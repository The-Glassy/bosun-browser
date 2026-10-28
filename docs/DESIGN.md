# Bosun — design (draft 0.1, 2026-10-18)

A self-hosted, multi-tenant browser service for agents, exposed as an MCPL server. Goal: a Browserbase-class
service you run yourself, built for agents that live on MCPL hosts (Connectome), usable as plain MCP by others
(Claude Code, Codex).

Status: design + prototype. Conventions follow the MCPL spec as pointed out in anima-research/mcpl#26
(feature sets §6, push events §9, tags §16, bulk content references §19).

## 1. Goals / non-goals

Goals
- Real browser (JS, galleries, cookie walls, region selectors) for research agents — where fetch-only agents get 403/empty pages.
- **Human handoff**: CAPTCHA / 2FA / login / "are you human" → the server pauses, pushes an event, a human finishes it
  in a live view from a phone, the agent continues.
- **Persistent per-tenant profiles** (stay logged in) next to **ephemeral** research profiles (wiped after a task).
- **Credentials never reach the model**: entered by the human in the live view, or filled by the server from a per-tenant vault.
- **Multi-tenant**: one service for several agents/people; strict isolation, quotas, per-tenant tokens and logs.
- Fast and cheap per step: the agent reads the DOM/accessibility tree, not screenshots; screenshots on demand only.
- Pluggable engines (stock Chromium, patched Chromium for automation-flag hiding, Firefox-based Camoufox).

Non-goals (v1)
- A full desktop / computer use for non-browser apps (possible later: Xvfb + noVNC sidecar).
- CAPTCHA-solving services. Handoff to a human instead.
- Bulk scraping at scale. Target is "a person's agent, a bit above human pace", parallel sessions for breadth.

## 2. Architecture

```
 agent (MCPL host) ──ws/MCPL──►  browser-mcpl server  ──CDP──► engine pool (per tenant)
                                   │  auth: token → tenant              Chromium headful under Xvfb
                                   │  sessions, profiles, quotas         (one process per session)
                                   │  event bus → push/event
 human (phone, NetBird/LAN) ──https──► live view (/v/<handoff-token>): CDP screencast + input
```

- One server process (Node/TS, Playwright for engine control, raw CDP for screencast/input).
- **Tenant** = an auth token (or token file entry) → tenant id. Everything is namespaced by tenant: profiles dir,
  vault, logs, quotas, live-view links.
- **Session** = one browser context with its own process (headful Chromium, own Xvfb display or one shared Xvfb
  with separate windows). A session uses either an *ephemeral* profile (temp dir, deleted on close) or a named
  *persistent* profile of its tenant (`profiles/<tenant>/<name>/`).
- Idle: a persistent profile is only files on disk (cookies, localStorage, IndexedDB). No RAM while no session is
  open. Optional linger (e.g. 5 min) after a task before the process is closed.
- Isolation level is a deployment choice: (a) one server, tenants separated by process + dirs (default for one
  family/team), (b) one container per tenant behind a tiny router (hard isolation). Same code.

## 3. Feature sets (MCPL §6)

| feature set | uses | contents |
|---|---|---|
| `browser.core` | tools | open/close session, navigate, read (a11y/markdown), find, click, type, select, scroll, back, wait_for, evaluate (opt-in) |
| `browser.vision` | tools | screenshot (viewport/element/full), PDF print |
| `browser.handoff` | tools, push | request_human, cancel_handoff; events needs-human / human-done / handoff-timeout |
| `browser.profiles` | tools | list/create/delete persistent profiles, session from profile, cookie summary (no values) |
| `browser.vault` | tools | list credential names, fill_credential (values never returned) |
| `browser.downloads` | tools, push, content refs | download events as bulk content references (§19) |
| `browser.watch` | tools, push | watch a page/selector for change; event on change (e.g. price) |
| `browser.macros` | tools | save/run deterministic step sequences without a model in between (0.14.0, §9a; recording not yet) |

A host disables any set whose `uses` it lacks; capability grants decide authority (§6.4). Plain-MCP clients get the
tools only (no push), and handoff then returns "waiting for human" until done/timeout.

## 4. Tools (browser.core, first cut)

- `session_open({profile?: string, engine?: 'chromium'|'chromium-stealth'|'camoufox', viewport?, locale?, timezone?}) → {session}`
- `session_close({session})`
- `navigate({session, url, wait?: 'load'|'domcontentloaded'|'networkidle'})` → title, url, status
- `read({session, mode?: 'a11y'|'markdown'|'text', selector?, maxChars?})` → compact accessibility tree with stable
  element refs (`e12`), or readable markdown of the main content
- `click({session, ref|selector|text})`, `type({session, ref, text, submit?})`, `select({session, ref, value})`,
  `scroll({session, to|by})`, `wait_for({session, text|selector|url, timeoutMs})`
- `screenshot({session, ref?, fullPage?})` (browser.vision) — returns an image content block
- Every action result includes the new URL/title and a short diff summary of the page, so the agent rarely needs a full re-read.

Element refs come from the a11y snapshot (like Playwright MCP's `ref`s) so the model never deals with coordinates.

## 5. Human handoff

Triggers
- explicit: agent calls `request_human({session, reason})`
- detected: server heuristics on navigation/DOM change — reCAPTCHA/hCaptcha/Turnstile iframes, Cloudflare
  challenge pages, OTP/2FA inputs, password field on a domain with no saved login in this profile.
  Detection pauses the session and answers the pending tool call with `{status:'waiting_for_human', handoff}`.

Flow
1. Server creates a handoff: link `/v/<token>` (TTL 15 min, bound to this session + tenant; one viewer at a time,
   reopenable until the handoff ends, dead afterwards).
2. Push event `browser:needs-human` (feature set `browser.handoff`) with session, reason, URL, a small screenshot, the link.
   The agent's host decides whether it wakes (tags are claims, not authority, §16.6).
3. The agent tells its human (e.g. Telegram) and waits (no polling — a later event wakes it).
4. Live view: CDP `Page.startScreencast` frames → browser page (canvas); taps/clicks/keys → `Input.dispatchMouseEvent`
   / `dispatchKeyEvent` / `insertText`. Works on phones. Buttons: Done, Give up.
5. While a handoff is active the agent is **blinded**: every page tool returns "handoff active" and no URL/title is
   reported. Password/PIN/OTP inputs are masked in a11y/markdown output and screenshots at all times. Text typed into
   ordinary fields is not masked after Done (see README › Handoff for the exact guarantees).
6. Done → `browser:human-done`; timeout → `browser:handoff-timeout`. The pending call resolves and the agent continues
   on the post-login page. Cookies persist if the session uses a persistent profile.

## 6. Credentials (browser.vault)

- Per-tenant encrypted store (age/libsodium, key from the deployment's secrets). Entries: name, origin(s), username, password, optional TOTP seed.
- `fill_credential({session, name})`: server checks the current origin matches the entry, fills fields itself,
  returns only "filled username+password for <name>". Values are never in tool results, logs or events.
- TOTP only if the human explicitly stores a seed; SMS/app 2FA → handoff.

## 7. Events / tags (MCPL §9, §16)

Namespace = server name: `browser:`. Declared as an ontology on the feature sets.

Implemented so far: `bosun:needs-human` from keepalive (0.4.0, feature set `bosun.handoff`, see README › Keeping
logins alive) and `bosun:watch-changed` from a keepalive visit's watch (0.5.0, feature set `bosun.watch`, see
README › Watching a value); `bosun:meeting-chat`, `bosun:meeting-optout` and `bosun:meeting-ended` from meetings
(0.6.0, feature set `bosun.meeting`, see README › Meetings (PoC)), `bosun:meeting-announce` (0.13.1), and
`bosun:meeting-transcript`, `bosun:meeting-transcript-stopped`, `bosun:meeting-speech` (0.15.0, §9b); the server's namespace is `bosun:`.
- `browser:needs-human`, `browser:human-done`, `browser:handoff-timeout`
- `browser:download-finished` (with a bulk content reference, §19), `browser:download-failed`
- `browser:watch-changed`
- `browser:session-crashed`, `browser:session-idle-closed`

## 8. Engines

- `chromium` (default): Playwright's Chromium, **headful under Xvfb** (fewer bot flags than headless), realistic
  viewport/locale/timezone per tenant.
- `chromium-stealth`: same + automation-flag hiding (patchright-style). Opt-in per session/tenant.
- `camoufox`: Firefox build with fingerprint management, for sites that defeat Chromium. Later.
- Network: residential IP of the host (home server) matters more than any of the above. Optional per-tenant proxy.

## 9. Quotas, limits, safety

- Per tenant: max concurrent sessions (e.g. 2–4), max session lifetime, idle close, max downloads size, rate limit per domain.
- Global: max total sessions (RAM budget ~0.3–0.6 GB per headful session).
- Downloads go to a tenant dir and are referenced, never inlined.
- Web content is untrusted (prompt injection). The server doesn't execute model-supplied JS unless `evaluate` is granted.
- Audit log per tenant: tool calls (no secret values), URLs, handoffs.

## 9a. Macros (0.14.0)

Agents repeat the same multi-step flows (Plaud: import a file through a chooser, reload, generate, export,
download). A macro stores such a flow once, per tenant, and `macro_run` replays it without a model between steps.

- **Document.** `{name, description, site, params, steps, confirm_risky, risky_steps, version, created_by,
  created_at}`, versioned (last 20 kept), in `BROWSER_DATA/macros/<tenant>/<name>.json`, one file per macro written
  by rename. Plain files rather than a database: the data volume already survives restarts and is snapshotted with
  the profiles, and a macro is small and read whole.
- **Steps are tool calls**, minus `session` and `ref`. Each step is run by the very handler registered for that
  tool on this connection (`handlers` in `tools.mjs`), its arguments parsed by that tool's own schema, under that
  tool's deadline (`withDeadline`, the same code path as a direct call). So the policy of the token, the host
  allowlist and its proxy, bot-check detection, masking, the downloads allowlist and the secret and upload rules
  hold for a macro step exactly as they do for the tool, and a tool the token may not call is missing from
  `handlers` and refused before the run starts. The alternative, a second interpreter of page actions inside the
  macro module, would have to be kept in step with every tool by hand.
- **No refs, no code.** Refs (`e12`) come from one `read` and mean nothing in the next run; a step names its
  element by role+name, selector or text. There is no `evaluate` step. `assert` (text / selector / url_contains) is
  the one step that is not a tool; it only waits for something to be visible.
- **Params** fill `{{name}}` in any string. `file_id` and `secret_id` params go only into `upload` file ids and
  `type` secret_id, and those fields take nothing but such a param: ids are used once, and a macro never stores a
  secret. A step that uses an optional param that was not given is skipped.
- **Site.** Each macro names its hosts (no `*`). Checked before the run (every `navigate` URL, after the args are
  filled in) and before each step (the page must be on the site or `about:blank`). A step's deadline call carries
  two hooks (`withDeadline` hooks): `guard()` runs in the session's queue (`SessionManager.run`) right before each
  page operation of the step, since another call on the session may have moved the page meanwhile, and again right
  before an element is acted on. `vet(handle)` runs on the element `click`, `type` and `upload` resolved
  (`onTarget`). The element must be in a document on the site, and a `type` with a secret checks it before the
  secret is taken. A listener on the tab's main-frame navigations notes the first one off the site, so a redirect
  out and back is still seen, and the guard refuses after it. Off the site the run stops after the step, also an
  optional one. The hooks are taken when the step starts and kept for all it does: a handler still going after its
  step ran out of time (an upload waiting for a file chooser) finds its call over and does nothing more on the page.
  Loading a page outside is not blocked (the tab may load it, within the tenant's allowlist, which
  the proxy enforces); acting on it is. Blocking the load itself would need request interception in every engine.
- **Risky steps.** A word list (pay, buy, purchase, submit/place order, checkout, delete account, and German
  equivalents) is matched against every string of every step at save time (refused without `confirm_risky`), again
  after the args are filled in, and against what the element a `click` (or an `upload`'s click) hits says, and
  every control around it on the composed tree (slots, shadow hosts): the text inside it as one stream, shadow
  roots included; each alt, aria-label, title, value and placeholder on its own; aria-labelledby read the same way
  and joined in order. Generous on purpose: hidden text counts too. An element too large to read whole (50,000
  nodes) is refused rather than read in part. The element is resolved to a handle, waited for until it can be clicked (a trial click), vetted, and then
  that handle is clicked, so there is no wait between check and click. If it can't be vetted, nothing is clicked.
  `type` with a `value` works the same way. It checks the control Playwright fills (a `<label>` leads to its
  control), refuses a password field, and looks again after the fill (a field that became a password field is
  cleared). A word list is crude; it catches the obvious cases a macro should not do by accident, not an
  adversarial page that rewrites a button between the check and the click.
- **Time.** Each page operation gets the smaller of its tool's deadline and what is left of the run. The run:
  `timeout_sec` (default 300, max 900), the failure report included (the steps stop 15 s, or a third of a shorter
  run, early; the report's read and screenshot get the rest). A wait of the step's own (`wait_for`, `assert`,
  `download_wait`) is shortened to end before the deadline: a wait cut off by the deadline would keep the page busy
  and make the next call wait, or replace the tab. A progress notification after every step keeps a client with
  `resetTimeoutOnProgress` from timing out; a cancelled request stops the run before the next step.
- **Read-only tenants** list, get and run (`EPHEMERAL_TOOLS`), but cannot save or delete. Since a tenant has one
  policy, a read-only tenant has no macros of its own: `BROWSER_MACRO_SOURCE=<read-only>=<tenant>` points it at a
  full tenant's macros. Only a read-only tenant may be pointed elsewhere, so it is never unclear where a save goes.
- **Not done (follow-up): recording** (`macro_record_start/stop`, turning the agent's own calls in a session into a
  draft). A recorded `click { ref }` must become role+name at record time, which the a11y snapshot gives only for
  elements with a role and a unique name (Plaud's "Generate" is a bare `div`), and it hooks every tool call.

## 9b. Live transcript and speaking in meetings (0.15.0, settings 0.16.0)

Goal: the agent takes part in a call: it hears it as a live transcript and can speak into it. Bosun provides only
the mechanism; when to speak (or raise a hand) is decided by the agent, never by Bosun.

**Audio.** Each meeting already had a private PulseAudio server (sinks `bosun_out`, the meeting, and `bosun_mic`).
- **Hearing:** a second ffmpeg reads `bosun_out.monitor` as raw PCM s16le 16 kHz mono (the recorder's ffmpeg is left
  alone, so a failing stream can't cost the recording). `src/meetings/transcript.mjs` sends it in 250 ms chunks to
  ElevenLabs Scribe v2 Realtime (`wss://api.elevenlabs.io/v1/speech-to-text/realtime`, `model_id=scribe_v2_realtime`,
  `audio_format=pcm_16000`, `commit_strategy=vad`, `vad_silence_threshold_secs=1`, `include_timestamps`,
  `include_language_detection`, `enable_logging=false`; no `language_code`, so a uk/ru/en/de/sk mix works).
- **Speaking:** Chromium lists no PulseAudio monitor sources as microphones, so `bosun_mic`'s monitor is remapped
  (`module-remap-source`) into `bosun_mic_src`, the browser's microphone (before 0.15 the browser had no microphone at
  all: Meet said "Microphone not found"). ffmpeg plays into `bosun_mic`; it is silent otherwise.

**Transcript.** Segments are numbered (`seq`); partials carry the seq their final will get. Times are seconds of
audio since the transcript started, from the words' timestamps plus the audio sent before the current connection.
Events go only to connections attached at the time (`EventBus.meetingLive`): a 20-event pending queue per tenant
would otherwise lose chat and opt-out events to transcript text. `meeting_transcript` has every final (in memory, with
the meeting; up to 5000). Reconnects: up to 20 s of audio is buffered; the first chunk carries the last ≤ 50
characters as `previous_text`; fatal errors (auth, quota, terms, invalid request) stop it; others retry with backoff,
8 failures in a row at most (a session that closes within 10 s counts as one).

**Consent.** The transcript is part of the recording: it starts in the same place (after the announcement, which
then says "recorded and transcribed live"), and everything that stops or deletes the recording stops it (opt-out:
both at once, `Promise.all`), and deleting forgets its text. Zero retention is requested on every connection;
ElevenLabs grants it only to enterprise and trial plans and otherwise says so in a `warning`, which is reported
(`zero_retention: false`).

**Cost cap.** Minutes are counted per tenant and local day in `BROWSER_DATA/live-transcript-usage.json`
(`LIVE_TRANSCRIPT_DAILY_MIN`, 180). The money cap is ElevenLabs' own (dashboard).

**Speaking.** `meeting_speak` splits text into pieces (sentences; a long first sentence at its first comma; later
ones grouped up to 160 characters), synthesizes the first, and starts one ffmpeg player on stdin while unmuting in
parallel; the remaining pieces are synthesized and written into the same player while it plays. A local Supertonic on
a busy CPU synthesizes at about real time, so time to first audio is the first piece's synthesis, not the whole text's;
it can also fall behind, and the listener hears a pause between pieces. ElevenLabs (`ELEVENLABS_TTS_MODEL`, default
`eleven_v4_turbo` since 0.15.1: 94 languages, `language_code` `uk`, 16-bit `wav_24000`) synthesizes a piece in 0.3–0.9 s,
far less than the piece before it lasts, so the pieces play without a pause; `gap_ms` in the result is the longest
pause there was (the time a piece was written minus when the audio before it ends, counted from the start of
playback and moved on by each pause).
**Settings (0.16.0).** Every speech value can be set by the agent: per call (`meeting_speak` `backend`, `voice`,
`model`; `meeting_join` `vad_silence_s`), per tenant (`speech_settings_set`, a JSON file per tenant under
`BROWSER_DATA/speech-settings/`, 0600, validated on read too), and as env fallbacks for the deployment
(`TTS_DEFAULT_BACKEND`, `ELEVENLABS_TTS_MODEL`, `ELEVENLABS_VOICE`, `TTS_VOICE`, `LIVE_TRANSCRIPT_VAD_SILENCE_S`).
Precedence: call > tenant > env > built-in (`supertonic`, `eleven_v4_turbo`, Sarah, the service's voice, 0.5 s).
`elevenlabs` without a key falls back to `supertonic` and says so (start-up warning for the env value, `warning` in
`speech_settings_get`) rather than refusing every utterance. Read-only tokens may read the settings, not change them.

**VAD pause (0.16.0).** The Scribe segment ends after `vad_silence_s` of silence (was a fixed 1 s; ElevenLabs' own
default is 1.5 s). Measured on real Scribe with TTS speech (River, `eleven_v4_turbo`) in English and Ukrainian, pauses
inside sentences 0.15–0.6 s plus the clips' own edges: a final comes 0.83–0.97 s after the speaker stops at 0.5 s,
1.06–1.11 s at 0.7 s, 1.44–1.49 s at 1.0 s. At 0.5 s, fluent sentences stay whole; clause pauses of about 0.5 s or
more split a sentence into finals (nothing lost). 0.5 s is the default because a reply waits on the final.

**Muting again (0.16.0).** Production 0.15.0 on Zoom: after a 9.2 s utterance the microphone stayed on ("muting
again took longer than 30 s", and `wait` gave up first). Zoom's toolbar fades out after a few seconds without mouse
movement; "Mute" stays in the page with its size, so it counts as visible, but a click on it lands on what is behind
it, and Playwright's click waits 3 s for that to change, 10 s of tries, three times. Short utterances muted fine
because the unmute had just moved the mouse there. Now every click on the control is preceded by a mouse move over
the toolbar; between the three tries an open menu is closed (Escape); the utterance's end waits 20 s (so `wait`
answers in time), and a microphone still on is `mic_open` in `meeting_status` and tried again every 5 s, 6 times.
The microphone is unmuted through the platform's toolbar control (`setMic`), and muted again 0.4 s after the audio
ends, only if speaking turned it on. Zoom: a microphone Zoom never got makes Zoom ask "Do you want people to hear you?"
on unmute; since the agent asked to be heard, "Use microphone" is answered then (the lobby still declines it).

**Not done.** Streaming TTS (audio while a piece is still being synthesized); speaker labels from the audio (realtime
Scribe gives none for one mixed track; 0.17.0 reads them from the page, §9c). The meeting doesn't play Bosun's own voice
back to it, but a participant's microphone can pick it up from their speakers: §9d.

## 9c. The meeting as an MCPL channel; acknowledgements; speaker labels (0.17.0)

**Why.** On a live call (2026-10-28) Glassy took too long to answer. TTS started about 0.55 s after `meeting_speak`,
and Scribe's final came about 0.85 s after the speaker stopped. The bulk was the agent's own turn: `meeting_speak` is
called once the whole reply is written.

**Host side, as it is (connectome-host v0.12.0 → @animalabs/agent-framework 0.24.0, MCPL SPEC §14):**
- **Grant:** the host grants the channel capabilities a server advertises (`computeGrant`), so Glassy's recipe needs
  no change.
- **Incoming:** `channels/incoming` on a registered channel wakes the agent. With no wake policy for the source, the
  gate's default is `always`.
- **Prose:** with `proseRouting: "disabled"` (Glassy's recipe) plain prose is never published. The option is
  agent-wide; there is no per-channel routing. Only the `channel_publish` tool reaches the channel: one
  `channels/publish` per call, no chunks.
- **Chunks:** the host sends `channels/outgoing/chunk` only after a publish succeeds, each chunk a whole published
  piece. The spec forbids streaming before routing is decided (§14.3) and delivering on chunks (§14.5).
- **Consequence:** Bosun speaks on publish. The gain is that the agent can publish its first sentence (one tool call)
  and go on writing; each publish is spoken as it arrives.
- **Needs an upstream change:** token-level streaming would need agent-framework to stream deltas to
  `channels.streaming` servers before publish. The spec allows that only once routing is decided. Bosun is ready for
  it: `channel_prepare_chunks` synthesizes chunk sentences ahead, and the publish then plays them at once.

**Bosun side.**
- **Connections:** `EventBus` keeps the tenant's channels (`openChannel`, `closeChannel`) and each MCPL connection's
  channel side (`attachChannels`).
  - Notifications narrow and never widen, as for push events. That includes `effectiveCapabilities`, which §6.7 says
    to ignore in a notification. Narrowing on it is the deny-safe reading for a host that sends a reduction the
    non-conforming way.
  - A connection attaches while its grant has `channels.register`. It registers every open channel, one
    `channels/register` each, in order, after the answer to the `featureSets/update` that granted it.
  - It takes channels back with `channels/changed` when the grant narrows or the meeting ends.
- **Incoming:** checked at the time against the grant (`channels.incoming`) and the channels the host accepted on
  that connection.
- **Publish:** answered at once, because the host queues the agent's next posts behind each publish. The text goes
  into a per-meeting queue (`channelQueue`).
  - Bounds: 2000 characters per publish, and 6000 characters waiting or 120 s of audio not played.
  - `channelGen` drops queued text on an opt-out or `meeting_stop_speaking`. `consentGen` keeps a final from being
    sent as an event after its text was forgotten (opt-out, deletion) while the channel delivery was pending.
  - A follower never cuts off the utterance it waits for: if that one doesn't end in its time, the text is dropped
    (a failed speech event).
- **Utterances** (`Meetings.utter`, which `meeting_speak` uses too) have a kind: `speak`, `stream` (from the channel)
  or `ack`.
  - A `stream` utterance is **open**: its pump (`nextPiece`) takes more pieces while it plays. Once what was written
    has played and `STREAM_IDLE_MS` (300 ms) passed with nothing new, it closes and ends its ffmpeg player's stdin.
  - Text that comes later starts a new utterance.
  - A publish while `meeting_speak` plays waits for it with `speechFollows` raised, so `endUtterance` doesn't mute in
    between.
  - An agent utterance while an ack plays waits for the ack's player. An ack still waiting for the microphone is
    dropped.
- **Ack:** the clips are synthesized with the tenant's TTS settings and `ack_lang`, at admission (`prepareAcks`) and
  whenever the settings change. They are cached per (backend, voice, model, lang, phrase), with at most 64 clips; a
  failed one is tried again after 60 s.
  - The trigger is a final of at least `ack_min_words` that ends with sentence punctuation, while nothing is being
    said, outside the cooldown. The clip plays after `ack_delay_ms`, unless the agent spoke meanwhile.
  - No speech event (it would wake the agent for its own "mhm"). A failed re-mute after an ack still raises
    `bosun:meeting-mic-open`.
- **Speaker labels:** an in-page watcher (`common.mjs watchSpeakers`, per-platform selector spec) logs changes of the
  shown speaker every 200 ms. Bosun drains it every 300 ms outside the page queue (a read; the queue can be busy for
  seconds with a mute).
  - `LiveTranscript.wallAt(sec)` maps a segment's audio seconds to wall time through the times its chunks were sent,
    about 0.25 s after they were heard.
  - The segment's speaker is the name shown longest within [start − 0.3 s, end].
- **Zoom muting again** (prod 2026-10-28: "no microphone control found in Zoom"):
  - The fallback reads the control from the DOM and clicks it there (`element.click()` reaches a control under a
    faded or hidden toolbar). Then Alt+A, only when the DOM shows the opposite state, so it is never a blind toggle.
    The state is read back each time.
  - Timings per try: 2.5 s for Playwright's own clicks, 1 s each for the page click and Alt+A. Three tries fit the
    20 s an utterance's end waits.
  - The page click happens only if the control shows the other state at that moment (read and click in one
    evaluate), so a microphone the host muted meanwhile is never clicked back on.
  - Waiting room (prod 2026-10-28, 44 min "admitted" in Zoom's waiting room): before admission `zoom.state` checks
    the waiting room's texts first, over the page without participants' text, title and captions. "Admitted"
    then needs the participants button, or a call audio control with no preview (Join / name field) shown. The chat
    button counts only once admitted (it moved in the waiting room).
  - Not seen live: the web client refused a scripted guest on Zoom's own test meeting ("Automated bots aren't allowed
    to join this meeting"). Both causes that fit the message are reproduced in the stand-in.

## 9d. Turns, barge-in, stale answers (0.17.1)

**Why.** Misha, on a live call with 0.17.0: when he paused mid-sentence and then went on, Glassy answered the first
part after it ended, and what he added was handled only after she had finished speaking. At `vad_silence_s` 0.5 a pause
in a sentence is a final; the agent answers it; the rest arrives while she speaks.

**Turn hold (`onFinal` → `m.hold` → `flushHold` → `deliver`).**
- **Holding:** a final goes into the meeting's hold and a timer starts: `turn_hold_ms`, or `turn_hold_complete_ms`
  when the final clearly ends a sentence (`turnComplete`). Each new final restarts the timer.
- **New speech:** a partial of a later segment that is not Bosun's own voice holds the turn until that segment's
  final. That includes a partial that came before the held final's own timestamped copy (Scribe may send it first).
  A final never replaces a later segment's partial as the open segment (`openSegment`). If the final never comes (Scribe committed nothing), the turn goes after
  `max(turn_hold_ms, vad_silence_s + 2.5 s)`.
- **Delivery:** `deliver` is what 0.17.0's `onFinal` did (acknowledgement, channel, events), now once per turn. A
  merged turn: text joined with spaces, `seq` and `messageId` of its last segment, `merged_seqs`, start of the first
  segment and end of the last, the speaker over the whole span.
- **A hard limit:** a turn always goes 30 s after its first final, however many partials come (`holdFor` clamps).
- **Not held:**
  - `turn_hold_ms` 0;
  - a meeting ending: `finish` stops the transcript (its committed text becomes finals) and delivers a held turn
    before it closes the channel;
  - Bosun's own voice coming back (delivered at once, `echo_suspected`).
- **Different speaker:** a final of someone else (both labelled, names differ) ends the held turn first.
- **Consent:** an opt-out or a deletion forgets a held turn (`consentGen`), as it forgets the transcript.
- **Why 900/300:** Scribe's final comes about 0.35 s after its 0.5 s of silence. Someone who goes on after a breath
  pause of up to about 1.4 s in total has a partial within 900 ms. The partial needs a few hundred ms of speech: the
  stand-in sends one after 0.5 s, and Scribe's are faster. A question or a finished sentence ending a turn is the
  common case, and 300 ms there is barely noticeable next to the ~0.85 s Scribe already takes. Measured locally:
  `held_ms` 302 / 900 / 304 ms (question / fragment / sentence) at the defaults. Timer jitter is under 5 ms, so the
  added latency is the hold itself.
- **The heuristic is conservative where it is cheap to be wrong:** Scribe punctuates every final. "I think that."
  ends in a full stop but is not complete, so the trailing-word list (EN/UK/RU/DE/SK conjunctions and articles) and
  "…" keep such a fragment at 900 ms.

**Barge-in (`maybeBargeIn` on every partial and final).**
- **When it is checked:** only while an utterance's audio plays (`u.startedAt`), not while it is still being
  synthesized. A publish that arrives while someone talks is still said, as item 3 of the brief wants. If they go on
  talking, the barge-in then stops it.
- **Not for audio files:** `meeting_speak` with `audio_file_id` has no text to recognise its own echo by, so it is
  never cut off automatically (`meeting_stop_speaking` still works).
- **Counting:** from `u.base`, the open segment's words already heard when playback began. Only new words count.
- **Threshold:** `barge_in_min_words` words that are not agreement (a fixed list of backchannel words), or one word
  while the page has shown someone else speaking `barge_in_min_s` since playback began.
- **What it does:** the same as `meeting_stop_speaking`: `channelGen++` (channel text waiting is dropped), no pending
  acknowledgement, the player stopped, `endUtterance` (muted again, also with channel text queued behind it, because
  `stopped` is set).
- **What was said:** `spokenSoFar` uses each piece's place on the playback timeline (`u.timeline`, written as pieces
  are written to the player). A piece cut off counts as far as its whole words went, by share of its duration.
  - This is an estimate: player start-up and the network are not in it, so `said` may run a word or two ahead of
    what was heard.
- **Telling the agent:**
  - On the channel: a `channels/incoming` message `<meeting>:int<n>`, author `bosun`, tagged
    `bosun:meeting-interrupted`, metadata `{interrupted, utterance_id, said, unsaid, heard, speaker, last_turn_seq}`.
    It comes before the interrupter's turn, which is still held.
  - Always: `bosun:meeting-speech` with `barge_in`, `said` and `interrupted_by`.
  - An acknowledgement that is talked over just stops.
  - An acknowledgement playing in front of a reply still being prepared counts as Bosun speaking. Both stop, and the
    reply's message says nothing of it was said.
- **Latency:** with the stand-in, 1.5 s from the start of the interruption. Its partials come every 0.5 s of speech,
  one word each, so two words take 1 s plus chunking. Scribe's partials carry several words each and come sooner.

**Echo (`ownVoice`, `heard`).**
- **Where Bosun's voice can come back:** Bosun's audio goes only to its microphone (`bosun_mic`), and the capture is
  what the browser plays (`bosun_out`). Meet and Zoom don't play a participant's own audio back to them. Bosun's voice
  can reach the transcript only through someone else's microphone (speakers, failed echo cancellation), or through a
  platform that mixed it in.
- **The text check:** text whose words are at least 60 % words of the utterance playing (not one still being
  synthesized: nothing of it can come back yet, and someone may be saying the same words) (also an acknowledgement
  playing out) or of an utterance that ended within 8 s counts as Bosun's own voice. It never barges in, never extends
  a held turn, never sets `lastHumanAt`, and its final goes at once with `echo_suspected`.
- **The label check:** where the page names speakers (one was named in the last 2 minutes, or one is shown now),
  barge-in also needs someone other than Bosun shown speaking since playback began. The page never names Bosun's own
  tile, so Bosun's voice in the mix alone never barges in. Labels can't tell acoustic echo from a person (that
  person's tile lights up), which is why the text check comes first.
- **Known gaps:**
  - A participant who repeats Bosun's words ("yes, the budget") counts as an echo.
  - Someone who talks over Bosun using mostly Bosun's words is not heard as a barge-in until they add their own.

**Stale answers.**
- **The flag:** `superseded_by_new_speech = heardSeq > lastTurnSeq`, while that speech is in a held turn or was heard
  in the last 5 s. `heardSeq` is the newest segment someone (not Bosun's echo) was heard in, from a partial or a
  final. `lastTurnSeq` is the newest segment delivered as someone's turn. Segments are compared, not times, so:
  - Bosun's own voice delivered meanwhile doesn't clear the flag.
  - An older final delivered after a newer partial doesn't clear it either.
  - The 5 s limit covers speech that Scribe never committed (a cough as a partial with words).
- **The text is said anyway,** as the brief asks. The agent decides.
- **Not detectable:** a publish answering turn K that comes after turn K+1 was already delivered. `channels/publish`
  carries no reference to the message it answers. `last_turn_seq` in the acknowledgement lets the agent compare
  against the seq it answered.

**Still thinking (addendum, Misha 20:25: "not only while you're speaking, but also while you're thinking").**
- **When:** `maybeExtend` runs on a partial or final of someone (not echo) with a seq after the last delivered turn
  (`m.lastTurn`). All of these must hold:
  - that turn is not answered (`answeredSeq`: set by a publish that is said, and by `meeting_speak`);
  - nothing but an acknowledgement is playing;
  - it was delivered within `turn_extend_s`;
  - it was not reopened before;
  - nothing is held now;
  - the speaker is the same, or unknown;
  - its text was not forgotten since (`gen`).
- **What happens:**
  - The last turn's finals (`seg.parts` of a merged turn) seed a new hold (`extends`), which waits as for a partial
    during a hold.
  - The agent gets a `turn-extended` message (channel) or live event.
  - A pending acknowledgement is cancelled and its cooldown released.
- **Delivery:** `flushHold` delivers the reopened turn as a merged final with `extends_turn`. If nothing new was
  committed, it delivers the same turn again and takes it off the reopened list, so it can be answered.
- **Publishes:** a publish belongs to `turn_seq` (named, or the last delivered turn when it came). If that turn was
  reopened, `superseded_publish: "drop"` answers `{delivered: false, dropped: true, reason}` without speaking.
  - `delivered: false` with no `messageId`: agent-framework 0.24's `publishReceiptOutcome` then reports the publish as
    failed, which is true. A `delivered: true` would be a lie the host acts on (it streams the text as published).
- **Host limit:** connectome-host (agent-framework 0.24.0, `publishReceiptOutcome`) keeps only `delivered` and
  `messageId` of a receipt. `superseded_by_new_speech`, `turn_seq` and `dropped` don't reach the agent through it:
  - A dropped publish shows up as "reported delivered:false".
  - The messages Glassy actually sees are the channel messages: `bosun:meeting-turn-extended`,
    `bosun:meeting-interrupted`, and the merged final with `extends_turn`.
  - Surfacing the receipt's fields to the agent would be a host change.

**Codex round 3 fixes.**
- The echo vocabulary is only the pieces that have begun to play (`playedWords` from `u.timeline`), during playback
  and in `saidRecent` after it. A piece still waiting or being synthesized can't come back yet.
- A final whose audio ended before Bosun began to play (its timestamped copy came late) is no barge-in. Of a final
  that began before, the share of its words before playback started is left out.

## 10. Deployment

- Package: npm + Docker image (Chromium, Xvfb, fonts, the server).
- Config: tokens file (token → tenant, quotas, allowed feature sets), data dir (profiles, vault, downloads, logs), live-view base URL.
- Homelab: a shared service like whisper/TTS (host container), each tenant reaches it on a forwarded port with its
  own token; live view reachable over NetBird. Target host: the home server (residential IP, RAM).

## 11. Milestones

- **M0 prototype (in Glassy's container):** Chromium headful + Xvfb, core tools over MCPL, one tenant, ephemeral profile. Smoke test against sites that 403'd fetch-only agents.
- **M1:** persistent profiles, multi-tenant tokens/quotas, live view + handoff events.
- **M2:** vault, downloads as content refs, watch.
- **M3:** stealth engine option, macros, Docker image, docs → public repo.
- **M4:** homelab brick on the home server; Codex/Claude Code via plain MCP; comparison run (Claude subagent vs Codex with the same browser).

## Open questions
- Which MCPL server toolkit to build on (mcpl-core-ts) and how other anima servers structure feature sets.
- Live view auth: handoff link only, or also tenant login?
- Shared Xvfb vs Xvfb per session (RAM vs isolation).
