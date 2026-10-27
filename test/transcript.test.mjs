// The live transcript client (src/meetings/transcript.mjs) against a local ElevenLabs stand-in (fakeelevenlabs.mjs):
// the URL and key, partials (throttled) and finals with times, zero retention reported as it applied, reconnecting
// (previous_text, times carried on), errors that stop it, the daily cap; and the speech helpers (speech.mjs): WAV
// lengths, Supertonic and ElevenLabs text-to-speech requests. One test calls the real ElevenLabs API, only with
// ELEVENLABS_API_KEY set (a few seconds of audio).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { fileURLToPath } from 'url';
import { LiveTranscript, TranscriptUsage, realtimeUrl, EL_MODEL } from '../src/meetings/transcript.mjs';
import { synthesizeWav, splitSpeech, wavSeconds, parseWav, audioFormat, probeSeconds } from '../src/meetings/speech.mjs';
import { startFakeElevenLabs, tonePcm, toneWav } from './fakeelevenlabs.mjs';
import { tmpDir, until, sleep } from './helpers.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
let el;
before(async () => { el = await startFakeElevenLabs({ phrases: ['Hello Misha, this is a test.', 'Second sentence here.'] }); });
after(async () => { await el?.close(); });

const silence = (sec) => Buffer.alloc(Math.round(sec * 16000) * 2);
// A source that plays `pcm` in real time (100 ms steps, `speed` times faster), then silence until stopped.
function source(pcm, { speed = 4 } = {}) {
  const stream = new PassThrough();
  let done, at = 0;
  const exited = new Promise((r) => { done = r; });
  const t = setInterval(() => {
    const chunk = Buffer.alloc(3200);
    if (at < pcm.length) pcm.copy(chunk, 0, at, Math.min(pcm.length, at + 3200));
    at += 3200;
    stream.write(chunk);
  }, 100 / speed);
  return { stream, exited, error: () => null, stopped: false, async stop() { clearInterval(t); this.stopped = true; stream.end(); done(true); } };
}
const usage = (capMin = 60, file = path.join(tmpDir(), 'u.json')) => new TranscriptUsage({ file, tz: 'Europe/Vienna', capMin });
function live(src, opts = {}) {
  const ev = { partial: [], final: [], stopped: [] };
  const t = new LiveTranscript({
    apiKey: el.key, baseUrl: el.base, source: src, tenant: 'alice', usage: opts.usage || usage(), retryMs: 50, partials: opts.partials ?? true, limits: opts.limits,
    on: { partial: (s) => ev.partial.push({ ...s, t: Date.now() }), final: (s) => ev.final.push({ ...s, t: Date.now() }), stopped: (s) => ev.stopped.push(s) },
  });
  return { t: t.start(), ev };
}

test('realtimeUrl: Scribe v2 Realtime, PCM 16 kHz, VAD commits, word times, language detection, zero retention asked for', () => {
  const u = new URL(realtimeUrl('https://api.elevenlabs.io'));
  assert.equal(u.protocol, 'wss:');
  assert.equal(u.host, 'api.elevenlabs.io');
  assert.equal(u.pathname, '/v1/speech-to-text/realtime');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    model_id: EL_MODEL, audio_format: 'pcm_16000', commit_strategy: 'vad', vad_silence_threshold_secs: '1', include_timestamps: 'true',
    include_language_detection: 'true', enable_logging: 'false',
  });
  assert.equal(new URL(realtimeUrl('http://127.0.0.1:5')).protocol, 'ws:');
  assert.equal(u.searchParams.has('language_code'), false); // detected per segment
});

test('a stretch of speech: throttled partials with the coming seq, then one final with times and language; zero retention reported as not applied', async () => {
  const src = source(Buffer.concat([silence(1), tonePcm(3), silence(1.5)]), { speed: 1 });
  const { t, ev } = live(src);
  try {
    await until(() => ev.final.length === 1, 15_000);
    const c = el.conns.at(-1);
    assert.equal(c.query.model_id, EL_MODEL);
    assert.deepEqual([...c.sampleRates], [16000]);
    assert.ok(ev.partial.length >= 2, `partials ${ev.partial.length}`);
    for (const p of ev.partial) { assert.equal(p.final, false); assert.equal(p.seq, 1); }
    for (let i = 1; i < ev.partial.length; i++) {
      assert.ok(ev.partial[i].t - ev.partial[i - 1].t >= 450, 'at most two partials a second');
      assert.notEqual(ev.partial[i].text, ev.partial[i - 1].text);
    }
    const f = ev.final[0];
    assert.equal(f.seq, 1);
    assert.equal(f.final, true);
    assert.equal(f.text, 'Hello Misha, this is a test.');
    assert.equal(f.lang, 'en');
    assert.ok(Math.abs(f.start_s - 1) <= 0.3, `start ${f.start_s}`);
    assert.ok(f.end_s > 3 && f.end_s <= 4.1, `end ${f.end_s}`);
    assert.ok(f.lag_s >= 0 && f.lag_s < 3, `lag ${f.lag_s}`);
    const s = t.status();
    assert.equal(s.state, 'live');
    assert.equal(s.zero_retention, false);
    assert.match(s.warnings[0], /Zero retention mode was requested/);
    assert.equal(s.segments, 1);
    assert.deepEqual(t.since(0).map((x) => x.seq), [1]);
    assert.deepEqual(t.since(1), []);
  } finally { await t.stop('left'); }
  assert.equal(src.stopped, true);
  assert.deepEqual(ev.stopped, [{ reason: 'left' }]);
  await until(() => el.conns.at(-1).closed, 5000);
});

test('transcript_partials false: finals only', async () => {
  const { t, ev } = live(source(Buffer.concat([tonePcm(2), silence(1.5)])), { partials: false });
  try {
    await until(() => ev.final.length === 1, 15_000);
    assert.equal(ev.partial.length, 0);
  } finally { await t.stop('left'); }
});

test('a dropped connection is opened again: the audio meanwhile is sent, previous_text carries the last words, times go on', async () => {
  const src = source(Buffer.concat([tonePcm(1.5), silence(1.5), silence(1), tonePcm(1.5), silence(1.5)]), { speed: 2 });
  const { t, ev } = live(src);
  try {
    await until(() => ev.final.length === 1, 15_000);
    const n = el.conns.length;
    el.drop();
    await until(() => el.conns.length === n + 1 && t.status().state === 'live', 10_000);
    await until(() => ev.final.length === 2, 15_000);
    assert.deepEqual(el.conns.at(-1).previousText, [ev.final[0].text.slice(-50)]);
    assert.ok(ev.final[1].start_s > ev.final[0].end_s, `${ev.final[1].start_s} after ${ev.final[0].end_s}`);
    assert.ok(ev.final[1].start_s >= 3.5 && ev.final[1].start_s <= 4.6, `second segment at ${ev.final[1].start_s}`);
    assert.equal(ev.final[1].seq, 2);
  } finally { await t.stop('left'); }
});

test('an error a new connection would not fix stops it (auth_error); one it would (resource_exhausted) is retried', async () => {
  const a = live(source(silence(30)));
  await until(() => a.t.status().state === 'live', 5000);
  const n = el.conns.length;
  el.fail('resource_exhausted', 'busy');
  await until(() => el.conns.length === n + 1 && a.t.status().state === 'live', 10_000);
  el.fail('auth_error', 'invalid key');
  await until(() => a.ev.stopped.length === 1, 5000);
  assert.deepEqual(a.ev.stopped, [{ reason: 'error', error: 'auth_error: invalid key' }]);
  assert.equal(a.t.status().state, 'stopped');

  // A wrong key: HTTP 401 at the handshake, stopped at once.
  const ev = { stopped: [] };
  const src = source(silence(5));
  const b = new LiveTranscript({ apiKey: 'wrong-key-0123456789', baseUrl: el.base, source: src, tenant: 'alice', usage: usage(), retryMs: 50, on: { stopped: (s) => ev.stopped.push(s) } }).start();
  await until(() => ev.stopped.length === 1, 5000);
  assert.equal(ev.stopped[0].reason, 'error');
  assert.match(ev.stopped[0].error, /auth_error: HTTP 401/);
  assert.equal(src.stopped, true);
  assert.equal(b.status().state, 'stopped');
});

test('the daily cap: minutes are counted per tenant and day, survive a restart, and stop the stream when used up', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'usage.json');
  let now = Date.parse('2026-10-27T10:00:00Z');
  const u = new TranscriptUsage({ file, tz: 'Europe/Vienna', capMin: 1, now: () => now });
  u.add('alice', 58);
  u.save();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = new TranscriptUsage({ file, tz: 'Europe/Vienna', capMin: 1, now: () => now });
  assert.equal(again.used('alice'), 58);
  assert.equal(again.left('alice'), 2);
  assert.equal(again.left('bob'), 60);
  const { t, ev } = live(source(silence(20), { speed: 4 }), { usage: again });
  await until(() => ev.stopped.length === 1, 10_000);
  assert.deepEqual(ev.stopped, [{ reason: 'daily-cap' }]);
  assert.ok(again.used('alice') >= 60);
  assert.equal(t.status().today_min, 1);
  // The next local day starts from zero (Vienna midnight is 23:00 UTC in winter).
  now = Date.parse('2026-10-27T23:00:01Z');
  assert.equal(again.used('alice'), 0);
  // A tenant whose cap is used up gets no connection at all.
  const before = el.conns.length;
  const full = new TranscriptUsage({ file: path.join(dir, 'x.json'), tz: 'Europe/Vienna', capMin: 1 });
  full.add('alice', 60);
  const r = live(source(silence(1)), { usage: full });
  await until(() => r.ev.stopped.length === 1, 2000);
  assert.deepEqual(r.ev.stopped, [{ reason: 'daily-cap' }]);
  await sleep(200);
  assert.equal(el.conns.length, before);
});

test('splitSpeech: sentences, a long first one cut at a comma, the rest grouped', () => {
  assert.deepEqual(splitSpeech('Hi Misha, this is Glassy. I can hear you well, shall we start?'), ['Hi Misha, this is Glassy.', 'I can hear you well, shall we start?']);
  assert.deepEqual(splitSpeech('One sentence only'), ['One sentence only']);
  assert.deepEqual(splitSpeech('Привіт, Міша! Як справи? Добре.'), ['Привіт, Міша!', 'Як справи? Добре.']);
  const long = 'A really long first sentence that goes on and on, with a comma somewhere in the middle of it, and more words after.';
  assert.deepEqual(splitSpeech(`${long}\nNext line`), ['A really long first sentence that goes on and on,', 'with a comma somewhere in the middle of it, and more words after. Next line']);
  assert.deepEqual(splitSpeech('  '), ['']);
});

test('parseWav reads the header (also a LIST chunk first, a streamed size); synthesizeWav: Supertonic (wav, voice, lang) and ElevenLabs (voice id, key, flash model, zero retention asked)', async () => {
  assert.equal(wavSeconds(toneWav(1.5)), 1.5);
  assert.equal(wavSeconds(Buffer.from('not a wav file at all, not even close to one....')), null);
  const streamed = toneWav(1); streamed.writeUInt32LE(0xffffffff, 40);
  assert.equal(wavSeconds(streamed), 1);
  const t = toneWav(0.5);
  const list = Buffer.concat([t.subarray(0, 36), Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO'), t.subarray(36)]);
  assert.deepEqual({ ...parseWav(list), data: null }, { format: 1, channels: 1, rate: 24000, byteRate: 48000, bits: 16, data: null, seconds: 0.5 });
  const fx = fs.readFileSync(path.join(FIXTURES, 'speech-en.wav'));
  assert.ok(Math.abs(wavSeconds(fx) - 6.8) < 0.05);

  const cfg = { ttsUrl: el.base, elevenlabs: { apiKey: el.key, baseUrl: el.base, voice: null } };
  const a = await synthesizeWav(cfg, { text: 'Hello there everyone', voice: 'supertonic-M2', lang: 'en' });
  assert.ok(Math.abs(a.seconds - 0.9) < 0.01);
  assert.deepEqual(a.pcm, { rate: 24000, channels: 1 });
  assert.equal(a.data.length, 0.9 * 24000 * 2);
  assert.equal(a.voice, 'supertonic-M2');
  assert.deepEqual({ ...el.st.speech.at(-1), at: 0 }, { input: 'Hello there everyone', voice: 'supertonic-M2', lang: 'en', response_format: 'wav', at: 0 });
  await assert.rejects(synthesizeWav(cfg, { text: 'x', voice: 'alloy' }), /voice must be one of supertonic-F1/);
  await assert.rejects(synthesizeWav({}, { text: 'x' }), /no TTS service configured/);

  const b = await synthesizeWav(cfg, { text: 'Привіт', backend: 'elevenlabs', lang: 'uk' });
  assert.equal(b.voice, 'EXAVITQu4vr4xnSDxMaL');
  const req = el.st.tts.at(-1);
  assert.equal(req.voice, 'EXAVITQu4vr4xnSDxMaL');
  assert.deepEqual(req.query, { output_format: 'wav_24000', enable_logging: 'false' });
  assert.deepEqual(req.body, { text: 'Привіт', model_id: 'eleven_flash_v2_5', language_code: 'uk' });
  await assert.rejects(synthesizeWav({ ...cfg, elevenlabs: { ...cfg.elevenlabs, apiKey: 'wrong-key-0123456789' } }, { text: 'x', backend: 'elevenlabs' }), /ElevenLabs text-to-speech answered HTTP 401/);
  await assert.rejects(synthesizeWav({ ttsUrl: 'http://127.0.0.1:9' }, { text: 'x' }), /supertonic could not be reached/);
});

test('a timestamped copy that comes late, or before its committed_transcript, makes no second segment', async () => {
  for (const [k, v] of [['stampDelayMs', 2500], ['stampFirst', true]]) {
    el.st[k] = v;
    const { t, ev } = live(source(Buffer.concat([tonePcm(1.5), silence(1.5), tonePcm(1.5), silence(4)]), { speed: 2 }));
    try {
      await until(() => ev.final.length >= 2, 15_000);
      await sleep(3000);
      assert.equal(ev.final.length, 2, `${k}: ${JSON.stringify(ev.final.map((f) => [f.seq, f.text, f.end_s]))}`);
      assert.deepEqual(ev.final.map((f) => f.seq), [1, 2]);
      // A partial is numbered as the segment its final will be, also while the one before waits for its copy.
      assert.equal(ev.partial[0].seq, 1, k);
      assert.equal(ev.partial.filter((p) => p.t < ev.final[1].t).at(-1).seq, 2, `${k}: partials of the second segment are #2`);
      assert.deepEqual([...new Set(ev.partial.map((p) => p.seq))], [1, 2], k);
      assert.ok(ev.final[1].start_s >= ev.final[0].end_s, `${k}: times go forward ${JSON.stringify(ev.final)}`);
    } finally { el.st[k] = k === 'stampFirst' ? false : 0; await t.stop('left'); }
  }
});

test('a server that never starts the session, or stops reading the audio, is given up and connected again', async () => {
  el.st.silent = true;
  const n = el.conns.length;
  const a = live(source(silence(30)), { limits: { startMs: 300 } });
  await until(() => el.conns.length >= n + 2, 5000);
  assert.notEqual(a.t.status().state, 'live');
  await a.t.stop('left');
  el.st.silent = false;

  el.st.stall = true;
  const m = el.conns.length;
  const b = live(source(silence(600), { speed: 40 }), { limits: { unsentBytes: 64 * 1024, stallMs: 500 } });
  try {
    await until(() => el.conns.length >= m + 1 && el.conns.at(-1).stalled, 5000);
    el.st.stall = false;
    await until(() => el.conns.length >= m + 2 && b.t.status().state === 'live', 10_000);
  } finally { el.st.stall = false; await b.t.stop('left'); }
});

test('errors after sessions that lasted never add up to giving up', async () => {
  const { t, ev } = live(source(silence(120)), { limits: { shortSessionMs: 200 } });
  try {
    for (let i = 0; i < 11; i++) {
      await until(() => t.status().state === 'live', 5000);
      await sleep(300);
      el.fail('resource_exhausted', 'busy');
      await until(() => t.status().state !== 'live', 2000);
    }
    await until(() => t.status().state === 'live', 5000);
    assert.equal(ev.stopped.length, 0);
    assert.ok(t.failures <= 1, `failures ${t.failures}`);
  } finally { await t.stop('left'); }
});

test('a partial still waiting for its turn when its segment is committed is dropped, not sent as the next segment', async () => {
  const ev = { partial: [], final: [] };
  const t = new LiveTranscript({ apiKey: el.key, baseUrl: el.base, source: source(silence(1)), tenant: 'alice', usage: usage(), on: { partial: (s) => ev.partial.push(s), final: (s) => ev.final.push(s) } });
  t.onMessage({ message_type: 'partial_transcript', text: 'Hello' });
  t.onMessage({ message_type: 'partial_transcript', text: 'Hello Misha' }); // throttled: waits
  t.onMessage({ message_type: 'committed_transcript', text: 'Hello Misha, hi.' });
  await sleep(700);
  assert.deepEqual(ev.partial.map((p) => [p.seq, p.text]), [[1, 'Hello']]);
  t.onMessage({ message_type: 'committed_transcript_with_timestamps', text: 'Hello Misha, hi.', words: [] });
  t.onMessage({ message_type: 'partial_transcript', text: 'Next' });
  assert.deepEqual(ev.final.map((f) => [f.seq, f.text]), [[1, 'Hello Misha, hi.']]);
  assert.deepEqual(ev.partial.at(-1).seq, 2);
  await t.stop('left');
});

test('a committed text still waiting for its copy when the transcript stops is kept (not when discarded)', async () => {
  for (const discard of [false, true]) {
    const ev = { final: [] };
    const t = new LiveTranscript({ apiKey: el.key, baseUrl: el.base, source: source(silence(1)), tenant: 'alice', usage: usage(), on: { final: (s) => ev.final.push(s) } });
    t.onMessage({ message_type: 'committed_transcript', text: 'Last words before the end.' });
    await t.stop('ended', null, { discard });
    assert.deepEqual(t.since(0).map((f) => [f.seq, f.text]), discard ? [] : [[1, 'Last words before the end.']], `discard ${discard}`);
    assert.equal(ev.final.length, discard ? 0 : 1);
  }
});

test('many copies late: plain texts made into finals and dropped from the queue still swallow their copies', async () => {
  const ev = { final: [] };
  const t = new LiveTranscript({ apiKey: el.key, baseUrl: el.base, source: source(silence(1)), tenant: 'alice', usage: usage(), on: { final: (s) => ev.final.push(s) } });
  for (let i = 1; i <= 60; i++) t.onMessage({ message_type: 'committed_transcript', text: `Segment ${i}.` });
  await sleep(1700); // all made into finals without their copies
  for (let i = 1; i <= 60; i++) t.onMessage({ message_type: 'committed_transcript_with_timestamps', text: `Segment ${i}.`, words: [] });
  t.onMessage({ message_type: 'committed_transcript', text: 'Segment 61.' });
  t.onMessage({ message_type: 'committed_transcript_with_timestamps', text: 'Segment 61.', words: [] });
  assert.deepEqual(ev.final.map((f) => f.seq), Array.from({ length: 61 }, (_, i) => i + 1));
  assert.equal(ev.final.at(-1).text, 'Segment 61.');
  await t.stop('left');
});

test('NODE_DEBUG set: no connection with the key (Node would log its headers)', async () => {
  const n = el.conns.length;
  process.env.NODE_DEBUG = 'net';
  try {
    const { ev } = live(source(silence(2)));
    await until(() => ev.stopped.length === 1, 3000);
    assert.equal(ev.stopped[0].reason, 'error');
    assert.match(ev.stopped[0].error, /NODE_DEBUG is set/);
    assert.equal(el.conns.length, n);
    await assert.rejects(synthesizeWav({ elevenlabs: { apiKey: el.key, baseUrl: el.base } }, { text: 'x', backend: 'elevenlabs' }), /NODE_DEBUG is set/);
  } finally { delete process.env.NODE_DEBUG; }
});

test('a tenant named __proto__ is counted and capped like any other', () => {
  const file = path.join(tmpDir(), 'u.json');
  const u = new TranscriptUsage({ file, tz: 'Europe/Vienna', capMin: 1 });
  u.add('__proto__', 100);
  assert.equal(u.used('__proto__'), 100);
  assert.equal(u.left('__proto__'), 0);
  assert.equal(u.used('alice'), 0);
  u.save();
  const again = new TranscriptUsage({ file, tz: 'Europe/Vienna', capMin: 1 });
  assert.equal(again.used('__proto__'), 100);
  assert.equal(Object.getPrototypeOf(again.state.tenants), null);
});

test('uploaded audio: only self-contained containers, read with a fixed demuxer (a playlist could pull in other files)', async () => {
  const dir = tmpDir();
  const f = (name, bytes) => { const p = path.join(dir, name); fs.writeFileSync(p, bytes); return p; };
  assert.equal(audioFormat(f('a.wav', toneWav(0.5))), 'wav');
  assert.equal(audioFormat(f('a.ogg', Buffer.from('OggS\0\x02xxxxxxxxxx'))), 'ogg');
  assert.equal(audioFormat(f('a.mp3', Buffer.from('ID3\x04\0\0\0\0\0\0xxxxxx'))), 'mp3');
  assert.equal(audioFormat(f('a.m4a', Buffer.from('\0\0\0\x20ftypM4A xxxxxxxx'))), 'mov');
  const secret = f('secret.wav', toneWav(2));
  const m3u8 = f('list.m3u8', `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:2,\n${secret}\n#EXT-X-ENDLIST\n`);
  assert.equal(audioFormat(m3u8), null);
  assert.equal(audioFormat(f('c.txt', 'ffconcat version 1.0\nfile secret.wav\n')), null);
  assert.equal(audioFormat(path.join(dir, 'missing')), null);
  assert.equal(await probeSeconds(secret, 'wav'), 2);
  // A playlist renamed as WAV doesn't pass either: the demuxer is fixed.
  assert.equal(await probeSeconds(m3u8, 'wav'), null);
});

test('a TTS body larger than 50 MB is cut off, not held in memory', async () => {
  el.st.hugeTts = true;
  try {
    await assert.rejects(synthesizeWav({ ttsUrl: el.base }, { text: 'x' }), /sent more than 52428800 bytes of audio/);
  } finally { el.st.hugeTts = false; }
});

// The real thing: a few seconds of English speech to ElevenLabs. Costs about $0.001.
test('ElevenLabs for real: the speech fixture comes back as text', { skip: !process.env.ELEVENLABS_API_KEY && 'ELEVENLABS_API_KEY not set' }, async () => {
  const pcm = fs.readFileSync(path.join(FIXTURES, 'speech-en.wav')).subarray(44);
  const ev = { partial: [], final: [], stopped: [] };
  const t = new LiveTranscript({
    apiKey: process.env.ELEVENLABS_API_KEY, baseUrl: 'https://api.elevenlabs.io', source: source(Buffer.concat([pcm, silence(3)]), { speed: 1 }), tenant: 'test', usage: usage(),
    on: { partial: (s) => ev.partial.push(s), final: (s) => ev.final.push(s), stopped: (s) => ev.stopped.push(s) },
  }).start();
  try {
    await until(() => ev.final.length >= 1 && /vienna/i.test(ev.final.map((f) => f.text).join(' ')), 25_000);
    const text = ev.final.map((f) => f.text).join(' ');
    assert.match(text, /misha/i);
    assert.match(text, /live transcript/i);
    assert.equal(ev.final[0].lang, 'en');
    assert.ok(ev.partial.length >= 1);
    const s = t.status();
    console.log(`real ElevenLabs: ${ev.final.length} finals, partials ${ev.partial.length}, final lag ${JSON.stringify(s.final_lag_s)}, zero_retention ${s.zero_retention}`);
  } finally { await t.stop('left'); }
});
