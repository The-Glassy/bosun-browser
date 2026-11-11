// No display or listening sockets: the real meeting lifecycle and MCP surface with a stub platform/recorder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Meetings, announcement, sweepRecordings } from '../src/meetings/index.mjs';
import { speakerFile } from '../src/meetings/speaker-timeline.mjs';
import { startPageVideo, validateVideo, videoCapacity } from '../src/meetings/video.mjs';
import { buildServer } from '../src/tools.mjs';
import { loadConfig } from '../src/config.mjs';

const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) { for (let n = 0; n < 200; n++) { if (fn()) return; await pause(5); } throw new Error('timed out'); }

function fixture(t, { announceGate, cfg: overrides = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-video-'));
  const cfg = { ...loadConfig({ ALLOW_NO_TOKEN: '1' }), dataDir, maxSessions: 10, maxSessionsPerTenant: 10, ...overrides };
  const log = [], recorders = [], chat = [];
  const page = { goto: async () => {}, keyboard: { press: async () => {} } };
  const platform = {
    name: 'meet', lobby: async () => 'admitted', state: async () => 'admitted', participants: async () => 3,
    openChat: async () => {}, watchChat: async () => {}, drainChat: async () => chat.splice(0), leave: async () => {},
    sendChat: async (_p, text) => { log.push(['announce-start', text]); await announceGate?.p; log.push(['announce-end', text]); },
  };
  let seq = 0;
  const manager = { allowList: () => null, used: 0, tenantUse: new Map(), engines: { get: () => ({ family: 'chromium' }) },
    open: async () => ({ id: `s${++seq}`, page, ctx: { grantPermissions: async () => {} } }),
    run: async (_owner, _id, fn) => fn({ page }), dispose: async (s) => { s.disposed = true; },
  };
  const audio = { unsupported: async () => null, open: async () => ({ close: async () => {}, record: (file) => makeRecorder(file), recordVideo: (file, video) => makeRecorder(file, video) }) };
  function makeRecorder(file, video) {
    log.push(['record', video]);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fake media', { mode: 0o600 });
    const done = deferred();
    const rec = { startedAt: Date.now(), audioStartedAt: Date.now(), exited: done.p, error: () => null,
      valid: async () => true, fail: () => done.resolve(), stop: async () => done.resolve(), kill: async () => { rec.killed = true; done.resolve(); }, video };
    recorders.push(rec); return rec;
  }
  let free = 100;
  const meetings = new Meetings({ cfg, manager, audio, platformFor: () => platform, pollMs: 10,
    diskStat: () => ({ bavail: free * 1024 ** 3, bsize: 1 }) });
  manager.meetings = meetings;
  t.after(async () => { announceGate?.resolve(); await meetings.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { meetings, manager, cfg, log, chat, recorders, page, setFree: (n) => { free = n; } };
}
async function join(f, opts = {}) {
  const r = await f.meetings.join('alice', { url: 'https://meet.google.com/abc-defg-hij', leaveOnOptOut: false, ...opts });
  return f.meetings.active.get(r.meeting_id);
}
async function recording(f, opts = {}) { const m = await join(f, { recordVideo: true, ...opts }); await until(() => !!m.rec); return m; }

async function mcp(t, f) {
  const server = buildServer({ manager: f.manager, cfg: f.cfg, tenant: 'alice', owner: 'test', uploadBase: 'http://localhost:9999' });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
async function get(links, id, secret, tenant = null, kind = '') {
  const req = { method: 'GET', url: `/recording/${id}${kind ? `/${kind}` : ''}?t=${secret}`, resume() {} };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  res.setTimeout = () => {};
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  await links.handle(req, res, { authTenant: () => tenant });
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
}

test('join parameters, defaults, config validation and no tenant video setting', async (t) => {
  for (const bad of [null, 1, 'true']) assert.throws(() => validateVideo(bad, 2), /record_video/);
  for (const bad of [null, 0, 1, 6, 2.5, '2', NaN]) assert.throws(() => validateVideo(true, bad), /video_fps/);
  for (const fps of [2, 3, 4, 5]) validateVideo(true, fps);
  for (const env of [{ MEETING_VIDEO_LIMIT: '-1' }, { MEETING_VIDEO_MIN_FREE_GB: '1.5' }]) assert.throws(() => loadConfig({ ALLOW_NO_TOKEN: '1', ...env }), /MEETING_VIDEO/);
  const f = fixture(t), c = await mcp(t, f);
  assert.equal(c.getServerVersion().version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version);
  const schema = (await c.listTools()).tools.find((x) => x.name === 'meeting_join').inputSchema;
  assert.equal(schema.properties.record_video.type, 'boolean');
  assert.equal(schema.properties.video_fps.minimum, 2); assert.equal(schema.properties.video_fps.maximum, 5);
  for (const args of [{ record_video: 'true' }, { video_fps: 1 }, { video_fps: 6 }, { video_fps: 2.1 }]) {
    const r = await c.callTool({ name: 'meeting_join', arguments: { url: 'https://meet.google.com/abc-defg-hij', ...args } });
    assert.equal(r.isError, true);
  }
  await assert.rejects(f.meetings.join('alice', { url: 'https://meet.google.com/abc-defg-hij', settings: { record_video: true } }), /cannot be set/);
  assert.ok(!Object.hasOwn(f.meetings.settings.effective('alice').values, 'record_video'));
  const m = await join(f); await until(() => !!m.rec);
  assert.equal(m.recordVideo, false); assert.equal(m.videoFps, 2);
  assert.ok(m.file.endsWith('.ogg')); assert.equal(f.recorders[0].video, undefined);
  assert.deepEqual(f.meetings.view(m).video, { on: false, fps: 2, bytes: 0 });
});

test('no recorder or frames before both announcements finish; page and fps passed only afterwards', async (t) => {
  const gate = deferred(), f = fixture(t, { announceGate: gate });
  const m = await join(f, { recordVideo: true, videoFps: 4 });
  await until(() => f.log.length > 0);
  assert.equal(m.state, 'admitted'); assert.equal(f.recorders.length, 0); assert.equal(m.file, null);
  gate.resolve(); await until(() => !!m.rec);
  assert.deepEqual(f.log.map((x) => x[0]), ['announce-start', 'announce-end', 'announce-start', 'announce-end', 'record', 'record']);
  assert.deepEqual(f.recorders[1].video, { page: f.page, fps: 4 });
  assert.match(f.log[0][1], /audio and video of this meeting page/);
  assert.match(announcement('Notes', null, { video: true, live: true })[1], /Ton und Video/);
  assert.ok(m.file.endsWith('.ogg')); assert.ok(m.videoFile.endsWith('.webm')); assert.notEqual(m.rec, m.videoRec); assert.equal(fs.statSync(m.file).mode & 0o777, 0o600);
  assert.deepEqual(f.meetings.view(m).video, { on: true, fps: 4, bytes: 10 });
});

test('objection during announcement prevents all video capture, including announce none/failed policies', async (t) => {
  const gate = deferred(), f = fixture(t, { announceGate: gate });
  const m = await join(f, { recordVideo: true });
  f.chat.push({ id: '1', sender: 'Alice', text: "please don't record" });
  gate.resolve(); await until(() => !!m.optedOut);
  assert.equal(f.recorders.length, 0); assert.equal(m.noRecord, true);
  for (const mode of ['none', 'chat']) {
    const g = fixture(t);
    if (mode === 'chat') { const old = g.meetings.platformFor; g.meetings.platformFor = (...a) => ({ ...old(...a), sendChat: async () => { throw new Error('chat disabled'); } }); }
    const n = await recording(g, { announce: mode });
    assert.equal(n.announced.sent_to, mode === 'none' ? 'none' : 'failed');
    await g.meetings.optOut(n, { sender: 'Alice', text: 'stop recording' });
    assert.equal(n.rec, null); assert.equal(n.deleted, true);
  }
});

test('disk and concurrency guards reserve lobby joins across tenants and release pre-recording stops', async (t) => {
  const gate = deferred(), f = fixture(t, { announceGate: gate });
  f.setFree(1); await assert.rejects(join(f, { recordVideo: true }), /2 GB free/);
  assert.equal(f.meetings.active.size, 0);
  f.setFree(10);
  const attempts = await Promise.allSettled([join(f, { recordVideo: true }), f.meetings.join('bob', { url: 'https://meet.google.com/abc-defg-hij', recordVideo: true })]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  assert.match(attempts.find((r) => r.status === 'rejected').reason.message, /limit 1/);
  const m = [...f.meetings.active.values()][0];
  await f.meetings.stopRecordingTool(m.tenant, m.id, false);
  assert.equal(m.videoReserved, false);
  const n = await join(f, { recordVideo: true });
  // Disk can fill during a lobby wait; refuse again before touching CDP or creating the file.
  f.setFree(0); gate.resolve(); await until(() => n.state === 'ended');
  assert.match(n.error, /free disk/); assert.equal(f.recorders.length, 0);
  assert.equal(n.videoReserved, false);
  const disabled = fixture(t, { cfg: { meetingVideoLimit: 0 } });
  await assert.rejects(join(disabled, { recordVideo: true }), /limit 0/);
  assert.throws(() => videoCapacity('/tmp', { meetingVideoMinFreeGb: 3 }, 0, () => ({ bavail: 2 * 1024 ** 3, bsize: 1 })), /3 GB/);
});

test('WebM download uses video metadata and one-time tenant-scoped URL; sidecar and restart discovery', async (t) => {
  const f = fixture(t, { cfg: { ws: true } }), m = await recording(f);
  assert.throws(() => f.meetings.recordingGet('alice', m.id), /still recording/);
  await f.meetings.stopRecordingTool('alice', m.id, false);
  assert.deepEqual(f.meetings.view(m).video, { on: false, fps: 2, bytes: 10 });
  assert.ok(fs.existsSync(speakerFile(m.file)));
  const c = await mcp(t, f);
  const result = await c.callTool({ name: 'recording_get', arguments: { meeting_id: m.id } });
  assert.ok(!result.isError, JSON.stringify(result));
  const meta = JSON.parse(result.content[0].text);
  assert.equal(meta.mime, 'audio/ogg'); assert.equal(meta.filename, `${m.id}.ogg`);
  assert.equal(meta.video.mime, 'video/webm'); assert.equal(meta.video.filename, `${m.id}.webm`);
  assert.match(meta.video.curl, /\.webm/);
  assert.match(meta.curl, /\.ogg/); assert.equal(meta.speakers.meeting_id, m.id);
  const secret = new URL(meta.get_url).searchParams.get('t');
  assert.equal((await get(f.meetings.links, m.id, secret, 'bob')).status, 403);
  const fetched = await get(f.meetings.links, m.id, secret);
  assert.equal(fetched.status, 200); assert.equal(fetched.headers['content-type'], 'audio/ogg');
  assert.match(fetched.headers['content-disposition'], /\.ogg/);
  assert.equal((await get(f.meetings.links, m.id, secret)).status, 404);
  const videoSecret = new URL(meta.video.url).searchParams.get('t');
  assert.equal((await get(f.meetings.links, m.id, videoSecret, 'bob', 'video')).status, 403);
  const videoFetched = await get(f.meetings.links, m.id, videoSecret, null, 'video');
  assert.equal(videoFetched.status, 200); assert.equal(videoFetched.headers['content-type'], 'video/webm');
  assert.equal((await get(f.meetings.links, m.id, videoSecret, null, 'video')).status, 404);
  const videoFile = m.videoFile;
  await f.meetings.finish(m, 'meeting-ended'); f.meetings.ended.clear();
  fs.utimesSync(m.file, new Date(0), new Date(0));
  assert.equal(f.meetings.recordingGet('alice', m.id).file, m.file);
  assert.equal(f.meetings.recordingGet('alice', m.id).video.file, videoFile);
  const audioFile = m.file; await f.meetings.deleteRecording('alice', m.id);
  assert.equal(fs.existsSync(videoFile), false); assert.equal(fs.existsSync(audioFile), false); assert.equal(fs.existsSync(speakerFile(m.file)), false);
});

test('opt-out, stop(delete), recording_delete, shutdown and deletion during a graceful stop', async (t) => {
  for (const action of ['optout', 'stop', 'delete', 'shutdown', 'race']) {
    const f = fixture(t), m = await recording(f), file = m.file, videoFile = m.videoFile;
    fs.writeFileSync(speakerFile(file), '{}');
    const url = f.meetings.links.issue('alice', m.id);
    if (action === 'optout') await f.meetings.optOut(m, { sender: 'Alice', text: 'stop recording' });
    if (action === 'stop') await f.meetings.stopRecordingTool('alice', m.id, true);
    if (action === 'delete') await f.meetings.deleteRecording('alice', m.id);
    if (action === 'shutdown') { await f.meetings.stop(); assert.ok(fs.existsSync(file)); assert.ok(fs.existsSync(speakerFile(file))); continue; }
    if (action === 'race') {
      const gate = deferred(); m.rec.stop = () => gate.p;
      const stopping = f.meetings.stopRecordingTool('alice', m.id, false);
      await until(() => !!m.stopping);
      await f.meetings.deleteRecording('alice', m.id); gate.resolve(); await stopping;
    }
    assert.equal(m.rec, null); assert.equal(m.deleted, true); assert.equal(m.videoReserved, false);
    assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(videoFile), false); assert.equal(fs.existsSync(speakerFile(file)), false);
    assert.equal((await get(f.meetings.links, m.id, url)).status, 404);
    assert.throws(() => f.meetings.recordingGet('alice', m.id), /deleted/);
    // A late encoder reopening either extension cannot resurrect deleted content after restart.
    fs.writeFileSync(file, 'late'); fs.writeFileSync(videoFile, 'late'); fs.writeFileSync(speakerFile(file), '{}');
    f.meetings.sweep(); assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(videoFile), false); assert.equal(fs.existsSync(speakerFile(file)), false);
  }
});

test('30-day cleanup removes WebM and sidecar, keeps active files and sidecars, revokes links', async (t) => {
  const f = fixture(t), m = await recording(f), file = m.file, videoFile = m.videoFile;
  fs.writeFileSync(speakerFile(file), '{}'); fs.utimesSync(file, new Date(0), new Date(0));
  assert.deepEqual(f.meetings.sweep(), []); assert.ok(fs.existsSync(speakerFile(file)));
  await f.meetings.stopRecordingTool('alice', m.id, false);
  const link = f.meetings.recordingGet('alice', m.id).secret;
  assert.deepEqual(f.meetings.sweep().sort(), [file, videoFile].sort());
  assert.equal(fs.existsSync(videoFile), false);
  assert.equal(fs.existsSync(speakerFile(file)), false); assert.equal((await get(f.meetings.links, m.id, link)).status, 404);
  fs.writeFileSync(speakerFile(file), '{}'); sweepRecordings(f.meetings.dir, 30);
  assert.equal(fs.existsSync(speakerFile(file)), false);
});

function fakePage() {
  const cdp = new EventEmitter(), commands = [];
  cdp.send = async (method, args) => { commands.push([method, args]); if (method === 'Page.startScreencast') cdp.emit('Page.screencastFrame', { data: Buffer.from('jpeg').toString('base64'), sessionId: 1 }); };
  cdp.detach = async () => { commands.push(['detach']); };
  return { cdp, commands, page: { context: () => ({ newCDPSession: async () => cdp }) } };
}
test('CDP repeats static frames on audio clock, acknowledges frames, and releases page on stop', async () => {
  const f = fakePage(), done = deferred(), frames = new PassThrough(), chunks = [];
  frames.on('data', (b) => chunks.push(b));
  const now = Date.now(); let killed = false;
  const rec = startPageVideo({ page: f.page, fps: 5, file: '/unused', makeRecorder: () => ({ frames, startedAt: now, audioStartedAt: now, exited: done.p,
    error: () => null, stop: async () => done.resolve(), kill: async () => { killed = true; done.resolve(); } }) });
  await until(() => chunks.length >= 3); await rec.stop();
  assert.equal(killed, false); assert.ok(f.commands.some(([cmd]) => cmd === 'Page.screencastFrameAck'));
  assert.ok(f.commands.some(([cmd]) => cmd === 'Page.stopScreencast')); assert.equal(f.cdp.listenerCount('Page.screencastFrame'), 0);
  const count = chunks.length; await pause(220); assert.equal(chunks.length, count);
});

test('delete during CDP acquisition starts no screencast/encoder; page failures and slow encoder are bounded', async () => {
  const f = fakePage(), gate = deferred(); let made = 0;
  f.page.context = () => ({ newCDPSession: () => gate.p });
  const rec = startPageVideo({ page: f.page, fps: 2, makeRecorder: () => { made++; } });
  const ending = rec.kill(); gate.resolve(f.cdp); await ending;
  assert.equal(made, 0); assert.ok(!f.commands.some(([cmd]) => cmd === 'Page.startScreencast'));
  const broken = startPageVideo({ page: { context: () => ({ newCDPSession: async () => { throw new Error('page closed'); } }) }, fps: 2 });
  await broken.exited; assert.match(broken.error(), /page closed/);
  const g = fakePage(), now = Date.now(), done = deferred();
  const slow = startPageVideo({ page: g.page, fps: 2, makeRecorder: () => ({ frames: new PassThrough(), startedAt: now, audioStartedAt: now - 6000, exited: done.p, stop: async () => done.resolve(), kill: async () => done.resolve() }) });
  await slow.exited; assert.match(slow.error(), /5 seconds behind/);
});

test('video failures keep the original audio recorder, file and timeline running', async (t) => {
  for (const valid of [false, true]) {
    const f = fixture(t), m = await recording(f);
    const audio = m.rec, file = m.file, timeline = m.speakerTimeline, zero = audio.audioStartedAt, videoFile = m.videoFile;
    m.videoRec.valid = async () => valid;
    m.videoRec.error = () => 'meeting page supplied no video frame';
    m.videoRec.fail();
    await until(() => !m.videoRec && !m.videoStopping);
    assert.equal(f.recorders.length, 2);
    assert.equal(m.rec, audio); assert.equal(m.file, file); assert.equal(m.speakerTimeline, timeline);
    assert.equal(m.rec.audioStartedAt, zero); assert.equal(m.state, 'recording');
    assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(videoFile), valid);
    assert.match(f.meetings.view(m).video.error, /no video frame/);
    assert.equal(f.meetings.view(m).video.on, false); assert.equal(m.videoReserved, false);
    assert.equal(m.recError, undefined);
  }
});

test('an audio failure stops video too', async (t) => {
  const f = fixture(t), m = await recording(f);
  m.rec.fail(); await until(() => !m.rec && !m.videoRec && !m.stopping);
  assert.equal(m.state, 'admitted'); assert.match(m.recError, /recorder exited/);
});
