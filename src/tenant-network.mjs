// A worker has loopback and its own Unix sockets. Everything outside is dialed by the host.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Readable } from 'node:stream';

export async function forwardTcp(listen, destination) {
  const upstreams = new Set();
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
    client.pipe(upstream).pipe(client);
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

export async function startRelayProxy({ socketPath, username, password }) {
  const bridge = await forwardTcp({ host: '127.0.0.1', port: 0 }, { path: socketPath });
  return {
    server: `http://127.0.0.1:${bridge.port}`, username, password, bypass: '<-loopback>',
    close: bridge.close,
  };
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
