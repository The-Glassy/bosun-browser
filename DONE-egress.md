# Egress proxy — 0.23.0

Implemented the brief, including per-profile exits. Nothing was pushed.

## Changes

- `BROWSER_EGRESS_PROXY`: validated HTTP proxy URL with optional credentials, or unauthenticated SOCKS5. Empty
  configuration retains direct networking. Credentials are separated from server URLs and percent-decoded.
- All browser launch paths use the selected proxy and the existing QUIC/WebRTC restrictions, with DNS prefetch
  disabled: chromium, patchright, camoufox, profiles, ephemeral contexts, keepalive, macros, meeting joins/dry runs,
  and Chromium's Linux sandbox preflight. Proxied sessions use private browser processes, avoiding shared flags.
- Allowlist proxies retain host/private-address checks and forward plain HTTP through the exit; HTTPS and
  WebSockets use CONNECT. SOCKS5 uses CONNECT tunnels for all protocols. There is no direct retry path. The exit
  receives hostnames, while local DNS is still used to reject locally private/unresolvable names. Code comments
  and README explain why exit-side DNS cannot also provide local address pinning.
- `BROWSER_EGRESS_PROXIES` maps names to URLs. `session_open.egress` supports `default`, `direct`, or a configured
  name. Successful profile opens persist the choice in `bosun-profile.json`; background/media opens reuse it.
  Missing saved names fail closed. Concurrent allowlist routes are keyed by tenant and exit.
- Proxy failures identify the credential-free exit. Authenticated `GET /health` on the MCP port reports default
  and named exits (200/503, 401 without authentication). This checkout had no existing HTTP health endpoint.
  Probes check HTTP OPTIONS/authentication or SOCKS negotiation without contacting an arbitrary target site.
- Shared redaction now removes proxy URL userinfo from tool/startup errors. Authenticated exits refuse the same
  unsafe diagnostics as typed secrets (`NODE_DEBUG` and sensitive Playwright `DEBUG` modes), because those log
  outside Bosun's logger. Egress environment secrets are removed before child processes start.
- README Egress section, CHANGELOG 0.23.0, package/lockfile and MCP server version updated. Searching for the previous release version
  leaves only the historical CHANGELOG/DECISIONS entries and the supplied brief.

## Routing inventory

Browser navigations, redirects, subresources, XHR/fetch, page/worker/service-worker WebSockets, browser downloads,
and page file uploads use the selected exit. `download_get` and `recording_get` serve local files/inline content;
there is no second origin fetch or external recording upload in those handlers. `upload_create` receives bytes
from the caller. MCP/live view and local file transfers retain their existing networking. ElevenLabs live
transcription/TTS, configured TTS services, externally run whisper/transcription, and browser installation/update
operations deliberately retain their existing networking.

## Validation

- Final full-suite result: **610 tests: 119 passed, 479 failed, 3 cancelled, 9 skipped, 0 todo**.
  The run is not green. Failures are dominated by forbidden localhost listeners (`EPERM`) and dependent hooks;
  Chromium launch and process-lookup checks also hit sandbox restrictions. The per-test bound cancels stalled
  setup. This is an environment-limited attempt, not evidence that browser/network integration passes.
- Focused browser-free egress regressions: **24 passed, 0 failed, 0 skipped**. Covers all three engines' launch
  options, empty config, named/direct/default profile persistence, background/media reuse, removed exits, private
  address refusals, HTTP CONNECT and SOCKS5 protocol success/refusal/close/deadline, fragmented SOCKS replies and
  preservation of application bytes, health protocol responses, MCP parameter/errors, and diagnostic guards.
- Complete final egress file: **24 passed, 5 failed, 0 cancelled, 0 skipped** (29 tests).
  All five local fake-exit/browser tests fail at `listen EPERM: operation not permitted 127.0.0.1` in this sandbox.
  These tests cover HTTP/CONNECT chaining, WebSocket Upgrade, no direct target connection on failure, real-browser
  routing/health, and concurrent profile exits. They are present but could not be exercised here.
- Existing config subset: **9 passed, 0 failed, 0 skipped**. Existing engine/configuration launch-option subset:
  **4 passed, 0 failed, 0 skipped**. Existing speaker-timeline suite: **20 passed, 0 failed, 0 skipped**.
- Syntax checks: **85 source/test modules passed**; the final changed modules were checked again. Package and
  lockfile versions agree on 0.23.0. `git diff --check` passed.
- `npm test` was attempted, then interrupted because hooks awaiting forbidden listeners could hang indefinitely.
  Full-suite runs use the same files/concurrency with a 10-second per-test bound:
  `node --test --test-timeout=10000 --test-concurrency=4 --test-reporter=tap test/*.test.mjs`.
- Logs: `/tmp/bosun-egress-full-release-final.log`, `/tmp/bosun-egress-unit.log`,
  `/tmp/bosun-egress-all-final.log`, `/tmp/bosun-egress-config-unit.log`,
  `/tmp/bosun-egress-engine-options.log`, `/tmp/bosun-egress-speaker.log`.

## Review / remaining risks and questions

`codex review --uncommitted -c 'sandbox_mode="read-only"' -c 'approval_policy="never"'` was attempted and failed
before review: `failed to initialize in-process app-server client: Operation not permitted (os error 1)`.
The log is `/tmp/bosun-egress-review.log`. I inspected the full diff manually; protocol tests caught and fixed a
fragmented SOCKS reply starvation bug, and review added the diagnostic credential guard and preserved origin 5xx
responses instead of misclassifying them as exit failures.

For your review, the riskiest parts are:

1. Real-engine/network integration remains unverified here. Re-run `npm test` and `npm run test:engines` on the
   deployment/test host; this sandbox also prevents Chromium's macOS Mach service startup and `ps` process lookup.
2. DNS preflight and exit-side DNS can disagree. Hostname allowlists necessarily trust the exit's DNS/private
   network policy; literal public IP entries preserve pinning. Local preflight DNS failure intentionally denies.
3. Health OPTIONS/SOCKS negotiation proves endpoint/protocol reachability, not successful forwarding to a
   particular site or availability of CONNECT to every port. Confirm the old host's proxy permits the required
   HTTPS/WebSocket targets. HTTP Basic and unauthenticated SOCKS5 are supported; SOCKS authentication is refused.
4. Meeting browser traffic follows the exit and WebRTC restrictions; actual Meet/Zoom joins and proxy-compatible
   media transport could not be tested here. The deliberate `direct` override still enforces tenant allowlists.

No product decisions are left open. Deployment verification above is still required before relying on the exit.

## Commits and sandbox limitation

The requested author is Glassy <342939150+The-Glassy@users.noreply.github.com>; no AI trailers were added.
The managed sandbox makes the original `.git` read-only, so `git switch -c egress-proxy` there failed to create its
lock with `Operation not permitted`. The original checkout remains on main with the implemented files modified.
Commits are on branch `egress-proxy` in the writable Git metadata copy at
`/tmp/bosun-egress-git.jwSr8v/repo.git`, using this checkout as its work tree:

- `817bc5e`: core browser/allowlist egress routing.
- `7de090b`: per-profile choices, keepalive/meeting reuse.
- `af8bdcb`: protocol hardening and regressions.
- `c6e1ac5`: diagnostic credential guard.
- A final release/documentation commit also contains this report.

`egress-proxy.bundle` contains all new commits, based on 9474d8e, for importing into the original repository once
Git metadata is writable. It is a local artifact, not a push. From this directory:

```sh
git fetch ./egress-proxy.bundle refs/heads/egress-proxy:refs/heads/egress-proxy
git switch egress-proxy
```

The supplied untracked `BRIEF-egress.md` is preserved and is not included in the commits.
