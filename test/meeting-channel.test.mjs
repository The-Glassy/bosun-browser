// A meeting as an MCPL channel (spec §14) and what came with it in 0.17.0, through MCP against the Meet and Zoom
// stand-ins, the fake audio backend and the local ElevenLabs/Supertonic stand-in: the channel bosun:meeting:<id> is
// registered with a host that grants channels once the announcement is out, transcript finals arrive on it as
// channels/incoming (and not twice as events), text the host publishes is spoken at once and text published while it
// plays is added to the same utterance, chunks are spoken only when asked for, partials only when asked for and rate
// limited; the acknowledgement clip on the end of someone's turn; speaker labels from the page; Zoom muting again
// through a control Playwright's button lookups miss (in the page, then Alt+A), and mic_open loudly when nothing works.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { startFakeZoom } from './fakezoom.mjs';
import { startFakeElevenLabs, tonePcm } from './fakeelevenlabs.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { zoom, zoomWebClientUrl } from '../src/meetings/platforms/zoom.mjs';
import { MEETING_SET, MANIFEST } from '../src/events.mjs';

let fake, fz, el;
before(async () => { [fake, fz, el] = await Promise.all([startFakeMeet(), startFakeZoom(), startFakeElevenLabs({ phrases: ['Hello Misha, this is a test.', 'And what do you think about it?'] })]); });
after(async () => { await Promise.all([fake?.close(), fz?.close(), el?.close()]); });

const MCPL = { experimental: { mcpl: { version: '0.5', pushEvents: true, channels: { register: true, publish: true, incoming: true, streaming: true } } } };
const zoomPlatform = () => ({ ...zoom, accountUrl: `${fz.base}/profile`, joinUrl: (u) => zoomWebClientUrl(u).replace('https://app.zoom.us', fz.base), origins: () => [fz.base] });

async function withService(fn, { env = {} } = {}) {
  const audio = fakeAudio();
  const zp = zoomPlatform();
  const svc = await startBosun({ KEEPALIVE: '0', ELEVENLABS_API_KEY: el.key, ELEVENLABS_BASE_URL: el.base, TTS_URL: el.base, ...env }, {
    meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : zoom.matches(u) ? zp : null), pollMs: 200 },
  });
  const ev = { transcript: [], speech: [], ended: [], 'mic-open': [] };
  for (const k of Object.keys(ev)) svc.events.on(`meeting-${k}`, (e) => ev[k].push(e));
  try { return await fn(svc, ev, audio); } finally { await svc.stop(); }
}

// An MCPL host that grants channels (caps) and records what Bosun sends: registrations, channels/changed, incoming
// messages (accepted unless refuse), push events.
async function host(svc, { caps = ['tools', 'pushEvents', 'channels.*'], refuse = false } = {}) {
  const c = await connect(svc, undefined, { capabilities: MCPL });
  Object.assign(c, { pushes: [], registered: [], changed: [], incoming: [] });
  c.setRequestHandler(z.object({ method: z.literal('push/event'), params: z.any() }), async (r) => { c.pushes.push(r.params); return { accepted: true }; });
  c.setRequestHandler(z.object({ method: z.literal('channels/register'), params: z.any() }), async (r) => {
    c.registered.push(...r.params.channels);
    return { registered: r.params.channels.map((d) => d.id), results: r.params.channels.map((d) => ({ id: d.id, accepted: true })) };
  });
  c.setRequestHandler(z.object({ method: z.literal('channels/incoming'), params: z.any() }), async (r) => {
    c.incoming.push(...r.params.messages.map((m) => ({ ...m, at: Date.now() })));
    return { results: r.params.messages.map((m) => ({ messageId: m.messageId, accepted: !refuse })) };
  });
  c.setNotificationHandler(z.object({ method: z.literal('channels/changed'), params: z.any() }), async (n) => { c.changed.push(n.params); });
  await c.request({ method: 'featureSets/update', params: { enabled: [MEETING_SET], effectiveCapabilities: caps } }, z.any());
  c.publish = (channelId, text, more = {}) => c.request({ method: 'channels/publish', params: { conversationId: '', channelId, content: [{ type: 'text', text }], ...more } }, z.any());
  c.notify = (method, params) => c.notification({ method, params });
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
  return { id, code };
}
const mics = (code) => fake.room(code).media.filter((m) => 'mic' in m).map((m) => m.mic);
const transcriptPushes = (c) => c.pushes.filter((p) => p.tags.includes('bosun:meeting-transcript'));

test('the manifest offers channels; a host that grants them gets bosun:meeting:<id> registered once the announcement is out, and taken back at the end', async () => {
  assert.deepEqual(MANIFEST.channels, { register: true, incoming: true, publish: true, streaming: true });
  await withService(async (svc, ev) => {
    const c = await host(svc);
    const { id } = await admitted(c);
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    assert.deepEqual(c.registered[0], { id: chId, type: 'bosun.meeting', label: `Google Meet meeting ${id}`, direction: 'bidirectional', initiallyOpen: true, metadata: { meeting_id: id, platform: 'meet', url: c.registered[0].metadata.url } });
    await until(async () => (await status(c, id)).channel?.registered === true);
    assert.deepEqual((await c.request({ method: 'channels/list', params: {} }, z.any())).channels.map((d) => d.id), [chId]);
    // A second connection of the tenant that comes later is told about it too; another tenant's never is.
    const c2 = await host(svc);
    await until(() => c2.registered.length === 1, 10_000);
    // What the host may not publish to: a channel it was never given, or one of another meeting.
    await assert.rejects(c.publish('bosun:meeting:m000000000000', 'hi'), /unknown channel/);
    await c.call('meeting_leave', { meeting_id: id });
    await until(() => ev.ended.length === 1);
    await until(() => c.changed.length === 1 && c2.changed.length === 1);
    assert.deepEqual(c.changed[0], { added: [], removed: [chId], updated: [] });
    await assert.rejects(c.publish(chId, 'hi'), /unknown channel/);
    assert.equal((await status(c, id)).channel.open, false);
    await c.close(); await c2.close();
  });
});

test('without channels in the grant (or with meeting_channel false) nothing is registered and the transcript comes as events, as before', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc, { caps: ['tools', 'pushEvents'] });
    const { id } = await admitted(c);
    audio.say(tonePcm(2));
    await until(() => transcriptPushes(c).some((p) => p.origin.final), 15_000);
    assert.equal(c.registered.length, 0);
    assert.equal((await status(c, id)).channel.registered, false);
    await assert.rejects(c.publish(`bosun:meeting:${id}`, 'hi'), /capability denied: channels.publish/);
    await c.call('meeting_leave', { meeting_id: id });
    // meeting_channel false: no channel at all, even where the host grants channels.
    const h = await host(svc);
    await h.call('speech_settings_set', { meeting_channel: false });
    const m2 = await admitted(h);
    await sleep(800);
    assert.equal(h.registered.length, 0);
    assert.equal((await status(h, m2.id)).channel, undefined);
    await h.call('meeting_leave', { meeting_id: m2.id });
    await c.close(); await h.close();
  });
});

test('finals arrive as channels/incoming (with speaker and seq), not also as events (transcript_events auto); always sends both; a refused one falls back to the event', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id, code } = await admitted(c);
    await until(() => c.registered.length === 1, 10_000);
    fake.room(code).speaking = 'host-1';
    await sleep(700);
    audio.say(tonePcm(2));
    await until(() => c.incoming.some((m) => m.metadata.final), 15_000);
    const fin = c.incoming.find((m) => m.metadata.final);
    assert.equal(fin.channelId, `bosun:meeting:${id}`);
    assert.equal(fin.messageId, `${id}:1`);
    assert.equal(fin.threadId, id);
    assert.deepEqual(fin.author, { id: 'speaker:host-1', name: 'host-1' });
    assert.equal(fin.content.length, 1);
    assert.ok(['Hello Misha, this is a test.', 'And what do you think about it?'].includes(fin.content[0].text), fin.content[0].text);
    assert.equal(fin.metadata.seq, 1);
    assert.equal(fin.metadata.speaker, 'host-1');
    assert.deepEqual(fin.tags, ['bosun:meeting-transcript', `bosun:meeting=${id}`]);
    assert.ok(!c.incoming.some((m) => !m.metadata.final), 'no partials on the channel unless agent_partials');
    await sleep(300);
    assert.equal(transcriptPushes(c).length, 0, 'neither finals nor partials as events while the channel takes them');
    // meeting_transcript has it, with the speaker.
    assert.equal((await c.call('meeting_transcript', { meeting_id: id })).json().segments[0].speaker, 'host-1');
    // always: both.
    await c.call('speech_settings_set', { transcript_events: 'always' });
    audio.say(tonePcm(2));
    await until(() => c.incoming.filter((m) => m.metadata.final).length === 2 && transcriptPushes(c).some((p) => p.origin.final && p.origin.seq === 2), 15_000);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
  // A host that does not accept the message: the final comes as the event after all (auto).
  await withService(async (svc, ev, audio) => {
    const c = await host(svc, { refuse: true });
    const { id } = await admitted(c);
    await until(() => c.registered.length === 1, 10_000);
    audio.say(tonePcm(2));
    await until(() => transcriptPushes(c).some((p) => p.origin.final), 15_000);
    assert.ok(c.incoming.some((m) => m.metadata.final));
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('agent_partials: partial text on the channel too, at most every agent_partials_interval_s, tagged bosun:partial', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { agent_partials: true, agent_partials_interval_s: 1 });
    const { id } = await admitted(c);
    await until(() => c.registered.length === 1, 10_000);
    audio.say(tonePcm(4));
    await until(() => c.incoming.some((m) => m.metadata.final), 15_000);
    const parts = c.incoming.filter((m) => !m.metadata.final);
    assert.ok(parts.length >= 2, `partials: ${parts.length}`);
    assert.ok(parts.every((p) => p.tags.includes('bosun:partial') && p.metadata.seq === 1 && p.messageId.startsWith(`${id}:1:p`)));
    for (let i = 1; i < parts.length; i++) assert.ok(parts[i].at - parts[i - 1].at >= 900, `partials ${parts[i].at - parts[i - 1].at} ms apart`);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('text published to the channel is spoken at once (acknowledged before it plays); text published while it plays joins the same utterance; the microphone goes on once and off once', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id, code } = await admitted(c);
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    const t0 = Date.now();
    const r = await c.publish(chId, 'Sure, one moment. I will check the numbers for you.');
    const published = Date.now();
    assert.equal(r.delivered, true);
    assert.match(r.messageId, new RegExp(`^${id}:out1$`));
    assert.ok(Date.now() - t0 < 1000, 'answered before it is spoken');
    await until(() => audio.players.length === 1, 10_000);
    console.log(`MEASURE channel: first audio ${audio.players[0].startedAt - t0} ms after channels/publish was sent (acknowledged after ${published - t0} ms)`);
    const r2 = await c.publish(chId, 'The total is forty two.');
    assert.equal(r2.delivered, true);
    await until(() => ev.speech.length === 1, 20_000);
    assert.equal(audio.players.length, 1, 'one utterance');
    assert.equal(ev.speech[0].state, 'done');
    assert.equal(ev.speech[0].kind, 'stream');
    // The Supertonic stand-in got every sentence (the first one cut at its comma), in order.
    assert.deepEqual(el.st.speech.slice(-3).map((s) => s.input), ['Sure, one moment.', 'I will check the numbers for you.', 'The total is forty two.']);
    assert.deepEqual(mics(code), [true, false]);
    // After it has played out, the next publish is a new utterance.
    await c.publish(chId, 'Anything else?');
    await until(() => ev.speech.length === 2, 20_000);
    assert.equal(audio.players.length, 2);
    assert.deepEqual(mics(code), [true, false, true, false]);
    // meeting_speak while a stream plays is refused as for any utterance; a publish while meeting_speak plays follows it.
    await c.call('meeting_speak', { meeting_id: id, text: 'One. Two. Three. Four. Five. Six.' });
    await c.publish(chId, 'And then this.');
    await until(() => ev.speech.length === 4, 30_000);
    assert.deepEqual(ev.speech.slice(2).map((e) => e.kind || 'speak'), ['speak', 'stream']);
    assert.deepEqual(mics(code).slice(4), [true, false], 'not muted in between');
    // Not in the call any more: refused.
    await c.call('meeting_leave', { meeting_id: id });
    await assert.rejects(c.publish(chId, 'hi'));
    await c.close();
  });
});

test('chunks are never spoken; with channel_prepare_chunks their sentences are synthesized ahead and the publish that delivers them plays that audio', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id } = await admitted(c);
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    const chunk = (inf, index, delta) => c.notify('channels/outgoing/chunk', { inferenceId: inf, conversationId: 'x', channelId: chId, index, delta });
    const n0 = el.st.speech.length;
    // Off (default): chunks do nothing, and an inference that never publishes says nothing.
    await chunk('inf0', 0, 'Not this. Nor this. ');
    await c.notify('channels/outgoing/complete', { inferenceId: 'inf0', conversationId: 'x', channelId: chId, content: [{ type: 'text', text: 'Not this. Nor this.' }] });
    await sleep(600);
    assert.equal(el.st.speech.length, n0);
    assert.equal(audio.players.length, 0);
    await c.call('speech_settings_set', { channel_prepare_chunks: true });
    await chunk('inf1', 0, 'Good question. The ans');
    await until(() => el.st.speech.length === n0 + 1, 10_000);
    assert.equal(el.st.speech.at(-1).input, 'Good question.');
    await chunk('inf1', 1, 'wer is ye');
    await sleep(300);
    assert.equal(el.st.speech.length, n0 + 1, 'an open sentence waits');
    await chunk('inf1', 2, 's.');
    await c.notify('channels/outgoing/complete', { inferenceId: 'inf1', conversationId: 'x', channelId: chId, content: [{ type: 'text', text: 'Good question. The answer is yes.' }] });
    await until(() => el.st.speech.length === n0 + 2, 10_000);
    assert.equal(el.st.speech.at(-1).input, 'The answer is yes.');
    assert.equal(audio.players.length, 0, 'nothing spoken from chunks');
    // The publish plays the audio made ahead: no new synthesis, one per sentence.
    assert.equal((await c.publish(chId, 'Good question. The answer is yes.')).delivered, true);
    await until(() => ev.speech.length === 1, 20_000);
    assert.equal(el.st.speech.length, n0 + 2);
    assert.equal(audio.players.length, 1);
    // Text published already is not synthesized again when its chunks come after (connectome-host's order).
    await chunk('inf2', 0, 'Good question. ');
    await sleep(500);
    assert.equal(el.st.speech.length, n0 + 2);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('publish limits: more than 2000 characters, or more than 6000 waiting, is refused before it is acknowledged', async () => {
  await withService(async (svc) => {
    const c = await host(svc);
    const { id } = await admitted(c);
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    await assert.rejects(c.publish(chId, 'x'.repeat(2001)), /at most 2000 characters per publish/);
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here, and it goes on for a while longer.`).join(' ').slice(0, 1990);
    assert.equal(long.length, 1990);
    el.st.ttsDelayMs = 3000; // synthesis falls behind: the text waits
    try {
      for (let i = 0; i < 3; i++) assert.equal((await c.publish(chId, long)).delivered, true);
      await assert.rejects(c.publish(chId, long), /too much is still waiting to be said/);
    } finally { el.st.ttsDelayMs = 0; }
    await c.call('meeting_stop_speaking', { meeting_id: id });
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a publish while meeting_speak is still being prepared follows it and never cuts it off; meeting_stop_speaking drops the text waiting and mutes', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id, code } = await admitted(c);
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    el.st.ttsDelayMs = 800;
    try {
      const speaking = c.call('meeting_speak', { meeting_id: id, text: 'One two three. Four five six.' });
      await sleep(100);
      await c.publish(chId, 'After that.');
      assert.equal((await speaking).isError, false);
      await until(() => ev.speech.length === 2, 30_000);
      assert.deepEqual(ev.speech.map((e) => [e.kind || 'speak', e.state]), [['speak', 'done'], ['stream', 'done']]);
      assert.deepEqual(mics(code), [true, false]);
      // Barge-in with channel text waiting behind meeting_speak: all of it stops, and the microphone is muted.
      await c.call('meeting_speak', { meeting_id: id, text: 'Seven eight nine ten eleven twelve thirteen.' });
      await c.publish(chId, 'This waits.');
      const st = (await c.call('meeting_stop_speaking', { meeting_id: id })).json();
      assert.equal(st.stopped, true);
      await sleep(1500);
      assert.equal(audio.players.length, 3, 'the waiting text never played');
      assert.equal(mics(code).at(-1), false);
      assert.equal((await status(c, id)).speaking, undefined);
    } finally { el.st.ttsDelayMs = 0; }
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('an opt-out (staying in the call) closes the channel, cancels a pending acknowledgement and drops channel text waiting', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { ack_on_final: true, ack_delay_ms: 1500, ack_min_words: 1, ack_cooldown_s: 0 });
    const { id, code } = await admitted(c, { leave_on_optout: false });
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    audio.say(tonePcm(2));
    await until(() => c.incoming.some((m) => m.metadata.final), 15_000);
    fake.say(code, 'Alex', "please don't record this");
    await until(() => c.changed.length === 1, 10_000);
    assert.deepEqual(c.changed[0].removed, [chId]);
    await sleep(2000);
    assert.equal(audio.players.length, 0, 'no acknowledgement after the opt-out');
    await assert.rejects(c.publish(chId, 'hi'), /unknown channel/);
    const s = await status(c, id);
    assert.equal(s.channel.open, false);
    assert.equal(s.state, 'admitted');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('an opt-out while text from the channel is still being synthesized: it never plays, and the microphone is muted again', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id, code } = await admitted(c, { leave_on_optout: false });
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    el.st.ttsDelayMs = 1500;
    try {
      await c.publish(chId, 'This should never be heard.');
      await sleep(200);
      fake.say(code, 'Alex', "please don't record this");
      await until(() => c.changed.length === 1, 10_000);
      await sleep(2500);
    } finally { el.st.ttsDelayMs = 0; }
    assert.equal(audio.players.length, 0);
    assert.notEqual(mics(code).at(-1), true, 'not left on');
    assert.equal((await status(c, id)).speaking, undefined);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a featureSets/update notification without capabilities keeps the channels; one that drops channels.register takes them back', async () => {
  await withService(async (svc) => {
    const c = await host(svc);
    const { id } = await admitted(c);
    await until(() => c.registered.length === 1, 10_000);
    await c.notify('featureSets/update', { disabled: [] });
    await sleep(500);
    assert.equal(c.changed.length, 0);
    assert.equal((await status(c, id)).channel.registered, true);
    await c.notify('featureSets/update', { effectiveCapabilities: ['tools', 'pushEvents'] });
    await until(() => c.changed.length === 1);
    assert.equal((await status(c, id)).channel.registered, false);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('chunk preparation is bounded (20 sentences at a time, none longer than 400 characters) and keyed by the exact text', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { channel_prepare_chunks: true });
    const { id } = await admitted(c);
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    const n0 = el.st.speech.length;
    el.st.ttsDelayMs = 1000;
    try {
      const many = Array.from({ length: 100 }, (_, i) => `Item ${i}.`).join(' ') + ' ';
      await c.notify('channels/outgoing/chunk', { inferenceId: 'big', conversationId: 'x', channelId: chId, index: 0, delta: many });
      await c.notify('channels/outgoing/chunk', { inferenceId: 'long', conversationId: 'x', channelId: chId, index: 1, delta: `${'word '.repeat(100)}end. ` });
      await sleep(400);
      assert.equal(el.st.speech.length - n0, 20);
    } finally { el.st.ttsDelayMs = 0; }
    await sleep(1500);
    // The balance is -5, published as 5: the audio made ahead for "-5" is not used.
    await c.notify('channels/outgoing/chunk', { inferenceId: 'neg', conversationId: 'x', channelId: chId, index: 2, delta: 'The balance is -5 dollars. ' });
    await sleep(300);
    const n1 = el.st.speech.length;
    await c.publish(chId, 'The balance is 5 dollars.');
    await until(() => ev.speech.length === 1, 20_000);
    assert.equal(el.st.speech.length, n1 + 1);
    assert.equal(el.st.speech.at(-1).input, 'The balance is 5 dollars.');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('ack_phrases with duplicates: acknowledged again and again without failing (the process lives on)', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { ack_on_final: true, ack_phrases: ['Okay.', 'Okay.'], ack_delay_ms: 0, ack_cooldown_s: 0, ack_min_words: 1 });
    const { id } = await admitted(c);
    await until(() => c.registered.length === 1, 10_000);
    for (let i = 1; i <= 3; i++) {
      await until(async () => !(await status(c, id)).speaking);
      audio.say(tonePcm(2));
      await until(() => c.incoming.filter((m) => m.metadata.final).length === i, 15_000);
      await until(async () => (await status(c, id)).acks === i, 5000);
    }
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('an opt-out ends channel speech still being synthesized at once: the microphone is muted again without waiting for the synthesis', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const { id, code } = await admitted(c, { leave_on_optout: false });
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    el.st.ttsDelayMs = 8000;
    try {
      await c.publish(chId, 'This should never be heard.');
      await until(() => mics(code).at(-1) === true, 5000); // unmuted while it synthesizes
      fake.say(code, 'Alex', "please don't record this");
      await until(() => c.changed.length === 1, 10_000);
      await until(() => mics(code).at(-1) === false, 4000);
      assert.equal((await status(c, id)).speaking, undefined);
    } finally { el.st.ttsDelayMs = 0; }
    assert.equal(audio.players.length, 0);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a host that turned a channel down gets it offered again with its next grant', async () => {
  await withService(async (svc) => {
    const c = await host(svc);
    let refuse = true;
    c.setRequestHandler(z.object({ method: z.literal('channels/register'), params: z.any() }), async (r) => {
      if (!refuse) c.registered.push(...r.params.channels);
      return { results: r.params.channels.map((d) => ({ id: d.id, accepted: !refuse, ...(refuse ? { reason: 'capability_denied' } : {}) })) };
    });
    const { id } = await admitted(c);
    await sleep(800);
    assert.equal((await status(c, id)).channel.registered, false);
    refuse = false;
    await c.request({ method: 'featureSets/update', params: { enabled: [MEETING_SET], effectiveCapabilities: ['tools', 'pushEvents', 'channels.*'] } }, z.any());
    await until(() => c.registered.length === 1, 5000);
    await until(async () => (await status(c, id)).channel.registered === true);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('meeting_stop_speaking during ack_delay_ms: the acknowledgement never plays; a publish while a stream is being stopped starts a new one', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { ack_on_final: true, ack_delay_ms: 1500, ack_min_words: 1, ack_cooldown_s: 0 });
    const { id } = await admitted(c);
    const chId = `bosun:meeting:${id}`;
    await until(() => c.registered.length === 1, 10_000);
    await until(async () => (await status(c, id)).acks === undefined);
    audio.say(tonePcm(2));
    await until(() => c.incoming.some((m) => m.metadata.final), 15_000);
    await c.call('meeting_stop_speaking', { meeting_id: id });
    await sleep(2000);
    assert.equal(audio.players.length, 0, 'the armed acknowledgement was cancelled');
    // A stream stopped while its next sentence is synthesizing; a publish meanwhile is said after it, once.
    await c.call('speech_settings_set', { ack_on_final: false });
    await c.publish(chId, 'First sentence here. Second sentence here.');
    await until(() => audio.players.length === 1, 10_000);
    el.st.ttsDelayMs = 1000;
    try {
      const stopping = c.call('meeting_stop_speaking', { meeting_id: id });
      await sleep(100); // a publish that overtakes the tool call is dropped with what was waiting (it came before the stop)
      await c.publish(chId, 'After the stop.');
      await stopping;
      await until(() => ev.speech.filter((e) => e.kind === 'stream').length === 2, 20_000).catch((e) => { throw new Error(`${e.message}: ${JSON.stringify(ev.speech)} players ${audio.players.length}`); });
    } finally { el.st.ttsDelayMs = 0; }
    assert.equal(audio.players.length, 2);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('grant matching per MCPL §5.4: a bare "*" grants no channel capability; channels.* does', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc, { caps: ['*'] });
    const { id } = await admitted(c);
    await sleep(800);
    assert.equal(c.registered.length, 0, 'a bare * matches depth-1 paths only');
    assert.equal((await status(c, id)).channel.registered, false);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('ack_on_final: the end of someone\'s turn gets a cached clip within ~300 ms (no speech event); the agent speaking first, a short final or the cooldown: none; the agent\'s reply follows the clip without muting in between', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { ack_on_final: true, ack_phrases: ['Mhm.', 'One sec.'], ack_delay_ms: 0, ack_cooldown_s: 0 });
    const n0 = el.st.speech.length;
    const { id, code } = await admitted(c);
    // Pre-synthesized at admission, once per phrase.
    await until(() => el.st.speech.length === n0 + 2, 10_000);
    assert.deepEqual(new Set(el.st.speech.slice(n0).map((s) => s.input)), new Set(['Mhm.', 'One sec.']));
    await until(() => c.registered.length === 1, 10_000);
    audio.say(tonePcm(2));
    await until(() => c.incoming.some((m) => m.metadata.final), 15_000);
    const finalAt = c.incoming.find((m) => m.metadata.final).at;
    await until(() => audio.players.length === 1, 5000);
    const lag = audio.players[0].startedAt - finalAt;
    console.log(`MEASURE ack: first audio ${lag} ms after the final reached the host`);
    assert.ok(lag < 600, `ack ${lag} ms after the final reached the host`); // the final reaches the host and the ack starts at the same moment
    await until(async () => (await status(c, id)).acks === 1, 5000);
    await until(() => mics(code).length === 2);
    assert.equal(ev.speech.length, 0, 'no speech event for an acknowledgement');
    assert.equal(el.st.speech.length, n0 + 2, 'from the cache');
    // The agent answers while the clip plays: its reply starts after it, the microphone stays on.
    await until(async () => !(await status(c, id)).speaking);
    audio.say(tonePcm(2));
    await until(() => audio.players.length === 2, 15_000);
    await c.publish(`bosun:meeting:${id}`, 'Yes, I think so.');
    await until(() => ev.speech.length === 1, 20_000);
    assert.equal(ev.speech[0].kind, 'stream');
    const [ack2, reply] = audio.players.slice(1);
    assert.ok(reply.startedAt - ack2.startedAt >= 400, `the reply ${reply.startedAt - ack2.startedAt} ms after the clip started (it lasts 0.5 s)`);
    assert.deepEqual(mics(code).slice(2), [true, false], 'one unmute, one mute');
    // A final too short to end a turn: no clip.
    await c.call('speech_settings_set', { ack_min_words: 20 });
    const players = audio.players.length;
    audio.say(tonePcm(2));
    await until(() => c.incoming.filter((m) => m.metadata.final).length === 3, 15_000);
    await sleep(600);
    assert.equal(audio.players.length, players);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('speaker labels: Zoom\'s active speaker and Meet\'s speaking tile name the segment; Bosun\'s own tile never does', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc, { caps: ['tools', 'pushEvents'] });
    // Meet: our own tile lighting up is not a speaker.
    const { id, code } = await admitted(c);
    fake.set(code, { selfSpeaking: true });
    await sleep(600);
    audio.say(tonePcm(2));
    await until(() => transcriptPushes(c).some((p) => p.origin.final), 15_000);
    assert.equal(transcriptPushes(c).find((p) => p.origin.final).origin.speaker, undefined);
    fake.set(code, { selfSpeaking: false, speaking: 'guest-2' });
    await sleep(600);
    audio.say(tonePcm(2));
    await until(() => transcriptPushes(c).some((p) => p.origin.final && p.origin.seq === 2), 15_000);
    const fin = transcriptPushes(c).find((p) => p.origin.final && p.origin.seq === 2);
    assert.equal(fin.origin.speaker, 'guest-2');
    assert.match(fin.payload.content[0].text, /, guest-2\): /);
    assert.equal((await status(c, id)).speaker_labels, 'seen');
    await c.call('meeting_leave', { meeting_id: id });

    // Zoom (a guest join is enough): the speaker view's active tile.
    const { id: zid, url: zurl } = fz.newRoom({ open: true });
    const zj = await c.call('meeting_join', { url: zurl, live_transcript: true });
    assert.equal(zj.isError, false, zj.text);
    const z = zj.json().meeting_id;
    await until(async () => (await status(c, z)).state === 'recording', 20_000);
    fz.room(zid).speaking = 'Host Person';
    await sleep(600);
    audio.say(tonePcm(2));
    await until(() => transcriptPushes(c).some((p) => p.origin.final && p.origin.meeting_id === z), 15_000);
    assert.equal(transcriptPushes(c).find((p) => p.origin.final && p.origin.meeting_id === z).origin.speaker, 'Host Person');
    await c.call('meeting_leave', { meeting_id: z });
    await c.close();
  });
});

// Live Zoom, 2026-10-28 (addendum item 6): "admitted" 13 s after the join while the bot sat in the waiting room for
// 44 min, then "recording" silence. The waiting room there had a chat with the host.
test('Zoom waiting room with a chat button: stays waiting (nothing announced, recorded or transcribed) until the host lets it in', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc, { caps: ['tools', 'pushEvents'] });
    for (const waitingText of ['Please wait, the meeting host will let you in soon.', 'Waiting for the host to let you in']) {
      const conns = el.conns.length;
      const { id: zid, url } = fz.newRoom({ waitingChat: true, waitingText });
      const j = await c.call('meeting_join', { url, live_transcript: true });
      assert.equal(j.isError, false, j.text);
      const id = j.json().meeting_id;
      assert.equal(j.json().state, 'waiting', waitingText);
      await sleep(4000);
      const s = await status(c, id);
      assert.equal(s.state, 'waiting', waitingText);
      assert.equal(s.admitted_at, null);
      assert.equal(fz.room(zid).chat.length, 0, 'nothing announced');
      assert.equal(audio.recorders.length, 0, 'nothing recorded');
      assert.equal(el.conns.length, conns, 'nothing transcribed');
      // Let in: now the announcement, then the recording.
      fz.admit(zid);
      await until(async () => (await status(c, id)).state === 'recording', 20_000);
      assert.ok(fz.room(zid).chat.length >= 1);
      await c.call('meeting_leave', { meeting_id: id });
      await until(() => ev.ended.length === (waitingText.startsWith('Please') ? 1 : 2), 10_000);
      audio.recorders.length = 0;
    }
    await c.close();
  });
});

test('Zoom: a participant named "Waiting Room" on the active tile does not keep Bosun out of the call', async () => {
  await withService(async (svc) => {
    const c = await host(svc, { caps: ['tools', 'pushEvents'] });
    const { url } = fz.newRoom({ open: true, speaking: 'Waiting Room' });
    const id = (await c.call('meeting_join', { url })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 20_000);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

// Zoom muting again after speaking (live Zoom, 2026-10-28: "no microphone control found in Zoom", the microphone left
// on): the in-call control turned out to be one Playwright's button lookups miss.
async function zoomSpeak(svc, room) {
  const c = await host(svc, { caps: ['tools', 'pushEvents'] });
  const { id: zid, url } = fz.newRoom({ open: true, ...room });
  const j = await c.call('meeting_join', { url });
  assert.equal(j.isError, false, j.text);
  const id = j.json().meeting_id;
  await until(async () => (await status(c, id)).state === 'recording', 20_000).catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await status(c, id))}`); });
  const r = await c.call('meeting_speak', { meeting_id: id, text: 'Hello everyone, this is Glassy.', wait: true }, { timeout: 90_000 });
  return { c, zid, id, r: r.json() };
}
const zmics = (zid) => fz.room(zid).media.filter((m) => 'mic' in m && !('audio' in m));

test('Zoom: the faded toolbar hidden for good (visibility) while it spoke: muted again through the page all the same', async () => {
  await withService(async (svc) => {
    const { c, zid, id, r } = await zoomSpeak(svc, { autoHideMs: 1000, hideToolbar: true });
    assert.equal(r.state, 'done');
    assert.equal(r.mic_open, undefined, JSON.stringify(r));
    assert.deepEqual(zmics(zid).map((m) => m.mic).slice(-2), [true, false]);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('Zoom: a microphone control that is only a <div> once on is still muted again (clicked in the page)', async () => {
  await withService(async (svc) => {
    const { c, zid, id, r } = await zoomSpeak(svc, { micDiv: true });
    assert.equal(r.state, 'done');
    assert.equal(r.mic_open, undefined, JSON.stringify(r));
    assert.deepEqual(zmics(zid).map((m) => m.mic).slice(-2), [true, false]);
    assert.equal((await status(c, id)).mic_open, undefined);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('Zoom: a control that ignores clicks is muted with Alt+A, checked after', async () => {
  await withService(async (svc) => {
    const { c, zid, id, r } = await zoomSpeak(svc, { micDiv: true, micClickIgnored: true, altA: true });
    assert.equal(r.mic_open, undefined, JSON.stringify(r));
    assert.deepEqual({ ...zmics(zid).at(-1), at: 0 }, { mic: false, cam: false, via: 'alt+a', at: 0 });
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('Zoom: a microphone nothing can mute is reported loudly: mic_open in the result and the status, a bosun:meeting-mic-open event; Alt+A is never pressed blind', async () => {
  await withService(async (svc, ev) => {
    const { c, zid, id, r } = await zoomSpeak(svc, { micDiv: true, micClickIgnored: true });
    assert.equal(r.mic_open, true);
    assert.match(r.mute_error, /no microphone control found in Zoom; the page shows it on \("mute my microphone"\), and neither clicking it in the page nor Alt\+A changed it/);
    const s = await status(c, id);
    assert.equal(s.mic_open, true);
    await until(() => ev['mic-open'].length >= 1);
    await until(() => c.pushes.some((p) => p.tags.includes('bosun:meeting-mic-open')));
    const p = c.pushes.find((x) => x.tags.includes('bosun:meeting-mic-open'));
    assert.match(p.payload.content[0].text, /^WARNING: Bosun's microphone may still be ON in meeting/);
    assert.match(c.pushes.find((x) => x.tags.includes('bosun:meeting-speech')).payload.content[0].text, /^WARNING: Bosun's microphone may still be ON/);
    assert.ok(!fz.room(zid).media.some((m) => m.via === 'alt+a'));
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});
