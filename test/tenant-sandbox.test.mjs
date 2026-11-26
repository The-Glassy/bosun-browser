import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { allowFor, parseHostPattern } from '../src/allow.mjs';
import { startService } from '../src/bosun.mjs';
import { loadConfig } from '../src/config.mjs';
import { exitsFor } from '../src/egress.mjs';
import { forwardTcp, providerConnection, providerFetch } from '../src/tenant-network.mjs';
import { WebSocket, WebSocketServer } from 'ws';
import { resolveTarget } from '../src/proxy.mjs';
import { createSandboxRuntime, sandboxCommand } from '../src/tenant-sandbox.mjs';
import { closeServer, fixture, listen } from './egress-fixture.mjs';
import { connect, startBosun, tmpDir, TOKEN, TOKEN_B, until, viewer } from './helpers.mjs';

const assertOk = async (client, name, args) => {
  const result = await client.call(name, args);
  assert.equal(result.isError, false, result.text);
  return result.json();
};

function putChunked(url, first, last) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT', headers: { expect: '100-continue' } }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
      res.once('error', reject);
    });
    req.on('continue', () => {
      req.write(first);
      req.end(last);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timed out waiting for the worker')));
    req.flushHeaders();
  });
}

test('sandbox address checks reject private DNS answers, numeric aliases and wildcard exceptions', async () => {
  const target = (allow, name, resolve) => resolveTarget(allow, name, 80, async () => resolve, true, true);
  for (const name of ['127.1', '0x7f000001', '169.254.169.254', '::ffff:7f00:1', 'fd00::1', '64:ff9b::a9fe:a9fe', '::a9fe:a9fe']) {
    assert.match((await target(null, name)).denied, /private/, name);
    assert.match((await target([parseHostPattern('*')], name)).denied, /private/, name);
  }
  const patterns = ['*.example.org', '127.0.0.1:80'].map(parseHostPattern);
  assert.equal((await target(patterns, 'api.example.org', '127.0.0.1')).ip, '127.0.0.1');
  assert.equal((await target(patterns, 'api.example.org', '1.1.1.1')).host, '1.1.1.1');
  assert.match((await target(patterns, 'api.example.org', '127.0.0.2')).denied, /private/);
  assert.match((await target(patterns, 'other.example.net', '1.1.1.1')).denied, /allowlist/);
});

test('tenant egress exit limits validate and select only the configured exits', () => {
  const env = { BROWSER_TOKEN: TOKEN, BROWSER_EGRESS_PROXIES: '{"office":"http://exit.example.org:3128"}' };
  assert.deepEqual([...exitsFor(loadConfig(env), 'default')], ['default', 'direct', 'office']);
  const cfg = loadConfig({ ...env, BROWSER_TENANT_EGRESS: 'default=direct,office' });
  assert.deepEqual([...exitsFor(cfg, 'default')], ['direct', 'office']);
  assert.equal(allowFor(cfg, 'default'), null);
  assert.throws(() => loadConfig({ ...env, BROWSER_TENANT_EGRESS: 'default=unknown' }), /unknown exit/);
});

const canProbe = process.platform === 'linux' && process.getuid?.() !== 0;
const probe = canProbe && spawnSync('bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/usr', '/usr',
  '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--proc', '/proc', '/usr/bin/true'], { timeout: 5000 });
const skip = process.env.BOSUN_TEST_SANDBOX !== '1' && (!probe || probe.status !== 0)
  ? 'requires a Linux host that permits bwrap user, PID and network namespaces and a private procfs' : false;

function inspectSandbox(sandbox, tenant, files, port) {
  const ipc = fs.mkdtempSync(path.join(sandbox.runtime, 'probe-ipc-'));
  const relay = fs.mkdtempSync(path.join(sandbox.runtime, 'probe-relay-'));
  const command = sandboxCommand({
    runtime: sandbox.runtime, state: sandbox.state(tenant), ipc, relay, headless: true, tz: 'UTC',
    script: '--input-type=module', args: ['-e', `
      import fs from 'node:fs';
      import net from 'node:net';
      const paths = ${JSON.stringify(files)};
      const marker = '/tmp/tenant-sandbox-marker';
      const seen = paths.map((p) => { try { return fs.readFileSync(p, 'utf8'); } catch (error) { return error.code; } });
      const sharedTemp = fs.existsSync(marker);
      fs.writeFileSync(marker, 'this sandbox only');
      const direct = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: ${port} }, () => { sock.destroy(); resolve(true); });
        sock.on('error', () => resolve(false));
      });
      console.log(JSON.stringify({ seen, sharedTemp, direct, token: !!process.env.BROWSER_TOKENS }));
    `],
  });
  const filter = fs.openSync(path.join(sandbox.runtime, 'seccomp'), 'r');
  try {
    const result = spawnSync('bwrap', command, { stdio: ['ignore', 'pipe', 'pipe', filter], encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, BROWSER_TOKENS: TOKEN },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return JSON.parse(result.stdout);
  } finally { fs.closeSync(filter); }
}

test('sandbox refuses legacy data and only auto-migrates when explicitly enabled', { skip }, async (t) => {
  const dataDir = tmpDir();
  let service;
  t.after(async () => {
    await service?.shutdown();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const legacy = path.join(dataDir, 'profiles/default/work');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'bosun-profile.json'), '{"egress":"direct"}');
  const env = {
    BROWSER_DATA: dataDir, BROWSER_TOKEN: TOKEN, HEADLESS: '1', FEATURES_ENGINES: 'chromium',
    BOSUN_TENANT_SANDBOX: 'on', WS_PORT: '0',
  };
  await assert.rejects(startService(loadConfig(env)), /Legacy BROWSER_DATA layout.*bosun migrate-data/);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.existsSync(path.join(dataDir, 'tenants')), false);
  assert.equal(fs.existsSync(path.join(dataDir, '.bosun-backups')), false);

  service = await startService(loadConfig({ ...env, BOSUN_AUTO_MIGRATE: '1' }));
  assert.equal(fs.existsSync(legacy), false);
  const migrated = path.join(dataDir, 'tenants/default/profiles/default/work/bosun-profile.json');
  assert.equal(fs.readFileSync(migrated, 'utf8'), '{"egress":"direct"}');
  assert.equal(fs.readdirSync(path.join(dataDir, '.bosun-backups')).length, 1);
});

test('two real bwrap tenants isolate profiles, downloads, tmp, connection leases and egress', { skip, timeout: 90_000 }, async (t) => {
  const packets = [];
  const origin = http.createServer((req, res) => {
    packets.push(req.url);
    if (req.url === '/file') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="notes.txt"' });
      return res.end('owned download');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Tenant page</title><a href="/file">Download</a><p id="secret">fixture secret value</p>
      <input id="pw" type="password"><p id="zone"></p><script>
      document.getElementById('zone').textContent = 'Browser zone ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
      </script>`);
  });
  const port = await listen(origin);
  t.after(() => closeServer(origin));
  const exit = await fixture(t);
  const host = `127.0.0.1:${port}`, web = `http://${host}`;
  const svc = await startBosun({
    BOSUN_TENANT_SANDBOX: 'auto', BOSUN_ALLOW_UNSAFE_SHARED: '0', ENGINE: 'chromium', FEATURES_ENGINES: 'chromium',
    CHROMIUM_SANDBOX: '1', HEADLESS: '1', KEEPALIVE: '0', SECRETS_REVEAL: '1', BROWSER_TIMEZONE: 'UTC',
    BROWSER_TENANT_ALLOW: `alice=${host};bob=${host}`, BROWSER_TENANT_DOWNLOAD_ALLOW: `alice=${host};bob=${host}`,
    BROWSER_EGRESS_PROXIES: JSON.stringify({ alternate: exit.url }), BROWSER_TENANT_EGRESS: 'alice=default,alternate;bob=default',
  });
  t.after(() => svc.stop());
  const [a, b] = await Promise.all([connect(svc, TOKEN), connect(svc, TOKEN_B)]);
  t.after(() => Promise.all([a.close(), b.close()]));
  const names = (await a.listTools()).tools.map(({ name }) => name);
  for (const name of ['secret_create', 'secret_save', 'secret_reveal']) assert.ok(names.includes(name), name);
  assert.deepEqual((await b.listTools()).tools.map(({ name }) => name), names);
  const health = `http://127.0.0.1:${svc.ws.port}`;
  const readiness = await fetch(`${health}/health`);
  assert.equal(readiness.status, 200);
  assert.deepEqual((await readiness.json()).engines, [{ name: 'chromium', ok: true }]);
  assert.equal((await fetch(`${health}/health/exits`)).status, 200);
  assert.match(await (await fetch(`${health}/metrics`)).text(), /bosun_exit_up\{name="alternate"\} 1/);
  assert.equal((await b.call('session_open', { egress: 'alternate' })).isError, true);
  const alternate = await a.open({ egress: 'alternate' });
  await assertOk(a, 'navigate', { session: alternate, url: web });
  assert.ok(exit.tunnels.includes(host), 'named exit received the pinned address');
  assert.ok(exit.originHeaders.every((headers) => !headers['proxy-authorization']));
  await exit.stopExit();
  const failed = await a.call('navigate', { session: alternate, url: `${web}/exit-down` });
  assert.ok(failed.isError || failed.json().status === 502, failed.text);
  assert.ok(!packets.includes('/exit-down'), 'an unavailable exit never dials the origin directly');
  await assertOk(a, 'session_close', { session: alternate });
  const [sa, sb] = await Promise.all([a.open({ profile: 'same' }), b.open({ profile: 'same' })]);
  assert.equal((await b.call('read', { session: sa })).isError, true);
  const files = [];
  for (const [tenant, client, session] of [['alice', a, sa], ['bob', b, sb]]) {
    const nav = await assertOk(client, 'navigate', { session, url: web });
    assert.equal(nav.title, 'Tenant page');
    assert.match((await client.call('read', { session })).text, /Browser zone UTC/);
    await assertOk(client, 'click', { session, text: 'Download' });
    const downloads = await assertOk(client, 'downloads', { session });
    assert.equal(downloads[0]?.state, 'ready');
    const profile = path.join(svc.dataDir, 'tenants', tenant, 'profiles', tenant, 'same', 'bosun-profile.json');
    const download = path.join(svc.dataDir, 'tenants', tenant, 'downloads', tenant, downloads[0].download_id, 'notes.txt');
    assert.ok(fs.existsSync(profile));
    assert.equal(fs.readFileSync(download, 'utf8'), 'owned download');
    files.push(profile, download);
    const link = await assertOk(client, 'download_get', { download_id: downloads[0].download_id });
    const foreign = tenant === 'alice' ? TOKEN_B : TOKEN;
    assert.equal((await fetch(link.get_url, { headers: { authorization: `Bearer ${foreign}` } })).status, 403);
  }
  assert.equal(packets.filter((p) => p === '/file').length, 2);

  const sandbox = createSandboxRuntime(svc.dataDir);
  t.after(() => sandbox.close());
  for (const [tenant, readable] of [['alice', 0], ['bob', 2]]) {
    const actual = inspectSandbox(sandbox, tenant, files, port);
    const expected = files.map((file, i) => (i === readable || i === readable + 1) ? fs.readFileSync(file, 'utf8') : 'ENOENT');
    assert.deepEqual(actual, { seen: expected, sharedTemp: false, direct: false, token: false });
  }

  const input = await assertOk(a, 'secret_create', {});
  const foreignPut = await fetch(input.put_url, { method: 'PUT', body: 'ignored', headers: { authorization: `Bearer ${TOKEN_B}` } });
  assert.equal(foreignPut.status, 403);
  assert.equal(await putChunked(input.put_url, 'typed fixture ', 'value'), 201);
  await assertOk(a, 'type', { session: sa, selector: '#pw', secret_id: input.secret_id });
  assert.equal((await assertOk(a, 'secret_reveal', { session: sa, selector: '#pw' })).value, 'typed fixture value');
  const revealed = await assertOk(a, 'secret_reveal', { session: sa, selector: '#secret' });
  assert.equal(revealed.value, 'fixture secret value');
  const secret = await assertOk(a, 'secret_save', { session: sa, selector: '#secret' });
  const link = await assertOk(a, 'download_get', { download_id: secret.download_id, inline: false });
  assert.equal(await (await fetch(link.get_url)).text(), 'fixture secret value');
  assert.equal((await fetch(link.get_url)).status, 404);
  const put = await assertOk(a, 'upload_create', { filename: 'fixture.txt', size_bytes: 7 });
  assert.equal((await fetch(put.put_url, { method: 'PUT', body: 'fixture' })).status, 201);
  const handoff = await assertOk(b, 'request_human', { session: sb, reason: 'test' });
  assert.equal((await fetch(handoff.link)).status, 200);
  assert.equal((await fetch(handoff.link.replace('/tenant/bob/', '/tenant/alice/'))).status, 404);
  const legacy = handoff.link.replace('/tenant/bob/', '/');
  const redirect = await fetch(legacy, { redirect: 'manual' });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), new URL(handoff.link).pathname);
  assert.equal((await fetch(legacy)).status, 200);
  assert.equal((await fetch(new URL('/v/' + '0'.repeat(32), legacy))).status, 404);
  const v = await viewer(legacy);
  await until(() => v.frames > 0, 10_000);
  v.ws.send(JSON.stringify({ type: 'done' }));
  assert.equal((await assertOk(b, 'handoff_wait', { session: sb, timeoutSec: 10 })).status, 'human-done');
  assert.equal((await fetch(legacy)).status, 404);
});

test('sandbox state rejects a symlink in place of a tenant root', { skip: !canProbe }, (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sandbox = createSandboxRuntime(dir);
  t.after(() => sandbox.close());
  fs.symlinkSync(sandbox.state('alice'), path.join(dir, 'tenants/bob'));
  assert.throws(() => sandbox.state('bob'), /must be a directory/);
});

test('configured provider connections carry HTTP and WebSocket traffic over a Unix relay', { skip: process.platform === 'win32' }, async (t) => {
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    req.pipe(res);
  });
  const wss = new WebSocketServer({ server: origin });
  wss.on('connection', (ws) => ws.send('transcript fixture'));
  const port = await listen(origin);
  t.after(async () => { wss.close(); await closeServer(origin); });
  const dir = tmpDir(), socketPath = path.join(dir, 'provider');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const relay = await forwardTcp({ path: socketPath }, { host: '127.0.0.1', port });
  t.after(() => relay.close());
  const base = `127.0.0.1:${port}`;
  const response = await providerFetch(`http://${base}/audio`, { method: 'POST', body: 'audio fixture' }, socketPath);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('content-type'), 'text/plain');
  assert.equal(await new Response(response.body).text(), 'audio fixture');
  const wsUrl = `ws://${base}/transcript`;
  const ws = new WebSocket(wsUrl, { createConnection: providerConnection(wsUrl, socketPath), handshakeTimeout: 5000 });
  try {
    const [message] = await once(ws, 'message');
    assert.equal(String(message), 'transcript fixture');
  } finally { ws.terminate(); }
});

test('the gateway diagnostic guard applies to secret tools in its worker', { skip, timeout: 30_000 }, async (t) => {
  const previous = process.env.NODE_DEBUG;
  process.env.NODE_DEBUG = 'bosun-sandbox-test';
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_DEBUG;
    else process.env.NODE_DEBUG = previous;
  });
  const svc = await startBosun({ BROWSER_TOKENS: '', BROWSER_TOKEN: TOKEN, BOSUN_TENANT_SANDBOX: 'on',
    FEATURES_ENGINES: 'chromium', ENGINE: 'chromium', KEEPALIVE: '0', HEADLESS: '1' });
  t.after(() => svc.stop());
  const client = await connect(svc);
  t.after(() => client.close());
  const result = await client.call('secret_create');
  assert.equal(result.isError, true);
  assert.match(result.text, /secrets are refused.*NODE_DEBUG/);
});
