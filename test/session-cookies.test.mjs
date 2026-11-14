import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../src/config.mjs';
import { SessionManager } from '../src/sessions.mjs';
import { readProfileMeta } from '../src/engines.mjs';
import { restoreSessionCookies, saveSessionCookies, SESSION_COOKIES_FILE, DEFAULT_MAX_AGE_MS } from '../src/session-cookies.mjs';
import { startBosun, connect, tmpDir, TOKEN_B, sleep } from './helpers.mjs';

const secret = 'cookie-value-never-log-35';
const cookie = (extra = {}) => ({ name: 'sid', value: secret, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax', ...extra });
const snapshot = (dir) => path.join(dir, SESSION_COOKIES_FILE);
const profileDir = (svc, tenant = 'alice', profile = 'work') => path.join(svc.cfg.dataDir, 'profiles', tenant, profile);
function temp(t) { const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

// Browser-free regressions cover existing cookie precedence, corrupt data and lifecycle timing deterministically.
test('snapshot saves only session cookies, replaces atomically at 0600, and clears removed cookies', async (t) => {
  const dir = temp(t);
  fs.writeFileSync(snapshot(dir), 'old', { mode: 0o644 });
  await saveSessionCookies({ cookies: async () => [cookie(), cookie({ name: 'persistent', expires: Date.now() / 1000 + 3600 })] }, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshot(dir))), [cookie()]);
  assert.equal(fs.statSync(snapshot(dir)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), [SESSION_COOKIES_FILE]);
  await saveSessionCookies({ cookies: async () => [] }, dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(snapshot(dir))), []);
});

test('restore preserves jar entries (including persistent cookies), deduplicates domain/name/path, keeps attributes', async (t) => {
  const dir = temp(t), added = [];
  const other = cookie({ path: '/account', domain: '.example.test', secure: true, sameSite: 'None' });
  fs.writeFileSync(snapshot(dir), JSON.stringify([cookie(), other, other]));
  const jar = [cookie({ value: 'newer-persistent', expires: Date.now() / 1000 + 3600 })];
  await restoreSessionCookies({ cookies: async () => jar, addCookies: async (cs) => added.push(...cs) }, dir);
  assert.deepEqual(added, [other]);
  assert.equal(jar[0].value, 'newer-persistent');
});

test('snapshot max age is configurable; stale files are deleted before reading the jar', async (t) => {
  assert.equal(loadConfig({}).sessionCookiesMaxAgeMs, DEFAULT_MAX_AGE_MS);
  assert.equal(loadConfig({ SESSION_COOKIES_MAX_AGE_DAYS: '2' }).sessionCookiesMaxAgeMs, 2 * 86400_000);
  assert.throws(() => loadConfig({ SESSION_COOKIES_MAX_AGE_DAYS: '0' }), /SESSION_COOKIES_MAX_AGE_DAYS/);
  const dir = temp(t);
  fs.writeFileSync(snapshot(dir), JSON.stringify([cookie()]));
  const old = new Date(Date.now() - 3 * 86400_000); fs.utimesSync(snapshot(dir), old, old);
  await restoreSessionCookies({ cookies: () => { throw new Error('must not read jar'); } }, dir, 2 * 86400_000);
  assert.equal(fs.existsSync(snapshot(dir)), false);
});

test('cookie failures never expose values and leave the previous snapshot intact', async (t) => {
  const dir = temp(t);
  const rawError = () => { throw new Error(secret); };
  fs.writeFileSync(snapshot(dir), JSON.stringify([cookie()]));
  const previous = fs.readFileSync(snapshot(dir), 'utf8');
  await assert.rejects(saveSessionCookies({ cookies: rawError }, dir), { message: 'could not save session cookies' });
  assert.equal(fs.readFileSync(snapshot(dir), 'utf8'), previous);
  await assert.rejects(restoreSessionCookies({ cookies: async () => [], addCookies: rawError }, dir), { message: 'could not restore saved session cookies' });
  fs.writeFileSync(snapshot(dir), secret);
  await assert.rejects(restoreSessionCookies({}, dir), { message: 'could not restore saved session cookies' });
});

async function fakeManager(t) {
  const dataDir = tmpDir();
  const engines = {
    get: (name) => ({ name, family: 'chromium', tracker: 'init' }), load: async () => ({}),
    open: async () => {
      const page = new EventEmitter(); page.url = () => 'about:blank'; page.frames = () => [];
      const ctx = new EventEmitter(); ctx.pages = () => [page]; ctx.addInitScript = async () => {};
      ctx.jar = []; ctx.cookies = async () => ctx.jar; ctx.addCookies = async (cs) => ctx.jar.push(...cs);
      ctx.close = async () => { await Promise.resolve(); ctx.emit('close'); };
      return { ctx };
    },
  };
  const manager = new SessionManager(loadConfig({ BROWSER_DATA: dataDir, IDLE_TIMEOUT_SEC: '0' }), { engines });
  t.after(async () => { await manager.closeAll(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return manager;
}
const fakeOpen = (manager, args = {}) => manager.open({ owner: 'agent', tenant: 'alice', profile: 'work', ...args });

test('crash and failed cookie read keep the last snapshot; disposal logs contain no values', async (t) => {
  const m = await fakeManager(t);
  const first = await fakeOpen(m, { keep_session_cookies: true }); first.ctx.jar = [cookie()];
  await m.close('agent', first.id);
  const file = snapshot(first.profileDir), previous = fs.readFileSync(file, 'utf8');
  for (const reason of ['browser-crashed', 'page-crashed', 'context-closed']) {
    const s = await fakeOpen(m); s.ctx.jar = [];
    await m.dispose(s, reason);
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
  }
  const logs = [], log = console.error; console.error = (...args) => logs.push(args.join(' '));
  try {
    const s = await fakeOpen(m); s.ctx.cookies = async () => { throw new Error(secret); };
    await m.close('agent', s.id);
  } finally { console.error = log; }
  assert.equal(fs.readFileSync(file, 'utf8'), previous);
  assert.match(logs.join(' '), /could not save session cookies/);
  assert.ok(!logs.join(' ').includes(secret));
});

test('sensitive diagnostics refuse saved and explicit opt-in before opening or reading cookies', async (t) => {
  const m = await fakeManager(t);
  const s = await fakeOpen(m, { keep_session_cookies: true }); s.ctx.jar = [cookie()]; await m.close('agent', s.id);
  const previous = fs.readFileSync(snapshot(s.profileDir), 'utf8');
  const debug = process.env.DEBUG, nodeDebug = process.env.NODE_DEBUG;
  try {
    for (const diagnostics of [{ DEBUG: 'pw:protocol' }, { DEBUG: 'pw:*' }, { NODE_DEBUG: 'stream' }]) {
      delete process.env.DEBUG; delete process.env.NODE_DEBUG; Object.assign(process.env, diagnostics);
      await assert.rejects(fakeOpen(m), /session cookie persistence is refused/);
      await assert.rejects(fakeOpen(m, { profile: 'fresh', keep_session_cookies: true }), /session cookie persistence is refused/);
      await assert.rejects(saveSessionCookies({ cookies: () => assert.fail('cookie API called with diagnostics') }, s.profileDir), /could not save session cookies/);
      assert.equal(fs.readFileSync(snapshot(s.profileDir), 'utf8'), previous);
      assert.equal(m.used, 0);
    }
    // Turning it off must still work with diagnostics enabled.
    const disabled = await fakeOpen(m, { keep_session_cookies: false });
    assert.equal(fs.existsSync(snapshot(disabled.profileDir)), false);
    await m.close('agent', disabled.id);
  } finally {
    if (debug === undefined) delete process.env.DEBUG; else process.env.DEBUG = debug;
    if (nodeDebug === undefined) delete process.env.NODE_DEBUG; else process.env.NODE_DEBUG = nodeDebug;
  }
});

test('hung cookie read shares close grace; late results cannot recreate a disabled snapshot', async (t) => {
  const m = await fakeManager(t); m.closeDeadlineMs = 30;
  const s = await fakeOpen(m, { keep_session_cookies: true });
  let finish, closed = false;
  s.ctx.cookies = () => new Promise((resolve) => { finish = resolve; });
  s.ctx.close = async () => { closed = true; };
  await m.close('agent', s.id);
  assert.equal(closed, true); assert.equal(m.used, 0);
  const next = await fakeOpen(m, { keep_session_cookies: false });
  finish([cookie()]); await sleep(10);
  assert.equal(fs.existsSync(snapshot(next.profileDir)), false);
  assert.equal(readProfileMeta(next.profileDir).keep_session_cookies, false);
});

test('failed opens do not change saved setting and do not delete the last snapshot', async (t) => {
  const m = await fakeManager(t);
  const s = await fakeOpen(m, { keep_session_cookies: true }); s.ctx.jar = [cookie()]; await m.close('agent', s.id);
  const open = m.engines.open;
  m.engines.open = async () => { throw new Error('launch failed'); };
  await assert.rejects(fakeOpen(m, { keep_session_cookies: false }), /launch failed/);
  m.engines.open = async (...args) => {
    const result = await open(...args);
    result.ctx.addInitScript = async () => { throw new Error('setup failed'); };
    return result;
  };
  await assert.rejects(fakeOpen(m, { keep_session_cookies: false }), /setup failed/);
  assert.equal(readProfileMeta(s.profileDir).keep_session_cookies, true);
  assert.ok(fs.existsSync(snapshot(s.profileDir)));
  assert.equal(m.used, 0);
});

for (const engine of ['chromium', 'patchright', 'camoufox']) {
  test(`${engine}: opted-in session cookie survives close/open; persistent cookie unchanged; default remains off`, async (t) => {
    // camoufox-js 0.13 requires Node >=22; its native dependency crashes this Mac under Node 20.
    if (engine === 'camoufox' && Number(process.versions.node.split('.')[0]) < 22) return t.skip('camoufox-js 0.13 requires Node >=22');
    const svc = await startBosun({ KEEPALIVE: '0' }); t.after(() => svc.stop());
    const c = await connect(svc); t.after(() => c.close());
    let id;
    try { id = await c.open({ profile: 'work', engine, keep_session_cookies: true }); }
    catch (e) { if (/not installed|browser binary missing/.test(e.message)) return t.skip(e.message); throw e; }
    const expires = Math.floor(Date.now() / 1000) + 86400;
    const ctx = () => svc.manager.sessions.get(id).ctx;
    await ctx().addCookies([cookie(), cookie({ name: 'persistent', value: 'keep-persistent', expires })]);
    assert.equal((await c.call('session_close', { session: id })).isError, false);
    const dir = profileDir(svc), file = snapshot(dir);
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).map((c) => c.name), ['sid']);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(readProfileMeta(dir).keep_session_cookies, true);
    id = await c.open({ profile: 'work', engine });
    const jar = await ctx().cookies();
    assert.equal(jar.filter((c) => c.name === 'sid').length, 1);
    assert.equal(jar.find((c) => c.name === 'sid').value, secret);
    assert.equal(jar.find((c) => c.name === 'persistent').expires, expires);
    assert.equal(jar.find((c) => c.name === 'persistent').value, 'keep-persistent');
    await c.call('session_close', { session: id });
    id = await c.open({ profile: 'work', engine, keep_session_cookies: false });
    assert.equal(fs.existsSync(file), false);
    assert.equal(readProfileMeta(dir).keep_session_cookies, false);
    await c.call('session_close', { session: id });
    // A fresh profile verifies the default without interference from the engine's own session restore behaviour.
    id = await c.open({ profile: 'default-off', engine });
    await ctx().addCookies([cookie()]); await c.call('session_close', { session: id });
    assert.equal(fs.existsSync(snapshot(profileDir(svc, 'alice', 'default-off'))), false);
    id = await c.open({ profile: 'default-off', engine });
    assert.equal((await ctx().cookies()).some((c) => c.name === 'sid'), false);
  });
}

test('MCP setting validation, tenant isolation, stale snapshot, profile directory deletion', async (t) => {
  const svc = await startBosun({ KEEPALIVE: '0', SESSION_COOKIES_MAX_AGE_DAYS: '1' }); t.after(() => svc.stop());
  const a = await connect(svc), b = await connect(svc, TOKEN_B); t.after(() => a.close()); t.after(() => b.close());
  assert.match((await a.call('session_open', { keep_session_cookies: true })).text, /requires a persistent profile/);
  assert.equal((await a.call('session_open', { profile: 'work', keep_session_cookies: 'true' })).isError, true);
  let id = await a.open({ profile: 'work', keep_session_cookies: true });
  await svc.manager.sessions.get(id).ctx.addCookies([cookie()]); await a.call('session_close', { session: id });
  const file = snapshot(profileDir(svc));
  const bid = await b.open({ profile: 'work', keep_session_cookies: true });
  assert.deepEqual(await svc.manager.sessions.get(bid).ctx.cookies(), []);
  await b.call('session_close', { session: bid });
  assert.notEqual(file, snapshot(profileDir(svc, 'bob')));
  const old = new Date(Date.now() - 2 * 86400_000); fs.utimesSync(file, old, old);
  id = await a.open({ profile: 'work' });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await svc.manager.sessions.get(id).ctx.cookies(), []);
  await a.call('session_close', { session: id });
  fs.rmSync(profileDir(svc), { recursive: true });
  id = await a.open({ profile: 'work' });
  assert.equal(svc.manager.sessions.get(id).keep_session_cookies, false);
  assert.deepEqual(await svc.manager.sessions.get(id).ctx.cookies(), []);
});

test('keepalive restores before navigation, saves refreshed session cookies, and never emits their values', async (t) => {
  let sawLogin = false;
  const server = http.createServer((req, res) => {
    sawLogin ||= (req.headers.cookie || '').includes(`sid=${secret}`);
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=refreshed-private-value; Path=/; HttpOnly; SameSite=Lax' });
    res.end('<title>Account</title><p id="who">Signed in</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const svc = await startBosun({ KEEPALIVE: '0' }, { keepalive: { tickMs: 3600000, gapMs: [0, 0], activityMs: [10, 10] } }); t.after(() => svc.stop());
  const events = [], logs = [], log = console.error;
  svc.events.on('needs-human', (e) => events.push(e)); svc.events.on('watch-changed', (e) => events.push(e));
  console.error = (...args) => logs.push(args.join(' ')); t.after(() => { console.error = log; });
  const c = await connect(svc); t.after(() => c.close());
  const id = await c.open({ profile: 'work', keep_session_cookies: true });
  await svc.manager.sessions.get(id).ctx.addCookies([cookie()]); await c.call('session_close', { session: id });
  const result = await c.call('keepalive_set', { profile: 'work', url: `http://127.0.0.1:${server.address().port}/`, logged_in_check: { selector: '#who', text: 'Signed in' } });
  assert.equal(result.isError, false, result.text);
  svc.keepalive.store.entries.get('alice/work').nextAt = Date.now() - 1000;
  assert.equal((await svc.keepalive.tick()).status, 'ok'); assert.equal(sawLogin, true);
  const saved = JSON.parse(fs.readFileSync(snapshot(profileDir(svc))));
  assert.equal(saved.length, 1); assert.equal(saved[0].value, 'refreshed-private-value');
  const reopened = await c.open({ profile: 'work' });
  assert.equal((await svc.manager.sessions.get(reopened).ctx.cookies())[0].value, 'refreshed-private-value');
  const visible = JSON.stringify({ logs, events, list: (await c.call('keepalive_list')).json(), opened: (await c.call('sessions')).json() });
  for (const value of [secret, 'refreshed-private-value']) assert.ok(!visible.includes(value));
});


test('CHIPS partitions retain independent precedence through two save/open cycles', async (t) => {
  const dir = temp(t);
  const cookies = [cookie(), cookie({ partitionKey: 'https://first.example' }), cookie({ partitionKey: 'https://second.example' })];
  await saveSessionCookies({ cookies: async () => cookies }, dir);
  for (const existing of [[], [cookie({ value: 'new-unpartitioned' })], [cookie({ partitionKey: 'https://first.example', value: 'new-partitioned' })]]) {
    const jar = [...existing];
    await restoreSessionCookies({ cookies: async () => jar, addCookies: async (cs) => jar.push(...cs) }, dir);
    assert.equal(jar.length, 3);
    for (const c of cookies) assert.deepEqual(jar.find((x) => x.partitionKey === c.partitionKey), existing.find((x) => x.partitionKey === c.partitionKey) ?? c);
    await saveSessionCookies({ cookies: async () => jar }, dir);
    const reopened = [];
    await restoreSessionCookies({ cookies: async () => [], addCookies: async (cs) => reopened.push(...cs) }, dir);
    assert.deepEqual(reopened, jar);
    await saveSessionCookies({ cookies: async () => cookies }, dir);
  }
});
