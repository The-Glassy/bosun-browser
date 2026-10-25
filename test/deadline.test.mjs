// Per-call deadline (src/deadline.mjs): a call that runs out of time is answered by its deadline with a clear error;
// the session's next call runs once what the call started has stopped, and a page that stopped responding is
// replaced by a new one in the same session. The meeting tools, download_wait and the handoff waits keep their own
// limits.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { loadConfig } from '../src/config.mjs';
import { DEFAULT_TIMEOUT_SEC, OWN_LIMIT_TOOLS, TIMED_TOOLS } from '../src/deadline.mjs';
import { startBosun, connect, sleep, until } from './helpers.mjs';

const PAGES = {
  '/': '<title>Home</title><h1>Hello Bosun</h1>',
  // The renderer goes into an endless loop shortly after the page loaded: nothing in the page answers any more.
  '/spin': '<title>Spin</title><p>about to hang</p><script>setTimeout(() => { for (;;) {} }, 2500)</script>',
  '/slow': '<title>Slow</title><p>nothing to click here</p>',
};

let srv, base, svc, c;
before(async () => {
  srv = http.createServer((req, res) => {
    const body = PAGES[req.url.split('?')[0]];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body || 'not found');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  svc = await startBosun({ TOOL_TIMEOUT_SEC: '4', TOOL_TIMEOUTS: 'read=15,screenshot=40,navigate=20,session_close=20,session_open=60', IDLE_TIMEOUT_SEC: '0' });
  c = await connect(svc);
});
after(async () => {
  await c?.close();
  await svc?.stop();
  await new Promise((r) => { srv.close(r); srv.closeAllConnections(); });
});

test('config: TOOL_TIMEOUT_SEC for every timed tool, TOOL_TIMEOUTS per tool, at most 120 s', () => {
  const d = loadConfig({}).toolTimeouts;
  assert.deepEqual([...d.keys()].sort(), [...TIMED_TOOLS].sort());
  for (const [t, ms] of d) assert.equal(ms, t === 'wait_for' ? 75_000 : DEFAULT_TIMEOUT_SEC * 1000, t);
  for (const t of OWN_LIMIT_TOOLS) assert.equal(d.has(t), false, t);
  const x = loadConfig({ TOOL_TIMEOUT_SEC: '30', TOOL_TIMEOUTS: 'read=90, upload = 120' }).toolTimeouts;
  assert.equal(x.get('read'), 90_000);
  assert.equal(x.get('upload'), 120_000);
  assert.equal(x.get('navigate'), 30_000);
  // wait_for waits up to 60 s by itself: at least 75 s unless named.
  assert.equal(x.get('wait_for'), 75_000);
  assert.equal(loadConfig({ TOOL_TIMEOUT_SEC: '120' }).toolTimeouts.get('wait_for'), 120_000);
  assert.equal(loadConfig({ TOOL_TIMEOUTS: 'wait_for=30' }).toolTimeouts.get('wait_for'), 30_000);
  assert.throws(() => loadConfig({ TOOL_TIMEOUT_SEC: '121' }), /TOOL_TIMEOUT_SEC must be between 1 and 120/);
  assert.throws(() => loadConfig({ TOOL_TIMEOUT_SEC: '0' }), /between 1 and 120/);
  assert.throws(() => loadConfig({ TOOL_TIMEOUT_SEC: '1m' }), /whole number of seconds/);
  assert.throws(() => loadConfig({ TOOL_TIMEOUTS: 'read=500' }), /TOOL_TIMEOUTS read must be between 1 and 120/);
  assert.throws(() => loadConfig({ TOOL_TIMEOUTS: 'reed=30' }), /no tool reed/);
  assert.throws(() => loadConfig({ TOOL_TIMEOUTS: 'download_wait=30' }), /download_wait keeps its own limit/);
  assert.throws(() => loadConfig({ TOOL_TIMEOUTS: 'meeting_join=30' }), /keeps its own limit/);
  assert.throws(() => loadConfig({ TOOL_TIMEOUTS: 'read' }), /comma list of tool=seconds/);
});

test('a page that stopped responding: the call times out, the page is replaced, the session goes on', async () => {
  const s = await c.open();
  const nav = await c.call('navigate', { session: s, url: `${base}/spin` });
  assert.equal(nav.isError, false, nav.text);
  await sleep(3000); // the loop has started
  const t0 = Date.now();
  const r = await c.call('read', { session: s });
  const took = Date.now() - t0;
  assert.equal(r.isError, true);
  // Replaced before the deadline, or (Firefox takes about 5 s to open a tab next to a busy one) still being replaced:
  // the next call waits for that.
  assert.match(r.text, /^read timed out after 15 s \(Bosun's limit for one read call \(TOOL_TIMEOUT_SEC \/ TOOL_TIMEOUTS\)\)( and the page stopped responding, so Bosun replaced it with a new tab in the same session \(cookies kept, now at about:blank\)|; Bosun is checking the page \(one that does not respond is replaced by a new tab in the same session, cookies kept, at about:blank\) and the next call on this session waits for that)/);
  if (svc.cfg.engine !== 'camoufox') assert.match(r.text, /replaced it with a new tab/);
  assert.ok(took < 15000 + 1000, `answered after ${took} ms, past the deadline`);
  // Same session, a working page: at about:blank, then anywhere again.
  const after1 = await c.call('read', { session: s, mode: 'text' });
  assert.equal(after1.isError, false, after1.text);
  assert.match(after1.text, /^url: about:blank/);
  const nav2 = await c.call('navigate', { session: s, url: `${base}/` });
  assert.equal(nav2.isError, false, nav2.text);
  assert.match((await c.call('read', { session: s, mode: 'text' })).text, /Hello Bosun/);
  const list = (await c.call('sessions')).json();
  assert.deepEqual(list.map((x) => x.id), [s]);
  // The wedged tab is gone (closing it does not close the session).
  await until(() => svc.manager.sessions.get(s).ctx.pages().length === 1, 15000);
  await c.call('session_close', { session: s });
});

test('a slow call on a page that still responds: answered at its deadline; the next call runs once it has stopped', async () => {
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${base}/slow` });
  // click waits up to 15 s for an element that never comes; its deadline is 4 s.
  const t0 = Date.now();
  const [clicked, back] = await Promise.all([
    c.call('click', { session: s, selector: '#never' }),
    sleep(200).then(() => c.call('back', { session: s })),
  ]);
  assert.equal(clicked.isError, true);
  assert.match(clicked.text, /^click timed out after 4 s .*; the page still responds and the session is usable/);
  // back was queued behind the click: its own 4 s ran out while it waited, so it was answered without running.
  assert.equal(back.isError, true);
  assert.match(back.text, /^back timed out after 4 s .* while waiting behind other calls on this session; it was not run, the session is usable/);
  assert.ok(Date.now() - t0 < 4200 + 1000, 'both answered by their deadlines');
  // The next call waits until the click has stopped (its own 15 s), so the two never overlap; then it runs.
  const shot = await c.call('screenshot', { session: s });
  assert.equal(shot.isError, false, shot.text);
  assert.ok(Date.now() - t0 >= 14500, `ran after ${Date.now() - t0} ms, while the click was still running`);
  const again = await c.call('read', { session: s, mode: 'text' });
  assert.match(again.text, /nothing to click here/);
  await c.call('session_close', { session: s });
});

test('wait_for has 75 s unless TOOL_TIMEOUTS names it', async () => {
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${base}/slow` });
  const t0 = Date.now();
  const r = await c.call('wait_for', { session: s, selector: '#never', timeoutMs: 6000 });
  assert.equal(r.isError, true);
  assert.match(r.text, /Timeout 6000ms exceeded/); // its own timeout, not the 4 s deadline
  assert.ok(Date.now() - t0 >= 5500);
  await c.call('session_close', { session: s });
});

test('a session_open that times out leaves no session behind', async () => {
  const slow = await startBosun({ TOOL_TIMEOUTS: 'session_open=1' });
  try {
    const orig = slow.manager.open.bind(slow.manager);
    let opened = null;
    slow.manager.open = async (o) => { await sleep(1500); opened = orig(o); return opened; };
    const k = await connect(slow);
    const r = await k.call('session_open');
    assert.equal(r.isError, true);
    assert.match(r.text, /^session_open timed out after 1 s/);
    // The open goes on after the answer and succeeds; then it is closed at once.
    const s = await (await until(() => opened, 10000));
    assert.equal(s.disposed, true);
    assert.equal(s.closeReason, 'open-timed-out');
    await until(() => slow.manager.used === 0 && slow.manager.sessions.size === 0, 30000);
    assert.deepEqual((await k.call('sessions')).json(), []);
    await k.close();
  } finally { await slow.stop(); }
});
