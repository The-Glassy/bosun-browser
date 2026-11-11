---
name: bosun-browser
description: Use Bosun, a shared real-browser service, to browse, read and act on web pages, keep logins alive, type passwords without seeing them, hand a tab to a human for CAPTCHAs or 2FA, run saved multi-step macros, and join Google Meet or Zoom calls as a notetaker or a speaking participant. Use when a task needs a real browser session (logins, JS-heavy sites, forms, downloads, uploads) or a meeting recording/transcript.
---

# Bosun browser

Bosun gives you a real Chromium (or patchright / camoufox) running on a server, through MCP tools.
Pages are seen through an accessibility snapshot with element refs, not pixels. When a page needs a
person (CAPTCHA, cookie wall, 2FA, a phone prompt) you hand that tab to the human and wait.

## The basic loop

1. `session_open` — ephemeral (wiped on close) unless you pass `profile` (a persistent, logged-in
   profile of your tenant). Pick `engine` only if a site blocks the default `chromium`.
2. `navigate {session, url}` — http/https only. Check the result: `blocked` means a bot check,
   CAPTCHA or "access denied" was detected; its `hint` says what to try.
3. `read {session}` — accessibility snapshot with `[ref=eN]`. Use `mode:"text"` for the visible text,
   `selector` to read one part of a long page, `maxChars` to keep it small.
4. Act: `click`, `type`, `select`, `press`, `hover`, `back`, `wait_for`.
   Target an element by `ref` from the latest `read`, or by `role` + `name`, `text`, or `selector`.
   With `role`/`text`/`selector`: `nth` picks which visible match, and `after`/`before` count from a
   visible text ("the first button after Share") — useful for icon buttons with no name.
5. `read` again to see what changed. Refs are only valid for the snapshot they came from.
6. `session_close` when done. Persistent profiles keep their cookies; a profile with
   `keep_session_cookies:true` also keeps session cookies across closes.

Rules of thumb:
- Read before you click; never guess refs. After a navigation or a big click, read again.
- Prefer `role`+`name` or `text` targets over CSS selectors; they survive redesigns.
- Don't fire dependent browser calls in parallel. One action, then look.
- Use `screenshot` when the a11y tree doesn't explain what you see (overlays, canvases, layout).
  Credential fields and secret-looking values are masked in `read` and `screenshot`.
- Every call has a deadline; `timeoutMs` (100–60000) shortens the wait for an element.

## Passwords and other secrets

Never put a password in a `type` value. Instead:
1. `secret_create {label}` → you get a `secret_id` and a one-time PUT URL with a ready `curl` line.
2. Pipe the secret into that curl from where it is stored (a secrets manager, `sops -d --extract …`),
   so it never appears in your context or a log.
3. `type {session, secret_id, selector:"input[type=password]", submit:true}`.
   Secrets go only into password inputs unless you set `allow_non_password:true` (OTP or e-mail fields).

## When a human is needed

`request_human {session, reason}` returns a live-view link (phone-friendly, one viewer at a time).
Send it to your human, then call `handoff_wait` until it returns done. While a handoff is active,
page tools are refused. Use it for CAPTCHAs, 2FA codes you can't get, unusual login prompts —
not as a first resort: try the login yourself first.

## Logins that stay alive

`keepalive_set {profile, url, logged_in_check, every_hours}` visits the page on a schedule without
a model and pushes `bosun:needs-human` when the profile is logged out. Add `watch` to read one value
(say, an unread counter) and get `bosun:watch-changed` when it changes. `keepalive_list` shows the
last results.

## Files

- Upload: `upload_create` (base64 for ≤1 MB, or a PUT URL) → `upload {session, file_id, target}`.
- Download: click the link → `download_wait` → `download_get` (one-time URL, or `inline` for small text).
  Only hosts on your tenant's download allowlist are kept.

## Macros (repeatable flows)

Save a flow once with `macro_save {name, site, params, steps}`, rerun it with `macro_run`.
Steps mirror the tools (`navigate`, `click`, `type`, `select`, `hover`, `press`, `wait_for`, `upload`,
`download_wait`, `read`, `screenshot`, `assert`) plus control flow:
- `if_exists {target, then, else}` — instant presence check, no waiting;
- `repeat {while, max, steps}` — `max` (1–100) is required; the result reports `count` and `max_hit`;
- per-step `timeoutMs`, and `optional:true` for steps that may fail.
`read` and `assert` results come back in the run output. Use `{{param}}` for inputs; secrets and files
only as `secret_id` / `file_id` params. Try `dry_run:true` first. Steps that pay, buy, check out or
delete an account are refused unless the macro was saved with `confirm_risky:true` — and you should
only do that with the human's explicit approval.

## Meetings (Google Meet, Zoom)

`meeting_join {url, …}` joins as a notetaker (mic and camera off), posts a recording notice, records
audio, and leaves when the meeting ends or everyone leaves.
- `profile`: join with a signed-in Google/Zoom profile — far fewer refusals than a guest. A guest
  `name` is used only without a profile.
- `announce`: `chat` (default, everyone), `host` (host only) or `none` — use `none` only when the
  meeting owner told you so. An opt-out in the chat ("please don't record") always stops and deletes.
- `record_video:true` adds a separate WebM of the meeting page; audio stays a separate Ogg.
- `live_transcript:true` gives transcript finals live (`meeting_transcript`, or as an MCPL channel).
- `dry_run:true` only checks the lobby.
Then: `meeting_status`, `meeting_chat_read` / `meeting_chat_send`, `meeting_speak` (text → voice),
`meeting_mute`, `meeting_raise_hand`, `meeting_leave`. Afterwards `recording_get` gives the audio,
the optional video, and a speaker timeline (who was highlighted when) to label a transcript.
In group calls, speak only when addressed.

## Don'ts

- Don't paste passwords or tokens into `type` values, macro steps, or messages.
- Don't buy, pay, send or delete on someone's behalf without their explicit OK.
- Don't record a meeting silently unless the meeting owner asked for `announce:"none"`.
- Don't leave sessions open; close them when the task is done.
