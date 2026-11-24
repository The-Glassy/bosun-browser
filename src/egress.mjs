// Upstream exits. Credentials are separate from the public server URL and never enter diagnostics.
import http from 'http';
import net from 'net';
import { driverLogsValues } from './secrets.mjs';

export function parseEgress(raw, label = 'BROWSER_EGRESS_PROXY') {
  if (raw === undefined || raw === '') return null;
  try {
    if (typeof raw !== 'string') throw new Error();
    const u = new URL(raw);
    if (!['http:', 'socks5:'].includes(u.protocol) || !u.hostname || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error();
    if (u.port && Number(u.port) < 1) throw new Error();
    if (u.protocol === 'socks5:' && (u.username || u.password || !u.port)) throw new Error();
    const username = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
    if (username.includes(':') || /[\x00-\x1f\x7f]/.test(username + password)) throw new Error();
    return { server: `${u.protocol}//${u.host}`, ...(username || password ? { username, password } : {}), bypass: '<-loopback>' };
  } catch {
    // Do not echo even malformed input: it can contain an unparseable credential.
    throw new Error(`${label} must be http://[user:pass@]host:port or socks5://host:port (SOCKS5 authentication is unsupported)`);
  }
}

// Node/driver diagnostics can log Authorization headers outside our logger. Reuse the typed-secrets guard:
// refuse credential-bearing exits under these diagnostics, rather than promising redaction we cannot enforce.
export function protectEgressCredentials(proxies, debug = process.env.DEBUG, nodeDebug = process.env.NODE_DEBUG) {
  if (proxies.some((p) => p && (p.username || p.password)) && driverLogsValues(debug, nodeDebug)) {
    throw new Error('egress proxy credentials are refused while DEBUG enables sensitive Playwright logs or NODE_DEBUG is set; disable those diagnostics');
  }
}
export const proxyAuth = (p) => {
  protectEgressCredentials([p]);
  return p.username || p.password ? { 'proxy-authorization': `Basic ${Buffer.from(`${p.username || ''}:${p.password || ''}`).toString('base64')}` } : {};
};
export const egressError = (p) => new Error(`egress proxy ${p.server} failed (unreachable, refused, or authentication failed); no direct fallback`);
const hostOf = (p) => new URL(p.server).hostname.replace(/^\[|\]$/g, '');

// Read exactly n handshake bytes without consuming application bytes that arrive in the same packet.
async function readBytes(sock, n) {
  const chunks = [];
  let left = n;
  while (left) {
    // Consume partial fragments too: read(n) with fewer than n buffered bytes can repeatedly emit
    // readable without making progress, starving the handshake deadline and the next network packet.
    const part = sock.read(Math.min(left, sock.readableLength) || left);
    if (part) { chunks.push(part); left -= part.length; continue; }
    await new Promise((ok, no) => {
      const cleanup = () => { sock.off('readable', ready); sock.off('error', fail); sock.off('close', closed); };
      const ready = () => { cleanup(); ok(); };
      const fail = (e) => { cleanup(); no(e); };
      const closed = () => fail(new Error('closed'));
      if (sock.destroyed || sock.readableEnded) return closed();
      sock.once('readable', ready); sock.once('error', fail); sock.once('close', closed);
    });
  }
  return Buffer.concat(chunks);
}

function socksDestination({ host, port, pinned }) {
  const portBytes = Buffer.from([port >> 8, port & 255]);
  if (pinned && net.isIPv4(host)) return Buffer.concat([Buffer.from([1, ...host.split('.').map(Number)]), portBytes]);
  if (pinned && net.isIPv6(host)) {
    const [left, right] = new URL(`http://[${host}]`).hostname.slice(1, -1).split('::');
    const head = left ? left.split(':') : [], tail = right ? right.split(':') : [];
    const groups = [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
    const address = Buffer.alloc(17, 4);
    for (const [i, group] of groups.entries()) address.writeUInt16BE(parseInt(group, 16), 1 + i * 2);
    return Buffer.concat([address, portBytes]);
  }
  const name = Buffer.from(host);
  if (!name.length || name.length > 255) throw new Error('invalid SOCKS5 host');
  return Buffer.concat([Buffer.from([3, name.length]), name, portBytes]);
}

async function socksConnect(p, target, track, timeoutMs) {
  const u = new URL(p.server);
  const sock = track(net.connect({ host: hostOf(p), port: Number(u.port) }));
  // A wall-clock deadline covers TCP connect and the whole handshake, even a slow-drip peer.
  const timer = setTimeout(() => sock.destroy(new Error('timeout')), timeoutMs);
  sock.on('error', () => {});
  try {
    await new Promise((ok, no) => { sock.once('connect', ok); sock.once('error', no); sock.once('close', () => no(new Error('closed'))); });
    sock.write(Buffer.from([5, 1, 0]));
    const hello = await readBytes(sock, 2);
    if (hello[0] !== 5 || hello[1] !== 0) throw new Error('SOCKS5 authentication refused');
    if (target) {
      sock.write(Buffer.concat([Buffer.from([5, 1, 0]), socksDestination(target)]));
      const reply = await readBytes(sock, 4);
      if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error('SOCKS5 refused');
      const len = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readBytes(sock, 1))[0] : 0;
      if (!len) throw new Error('invalid SOCKS5 response');
      await readBytes(sock, len + 2);
    }
    return sock;
  } catch { sock.destroy(); throw egressError(p); } finally { clearTimeout(timer); }
}

// HTTP CONNECT for TLS and WebSockets, SOCKS5 CONNECT for every protocol. track owns sockets even while
// handshakes are pending, so the tenant proxy can close them on shutdown. There is no direct-target branch here.
export async function connectEgress(p, target, track = (s) => s, timeoutMs = 15_000) {
  if (p.server.startsWith('socks5:')) return socksConnect(p, target, track, timeoutMs);
  return new Promise((ok, no) => {
    const u = new URL(p.server);
    const authority = `${net.isIPv6(target.host) ? `[${target.host}]` : target.host}:${target.port}`;
    const req = http.request({ host: hostOf(p), port: Number(u.port || 80), method: 'CONNECT', path: authority,
      headers: { host: authority, ...proxyAuth(p) }, agent: false });
    const timer = setTimeout(() => req.destroy(egressError(p)), timeoutMs);
    const fail = () => { clearTimeout(timer); no(egressError(p)); };
    req.on('socket', (sock) => { track(sock); sock.on('error', () => {}); });
    req.on('error', fail);
    req.on('connect', (res, sock, head) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) { sock.destroy(); return fail(); }
      if (head.length) sock.unshift(head);
      ok(sock);
    });
    req.on('close', fail); // also rejects a peer that closes before returning a CONNECT response
    req.end();
  });
}

// Health is deliberately a bounded protocol/reachability probe, without visiting an arbitrary Internet host.
// HTTP checks the proxy response/auth; SOCKS checks negotiation. A target-specific policy can still deny a visit.
export async function probeEgress(p, timeoutMs = 2000) {
  if (!p) return { mode: 'direct', ok: true };
  try {
    if (p.server.startsWith('socks5:')) (await socksConnect(p, null, (s) => s, timeoutMs)).destroy();
    else await new Promise((ok, no) => {
      const u = new URL(p.server);
      const req = http.request({ host: hostOf(p), port: Number(u.port || 80), method: 'OPTIONS', path: '*', headers: proxyAuth(p), agent: false });
      const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
      req.once('error', no);
      req.once('close', () => { clearTimeout(timer); no(new Error('closed')); });
      req.once('response', (res) => { res.resume(); res.statusCode === 407 || res.statusCode >= 500 ? no(new Error('refused')) : ok(); req.destroy(); });
      req.end();
    });
    return { mode: 'proxy', server: p.server, ok: true };
  } catch { return { mode: 'proxy', server: p.server, ok: false, error: egressError(p).message }; }
}

export function parseEgressProxies(raw) {
  if (raw === undefined || raw === '') return new Map();
  let values;
  try { values = JSON.parse(raw); } catch { throw new Error('BROWSER_EGRESS_PROXIES must be a JSON object of named exits'); }
  if (!values || Array.isArray(values) || typeof values !== 'object' || Object.keys(values).length > 32) throw new Error('BROWSER_EGRESS_PROXIES must be an object with at most 32 named proxies');
  const proxies = new Map();
  for (const [name, value] of Object.entries(values)) {
    if (!/^[a-z0-9_-]{1,40}$/.test(name) || ['default', 'direct'].includes(name)) throw new Error('BROWSER_EGRESS_PROXIES names must match [a-z0-9_-]{1,40}, excluding default and direct');
    const object = value && typeof value === 'object' && !Array.isArray(value);
    if (object && ('required' in value && typeof value.required !== 'boolean')) {
      throw new Error('BROWSER_EGRESS_PROXIES entry required must be a boolean');
    }
    const proxy = parseEgress(object ? value.url : value, 'BROWSER_EGRESS_PROXIES entry');
    if (!proxy) throw new Error('BROWSER_EGRESS_PROXIES entries must have a proxy URL');
    if (object && value.required) proxy.required = true;
    proxies.set(name, proxy);
  }
  return proxies;
}

export function parseTenantExits(env, tenants, proxies) {
  const routes = new Map();
  for (const entry of String(env.BROWSER_TENANT_EGRESS || '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const [tenant, names, extra] = entry.split('=').map((s) => s.trim());
    if ((!tenants.has(tenant) && tenant !== 'default') || routes.has(tenant) || !names || extra !== undefined) {
      throw new Error('BROWSER_TENANT_EGRESS expects one entry per tenant, in the form <tenant>=<exit>,<exit>;…');
    }
    const allowed = new Set(names.split(',').map((s) => s.trim()));
    for (const name of allowed) if (!['default', 'direct'].includes(name) && !proxies.has(name)) {
      throw new Error('BROWSER_TENANT_EGRESS names an unknown exit');
    }
    routes.set(tenant, allowed);
  }
  return routes;
}

export function exitsFor(cfg, tenant) {
  return cfg.tenantExits?.get(tenant) ?? new Set(['default', 'direct', ...(cfg.egressProxies?.keys() || [])]);
}

// Share both the report and work in flight between health requests and scrapes.
export function createExitHealth(cfg) {
  let sample;
  return () => {
    const now = Date.now();
    if (!sample || now >= sample.expires) {
      const report = Promise.all([...(cfg.egressProxies || [])].map(async ([name, p]) => ({
        name, ...await probeEgress(p), checked_at: new Date().toISOString(),
      })));
      sample = { report, expires: now + 10_000 };
    }
    return sample.report;
  };
}

export async function serviceHealth(cfg, exitHealth, engineHealth, closing) {
  const [egress, exits, engines] = await Promise.all([probeEgress(cfg.egressProxy), exitHealth(), engineHealth()]);
  const ok = !closing() && egress.ok && engines.every((e) => e.ok)
    && exits.every((e) => e.ok || !cfg.egressProxies.get(e.name)?.required);
  return { ok, egress, proxies: exits.map(({ checked_at, ...proxy }) => proxy), engines };
}

export function selectEgress(cfg, name = 'default', tenant) {
  if (cfg.sandboxRoutes) {
    if (!cfg.sandboxRoutes.has(name)) throw new Error('egress exit is not available to this tenant');
    return cfg.sandboxRoutes.get(name).egress;
  }
  if (cfg.tenantExits?.has(tenant) && !cfg.tenantExits.get(tenant).has(name)) throw new Error('egress exit is not available to this tenant');
  protectEgressCredentials([cfg.egressProxy, ...(cfg.egressProxies?.values() || [])]);
  if (name === 'default') return cfg.egressProxy || null;
  if (name === 'direct') return null;
  if (cfg.egressProxies?.has(name)) {
    const { required, ...proxy } = cfg.egressProxies.get(name);
    return proxy;
  }
  // Saved profiles must fail closed if their named exit is removed. Never use the default or go direct instead.
  throw new Error('unknown egress proxy name; use default, direct, or a name in BROWSER_EGRESS_PROXIES');
}
