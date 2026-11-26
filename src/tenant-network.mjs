// A worker has loopback and its own Unix sockets. Everything outside is dialed by the host.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';

// The first request line a relay bridge holds back while it waits for its end. Node's HTTP parser refuses a
// request head beyond 16 KiB, so a longer line never was a request the relay would have served.
const MAX_REQUEST_LINE = 32 * 1024;

// firstHeader: one HTTP header line the forwarder adds to the first request of every connection (see startRelayProxy).
export async function forwardTcp(listen, destination, firstHeader = null) {
  const upstreams = new Set();
  const forward = (client, upstream) => {
    if (!firstHeader) return client.pipe(upstream);
    let held = Buffer.alloc(0);
    const onData = (chunk) => {
      held = Buffer.concat([held, chunk]);
      const end = held.indexOf('\r\n');
      if (end < 0) { if (held.length > MAX_REQUEST_LINE) client.destroy(); return; }
      client.off('data', onData);
      upstream.write(Buffer.concat([held.subarray(0, end + 2), Buffer.from(`${firstHeader}\r\n`), held.subarray(end + 2)]));
      client.pipe(upstream);
    };
    client.on('data', onData);
  };
  const server = net.createServer((client) => {
    const upstream = net.connect(destination);
    upstreams.add(upstream);
    const timer = setTimeout(() => upstream.destroy(), 15_000);
    timer.unref();
    upstream.once('connect', () => clearTimeout(timer));
    upstream.once('close', () => { clearTimeout(timer); upstreams.delete(upstream); client.destroy(); });
    client.once('close', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    forward(client, upstream);
    upstream.pipe(client);
  });
  server.maxConnections = 256;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen, () => { server.off('error', reject); resolve(); });
  });
  return {
    port: server.address().port,
    async close() {
      const done = new Promise((resolve) => server.close(resolve));
      for (const upstream of upstreams) upstream.destroy();
      await done;
    },
  };
}

// The browser's proxy inside a worker: a loopback listener bridged to the tenant's relay socket. The bridge, not the
// browser, presents the relay credentials, on the first request of each connection (the relay accepts the rest of
// that connection, see startTenantProxy). A browser given proxy credentials answers the relay's 407 through
// Playwright's CDP Fetch interception, and with that enabled Chromium never resumes a request it restarts for an
// ACCEPT_CH frame (the client-hints frame Google's servers send in the TLS handshake): every such navigation hangs
// until it times out. The listener is on the worker's private loopback, which only this tenant's own processes
// reach, and the relay applies the same destination checks to everything that arrives.
export async function startRelayProxy({ socketPath, username, password }) {
  const credentials = Buffer.from(`${username}:${password}`).toString('base64');
  const bridge = await forwardTcp({ host: '127.0.0.1', port: 0 }, { path: socketPath }, `Proxy-Authorization: Basic ${credentials}`);
  return { server: `http://127.0.0.1:${bridge.port}`, bypass: '<-loopback>', close: bridge.close };
}

// Provider sockets are separate from browser exits. Each is pinned to the configured origin on the host.
// TLS and HTTP stay end-to-end, so the host relay never needs the provider API key.
export function providerConnection(url, socketPath) {
  const { hostname, protocol } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, '');
  return () => {
    const socket = net.connect({ path: socketPath });
    if (protocol === 'http:' || protocol === 'ws:') return socket;
    const secure = tls.connect({ socket, host, servername: net.isIP(host) ? undefined : host });
    socket.on('error', (error) => secure.destroy(error));
    return secure;
  };
}

export async function providerFetch(url, init, socketPath) {
  if (!socketPath) return fetch(url, { ...init, redirect: 'error' });
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(url, { ...init, createConnection: providerConnection(url, socketPath) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.destroy();
        return reject(new Error('provider redirected the request'));
      }
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode,
        headers: new Headers(res.headers), body: Readable.toWeb(res),
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}
