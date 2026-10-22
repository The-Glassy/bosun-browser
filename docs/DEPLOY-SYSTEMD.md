# Deploying Bosun on Linux with systemd

A single-host deployment: Bosun as its own unprivileged user, headful Chromium under Xvfb, both listeners on
loopback, the live view published to a private network only, and every secret outside this repository.

Example files: [`deploy/bosun.service`](../deploy/bosun.service) and
[`deploy/bosun.env.example`](../deploy/bosun.env.example). Placeholders (`example.org`, `bosun.example.ts.net`) are
meant to be replaced; nothing in this repository knows your hostnames or tokens, and nothing here should learn
them.

Threat model behind these choices: the browser runs untrusted web content as the service user, so the service user
must own nothing else and reach nothing else. See [FORK-SECURITY-REVIEW.md](FORK-SECURITY-REVIEW.md) — in particular
H1 (where the browser may go), M1 (the live-view link is a bearer token) and M4 (child processes inherit the
service's environment, tokens included).

## 1. User, directories, packages

```sh
sudo useradd --system --create-home --home-dir /var/lib/bosun --shell /usr/sbin/nologin bosun
sudo install -d -o bosun -g bosun -m 0700 /var/lib/bosun/data /var/lib/bosun/pw-browsers
sudo install -d -o root  -g bosun -m 0750 /etc/bosun

sudo apt-get install -y nodejs npm xvfb   # Node 20+; use nodesource if the distro ships an older one
sudo install -d -o root -g root -m 0755 /opt/bosun
sudo git clone <this fork> /opt/bosun     # or unpack a release tarball
sudo chown -R root:root /opt/bosun        # code is read-only to the service user
```

Install dependencies and the browser **as the service user**, so the browser lands in the data volume and not in
root's cache:

```sh
cd /opt/bosun
sudo npm ci --omit=optional               # skips patchright/camoufox; this fork only enables chromium
sudo -u bosun env HOME=/var/lib/bosun PLAYWRIGHT_BROWSERS_PATH=/var/lib/bosun/pw-browsers \
  npx playwright install chromium
sudo npx playwright install-deps chromium # the shared libraries Chromium needs (root, once)
```

`npm ci` writes `node_modules` under `/opt/bosun`; keep it root-owned. The service user needs write access to
`/var/lib/bosun` only.

## 2. Secrets

```sh
openssl rand -hex 32        # one token per tenant
sudo install -o root -g bosun -m 0640 deploy/bosun.env.example /etc/bosun/bosun.env
sudo editor /etc/bosun/bosun.env
```

- Tokens live only in `/etc/bosun/bosun.env` (`root:bosun`, `0640`), never in the unit file, never in a shell
  history, never in this repository, never in a URL (`?token=` still works but puts the token in logs — use the
  `Authorization: Bearer` header).
- One token per consumer, so revoking one does not disturb the others. Rotation = edit the file,
  `systemctl restart bosun`.
- The browser, `ffmpeg` and `pulseaudio` children inherit this environment, so anything able to read
  `/proc/<pid>/environ` as the `bosun` user can read the tokens. That is why `bosun` runs nothing else.

## 3. The unit

```sh
sudo install -o root -g root -m 0644 deploy/bosun.service /etc/systemd/system/bosun.service
sudo systemctl daemon-reload
sudo systemctl enable --now bosun
journalctl -u bosun -f
```

Expect two lines and no token:

```
bosun: MCP over WebSocket on 127.0.0.1:7360
bosun: live view on 127.0.0.1:7350
```

What the unit does, and why:

| directive | why |
|---|---|
| `User=bosun` | the browser's blast radius is one user that owns nothing else |
| `xvfb-run -a -s "-screen 0 1366x900x24 -nolisten tcp"` | headful Chromium on a private display; no X over TCP |
| `TasksMax=2000` | Chromium spawns a lot of threads; the default limit is easy to hit |
| `MemoryMax=6G` | ~0.3–0.6 GB per headful session plus the shared browser; keep the host from swapping |
| `EnvironmentFile=/etc/bosun/bosun.env` | secrets stay in a root-owned file |
| `ProtectSystem=strict` + `ReadWritePaths=/var/lib/bosun` | the only writable path is the data volume |
| `ProtectHome=yes`, `PrivateTmp=yes`, `NoNewPrivileges=yes` | no access to other users' data, private `/tmp` |
| `RestrictAddressFamilies=… AF_NETLINK` | Chromium needs netlink for network-change notifications |
| no `SystemCallFilter`, no `RestrictNamespaces` | Chromium's own sandbox needs `clone()`/`unshare()`; filtering them breaks the launch or silently disables the sandbox |

Bosun locates leftover browser processes with `ps` and kills them by their profile directory
(`src/sessions.mjs`), so do not hide its own children from it (no `PrivatePIDs=yes`).

## 4. Network: loopback plus `tailscale serve`

Both listeners bind `127.0.0.1`. Nothing is published by Bosun itself.

- **MCP (WebSocket)** stays on loopback. Agents on the same host connect to `ws://127.0.0.1:7360`; stdio-only
  clients use the `bosun-mcp-stdio` bridge (README › stdio bridge). If a remote agent needs it, publish it on the
  private network with its own path and keep the token requirement:
  `tailscale serve --bg --https=443 --set-path=/mcp http://127.0.0.1:7360`.
- **Live view** is published for the human's phone:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:7350
tailscale serve status
```

Then set `LIVE_BASE_URL=https://<node>.<tailnet>.ts.net` so the links Bosun hands out point at the proxy, not at
`127.0.0.1`. The live-view page derives its WebSocket origin from that URL, so it must match exactly (scheme and
host), without a trailing path.

- **Never `tailscale funnel`.** A handoff link is a bearer token for the whole handoff (TTL `HANDOFF_TTL_SEC`,
  default 900 s): anyone who has it can drive that tab while nobody else is connected. Keep it inside the tailnet,
  send it over a private channel, and press **Done** when finished — that revokes it for good.
- Egress: the service should not be able to reach your private networks. Block `10/8`, `172.16/12`, `192.168/16`,
  `100.64/10` (except the tailnet addresses you need) and `169.254/16` for the `bosun` user or its network
  namespace. The host allowlist below narrows what the agent asks for; the firewall is what makes it a boundary.

## 5. Host allowlist and feature switches

```sh
BROWSER_TENANT_ALLOW=ops=*.example.org,example.org,127.0.0.1:4848; swarm=*.example.org
FEATURES_MEETINGS=0
FEATURES_ENGINES=chromium
```

- `BROWSER_TENANT_ALLOW` is per tenant: entries separated by `;`, hosts within an entry by `,`. Patterns are
  `host` (any port), `*.host` (subdomains only — add the apex separately), `host:port`, `[::1]:port`, or `*`.
  It is enforced on `navigate`, on `keepalive_set`, and on every HTTP(S) request any frame of that tenant's
  sessions makes, so a page cannot steer the browser somewhere else; denied requests are aborted and logged
  (`bosun: tenant <t>: blocked request to <scheme>://<host>/<path> (host allowlist)`) without the query. A tenant
  that is not named may reach any host.
- A denied navigation the *page* started leaves the tab on the browser's error page; the agent can navigate again.
- Remember the hosts a login actually needs: an identity provider, a CDN that serves the page's scripts, the
  CAPTCHA vendor. A handoff can only reach what the tenant may reach.
- `FEATURES_MEETINGS=0` (the default here) means the meeting tools are not listed and their handlers are not wired:
  no recordings directory, no PulseAudio server, no `ffmpeg`. Turning it on adds a recording consent surface — read
  README › Meetings first.
- `FEATURES_ENGINES=chromium` (the default here) means a session cannot ask for the anti-detect engines. Enable
  them deliberately (`FEATURES_ENGINES=chromium,patchright`) and install them first; `patchright` is also the
  engine whose credential masking a page cannot see (review finding H2), so prefer it for handoffs on sites you do
  not control.

## 6. Operating it

- Logs: `journalctl -u bosun`. Bosun never logs tokens or query strings; a denied request is logged as origin plus
  path only.
- Data: `/var/lib/bosun/data` holds `profiles/<tenant>/<name>` (cookies — treat it as credential material),
  `keepalive.json` and, with `SAVE_SHOTS=1`, screenshots (`0600`, deleted with the session). Back it up like a
  password store, or not at all.
- Upgrade: `git -C /opt/bosun pull`, `sudo npm ci --omit=optional`, re-run `playwright install chromium` as `bosun`
  when the pinned Playwright version changed, `systemctl restart bosun`. Restarting ends every session and handoff.
- Restart behaviour: `Restart=on-failure` with a 45 s stop timeout. Bosun closes sessions and handoffs on SIGTERM
  within its own bounded deadlines; a browser that survives SIGKILL keeps its session slot and says so in the log.
- Health check: `systemctl is-active bosun` plus one `tools/list` call over the WebSocket with a real token.

## 7. Checklist before you call it done

- [ ] `/etc/bosun/bosun.env` is `root:bosun 0640` and holds real tokens; the repository holds none.
- [ ] `ss -ltnp` shows both Bosun ports bound to `127.0.0.1` only.
- [ ] `tailscale serve status` shows the live view, and `tailscale funnel status` shows nothing.
- [ ] `LIVE_BASE_URL` matches the `tailscale serve` address; a link opens on a phone in the tailnet.
- [ ] Every tenant that should be restricted appears in `BROWSER_TENANT_ALLOW`; a `navigate` to another host is
      refused, and the refusal shows up in the journal without the query.
- [ ] `FEATURES_MEETINGS=0`, `FEATURES_ENGINES` lists only what is installed.
- [ ] Egress to private ranges is blocked for the service.
- [ ] `ALLOW_NO_TOKEN` is unset.
