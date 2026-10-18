# Bosun

**The boatswain browser for agents.** A self-hosted browser service that gives AI agents a real browser — and
calls a human on deck when it needs one (CAPTCHA, cookie wall, 2FA).

> Status: **prototype (M0)**. Works end to end in one deployment; APIs will change. See [docs/DESIGN.md](docs/DESIGN.md)
> and [CHANGELOG.md](CHANGELOG.md).

## What it does today

- Headful Chromium (Playwright) under Xvfb — fewer bot flags than headless.
- **Engines** (`ENGINE`, or `engine` on `session_open`): `chromium` (default), `patchright` (Chromium without the
  CDP/automation leaks) and `camoufox` (anti-detect Firefox). See [docs/ENGINES.md](docs/ENGINES.md) for what each one
  passes and what it costs.
- MCP server over **stdio** (Claude Code, Codex, …) or **WebSocket** (shared service).
- Tools: `session_open` / `session_close` / `sessions`, `navigate`, `read` (accessibility snapshot with element
  refs), `click`, `type`, `select`, `press`, `back`, `wait_for`, `screenshot`, `request_human`, `handoff_wait`.
- Sessions are **ephemeral** (wiped on close) or use a named **persistent profile** of the tenant (stays logged in;
  no RAM while idle). A session belongs to the connection that opened it: other connections can't see, use or close
  it, and it is closed when that connection goes away or after `IDLE_TIMEOUT_SEC` without use.
- `navigate` accepts only `http://` and `https://` URLs.
- **Bot-wall detection** after navigation/click (Cloudflare challenge pages, CAPTCHA iframes, "access denied" texts).
- **Human handoff:** `request_human` returns a link (15 min) to a **live view** of the tab (CDP screencast; taps,
  scroll and typing are forwarded; works on a phone). **Done** resumes the agent. See [Handoff](#handoff) for what
  is and isn't protected.

## Run

```sh
npm ci                                   # add --omit=optional to skip patchright/camoufox
npx playwright install --with-deps chromium
npx patchright install chromium          # only for ENGINE=patchright
npx camoufox-js fetch                    # only for ENGINE=camoufox (Node 22+)
npm test            # headless, against a local test server; no internet needed
npm run test:engines  # the same suite once per installed engine

# stdio (an MCP client spawns it)
xvfb-run -a node src/server.mjs

# WebSocket service + live view, reachable over a VPN interface (here 100.64.0.10)
WS_HOST=100.64.0.10 WS_PORT=7360 BROWSER_TOKEN=<32+ random chars> \
LIVE_HOST=100.64.0.10 LIVE_PORT=7350 LIVE_BASE_URL=http://100.64.0.10:7350 \
  xvfb-run -a -s "-screen 0 1366x900x24" node src/server.mjs
```

Clients authenticate with `Authorization: Bearer <token>` (the old `?token=` query parameter still works but puts
the secret in URLs and logs; prefer the header). The WebSocket listener **refuses to start** on a non-loopback
address without a token; on loopback an unauthenticated listener needs `ALLOW_NO_TOKEN=1` (local development only).
The two listeners are separate: `WS_HOST`/`WS_PORT` carry MCP (token-protected), `LIVE_HOST`/`LIVE_PORT` serve the
human's live view (protected by the one-time link). Both default to `127.0.0.1`; bind them to a VPN/mesh address or
put a TLS reverse proxy in front, and set `LIVE_BASE_URL` to the address the human's phone uses.

### Environment

| variable | default | |
|---|---|---|
| `BROWSER_TOKEN` | – | token for tenant `default` (16+ chars) |
| `BROWSER_TOKENS` | – | more tenants: `alice:<token>,bob:<token>` |
| `WS_HOST` / `WS_PORT` | `127.0.0.1` / – | WebSocket MCP listener (stdio when `WS_PORT` is unset) |
| `WS_ALLOWED_ORIGINS` | – | comma list of browser Origins allowed to connect (non-browser clients send none) |
| `ALLOW_NO_TOKEN` | – | `1` = no auth, loopback only |
| `MAX_CONNECTIONS` | 32 | concurrent WebSocket connections |
| `MAX_INFLIGHT` | 8 | concurrent tool calls per connection |
| `LIVE_HOST` / `LIVE_PORT` / `LIVE_BASE_URL` | `127.0.0.1` / – / derived | live view listener and the URL put in links |
| `HANDOFF_TTL_SEC` | 900 | handoff link lifetime |
| `BROWSER_DATA` | `./data` | profiles (`profiles/<tenant>/<name>`) and saved screenshots |
| `HEADLESS` | – | `1` = headless browser (more detectable; use for tests) |
| `ENGINE` | `chromium` | default engine: `chromium`, `patchright`, `camoufox` (must be installed, or startup fails) |
| `CAMOUFOX_OS` | host OS | OS of the Camoufox fingerprint: `macos`, `windows`, `linux` |
| `MAX_SESSIONS` | 3 | sessions across all tenants |
| `MAX_SESSIONS_PER_TENANT` | `MAX_SESSIONS` | |
| `IDLE_TIMEOUT_SEC` | 900 | close sessions unused this long (`0` = never; a session in handoff is never idle) |
| `MAX_PAGES_PER_SESSION` | 5 | popups beyond this are closed |
| `MAX_DOM_NODES` | 60000 | `read` (a11y, whole page) refuses larger pages; pass `selector` |
| `SAVE_SHOTS` / `SHOTS_PER_SESSION` | – / 20 | `1` = also keep screenshots on disk (0600, deleted when the session closes) |

All numbers are validated at startup; a bad value stops the service instead of silently disabling a limit.

### Engines

| engine | process model | live view | notes |
|---|---|---|---|
| `chromium` | one shared browser, a context per session | CDP screencast | Playwright's Chromium |
| `patchright` | a browser per session (persistent context; temp profile for ephemeral sessions) | CDP screencast | patchright's recommended setup: no custom UA, no automation-flag args, window-sized viewport |
| `camoufox` | a browser per session | Playwright screencast + `page.mouse`/`keyboard` | fingerprint (window, screen, fonts, UA) from Camoufox; `humanize` off (hangs clicks with Playwright 1.64) |

A session asking for an engine that isn't installed gets an error naming the install command; there is no silent
fallback to another engine. A persistent profile remembers its engine family (Chromium or Firefox) and refuses the
other. patchright and camoufox-js are `optionalDependencies`; their browsers are separate downloads.

Chromium spawns many threads: under systemd give the unit a generous `TasksMax` (e.g. 2000).

## Handoff

- The link is **one-time**: opening the page (e.g. a chat app's link preview) doesn't use it up, but the first live
  view that connects claims it. From then on only that browser tab (it holds a viewer key) can connect, one socket
  at a time. Done, Give up, expiry, `session_close` and disconnect of the agent revoke it.
- While a handoff is active **every** page tool (`read`, `screenshot`, `navigate`, `click`, `type`, `select`,
  `press`, `back`, `wait_for`) is refused, and `sessions`/`handoff_wait` report no URL or title. Tool calls that were
  already running when `request_human` came in finish first; the human gets the tab after them.
- `handoff_wait` waits 50 s by default (below the MCP SDK's 60 s request timeout); call it again on `still_waiting`.
  Longer `timeoutSec` needs a longer client-side request timeout.
- After the handoff the agent can read the page again. What the human typed into **password, PIN, OTP and card
  security-code fields** (detected by input type, `autocomplete`, name/id and label, across frames and open shadow
  roots, including show-password toggles) is masked as `[masked]` in `read` output and blacked out in screenshots.
  After **Give up / timeout / cancel** those fields are emptied before the agent resumes; if that fails, the
  session is closed instead. If a frame can't be inspected, `read`/`screenshot` fail rather than return unmasked
  output. The handoff ends only after the human's last input has reached the page.
- A password field that is revealed with a show-password toggle stays masked: an event-driven tracker remembers every
  input that ever was `type=password` (incl. shadow roots), and Bosun also notes them when a handoff starts and every
  500 ms during it. On `chromium` Bosun's helpers run in the page's own JavaScript world, so a page can detect them;
  on `patchright` and `camoufox` they run in an isolated world (details in [docs/ENGINES.md](docs/ENGINES.md)).
- Not protected: text the human types into ordinary fields, secrets the page itself echoes as normal text, custom
  widgets that aren't `<input>`/`<textarea>` (e.g. per-digit OTP boxes built from `div`s), closed shadow roots.
  Those are visible to the agent after Done. Ask the human to finish the login (submit it) before pressing Done.

## Security notes

- One service is one trust domain per **tenant** (token): a tenant's connections share its persistent profiles;
  sessions are private to the connection. For hard isolation run one process (and data dir) per tenant.
- Web content is untrusted (prompt injection). Run the service where it **can't reach private networks**
  (block 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 egress) — otherwise a page can steer it at your LAN.
  The `http(s)`-only check on `navigate` does not replace that boundary. Run it as a user that can't read secrets.
- Live-view links are bearer tokens until claimed: serve them on a private network (VPN/mesh) or behind TLS, and
  send them over a private channel.
- No rate limiting yet beyond the connection, in-flight and session caps.

## Roadmap

M1 tenant quotas/audit log, mobile viewport for handoff · M2 vault (`fill_credential`), downloads as content
references, watch · M3 stealth engines (patchright, Camoufox), macros · MCPL push events (`bosun:needs-human`, …).

## License

MIT
