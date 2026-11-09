import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.mjs';
import { parseEgress, connectEgress, probeEgress } from '../src/egress.mjs';
import { redactUrlCredentials } from '../src/redact.mjs';
import { parseHostPattern } from '../src/allow.mjs';
import { startTenantProxy, resolveTarget } from '../src/proxy.mjs';
import { createEngines, PROXY_ARGS, PROXY_FIREFOX_PREFS } from '../src/engines.mjs';
import { startBosun, connect, tmpDir, TOKEN } from './helpers.mjs';

const listen = (server) => new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => ok(server.address().port)); });
const closeServer = (server) => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); });
const auth = (p) => `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`;
const patterns = (...values) => values.map(parseHostPattern);

// The fake exit resolves virtual public hostnames to our local target. Tests assert the exit received the original
// name and that its credentials do not leak through to the origin. No public network or DNS is required.
async function fixture(t) {
  const sockets = new Set(), requests = [], tunnels = [], originHeaders = [];
  let directConnections = 0;
  const origin = http.createServer((req, res) => {
    originHeaders.push(req.headers);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Exit</title><p>proxied</p>');
  });
  origin.on('connection', () => directConnections++);
  const originPort = await listen(origin);
  const exit = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== 'Basic dXNlcjpwYXNz') { res.writeHead(407); return res.end(); }
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
    requests.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    const u = new URL(req.url);
    const headers = { ...req.headers }; delete headers['proxy-authorization'];
    const out = http.request({ host: '127.0.0.1', port: originPort, path: u.pathname, headers }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    out.on('error', () => res.destroy()); req.pipe(out);
  });
  exit.on('connect', (req, client, head) => {
    tunnels.push(req.url);
    if (req.headers['proxy-authorization'] !== 'Basic dXNlcjpwYXNz') return client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    const up = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head); client.pipe(up); up.pipe(client);
    });
    sockets.add(up); up.on('close', () => sockets.delete(up));
    up.on('error', () => client.destroy()); client.on('error', () => up.destroy()); client.on('close', () => up.destroy());
  });
  exit.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  const port = await listen(exit);
  t.after(async () => { for (const sock of sockets) sock.destroy(); await closeServer(exit); await closeServer(origin); });
  return { originPort, exit, stopExit: async () => { for (const sock of sockets) sock.destroy(); await closeServer(exit); }, port, url: `http://user:pass@127.0.0.1:${port}`, requests, tunnels, originHeaders, connections: () => directConnections };
}

function requestProxy(p, url) {
  return new Promise((ok, no) => {
    const u = new URL(p.server);
    const req = http.get({ host: u.hostname, port: u.port, path: url, headers: { 'proxy-authorization': auth(p) } }, (res) => {
      let body = ''; res.on('data', (b) => body += b); res.on('end', () => ok({ status: res.statusCode, body }));
    }); req.on('error', no);
  });
}

test('egress config: empty is direct; URLs parsed without credentials in server; invalid input never echoed', () => {
  assert.equal(loadConfig({}).egressProxy, null);
  assert.equal(loadConfig({ BROWSER_EGRESS_PROXY: '' }).egressProxy, null);
  assert.deepEqual(parseEgress('http://u%40ser:p%3Ass@localhost:1234'), { server: 'http://localhost:1234', username: 'u@ser', password: 'p:ss', bypass: '<-loopback>' });
  assert.equal(parseEgress('socks5://localhost:1080').server, 'socks5://localhost:1080');
  for (const url of ['https://secret:password@host', 'socks5://u:password@host:1080', 'http://u:password@host/path', 'http://u:password@host?token=x', 'not-a-url-password']) {
    assert.throws(() => parseEgress(url), (e) => /BROWSER_EGRESS_PROXY/.test(e.message) && !e.message.includes('password'));
  }
});

test('egress credential redaction covers HTTP and SOCKS URLs in diagnostics', () => {
  const log = redactUrlCredentials('failed http://u:p%40ss@host:3128 and socks5://user:pass@exit:1080');
  assert.equal(log, 'failed http://[masked]@host:3128 and socks5://[masked]@exit:1080');
});

test('egress allowlist preflight preserves private-address refusals and sends the hostname', async () => {
  assert.deepEqual(await resolveTarget(patterns('allowed.test'), 'allowed.test', 80, async () => '8.8.8.8', true), { ip: 'allowed.test', host: 'allowed.test', port: 80 });
  assert.match((await resolveTarget(patterns('allowed.test'), 'allowed.test', 80, async () => '127.0.0.1', true)).denied, /private/);
  assert.equal((await resolveTarget(patterns('allowed.test', '127.0.0.1'), 'allowed.test', 80, async () => '127.0.0.1', true)).ip, 'allowed.test');
});

for (const name of ['chromium', 'patchright', 'camoufox']) {
  test(`egress ${name}: launch proxy and leak-prevention options reach persistent and ephemeral contexts`, async () => {
    const dataDir = tmpDir();
    try {
      const calls = [];
      const bt = { launchPersistentContext: async (dir, options) => { calls.push(options); return {}; } };
      const engines = createEngines({ importer: async (pkg) => pkg === 'camoufox-js' ? { launchOptions: async () => ({}) } : { chromium: bt, firefox: bt } });
      const proxy = parseEgress('http://localhost:1234');
      for (const profileDir of [undefined, path.join(dataDir, name)]) {
        if (profileDir) fs.mkdirSync(profileDir, { recursive: true });
        await engines.open(name, { cfg: { dataDir, headless: true, chromiumSandbox: false }, profileDir, locale: 'en', timezone: 'UTC', proxy, shared: () => { throw new Error('proxied context shared an unprotected browser'); } });
        const options = calls.at(-1);
        assert.deepEqual(options.proxy, proxy);
        if (name === 'camoufox') assert.deepEqual(options.firefoxUserPrefs, PROXY_FIREFOX_PREFS);
        else for (const arg of PROXY_ARGS) assert.ok(options.args.includes(arg));
      }
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
}

test('egress allowlist chains plain HTTP and CONNECT, keeps hostname, strips hop credentials and denies other hosts', async (t) => {
  const f = await fixture(t);
  const p = await startTenantProxy({ tenant: 'test', allow: patterns('allowed.test'), lookup: async () => '8.8.8.8', egress: parseEgress(f.url), log: () => {} });
  t.after(() => p.close());
  const response = await requestProxy(p, 'http://allowed.test/page');
  assert.equal(response.status, 200); assert.match(response.body, /proxied/);
  assert.equal(f.requests[0].url, 'http://allowed.test/page');
  assert.equal(f.originHeaders[0]['proxy-authorization'], undefined);
  const tunnel = await new Promise((ok, no) => {
    const req = http.request({ host: '127.0.0.1', port: p.port, method: 'CONNECT', path: 'allowed.test:443', headers: { 'proxy-authorization': auth(p) } });
    req.once('connect', (res, sock) => { assert.equal(res.statusCode, 200); sock.destroy(); ok(); }); req.on('error', no); req.end();
  });
  assert.equal(tunnel, undefined);
  assert.deepEqual(f.tunnels, ['allowed.test:443']);
  const hits = f.connections();
  assert.equal((await requestProxy(p, 'http://denied.test/page')).status, 403);
  assert.equal(f.connections(), hits);
  assert.equal(f.requests.length, 1);
});

test('egress unreachable chain names exit, never connects directly, and health fails without credentials', async (t) => {
  const f = await fixture(t);
  const unused = http.createServer(); const port = await listen(unused); await closeServer(unused);
  const egress = parseEgress(`http://user:supersecret@127.0.0.1:${port}`);
  const p = await startTenantProxy({ tenant: 'test', allow: patterns(`127.0.0.1:${f.originPort}`), egress });
  t.after(() => p.close());
  const response = await requestProxy(p, `http://127.0.0.1:${f.originPort}/`);
  assert.equal(response.status, 502); assert.match(response.body, /egress proxy http:\/\/127\.0\.0\.1:/);
  assert.ok(!response.body.includes('supersecret')); assert.equal(f.connections(), 0);
  await assert.rejects(connectEgress(egress, { host: '127.0.0.1', port: f.originPort }), /egress proxy/);
  assert.equal(f.connections(), 0);
  const health = await probeEgress(egress); assert.equal(health.ok, false); assert.ok(!JSON.stringify(health).includes('supersecret'));
});

test('egress no-allowlist real browser visits only through the configured authenticated exit; health is authenticated', async (t) => {
  const f = await fixture(t);
  const svc = await startBosun({ BROWSER_EGRESS_PROXY: f.url }); t.after(() => svc.stop());
  const c = await connect(svc); t.after(() => c.close());
  const id = await c.open();
  const nav = await c.call('navigate', { session: id, url: 'http://exit-only.invalid/page' });
  assert.equal(nav.isError, false, nav.text); assert.equal(nav.json().title, 'Exit');
  assert.ok(f.requests.some((r) => r.url === 'http://exit-only.invalid/page'));
  const base = svc.wsUrl.replace('ws:', 'http:');
  assert.equal((await fetch(`${base}/health`)).status, 401);
  const health = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(health.status, 200); assert.equal((await health.json()).egress.server, `http://127.0.0.1:${f.port}`);
  await f.stopExit();
  const before = f.connections();
  const failed = await c.call('navigate', { session: id, url: `http://127.0.0.1:${f.originPort}/never-direct` });
  assert.equal(failed.isError, true); assert.match(failed.text, /egress proxy/); assert.equal(f.connections(), before);
});
