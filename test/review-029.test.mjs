// Regression tests for the 0.29 review fixes (REVIEW.md): one test per finding that was fixed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serialize } from 'node:v8';
import { test } from 'node:test';
import { parseHostPattern } from '../src/allow.mjs';
import { loadConfig } from '../src/config.mjs';
import { Keepalive } from '../src/keepalive.mjs';
import { checkMacro, runMacro } from '../src/macros.mjs';
import { Meetings } from '../src/meetings/index.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { startTenantProxy } from '../src/proxy.mjs';
import { workerConfig } from '../src/tenant-sandbox.mjs';
import { connect, sleep, startBosun, startPageServer, tmpDir, TOKEN, until } from './helpers.mjs';
import { fakeAudio, startFakeMeet } from './fakemeet.mjs';

// An origin that answers every request with the raw bytes given (or by fn(socket)).
async function rawOrigin(answer) {
  const srv = net.createServer((s) => { s.on('error', () => {}); s.once('data', () => (typeof answer === 'function' ? answer(s) : s.end(answer))); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}
function viaProxy(p, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const out = { status: null, body: '', ended: false, closed: false, error: null };
    const done = () => { out.ms = Date.now() - t0; resolve(out); };
    const req = http.request({ host: '127.0.0.1', port: p.port, path: `http://127.0.0.1:${port}/x`,
      headers: { 'proxy-authorization': `Basic ${Buffer.from(`${p.username}:${p.password}`).toString('base64')}`, host: `127.0.0.1:${port}` } }, (res) => {
      out.status = res.statusCode;
      res.on('data', (d) => { out.body += d; });
      res.on('end', () => { out.ended = true; });
      res.on('error', (e) => { out.error = e.code || e.message; });
      res.on('close', () => { out.closed = true; done(); });
    });
    req.on('error', (e) => { out.error = e.code || e.message; done(); });
    req.setTimeout(4000, () => { out.error = 'still waiting after 4 s'; req.destroy(); });
    req.end();
  });
}

test('tenant proxy: a response the origin malformed ends that response, not the service (P1)', async (t) => {
  const answers = {
    reason: 'HTTP/1.1 200 O\x01K\r\nContent-Length: 2\r\n\r\nhi',
    unicode: 'HTTP/1.1 200 ä中\r\nContent-Length: 2\r\n\r\nhi',
    header: 'HTTP/1.1 200 OK\r\nX-A: a\x01b\r\nContent-Length: 2\r\n\r\nhi',
    fine: 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi',
  };
  const origins = {};
  for (const [k, v] of Object.entries(answers)) origins[k] = await rawOrigin(Buffer.from(v, 'latin1'));
  const p = await startTenantProxy({ tenant: 't', allow: Object.values(origins).map((o) => parseHostPattern(`127.0.0.1:${o.port}`)), log: () => {} });
  t.after(async () => { await p.close(); await Promise.all(Object.values(origins).map((o) => o.close())); });
  // Before the fix the first of these threw ERR_INVALID_CHAR inside the proxy's response callback: an uncaught
  // exception, so the whole process (and every tenant's sessions) went down.
  const reason = await viaProxy(p, origins.reason.port);
  assert.deepEqual([reason.status, reason.body], [200, 'hi'], 'the reason phrase is dropped, the response is served');
  const unicode = await viaProxy(p, origins.unicode.port);
  assert.ok(unicode.status === 200 || unicode.status === 502, JSON.stringify(unicode));
  const header = await viaProxy(p, origins.header.port);
  assert.ok(header.status === 502 || header.status === 200, JSON.stringify(header));
  assert.deepEqual([(await viaProxy(p, origins.fine.port)).status], [200], 'the proxy still serves');
});

test('tenant proxy: an origin that stops in the middle of a body ends the request instead of hanging it (P2)', async (t) => {
  const cut = (head) => rawOrigin((s) => { s.write(head); setTimeout(() => s.destroy(), 100); });
  const length = await cut('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nhi');
  const chunked = await cut('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhi\r\n');
  const p = await startTenantProxy({ tenant: 't', allow: [length, chunked].map((o) => parseHostPattern(`127.0.0.1:${o.port}`)), log: () => {} });
  t.after(async () => { await p.close(); await length.close(); await chunked.close(); });
  for (const o of [length, chunked]) {
    const r = await viaProxy(p, o.port);
    assert.equal(r.status, 200);
    assert.ok(r.closed && !r.ended && r.ms < 3000, `the client is told at once: ${JSON.stringify(r)}`);
  }
});

function keepaliveFixture(t, { tokens, policies = new Map(), wall = async () => null, visitMaxMs } = {}) {
  const dataDir = tmpDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  for (const tenant of ['alice', 'ghost', 'swarm']) {
    fs.mkdirSync(path.join(dataDir, 'profiles', tenant, 'p'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'profiles', tenant, 'p', 'bosun-profile.json'), JSON.stringify({ family: 'chromium', engine: 'chromium', headless: true }));
  }
  const state = { now: Date.now(), opened: [], disposed: [] };
  const page = { goto: async () => null, waitForLoadState: async () => {}, url: () => 'https://x.example/' };
  const manager = { profilesInUse: new Set(), used: 0, tenantUse: new Map(), preemptible: new Map(), closing: false, checkAllowed: (_t, u) => u,
    open: async (o) => { state.opened.push(o.tenant); return { id: `s${state.opened.length}` }; }, run: async (_o, _id, fn) => fn({ page }),
    dispose: async (s, why) => { state.disposed.push([s.id, why]); } };
  const cfg = { dataDir, headless: true, engine: 'chromium', maxSessions: 3, maxSessionsPerTenant: 2, tokens, policies };
  const ka = new Keepalive({ cfg, manager, now: () => state.now, gapMs: [0, 0], activityMs: [1, 1], wall, ...(visitMaxMs ? { visitMaxMs } : {}) });
  return { ka, state };
}

test('keepalive: a page that stops answering ends its visit; the next one still runs (P2)', async (t) => {
  // page.title() on a page stuck in a script never settles: that is what the bot-check look does first.
  const { ka, state } = keepaliveFixture(t, { tokens: [{ tenant: 'alice', token: 'x' }], wall: () => new Promise(() => {}), visitMaxMs: 150 });
  assert.equal(new Keepalive({ cfg: ka.cfg, manager: ka.manager }).visitMaxMs, 45_000 + 15_000 + 60_000 + 60_000, 'the default: navigation, load, the longest activity, a minute');
  ka.set('alice', { profile: 'p', url: 'https://x.example/', everyMinutes: 30, check: { text: 'ok' } });
  state.now += 40 * 60_000;
  const visit = ka.tick();
  await sleep(20);
  assert.ok(ka.current, 'a visit is running');
  assert.deepEqual(await visit, { status: 'error', reason: 'visit timed out (the page stopped responding)' });
  assert.deepEqual(state.disposed, [['s1', 'keepalive-timeout']]);
  assert.equal(ka.current, null, 'the slot is free again');
  assert.deepEqual(ka.list('alice')[0].last[0].reason, 'visit timed out (the page stopped responding)');
  state.now += 40 * 60_000;
  assert.ok(await ka.tick(), 'the next visit starts');
  await ka.stop();
});

test('keepalive: schedules of a tenant without a token, or a read-only one, are kept but not run (P2)', async (t) => {
  const { ka, state } = keepaliveFixture(t, { tokens: [{ tenant: 'alice', token: 'x' }, { tenant: 'swarm', token: 'y' }], policies: new Map([['swarm', 'ephemeral']]) });
  ka.set('ghost', { profile: 'p', url: 'https://x.example/', everyMinutes: 30, check: { text: 'ok' } }); // its token was removed since
  ka.set('swarm', { profile: 'p', url: 'https://x.example/', everyMinutes: 30, check: { text: 'ok' } }); // made read-only since
  state.now += 24 * 3600_000;
  assert.equal(await ka.tick(), null);
  assert.deepEqual(state.opened, [], "no profile of theirs is opened");
  assert.equal(ka.list('ghost').length, 1, 'the schedule is still there for when the token comes back');
  ka.set('alice', { profile: 'p', url: 'https://x.example/', everyMinutes: 30, check: { text: 'ok' } });
  state.now += 40 * 60_000;
  await ka.tick();
  assert.deepEqual(state.opened, ['alice'], 'a tenant with a token is served as before');
  // Without any token (stdio, local development) every entry is served, as before.
  const local = keepaliveFixture(t, { tokens: [] });
  local.ka.set('ghost', { profile: 'p', url: 'https://x.example/', everyMinutes: 30, check: { text: 'ok' } });
  local.state.now += 40 * 60_000;
  await local.ka.tick();
  assert.deepEqual(local.state.opened, ['ghost']);
  await ka.stop(); await local.ka.stop();
});

test('macro_run progress only grows, also through loops and branches (P3)', async () => {
  const m = { ...checkMacro({ name: 'm', site: ['example.org'], steps: [
    { tool: 'repeat', while: { selector: '.next' }, max: 3, steps: [{ tool: 'click', selector: '.next' }, { tool: 'press', key: 'End' }] },
    { tool: 'if_exists', target: { text: 'x' }, then: [{ tool: 'press', key: 'a' }] },
  ] }), version: 1 };
  const seen = [];
  let n = 0;
  const ops = { allowed: () => null, limitOf: () => 60000, url: () => 'https://example.org/', watch: () => ({ seen: () => null, stop() {} }),
    exists: async () => n++ < 2 || n === 4, step: async () => ({ content: [{ type: 'text', text: '{}' }] }), failure: async () => ({}),
    progress: async (done, total) => { seen.push([done, total]); } };
  const out = await runMacro(m, { args: {}, ops });
  assert.equal(out.result.ok, true);
  assert.ok(seen.length >= 5);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][0] > seen[i - 1][0], `progress went ${seen.map((s) => s.join('/')).join(' ')}`);
  assert.ok(seen.every(([done, total]) => total >= done));
});

const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
function meetingFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-rev-'));
  const cfg = { ...loadConfig({ ALLOW_NO_TOKEN: '1' }), dataDir, maxSessions: 100, maxSessionsPerTenant: 100 };
  const recorders = [], chat = [], events = [], sent = [];
  const page = { goto: async () => {}, keyboard: { press: async () => {} } };
  const platform = { name: 'meet', lobby: async () => 'admitted', state: async () => 'admitted', participants: async () => 3,
    openChat: async () => {}, watchChat: async () => {}, drainChat: async () => chat.splice(0), leave: async () => {}, sendChat: async (_p, text) => { sent.push(text); } };
  let seq = 0;
  const manager = { allowList: () => null, used: 0, tenantUse: new Map(), engines: { get: () => ({ family: 'chromium' }) },
    open: async () => ({ id: `s${++seq}`, page, ctx: { grantPermissions: async () => {} } }), run: async (_o, _i, fn) => fn({ page }), dispose: async (s) => { s.disposed = true; } };
  const audio = { unsupported: async () => null, open: async () => ({ close: async () => {}, record: (file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fake media');
    const done = deferred();
    const rec = { startedAt: Date.now(), audioStartedAt: Date.now(), exited: done.p, error: () => null, stop: async () => { rec.stopped = true; done.resolve(); }, kill: async () => { rec.killed = true; done.resolve(); } };
    recorders.push(rec); return rec; } }) };
  const meetings = new Meetings({ cfg, manager, audio, bus: { meeting: (kind, data) => events.push({ kind, ...data }) }, platformFor: () => platform, pollMs: 10 });
  t.after(async () => { await meetings.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { meetings, recorders, chat, events, sent };
}

test('meetings: an objection still deletes the recording when the deletion marker cannot be written (P2)', async (t) => {
  const f = meetingFixture(t);
  const r = await f.meetings.join('alice', { url: 'https://meet.google.com/abc-defg-hij', leaveOnOptOut: true });
  const m = f.meetings.active.get(r.meeting_id);
  await until(() => !!m.rec);
  const file = m.file;
  assert.ok(fs.existsSync(file));
  // A full disk: the marker cannot be created (its directory entry is taken by something that is not a file).
  fs.mkdirSync(file.replace(/\.ogg$/, '.deleted'));
  const logged = [];
  t.mock.method(console, 'error', (l) => logged.push(String(l)));
  f.chat.push({ id: 'c1', sender: 'Alex', text: 'please do not record me' });
  await until(() => m.state === 'ended');
  await m.finishing;
  assert.equal(f.recorders[0].killed, true, 'the recorder was stopped');
  assert.equal(fs.existsSync(file), false, 'the file is gone');
  assert.equal(m.deleted, true);
  assert.throws(() => f.meetings.recordingGet('alice', m.id), /deleted|no recording/i);
  assert.ok(f.events.some((e) => e.kind === 'optout'), 'the agent hears about the objection');
  assert.ok(!f.events.find((e) => e.kind === 'ended')?.recording, 'no recording is offered');
  assert.ok(logged.some((l) => /deletion marker could not be written/.test(l)));
});

test('meetings: meeting_recording_delete before recording started says that it switched recording off (P3)', async (t) => {
  const f = meetingFixture(t);
  let admit;
  const lobby = new Promise((r) => { admit = r; });
  const m0 = f.meetings;
  const orig = m0.platformFor;
  m0.platformFor = (u) => ({ ...orig(u), lobby: async () => { await lobby; return 'admitted'; } });
  const r = await m0.join('alice', { url: 'https://meet.google.com/abc-defg-hij' });
  await sleep(50);
  assert.deepEqual(await m0.deleteRecording('alice', r.meeting_id), { meeting_id: r.meeting_id, deleted: false, recording_disabled: true });
  admit();
  await sleep(200);
  assert.equal(f.recorders.length, 0, 'and nothing is recorded');
  await m0.leave('alice', r.meeting_id);
  const done = await m0.join('alice', { url: 'https://meet.google.com/abc-defg-hij' });
  await until(() => f.recorders.length === 1);
  await m0.leave('alice', done.meeting_id);
  assert.deepEqual(await m0.deleteRecording('alice', done.meeting_id), { meeting_id: done.meeting_id, deleted: true }, 'an ended meeting: as before');
});

test('meetings: ended meetings are kept per tenant (P3)', async (t) => {
  const f = meetingFixture(t);
  const first = await f.meetings.join('alice', { url: 'https://meet.google.com/abc-defg-hij' });
  await f.meetings.leave('alice', first.meeting_id);
  const bobs = [];
  for (let i = 0; i < 52; i++) { const r = await f.meetings.join('bob', { url: 'https://meet.google.com/abc-defg-hij' }); await f.meetings.leave('bob', r.meeting_id); bobs.push(r.meeting_id); }
  assert.equal(f.meetings.status('alice', first.meeting_id).state, 'ended', "another tenant's meetings do not push it out");
  assert.throws(() => f.meetings.status('bob', bobs[0]), /no meeting/);
  assert.equal(f.meetings.status('bob', bobs[51]).state, 'ended');
  assert.equal([...f.meetings.ended.values()].filter((x) => x.tenant === 'bob').length, 50);
});

test('meetings: a chat message of its own that starts with a time is not taken for an objection (P2)', { timeout: 120_000 }, async (t) => {
  const fake = await startFakeMeet();
  const audio = fakeAudio({});
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 } });
  t.after(async () => { await svc.stop(); await fake.close(); });
  const ev = { chat: [], optout: [] };
  for (const k of Object.keys(ev)) svc.events.on(`meeting-${k}`, (e) => ev[k].push(e));
  const c = await connect(svc);
  const { code, url } = fake.newRoom();
  fake.open(code);
  const id = (await c.call('meeting_join', { url })).json().meeting_id;
  const status = async () => (await c.call('meeting_status', { meeting_id: id })).json();
  await until(async () => (await status()).state === 'recording', 30_000, 200);
  const sent = await c.call('meeting_chat_send', { meeting_id: id, text: '14:00: stop recording and wrap up' });
  assert.equal(sent.isError, false, sent.text);
  await sleep(2500);
  assert.equal((await status()).state, 'recording', 'still recording');
  assert.deepEqual(ev.optout, []);
  assert.deepEqual(ev.chat.filter((e) => /wrap up/.test(e.text)), [], 'its own message is not reported back as chat');
  // Someone else writing the same still counts.
  fake.say(code, 'Alex Example', '14:05: please stop recording');
  await until(() => ev.optout.length === 1, 10_000, 100);
  await c.close();
});

test('secret_save: a short value gets no hash prefix to guess it from (P2)', { timeout: 90_000 }, async (t) => {
  const site = await startPageServer();
  const svc = await startBosun();
  t.after(async () => { await svc.stop(); await site.close(); });
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${site.base}/login` });
  await c.call('type', { session: s, selector: '#otp', value: '424242' });
  const short = (await c.call('secret_save', { session: s, selector: '#otp' })).json();
  assert.equal(short.length, 6);
  assert.equal(short.sha256_prefix, null);
  assert.match(short.sha256_note, /under 16 bytes/);
  assert.ok(!JSON.stringify(short).includes(crypto.createHash('sha256').update('424242').digest('hex').slice(0, 8)));
  await c.call('type', { session: s, selector: '#pw', value: 'a-long-enough-value-0123' });
  const long = (await c.call('secret_save', { session: s, selector: '#pw' })).json();
  assert.equal(long.sha256_prefix, crypto.createHash('sha256').update('a-long-enough-value-0123').digest('hex').slice(0, 8));
  assert.equal(long.sha256_note, undefined);
});

test('tenant sandbox: a worker is handed neither the store configuration nor a provider key it has no use for', (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const doc = { stores: { files: { type: 'file', dir }, bao: { type: 'openbao', address: 'https://bao.example:8200', token_file: path.join(dir, 'bao-token') } },
    tenants: { alice: { recipes: { r: { store: 'bao', path: 'tenants/alice/x', origin: 'https://app.example.org', selector: '#p' } } } } };
  const env = { BROWSER_TOKENS: `alice:${TOKEN},bob:test-token-bbbbbbbbbbbbbbbb`, WS_PORT: '0', BOSUN_SECRET_STORES: JSON.stringify(doc), ELEVENLABS_API_KEY: 'elevenlabs-key-0123456789' };
  const cfg = loadConfig(env);
  assert.ok(cfg.secretStores.stores.size === 2);
  const worker = workerConfig(cfg, 'alice', '/state', 'worker-token', null, new Map(), {}, '/run/bosun/relay/secrets');
  const wire = serialize(worker).toString('latin1'); // what crosses into the sandbox; it must serialize at all
  assert.equal(worker.secretStores, null);
  assert.equal(worker.secretBroker, '/run/bosun/relay/secrets');
  for (const s of ['bao-token', 'bao.example', 'tenants/alice/x', dir, 'test-token-bbbbbbbbbbbbbbbb', TOKEN]) assert.ok(!wire.includes(s), `the worker configuration carries ${s}`);
  assert.ok(wire.includes('elevenlabs-key-0123456789'), 'meetings on: the worker speaks to the provider itself');
  const off = workerConfig(loadConfig({ ...env, FEATURES_MEETINGS: '0' }), 'bob', '/state', 'worker-token', null, new Map(), {}, null);
  assert.equal(off.elevenlabs, null, 'meetings off: no provider key in the worker');
  assert.equal(off.secretBroker, null);
});
