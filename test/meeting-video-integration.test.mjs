// Full Linux meeting harness: real browser page + private PulseAudio + ffmpeg; no external meeting service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet } from './fakemeet.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { audioUnsupported } from '../src/meetings/audio.mjs';
import { videoUnsupported } from '../src/meetings/video.mjs';

const why = await audioUnsupported() || await videoUnsupported() || (!process.env.DISPLAY ? 'run under xvfb-run' : null);
test('meeting page and private meeting audio are in separate downloadable Ogg and WebM with audio-aligned timeline', { skip: why || false }, async (t) => {
  const fake = await startFakeMeet({ tone: true });
  let svc;
  t.after(async () => { await svc?.stop(); await fake.close(); });
  svc = await startBosun({ HEADLESS: '0', KEEPALIVE: '0', ENGINE: process.env.ENGINE || 'chromium' }, {
    meetings: { platformFor: (u) => u.startsWith(fake.base) ? meet : null, pollMs: 200 },
  });
  const c = await connect(svc), room = fake.newRoom(); fake.open(room.code);
  t.after(() => c.close());
  const r = await c.call('meeting_join', { url: room.url, record_video: true });
  assert.equal(r.isError, false, r.text);
  const id = r.json().meeting_id;
  await until(async () => (await c.call('meeting_status', { meeting_id: id })).json().state === 'recording', 30000);
  await sleep(6500);
  const ended = (await c.call('meeting_leave', { meeting_id: id })).json();
  assert.equal(ended.video.on, false); assert.ok(ended.video.bytes > 1000);
  const meta = (await c.call('recording_get', { meeting_id: id })).json();
  assert.equal(meta.mime, 'audio/ogg'); assert.equal(meta.video.mime, 'video/webm'); assert.equal(meta.speakers.alignment, 'pulse-input-timestamp');
  const downloaded = await fetch(meta.video.url); assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'video/webm');
  const bytes = Buffer.from(await downloaded.arrayBuffer()); assert.equal(bytes.length, ended.video.bytes);
  const audioFile = ended.recording.path, file = audioFile.replace(/\.ogg$/, '.webm');
  assert.ok(fs.existsSync(audioFile));
  const audioInfo = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', audioFile]));
  assert.deepEqual(audioInfo.streams.map((s) => s.codec_name), ['opus']);
  assert.equal(audioInfo.streams[0].channels, 1);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]));
  assert.deepEqual(info.streams.map((s) => s.codec_name).sort(), ['opus', 'vp9']);
  const audio = execFileSync('ffmpeg', ['-v', 'error', '-i', audioFile, '-map', '0:a', '-ar', '16000', '-f', 's16le', 'pipe:1']);
  assert.ok(audio.length / 32000 > 4, 'audio spans the recording');
  let sum = 0; for (let i = 0; i < audio.length; i += 2) sum += audio.readInt16LE(i) ** 2;
  assert.ok(Math.sqrt(sum / (audio.length / 2)) > 100, 'meeting tone is audible');
  assert.ok(Math.abs(meta.speakers.recording_seconds - audio.length / 32000) < 0.6);
  await c.call('meeting_recording_delete', { meeting_id: id }); assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(audioFile), false); assert.equal(fs.existsSync(audioFile.replace(/\.ogg$/, '.speakers.json')), false);
  await c.close();
});
