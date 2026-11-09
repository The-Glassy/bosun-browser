# Bosun 0.23.0 egress fix round

Based on `00040e6` on `egress-proxy`. Nothing pushed. The supplied `BRIEF-fix.md` is preserved and uncommitted.

## Causes and fixes

### Handoff sessions list

Retained `egress`: it is the session's selected route name, without proxy credentials, page URL or title.
Updated the exact sessions-list expectation to include `egress: 'default'` and explicitly checked that neither
the secret title value nor the page server's URL appears. All page-tool refusal checks remain intact.

### Empty title through the authenticated exit

The fixture returned an empty `407` response without `Proxy-Authenticate`. Chromium did not retry with the
credentials supplied through Playwright's proxy option. Playwright completed navigation to that HTTP response;
Bosun returned `isError: false` because an HTTP error response is not itself a navigation exception. The empty
response document correctly had an empty title.

Extracted the existing exit into `test/egress-fixture.mjs`, shared by the tests and the small standalone
reproduction, `node scripts/repro-egress-auth.mjs`. With the same browser flags, proxy credentials, bypass rule,
`domcontentloaded` wait and `http://exit-only.invalid/page` target, the reproduction reports:

| Fixture response | HTTP status | Title | Requests for the page at exit | Forwarded requests | Direct origin connections |
| --- | --- | --- | --- | --- | --- |
| Bare 407 (original) | 407 | `''` | One unauthenticated | 0 | 0 |
| Basic challenge | 200 | `Exit` | Unauthenticated, then authenticated retry | 1 | 0 |

Added `Proxy-Authenticate: Basic realm="fixture-exit"` to both HTTP and CONNECT authentication refusals.
This fixes the fixture's authentication handshake; the `.invalid` hostname, browser routing and navigation
timing did not need changing. The integration test still requires title `Exit` and the exact request at the
exit, and now also requires HTTP 200 and zero direct origin connections before and after exit failure.
The fixture distinguishes exit-forwarded TCP connections by their outgoing socket ports.

### Ephemeral direct/default routing

The reported shared-browser bug is already prevented at the requested base commit. Verified against
`git show 00040e6:src/engines.mjs`: `launchShared` has no proxy option. The launch using `cfg.egressProxy` is
`sandboxPreflight`, a separate Linux startup check whose browser is immediately closed. It does not serve sessions.

Kept the existing simple architecture: shared Chromium is always direct; a session with a resolved exit or an
allowlist proxy gets its own temporary persistent browser, including its proxy leak-prevention flags and profile
preferences. This is stricter isolation than applying the default exit only at context creation. No runtime
routing change was necessary at this HEAD; clarified the comments and added regression coverage:

- A real `SessionManager`, real Chromium and the authenticated fixture, without a tenant allowlist: concurrent
  ephemeral `direct` and `default` sessions navigate to the same local origin. `default` reaches the exit and
  opens zero direct origin connections; `direct` opens an origin connection and never sends its path to the exit.
  The test also checks that only the direct session uses the shared browser and that the default session has a
  private temporary profile.
- The existing launch-options test now supplies an authenticated default exit and still requires the shared
  browser's proxy to be absent and its arguments to be the direct-browser arguments.

## Validation

Environment: macOS arm64, Node 25.2.1, Playwright 1.64.1, Chrome Headless Shell 156.0.8078.4 (revision 1248).
The browser binary required by the installed Playwright was initially missing; installed it with
`npx playwright install chromium`. No package or lockfile changes were made.

- Reproduced the original browser-test assertion failure before fixing the fixture.
- `node scripts/repro-egress-auth.mjs`: both before/after cases passed their strict assertions.
- `node --test --test-timeout=60000 --test-reporter=tap test/egress.test.mjs test/handoff.test.mjs`:
  **49 tests, 48 passed, 0 failed, 0 cancelled, 1 skipped** (the existing stealth-engine-only check).
- `node --test --test-name-pattern='the engine launches Chromium' test/features.test.mjs`: **1 passed**.
- `npm test` (unmodified suite command, concurrency 4): **610 tests, 599 passed, 2 failed, 0 cancelled,
  9 skipped**, completed in about 15 minutes. Both requested failures and the new routing regression passed.
  This run is not green: the two failures below are in unchanged meeting/upload tests. There were **no sandbox
  listener, EPERM or EACCES failures**; local listeners and real Chromium worked here.
- Investigated the full-run failure in `test/meeting-live.test.mjs` (speech settings per tenant): isolated
  runs of that test passed on both this checkout and an archive of the original `00040e6` (**1 passed each**).
  On the original commit, running the first live-transcript test followed by the speech-settings test also
  passed (**2 passed**). The full-run assertion at line 344 read VAD `0.5` instead of `0.8`. A likely existing
  test race is that the preceding wait accepts any connection in the shared `el.conns` array, without waiting
  for this meeting's new connection, and can read the previous connection. This is an inference from the test
  and full-run result; the reruns did not reproduce it. Left this unrelated test unchanged.
- The 200 MB upload memory test also failed outside the changed files. Isolated reruns reproduced its RSS
  limit failure on both this checkout (**83 MB growth**) and original `00040e6` (**78 MB growth**), against its
  64 MB limit. The full run measured **66 MB growth**. The original-commit failure confirms this is not introduced
  by this fix round. Left this unrelated test unchanged.
- Syntax checks passed for all seven changed/new JavaScript modules. `git diff --check` passed.

Logs: `/tmp/bosun-egress-before-browser.log`, `/tmp/bosun-egress-auth-repro.log`,
`/tmp/bosun-egress-fix-focused.log`, `/tmp/bosun-egress-fix-shared-launch.log`, `/tmp/bosun-egress-fix-full.log`.
Speech reruns: `/tmp/bosun-egress-fix-speech-current.log`, `/tmp/bosun-egress-fix-speech-baseline.log`,
`/tmp/bosun-egress-fix-speech-baseline-pair.log`. The baseline archive's path is saved in
`/tmp/bosun-egress-fix-baseline-path`; it shares this checkout's installed dependencies.
Upload reruns: `/tmp/bosun-egress-fix-upload-current.log`, `/tmp/bosun-egress-fix-upload-baseline.log`.

## Commits

- `a054274` — Fix authenticated egress fixture and guard ephemeral direct routing.
- `Document egress fix causes and validation results` — documentation commit containing this report and the
  full-suite results.

Author: Glassy <342939150+The-Glassy@users.noreply.github.com>. No Claude/Codex trailers.

## Questions

None. Linux rerun remains with the requester as planned.
