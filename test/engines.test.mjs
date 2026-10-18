// Engine selection: defaults, explicit choice, clear errors for missing modules/binaries, no silent fallback,
// per-engine profile families, cleanup of per-session temp profiles. No internet needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { loadConfig } from '../src/config.mjs';
import { createEngines, claimProfile, ENGINE_NAMES, EngineUnavailableError } from '../src/engines.mjs';
import { procsUsing, terminate } from '../src/sessions.mjs';
import { startBosun, startPageServer, connect, tmpDir, until } from './helpers.mjs';

const SERVER = new URL('../src/server.mjs', import.meta.url).pathname;
const installed = async (spec) => import(spec).then(() => true, () => false);
const notFound = (spec) => Object.assign(new Error(`Cannot find package '${spec}'`), { code: 'ERR_MODULE_NOT_FOUND' });
// An importer that behaves as if the given packages were not installed.
const without = (...missing) => (spec) => (missing.includes(spec) ? Promise.reject(notFound(spec)) : import(spec));

let pages;
const pagesP = startPageServer().then((p) => { pages = p; });
after(async () => { await pagesP; await pages.close(); });

test('ENGINE defaults to chromium and is validated', () => {
  assert.equal(loadConfig({}).engine, 'chromium');
  for (const e of ENGINE_NAMES) assert.equal(loadConfig({ ENGINE: e }).engine, e);
  assert.throws(() => loadConfig({ ENGINE: 'webkit' }), /ENGINE must be one of chromium, patchright, camoufox/);
  assert.throws(() => loadConfig({ CAMOUFOX_OS: 'beos' }), /CAMOUFOX_OS/);
  assert.equal(loadConfig({ CAMOUFOX_OS: 'linux' }).camoufoxOs, 'linux');
});

test('a missing engine package is a clear error, and loading is retried later', async () => {
  let fail = true;
  const engines = createEngines({ importer: (spec) => (fail && spec === 'patchright' ? Promise.reject(notFound(spec)) : import(spec)) });
  await assert.rejects(engines.load('patchright'), (e) => e instanceof EngineUnavailableError && /engine patchright is not installed — run: npm install patchright@1\.64\.1 && npx patchright install chromium/.test(e.message));
  await assert.rejects(createEngines({ importer: without('camoufox-js') }).load('camoufox'), /engine camoufox is not installed — run: npm install camoufox-js@0\.13\.0 && npx camoufox-js fetch/);
  assert.throws(() => engines.get('webkit'), /unknown engine webkit/);
  if (await installed('patchright')) {
    fail = false;
    assert.ok(await engines.load('patchright')); // the failed attempt wasn't cached
  }
});

test('a missing browser binary is a clear error, and the failed open leaves no temp profile', async () => {
  const broken = { name: 'patchright', family: 'chromium', cdp: true, shared: false, tracker: 'navigate', load: async () => ({}), open: async () => { throw new Error("browserType.launchPersistentContext: Executable doesn't exist at /nope/chrome"); } };
  const svc = await startBosun({ ENGINE: 'chromium' }, { engines: createEngines({ overrides: { patchright: broken } }) });
  try {
    const c = await connect(svc);
    const r = await c.call('session_open', { engine: 'patchright' });
    assert.match(r.text, /engine patchright: browser binary missing — run: npm install patchright@1\.64\.1 && npx patchright install chromium/);
    assert.deepEqual(fs.readdirSync(path.join(svc.dataDir, 'tmp')), []);
    assert.equal(svc.manager.used, 0);
    await c.close();
  } finally {
    await svc.stop();
  }
});

test('the service refuses to start when the default engine is missing', async () => {
  await assert.rejects(startBosun({ ENGINE: 'patchright' }, { engines: createEngines({ importer: without('patchright') }) }), /engine patchright is not installed/);
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ENGINE: 'webkit', BROWSER_DATA: tmpDir() } });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, err }));
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /ENGINE must be one of/);
});

test('session_open: default engine, explicit engine, no silent fallback when one is missing', async () => {
  await pagesP;
  const svc = await startBosun({ ENGINE: 'chromium' }, { engines: createEngines({ importer: without('patchright', 'camoufox-js') }) });
  try {
    const c = await connect(svc);
    const r1 = await c.call('session_open', {});
    assert.equal(r1.json().engine, 'chromium');
    const r2 = await c.call('session_open', { engine: 'chromium' });
    assert.equal(r2.json().engine, 'chromium');
    for (const engine of ['patchright', 'camoufox']) {
      const r = await c.call('session_open', { engine });
      assert.equal(r.isError, true);
      assert.match(r.text, new RegExp(`engine ${engine} is not installed — run: `));
    }
    assert.equal((await c.call('session_open', { engine: 'webkit' })).isError, true); // schema enum
    assert.equal(svc.manager.used, 2); // failed opens released their reservation; nothing fell back to chromium
    const list = (await c.call('sessions')).json();
    assert.deepEqual(list.map((s) => s.engine), ['chromium', 'chromium']);
    await c.close();
  } finally {
    await svc.stop();
  }
});

test('temp profiles left by a killed process are removed at startup', async () => {
  const { SessionManager } = await import('../src/sessions.mjs');
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, 'tmp', 'camoufox-stale'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'tmp', 'camoufox-stale', 'cookies.sqlite'), 'x');
  const m = new SessionManager(loadConfig({ BROWSER_DATA: dataDir, IDLE_TIMEOUT_SEC: '0' }));
  assert.ok(!fs.existsSync(path.join(dataDir, 'tmp')));
  await m.closeAll();
});

test('a persistent profile keeps its engine family', () => {
  const dir = tmpDir();
  const chromium = { family: 'chromium' }, firefox = { family: 'firefox' };
  fs.mkdirSync(path.join(dir, 'new'));
  claimProfile(path.join(dir, 'new'), firefox);
  assert.throws(() => claimProfile(path.join(dir, 'new'), chromium), /created with a firefox engine; open it with engine camoufox/);
  claimProfile(path.join(dir, 'new'), firefox);
  // A profile from before engines existed (non-empty, no marker) is a Chromium profile.
  fs.mkdirSync(path.join(dir, 'old'));
  fs.writeFileSync(path.join(dir, 'old', 'Local State'), '{}');
  assert.throws(() => claimProfile(path.join(dir, 'old'), firefox), /created with a chromium engine; open it with engine chromium or patchright/);
  claimProfile(path.join(dir, 'old'), chromium);
});

for (const engine of ['patchright', 'camoufox']) {
  test(`${engine}: own browser per session, temp profile removed on close`, { skip: !(await installed(engine === 'camoufox' ? 'camoufox-js' : engine)) && `${engine} not installed` }, async () => {
    await pagesP;
    const svc = await startBosun();
    try {
      const c = await connect(svc);
      const id = (await c.call('session_open', { engine })).json().session;
      const s = svc.manager.sessions.get(id);
      assert.equal(s.engine, engine);
      assert.ok(s.tmpDir && fs.existsSync(s.tmpDir));
      assert.equal(s.browser, null); // not the shared browser
      const nav = await c.call('navigate', { session: id, url: `${pages.base}/` });
      assert.equal(nav.isError, false, nav.text);
      assert.equal(nav.json().title, 'Home');
      const tmp = s.tmpDir;
      await c.call('session_close', { session: id });
      assert.ok(!fs.existsSync(tmp));
      assert.equal(svc.manager.used, 0);
      await c.close();
    } finally {
      await svc.stop();
    }
  });
}

test('profiles: opening a Chromium profile with camoufox is refused before launching anything', { skip: !(await installed('camoufox-js')) && 'camoufox not installed' }, async () => {
  const svc = await startBosun({ ENGINE: 'chromium' });
  try {
    const c = await connect(svc);
    const id = (await c.call('session_open', { profile: 'work' })).json().session;
    await c.call('session_close', { session: id });
    const r = await c.call('session_open', { profile: 'work', engine: 'camoufox' });
    assert.match(r.text, /created with a chromium engine/);
    await until(() => svc.manager.used === 0);
    await c.close();
  } finally {
    await svc.stop();
  }
});

test('startup also checks the default engine\'s browser binary', async () => {
  const engines = createEngines({
    overrides: { chromium: { ...createEngines().get('chromium'), check: () => { throw Object.assign(new Error('Executable doesn\'t exist at /nope'), { binary: true }); } } },
  });
  await assert.rejects(startBosun({ ENGINE: 'chromium' }, { engines }), /engine chromium: browser binary missing — run: npx playwright install chromium/);
});

test('a failed open with a missing engine does not claim a fresh profile for that engine', async () => {
  const svc = await startBosun({ ENGINE: 'chromium' }, { engines: createEngines({ importer: without('camoufox-js') }) });
  try {
    const c = await connect(svc);
    assert.match((await c.call('session_open', { profile: 'fresh', engine: 'camoufox' })).text, /not installed/);
    const r = await c.call('session_open', { profile: 'fresh' });
    assert.equal(r.isError, false, r.text);
    await c.close();
  } finally {
    await svc.stop();
  }
});

test('process lookup by directory matches exactly (…/work is not …/work2)', async () => {
  const base = tmpDir();
  const spawnOn = (d) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', '--', `--user-data-dir=${d}`], { stdio: 'ignore' });
  const a = spawnOn(path.join(base, 'work')), b = spawnOn(path.join(base, 'work2'));
  try {
    await until(() => procsUsing(path.join(base, 'work')).length === 1 && procsUsing(path.join(base, 'work2')).length === 1);
    assert.deepEqual(procsUsing(path.join(base, 'work')), [a.pid]);
    assert.equal(await terminate(path.join(base, 'work')), true);
    assert.deepEqual(procsUsing(path.join(base, 'work2')), [b.pid]); // untouched
  } finally {
    a.kill('SIGKILL'); b.kill('SIGKILL');
  }
});

for (const engine of ['patchright', 'camoufox']) {
  test(`${engine}: a close that hangs is escalated; the slot is released only once the browser is gone`, { skip: !(await installed(engine === 'camoufox' ? 'camoufox-js' : engine)) && `${engine} not installed` }, async () => {
    const svc = await startBosun();
    try {
      svc.manager.closeDeadlineMs = 300;
      const c = await connect(svc);
      const id = (await c.call('session_open', { engine })).json().session;
      const s = svc.manager.sessions.get(id);
      assert.ok(procsUsing(s.dir).length > 0);
      s.ctx.close = () => new Promise(() => {}); // hangs forever
      s.ctx.removeAllListeners('close');
      await svc.manager.dispose(s, 'closed');
      assert.deepEqual(procsUsing(s.dir), []);
      assert.ok(!fs.existsSync(s.tmpDir));
      assert.equal(svc.manager.used, 0);
      await c.close();
    } finally {
      await svc.stop();
    }
  });
}
