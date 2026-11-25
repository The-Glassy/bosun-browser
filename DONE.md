# Bosun 0.28.0

## What changed

- `v0.28` includes the health changes from PR #47. The gateway keeps the public listeners and one private worker per tenant when sandboxing is enabled. Each worker's browsers, persistent files, temporary paths, process tree, and network are isolated with bubblewrap. Browser traffic uses a tenant-specific host relay.
- `/health` and `/health/exits` are public and expose status, public names and timestamps. `/metrics` exports `bosun_exit_up` publicly by default and accepts a dedicated bearer when `BOSUN_METRICS_TOKEN` is configured.
- The guest name, recording announcement and time zone keep their 0.27 defaults. The deploy guide explains how to set explicit names, text and time zones.
- `speech_settings_get` and `speech_settings_set` expose the two leave timers. `meeting_join` accepts per-call overrides and `meeting_status` reports the effective values. All 48 tool registrations match the PR #47 baseline, including the existing secret tools.
- README, changelog, and [tenant sandbox documentation](docs/TENANT-SANDBOX.md) cover setup, egress, metrics and state migration.

## Decisions

- The default is `off`. When configured, `auto` counts token entries. Multiple entries for one tenant enable a single isolated worker. Shared mode logs a startup warning for distinct tenants unless acknowledged with `BOSUN_ALLOW_UNSAFE_SHARED=1`.
- The gateway pins host DNS answers before dialing, including when it uses a named HTTP or SOCKS5 exit. A private address requires an exact allowlist entry. `BROWSER_TENANT_EGRESS` can restrict the configured exits available to a tenant.
- Sandboxed workers mount only `BROWSER_DATA/tenants/<tenant>/` as durable state. The `bosun migrate-data` command migrates and backs up existing data, and supports reversing the layout. `BROWSER_MACRO_SOURCE` requires shared mode because it reads another tenant's macro directory.
- The leave timers accept whole seconds from 5 through 3600. The existing 30-second wait after the last departure and 120-second wait for the first participant remain the defaults. A meeting keeps the values resolved at join time.
- A configured announcement is a single string and the built-in consent matcher retains its multilingual coverage. The proposal's broader configuration schema, worker resource metrics and credential resolver are outside the implemented scope.

## Initial PR branch verification

`xvfb-run -a npm test` with `BOSUN_TEST_SANDBOX=1` exited 0 on Linux x64, Node 24.22.1 and bubblewrap 0.12.0.
A disposable mount namespace detached the test host's extra procfs submounts so bubblewrap could mount a private
`/proc`.

```text
✔ two real bwrap tenants isolate profiles, downloads, tmp, connection leases and egress
✔ the gateway diagnostic guard applies to secret tools in its worker
ℹ tests 699
ℹ pass 695
ℹ fail 0
ℹ cancelled 0
ℹ skipped 4
ℹ duration_ms 827633.012246
```

The three Camoufox-specific skips passed separately with that engine enabled. The live ElevenLabs case requires an
API key and stayed skipped. The local provider fixtures passed. Manual checks passed for private Xvfb and browser
navigation using Chromium, Patchright and Camoufox, PulseAudio startup inside bwrap, the sandboxed stdio entry
point, and worker restart while the other tenant's session stayed usable.

ESLint 9.39.4 passed with zero warnings across source, scripts and tests using a temporary correctness-rule
configuration. `git diff --check` passed.

## Open risks

- Deployment-specific AppArmor, systemd and container namespace policies still need validation on the target host.
  This run exercised Linux x64. ARM64 support and production state migration remain unverified.
- The sandbox shares the host kernel, service UID and disk. Per-worker limits apply to sessions and video slots.
  Host memory, process and disk limits still depend on deployment configuration.
- Upstream exits must accept tunnels to the pinned addresses. Host-side DNS may produce different answers from an
  upstream resolver. Production Meet and Zoom media need verification through the deployment's proxy paths.
- An early parallel fixture run produced an intermittent HTTP 503 during a secret PUT. The final test suite and
  focused checks, including chunked PUT handling, passed after relay cleanup was tightened. Sustained load on the
  production gateway remains unmeasured.
