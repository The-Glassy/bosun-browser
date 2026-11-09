// Upstream exits. Credentials are separate from the public server URL and never enter diagnostics.
import http from 'http';
import net from 'net';

export function parseEgress(raw, label = 'BROWSER_EGRESS_PROXY') {
  if (raw === undefined || raw === '') return null;
  try {
    if (typeof raw !== 'string') throw new Error();
    const u = new URL(raw);
    if (!['http:', 'socks5:'].includes(u.protocol) || !u.hostname || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error();
    if (u.protocol === 'socks5:' && (u.username || u.password || !u.port)) throw new Error();
    const username = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
    if (/[\x00-\x1f\x7f]/.test(username + password)) throw new Error();
    return { server: `${u.protocol}//${u.host}`, ...(username || password ? { username, password } : {}), bypass: '<-loopback>' };
  } catch {
    // Do not echo even malformed input: it can contain an unparseable credential.
    throw new Error(`${label} must be http://[user:pass@]host:port or socks5://host:port (SOCKS5 authentication is unsupported)`);
  }
}

export const proxyAuth = (p) => p.username || p.password ? { 'proxy-authorization': `Basic ${Buffer.from(`${p.username || ''}:${p.password || ''}`).toString('base64')}` } : {};
export const egressError = (p) => new Error(`egress proxy ${p.server} failed (unreachable, refused, or authentication failed); no direct fallback`);
const hostOf = (p) => new URL(p.server).hostname.replace(/^\[|\]$/g, '');

// Read exactly n handshake bytes without consuming application bytes that arrive in the same packet.
async function readBytes(sock, n) {
  const chunks = [];
  let left = n;
  while (left) {
    const part = sock.read(left);
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
      // Domain form also accepts literal IPs; importantly, names are resolved by the exit, never here.
      const name = Buffer.from(target.host);
      if (!name.length || name.length > 255) throw new Error('invalid SOCKS5 host');
      sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([target.port >> 8, target.port & 255])]));
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
    req.on('socket', track);
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
