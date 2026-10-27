// The real audio path for speaking and the live transcript (Linux with PulseAudio, ffmpeg and a display, e.g. under
// xvfb-run; skipped elsewhere), with chromium and patchright:
// - meeting_speak: what Bosun plays goes into the meeting browser's microphone. The Meet stand-in listens to its
//   microphone (getUserMedia -> analyser) and reports what it hears while unmuted: nothing before, the speech after,
//   with the time from the call to the first sound (the speak latency, TTS from a local stand-in).
// - live transcript: the stand-in plays a recorded sentence as the meeting's audio; it reaches the transcript through
//   the meeting's own audio server. With ELEVENLABS_API_KEY set it goes to ElevenLabs for real and the words must come
//   back; otherwise to the local ElevenLabs stand-in.
//   docker build -f docker/meeting-test.Dockerfile -t bosun-meeting-test docker
//   docker run --rm -v "$PWD":/app -w /app bosun-meeting-test xvfb-run -a node --test test/meeting-voice.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet } from './fakemeet.mjs';
import { startFakeElevenLabs } from './fakeelevenlabs.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { audioUnsupported } from '../src/meetings/audio.mjs';

const ENGINE = process.env.ENGINE || 'chromium';
const REAL_EL = process.env.ELEVENLABS_API_KEY || null;
const why = (await audioUnsupported()) || (!process.env.DISPLAY ? 'no display (run under xvfb-run)' : null) ||
  (!['chromium', 'patchright'].includes(ENGINE) ? `engine ${ENGINE}: meetings run on chromium and patchright` : null);

let fake, el;
before(async () => { if (!why) { fake = await startFakeMeet(); el = await startFakeElevenLabs({ phrases: ['Hello Misha. This is a short test of the live transcript.'] }); } });
after(async () => { await fake?.close(); await el?.close(); });

async function withService(fn) {
  const svc = await startBosun({
    KEEPALIVE: '0', HEADLESS: '0', ENGINE, TTS_URL: el.base,
    ...(REAL_EL ? { ELEVENLABS_API_KEY: REAL_EL } : { ELEVENLABS_API_KEY: el.key, ELEVENLABS_BASE_URL: el.base }),
  }, { meetings: { platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 300 } });
  try { return await fn(svc); } finally { await svc.stop(); }
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();
async function admitted(c, args = {}) {
  const { code, url } = fake.newRoom();
  const r = await c.call('meeting_join', { url, engine: ENGINE, ...args });
  assert.equal(r.isError, false, r.text);
  const id = r.json().meeting_id;
  fake.admit(code);
  await until(async () => (await status(c, id)).state === 'recording', 30_000);
  return { id, code, room: fake.room(code) };
}

test(`${ENGINE}: meeting_speak is heard through the browser's microphone, and only while unmuted`, { skip: why || false }, async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const { id, room } = await admitted(c);
    await until(() => room.media.length || room.heard.length, 5000).catch(() => {});
    await sleep(1500);
    assert.deepEqual(room.heard.filter((h) => !h.error), [], 'a muted, silent microphone is not heard');
    assert.deepEqual(room.heard.filter((h) => h.error), [], 'the page got the microphone');
    const lat = [];
    for (let i = 0; i < 3; i++) {
      const from = room.heard.length;
      const t0 = Date.now();
      const r = await c.call('meeting_speak', { meeting_id: id, text: 'This is Glassy speaking in the meeting now.', wait: true });
      assert.equal(r.isError, false, r.text);
      const s = r.json();
      assert.equal(s.state, 'done');
      const heard = room.heard.slice(from);
      assert.ok(heard.length >= 5, `heard ${heard.length} times`);
      lat.push({ heard_ms: heard[0].at - t0, start_ms: s.start_ms, prepare_ms: s.prepare_ms });
      // Heard for about as long as it played (the stand-in TTS: 2.4 s of tone), and not after it was muted again.
      const span = heard.at(-1).at - heard[0].at;
      assert.ok(span > 1500 && span < 3500, `heard for ${span} ms`);
      await sleep(800);
      const after = room.heard.length;
      await sleep(800);
      assert.equal(room.heard.length, after, 'nothing heard once it is muted again');
    }
    console.log(`${ENGINE} speak latency (call -> first sound in the page, local TTS stand-in): ${JSON.stringify(lat)}`);
    for (const l of lat) assert.ok(l.heard_ms < 2500, `heard after ${l.heard_ms} ms`);
    // Several sentences: one player, fed while it plays; heard for the whole of it.
    {
      const from = room.heard.length;
      const r = (await c.call('meeting_speak', { meeting_id: id, text: 'First part of it here. Then the second part follows. And a third one.', wait: true })).json();
      assert.equal(r.state, 'done');
      assert.equal(r.pieces, 2);
      const heard = room.heard.slice(from);
      const span = heard.at(-1).at - heard[0].at;
      assert.ok(span > r.duration_s * 1000 - 800 && span < r.duration_s * 1000 + 800, `heard for ${span} ms of ${r.duration_s} s`);
    }
    // Barge-in: cut off within a moment.
    const from = room.heard.length;
    await c.call('meeting_speak', { meeting_id: id, text: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen' });
    await until(() => room.heard.length > from, 5000);
    const cut = Date.now();
    await c.call('meeting_stop_speaking', { meeting_id: id });
    await sleep(1200);
    const lastHeard = room.heard.at(-1).at;
    assert.ok(lastHeard - cut < 800, `still heard ${lastHeard - cut} ms after the stop`);
    await c.close();
  });
});

test(`${ENGINE}: the meeting's audio reaches the live transcript${REAL_EL ? ' (ElevenLabs for real)' : ''}`, { skip: why || false }, async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const conns = el.conns.length;
    const { id, code } = await admitted(c, { live_transcript: true });
    await until(async () => (await status(c, id)).live_transcript.state === 'live', 15_000);
    const t0 = Date.now();
    fake.play(code, 'speech-en');
    const seen = [];
    svc.events.on('meeting-transcript', (e) => seen.push({ ...e, t: Date.now() }));
    await until(async () => (await c.call('meeting_transcript', { meeting_id: id })).json().segments.some((s) => /vienna|transcript/i.test(s.text)), 40_000);
    const segs = (await c.call('meeting_transcript', { meeting_id: id })).json().segments;
    const text = segs.map((s) => s.text).join(' ');
    if (REAL_EL) {
      assert.match(text, /misha/i);
      assert.match(text, /live transcript/i);
    } else {
      assert.equal(el.conns.length, conns + 1);
      assert.ok(el.conns.at(-1).bytes > 32000 * 5, `${el.conns.at(-1).bytes} bytes of audio`);
    }
    const s = (await status(c, id)).live_transcript;
    const firstPartial = seen.find((e) => !e.final), firstFinal = seen.find((e) => e.final);
    console.log(`${ENGINE} transcript: ${JSON.stringify({ text, first_partial_ms: firstPartial ? firstPartial.t - t0 : null, first_final_ms: firstFinal ? firstFinal.t - t0 : null, final_lag_s: s.final_lag_s, zero_retention: s.zero_retention, streamed_min: s.streamed_min })}`);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});
