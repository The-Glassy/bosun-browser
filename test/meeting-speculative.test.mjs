// Speculative speech in 0.18.0 (docs/STREAMING.md), against a fake host: with speculative_speech the meeting channel
// declares streaming {speculative: true}; channels/outgoing/chunk {streamId, seq, content, speculative: true} is spoken
// sentence by sentence before the publish lands; complete with cancelled stops it at once; complete (or the publish)
// with other text stops what differs and says the text from there; the publish that follows is not said twice (by
// streamId, or by its text within 10 s); a barge-in stops it like any speech; off, nothing of this happens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { startFakeElevenLabs, tonePcm } from './fakeelevenlabs.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { MEETING_SET } from '../src/events.mjs';

let fake, el;
before(async () => { [fake, el] = await Promise.all([startFakeMeet(), startFakeElevenLabs()]); });
after(async () => { await Promise.all([fake?.close(), el?.close()]); });

const MCPL = { experimental: { mcpl: { version: '0.5', pushEvents: true, channels: { register: true, publish: true, incoming: true, streaming: true } } } };
const phrases = (...p) => { el.st.phrases = p; el.st.phraseAt = 0; };
const synthesized = (n0 = 0) => el.st.speech.slice(n0).map((s) => s.input);
const seconds = (p) => p.bytes.length / (p.pcm.rate * p.pcm.channels * 2);

async function withService(fn) {
  const audio = fakeAudio();
  const svc = await startBosun({ KEEPALIVE: '0', ELEVENLABS_API_KEY: el.key, ELEVENLABS_BASE_URL: el.base, TTS_URL: el.base }, {
    meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 },
  });
  const ev = { transcript: [], speech: [], ended: [] };
  for (const k of Object.keys(ev)) svc.events.on(`meeting-${k}`, (e) => ev[k].push(e));
  try { return await fn(svc, ev, audio); } finally { await svc.stop(); }
}

// The fake host: grants channels, records registrations and incoming messages, and streams like the agent-framework
// fork would: chunk(...) per delta, complete(...) / cancel(...) at the end, publish(...) for the tool call.
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
  c.publish = (channelId, text, more = {}) => c.request({ method: 'channels/publish', params: { conversationId: '', channelId, content: [{ type: 'text', text }], ...more } }, z.any());
  c.stream = (channelId, streamId) => {
    let seq = 0;
    return {
      chunk: (content, s = seq++) => c.notification({ method: 'channels/outgoing/chunk', params: { channelId, streamId, seq: s, content, speculative: true } }),
      complete: (content) => c.notification({ method: 'channels/outgoing/complete', params: { channelId, streamId, content, speculative: true } }),
      cancel: () => c.notification({ method: 'channels/outgoing/complete', params: { channelId, streamId, content: '', cancelled: true, speculative: true } }),
    };
  };
  c.finals = () => c.incoming.filter((m) => m.metadata.final && !m.metadata.echo_suspected);
  return c;
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();
async function admitted(c, more = {}) {
  const { code, url } = fake.newRoom();
  const r = await c.call('meeting_join', { url, live_transcript: true, ...more });
  assert.equal(r.isError, false, r.text);
  const id = r.json().meeting_id;
  fake.admit(code);
  await until(async () => (await status(c, id)).state === 'recording', 15_000);
  await until(() => c.registered.length === 1, 10_000);
  return { id, code, chId: `bosun:meeting:${id}` };
}
const mics = (code) => fake.room(code).media.filter((m) => 'mic' in m).map((m) => m.mic);

test('the channel declares streaming {speculative: true} only with speculative_speech (tenant, or meeting_join for one meeting)', async () => {
  await withService(async (svc) => {
    const c = await host(svc);
    const a = await admitted(c);
    assert.equal(c.registered[0].capabilities, undefined);
    assert.equal(c.registered[0].metadata.streaming, undefined);
    await c.call('meeting_leave', { meeting_id: a.id });
    c.registered.length = 0;
    const b = await admitted(c, { speculative_speech: true });
    assert.deepEqual(c.registered[0].capabilities, { streaming: { speculative: true } });
    assert.deepEqual(c.registered[0].metadata.streaming, { speculative: true });
    await c.call('meeting_leave', { meeting_id: b.id });
    c.registered.length = 0;
    await c.call('speech_settings_set', { speculative_speech: true });
    const d = await admitted(c);
    assert.deepEqual(c.registered[0].capabilities, { streaming: { speculative: true } });
    assert.deepEqual((await status(c, d.id)).speculative, { sentences: 0, cancelled: 0 });
    await c.call('meeting_leave', { meeting_id: d.id });
    await c.close();
  });
});

test('chunks are spoken sentence by sentence before the publish lands; the publish (streamId) and complete that follow say nothing twice', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { speculative_speech: true });
    const { id, code, chId } = await admitted(c);
    const n0 = el.st.speech.length;
    const s = c.stream(chId, 'call_1');
    const t0 = Date.now();
    await s.chunk('Sure, the bud');
    await s.chunk('get is fine. Next');
    await until(() => audio.players.length === 1, 10_000);
    console.log(`MEASURE speculative: first audio ${audio.players[0].startedAt - t0} ms after the first chunk (no publish yet)`);
    assert.deepEqual(synthesized(n0), ['Sure, the budget is fine.']);
    await s.chunk(' year looks good too. And the');
    await until(() => synthesized(n0).length === 2, 5000);
    await s.chunk(' year after');
    await sleep(200);
    assert.equal(synthesized(n0).length, 2, 'an open sentence waits');
    // The tool call finished: the publish (carrying streamId), then complete.
    const text = 'Sure, the budget is fine. Next year looks good too. And the year after.';
    const r = await c.publish(chId, text, { streamId: 'call_1' });
    assert.equal(r.delivered, true);
    assert.equal(r.speculative, true);
    assert.equal(r.stream_id, 'call_1');
    assert.equal(r.spoken, 'settled');
    await s.complete(text);
    await until(() => ev.speech.length === 1, 20_000);
    assert.equal(ev.speech[0].state, 'done');
    assert.deepEqual(synthesized(n0), ['Sure, the budget is fine.', 'Next year looks good too.', 'And the year after.'], 'each sentence once');
    assert.equal(audio.players.length, 1, 'one utterance');
    assert.deepEqual(mics(code), [true, false]);
    assert.deepEqual((await status(c, id)).speculative, { sentences: 2, cancelled: 0 });
    // complete first, then a publish without streamId: matched by its text, not said again.
    const s2 = c.stream(chId, 'call_2');
    await s2.chunk('Second answer here. ');
    await s2.complete('Second answer here.');
    const r2 = await c.publish(chId, 'Second answer here.');
    assert.equal(r2.spoken, 'already_spoken');
    await until(() => ev.speech.length === 2, 20_000);
    assert.deepEqual(synthesized(n0).slice(3), ['Second answer here.']);
    // Chunks out of order are put back in order.
    const s3 = c.stream(chId, 'call_3');
    await s3.chunk('three. ', 1);
    await sleep(100);
    assert.equal(synthesized(n0).length, 4);
    await s3.chunk('One two ', 0);
    await until(() => synthesized(n0).length === 5, 5000);
    assert.equal(synthesized(n0)[4], 'One two three.');
    await s3.complete('One two three.');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('complete with cancelled stops the speech at once, mutes again and drops the rest; later chunks of it say nothing', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { speculative_speech: true });
    const { id, code, chId } = await admitted(c);
    const n0 = el.st.speech.length;
    const s = c.stream(chId, 'call_x');
    await s.chunk('This is a long first sentence that takes a while to say. And a second one that also goes on and on. ');
    await until(() => audio.players.length === 1, 10_000);
    const t0 = Date.now();
    await s.cancel();
    await until(() => ev.speech.length === 1, 5000);
    console.log(`MEASURE speculative cancel: stopped ${Date.now() - t0} ms after complete {cancelled}`);
    assert.equal(ev.speech[0].state, 'interrupted');
    assert.ok(audio.players[0].stopped);
    await until(() => mics(code).length === 2);
    assert.deepEqual(mics(code), [true, false], 'muted again');
    await s.chunk('Even more text. ');
    await sleep(500);
    assert.equal(audio.players.length, 1);
    assert.ok(!synthesized(n0).includes('Even more text.'));
    assert.deepEqual((await status(c, id)).speculative, { sentences: 2, cancelled: 1 });
    // A stream cancelled before its first sentence was taken up says nothing at all.
    el.st.ttsDelayMs = 1500;
    try {
      const s2 = c.stream(chId, 'call_y');
      await s2.chunk('Never heard. ');
      await sleep(200);
      await s2.cancel();
      await sleep(2500);
      assert.equal(audio.players.length, 1, 'never played');
    } finally { el.st.ttsDelayMs = 0; }
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('complete with other text: what differs is stopped and the text from the first differing sentence is said; not yet taken up: dropped silently', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { speculative_speech: true });
    const { id, chId } = await admitted(c);
    const n0 = el.st.speech.length;
    // Sentence 2 is being synthesized or played when the final text arrives: the utterance is stopped.
    const s = c.stream(chId, 'call_a');
    await s.chunk('First sentence here. Second one is wrong. ');
    await until(() => audio.players.length === 1 && synthesized(n0).includes('Second one is wrong.'), 10_000);
    await s.complete('First sentence here. Second one is right. Third.');
    await until(() => audio.players.length === 2, 10_000);
    await until(() => ev.speech.length === 2, 20_000);
    assert.deepEqual(ev.speech.map((e) => e.state), ['interrupted', 'done']);
    assert.deepEqual(synthesized(n0).slice(-2), ['Second one is right.', 'Third.']);
    const r = await c.publish(chId, 'First sentence here. Second one is right. Third.');
    assert.equal(r.spoken, 'already_spoken');
    await sleep(500);
    assert.equal(audio.players.length, 2);
    // TTS slow: the first sentence is still being synthesized, the second waits in the utterance: it is taken out
    // without a sound, and the right one follows in the same utterance.
    el.st.ttsDelayMs = 1500;
    try {
      const s2 = c.stream(chId, 'call_b');
      await s2.chunk('Alpha one. Bravo two. ');
      await sleep(300);
      await s2.complete('Alpha one. Charlie three.');
      await until(() => ev.speech.length === 3, 20_000);
    } finally { el.st.ttsDelayMs = 0; }
    assert.equal(ev.speech[2].state, 'done');
    assert.equal(audio.players.length, 3);
    assert.ok(Math.abs(seconds(audio.players[2]) - 1.2) < 0.05, `Alpha one. + Charlie three. only: ${seconds(audio.players[2])} s`);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a barge-in stops speculative speech; the stream says nothing more and its publish is not said (spoken: interrupted)', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { speculative_speech: true, turn_hold_ms: 300 });
    const { id, chId } = await admitted(c);
    const s = c.stream(chId, 'call_b');
    await s.chunk('This is the first sentence of a rather long answer. And here is a second sentence that keeps on going for a while. ');
    await until(() => audio.players.length === 1, 10_000);
    phrases('Wait, stop, I have a question.');
    audio.say(tonePcm(2));
    await until(() => ev.speech.length === 1, 10_000);
    assert.equal(ev.speech[0].barge_in, true);
    await s.chunk('A third sentence. ');
    const r = await c.publish(chId, 'This is the first sentence of a rather long answer. And here is a second sentence that keeps on going for a while. A third sentence.');
    assert.equal(r.delivered, true);
    assert.equal(r.spoken, 'interrupted');
    await s.complete('ignored');
    await sleep(1000);
    assert.equal(audio.players.length, 1, 'nothing more said');
    assert.ok(c.incoming.some((m) => m.tags.includes('bosun:meeting-interrupted')));
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('with a spoken draft, a stream that starts with the drafted sentence skips it; speculative_speech off: speculative chunks are never spoken', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { speculative_speech: true, draft_enabled: true, transcript_events: 'always', turn_hold_ms: 300, turn_hold_complete_ms: 300 });
    const { id, chId } = await admitted(c);
    const n0 = el.st.speech.length;
    phrases('Is the plan ready for review?');
    audio.say(tonePcm(3.5));
    await until(() => ev.transcript.some((x) => !x.final && x.text.split(' ').length >= 5), 15_000);
    await c.call('meeting_draft', { meeting_id: id, text: 'Yes, it is ready.', ready: true });
    await until(() => c.finals().length === 1, 15_000);
    assert.equal(c.finals()[0].metadata.draft, 'spoken');
    const s = c.stream(chId, 'call_d');
    await s.chunk('Yes, it is ready. The review can start tomorrow. ');
    const r = await c.publish(chId, 'Yes, it is ready. The review can start tomorrow.', { streamId: 'call_d' });
    assert.equal(r.spoken, 'settled');
    assert.equal(r.draft_prefix_skipped, true);
    await s.complete('Yes, it is ready. The review can start tomorrow.');
    await until(() => ev.speech.length === 1, 20_000);
    assert.deepEqual(synthesized(n0), ['Yes, it is ready.', 'The review can start tomorrow.']);
    // Off: speculative chunks are not spoken (and the publish is, as always).
    await c.call('speech_settings_set', { speculative_speech: false });
    const s2 = c.stream(chId, 'call_e');
    await s2.chunk('Not spoken from chunks. ');
    await sleep(700);
    assert.equal(audio.players.length, 1);
    const r2 = await c.publish(chId, 'Not spoken from chunks.');
    assert.equal(r2.speculative, undefined);
    await until(() => ev.speech.length === 2, 20_000);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});
