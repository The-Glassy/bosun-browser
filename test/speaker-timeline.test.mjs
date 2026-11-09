// No browser, display, PulseAudio, network or API keys: fake recorders and page snapshots drive the real lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SpeakerTimeline, labelTranscript, speakerFile } from '../src/meetings/speaker-timeline.mjs';
import { Meetings, sweepRecordings } from '../src/meetings/index.mjs';
import { watchSpeakers, drainSpeakers } from '../src/meetings/platforms/common.mjs';
import { meetingEvent } from '../src/events.mjs';
import { buildServer } from '../src/tools.mjs';
import { loadConfig } from '../src/config.mjs';
import { pulseInputStartedAt } from '../src/meetings/audio.mjs';
import { execFileSync, spawnSync } from 'node:child_process';

const snapshot = (t, opts = {}) => t.snapshot({ meeting_id: 'm123456789abc', platform: 'meet', recording_seconds: 10, now: 11000, ...opts });
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

test('PulseAudio input clock: parse the FFmpeg input start, never the rebased output duration', () => {
  const header = "Input #0, pulse, from 'bosun_out.monitor':\n  Duration: N/A, start: 1794222000.123456, bitrate: 1536 kb/s\n";
  assert.equal(pulseInputStartedAt(header.slice(0, header.indexOf('123456'))), null);
  assert.equal(pulseInputStartedAt(header), 1794222000123.456);
  assert.equal(pulseInputStartedAt('Duration: 00:03:00.0, start: 0.000000, bitrate: 24 kb/s'), null);
});

test('intervals: merge consecutive samples, overlap, silence, sub-300 ms flickers, self names', () => {
  const t = new SpeakerTimeline({ startedAt: 1000, self: ['Bosun (notetaker)', 'Glassy Account'] });
  t.sample({ t: 800, names: ['Alice', 'bosun', ' GLASSY  ACCOUNT '] });
  t.sample({ t: 1500, names: ['Alice', 'Bob'] });
  t.sample({ t: 1700, names: ['Alice'] }); // Bob flickers for 200 ms
  t.sample({ t: 2000, names: ['Alice', 'Bob'] });
  t.sample({ t: 2400, names: ['Bob'] });
  t.sample({ t: 2500, names: ['Bob'] });
  t.sample({ t: 3000, names: [] });
  t.finish(4000);
  assert.deepEqual(snapshot(t).intervals, [
    { start_s: 0, end_s: 1.4, name: 'Alice' }, { start_s: 1, end_s: 2, name: 'Bob' },
  ]);
  assert.deepEqual(snapshot(t).speakers, ['Alice', 'Bob']);
});

test('audio zero clips startup time and the stop boundary; no labels before/after audio', () => {
  const t = new SpeakerTimeline({ startedAt: 1000 });
  t.sample({ t: 500, name: 'Alice' });
  t.sample({ t: 2200, name: 'Bob' });
  t.sample({ t: 2600, name: 'Alice' });
  t.finish(4000);
  assert.deepEqual(snapshot(t, { audioStartedAt: 2000, recording_seconds: 1.5 }).intervals,
    [{ start_s: 0.2, end_s: 0.6, name: 'Bob' }, { start_s: 0.6, end_s: 1.5, name: 'Alice' }]);
});

test('ten-minute history is retained; memory cap and clock disorder are reported', () => {
  const t = new SpeakerTimeline({ startedAt: 1000, maxIntervals: 2 });
  t.sample({ t: 1000, name: 'Alice' });
  t.sample({ t: 901000, name: 'Bob' });
  t.sample({ t: 900000, name: 'wrong clock' });
  t.sample({ t: 902000, name: 'Alice' });
  t.finish(903000);
  const data = snapshot(t, { recording_seconds: 902 });
  assert.equal(data.intervals[0].end_s, 900);
  assert.equal(data.intervals.length, 2);
  assert.equal(data.truncated, true);
  assert.match(data.note, /capacity/);
  assert.match(data.note, /clock alignment may be unreliable/);
});

test('no activity or only self yields none-seen; exactly 300 ms is retained', () => {
  const t = new SpeakerTimeline({ startedAt: 1000, self: ['Bosun'] });
  t.sample({ t: 1000, names: ['Bosun'] });
  assert.equal(snapshot(t).speaker_labels, 'none-seen');
  t.sample({ t: 2000, name: 'Alice' });
  t.finish(2300);
  assert.deepEqual(snapshot(t).intervals, [{ start_s: 1, end_s: 1.3, name: 'Alice' }]);
});

test('offline helper: total overlap, duplicate ranges, ties, gaps, no input mutation', () => {
  const timeline = { intervals: [
    { start_s: 0, end_s: 1, name: 'Alice' }, { start_s: 2, end_s: 3, name: 'Alice' },
    { start_s: 0, end_s: 1, name: 'Alice' }, { start_s: 0, end_s: 2.5, name: 'Bob' },
  ] };
  const segments = [{ start_s: 0, end_s: 3, text: 'hello' }, { start_s: 2, end_s: 2.5, text: 'tie' }, { start_s: 4, end_s: 5, text: '?' }];
  const before = JSON.stringify({ timeline, segments });
  assert.deepEqual(labelTranscript(timeline, segments).map((s) => s.speaker), ['Bob', 'Alice', null]);
  assert.equal(JSON.stringify({ timeline, segments }), before);
});

test('the real page watcher collects all active names and excludes marked/name-matched self (VM DOM)', async () => {
  const box = (text, self = false) => ({ textContent: text, matches: (s) => s === '.self' && self, querySelector: (s) => s === '.speaking' ? {} : null });
  let tiles = [box('Alice'), box('Bob'), box('Bosun'), box('Account name', true)];
  const context = vm.createContext({ window: {}, document: { querySelectorAll: () => tiles }, Date, setInterval: (fn) => { context.tick = fn; } });
  const page = { evaluate: async (fn, arg) => { context.arg = arg; return vm.runInContext(`(${fn.toString()})(arg)`, context); } };
  await watchSpeakers(page, 'speaker', { tiles: '.tile', selfMark: '.self', speaking: ['.speaking'] }, { self: ['Bosun'] });
  assert.deepEqual(JSON.parse(JSON.stringify(await drainSpeakers(page, 'speaker'))).map((s) => s.names), [['Alice', 'Bob']]);
  context.tick();
  assert.equal((await drainSpeakers(page, 'speaker')).length, 0);
  tiles = []; context.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(await drainSpeakers(page, 'speaker')))[0].names, []);
});

function fixture(t, { aligned = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-speakers-'));
  let now = 100000, pending = [], recExit;
  const cfg = { ...loadConfig({ ALLOW_NO_TOKEN: '1' }), dataDir: dir, recordingRetentionDays: 30, downloadUrlTtlMs: 900000, ws: true };
  const events = [];
  const manager = { allowList: () => null, run: async (_owner, _id, fn) => fn({ page: {} }), dispose: async (session) => { session.disposed = true; } };
  const meetings = new Meetings({ cfg, manager, now: () => now, bus: { meeting: (kind, data) => events.push({ kind, ...data }) } });
  manager.meetings = meetings;
  const m = { id: 'm123456789abc', tenant: 'alice', name: 'Bosun', info: { selfName: 'Account' }, state: 'admitted', recMs: 0, speakerLog: [],
    platform: { name: 'meet', drainSpeakers: async () => pending.splice(0) }, session: { id: 'session', page: {} },
    ac: new AbortController(), joined: deferred(), announceDone: deferred(), createdAt: now, admittedAt: now, announced: { failures: [] },
    channelGen: 0, consentGen: 0, specStreams: new Map(), prepared: new Map(), overrides: {}, leaveOnOptOut: false,
    rig: { close: async () => {}, record(file) {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fake audio');
      recExit = deferred();
      return { file, startedAt: now, ...(aligned ? { audioStartedAt: now + 1000 } : {}), exited: recExit.p,
        error: () => 'recorder failed', stop: async () => recExit.resolve(), kill: async () => recExit.resolve() };
    } },
  };
  meetings.active.set(m.id, m);
  t.after(() => { clearInterval(meetings.sweeper); clearInterval(m.speakerTimer); fs.rmSync(dir, { recursive: true, force: true }); });
  return { meetings, m, cfg, manager, events, setNow: (n) => { now = n; }, sample: (s) => pending.push(s), crash: () => recExit.resolve() };
}

async function recorded(t, opts) {
  const f = fixture(t, opts);
  f.meetings.startRecording(f.m);
  f.sample({ t: 100500, names: ['Alice', 'Bosun', 'Account'] });
  f.sample({ t: 102000, names: ['Alice', 'Bob'] });
  f.sample({ t: 103000, names: ['Bob'] });
  f.setNow(104000);
  return f;
}
const sidecar = (f) => JSON.parse(fs.readFileSync(speakerFile(f.meetings.file('alice', f.m.id)), 'utf8'));

test('notetaker stop(delete=false) drains pending samples, aligns and persists 0600; status and ended event', async (t) => {
  const f = await recorded(t);
  assert.throws(() => f.meetings.recordingGet('alice', f.m.id), /still recording/);
  await f.meetings.stopRecordingTool('alice', f.m.id, false);
  const data = sidecar(f);
  assert.equal(data.recording_seconds, 3);
  assert.equal(data.alignment, 'pulse-input-timestamp');
  assert.deepEqual(data.intervals, [{ start_s: 0, end_s: 2, name: 'Alice' }, { start_s: 1, end_s: 3, name: 'Bob' }]);
  assert.equal(fs.statSync(speakerFile(f.m.file)).mode & 0o777, 0o600);
  assert.deepEqual(f.meetings.recordingGet('alice', f.m.id).speakers.data, data);
  assert.deepEqual(f.meetings.view(f.m).speaker_timeline, { intervals: 2 });
  assert.equal(f.m.speakerTimeline, null, 'full data released from memory');
  await f.meetings.finish(f.m, 'meeting-ended');
  const event = f.events.find((e) => e.kind === 'ended');
  assert.deepEqual(event.speaker_timeline, { intervals: 2 });
  assert.match(meetingEvent('ended', event).payload.content[0].text, /speaker timeline \(2 intervals\)/);
  f.meetings.ended.clear(); // service restart: retrieve sidecar from disk with the same tenant guard
  const old = new Date(0); fs.utimesSync(f.m.file, old, old);
  assert.deepEqual(f.meetings.recordingGet('alice', f.m.id).speakers.data, data);
  assert.throws(() => f.meetings.recordingGet('bob', f.m.id), /no recording/);
});

test('meeting end saves directly; fallback alignment is explicit; restart overwrites and resets the timeline', async (t) => {
  const f = await recorded(t, { aligned: false });
  await f.meetings.stopRecording(f.m, { del: false });
  assert.equal(sidecar(f).recording_seconds, 4);
  assert.equal(sidecar(f).alignment, 'estimated-recorder-start');
  assert.match(sidecar(f).note, /startup latency/);
  f.setNow(200000); f.meetings.startRecording(f.m);
  assert.equal(fs.existsSync(speakerFile(f.m.file)), false);
  f.sample({ t: 200000, name: 'New speaker' }); f.setNow(201000);
  await f.meetings.finish(f.m, 'meeting-ended');
  assert.deepEqual(sidecar(f).intervals, [{ start_s: 0, end_s: 1, name: 'New speaker' }]);
});

test('recorder failure saves labels and stops accumulating during an unrecorded pause', async (t) => {
  const f = await recorded(t);
  f.crash();
  await new Promise((r) => setImmediate(r));
  await f.m.timelineSaving;
  assert.equal(sidecar(f).intervals.length, 2);
  assert.equal(f.m.state, 'admitted');
  f.setNow(200000); f.sample({ t: 200000, name: 'Not recorded' });
  await f.meetings.drainSpeakers(f.m);
  assert.deepEqual(sidecar(f).speakers, ['Alice', 'Bob']);
});

test('deletion and opt-out remove disk + memory labels and revoke both links, including during a graceful stop', async (t) => {
  const f = await recorded(t);
  let release;
  const rec = f.m.rec;
  rec.stop = () => new Promise((r) => { release = r; });
  const keeping = f.meetings.stopRecording(f.m, { del: false });
  const file = f.m.file;
  fs.writeFileSync(speakerFile(file), '{}');
  f.meetings.links.issue('alice', f.m.id); f.meetings.links.issue('alice', f.m.id, 'speakers');
  await f.meetings.optOut(f.m, { sender: 'Alice', text: "please don't record", at: 104000 });
  release(); await keeping;
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(speakerFile(file)), false);
  assert.equal(f.m.speakerTimeline, null);
  assert.equal(f.meetings.links.links.size, 0);
  assert.equal(f.meetings.timelineCount(f.m), 0);
  await f.meetings.finish(f.m, 'meeting-ended');
  assert.equal(fs.existsSync(speakerFile(file)), false, 'meeting end cannot resurrect deleted labels');
});

test('meeting_recording_delete after stop and earlier-run deletion respect tenant ownership', async (t) => {
  const f = await recorded(t);
  await f.meetings.stopRecording(f.m, { del: false });
  const file = f.m.file;
  await assert.rejects(f.meetings.deleteRecording('bob', f.m.id), /no meeting/);
  assert.ok(fs.existsSync(speakerFile(file)));
  await f.meetings.deleteRecording('alice', f.m.id);
  assert.equal(fs.existsSync(speakerFile(file)), false);
  assert.equal(f.meetings.timelineCount(f.m), 0);
  f.meetings.active.clear();
  fs.writeFileSync(file, 'late audio'); fs.writeFileSync(speakerFile(file), '{}');
  f.meetings.sweep();
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(speakerFile(file)), false);
});

test('retention follows audio age, keeps active sidecars, removes orphan sidecars', (t) => {
  const f = fixture(t), file = f.meetings.file('alice', f.m.id);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'audio'); fs.writeFileSync(speakerFile(file), '{}');
  const old = new Date(0); fs.utimesSync(file, old, old);
  const now = 31 * 86400000;
  assert.deepEqual(sweepRecordings(f.meetings.dir, 30, { now, keep: new Set([file]) }), []);
  assert.ok(fs.existsSync(speakerFile(file)));
  assert.deepEqual(sweepRecordings(f.meetings.dir, 30, { now }), [file]);
  assert.equal(fs.existsSync(speakerFile(file)), false);
  fs.writeFileSync(speakerFile(file), '{}');
  sweepRecordings(f.meetings.dir, 30, { now });
  assert.equal(fs.existsSync(speakerFile(file)), false);
});

// Exercise the actual GET handler through streams, without opening a listening socket.
async function get(links, id, secret, { kind = 'speakers', tenant = null } = {}) {
  const req = { method: 'GET', url: `/recording/${id}${kind === 'speakers' ? '/speakers' : ''}?t=${secret}`, resume() {} };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  res.setTimeout = () => {};
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  await links.handle(req, res, { authTenant: () => tenant });
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString() };
}

test('large sidecar: one-time JSON URL, independent audio URL, tenant checks, expiry and revocation', async (t) => {
  const f = await recorded(t); await f.meetings.stopRecording(f.m, { del: false });
  const data = sidecar(f);
  data.note += 'x'.repeat(33000); fs.writeFileSync(speakerFile(f.m.file), JSON.stringify(data));
  const r = f.meetings.recordingGet('alice', f.m.id);
  assert.ok(r.speakers.secret); assert.ok(!r.speakers.data);
  assert.equal((await get(f.meetings.links, f.m.id, r.speakers.secret, { tenant: 'bob' })).status, 403);
  assert.equal((await get(f.meetings.links, f.m.id, r.secret)).status, 404, 'audio secret cannot fetch labels');
  const json = await get(f.meetings.links, f.m.id, r.speakers.secret);
  assert.equal(json.status, 200); assert.equal(json.headers['content-type'], 'application/json');
  assert.equal(json.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(json.body), data);
  assert.equal((await get(f.meetings.links, f.m.id, r.speakers.secret)).status, 404);
  assert.equal((await get(f.meetings.links, f.m.id, r.secret, { kind: 'audio' })).status, 200);
  const expired = f.meetings.recordingGet('alice', f.m.id);
  f.meetings.links.links.get(`${f.m.id}:speakers`).expiresAt = 0;
  assert.equal((await get(f.meetings.links, f.m.id, expired.speakers.secret)).status, 404);
  const revoked = f.meetings.recordingGet('alice', f.m.id);
  f.meetings.links.revoke('bob', f.m.id);
  assert.ok(f.meetings.links.links.has(`${f.m.id}:speakers`));
  await f.meetings.deleteRecording('alice', f.m.id);
  assert.equal((await get(f.meetings.links, f.m.id, revoked.speakers.secret)).status, 404);
});

test('recording_get MCP response preserves audio fields and exposes inline/URL/stdio/legacy speaker metadata', async (t) => {
  const f = await recorded(t); await f.meetings.stopRecording(f.m, { del: false });
  const server = buildServer({ manager: f.manager, cfg: f.cfg, tenant: 'alice', owner: 'test', uploadBase: 'http://localhost:9999' });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async () => {
    const r = await client.callTool({ name: 'recording_get', arguments: { meeting_id: f.m.id } });
    assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text);
  };
  const r = await call();
  assert.equal(r.filename, `${f.m.id}.ogg`); assert.equal(r.mime, 'audio/ogg');
  assert.equal(r.valid_min, 15); assert.match(r.get_url, /^http:\/\/localhost:9999\/recording\//); assert.ok(r.curl);
  assert.deepEqual(r.speakers, sidecar(f));
  const data = sidecar(f); data.note += 'x'.repeat(33000); fs.writeFileSync(speakerFile(f.m.file), JSON.stringify(data));
  assert.match((await call()).speakers.get_url, /\/speakers\?t=/);
  f.cfg.ws = false;
  assert.equal((await call()).speakers.path, speakerFile(f.m.file));
  fs.rmSync(speakerFile(f.m.file));
  assert.equal((await call()).speakers, null);
});

const haveFFmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
test('real Ogg duration clips the stop tail to audio time, independently of wall time', { skip: !haveFFmpeg && 'ffmpeg/ffprobe unavailable' }, async (t) => {
  const f = await recorded(t);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '2', '-c:a', 'libopus', f.m.file]);
  await f.meetings.stopRecording(f.m, { del: false });
  const data = sidecar(f);
  assert.equal(data.duration_source, 'audio-probe');
  assert.ok(data.recording_seconds >= 2 && data.recording_seconds < 2.1);
  assert.ok(data.intervals.every((r) => r.end_s <= data.recording_seconds));
  assert.deepEqual(data.intervals.find((r) => r.name === 'Alice'), { start_s: 0, end_s: 2, name: 'Alice' });
});

test('a stalled final page drain is bounded and explicitly marks incomplete labels', async (t) => {
  const f = await recorded(t);
  await f.meetings.drainSpeakers(f.m);
  f.meetings.speakerDrainMs = 10;
  const pending = deferred();
  f.m.platform.drainSpeakers = () => pending.p;
  await f.meetings.stopRecording(f.m, { del: false });
  assert.equal(sidecar(f).incomplete, true);
  assert.match(sidecar(f).note, /samples could not be read/);
  pending.resolve([{ t: 103500, name: 'Too late' }]);
  await f.m.speakerDrain;
  assert.deepEqual(sidecar(f).speakers, ['Alice', 'Bob'], 'late drain cannot modify sealed sidecar');
});

test('opt-out wins while the final page drain is pending', async (t) => {
  const f = await recorded(t);
  const pending = deferred(), entered = deferred();
  f.m.platform.drainSpeakers = () => { entered.resolve(); return pending.p; };
  const keeping = f.meetings.stopRecording(f.m, { del: false });
  await entered.p;
  const file = f.m.file;
  await f.meetings.optOut(f.m, { sender: 'Alice', text: "please don't record", at: 104000 });
  pending.resolve([{ t: 102000, name: 'Do not keep' }]);
  await keeping;
  assert.equal(fs.existsSync(speakerFile(file)), false);
  assert.equal(f.meetings.timelineCount(f.m), 0);
});

test('deleting a recording aborts a sidecar transfer already in progress', async (t) => {
  const f = await recorded(t); await f.meetings.stopRecording(f.m, { del: false });
  fs.writeFileSync(speakerFile(f.m.file), 'x'.repeat(1024 * 1024));
  const r = f.meetings.recordingGet('alice', f.m.id);
  const opened = deferred();
  const req = { method: 'GET', url: `/recording/${f.m.id}/speakers?t=${r.speakers.secret}`, resume() {} };
  const res = new Writable({ highWaterMark: 1, write(_chunk, _enc, _done) { /* deliberately stalled consumer */ } });
  res.setTimeout = () => {};
  res.writeHead = () => { res.headersSent = true; opened.resolve(); };
  const transfer = f.meetings.links.handle(req, res, { authTenant: () => null });
  await opened.p;
  assert.equal(f.meetings.links.transfers.size, 1);
  await f.meetings.deleteRecording('alice', f.m.id);
  await transfer;
  assert.ok(res.destroyed);
  assert.equal(f.meetings.links.transfers.size, 0);
});

test('damaged small sidecar still permits audio retrieval and reports its error', async (t) => {
  const f = await recorded(t); await f.meetings.stopRecording(f.m, { del: false });
  fs.writeFileSync(speakerFile(f.m.file), '{partial');
  const r = f.meetings.recordingGet('alice', f.m.id);
  assert.equal(r.speakers, null);
  assert.match(r.speakers_error, /could not be read/);
  assert.ok(r.secret);
});
