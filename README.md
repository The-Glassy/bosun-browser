# Bosun

**The boatswain browser for agents.** A self-hosted browser service that gives AI agents a real browser — and
calls a human on deck when it needs one (CAPTCHA, cookie wall, 2FA).

> Status: **prototype (M0)**. Works end to end in one deployment; APIs will change. See [docs/DESIGN.md](docs/DESIGN.md).

## What it does today

- Headful Chromium (Playwright) under Xvfb — fewer bot flags than headless.
- MCP server over **stdio** (Claude Code, Codex, …) or **WebSocket** (shared service).
- Tools: `session_open` / `session_close` / `sessions`, `navigate`, `read` (accessibility snapshot with element
  refs), `click`, `type`, `select`, `press`, `back`, `wait_for`, `screenshot`, `request_human`, `handoff_wait`.
- Sessions are **ephemeral** (wiped on close) or use a named **persistent profile** (stay logged in; no RAM while idle).
- **Bot-wall detection** after navigation/click (Cloudflare challenge pages, CAPTCHA iframes, "access denied" texts).
- **Human handoff:** `request_human` returns a one-time link (15 min) to a **live view** of the tab (CDP screencast;
  taps, scroll and typing are forwarded; works on a phone). While it's active the agent can't read or screenshot the
  tab, so typed secrets never reach the model. **Done** resumes the agent.

## Run

```sh
npm ci
npx playwright install --with-deps chromium

# stdio (an MCP client spawns it)
xvfb-run -a node src/server.mjs

# WebSocket service + live view
WS_PORT=7360 LIVE_PORT=7350 LIVE_BASE_URL=http://<host>:7350 BROWSER_TOKEN=<secret> \
  xvfb-run -a -s "-screen 0 1366x900x24" node src/server.mjs
```

Environment: `BROWSER_DATA` (profiles, screenshots; default `./data`), `HEADLESS=1`, `MAX_SESSIONS` (default 3),
`WS_HOST` (default 127.0.0.1), `WS_PORT`, `BROWSER_TOKEN`, `LIVE_PORT`, `LIVE_BASE_URL`.

Chromium spawns many threads: under systemd give the unit a generous `TasksMax` (e.g. 2000).

## Security notes

- Web content is untrusted (prompt injection). Run the service where it **can't reach private networks**
  (block 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 egress) — otherwise a page can steer it at your LAN.
- Live-view links are bearer tokens: serve them on a private network (VPN/mesh) or behind TLS.
- Password fields are masked in `read` output; nothing in tool results contains what a human types during a handoff.

## Roadmap

M1 multi-tenant tokens/quotas, mobile viewport for handoff · M2 vault (`fill_credential`), downloads as content
references, watch · M3 stealth engines (patchright, Camoufox), macros · MCPL push events (`bosun:needs-human`, …).

## License

MIT
