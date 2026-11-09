import http from 'http';
import net from 'net';

export const listen = (server) => new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => ok(server.address().port)); });
export const closeServer = (server) => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); });

// The fake exit resolves virtual public hostnames to our local target. Tests assert the exit received the original
// name and that its credentials do not leak through to the origin. No public network or DNS is required.
export async function fixture(t, { challenge = true } = {}) {
  const sockets = new Set(), requests = [], tunnels = [], originHeaders = [];
  const originPorts = [], forwardedPorts = new Set();
  let originConnections = 0;
  const origin = http.createServer((req, res) => {
    originHeaders.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Exit</title><p>proxied</p>');
  });
  origin.on('connection', (sock) => { originConnections++; originPorts.push(sock.remotePort); });
  origin.on('upgrade', (req, sock) => {
    originHeaders.push(req.headers);
    sock.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  });
  const originPort = await listen(origin);
  const exit = http.createServer((req, res) => {
    // Chromium retries with Playwright's configured credentials only after a valid authentication challenge.
    // challenge=false reproduces the old empty-title failure (scripts/repro-egress-auth.mjs).
    if (req.headers['proxy-authorization'] !== 'Basic dXNlcjpwYXNz') {
      res.writeHead(407, challenge ? { 'proxy-authenticate': 'Basic realm="fixture-exit"' } : {});
      return res.end();
    }
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
    requests.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    const u = new URL(req.url);
    const headers = { ...req.headers }; delete headers['proxy-authorization'];
    const out = http.request({ host: '127.0.0.1', port: originPort, path: u.pathname, headers }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    out.on('socket', (sock) => {
      if (sock.connecting) sock.once('connect', () => forwardedPorts.add(sock.localPort));
      else forwardedPorts.add(sock.localPort);
    });
    out.on('error', () => res.destroy()); req.pipe(out);
  });
  exit.on('connect', (req, client, head) => {
    tunnels.push(req.url);
    if (req.headers['proxy-authorization'] !== 'Basic dXNlcjpwYXNz') return client.end(`HTTP/1.1 407 Proxy Authentication Required\r\n${challenge ? 'Proxy-Authenticate: Basic realm="fixture-exit"\r\n' : ''}\r\n`);
    const up = net.connect(originPort, '127.0.0.1', () => {
      forwardedPorts.add(up.localPort);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head); client.pipe(up); up.pipe(client);
    });
    sockets.add(up); up.on('close', () => sockets.delete(up));
    up.on('error', () => client.destroy()); client.on('error', () => up.destroy()); client.on('close', () => up.destroy());
  });
  exit.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  const port = await listen(exit);
  t.after(async () => { for (const sock of sockets) sock.destroy(); await closeServer(exit); await closeServer(origin); });
  // Match accepted TCP connections to the exit's outgoing socket ports. Everything else reached the origin directly.
  return { originPort, exit, stopExit: async () => { for (const sock of sockets) sock.destroy(); await closeServer(exit); }, port, url: `http://user:pass@127.0.0.1:${port}`, requests, tunnels, originHeaders, connections: () => originConnections,
    directConnections: () => originPorts.filter((p) => !forwardedPorts.has(p)).length };
}
