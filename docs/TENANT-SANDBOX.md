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
prefix `/tenant/<tenant>`; their existing one-time or expiring link credentials authorize access.

## Choose a mode

- `BOSUN_TENANT_SANDBOX=auto` (default) selects sandboxing for two or more configured token entries, even if both
  tokens map to the same tenant. Zero or one token uses a shared-process service.
- `BOSUN_TENANT_SANDBOX=on` runs the worker with any token count. For stdio, use a single configured tenant or
  no tokens for the local `default` tenant. For multiple tenants use the WebSocket gateway.
- `BOSUN_TENANT_SANDBOX=off` uses the existing process and data layout. For multiple distinct tenants,
  `BOSUN_ALLOW_UNSAFE_SHARED=1` is required and produces a startup warning. A failed sandbox launch stops
  startup.

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
- Exit health and metrics remain on the gateway. Protect scraper access with an MCP bearer or
  `BOSUN_METRICS_TOKEN`. The separate token authorizes only `/metrics`.

## Move existing state

A standard single-tenant upgrade with sandboxing off keeps its existing data directory. To enable the sandbox
on an existing installation, stop the service and take a backup. For each tenant, copy its own files into
`BROWSER_DATA/tenants/<tenant>/` under the same relative paths. For example, move the profile data from
`profiles/alice/work` to `tenants/alice/profiles/alice/work`.

Include `profiles/<tenant>/`, `macros/<tenant>/`, `recordings/<tenant>/`,
`speech-settings/<tenant>.json` and `secret-settings/<tenant>.json` for each tenant where they exist.
Split `keepalive.json` by retaining only that tenant's objects in its `entries` array. Split
`live-transcript-usage.json` by retaining its `day` and just that tenant's entry in `tenants`. Preserve file
ownership and permissions. Start new sessions after migration and check signed-in profiles, schedules and
recordings. Temporary files, pending transfers and live links expire at restart.

`BROWSER_MACRO_SOURCE` shares another tenant's macros and therefore requires shared mode. Operators can place
independent approved copies in a tenant's sandbox data directory.

## Pin deployment-specific defaults

Use `MEETING_BOT_NAME` for a guest name and `MEETING_ANNOUNCE_TEXT` for explicit wording, including any attribution
previously supplied through `MEETING_OWNER`. A join's `name` and `announce_text` can override those settings.
Set an IANA `TZ` if schedules and transcript quotas use local time. Use `BROWSER_LOCALE` and `BROWSER_TIMEZONE`
if browser sessions need a different language or clock.

## Run the containment test

On a host that allows bubblewrap and the browser's own sandbox, use
`BOSUN_TEST_SANDBOX=1 node --test test/tenant-sandbox.test.mjs`. The test starts two real workers, opens profiles
and downloads in both, and uses the same sandbox launcher to verify that either tenant's files and temporary
paths are unavailable to the other. It also exercises authorized egress, session ownership, gated artifact URLs
and live-view forwarding. With the flag set, an unavailable sandbox fails the test.
