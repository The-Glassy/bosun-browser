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
| `browser.macros` | tools | record/run deterministic step sequences without a model in between |

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
(0.6.0, feature set `bosun.meeting`, see README › Meetings (PoC)); the server's namespace is `bosun:`.
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
