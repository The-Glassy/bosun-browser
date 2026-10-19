// Keepalive + watch: a value read on each visit (count or text), baseline, change events, what is stored; the
// every_minutes / quiet_hours schedule; http(s)-only URLs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { startBosun, connect, tmpDir, sleep } from './helpers.mjs';
import { nextRun, advance, parseQuiet, extractWatch, watchChanged } from '../src/keepalive.mjs';
import { loadConfig } from '../src/config.mjs';

// A site with a cookie login and an inbox: "<n> neue Nachrichten" in the header while n > 0 (the badge is gone at 0),
// and a status line. The test changes both between visits.
function startSite() {
  const state = { count: 43, status: 'Paket   unterwegs', loads: 0, body: '' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = (b, h = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...h }); res.end(b); };
    if (u.pathname === '/do-login') return html('<title>ok</title>logged in', { 'set-cookie': 'sid=alice; Path=/; Max-Age=86400' });
    if (u.pathname === '/signin') return html('<title>Sign in</title><form><input name="user"></form>');
    if (u.pathname === '/inbox') {
      state.loads++;
      if (!(req.headers.cookie || '').includes('sid=alice')) { res.writeHead(302, { location: '/signin' }); return res.end(); }
      return html(`<title>Inbox</title><header><span id="who">Mein Konto</span>
        ${state.count ? `<a id="badge" href="/inbox"><b>${state.count.toLocaleString('de-AT')}</b> neue Nachrichten</a>` : ''}</header>
        <p id="status">${state.status}</p><main>${state.body || '<p>Private message from Anna: the flat is still available.</p>'.repeat(30)}</main>`);
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${srv.address().port}`, state, close: () => new Promise((d) => { srv.close(d); srv.closeAllConnections(); }) })));
}

let site;
before(async () => { site = await startSite(); });
after(async () => { await site.close(); });

const FAST = { tickMs: 3_600_000, gapMs: [0, 0], activityMs: [300, 500] };

async function withService(fn, { env = {}, dataDir } = {}) {
  const seen = { watch: [], human: [] };
  const svc = await startBosun({ KEEPALIVE: '0', ...(dataDir ? { BROWSER_DATA: dataDir } : {}), ...env }, { keepalive: FAST });
  svc.events.on('watch-changed', (e) => seen.watch.push(e));
  svc.events.on('needs-human', (e) => seen.human.push(e));
  try { return await fn(svc, seen); } finally { if (dataDir) await svc.shutdown(); else await svc.stop(); }
}

async function loggedInProfile(svc, profile = 'wh') {
  const c = await connect(svc);
  const s = await c.open({ profile });
  assert.equal((await c.call('navigate', { session: s, url: `${site.base}/do-login` })).isError, false);
  await c.call('session_close', { session: s });
  return c;
}

const due = (svc, profile = 'wh') => { svc.keepalive.store.entries.get(`alice/${profile}`).nextAt = Date.now() - 1000; };
const visit = async (svc, profile) => { due(svc, profile); return svc.keepalive.tick(); };
const COUNT = { text_regex: '(\\d+) neue Nachrichten', kind: 'count', label: 'willhaben messages' };
const setWatch = (c, watch = COUNT, extra = {}) => c.call('keepalive_set', { profile: 'wh', url: `${site.base}/inbox`, logged_in_check: { selector: '#who' }, watch, ...extra });

test('watch count: the first visit records a baseline, a rise is exactly one event, the same or a lower count none; it survives a restart', async () => {
  const dataDir = tmpDir();
  site.state.count = 43;
  try {
    await withService(async (svc, seen) => {
      const c = await loggedInProfile(svc);
      const r = await setWatch(c);
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(r.json().watch, { text_regex: COUNT.text_regex, kind: 'count', label: 'willhaben messages', value: null, baseline: 'not read yet' });
      assert.deepEqual(await visit(svc), { status: 'ok', reason: null, watch: 'baseline' });
      assert.deepEqual(seen.watch, []);
      const [v] = (await c.call('keepalive_list')).json();
      assert.equal(v.watch.value, 43);
      assert.equal(v.watch.changed_at, null);
      assert.equal(v.last[0].watch, 'baseline');
      assert.equal((await visit(svc)).watch, 'unchanged');
      await c.close();
    }, { dataDir });
    // Only the value is stored: nothing else from the page.
    const stored = fs.readFileSync(path.join(dataDir, 'keepalive.json'), 'utf8');
    assert.match(stored, /"value": 43/);
    for (const s of ['neue Nachrichten</', 'Anna', 'Mein Konto', 'unterwegs']) assert.ok(!stored.includes(s), s);
    site.state.count = 45;
    await withService(async (svc, seen) => {
      const c = await connect(svc);
      assert.equal((await visit(svc)).watch, 'changed'); // against the baseline from before the restart
      await sleep(50);
      assert.deepEqual(seen.watch, [{ tenant: 'alice', profile: 'wh', label: 'willhaben messages', old: 43, new: 45, url: `${site.base}/inbox` }]);
      assert.equal((await visit(svc)).watch, 'unchanged'); // still 45: no second event
      site.state.count = 0; // all read: the badge is gone
      assert.equal((await visit(svc)).watch, 'lower');
      site.state.count = 2; // two new ones, counted from 0
      assert.equal((await visit(svc)).watch, 'changed');
      site.state.count = 120;
      assert.equal((await visit(svc)).watch, 'changed');
      await sleep(50);
      assert.deepEqual(seen.watch.map((e) => [e.old, e.new]), [[43, 45], [0, 2], [2, 120]]);
      const [v] = (await c.call('keepalive_list')).json();
      assert.equal(v.watch.value, 120);
      assert.ok(Date.parse(v.watch.changed_at) > Date.now() - 60_000);
      assert.deepEqual(seen.human, []);
      await c.close();
    }, { dataDir });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
    site.state.count = 43;
  }
});

test('watch text by selector: whitespace collapsed, at most 200 chars, an event when it differs; changing what is watched starts a new baseline', async () => {
  await withService(async (svc, seen) => {
    const c = await loggedInProfile(svc);
    const status = { selector: '#status', kind: 'text', label: 'parcel' };
    await setWatch(c, status);
    site.state.status = 'Paket   unterwegs';
    assert.equal((await visit(svc)).watch, 'baseline');
    assert.equal((await c.call('keepalive_list')).json()[0].watch.value, 'Paket unterwegs');
    site.state.status = 'Zugestellt ' + 'x'.repeat(300);
    assert.equal((await visit(svc)).watch, 'changed');
    await sleep(50);
    assert.equal(seen.watch.length, 1);
    assert.equal(seen.watch[0].old, 'Paket unterwegs');
    assert.equal(seen.watch[0].new.length, 200);
    // A new label keeps the baseline; another selector or kind does not.
    await setWatch(c, { ...status, label: 'DHL parcel' });
    assert.equal((await c.call('keepalive_list')).json()[0].watch.value.length, 200);
    await setWatch(c, { selector: '#badge', kind: 'count', label: 'badge' });
    assert.equal((await c.call('keepalive_list')).json()[0].watch.value, null);
    assert.equal((await visit(svc)).watch, 'baseline');
    assert.equal((await c.call('keepalive_list')).json()[0].watch.value, 43);
    // Without a watch nothing is read or reported.
    await c.call('keepalive_set', { profile: 'wh', url: `${site.base}/inbox`, logged_in_check: { selector: '#who' } });
    const r = await visit(svc);
    assert.deepEqual(r, { status: 'ok', reason: null });
    assert.equal((await c.call('keepalive_list')).json()[0].watch, undefined);
    assert.equal(seen.watch.length, 1);
    await c.close();
  });
  site.state.status = 'Paket   unterwegs';
});

test('watch is read only when logged in; a failed read is a category and keeps the baseline', async () => {
  await withService(async (svc, seen) => {
    const c = await loggedInProfile(svc);
    await setWatch(c, { selector: '#status', text_regex: 'Paket\\s+(\\w+)', kind: 'count', label: 'n' });
    assert.deepEqual(await visit(svc), { status: 'ok', reason: null, watch: 'no number in the watched text' });
    assert.equal((await c.call('keepalive_list')).json()[0].watch.value, null);
    // Logged out (the check fails): no watch read at all.
    await c.call('keepalive_set', { profile: 'wh', url: `${site.base}/inbox`, logged_in_check: { text: 'Kein solcher Text' }, watch: COUNT });
    const r = await visit(svc);
    assert.equal(r.status, 'logged_out');
    assert.equal(r.watch, undefined);
    assert.deepEqual(seen.watch, []);
    assert.equal(seen.human.length, 1);
    await c.close();
  });
});

test('a runaway watch regex is cut off in the page; the service stays responsive', async () => {
  site.state.body = `<p>${'a'.repeat(40)}!</p>`;
  try {
    await withService(async (svc) => {
      const c = await loggedInProfile(svc);
      await setWatch(c, { text_regex: '(a+)+$', kind: 'text', label: 'redos' });
      let lag = 0, last = Date.now();
      const probe = setInterval(() => { lag = Math.max(lag, Date.now() - last - 50); last = Date.now(); }, 50);
      const t0 = Date.now();
      const r = await visit(svc).finally(() => clearInterval(probe));
      assert.equal(r.status, 'ok');
      assert.ok(['watch timeout', 'baseline'].includes(r.watch), r.watch); // an engine may bail out by itself
      assert.ok(Date.now() - t0 < 40_000);
      assert.ok(lag < 1000, `event loop blocked ${lag} ms`);
      assert.equal(svc.manager.used, 0);
      await c.close();
    });
  } finally {
    site.state.body = '';
  }
});

test('extractWatch and watchChanged on their own', async () => {
  const page = (text, sel = {}) => ({
    locator: (s) => {
      const l = {
        waitFor: async () => { if (s !== 'body' && !(s in sel)) throw new Error('timeout'); },
        evaluate: async (fn, args) => fn(s === 'body' ? { innerText: text } : { textContent: sel[s] }, args),
      };
      return { ...l, first: () => l };
    },
  });
  assert.equal(await extractWatch(page('Hallo 43 neue Nachrichten'), { textRegex: '(\\d+) neue', kind: 'count' }), 43);
  assert.equal(await extractWatch(page('Hallo'), { textRegex: '(\\d+) neue', kind: 'count' }), 0);
  assert.equal(await extractWatch(page('x', { '#b': ' 1.234 567 ' }), { selector: '#b', kind: 'count' }), 1234567);
  assert.equal(await extractWatch(page('x'), { selector: '#gone', kind: 'count', label: 'l' }, { timeoutMs: 10 }), 0);
  assert.equal(await extractWatch(page('x'), { selector: '#gone', kind: 'text' }, { timeoutMs: 10 }), null);
  assert.equal(await extractWatch(page('Status:\n  versandt\t heute'), { textRegex: 'Status:\\s+(.+)', kind: 'text' }), 'versandt heute');
  await assert.rejects(extractWatch(page('keine'), { textRegex: 'keine', kind: 'count' }), /no number/);
  assert.equal(watchChanged('count', 3, 4), true);
  assert.equal(watchChanged('count', 4, 3), false);
  assert.equal(watchChanged('text', 'a', 'b'), true);
  assert.equal(watchChanged('text', null, 'b'), true);
  assert.equal(watchChanged('text', 'a', 'a'), false);
});

test('schedule: every_minutes (at least 30), jitter kept, quiet hours stretch the interval x4 in TZ (default Europe/Vienna)', () => {
  const tz = 'Europe/Vienna';
  const at = (s) => Date.parse(s);
  const t = at('2026-10-19T12:00:00+02:00');
  assert.equal(nextRun(t, { everyMinutes: 30, jitterMin: 0 }, () => 0.5, tz), t + 30 * 60_000);
  assert.equal(nextRun(t, { everyMinutes: 45, jitterMin: 10 }, () => 1, tz), t + 55 * 60_000);
  const spread = new Set(Array.from({ length: 200 }, () => nextRun(t, { everyMinutes: 60, jitterMin: 15 }, Math.random, tz) - t));
  assert.ok(spread.size > 150 && [...spread].every((d) => d >= 45 * 60_000 && d <= 75 * 60_000));
  const q = { everyMinutes: 30, jitterMin: 0, quietHours: '22-08' };
  // Outside quiet hours: unchanged. Inside: x4. Across the edge: piecewise.
  assert.equal(nextRun(t, q, () => 0.5, tz), t + 30 * 60_000);
  assert.equal(nextRun(at('2026-10-19T23:00:00+02:00'), q, () => 0.5, tz), at('2026-10-20T01:00:00+02:00'));
  assert.equal(nextRun(at('2026-10-19T21:50:00+02:00'), q, () => 0.5, tz), at('2026-10-19T23:20:00+02:00'));
  assert.equal(nextRun(at('2026-10-20T07:20:00+02:00'), q, () => 0.5, tz), at('2026-10-20T08:20:00+02:00'));
  // A whole night with a 30 min interval: 4 visits between 22 and 8 instead of 20.
  let n = 0;
  for (let x = at('2026-10-19T22:00:00+02:00'); x < at('2026-10-20T08:00:00+02:00'); x = nextRun(x, q, () => 0.5, tz)) n++;
  assert.equal(n, 5); // 22:00, 00:00, 02:00, 04:00, 06:00
  // The same instant is quiet in Vienna but not in New York (16:00 there).
  assert.equal(nextRun(at('2026-10-19T22:00:00+02:00'), q, () => 0.5, 'America/New_York'), at('2026-10-19T22:30:00+02:00'));
  // Every hours, and a non-wrapping window.
  assert.equal(nextRun(t, { everyHours: 12, jitterMin: 0, quietHours: '01:30-05' }, () => 0.5, tz), at('2026-10-20T00:00:00+02:00'));
  assert.equal(advance(at('2026-10-20T01:00:00+02:00'), 60 * 60_000, parseQuiet('01:30-05'), tz), at('2026-10-20T03:30:00+02:00'));
  for (const bad of ['8-8', '25-03', '22-08:60', 'night', '']) assert.throws(() => parseQuiet(bad), /quiet_hours/, bad);
  assert.equal(loadConfig({}).tz, 'Europe/Vienna');
  assert.equal(loadConfig({ TZ: 'UTC' }).tz, 'UTC');
  assert.throws(() => loadConfig({ TZ: 'Mars/Olympus' }), /TZ must be an IANA time zone/);
});

test('keepalive_set: every_minutes / every_hours / quiet_hours / watch validation and what keepalive_list shows', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    const base = { profile: 'wh', url: `${site.base}/inbox`, logged_in_check: { selector: '#who' } };
    const bad = [
      [{ every_minutes: 29 }, /every_minutes|>=30|too_small/i],
      [{ every_minutes: 60, every_hours: 2 }, /not both/],
      [{ every_minutes: 30, jitter_min: 16 }, /jitter_min must be at most half of the interval \(30 min\)/],
      [{ quiet_hours: '22' }, /quiet_hours must look like/],
      [{ watch: { kind: 'count', label: 'x' } }, /watch needs selector or text_regex/],
      [{ watch: { text_regex: '(unclosed', kind: 'count', label: 'x' } }, /not a valid regular expression/],
      [{ watch: { selector: '#b', kind: 'number', label: 'x' } }, /kind/],
      [{ watch: { selector: '#b', kind: 'count' } }, /label/],
    ];
    for (const [args, re] of bad) assert.match((await c.call('keepalive_set', { ...base, ...args })).text, re, JSON.stringify(args));
    const t0 = Date.now();
    const v = (await c.call('keepalive_set', { ...base, every_minutes: 30, quiet_hours: '22-08' })).json();
    assert.deepEqual([v.every_minutes, v.every_hours, v.jitter_min, v.quiet_hours, v.tz], [30, undefined, 7, '22-08', 'Europe/Vienna']);
    const next = Date.parse(v.next_run) - t0;
    assert.ok(next >= 23 * 60_000 - 1000 && next <= 4 * 37 * 60_000 + 1000, String(next));
    const h = (await c.call('keepalive_set', { ...base, every_hours: 2 })).json();
    assert.deepEqual([h.every_hours, h.every_minutes, h.jitter_min, h.quiet_hours], [2, undefined, 30, undefined]);
    // An agent with the profile open: the visit is skipped, also on a minutes schedule.
    await c.call('keepalive_set', { ...base, every_minutes: 30 });
    const s = await c.open({ profile: 'wh' });
    assert.deepEqual(await visit(svc), { skipped: 'profile in use' });
    await c.call('session_close', { session: s });
    await c.close();
  });
});

test('URLs are http(s) only: keepalive_set (tool and core), navigate; a stored non-web URL is never visited', async () => {
  await withService(async (svc) => {
    const c = await loggedInProfile(svc);
    const s = await c.open();
    for (const url of ['file:///etc/passwd', 'data:text/html,<b>x</b>', 'javascript:alert(1)', 'about:blank', 'chrome://version', 'view-source:http://example.com', 'ftp://example.com/', 'blob:http://example.com/x']) {
      const r = await c.call('keepalive_set', { profile: 'wh', url, logged_in_check: { text: 'x' } });
      assert.equal(r.isError, true, url);
      assert.match(r.text, /http|url/i, url);
      assert.throws(() => svc.keepalive.set('alice', { profile: 'wh', url, check: { text: 'x' } }), /http|invalid URL/, url);
      assert.equal((await c.call('navigate', { session: s, url })).isError, true, url);
    }
    assert.deepEqual((await c.call('keepalive_list')).json(), []);
    // A keepalive.json edited by hand: the visit refuses before opening anything.
    assert.equal((await setWatch(c)).isError, false);
    svc.keepalive.store.entries.get('alice/wh').url = 'file:///etc/passwd';
    const loads = site.state.loads;
    const used = svc.manager.used;
    assert.deepEqual(await visit(svc), { status: 'error', reason: 'url is not http(s)' });
    assert.equal(svc.manager.used, used);
    assert.equal(site.state.loads, loads);
    await c.close();
  });
});
