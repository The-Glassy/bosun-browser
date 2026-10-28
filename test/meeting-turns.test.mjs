// Turns in 0.17.1, through MCP against the Meet stand-in, the fake audio backend and the local ElevenLabs/Supertonic
// stand-in: a final is held for more of the same turn (turn_hold_ms) and what comes meanwhile is merged into one final;
// one that comes after the hold is a turn of its own; the acknowledgement plays once per real turn; someone speaking
// over Bosun stops it (barge_in: muted again, channel text waiting dropped, the channel told what was said); Bosun's own
// voice coming back never does; a publish while someone has spoken since the last turn says superseded_by_new_speech.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { startFakeElevenLabs, tonePcm } from './fakeelevenlabs.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { Meetings } from '../src/meetings/index.mjs';
import { MEETING_SET } from '../src/events.mjs';

let fake, el;
before(async () => { [fake, el] = await Promise.all([startFakeMeet(), startFakeElevenLabs()]); });
after(async () => { await Promise.all([fake?.close(), el?.close()]); });

const MCPL = { experimental: { mcpl: { version: '0.5', pushEvents: true, channels: { register: true, publish: true, incoming: true, streaming: true } } } };
const silence = (seconds) => Buffer.alloc(Math.round(seconds * 16000) * 2);
// What the ElevenLabs stand-in hears in the next stretches of speech, in order.
const phrases = (...p) => { el.st.phrases = p; el.st.phraseAt = 0; };

async function withService(fn) {
  const audio = fakeAudio();
  const svc = await startBosun({ KEEPALIVE: '0', ELEVENLABS_API_KEY: el.key, ELEVENLABS_BASE_URL: el.base, TTS_URL: el.base }, {
    meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 },
  });
  const ev = { transcript: [], speech: [], ended: [] };
  for (const k of Object.keys(ev)) svc.events.on(`meeting-${k}`, (e) => ev[k].push(e));
  try { return await fn(svc, ev, audio); } finally { await svc.stop(); }
}

async function host(svc) {
  const c = await connect(svc, undefined, { capabilities: MCPL });
  Object.assign(c, { registered: [], incoming: [] });
  c.setRequestHandler(z.object({ method: z.literal('push/event'), params: z.any() }), async () => ({ accepted: true }));
  c.setRequestHandler(z.object({ method: z.literal('channels/register'), params: z.any() }), async (r) => {
    c.registered.push(...r.params.channels);
    return { registered: r.params.channels.map((d) => d.id), results: r.params.channels.map((d) => ({ id: d.id, accepted: true })) };
  });
  c.setRequestHandler(z.object({ method: z.literal('channels/incoming'), params: z.any() }), async (r) => {
    c.incoming.push(...r.params.messages.map((m) => ({ ...m, at: Date.now() })));
    return { results: r.params.messages.map((m) => ({ messageId: m.messageId, accepted: true })) };
  });
  c.setNotificationHandler(z.object({ method: z.literal('channels/changed'), params: z.any() }), async () => {});
  await c.request({ method: 'featureSets/update', params: { enabled: [MEETING_SET], effectiveCapabilities: ['tools', 'pushEvents', 'channels.*'] } }, z.any());
  c.publish = (channelId, text) => c.request({ method: 'channels/publish', params: { conversationId: '', channelId, content: [{ type: 'text', text }] } }, z.any());
  c.finals = () => c.incoming.filter((m) => m.metadata.final);
  return c;
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();
async function admitted(c) {
  const { code, url } = fake.newRoom();
  const r = await c.call('meeting_join', { url, live_transcript: true });
  assert.equal(r.isError, false, r.text);
  const id = r.json().meeting_id;
  fake.admit(code);
  await until(async () => (await status(c, id)).state === 'recording', 15_000);
  await until(() => c.registered.length === 1, 10_000);
  return { id, code, chId: `bosun:meeting:${id}` };
}
const mics = (code) => fake.room(code).media.filter((m) => 'mic' in m).map((m) => m.mic);
const segments = async (c, id) => (await c.call('meeting_transcript', { meeting_id: id })).json().segments;

test('which finals end a sentence (turn_hold_complete_ms): questions and full sentences; not a trailing "and", "the", "що" or "…"', () => {
  const done = (t) => Meetings.prototype.turnComplete.call(null, t);
  for (const t of ['Can you check that?', 'What do you think?”', 'The budget is fine.', 'Мені здається, що все гаразд.', 'Das passt schon!']) assert.equal(done(t), true, t);
  for (const t of ['So I was thinking about the', 'And then we went to the.', 'I think that.', 'Я думаю, що.', 'Well…', 'Wait...', 'Okay.', 'so', '']) assert.equal(done(t), false, t);
});

test('what was said of an utterance cut off: whole pieces played, and the whole words of the piece playing', () => {
  const said = (t, u) => Meetings.prototype.spokenSoFar.call({ now: () => 10_000 + t }, { startedAt: 10_000, pieces: ['Fourth.'], ...u });
  const timeline = [{ text: 'One two three.', start: 0, end: 1000 }, { text: 'Four five six seven.', start: 1000, end: 2000 }, { text: 'Eight.', start: 2000, end: 2500 }];
  assert.deepEqual(said(1500, { timeline }), { said: 'One two three. Four five', unsaid: 'six seven. Eight. Fourth.' });
  assert.deepEqual(said(100, { timeline }), { said: '', unsaid: 'One two three. Four five six seven. Eight. Fourth.' });
  assert.deepEqual(said(3000, { timeline, synthPiece: 'Ninth.' }), { said: 'One two three. Four five six seven. Eight.', unsaid: 'Ninth. Fourth.' });
  assert.deepEqual(said(500, { timeline: null }), { said: null, unsaid: '' });
});

test('two fragments within turn_hold_ms reach the agent as one merged final (one turn, merged_seqs); meeting_transcript keeps both', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { turn_hold_ms: 1500 });
    const { id } = await admitted(c);
    phrases('So I was thinking about the', 'budget for next year.');
    // The stand-in commits after 1 s of silence; the second stretch starts 1.2 s after the first ended, so its first
    // partial comes ~0.7 s after the first final (within the 1.5 s hold).
    audio.say(Buffer.concat([tonePcm(1.5), silence(1.2), tonePcm(1.5)]));
    await until(() => c.finals().length === 1, 20_000);
    await sleep(2500);
    assert.equal(c.finals().length, 1, 'one turn');
    const f = c.finals()[0];
    assert.equal(f.content[0].text, 'So I was thinking about the budget for next year.');
    assert.deepEqual(f.metadata.merged_seqs, [1, 2]);
    assert.equal(f.metadata.seq, 2);
    assert.equal(f.messageId, `${id}:2`);
    assert.ok(f.metadata.held_ms >= 280 && f.metadata.held_ms < 800, `held ${f.metadata.held_ms} ms after the last final (a complete sentence: 300)`);
    assert.deepEqual((await segments(c, id)).map((s) => s.text), ['So I was thinking about the', 'budget for next year.']);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a fragment after turn_hold_ms is a turn of its own; turn_hold_ms 0 delivers every final at once (0.17.0)', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { turn_hold_ms: 1000 });
    const { id } = await admitted(c);
    phrases('So I was thinking about the', 'budget for next year.');
    // Second stretch 3 s after the first: its final is 2 s after the first, which went after 1 s.
    audio.say(Buffer.concat([tonePcm(1.5), silence(3), tonePcm(1.5)]));
    await until(() => c.finals().length === 2, 20_000);
    const [a, b] = c.finals();
    assert.equal(a.content[0].text, 'So I was thinking about the');
    assert.equal(b.content[0].text, 'budget for next year.');
    assert.equal(a.metadata.merged_seqs, undefined);
    assert.ok(a.metadata.held_ms >= 980 && a.metadata.held_ms < 1500, `incomplete: held ${a.metadata.held_ms} ms`);
    assert.ok(b.metadata.held_ms < 700, `complete: held ${b.metadata.held_ms} ms`);
    // Off: at once, no held_ms.
    await c.call('speech_settings_set', { turn_hold_ms: 0 });
    phrases('So I was thinking about the', 'budget for next year.');
    audio.say(Buffer.concat([tonePcm(1.5), silence(1.2), tonePcm(1.5)]));
    await until(() => c.finals().length === 4, 20_000);
    assert.deepEqual(c.finals().slice(2).map((f) => [f.content[0].text, f.metadata.held_ms]), [['So I was thinking about the', undefined], ['budget for next year.', undefined]]);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('added latency at the defaults: ~300 ms after a question or full sentence, ~900 ms after a fragment', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id } = await admitted(c);
    phrases('Can you check the numbers?', 'I was thinking that', 'The plan looks good to me.');
    audio.say(Buffer.concat([tonePcm(1.5), silence(3), tonePcm(1.5), silence(3), tonePcm(1.5)]));
    await until(() => c.finals().length === 3, 25_000);
    const held = c.finals().map((f) => f.metadata.held_ms);
    console.log(`MEASURE turn hold (defaults 900/300): question ${held[0]} ms, fragment ${held[1]} ms, sentence ${held[2]} ms`);
    assert.ok(held[0] >= 295 && held[0] < 450, `question ${held[0]}`);
    assert.ok(held[1] >= 895 && held[1] < 1100, `fragment ${held[1]}`);
    assert.ok(held[2] >= 295 && held[2] < 450, `sentence ${held[2]}`);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('ack_on_final plays once per real turn: not on the first fragment, once when the merged turn ends', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { ack_on_final: true, ack_phrases: ['Mhm.'], ack_delay_ms: 0, ack_cooldown_s: 0, turn_hold_ms: 1500, turn_hold_complete_ms: 1500 });
    const { id } = await admitted(c);
    phrases('I have a few points here.', 'The first one is the budget.');
    audio.say(Buffer.concat([tonePcm(1.5), silence(1.2), tonePcm(1.5)]));
    await until(() => c.finals().length === 1, 20_000);
    await until(() => audio.players.length === 1, 5000);
    assert.ok(audio.players[0].startedAt >= c.finals()[0].at - 50, 'the clip after the turn went to the agent, not after the first fragment');
    await sleep(2500);
    assert.equal(audio.players.length, 1, 'one clip');
    assert.equal(c.finals()[0].content[0].text, 'I have a few points here. The first one is the budget.');
    assert.equal((await status(c, id)).acks, 1);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('barge-in: someone speaking over Bosun stops it at once, mutes, drops the channel text waiting, tells the channel what was said; their turn arrives as usual', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { turn_hold_ms: 300 });
    const { id, code, chId } = await admitted(c);
    const r = await c.publish(chId, 'This is the first sentence of a rather long answer. And here is a second sentence that keeps on going for a while.');
    assert.equal(r.superseded_by_new_speech, false);
    await until(() => audio.players.length === 1, 10_000);
    await c.publish(chId, 'And a third sentence that should never be heard by anyone.');
    phrases('Wait, stop, I have a question.');
    audio.say(tonePcm(2));
    const t0 = Date.now();
    await until(() => ev.speech.length === 1, 10_000);
    const s = ev.speech[0];
    console.log(`MEASURE barge-in: stopped ${Date.now() - t0} ms after the interruption started (2 words: partials every 0.5 s)`);
    assert.equal(s.state, 'interrupted');
    assert.equal(s.barge_in, true);
    assert.ok('This is the first sentence of a rather long answer.'.startsWith(s.said) || s.said.startsWith('This is the first'), s.said);
    assert.ok(audio.players[0].stopped, 'playback stopped');
    await until(() => mics(code).length === 2);
    assert.deepEqual(mics(code), [true, false], 'muted again');
    const note = c.incoming.find((m) => m.tags.includes('bosun:meeting-interrupted'));
    assert.ok(note, 'the channel is told');
    assert.equal(note.metadata.interrupted, true);
    assert.equal(note.metadata.said, s.said);
    assert.match(note.metadata.unsaid, /third sentence/);
    assert.equal(note.author.id, 'bosun');
    assert.match(note.content[0].text, /^\(interrupted at "/);
    // Their turn comes as usual; nothing more of the answer is said.
    await until(() => c.finals().length === 1, 15_000);
    assert.equal(c.finals()[0].content[0].text, 'Wait, stop, I have a question.');
    assert.ok(c.incoming.indexOf(note) < c.incoming.indexOf(c.finals()[0]), 'the note before their turn');
    await sleep(1500);
    assert.equal(audio.players.length, 1);
    assert.equal((await status(c, id)).barge_ins, 1);
    // Off: speaking over it changes nothing.
    await c.call('speech_settings_set', { barge_in: false });
    await c.publish(chId, 'One more short answer for the record.');
    await until(() => audio.players.length === 2, 10_000);
    phrases('Wait, stop, I have a question.');
    audio.say(tonePcm(2));
    await until(() => ev.speech.length === 2, 15_000);
    assert.equal(ev.speech[1].state, 'done');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('barge-in counts only new words: one word, or agreeing ("yeah, mhm"), doesn\'t stop Bosun; meeting_speak is stopped like channel text', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id, code } = await admitted(c);
    await c.call('meeting_speak', { meeting_id: id, text: 'Here is a long statement that I am going to make right now. It has two sentences.' });
    await until(() => audio.players.length === 1, 10_000);
    phrases('Yeah mhm okay right.');
    audio.say(tonePcm(2.5));
    await sleep(2800);
    assert.equal(ev.speech.length, 0, 'still speaking');
    phrases('No no, that is wrong.');
    audio.say(tonePcm(2));
    await until(() => ev.speech.length === 1, 10_000);
    assert.equal(ev.speech[0].state, 'interrupted');
    assert.equal(ev.speech[0].barge_in, true);
    await until(() => mics(code).length === 2);
    assert.deepEqual(mics(code), [true, false]);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('echo: Bosun\'s own words coming back never barge in (and their final is marked echo_suspected); with speaker labels, speech while the page shows nobody else doesn\'t either', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id, code, chId } = await admitted(c);
    const said = 'Hello Misha, this is a test of the echo in this meeting.';
    await c.publish(chId, said);
    await until(() => audio.players.length === 1, 10_000);
    phrases(said); // what someone's microphone picked up from their speakers
    audio.say(tonePcm(2.5));
    await until(() => ev.speech.length === 1, 15_000);
    assert.equal(ev.speech[0].state, 'done');
    assert.equal(ev.speech[0].barge_in, undefined);
    await until(() => c.finals().length === 1, 15_000);
    assert.equal(c.finals()[0].metadata.echo_suspected, true);
    assert.ok(c.finals()[0].tags.includes('bosun:echo-suspected'));
    assert.equal(c.finals()[0].metadata.held_ms, undefined, 'not held');
    // Speaker labels work in this call (host-1 was shown); then only Bosun's voice is in the mix (nobody else shown).
    fake.room(code).speaking = 'host-1';
    await until(async () => (await status(c, id)).speaker_labels === 'seen', 5000);
    fake.room(code).speaking = null;
    await sleep(800);
    await c.publish(chId, 'A second answer that runs for a few seconds at least.');
    await until(() => audio.players.length === 2, 10_000);
    phrases('Completely different words heard here now.');
    audio.say(tonePcm(2));
    await until(() => ev.speech.length === 2, 15_000);
    assert.equal(ev.speech[1].state, 'done', 'nobody else was shown speaking');
    // The same while host-1 is shown speaking: a barge-in.
    await c.publish(chId, 'A third answer that also runs for a few seconds at least.');
    await until(() => audio.players.length === 3, 10_000);
    fake.room(code).speaking = 'host-1';
    phrases('Completely different words heard here now.');
    audio.say(tonePcm(2));
    await until(() => ev.speech.length === 3, 15_000);
    assert.equal(ev.speech[2].state, 'interrupted');
    assert.equal(ev.speech[2].interrupted_by, 'host-1');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('stale answer: a publish while someone has spoken since the last turn (a turn still held) is said all the same, with superseded_by_new_speech', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { turn_hold_ms: 3000, turn_hold_complete_ms: 3000 });
    const { id, chId } = await admitted(c);
    phrases('Here is the first part.', 'And the second part.');
    audio.say(tonePcm(1.5));
    await until(() => c.finals().length === 1, 15_000);
    const r1 = await c.publish(chId, 'Okay.');
    assert.equal(r1.superseded_by_new_speech, false);
    assert.equal(r1.last_turn_seq, 1);
    await until(() => ev.speech.length === 1, 10_000);
    // More speech: held, so the agent hasn't got it; an answer now is flagged, and still spoken.
    audio.say(tonePcm(1.5));
    await until(async () => (await segments(c, id)).length === 2, 15_000);
    assert.equal(c.finals().length, 1);
    const r2 = await c.publish(chId, 'So about the first part.');
    assert.equal(r2.delivered, true);
    assert.equal(r2.superseded_by_new_speech, true);
    assert.equal(r2.last_turn_seq, 1);
    await until(() => ev.speech.length === 2, 10_000);
    assert.equal(ev.speech[1].state, 'done', 'said all the same');
    await until(() => c.finals().length === 2, 10_000);
    const r3 = await c.publish(chId, 'Got it.');
    assert.equal(r3.superseded_by_new_speech, false);
    assert.equal(r3.last_turn_seq, 2);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});
