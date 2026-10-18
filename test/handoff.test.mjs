// Handoff guarantees end to end (real Chromium, real live view): the agent is blinded for every page tool, operations
// started before takeover finish before the human gets the tab, the link is one-time, secrets stay masked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, startPageServer, connect, viewer, until, sleep, ENGINE } from './helpers.mjs';

let pages, svc;
before(async () => { pages = await startPageServer(); svc = await startBosun(); });
after(async () => { await svc.stop(); await pages.close(); });

const HANDOFF = /handoff active/;

async function sessionWithHandoff(c, url = `${pages.base}/secret-title`, reason = 'please help') {
  const s = await c.open();
  assert.equal((await c.call('navigate', { session: s, url })).isError, false);
  const r = await c.call('request_human', { session: s, reason });
  assert.equal(r.isError, false, r.text);
  return { s, link: r.json().link, first: r.json() };
}

test('every page tool is refused during a handoff, and nothing leaks URL/title', async () => {
  const c = await connect(svc);
  const { s, link, first } = await sessionWithHandoff(c);
  assert.equal(first.status, 'waiting_for_human');
  assert.ok(!JSON.stringify(first).includes('424242'));
  const calls = [
    ['navigate', { url: `${pages.base}/` }], ['read', {}], ['read', { mode: 'text' }], ['click', { text: 'otp' }],
    ['type', { selector: 'p', value: 'x' }], ['select', { selector: 'p', value: 'x' }], ['press', { key: 'Enter' }],
    ['back', {}], ['wait_for', { text: 'otp page', timeoutMs: 1000 }], ['screenshot', {}], ['screenshot', { fullPage: true }],
  ];
  for (const [tool, args] of calls) {
    const r = await c.call(tool, { session: s, ...args });
    assert.equal(r.isError, true, tool);
    assert.match(r.text, HANDOFF, tool);
    assert.ok(!r.text.includes('424242') && !r.text.includes(pages.base), `${tool} leaked: ${r.text}`);
  }
  const list = await c.call('sessions');
  assert.deepEqual(list.json(), [{ id: s, profile: 'ephemeral', engine: ENGINE, handoff: 'active' }]);
  const w = await c.call('handoff_wait', { session: s, timeoutSec: 1 });
  assert.equal(w.json().status, 'still_waiting');
  assert.ok(!w.text.includes('424242') && !w.text.includes(pages.base), w.text);
  const again = await c.call('request_human', { session: s, reason: 'again' });
  assert.equal(again.json().link, link);

  const v = await viewer(link);
  v.ws.send(JSON.stringify({ type: 'done' }));
  const done = (await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json();
  assert.equal(done.status, 'human-done');
  assert.equal(done.title, 'Code 424242'); // the agent may look again once the human is done
  assert.equal((await c.call('read', { session: s, mode: 'text' })).isError, false);
  await c.close();
});

test('an operation in flight finishes before the handoff starts; later ones are refused', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/late` });
  const order = [];
  const waitP = c.call('wait_for', { session: s, selector: '#late', timeoutMs: 5000 }).then((r) => { order.push('wait_for'); return r; });
  await sleep(50);
  const humanP = c.call('request_human', { session: s, reason: 'x' }).then((r) => { order.push('request_human'); return r; });
  await sleep(50);
  const readP = c.call('read', { session: s }).then((r) => { order.push('read'); return r; });
  const [w, h, rd] = await Promise.all([waitP, humanP, readP]);
  assert.equal(w.isError, false, w.text);
  assert.equal(h.isError, false, h.text);
  assert.equal(rd.isError, true);
  assert.match(rd.text, HANDOFF);
  assert.deepEqual(order.slice(0, 2), ['wait_for', 'request_human']);
  await c.close();
});

test('the live-view link reopens while the handoff runs, one viewer at a time, and is dead after it', async () => {
  const c = await connect(svc);
  const { s, link } = await sessionWithHandoff(c, `${pages.base}/`);
  // GETs (e.g. link previews) don't consume it.
  for (let i = 0; i < 2; i++) assert.equal((await fetch(link)).status, 200);
  const v1 = await viewer(link);
  await until(() => v1.key && v1.frames > 0);
  // A second viewer while the first is connected is turned away (it may retry), whatever key it guesses.
  for (const key of [undefined, 'f'.repeat(32)]) {
    const busy = await viewer(link, { key });
    await until(() => busy.closed);
    assert.equal(busy.closeCode, 4409);
  }
  await assert.rejects(viewer(link, { key: v1.key, origin: 'https://evil.example' }), /HTTP 403/);
  const v2 = await viewer(link, { key: v1.key }); // the same tab reconnecting replaces its old socket at once
  await until(() => v1.closed);
  await until(() => v2.frames > 0);
  // The phone closes the in-app browser; opening the same link again works, and shows the page at once.
  v2.ws.close();
  await until(() => v2.closed);
  const t0 = Date.now();
  const v3 = await viewer(link);
  await until(() => v3.frames > 0, 1000);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(v3.closed, false);
  v3.ws.send(JSON.stringify({ type: 'giveup' }));
  assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'human-gave-up');
  await until(() => v3.closed);
  // Finished: no replay, with or without a key.
  assert.equal((await fetch(link)).status, 404);
  await assert.rejects(viewer(link), /HTTP 404/);
  await assert.rejects(viewer(link, { key: v3.key }), /HTTP 404/);
  await c.close();
});

test('a static page keeps getting frames during a handoff', async () => {
  const c = await connect(svc);
  const { link } = await sessionWithHandoff(c, `${pages.base}/second`);
  const v = await viewer(link);
  await until(() => v.frames > 0);
  const n = v.frames;
  await sleep(4500);
  assert.ok(v.frames >= n + 2, `frames ${n} -> ${v.frames}`);
  await c.close();
});

test('the reason is HTML-escaped and the page carries a strict CSP', async () => {
  const c = await connect(svc);
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
  const { link } = await sessionWithHandoff(c, `${pages.base}/`, evil);
  const res = await fetch(link);
  const html = await res.text();
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp;'));
  assert.ok(!html.includes('<img'));
  assert.equal(html.match(/<script/g).length, 1);
  const csp = res.headers.get('content-security-policy');
  const nonce = /'nonce-([^']+)'/.exec(csp)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  await c.close();
});

test('what the human types into a password field is masked afterwards', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/login` });
  await c.call('click', { session: s, selector: '#pw' });
  const link = (await c.call('request_human', { session: s, reason: 'log in' })).json().link;
  const v = await viewer(link);
  await until(() => v.frames > 0);
  v.ws.send(JSON.stringify({ type: 'text', text: 'Hunter2-Secret' }));
  await sleep(300);
  v.ws.send(JSON.stringify({ type: 'done' }));
  assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'human-done');
  const page = svc.manager.sessions.get(s).page;
  assert.equal(await page.$eval('#pw', (e) => e.value), 'Hunter2-Secret');
  for (const mode of ['a11y', 'text']) {
    const r = await c.call('read', { session: s, mode });
    assert.ok(!r.text.includes('Hunter2-Secret'), r.text);
  }
  assert.match((await c.call('read', { session: s })).text, /textbox "Password"(?: \[[^\]]*\])*: \[masked\]/);
  // Revealed-password toggles (type=password -> text) stay masked.
  await page.$eval('#pw', (e) => { e.type = 'text'; });
  assert.ok(!(await c.call('read', { session: s })).text.includes('Hunter2-Secret'));
  // Sensitive fields found by type/autocomplete/label, not only by the label wording.
  for (const [sel, val] of [['#unnamed', 'unnamed-secret'], ['#pin', '4711'], ['#mdp', 'mdp-secret'], ['#otp', '123456']]) {
    await c.call('type', { session: s, selector: sel, value: val });
    assert.ok(!(await c.call('read', { session: s })).text.includes(val), sel);
  }
  await c.call('type', { session: s, selector: '#note', value: 'harmless note' });
  assert.match((await c.call('read', { session: s })).text, /harmless note/);
  const shot = await c.call('screenshot', { session: s });
  assert.equal(shot.isError, false, shot.text);
  assert.equal(await page.$$eval('[data-bosun-sensitive]', (els) => els.length), 0); // mask markers removed again
  await c.close();
});

test('giving up (or timeout) clears half-typed credentials before the agent resumes', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/login` });
  await c.call('click', { session: s, selector: '#pw' });
  const link = (await c.call('request_human', { session: s, reason: 'log in' })).json().link;
  const v = await viewer(link);
  await until(() => v.frames > 0);
  v.ws.send(JSON.stringify({ type: 'text', text: 'half-typed' }));
  await sleep(300);
  v.ws.send(JSON.stringify({ type: 'giveup' }));
  assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'human-gave-up');
  const page = svc.manager.sessions.get(s).page;
  assert.equal(await page.$eval('#pw', (e) => e.value), '');

  const ttl = svc.manager.cfg.handoffTtlMs;
  svc.manager.cfg.handoffTtlMs = 300;
  try {
    const r = (await c.call('request_human', { session: s, reason: 'again' })).json();
    assert.ok(r.link);
    assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'handoff-timeout');
    assert.equal((await fetch(r.link)).status, 404);
  } finally {
    svc.manager.cfg.handoffTtlMs = ttl;
  }
  await c.close();
});

test('request_human wait=true returns once the human is done', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/` });
  const p = c.call('request_human', { session: s, reason: 'x', wait: true });
  const link = await until(() => svc.manager.sessions.get(s).handoff?.url);
  const v = await viewer(link);
  v.ws.send(JSON.stringify({ type: 'done' }));
  const r = (await p).json();
  assert.equal(r.status, 'human-done');
  assert.equal(r.title, 'Home');
  await c.close();
});

test('closing the session (or disconnecting) cancels its handoff', async () => {
  const c = await connect(svc);
  const { s, link } = await sessionWithHandoff(c, `${pages.base}/`);
  const v = await viewer(link);
  const before = svc.live.size;
  await c.call('session_close', { session: s });
  await until(() => v.closed);
  assert.equal(svc.live.size, before - 1);
  assert.equal((await fetch(link)).status, 404);

  const { link: link2 } = await sessionWithHandoff(c, `${pages.base}/`);
  await c.close();
  await until(async () => (await fetch(link2)).status === 404);
});

test('handoff_wait honours cancellation and clears its timer', async () => {
  const c = await connect(svc);
  const { s } = await sessionWithHandoff(c, `${pages.base}/`);
  const owner = svc.manager.sessions.get(s).owner;
  const ac = new AbortController();
  const p = svc.manager.waitHandoff(owner, s, 60_000, ac.signal);
  ac.abort();
  await assert.rejects(p, /cancelled/);
  // Same through MCP: a client-side abort sends notifications/cancelled.
  const ac2 = new AbortController();
  const r = c.call('handoff_wait', { session: s, timeoutSec: 30 }, { signal: ac2.signal });
  await sleep(100);
  ac2.abort();
  assert.equal((await r).isError, true);
  assert.equal((await c.call('sessions')).isError, false);
  await c.close();
});

test('a password field the page reveals while it is still parsing stays masked (init-script tracker)', { skip: ENGINE === 'patchright' && 'patchright gets the tracker just after navigation, not at document start' }, async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/toggle` });
  const page = svc.manager.sessions.get(s).page;
  assert.equal(await page.$eval('#t', (e) => e.type), 'text');
  const r = await c.call('read', { session: s });
  assert.equal(r.isError, false, r.text);
  assert.ok(!r.text.includes('pre-scan-toggled'), r.text);
  await c.close();
});

test('inputs labelled inside an open shadow root are detected (mask, clear)', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/shadow` });
  await c.call('type', { session: s, selector: '#s', value: '8642' });
  const { sensitiveValues, clearSensitive } = await import('../src/redact.mjs');
  const page = svc.manager.sessions.get(s).page;
  assert.deepEqual(await sensitiveValues(page), ['8642']);
  assert.ok(!(await c.call('read', { session: s })).text.includes('8642'));
  await clearSensitive(page);
  assert.equal(await page.locator('#s').inputValue(), '');
  await c.close();
});

test('if credential clearing fails after give-up, the session is closed instead of resumed', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/login` });
  const link = (await c.call('request_human', { session: s, reason: 'x' })).json().link;
  const page = svc.manager.sessions.get(s).page;
  page.frames = () => [{ evaluate: async () => { throw new Error('Execution context was destroyed'); }, isDetached: () => false }];
  const v = await viewer(link);
  v.ws.send(JSON.stringify({ type: 'giveup' }));
  await until(() => !svc.manager.sessions.has(s));
  assert.match((await c.call('handoff_wait', { session: s })).text, /no session \S+ \(closed: handoff-cleanup-failed\)/);
  assert.match((await c.call('read', { session: s })).text, /closed: handoff-cleanup-failed/);
  await c.close();
});

test('read/screenshot fail closed when a frame cannot be inspected', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/login` });
  const page = svc.manager.sessions.get(s).page;
  const real = page.frames.bind(page);
  page.frames = () => [...real(), { evaluate: async () => { throw new Error('boom'); }, isDetached: () => false, locator: (x) => real()[0].locator(x) }];
  for (const [tool, args] of [['read', {}], ['read', { mode: 'text' }], ['screenshot', {}]]) {
    const r = await c.call(tool, { session: s, ...args });
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /could not inspect a frame/, tool);
  }
  page.frames = real;
  await c.close();
});

test('a password the human types and then reveals (show-password) stays masked after Done', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/login` });
  await c.call('click', { session: s, selector: '#unnamed' }); // type=password, no label/name/id hints
  const link = (await c.call('request_human', { session: s, reason: 'log in' })).json().link;
  const v = await viewer(link);
  await until(() => v.frames > 0);
  v.ws.send(JSON.stringify({ type: 'text', text: 'Revealed-Secret-1' }));
  await sleep(700); // at least one note poll
  const page = svc.manager.sessions.get(s).page;
  await page.$eval('#unnamed', (e) => { e.type = 'text'; }); // the human pressed "show password"
  v.ws.send(JSON.stringify({ type: 'done' }));
  assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'human-done');
  assert.equal(await page.$eval('#unnamed', (e) => e.type), 'text');
  for (const mode of ['a11y', 'text']) assert.ok(!(await c.call('read', { session: s, mode })).text.includes('Revealed-Secret-1'), mode);
  await c.close();
});

test('the page cannot see Bosun\'s tracker on stealth engines', { skip: ENGINE === 'chromium' && 'plain Chromium evaluates in the page world' }, async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/probe` });
  const { sensitiveValues } = await import('../src/redact.mjs');
  const page = svc.manager.sessions.get(s).page;
  await sensitiveValues(page); // Bosun has scanned
  await c.call('click', { session: s, selector: '#check' });
  const r = await c.call('read', { session: s, mode: 'text' });
  assert.match(r.text, /syms=\[\] shadow=native/, r.text);
  await c.close();
});

for (const [page, secret] of [['/toggle-later', 'pre-scan-toggled'], ['/dshadow', 'decl-shadow-secret']]) {
  test(`a password field the page reveals before any scan stays masked (${page})`, async () => {
    const c = await connect(svc);
    const s = await c.open();
    await c.call('navigate', { session: s, url: `${pages.base}${page}` }); // navigate waits 1.2 s: the toggle has run
    const r = await c.call('read', { session: s });
    assert.equal(r.isError, false, r.text);
    assert.ok(!r.text.includes(secret), r.text);
    await c.close();
  });
}

test('a password field created and revealed between two polls during a handoff stays masked', async () => {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${pages.base}/` });
  const link = (await c.call('request_human', { session: s, reason: 'x' })).json().link;
  const page = svc.manager.sessions.get(s).page;
  await page.evaluate(() => { const i = document.createElement('input'); i.type = 'password'; i.value = 'between-polls'; document.body.append(i); i.type = 'text'; });
  const v = await viewer(link);
  v.ws.send(JSON.stringify({ type: 'done' }));
  assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'human-done');
  assert.ok(!(await c.call('read', { session: s })).text.includes('between-polls'));
  await c.close();
});
