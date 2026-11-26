# Tenant sandbox in Bosun 0.28

Bosun starts one bubblewrap worker per distinct tenant on Linux x64 and arm64. The worker and its browsers share a
private filesystem, PID namespace, network namespace, IPC namespace, home, `/tmp` and `/dev/shm`. Bosun mounts
the application, runtime libraries and preinstalled browser binaries read-only. Only the worker's tenant data
and its private runtime paths are writable. Headful workers start their own Xvfb with no TCP listener. Meeting
audio uses the worker's PulseAudio process and private sockets.

The gateway checks public WebSocket and HTTP bearer credentials. Each MCP connection gets a dedicated channel to
its tenant worker. Closing the connection ends its session lease. Keeping the worker alive lets scheduled
keepalive jobs and meetings continue. A worker exit closes its connections and invalidates its capability URLs.
A new authenticated connection can start a new worker. Generated artifact and live-view links carry a routing
prefix `/tenant/<tenant>`. The existing one-time or expiring link credentials authorize access. The live
gateway redirects `/v/<token>` to the prefixed path when exactly one running worker owns the active handoff.
It also forwards a legacy WebSocket at `/ws/<token>` to that worker. Shared mode continues to issue the
unprefixed URLs. A handoff expires when its service or worker stops, so request a new link after upgrading.

## Choose a mode

- `BOSUN_TENANT_SANDBOX=off` (default) uses the 0.27 process and data layout. Multiple distinct tenants
  trigger a startup warning recommending the sandbox. Set `BOSUN_ALLOW_UNSAFE_SHARED=1` to acknowledge
  shared mode and silence the warning.
- `BOSUN_TENANT_SANDBOX=on` runs the worker with any token count. For stdio, use a single configured tenant or
  no tokens for the local `default` tenant. For multiple tenants use the WebSocket gateway.
- `BOSUN_TENANT_SANDBOX=auto` selects sandboxing for two or more configured token entries, even if both
  tokens map to the same tenant. Zero or one token uses a shared-process service.

A failed sandbox launch stops startup.

Run as an unprivileged Linux user. Install bubblewrap, the browser dependencies and the configured engines.
Install Xvfb for headful workers and PulseAudio/FFmpeg for meetings. Install browsers in the service user's
default cache or point `PLAYWRIGHT_BROWSERS_PATH` and `CAMOUFOX_INSTALL_DIR` at dedicated binary directories.
The default engine must successfully launch under bwrap during startup. Check `/health` for each enabled
engine, using the service's actual systemd or container configuration. Chromium's own sandbox remains enabled
by default and requires nested user namespaces. Container profiles must allow bubblewrap to create its namespaces
and mount a fresh procfs. See [systemd deployment](DEPLOY-SYSTEMD.md).

The host kernel and service account are shared. The trusted operator controls package and binary mounts, state
directories, provider endpoints and upstream exits. Use dedicated binary caches and keep secrets, tenant data
and host sockets outside read-only runtime directories. `MAX_SESSIONS` and video slots apply per sandbox worker.
Budget host memory, process count and storage for all active tenants.

## Egress

A browser connects to a loopback proxy inside its worker. A per-tenant Unix socket connects it to a host-owned
relay. The relay checks the destination against the tenant's host/port allowlist and dials a pinned address.
The namespace prevents bypass via direct DNS, UDP or WebRTC. An unavailable relay or exit fails the request.
Proxy credentials stay on the gateway side.

- Set `BROWSER_TENANT_EGRESS='alice=default,direct;bob=default,office'` to restrict each tenant to an explicit
  subset of `default`, `direct` and names from `BROWSER_EGRESS_PROXIES`. With no entry the tenant may select all
  configured exits. `direct` always goes through the host relay, which dials the destination itself.
- The relay blocks private, loopback, link-local and metadata addresses by default. To allow a known internal
  service, list its exact IP address and preferably its port in `BROWSER_TENANT_ALLOW`. If you navigate to it by
  name, allow the name and the IP. A wildcard alone grants access to public addresses.
- Named HTTP and SOCKS5 proxies receive the checked IP as the CONNECT target. This pins the address across both
  hops and requires the relay's DNS to resolve the name. The browser still sends its original HTTP Host or TLS
  server name to the destination. An upstream proxy must support tunneling to the checked IP.
- The worker has dedicated Unix channels for explicitly configured speech providers. These are pinned to the
  configured provider origin; the browser's host relay continues to apply its destination checks.
- The gateway serves public `/health`, `/health/exits` and `/metrics`. Set `BOSUN_METRICS_TOKEN` to require
  that dedicated bearer for metrics scraping.

## Move existing state

Stop Bosun before migrating. Run the command as the service user and point it to the service's actual
`BROWSER_DATA` directory. The installed command is `bosun migrate-data`. From the source checkout use
`node bin/bosun.mjs migrate-data`. Both forms accept the same options and use `BROWSER_DATA` or `./data`
if `--data` is omitted. The command uses `tar` with gzip support.

```sh
bosun migrate-data --dry-run --data /var/lib/bosun/data
bosun migrate-data --data /var/lib/bosun/data
```

The command prints the path of a private backup tarball inside `.bosun-backups/` before moving data.
It moves each tenant's `profiles/` (including browser data, profile metadata and cookie snapshots),
`macros/`, `recordings/` (audio, video and speaker sidecars), `downloads/`, `uploads/` and `shots/`
subtree, plus `speech-settings/<tenant>.json` and `secret-settings/<tenant>.json`. It splits
`keepalive.json` by tenant, including watches, state and history, and partitions `live-transcript-usage.json`
by tenant while preserving the quota date. For example, `profiles/alice/work` moves to
`tenants/alice/profiles/alice/work`. Temporary browser profiles under `tmp/` have no durable owner.
Retrieve pending transfers and finish handoffs before stopping. The migration moves their files when present,
and the normal service startup and retention rules still apply.

The command refuses conflicting data. If you choose `--force`, the source tenant's conflicting category or
setting file replaces the corresponding destination, and a conflicting keepalive entry takes the source
value. Conflicting quota records for the same tenant require `--force`. When combining quotas on rollback,
the shared store keeps the latest day's records because it holds a single day. The backup contains both layouts
as they existed before the run, including quotas from earlier days. A completed migration has
nothing left to move. If sandbox startup finds legacy state, including a partially migrated tree, it tells you
to migrate it. With `BOSUN_AUTO_MIGRATE=1`, startup runs the same migration and prints the backup path.

`BROWSER_MACRO_SOURCE` shares another tenant's macros and therefore requires shared mode. Operators can place
independent approved copies in a tenant's sandbox data directory.

## Roll back to shared mode or 0.27

Stop Bosun. Run the reverse migration using the 0.28 CLI before switching the installed version or mode.

```sh
bosun migrate-data --reverse --dry-run --data /var/lib/bosun/data
bosun migrate-data --reverse --data /var/lib/bosun/data
```

Inspect any conflict before retrying with `--force`. Reverse migration prints its own backup path and moves
current worker state back to the shared layout. Set `BOSUN_TENANT_SANDBOX=off` and unset `BOSUN_AUTO_MIGRATE`.
Before starting 0.27, convert named exit objects back to URL strings, restore bearer authentication to
the health client and remove scrapes of `/health/exits` and `/metrics`. If a migration is interrupted,
restore the printed archive into an empty data directory with `tar -xzf /path/to/bosun-data.tar.gz -C /path/to/empty-dir`
and point `BROWSER_DATA` at the recovered directory.

## Pin deployment-specific defaults

The guest name defaults to `Notetaker` and can be set with `MEETING_BOT_NAME`. The built-in English and German
notice uses generic wording, with optional attribution from `MEETING_OWNER`. Set `MEETING_ANNOUNCE_TEXT` for
custom wording. Set `MEETING_ANNOUNCE` to `chat` (default), `host`, or `none`. When the notice is disabled,
the operator must inform participants about recording. Chat opt-outs apply in every mode. A join's `name`,
`announce_text`, and `announce` override the instance defaults. Set `TZ` for keepalive quiet hours and
transcript quotas. Use `BROWSER_LOCALE` and `BROWSER_TIMEZONE` for browser contexts. The default time zone for each
is `Europe/Vienna`.

## Run the containment test

On a host that allows bubblewrap and the browser's own sandbox, use
`BOSUN_TEST_SANDBOX=1 node --test test/tenant-sandbox.test.mjs`. The test starts two real workers, opens profiles
and downloads in both, and uses the same sandbox launcher to verify that either tenant's files and temporary
paths are unavailable to the other. It also exercises authorized egress, session ownership, gated artifact URLs
and live-view forwarding. With the flag set, an unavailable sandbox fails the test.
