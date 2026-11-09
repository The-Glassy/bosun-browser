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
import { SessionManager } from '../src/sessions.mjs';
import { startBosun, connect, tmpDir, TOKEN } from './helpers.mjs';
import { fixture, listen, closeServer } from './egress-fixture.mjs';

const auth = (p) => `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`;
const patterns = (...values) => values.map(parseHostPattern);

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
  assert.equal(nav.json().status, 200);
  assert.ok(f.requests.some((r) => r.url === 'http://exit-only.invalid/page'));
  assert.equal(f.directConnections(), 0);
  const base = svc.wsUrl.replace('ws:', 'http:');
  assert.equal((await fetch(`${base}/health`)).status, 401);
  const health = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(health.status, 200); assert.equal((await health.json()).egress.server, `http://127.0.0.1:${f.port}`);
  await f.stopExit();
  const before = f.connections();
  const failed = await c.call('navigate', { session: id, url: `http://127.0.0.1:${f.originPort}/never-direct` });
  assert.equal(failed.isError, true); assert.match(failed.text, /egress proxy/); assert.equal(f.connections(), before);
  assert.equal(f.directConnections(), 0);
});

test('egress manager: non-allowlist ephemeral direct bypasses the exit while default uses it', async (t) => {
  const f = await fixture(t), dataDir = tmpDir();
  const cfg = loadConfig({ BROWSER_DATA: dataDir, HEADLESS: '1', CHROMIUM_SANDBOX: '0', IDLE_TIMEOUT_SEC: '0', BROWSER_EGRESS_PROXY: f.url });
  const manager = new SessionManager(cfg);
  t.after(async () => { await manager.closeAll(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(manager.allowList('default'), null);
  const direct = await manager.open({ owner: 'agent', tenant: 'default', egress: 'direct' });
  const viaExit = await manager.open({ owner: 'agent', tenant: 'default', egress: 'default' });
  assert.equal(direct.profile, null); assert.equal(viaExit.profile, null);
  // The shared browser is always direct; any selected proxy gets a private process and its launch restrictions.
  assert.ok(direct.browser); assert.equal(direct.dir, null); assert.equal(direct.egressProxy, null);
  assert.equal(viaExit.browser, null); assert.ok(viaExit.tmpDir); assert.deepEqual(viaExit.egressProxy, parseEgress(f.url));
  assert.equal(manager.launches, 1);
  const url = `http://127.0.0.1:${f.originPort}`;
  assert.equal((await viaExit.page.goto(`${url}/default`)).status(), 200);
  assert.equal(await viaExit.page.title(), 'Exit');
  assert.ok(f.requests.some((r) => r.url === `${url}/default`));
  assert.equal(f.directConnections(), 0);
  assert.equal((await direct.page.goto(`${url}/direct`)).status(), 200);
  assert.equal(await direct.page.title(), 'Exit');
  assert.ok(!f.requests.some((r) => r.url === `${url}/direct`));
  assert.ok(f.directConnections() > 0, 'the direct session must open a TCP connection to the origin');
});

test('egress named proxy configuration rejects malformed maps and reserved names without echoing credentials', () => {
  for (const value of ['[]', 'null', '{', '{"direct":"http://password@host:80"}', '{"home":null}', '{"home":""}']) {
    assert.throws(() => loadConfig({ BROWSER_EGRESS_PROXIES: value }), (e) => !e.message.includes('password'));
  }
  const cfg = loadConfig({ BROWSER_EGRESS_PROXIES: '{"home":"http://user:pass@host:8080"}' });
  assert.equal(cfg.egressProxies.get('home').server, 'http://host:8080');
});

// These lifecycle tests use a minimal browser adapter, exercising the real manager and profile persistence without
// installing three browsers or opening sockets. The wire-level tests above separately exercise local fake exits.
async function managerFixture(t, config = {}) {
  const { EventEmitter } = await import('node:events');
  const dataDir = tmpDir(), opens = [];
  const engines = {
    get: (name) => ({ name, family: 'chromium', cdp: true, tracker: 'init' }),
    load: async () => ({}),
    open: async (_name, opts) => {
      opens.push(opts);
      const page = new EventEmitter();
      page.url = () => 'about:blank'; page.frames = () => []; page.mainFrame = () => null;
      const ctx = new EventEmitter(); ctx.pages = () => [page]; ctx.addInitScript = async () => {};
      ctx.close = async () => { await Promise.resolve(); ctx.emit('close'); };
      return { ctx, dir: null, tmpDir: null };
    },
  };
  const cfg = loadConfig({ IDLE_TIMEOUT_SEC: '0', KEEPALIVE: '0', BROWSER_DATA: dataDir, BROWSER_EGRESS_PROXY: 'http://default:3128',
    BROWSER_EGRESS_PROXIES: '{"home":"http://home:8080"}', ...config });
  const manager = new SessionManager(cfg, { engines });
  t.after(async () => { await manager.closeAll(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { cfg, manager, opens, dataDir };
}

test('egress profile override: named, direct and default persist and are reused by background/media opens', async (t) => {
  const { manager, opens, dataDir } = await managerFixture(t);
  for (const egress of ['home', 'direct', 'default']) {
    const session = await manager.open({ owner: 'agent', tenant: 'default', profile: 'work', egress });
    assert.equal(session.egress, egress);
    assert.equal(opens.at(-1).proxy?.server || null, egress === 'home' ? 'http://home:8080' : egress === 'direct' ? null : 'http://default:3128');
    await manager.close('agent', session.id);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles/default/work/bosun-profile.json'))).egress, egress);
    // Same calls used by keepalive and meeting_join: no egress parameter, reuse the profile's saved choice.
    for (const media of [null, { args: [], env: {} }]) {
      const reopened = await manager.open({ owner: 'background', tenant: 'default', profile: 'work', media });
      assert.equal(reopened.egress, egress);
      assert.equal(opens.at(-1).proxy?.server || null, egress === 'home' ? 'http://home:8080' : egress === 'direct' ? null : 'http://default:3128');
      await manager.close('background', reopened.id);
    }
  }
});

test('egress missing saved exit fails closed and releases capacity; failed open does not change saved exit', async (t) => {
  const { manager, cfg, dataDir } = await managerFixture(t);
  const first = await manager.open({ owner: 'agent', tenant: 'default', profile: 'work', egress: 'home' });
  await manager.close('agent', first.id);
  cfg.egressProxies.delete('home');
  await assert.rejects(manager.open({ owner: 'agent', tenant: 'default', profile: 'work' }), /unknown egress/);
  await assert.rejects(manager.open({ owner: 'agent', tenant: 'default', profile: 'work', egress: 'missing' }), /unknown egress/);
  assert.equal(manager.used, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'profiles/default/work/bosun-profile.json'))).egress, 'home');
});

test('egress no configuration preserves unproxied manager options', async (t) => {
  const { manager, opens } = await managerFixture(t, { BROWSER_EGRESS_PROXY: '', BROWSER_EGRESS_PROXIES: '' });
  const session = await manager.open({ owner: 'agent', tenant: 'default' });
  assert.equal(session.egressProxy, null); assert.equal(opens[0].proxy, null);
});

test('egress per-profile MCP parameter and two concurrent allowlist exits stay independent', async (t) => {
  const first = await fixture(t), second = await fixture(t);
  const svc = await startBosun({ BROWSER_EGRESS_PROXY: first.url, BROWSER_EGRESS_PROXIES: JSON.stringify({ home: second.url }), BROWSER_TENANT_ALLOW: 'alice=127.0.0.1' });
  t.after(() => svc.stop());
  const c = await connect(svc); t.after(() => c.close());
  const a = await c.open({ profile: 'default-exit' }), b = await c.open({ profile: 'home-exit', egress: 'home' });
  assert.notEqual(svc.manager.sessions.get(a).proxyRoute, svc.manager.sessions.get(b).proxyRoute);
  for (const [session, url] of [[a, `http://127.0.0.1:${first.originPort}/first`], [b, `http://127.0.0.1:${second.originPort}/second`]]) {
    const r = await c.call('navigate', { session, url }); assert.equal(r.isError, false, r.text);
  }
  assert.ok(first.requests.some((r) => r.url.endsWith('/first'))); assert.ok(!first.requests.some((r) => r.url.endsWith('/second')));
  assert.ok(second.requests.some((r) => r.url.endsWith('/second'))); assert.ok(!second.requests.some((r) => r.url.endsWith('/first')));
});

test('egress SOCKS5 protocol: fragmented reply, remote DNS hostname, and first application bytes preserved', async (t) => {
  const { Duplex } = await import('node:stream');
  let stage = 0;
  const sock = new Duplex({ read() {}, write(chunk, _encoding, cb) {
    if (stage++ === 0) {
      assert.deepEqual([...chunk], [5, 1, 0]);
      this.push(Buffer.from([5])); setImmediate(() => this.push(Buffer.from([0])));
    } else {
      assert.deepEqual([...chunk.subarray(0, 5)], [5, 1, 0, 3, 12]);
      assert.equal(chunk.subarray(5, 17).toString(), 'allowed.test');
      assert.equal(chunk.readUInt16BE(17), 443);
      this.push(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187]), Buffer.from('first TLS bytes')]));
    }
    cb();
  } });
  t.mock.method(net, 'connect', (options) => { assert.deepEqual(options, { host: 'exit.test', port: 1080 }); queueMicrotask(() => sock.emit('connect')); return sock; });
  const result = await connectEgress(parseEgress('socks5://exit.test:1080'), { host: 'allowed.test', port: 443 });
  assert.equal(result, sock);
  assert.equal(sock.read().toString(), 'first TLS bytes');
  sock.destroy();
});

for (const failure of ['authentication refused', 'peer closed', 'timeout']) {
  test(`egress SOCKS5 protocol: ${failure} fails closed and destroys the socket`, async (t) => {
    const { Duplex } = await import('node:stream');
    const sock = new Duplex({ read() {}, write(_chunk, _encoding, cb) {
      if (failure === 'authentication refused') this.push(Buffer.from([5, 255]));
      if (failure === 'peer closed') setImmediate(() => this.destroy());
      cb();
    } });
    t.mock.method(net, 'connect', () => { queueMicrotask(() => sock.emit('connect')); return sock; });
    await assert.rejects(connectEgress(parseEgress('socks5://exit.test:1080'), { host: 'allowed.test', port: 443 }, (s) => s, 20), /egress proxy socks5:\/\/exit.test:1080 failed.*no direct fallback/);
    assert.equal(sock.destroyed, true);
  });
}

for (const mode of ['connected', 'refused', 'closed', 'timeout']) {
  test(`egress HTTP CONNECT protocol: ${mode}, credentials stay at the exit and no fallback occurs`, async (t) => {
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    let requests = 0;
    const sock = new PassThrough();
    t.mock.method(http, 'request', (options) => {
      requests++;
      assert.equal(options.host, 'exit.test'); assert.equal(options.port, 3128);
      assert.equal(options.path, 'allowed.test:443');
      assert.equal(options.headers['proxy-authorization'], 'Basic dXNlcjpwYXNz');
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => {
        req.emit('socket', sock);
        if (mode === 'closed') req.emit('close');
        else if (mode !== 'timeout') req.emit('connect', { statusCode: mode === 'connected' ? 200 : 407 }, sock, Buffer.from('first bytes'));
      });
      req.destroy = (e) => { sock.destroy(); if (e) req.emit('error', e); req.emit('close'); };
      return req;
    });
    const pending = connectEgress(parseEgress('http://user:pass@exit.test:3128'), { host: 'allowed.test', port: 443 }, (s) => s, 20);
    if (mode === 'connected') { assert.equal(await pending, sock); assert.equal(sock.read().toString(), 'first bytes'); sock.destroy(); }
    else await assert.rejects(pending, (e) => /egress proxy http:\/\/exit.test:3128 failed/.test(e.message) && !e.message.includes('user:pass'));
    assert.equal(requests, 1);
  });
}

test('egress session_open MCP exposes and persists exit selection, and sanitizes upstream errors', async (t) => {
  const { buildServer } = await import('../src/tools.mjs');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { manager, cfg } = await managerFixture(t);
  const server = buildServer({ manager, cfg, tenant: 'default', owner: 'test' });
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.callTool({ name: 'session_open', arguments: { profile: 'home', egress: 'home' } });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.equal(JSON.parse(response.content[0].text).egress, 'home');
  manager.engines.open = async () => { throw new Error('upstream http://user:password@exit:8080 failed'); };
  const error = await client.callTool({ name: 'session_open', arguments: { egress: 'default' } });
  assert.equal(error.isError, true);
  assert.ok(!JSON.stringify(error).includes('password')); assert.match(error.content[0].text, /\[masked\]@exit/);
});


test('egress Firefox-style WebSocket upgrade uses CONNECT at the exit and strips local proxy credentials', async (t) => {
  const f = await fixture(t);
  const logs = [];
  const p = await startTenantProxy({ tenant: 'test', allow: patterns('allowed.test'), lookup: async () => '8.8.8.8', egress: parseEgress(f.url), log: (line) => logs.push(line) });
  t.after(() => p.close());
  await new Promise((ok, no) => {
    const req = http.request({ host: '127.0.0.1', port: p.port, path: 'http://allowed.test/socket',
      headers: { host: 'allowed.test', connection: 'Upgrade', upgrade: 'websocket', 'proxy-authorization': auth(p) } });
    req.once('upgrade', (res, sock) => { assert.equal(res.statusCode, 101); sock.destroy(); ok(); });
    req.once('response', (res) => { res.resume(); no(new Error(`upgrade refused: ${res.statusCode}`)); });
    req.once('error', no); req.end();
  });
  assert.deepEqual(f.tunnels, ['allowed.test:80']);
  assert.equal(f.originHeaders[0]['proxy-authorization'], undefined);
  await requestProxy(p, 'http://denied.test/');
  assert.equal(logs.length, 1); assert.ok(!logs.join().includes('user:pass')); assert.ok(!logs.join().includes(p.password));
});

for (const status of [200, 400, 407, 503]) {
  test(`egress health protocol: HTTP ${status}, bounded probe reports public URL only`, async (t) => {
    const { EventEmitter } = await import('node:events');
    t.mock.method(http, 'request', (options) => {
      assert.equal(options.method, 'OPTIONS'); assert.equal(options.path, '*');
      assert.equal(options.headers['proxy-authorization'], 'Basic dXNlcjpwYXNz');
      const req = new EventEmitter();
      req.end = () => queueMicrotask(() => req.emit('response', { statusCode: status, resume() {} }));
      req.destroy = () => req.emit('close');
      return req;
    });
    const health = await probeEgress(parseEgress('http://user:pass@exit:3128'));
    assert.equal(health.ok, status < 500 && status !== 407);
    assert.equal(health.server, 'http://exit:3128'); assert.ok(!JSON.stringify(health).includes('user:pass'));
  });
}


test('egress diagnostics: authenticated exits refuse debug modes that bypass logger redaction', () => {
  const url = 'http://user:password@exit:3128';
  for (const debug of [{ NODE_DEBUG: 'http' }, { DEBUG: 'pw:protocol' }, { DEBUG: '*' }]) {
    for (const exit of [{ BROWSER_EGRESS_PROXY: url }, { BROWSER_EGRESS_PROXIES: JSON.stringify({ home: url }) }]) {
      assert.throws(() => loadConfig({ ...debug, ...exit }), (e) => /egress proxy credentials are refused/.test(e.message) && !e.message.includes('password'));
    }
  }
  assert.ok(loadConfig({ BROWSER_EGRESS_PROXY: url, DEBUG: 'pw:*,-pw:protocol,-pw:api,-pw:channel' }).egressProxy);
  assert.ok(loadConfig({ BROWSER_EGRESS_PROXY: 'http://exit:3128', NODE_DEBUG: 'http' }).egressProxy);
});
