// Live transcript and speaking, through MCP, against the Meet and Zoom stand-ins (fakemeet.mjs, fakezoom.mjs), a fake
// audio backend (its capture plays what the test queues, its player "plays" files) and a local ElevenLabs/Supertonic
// stand-in (fakeelevenlabs.mjs): the transcript starts only after the announcement (which then says so), its text
// arrives as bosun:meeting-transcript events and meeting_transcript, an opt-out stops recording and transcript at
// once, the daily cap and a missing key are refused up front; meeting_speak unmutes, plays, mutes again, can be
// cut off or interrupted, uses Supertonic, ElevenLabs or an uploaded file; meeting_mute and meeting_raise_hand on Meet
// and Zoom. The real audio path (PulseAudio, the browser's microphone) is in meeting-voice.test.mjs (Linux).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { startBosun, connect, until, sleep, ENGINE, TOKEN_B } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { startFakeZoom } from './fakezoom.mjs';
import { startFakeElevenLabs, tonePcm, toneWav } from './fakeelevenlabs.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { zoom, parseZoomUrl, zoomWebClientUrl } from '../src/meetings/platforms/zoom.mjs';
import { announcement, CONFIRM_DELETED_LIVE } from '../src/meetings/index.mjs';
import { MEETING_SET } from '../src/events.mjs';

let fake, fz, el;
before(async () => { [fake, fz, el] = await Promise.all([startFakeMeet(), startFakeZoom(), startFakeElevenLabs({ phrases: ['Hello Misha, this is a test.'] })]); });
after(async () => { await Promise.all([fake?.close(), fz?.close(), el?.close()]); });

const MCPL = { experimental: { mcpl: { version: '0.5', pushEvents: true } } };
const zoomPlatform = () => ({ ...zoom, accountUrl: `${fz.base}/profile`, joinUrl: (u) => zoomWebClientUrl(u).replace('https://app.zoom.us', fz.base), origins: () => [fz.base] });

async function withService(fn, { env = {}, el: withEl = true, meetings = {} } = {}) {
  const audio = fakeAudio();
  const zp = zoomPlatform();
  const svc = await startBosun({ KEEPALIVE: '0', ...(withEl ? { ELEVENLABS_API_KEY: el.key, ELEVENLABS_BASE_URL: el.base } : {}), TTS_URL: el.base, ...env }, {
    meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : zoom.matches(u) ? zp : null), pollMs: 200, ...meetings },
  });
  const ev = { transcript: [], 'transcript-stopped': [], speech: [], optout: [], ended: [] };
  for (const k of Object.keys(ev)) svc.events.on(`meeting-${k}`, (e) => ev[k].push(e));
  try { return await fn(svc, ev, audio); } finally { await svc.stop(); }
}
// An MCPL host connection that records push/event.
async function host(svc) {
  const c = await connect(svc, undefined, { capabilities: MCPL });
  c.pushes = [];
  c.setRequestHandler(z.object({ method: z.literal('push/event'), params: z.any() }), async (r) => { c.pushes.push(r.params); return { accepted: true }; });
  await c.request({ method: 'featureSets/update', params: { enabled: [MEETING_SET], effectiveCapabilities: ['tools', 'pushEvents'] } }, z.any());
  return c;
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();
async function admitted(c, { live = true, ...more } = {}) {
  const { code, url } = fake.newRoom();
  const r = await c.call('meeting_join', { url, ...(live ? { live_transcript: true } : {}), ...more });
  assert.equal(r.isError, false, r.text);
  const id = r.json().meeting_id;
  fake.admit(code);
  await until(async () => (await status(c, id)).state === 'recording', 15_000);
  return { id, code };
}
const media = (code, key) => fake.room(code).media.filter((m) => key in m).map((m) => m[key]);

test('live transcript: announced first, then the text arrives as events (partials, finals) and through meeting_transcript', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const conns = el.conns.length;
    const { code, url } = fake.newRoom();
    const id = (await c.call('meeting_join', { url, live_transcript: true })).json().meeting_id;
    await sleep(500);
    assert.equal(el.conns.length, conns, 'nothing goes to ElevenLabs before admission');
    fake.admit(code);
    await until(() => el.conns.length === conns + 1, 15_000);
    // The chat heard about it first, in words that say so.
    const room = fake.room(code);
    assert.deepEqual(room.chat.map((m) => m.text), announcement('Glassy (notetaker)', null, { live: true }));
    assert.match(room.chat[0].text, /recorded and transcribed live/);
    assert.match(room.chat[1].text, /aufgezeichnet und live transkribiert/);
    assert.ok(el.conns.at(-1).sent.length && audio.captures.length === 1);
    assert.equal(el.conns.at(-1).query.enable_logging, 'false');

    audio.say(Buffer.concat([tonePcm(2.5)]));
    await until(() => c.pushes.some((p) => p.tags.includes('bosun:meeting-transcript') && p.origin.final), 15_000);
    const pushes = c.pushes.filter((p) => p.tags.includes('bosun:meeting-transcript'));
    const fin = pushes.find((p) => p.origin.final);
    assert.ok(pushes.some((p) => !p.origin.final), 'partials too');
    assert.deepEqual(fin.tags, ['bosun:meeting-transcript', `bosun:meeting=${id}`, 'bosun:platform=meet']);
    assert.equal(fin.featureSet, MEETING_SET);
    assert.equal(fin.origin.text, 'Hello Misha, this is a test.');
    assert.equal(fin.origin.seq, 1);
    assert.equal(fin.origin.lang, 'en');
    assert.ok(fin.origin.end_s > fin.origin.start_s);
    assert.match(fin.payload.content[0].text, new RegExp(`^Meeting ${id} said \\(#1, [\\d.]+-[\\d.]+ s\\): Hello Misha`));

    const t = (await c.call('meeting_transcript', { meeting_id: id })).json();
    assert.equal(t.segments.length, 1);
    assert.equal(t.segments[0].text, 'Hello Misha, this is a test.');
    assert.deepEqual((await c.call('meeting_transcript', { meeting_id: id, since: 1 })).json().segments, []);
    const s = (await status(c, id)).live_transcript;
    assert.equal(s.state, 'live');
    assert.equal(s.zero_retention, false);
    assert.equal(s.model, 'scribe_v2_realtime');
    assert.equal(s.daily_cap_min, 180);
    // Another tenant sees none of it.
    const b = await connect(svc, TOKEN_B);
    assert.match((await b.call('meeting_transcript', { meeting_id: id })).text, /no meeting/);
    await b.close();

    // Transcript text is never queued for later: with no connection there, it is gone (meeting_transcript has it).
    await c.close();
    audio.say(tonePcm(2));
    await until(() => ev.transcript.some((e) => e.final && e.seq === 2), 15_000);
    assert.equal((svc.events.pending.get('alice') || []).filter((i) => i.params.tags.includes('bosun:meeting-transcript')).length, 0);
    const c2 = await connect(svc);
    assert.deepEqual((await c2.call('meeting_transcript', { meeting_id: id, since: 1 })).json().segments.map((x) => x.seq), [2]);
    await c2.call('meeting_leave', { meeting_id: id });
    await until(() => ev.ended.length === 1);
    assert.equal(audio.captures[0].stopped, true);
    await until(() => el.conns.at(-1).closed);
    assert.equal((await status(c2, id)).live_transcript.state, 'stopped');
    assert.equal(ev['transcript-stopped'].length, 0, 'the end of the meeting is bosun:meeting-ended, not a transcript event');
    await c2.close();
  });
});

test('an opt-out in the chat stops the recording and the live transcript at once; its text is forgotten', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { id, code } = await admitted(c, { leave_on_optout: false });
    audio.say(tonePcm(2));
    await until(async () => (await c.call('meeting_transcript', { meeting_id: id })).json().segments.length === 1, 15_000);
    fake.say(code, 'Alex', "please don't record this");
    await until(() => ev.optout.length === 1, 10_000);
    assert.equal(audio.recorders[0].killed, true);
    assert.equal(audio.captures[0].stopped, true);
    await until(() => el.conns.at(-1).closed);
    await until(() => fake.room(code).chat.some((m) => m.text === CONFIRM_DELETED_LIVE));
    const t = (await c.call('meeting_transcript', { meeting_id: id })).json();
    assert.deepEqual(t.segments, []);
    assert.equal(t.live_transcript.state, 'stopped');
    assert.equal(t.live_transcript.reason, 'opted-out');
    await until(() => ev['transcript-stopped'].length === 1);
    assert.equal(ev['transcript-stopped'][0].reason, 'opted-out');
    // Staying in the call unrecorded: nothing starts again.
    await sleep(600);
    assert.equal(audio.captures.length, 1);
    assert.equal((await status(c, id)).state, 'admitted');
    await c.close();
  });
});

test('meeting_stop_recording stops the transcript too; meeting_recording_delete forgets its text', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { id } = await admitted(c);
    audio.say(tonePcm(2));
    await until(async () => (await c.call('meeting_transcript', { meeting_id: id })).json().segments.length === 1, 15_000);
    const r = (await c.call('meeting_stop_recording', { meeting_id: id, delete: false })).json();
    assert.equal(r.live_transcript_stopped, true);
    assert.equal(audio.captures[0].stopped, true);
    assert.equal((await c.call('meeting_transcript', { meeting_id: id })).json().segments.length, 1); // kept, like the file
    await until(() => ev['transcript-stopped'].length === 1);
    assert.equal(ev['transcript-stopped'][0].reason, 'stopped');
    await c.call('meeting_recording_delete', { meeting_id: id });
    assert.deepEqual((await c.call('meeting_transcript', { meeting_id: id })).json().segments, []);
    await c.close();
  });
});

test('meeting_recording_delete before admission: the meeting never records or streams once admitted', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    const id = (await c.call('meeting_join', { url, live_transcript: true })).json().meeting_id;
    await c.call('meeting_recording_delete', { meeting_id: id });
    const conns = el.conns.length;
    fake.admit(code);
    await until(async () => (await status(c, id)).state === 'admitted' && fake.room(code).chat.length >= 2, 15_000);
    await sleep(1000);
    assert.equal(audio.recorders.length, 0);
    assert.equal(audio.captures.length, 0);
    assert.equal(el.conns.length, conns);
    assert.equal((await status(c, id)).live_transcript.state, 'off');
    await c.close();
  });
});

test('live transcript refused up front: no ElevenLabs key, or the daily minutes used up; a meeting without it has none', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const { url } = fake.newRoom();
    assert.match((await c.call('meeting_join', { url, live_transcript: true })).text, /live_transcript needs ElevenLabs \(ELEVENLABS_API_KEY/);
    const { id } = await admitted(c, { live: false });
    assert.match((await c.call('meeting_transcript', { meeting_id: id })).text, /has no live transcript/);
    assert.equal((await status(c, id)).live_transcript, undefined);
    assert.match(fake.room((await status(c, id)).url.split('/').pop()).chat[0].text, /I'm recording audio for notes\./);
    await c.close();
  }, { el: false });
  await withService(async (svc) => {
    svc.meetings.usage.add('alice', 60);
    const c = await connect(svc);
    const { url } = fake.newRoom();
    assert.match((await c.call('meeting_join', { url, live_transcript: true })).text, /daily live transcript limit \(1 min\) is used up/);
    await c.close();
  }, { env: { LIVE_TRANSCRIPT_DAILY_MIN: '1' } });
});

test('the daily cap reached during a meeting stops the stream with an event; the meeting and the recording go on', async () => {
  await withService(async (svc, ev, audio) => {
    svc.meetings.usage.add('alice', 58);
    const c = await connect(svc);
    const { id } = await admitted(c);
    await until(() => ev['transcript-stopped'].length === 1, 10_000);
    assert.equal(ev['transcript-stopped'][0].reason, 'daily-cap');
    const s = await status(c, id);
    assert.equal(s.state, 'recording');
    assert.equal(s.live_transcript.reason, 'daily-cap');
    assert.equal(audio.captures[0].stopped, true);
    await c.close();
  }, { env: { LIVE_TRANSCRIPT_DAILY_MIN: '1' } });
});

test('meeting_speak: refused before admission; unmutes, plays the synthesized text, mutes again; wait, events, durations', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { code, url } = fake.newRoom();
    const id = (await c.call('meeting_join', { url })).json().meeting_id;
    assert.match((await c.call('meeting_speak', { meeting_id: id, text: 'too early' })).text, /is waiting; speaking is possible once admitted/);
    fake.admit(code);
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    assert.deepEqual(media(code, 'mic'), [], 'the call starts muted');
    const r = await c.call('meeting_speak', { meeting_id: id, text: 'Hi everyone, this is Glassy.', voice: 'supertonic-F2', lang: 'en' });
    assert.equal(r.isError, false, r.text);
    const s = r.json();
    assert.equal(s.speaking, true);
    assert.equal(s.source, 'supertonic');
    assert.equal(s.voice, 'supertonic-F2');
    assert.equal(s.duration_s, 1.5);
    assert.equal(s.unmuted, true);
    assert.ok(s.start_ms >= s.prepare_ms && s.start_ms < 5000);
    assert.deepEqual(media(code, 'mic'), [true], 'unmuted before it plays');
    assert.equal(el.st.speech.at(-1).input, 'Hi everyone, this is Glassy.');
    assert.equal(s.pieces, 1);
    assert.equal(audio.players.length, 1);
    assert.deepEqual(audio.players[0].pcm, { rate: 24000, channels: 1 });
    assert.equal(audio.players[0].bytes.length, 1.5 * 24000 * 2);
    assert.equal((await status(c, id)).speaking.utterance_id, s.utterance_id);
    // Another one while it plays: refused.
    assert.match((await c.call('meeting_speak', { meeting_id: id, text: 'again' })).text, /already speaking/);
    await until(() => ev.speech.length === 1, 5000);
    assert.deepEqual(media(code, 'mic'), [true, false], 'muted again after');
    assert.equal(ev.speech[0].state, 'done');
    // Several sentences: synthesized one after the other into the same player, the first one playing meanwhile.
    const n = el.st.speech.length;
    const m2 = (await c.call('meeting_speak', { meeting_id: id, text: 'First sentence here. Second one follows! And a third?', wait: true })).json();
    assert.equal(m2.pieces, 2);
    assert.deepEqual(el.st.speech.slice(n).map((x) => x.input), ['First sentence here.', 'Second one follows! And a third?']);
    assert.equal(m2.duration_s, 0.9 + 1.8);
    assert.equal(audio.players.at(-1).bytes.length, Math.round(2.7 * 24000) * 2);
    assert.deepEqual(media(code, 'mic'), [true, false, true, false]);
    // wait: answers once it has played.
    const w = (await c.call('meeting_speak', { meeting_id: id, text: 'Short.', wait: true })).json();
    assert.equal(w.state, 'done');
    assert.equal(w.speaking, false);
    assert.ok(w.played_s >= 0.5, `played ${w.played_s}`);
    assert.deepEqual(media(code, 'mic'), [true, false, true, false, true, false]);
    // ElevenLabs as the voice.
    const e = (await c.call('meeting_speak', { meeting_id: id, text: 'Привіт усім', backend: 'elevenlabs', lang: 'uk', wait: true })).json();
    assert.equal(e.source, 'elevenlabs');
    assert.equal(e.voice, 'EXAVITQu4vr4xnSDxMaL');
    assert.equal(el.st.tts.at(-1).query.enable_logging, 'false');
    // A TTS failure says nothing and leaves the microphone muted.
    assert.match((await c.call('meeting_speak', { meeting_id: id, text: 'x', voice: 'alloy' })).text, /nothing was said: voice must be one of/);
    assert.equal(media(code, 'mic').at(-1), false);
    assert.equal((await status(c, id)).speaking, undefined);
    await c.close();
  }, { env: { TTS_VOICE: '' } });
});

test('barge-in: meeting_stop_speaking cuts it off and mutes; interrupt replaces it; auto_mute false leaves the microphone alone; an uploaded file', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { id, code } = await admitted(c, { live: false });
    const long = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
    const a = (await c.call('meeting_speak', { meeting_id: id, text: long })).json();
    assert.equal(a.duration_s, 4.5);
    await sleep(300);
    const st = (await c.call('meeting_stop_speaking', { meeting_id: id })).json();
    assert.equal(st.stopped, true);
    assert.equal(st.state, 'interrupted');
    assert.ok(st.played_s < 2, `played ${st.played_s}`);
    assert.equal(audio.players[0].stopped, true);
    assert.deepEqual(media(code, 'mic'), [true, false]);
    assert.deepEqual((await c.call('meeting_stop_speaking', { meeting_id: id })).json(), { meeting_id: id, stopped: false });
    // A player that never reports its end: the stop still answers, and the microphone is muted again.
    audio.hangPlayers = true;
    await c.call('meeting_speak', { meeting_id: id, text: long });
    const hung = (await c.call('meeting_stop_speaking', { meeting_id: id })).json();
    assert.equal(hung.state, 'interrupted');
    assert.equal(media(code, 'mic').at(-1), false);
    assert.equal((await status(c, id)).speaking, undefined);
    audio.hangPlayers = false;
    const k = media(code, 'mic').length;

    // interrupt: the new one takes over the microphone (no mute in between) and mutes it after.
    await c.call('meeting_speak', { meeting_id: id, text: long });
    const b = (await c.call('meeting_speak', { meeting_id: id, text: 'Sorry, shorter.', interrupt: true, wait: true })).json();
    assert.equal(b.state, 'done');
    assert.equal(audio.players[1].stopped, true);
    assert.deepEqual(media(code, 'mic').slice(k), [true, false]);
    await until(() => ev.speech.length === 4);
    assert.deepEqual(ev.speech.map((e) => e.state), ['interrupted', 'interrupted', 'interrupted', 'done']);

    // Interrupted while the first one is still being synthesized: the microphone is still muted again at the end.
    el.st.ttsDelayMs = 800;
    const slow = c.call('meeting_speak', { meeting_id: id, text: 'Slow to synthesize.' });
    await until(() => media(code, 'mic').length === k + 3, 5000);
    el.st.ttsDelayMs = 0;
    const fast = (await c.call('meeting_speak', { meeting_id: id, text: 'Fast.', interrupt: true, wait: true })).json();
    assert.equal(fast.state, 'done');
    await slow;
    await until(() => ev.speech.length >= 6, 5000).catch(() => {});
    await sleep(600);
    assert.equal(media(code, 'mic').at(-1), false, `mic ${JSON.stringify(media(code, 'mic'))}`);
    assert.equal((await status(c, id)).speaking, undefined);

    // The agent unmutes itself: speaking leaves it on.
    assert.deepEqual((await c.call('meeting_mute', { meeting_id: id, on: false })).json(), { meeting_id: id, muted: false });
    await c.call('meeting_speak', { meeting_id: id, text: 'Still here.', wait: true });
    assert.equal(media(code, 'mic').at(-1), true);
    assert.deepEqual((await c.call('meeting_mute', { meeting_id: id, on: true })).json(), { meeting_id: id, muted: true });
    // An utterance with auto_mute false that takes over from one that unmuted: the microphone is the agent's again, and
    // the next one with auto_mute finds it on and leaves it on.
    await c.call('meeting_speak', { meeting_id: id, text: long });
    await c.call('meeting_speak', { meeting_id: id, text: 'Manual.', auto_mute: false, interrupt: true, wait: true });
    assert.equal(media(code, 'mic').at(-1), true);
    await c.call('meeting_speak', { meeting_id: id, text: 'Auto.', wait: true });
    assert.equal(media(code, 'mic').at(-1), true);
    await c.call('meeting_mute', { meeting_id: id, on: true });
    // auto_mute false: played into a muted microphone, nothing touched.
    const n = media(code, 'mic').length;
    await c.call('meeting_speak', { meeting_id: id, text: 'Muted.', auto_mute: false, wait: true });
    assert.equal(media(code, 'mic').length, n);

    // An uploaded file instead of text.
    const up = (await c.call('upload_create', { filename: 'hi.wav' })).json();
    const put = await fetch(up.put_url, { method: 'PUT', body: toneWav(1.2) });
    assert.equal(put.status, 201);
    const f = (await c.call('meeting_speak', { meeting_id: id, audio_file_id: up.file_id, wait: true })).json();
    assert.equal(f.source, 'file');
    assert.ok(Math.abs(f.duration_s - 1.2) < 0.05, `duration ${f.duration_s}`);
    assert.match((await c.call('meeting_speak', { meeting_id: id })).text, /pass text or audio_file_id/);
    assert.match((await c.call('meeting_speak', { meeting_id: id, audio_file_id: 'f0000000000000000' })).text, /nothing was said: no uploaded file/);
    const pl = (await c.call('upload_create', { filename: 'list.m3u8' })).json();
    await fetch(pl.put_url, { method: 'PUT', body: '#EXTM3U\n#EXTINF:2,\n/etc/hostname\n#EXT-X-ENDLIST\n' });
    assert.match((await c.call('meeting_speak', { meeting_id: id, audio_file_id: pl.file_id })).text, /is not WAV, Ogg, FLAC, MP3, M4A or WebM audio/);
    await c.close();
  });
});

test('stopped while the text is still being synthesized: the microphone is muted again; a player that never ends is cut off; NODE_DEBUG keeps the key unused', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { id, code } = await admitted(c, { live: false });
    el.st.ttsDelayMs = 1500;
    const slow = c.call('meeting_speak', { meeting_id: id, text: 'Slow to synthesize.' });
    await until(() => media(code, 'mic').length === 1, 5000);
    const st = (await c.call('meeting_stop_speaking', { meeting_id: id })).json();
    assert.equal(st.state, 'interrupted');
    el.st.ttsDelayMs = 0;
    const r = await slow;
    assert.equal(r.json().state, 'interrupted');
    await sleep(300);
    assert.deepEqual(media(code, 'mic'), [true, false]);
    assert.equal(audio.players.length, 0, 'nothing played');

    audio.stuckPlayers = true;
    const w = (await c.call('meeting_speak', { meeting_id: id, text: 'Stuck.', wait: true })).json();
    assert.equal(w.state, 'failed');
    assert.match(w.error, /playback did not end in time/);
    assert.equal(audio.players.at(-1).stopped, true);
    assert.equal(media(code, 'mic').at(-1), false);
    audio.stuckPlayers = false;

    process.env.NODE_DEBUG = 'net';
    try {
      assert.match((await c.call('meeting_speak', { meeting_id: id, text: 'x', backend: 'elevenlabs' })).text, /NODE_DEBUG is set/);
      assert.match((await c.call('meeting_join', { url: fake.newRoom().url, live_transcript: true })).text, /live_transcript is refused: NODE_DEBUG is set/);
    } finally { delete process.env.NODE_DEBUG; }
    await c.close();
  }, { meetings: { speechGraceMs: 500 } });
});

test('Meet: meeting_raise_hand raises and lowers the hand; leaving while speaking stops the audio', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await connect(svc);
    const { id, code } = await admitted(c, { live: false });
    assert.deepEqual((await c.call('meeting_raise_hand', { meeting_id: id, on: true })).json(), { meeting_id: id, hand_raised: true });
    assert.deepEqual((await c.call('meeting_raise_hand', { meeting_id: id, on: true })).json(), { meeting_id: id, hand_raised: true }); // already up: no click
    assert.deepEqual((await c.call('meeting_raise_hand', { meeting_id: id, on: false })).json(), { meeting_id: id, hand_raised: false });
    assert.deepEqual(media(code, 'hand'), [true, false]);
    await c.call('meeting_speak', { meeting_id: id, text: 'one two three four five six seven eight nine ten' });
    await c.call('meeting_leave', { meeting_id: id });
    assert.equal(audio.players[0].stopped, true);
    assert.match((await c.call('meeting_raise_hand', { meeting_id: id, on: true })).text, /is ended/);
    await c.close();
  });
});

test('Zoom: mute and unmute in the toolbar, the hand in the Reactions menu', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const s = await c.open({ profile: 'zoom', engine: ENGINE === 'patchright' ? 'patchright' : 'chromium' });
    await c.call('session_close', { session: s });
    const { id: zid, url } = fz.newRoom({ signedIn: true, open: true, micInCall: 'ask' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    const id = r.json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 20_000);
    const zm = () => fz.room(zid).media;
    // Zoom never got the microphone: the first unmute answers its question with "Use microphone".
    assert.deepEqual((await c.call('meeting_mute', { meeting_id: id, on: false })).json(), { meeting_id: id, muted: false });
    assert.equal(zm().filter((m) => 'mic' in m).at(-1).mic, true);
    assert.deepEqual(zm().filter((m) => 'asked' in m).map((m) => m.asked), ['used']);
    assert.deepEqual((await c.call('meeting_mute', { meeting_id: id, on: true })).json(), { meeting_id: id, muted: true });
    assert.equal(zm().filter((m) => 'mic' in m).at(-1).mic, false);
    assert.deepEqual((await c.call('meeting_raise_hand', { meeting_id: id, on: true })).json(), { meeting_id: id, hand_raised: true });
    assert.deepEqual((await c.call('meeting_raise_hand', { meeting_id: id, on: false })).json(), { meeting_id: id, hand_raised: false });
    assert.deepEqual(zm().filter((m) => 'hand' in m).map((m) => m.hand), [true, false]);
    const w = (await c.call('meeting_speak', { meeting_id: id, text: 'Hello Zoom.', wait: true })).json();
    assert.equal(w.state, 'done');
    assert.deepEqual(zm().filter((m) => 'mic' in m).slice(-2).map((m) => m.mic), [true, false]);
    await c.close();
  });
});
