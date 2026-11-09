# Decisions

Decisions made without asking (Misha: "use your judgment and decide yourself"), with the reason. Newest first.

## 0.22.0 (2026-11-09): recording speaker timeline

- Keep a recording-only timeline separate from the ten-minute live-transcript speaker log. Page snapshots now
  carry all active names and preserve `name` for live transcript compatibility. Track each name independently,
  merge unchanged samples and discard runs shorter than 300 ms; display-name collisions remain ambiguous.
- Align zero with the first PulseAudio input PTS printed by FFmpeg's input header, not process launch. The
  [FFmpeg PulseAudio input](https://github.com/FFmpeg/FFmpeg/blob/master/libavdevice/pulse_audio_dec.c) timestamps
  packets with host epoch time adjusted for input latency. Probe the final Ogg duration and clip labels to it.
  Backends without this timestamp use launch time and explicitly report `estimated-recorder-start`; failed
  duration probes report `wall-clock-estimate`. Page sampling/indicator lag still makes labels approximate.
- No public restart or pause API exists. A hypothetical internal restart overwrites the same recording file,
  so reset both duration and timeline instead of concatenating clocks across unrecorded gaps. Recorder failure
  finalizes the existing timeline. A crash before finalization can leave audio without labels.
- Bound each recording to 50,000 intervals and 128 simultaneous names. Preserve the first completed intervals, flag
  omitted later runs with `truncated` and an explanatory note, and release full in-memory data after saving.
- Serialize page drains and collect a final snapshot on stop. Audio and labels share the deletion marker;
  deletion wins over a pending graceful stop, so an opt-out cannot be resurrected by sidecar finalization.
  Final drains have a two-second deadline and failed/missing page reads flag `incomplete`.
  Retention follows the audio file's age and also removes orphan sidecars.
- Inline sidecars up to 32 KiB; reuse the recording URL handler for larger JSON with separate secrets and
  one-time consumption. Tenant checks, expiry, replacement, revocation and transfer cancellation apply to both.
  Keep all audio response fields; older recordings have `speakers: null`, while empty new sidecars say `none-seen`.
- The optional pure `labelTranscript` helper scores total overlap per name, unions duplicate ranges, resolves
  ties by timeline order and returns `speaker: null` for gaps. It neither uploads audio nor requires an API key.

## 0.21.0 (2026-11-09): secret masking in read/screenshot (#31)

- Keep detection in `src/redact.mjs`; macro reads/screenshots already invoke the same tools. Match metadata on
  fields and value-bearing widgets, with word boundaries and separator normalization. Headings, labels and
  buttons do not become secret values merely because they say “token”, “PIN” or “secret”.
- Recognize public secret prefixes, JWTs, AWS key IDs and PEM private keys anywhere, including accessible names
  and hidden reveal copies. Retain only fixed non-secret prefixes. Entropy detection is limited to inputs,
  code/pre and readonly elements (32 characters minimum; Shannon entropy at least 3 bits for hex, 4.3 otherwise).
  URLs are exempt unless a component has a known secret format or a secret-named query contains an entropy match.
- Scan frames and open shadow roots for the same screenshot masks. Mark the smallest element containing the
  complete secret, including values split across inline spans; remove markers even when capture fails.
- Text reads explicitly exclude hidden/aria-hidden content, including a hidden selected root, and redact in the
  browser before truncating. No general unmask switch; the existing `secret_id` / `allow_non_password` flow stays.
- Accepted false-positive risks: credential-shaped examples, hashes/random identifiers in code or readonly
  elements, and opaque values under token-named widget wrappers can be masked. This is heuristic protection;
  arbitrary echoed passwords without a recognized format and closed shadow roots remain outside its coverage.

## 0.20.0 (2026-11-02): Meet chat fix, `addressed`, group-call guidance

- **No group mode, preset or tool** (Misha: guidance, not a mode). The only new things are `metadata.addressed` and
  the setting it needs (`name_aliases`). Everything else in the group guidance uses existing settings.
- **The 2 Nov chat failure was not reproduced, so the fix covers every cause I could find.** Live, with this code and
  with 0.19.0, Glassy's account posted fine in a calendar Meet and a plain one, with the host present. The account's
  plan has no continuous chat (the panel says "Continuous chat is turned off"). The group call ran in someone else's
  meeting, where a Google Chat conversation may replace the panel, or the host's organisation may keep outsiders
  out of it. The two `openChat` calls of 0.19.0 took 20 s together (admitted 09:00:09.8, transcript started
  09:00:30.2), so the click worked and no box was found both times. So: frames are searched, the toggle is
  respected, clicks are retried with a shortcut fallback, restriction is recognised, and a failure reports what was
  on the page. The README lists it as not verified live.
- **Posts are confirmed by a new message element with the whole text that is not someone else's** (Zoom has
  checked its posts since 0.9.0). Live Meet shows no sender on Bosun's own messages, so "not someone else's" is the
  check that works there. Someone else posting the very same words, unmarked, in the same seconds would still count:
  rare, and a false `not-confirmed` would be worse (the announcement would then go to the host and fail). Codex
  round 1 found the first version (text counted anywhere in the panel, cut at 200 characters) too loose; round 2
  added the sender header live Meet shows (not only `data-sender-name`), drafts left out of the count, and frames
  compared by identity.
- **No close-and-reopen of an open chat panel.** Meet's side panel has no tabs any more, and Codex showed a reopen
  can kill a slow embedded chat that was still loading. Waiting the whole 20 s is safer.
- **Enter gets 5 s before the send button is tried.** An Enter that is still pending after that could be sent twice;
  waiting longer only delays the not-sent case, and Meet posts within a second live.
- **The second open attempt is 5 s, not 20 s.** The join already waited 20 s. Recording and the transcript wait for
  the announcement, and 40 s of an unrecorded call is too much for a second try that rarely helps.
- **The `addressed` matcher compares a loose key, not spellings.** Scribe writes the name as it heard it, in the
  speaker's language. Listing every form ("Гласі", "Глассі", "Гласси", "Glassi", ...) in settings would never be
  complete. The key (Cyrillic transliterated, accents off, y=i, h=g, doubled letters single) makes those one word and
  still keeps "glass" and "glasses" apart. Keys under 3 letters never match, because "AI" or "Bo" would fire on
  every other sentence. A false hit ("glassy eyes") costs little: the agent reads the turn anyway.
- **The account name the call shows counts as a name too.** With a signed-in profile Meet shows the account's name
  ("Glassy Notetaker"), and people address what they see. The first word of a longer name counts on its own,
  because people say "Glassy", not "Glassy Notetaker". A bracketed note ("Glassy (notetaker)") is no part of a name.
- **The Meet account name comes from Bosun's own tile, only for signed-in joins.** A guest's tile shows the join
  name anyway. A tile labelled "You" is no name.
- **`addressed` only on finals.** Partials change while they come in, and the agent decides on turns.
- **No `addressed_as` or position field.** The brief asked for true or false, and the agent has the text.
- **`turn_hold_complete_ms` 300 is the recommendation, and the default stays 300.** The hold adds exactly its value
  (measured). Shorter holds split more continuations into two turns, but in a group the agent answers few turns, and
  `turn_extend_s` repairs a split turn it was answering. 0 is not recommended: by the real timings almost every
  continuation would reopen a turn. Glassy's stored settings (800) are left alone. The brief says not to change any
  tenant's settings; the README tells her what to set.
- **Zoom chat unchanged.** Both prod Zoom calls on 2 Nov posted the announcement to everyone (`sent_to: everyone`,
  confirmed by Zoom's own check of the posted message since 0.9.0), and the Zoom tests pass.
- **Live check without deploying first.** A second Bosun from the branch ran inside the browser container on
  127.0.0.1 only, with its own data dir, a copy of the google-glassy profile and a random token. Prod data, prod
  settings and the prod service were not touched. Guest joins could not be checked: Google turns away a datacenter
  guest ("You can't join this video call"), as the README already says.

## 0.19.0 (2026-11-01): meeting_draft removed

- **The removed keys stay in the two tool schemas, as arguments that only fail.** The MCP SDK strips arguments a
  schema doesn't name, so without them `speech_settings_set {draft_enabled: true}` would answer success and do
  nothing: the caller would believe drafts are on. They are listed as `removed in 0.19.0 ... passing it is an error`.
- **`speech_settings_set` with `null` for a removed key is accepted.** `null` asks for "not set", which is what is
  true now; failing would only break an old cleanup call. Any other value fails.
- **`meeting_join` refuses them even with `dry_run`,** before anything is loaded, so a caller learns it from the
  cheap call too.
- **No migration of stored files.** Unknown keys were already ignored when reading, and every write rebuilds the file
  from the known keys, so a 0.18 file loads as is and loses the keys at the tenant's next write. The brief says not to
  touch tenants' settings, and nothing needs to.
- **`afterPrefix` stays** (speculative streams settle with it); `addedWords`, `sentencesOf`, `MEANING_FLIP`,
  `heardSoFar`, `putPrepared` and the per-segment first-heard times existed only for drafts and are gone.
- **History is kept.** The 0.18.0 entries in CHANGELOG and below stay as they were (they describe that release); the
  README, DESIGN and STREAMING describe the current state and only say drafts were removed.
- **Minor version (0.19.0),** as the brief says: a tool is removed.

## 0.18.1 (2026-10-30): recording_get

- **It never worked, so there was no regression to fix.** The `file://` URI and the MCP `resource_link` were added in
  the first meetings commit (`b0e2c4d`, 2026-10-19) and are unchanged since; no tool or route ever served a recording.
  Speaking (0.15) did not break anything here. It was only noticed now, because passive notetaker agents need the file.
- **A route of its own, `/recording/<meeting_id>`, not `/download/<id>`.** A recording is not a download: it lives on
  in `BROWSER_DATA/recordings` (retention, not "gone once fetched"), it exists for tenants that have no download hosts,
  and its owner is looked up by tenant and meeting id, also after a restart. It shares the port, the token binding,
  the TTL (`DOWNLOAD_URL_TTL_SEC`), the one-time rule and the per-tenant cap of four transfers with downloads.
- **The URL secret is required; a bearer token alone is not enough.** `/download/` accepts either. For audio of a
  meeting, the one-time URL is the credential; a token, if sent, must belong to the same tenant.
- **The file is looked up again at fetch time.** A recording deleted after the URL was issued (an opt-out is the case
  that matters) must not be served: the delete paths revoke the link and abort a transfer under way.
- **The fetch does not delete the file.** The agent may need it again (a failed transcription); the retention sweep
  (30 days) and `meeting_recording_delete` remain the ways it goes.
- **Allowed while the meeting goes on if recording was stopped without delete.** The file is finished then.
- **Read-only tokens may call it** (the brief). A read-only tenant cannot join meetings, so it can only ever get a
  file under its own tenant name; another tenant's answer is the same as for an id that never existed.
- **A deletion is unlinked first, and leaves a marker (`<meeting_id>.deleted`).** Codex found that a crash between
  "stop the recorder" and "unlink" (or a recorder that opens its output only after the unlink) could bring an opted-out
  recording back, because a restarted service finds files on disk. Now the marker is written, the file unlinked, and only
  then the recorder killed (ffmpeg holds its output by file descriptor, so it keeps writing to nothing). `recordingFile`
  refuses a marked id and the sweep removes any file that reappeared under it; the marker itself goes after
  `RECORDING_RETENTION_DAYS`.
- **Accepted (Codex round 2, P2): a file of an earlier run is served once it has been quiet for 60 s,** with no proof that
  its recorder is gone. A completion marker would lock out every recording made before 0.18.1 (the one this release is
  for among them). An orphaned ffmpeg cannot outlive the service here: the unit uses the default
  `KillMode=control-group` and Bosun spawns ffmpeg undetached, so systemd ends it with the service.
- **Two Codex rounds, as the brief allows.** Round 1: one P1, two P2, all fixed. Round 2: one P1 (the marker above) and
  the P2 above; no third round.
- **No `file://` replacement.** Dropped from the event and from `meeting_status`; the hint to call `recording_get`
  replaces it. The `path` stays (it is where the file is, for logs and for stdio use, where `recording_get` returns it).

## 0.18.0 (2026-10-30): drafts and speculative speech

(The draft decisions here no longer apply: `meeting_draft` was removed in 0.19.0.)

- **A "not" or "but" among the new words drops the draft, however few words came.** The brief's rule is "at most
  `draft_max_new_words` (4) new words". Its own example, "... but not today", adds only three words and would pass. A
  wrong first sentence said aloud is worse than a second of silence, so these words always drop the draft. The list
  is short (EN/DE/UK/RU/SK negations and "but") and only checked among the words the final added.
- **New words are counted against a word alignment (LCS), not a prefix.** Scribe revises words between partial and
  final ("meat" to "meet"). A changed word counts as one new word. Words the final dropped count as nothing.
- **"What was heard" is the turn so far:** the finals held for it plus the open partial after them. A turn held
  across a pause would otherwise look like all new words.
- **A draft is used up at the turn it is checked against,** whatever the outcome. A draft for a later turn
  (`for_turn_seq` beyond it) waits. Without `for_turn_seq`, "set after the turn started" means after the first partial
  of the turn's first segment.
- **A draft for a turn that already reached the agent is refused (`too_late`)** instead of being kept. It could only
  ever be dropped, and the agent should publish.
- **The drafted sentence is said as channel text** (the same utterance, queue and barge-in as a publish), so the
  publish's remaining text joins the same utterance without the microphone going off in between.
- **A spoken draft counts as the turn's answer.** More speech after it is a barge-in or a new turn, not a reopened
  turn: Bosun has started answering.
- **The draft's result goes in the metadata and in a second text block.** The block says "already said ... go on
  after it", so Glassy sees it even where a host shows only the text.
- **The speculative opt-in is on the descriptor (`capabilities.streaming.speculative`) and in `metadata.streaming`.**
  MCPL 0.5 has no per-channel capabilities field. Hosts that keep only the metadata still see it.
- **Publish before `complete` is the usual order** (connectome sends `complete` after the publish succeeded), so the
  publish settles an open stream. Without a `streamId`, Bosun matches it when its text starts with what the stream has
  sent so far, within 10 s. A stream matches one publish only. The same text published again is said.
- **A sentence that differs but has not been taken up for synthesis is dropped silently.** One already being
  synthesized or played stops the utterance, as the brief says. An audible cut is only needed for audio that exists.
- **A publish matched to a stream a barge-in stopped is not said** (`spoken: "interrupted"`). The person spoke over
  that text; saying it again when the publish lands would ignore them.
- **A full stream table refuses the new stream instead of forgetting a busy one.** Forgetting a stream with speech
  under way would make its cancel unfindable, and the microphone could stay on. A refused stream loses only the
  head start: its publish is spoken as usual.
- **A full speech queue pauses a stream instead of dropping it.** The publish then says the rest. Dropping it would
  either lose the rest or repeat what was already said.
- **Speculative chunks with the setting off are treated as plain §14.3 chunks** (prepared ahead with
  `channel_prepare_chunks`, never spoken).

## 0.17.1 (2026-10-28): turns, barge-in, stale answers

- **The defaults are 900 ms and 300 ms, from the brief.** Scribe ends a segment after 0.5 s of silence and its final
  arrives about 0.35 s later. Someone who goes on after a pause shows a partial within a few hundred ms of speaking
  again, so 900 ms covers a breath pause of up to about 1.4 s. A question or a finished sentence is the common turn
  end and gets 300 ms. Measured locally: 302 / 900 / 304 ms added (question / fragment / sentence).
- **A full stop alone doesn't make a sentence complete.** Scribe punctuates every final. A final ending in a
  conjunction or article (EN/UK/RU/DE/SK) or in "…" is held the full 900 ms.
- **The hold applies to events too, not only the channel.** An agent without the channel answers
  `bosun:meeting-transcript` finals just the same.
- **Barge-in only while audio plays, not while a reply is still being synthesized.** Item 3 says a publish that
  arrives after new speech is still said. Cancelling it before it starts would contradict that. If the person goes on
  talking, the barge-in stops it within a partial or two.
- **Barge-in threshold: 2 words, agreement words excluded,** or 1 word plus 0.6 s shown speaking on the page. "Mhm" or
  "yeah" while Glassy talks is no interruption; "wait, stop" is.
- **Echo: a text check first, the speaker label second.** Labels can't tell acoustic echo (the participant's tile
  lights up) from a person, so the 60 %-of-Bosun's-words check decides. Where labels work, someone other than Bosun
  must also be shown speaking. Labels count as working when one was named in the last 2 minutes, so a page whose
  labels broke falls back to the text check.
- **Echo finals are still delivered, marked `echo_suspected`.** The brief doesn't ask to drop them, and a person
  repeating Bosun's words must not vanish.
- **superseded_by_new_speech is always in the publish acknowledgement (true/false), with `last_turn_seq`.** A
  publish carries no reference to what it answers. The seq lets the agent detect the case Bosun can't: turn K+1
  already delivered when the answer to turn K arrives.
- **The interruption message is a `channels/incoming` from author `bosun`, tagged `bosun:meeting-interrupted`.** A wake
  policy can filter it, and it arrives before the interrupter's (held) turn.
- **Addendum, still thinking: the default is "drop", as asked.** A dropped publish answers `delivered: false` (no
  `messageId`). connectome-host then reports a failed publish, which is honest: nothing was said. `delivered: true`
  would make the host stream the text as said.
- **A turn counts as answered once a publish for it is said, or `meeting_speak` is called.** After that the
  speaker's next words are a new turn (barge-in handles an answer still playing). An acknowledgement is not an
  answer.
- **`turn_extend_s` = 20 s.** Glassy's thinking time before her first publish is several seconds. Beyond 20 s
  without an answer, more speech is more likely a new thought. It is tunable, and 0 turns reopening off.
- **An acknowledgement that already played for the first part is not repeated** for the merged turn within the
  cooldown. One still waiting is cancelled, and its cooldown released.
- **The extra receipt fields stay,** although connectome-host drops them today. Hosts that read receipts get them,
  and the channel messages carry the same information for Glassy.
- **No fourth Codex round for the addendum:** the brief caps Codex at 3 rounds. The addendum diff was reviewed by
  hand. That review found a turn reopened with nothing new that stayed marked reopened, and a deleted transcript's
  turn that could be reopened. Both are fixed.
