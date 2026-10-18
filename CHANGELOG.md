# Changelog

## 0.0.2 — review fixes (Codex round 1)

Fixes from the first security/correctness review (B01–B26). Tool names and parameters are unchanged except where
noted under **Changed behaviour**.

### Changed behaviour

- **Sessions are owned by the connection that opened them.** Other connections no longer see them in `sessions` and
  get `no session <id>` when they try to use or close them. Sessions are closed when their connection disconnects
  (previously they stayed open, shared by everyone, until closed or restart) and after `IDLE_TIMEOUT_SEC` (900) idle.
- **Persistent profiles moved to `profiles/<tenant>/<name>`.** Tenant `default` is used for stdio and `BROWSER_TOKEN`.
  To keep an existing profile: `mv data/profiles/<name> data/profiles/default/<name>`. A profile can be open in one
  session at a time (`profile … is already open`).
- **WebSocket auth is mandatory.** The service refuses to start on a non-loopback `WS_HOST` without
  `BROWSER_TOKEN`/`BROWSER_TOKENS`; on loopback an open listener needs `ALLOW_NO_TOKEN=1`. Tokens must be at least
  16 characters. Browser `Origin`s are refused unless listed in `WS_ALLOWED_ORIGINS`. `Authorization: Bearer` is
  preferred; `?token=` still works.
- **`navigate` accepts only http/https** (was: any URL syntax, incl. `file:` and `javascript:`).
- **Handoff blinding covers every page tool** (`select`, `press`, `back`, `wait_for` were not blocked), and
  `sessions` / `handoff_wait` (`still_waiting`) no longer return URL/title during a handoff. `sessions` shows
  `handoff: "active"` instead of `url` for such sessions.
- **`handoff_wait` default timeout is 50 s** (was 300 s, beyond the SDK's 60 s request timeout).
  `request_human` with `wait=true` now waits at most 50 s and may return `still_waiting` with the link.
- **Live-view links are claimed by the first WebSocket viewer**; afterwards only that viewer (by key) can connect,
  one socket at a time.
- **Live view binds `LIVE_HOST`, default `127.0.0.1`** (was `0.0.0.0`). Set it to your VPN address (or `0.0.0.0`).
- **Screenshots are no longer written to disk by default.** `SAVE_SHOTS=1` keeps them (per session, 0600, at most
  `SHOTS_PER_SESSION`, deleted on close). The text part of the result is then the path, otherwise a note.
- **Argument bounds:** `read.maxChars` 1–200000, `wait_for.timeoutMs` ≤ 60000, `request_human.reason` 1–300 chars,
  `handoff_wait.timeoutSec` 1–1800, length limits on selectors/text/values. `read` in a11y mode refuses pages over
  `MAX_DOM_NODES` without a `selector`; full-page screenshots are cut at 8000 px.
- Configuration is validated (`MAX_SESSIONS=abc` used to disable the cap); bad values stop startup.

### Fixed

- B01 cross-connection access to sessions and profiles → per-connection ownership, per-tenant profile directories.
- B02 / B26 unauthenticated network listener, non-constant-time compare → mandatory token, auth in the HTTP upgrade
  before any WebSocket/MCP server exists, SHA-256 digests compared with `crypto.timingSafeEqual`.
- B03 scheme policy on `navigate`.
- B04 / B05 handoff blinding gaps and in-flight races → one per-session operation queue for all page tools;
  `request_human` queues behind running work; results of operations overtaken by a handoff are discarded.
- B06 password masking by label → detection by DOM type/autocomplete/name/label in all frames, value-based masking
  in `read`, masked screenshots, credential fields cleared after an unsuccessful handoff.
- B07 / B08 / B19 reusable link, expiry/attach race, interleaved input → claim on first socket + viewer key, single
  viewer, attach re-checks state after every await, validated input dispatched through one FIFO that finish revokes.
- B09 / B10 crash on malformed upgrade URL or socket errors → guarded upgrade handlers, error listeners everywhere,
  connection failures isolated to the connection.
- B11 session cap race and duplicate browser launches → synchronous reservation, single-flight launch promise.
- B12 unbounded resources → `maxPayload` (1 MiB MCP, 16 KiB live view), connection and in-flight caps, heartbeats,
  screencast frames acked after send and dropped above 1 MiB buffered, input queue bounded.
- B13 / B14 / B15 / B16 / B17 lifecycle → one idempotent disposal path (close, crash, page close, idle, disconnect,
  shutdown) that cancels the handoff and releases capacity; browser relaunch after a crash; partial opens cleaned up;
  shutdown stops admission, is idempotent and deadline-bounded.
- B18 handoff wait timers and stale-handoff clearing.
- B21 screenshot retention.
- B22 examples no longer print the live-view link or page content; the link goes to a private 0600 temp file.
- B23 WebSocket transport `send` rejects on a closed socket and settles from the write callback.
- B24 `npm test` (node:test): config/auth, service, handoff and live-view race suites against a local page server.
- B25 `package-lock.json` committed (`npm ci` works); README corrected.

### Round 2 (second Codex review, R01–R09)

- R01 MCP connections with more than 64 unanswered requests, or more than 8 MiB of unread output, are disconnected.
- R02 A handoff ends only after the human's in-flight input has returned and the screencast is detached; if that
  hangs (10 s) the session is closed.
- R03 A connection that disconnects while `session_open` is still launching no longer leaves an orphaned session.
- R04 Inputs that are or ever were `type=password` are tracked from document start (init script, incl. open shadow
  roots), so show-password toggles count even before Bosun's first scan.
- R05 `aria-labelledby` resolves inside the input's own shadow tree.
- R06 Masking fails closed: `read`/`screenshot` return an error if a (non-detached) frame can't be inspected, and if
  clearing credential fields after give-up/timeout fails, the session is closed instead of handed back.
- R07 Shutdown also waits for disposals that were already in progress.
- R08 The `read` DOM-size guard counts frames and open shadow roots.
- R09 A screenshot write that finishes after its session closed is deleted and the call fails.
- Calls on a session closed by Bosun (idle, crash, cleanup failure) say why: `no session <id> (closed: <reason>)`.

## 0.0.1

M0 prototype.
