// A bot check that keeps reloading itself is reported as such instead of as random tool failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, startPageServer, connect, sleep } from './helpers.mjs';
import { BOT_LOOP } from '../src/tools.mjs';

let pages, svc;
before(async () => { pages = await startPageServer(); svc = await startBosun(); });
after(async () => { await svc.stop(); await pages.close(); });

const LOOP = /bot check keeps reloading \(likely IP reputation\); try engine chromium \+ request_human, or another network/;

test('a challenge page that keeps reloading itself gives a clear error on every page tool', async () => {
  assert.match(BOT_LOOP, LOOP);
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/loop` }); // first visit: just a bot check
  await sleep(2000); // reloads every 250 ms: > 5 navigations to the same page
  for (const [tool, args] of [['read', {}], ['read', { mode: 'text' }], ['screenshot', {}], ['navigate', { url: `${pages.base}/loop` }]]) {
    const r = await c.call(tool, { session: s, ...args });
    assert.equal(r.isError, true, `${tool}: ${r.text}`);
    assert.match(r.text, LOOP, tool);
  }
  // Leaving the loop: a normal page reads fine again.
  const r = await c.call('navigate', { session: s, url: `${pages.base}/` });
  assert.equal(r.isError, false, r.text);
  assert.equal((await c.call('read', { session: s, mode: 'text' })).isError, false);
  await c.close();
});

test('a page that reloads itself but is no bot check is not reported', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/reloader` });
  await sleep(2000);
  let ok = 0;
  for (let i = 0; i < 4; i++) {
    const r = await c.call('read', { session: s, mode: 'text' });
    assert.ok(!LOOP.test(r.text), r.text);
    if (!r.isError) ok++;
  }
  assert.ok(ok > 0);
  await c.close();
});

test('page tools failing again and again with "Execution context was destroyed" report the loop', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/` });
  const page = svc.manager.sessions.get(s).page;
  const real = page.frames.bind(page);
  page.frames = () => [{ evaluate: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation'); }, isDetached: () => false }];
  const texts = [];
  for (let i = 0; i < 3; i++) texts.push((await c.call('read', { session: s })).text);
  assert.doesNotMatch(texts[0], LOOP);
  assert.match(texts[2], LOOP);
  page.frames = real;
  await c.close();
});

test('the navigation history is forgotten when a handoff ends (the human may have solved the check)', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/` });
  const sess = svc.manager.sessions.get(s);
  for (let i = 0; i < 8; i++) sess.navs.push({ t: Date.now(), at: `${pages.base}/` });
  sess.ctxErrors.push(Date.now(), Date.now());
  const link = (await c.call('request_human', { session: s, reason: 'x' })).json().link;
  const { viewer } = await import('./helpers.mjs');
  const v = await viewer(link);
  v.ws.send(JSON.stringify({ type: 'done' }));
  assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'human-done');
  assert.deepEqual([sess.navs.length, sess.ctxErrors.length], [0, 0]);
  await c.close();
});
