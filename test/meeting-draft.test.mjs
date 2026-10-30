// Drafts in 0.18.0 (meeting_draft), through MCP against the Meet stand-in, the fake audio backend and the local
// ElevenLabs/Supertonic stand-in: a draft marked ready while the speaker still talks has its first sentence synthesized
// at once and said the moment the turn reaches the agent; a final that added more than draft_max_new_words words (or
// a "not") drops it; the final says what became of it; a publish that starts with the sentence skips it; a barge-in or
// a reopened turn drops the draft; it is off unless the tenant or the meeting turns it on.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { startFakeElevenLabs, tonePcm } from './fakeelevenlabs.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { afterPrefix, addedWords, sentencesOf } from '../src/meetings/index.mjs';
import { normalize } from '../src/meetings/optout.mjs';
import { MEETING_SET } from '../src/events.mjs';

let fake, el;
before(async () => { [fake, el] = await Promise.all([startFakeMeet(), startFakeElevenLabs()]); });
after(async () => { await Promise.all([fake?.close(), el?.close()]); });

const MCPL = { experimental: { mcpl: { version: '0.5', pushEvents: true, channels: { register: true, publish: true, incoming: true, streaming: true } } } };
const silence = (seconds) => Buffer.alloc(Math.round(seconds * 16000) * 2);
const phrases = (...p) => { el.st.phrases = p; el.st.phraseAt = 0; };
// Text the Supertonic stand-in was asked to synthesize (after n0 requests).
const synthesized = (n0 = 0) => el.st.speech.slice(n0).map((s) => s.input);

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
  c.publish = (channelId, text, more = {}) => c.request({ method: 'channels/publish', params: { conversationId: '', channelId, content: [{ type: 'text', text }], ...more } }, z.any());
  c.finals = () => c.incoming.filter((m) => m.metadata.final && !m.metadata.echo_suspected);
  c.draft = async (meeting_id, a) => { const r = await c.call('meeting_draft', { meeting_id, ...a }); assert.equal(r.isError, false, r.text); return r.json(); };
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
// The newest partial of the live transcript with at least n words (transcript_events always).
const partialWith = (ev, n) => ev.transcript.filter((s) => !s.final && s.text.split(' ').length >= n).at(-1);
// turn_extend_s 0: the turns here go unanswered, and would otherwise be reopened by the next one.
const DRAFTS = { draft_enabled: true, transcript_events: 'always', turn_hold_ms: 300, turn_hold_complete_ms: 300, turn_extend_s: 0 };

test('afterPrefix / addedWords / sentencesOf: the pieces the draft and stream checks are made of', () => {
  assert.equal(afterPrefix('The budget is fine. It was approved.', 'the budget is FINE'), 'The budget is fine. '.length);
  assert.equal(afterPrefix('Yes, absolutely. More.', 'Yes.'), 'Yes, '.length);
  assert.equal(afterPrefix('The budget is fine.', 'The budget is fine.'), 'The budget is fine.'.length);
  assert.equal(afterPrefix('The budgets are fine.', 'The budget is fine.'), -1);
  assert.equal(afterPrefix('The budget', 'The budget is fine.'), -1);
  assert.equal(afterPrefix('Anything', ''), 0);
  assert.deepEqual(addedWords(['can', 'we', 'meet', 'on', 'friday'], ['can', 'we', 'meet', 'on', 'friday', 'but', 'not', 'today']), ['but', 'not', 'today']);
  assert.deepEqual(addedWords(['can', 'we', 'meat'], ['can', 'we', 'meet']), ['meet'], 'a changed word counts');
  assert.deepEqual(addedWords([], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(addedWords(['a', 'b', 'c'], ['a', 'c']), [], 'words dropped by the final add nothing');
  assert.deepEqual(sentencesOf('One. Two? Three'), ['One.', 'Two?', 'Three']);
  assert.deepEqual(sentencesOf('Just one'), ['Just one']);
  assert.equal(normalize('Hello, World!'), 'hello world');
});

test('a ready draft: its first sentence is synthesized at once, said the moment the turn reaches the agent (no synthesis then), the final says so; the publish starting with it skips it', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', DRAFTS);
    const { id, chId } = await admitted(c);
    const n0 = el.st.speech.length;
    phrases('Can you tell me what the budget for next year is?');
    audio.say(tonePcm(5.5));
    await until(() => partialWith(ev, 9), 15_000);
    const p = partialWith(ev, 9);
    const r = await c.draft(id, { text: 'The budget is two million euros. It was approved in May.', ready: true, for_turn_seq: p.seq });
    assert.equal(r.draft, 'set');
    assert.equal(r.sentence, 'The budget is two million euros.');
    assert.ok(r.heard_words >= 9, `heard ${r.heard_words}`);
    await until(() => synthesized(n0).includes('The budget is two million euros.'), 5000);
    assert.equal(c.finals().length, 0, 'synthesized while the turn is still being said');
    assert.equal(audio.players.length, 0);
    await until(() => c.finals().length === 1, 15_000);
    const f = c.finals()[0];
    assert.equal(f.metadata.draft, 'spoken');
    assert.equal(f.metadata.draft_text, 'The budget is two million euros.');
    assert.ok(f.metadata.draft_new_words <= 4);
    assert.ok(f.tags.includes('bosun:draft-spoken'));
    assert.match(f.content[1].text, /already said the first sentence of your draft: "The budget is two million euros\."/);
    await until(() => audio.players.length === 1, 5000);
    const lag = audio.players[0].startedAt - f.at;
    console.log(`MEASURE draft: first audio ${lag} ms after the final reached the agent (pre-synthesized)`);
    assert.ok(lag < 600, `${lag} ms`);
    assert.equal(synthesized(n0).filter((t) => t === 'The budget is two million euros.').length, 1, 'not synthesized again');
    // The publish repeats the sentence: skipped; the rest joins the same utterance.
    const pub = await c.publish(chId, 'The budget is two million euros. It was approved in May.');
    assert.equal(pub.delivered, true);
    assert.equal(pub.draft_prefix_skipped, true);
    assert.equal(pub.draft_said, 'The budget is two million euros.');
    await until(() => ev.speech.length === 1, 20_000);
    assert.equal(ev.speech[0].state, 'done');
    assert.deepEqual(synthesized(n0), ['The budget is two million euros.', 'It was approved in May.']);
    assert.equal(audio.players.length, 1, 'one utterance');
    const st = await status(c, id);
    assert.deepEqual(st.drafts, { spoken: 1, dropped: 0 });
    // A second publish for the same turn that repeats it is said in full (the check is used up).
    const pub2 = await c.publish(chId, 'The budget is two million euros.');
    assert.equal(pub2.draft_prefix_skipped, undefined);
    await until(() => ev.speech.length === 2, 20_000);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('dropped drafts: too many new words, a "not" among the new words, not ready, set before the turn began; a publish that starts otherwise is said in full', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', DRAFTS);
    const { id, chId } = await admitted(c);
    // Marked ready after two words: the final adds seven.
    phrases('Can you tell me what the budget is?');
    audio.say(tonePcm(4));
    await until(() => partialWith(ev, 2), 15_000);
    await c.draft(id, { text: 'Sure, here it is.', ready: true });
    await until(() => c.finals().length === 1, 15_000);
    assert.equal(c.finals()[0].metadata.draft, 'dropped');
    assert.equal(c.finals()[0].metadata.draft_reason, 'new_words');
    assert.ok(c.finals()[0].metadata.draft_new_words > 4);
    assert.match(c.finals()[0].content[1].text, /your draft was not said: new_words/);
    await sleep(600);
    assert.equal(audio.players.length, 0, 'nothing said');
    // "... on Friday but" -> "... on Friday but not today": two new words, one of them "not".
    ev.transcript.length = 0;
    phrases('Can we meet on Friday but not today');
    audio.say(Buffer.concat([silence(0.5), tonePcm(4)]));
    await until(() => partialWith(ev, 6), 15_000);
    await c.draft(id, { text: 'Friday works for me.', ready: true, for_turn_seq: partialWith(ev, 6).seq });
    await until(() => c.finals().length === 2, 15_000);
    assert.equal(c.finals()[1].metadata.draft, 'dropped');
    assert.equal(c.finals()[1].metadata.draft_reason, 'meaning_may_change');
    assert.ok(c.finals()[1].metadata.draft_new_words <= 4);
    // Not ready.
    ev.transcript.length = 0;
    phrases('What do you think about it?');
    audio.say(Buffer.concat([silence(0.5), tonePcm(3)]));
    await until(() => partialWith(ev, 2), 15_000);
    await c.draft(id, { text: 'I think it is fine.' });
    await until(() => c.finals().length === 3, 15_000);
    assert.equal(c.finals()[2].metadata.draft, 'dropped');
    assert.equal(c.finals()[2].metadata.draft_reason, 'not_ready');
    // Set before the turn began (no for_turn_seq): not for this turn.
    await c.draft(id, { text: 'Old idea.', ready: true });
    await sleep(300);
    phrases('Another question for you now.');
    audio.say(tonePcm(3));
    await until(() => c.finals().length === 4, 15_000);
    assert.equal(c.finals()[3].metadata.draft, 'dropped');
    assert.equal(c.finals()[3].metadata.draft_reason, 'other_turn');
    // No draft: none.
    phrases('And one more thing.');
    audio.say(Buffer.concat([silence(0.5), tonePcm(2)]));
    await until(() => c.finals().length === 5, 15_000);
    assert.equal(c.finals()[4].metadata.draft, 'none');
    assert.equal(c.finals()[4].content.length, 1, 'no note when there was no draft');
    assert.equal(audio.players.length, 0);
    // A spoken draft, then a publish that starts differently: said in full, nothing stopped.
    ev.transcript.length = 0;
    phrases('Is the plan ready for review?');
    audio.say(tonePcm(3.5));
    await until(() => partialWith(ev, 5), 15_000);
    await c.draft(id, { text: 'Yes, it is ready.', ready: true });
    await until(() => c.finals().length === 6, 15_000);
    assert.equal(c.finals()[5].metadata.draft, 'spoken');
    const pub = await c.publish(chId, 'Mostly. One section is missing.');
    assert.equal(pub.draft_prefix_skipped, false);
    await until(() => ev.speech.length >= 1 && ev.speech.at(-1).state === 'done' && el.st.speech.some((s) => s.input === 'One section is missing.'), 20_000);
    assert.ok(ev.speech.every((s) => s.state === 'done'), JSON.stringify(ev.speech));
    assert.deepEqual((await status(c, id)).drafts, { spoken: 1, dropped: 4 });
    // A draft for a turn that has reached the agent already: too late.
    const late = await c.draft(id, { text: 'Too late.', ready: true, for_turn_seq: c.finals()[5].metadata.turn_seq });
    assert.equal(late.draft, 'too_late');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a barge-in drops the draft; so does a turn reopened while the agent still thinks (turn_extended)', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    await c.call('speech_settings_set', { ...DRAFTS, turn_hold_ms: 400, turn_extend_s: 20 });
    const { id, chId } = await admitted(c);
    await c.publish(chId, 'This is the first sentence of a rather long answer. And here is a second sentence that keeps on going for a while.');
    await until(() => audio.players.length === 1, 10_000);
    await c.draft(id, { text: 'Prepared while I was speaking.', ready: true });
    phrases('Wait, stop, I have a question.');
    audio.say(tonePcm(2));
    await until(() => ev.speech.length === 1, 10_000);
    assert.equal(ev.speech[0].barge_in, true);
    assert.equal((await status(c, id)).draft, undefined, 'dropped at the barge-in');
    await until(() => c.finals().length === 1, 15_000);
    assert.equal(c.finals()[0].metadata.draft, 'none');
    await c.publish(chId, 'Go ahead.'); // answered: not reopened by what comes next
    await until(() => ev.speech.length === 2, 10_000);
    // Turn 2 reaches the agent; a draft set for what comes next, then the speaker goes on: the turn is reopened.
    phrases('Here is my first point.', 'And here is the second one.');
    audio.say(Buffer.concat([silence(0.5), tonePcm(1.5), silence(2.5), tonePcm(1.5)]));
    await until(() => c.finals().length === 2, 15_000);
    await c.draft(id, { text: 'Good point.', ready: true });
    await until(() => c.incoming.some((m) => m.tags.includes('bosun:meeting-turn-extended')), 15_000);
    assert.equal((await status(c, id)).draft, undefined, 'dropped when the turn was reopened');
    await until(() => c.finals().length === 3, 15_000);
    assert.equal(c.finals()[2].metadata.extends_turn, c.finals()[1].metadata.turn_seq);
    assert.equal(c.finals()[2].metadata.draft, 'none');
    assert.equal(audio.players.length, 2, 'only the answers were said');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('off by default (speech_settings_get shows the new keys off; meeting_draft refused; finals carry no draft); meeting_join can turn it on for one meeting', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const g = (await c.call('speech_settings_get', {})).json();
    assert.equal(g.effective.draft_enabled, false);
    assert.equal(g.effective.draft_max_new_words, 4);
    assert.equal(g.effective.speculative_speech, false);
    assert.equal(g.from.draft_enabled, 'default');
    const { id } = await admitted(c);
    const r = await c.call('meeting_draft', { meeting_id: id, text: 'Hello.', ready: true });
    assert.equal(r.isError, true);
    assert.match(r.text, /drafts are off/);
    phrases('Hello there, how are you?');
    audio.say(tonePcm(2));
    await until(() => c.finals().length === 1, 15_000);
    assert.equal(c.finals()[0].metadata.draft, undefined);
    assert.equal(c.finals()[0].content.length, 1);
    await c.call('meeting_leave', { meeting_id: id });
    // On for this meeting only.
    c.registered.length = 0;
    const m2 = await admitted(c, { draft_enabled: true, draft_max_new_words: 2 });
    assert.deepEqual((await status(c, m2.id)).settings, { draft_enabled: true, draft_max_new_words: 2 });
    assert.equal((await c.draft(m2.id, { text: 'Fine.', ready: false })).draft, 'set');
    assert.equal((await c.draft(m2.id, { text: '' })).draft, 'cleared');
    assert.equal((await c.call('speech_settings_get', {})).json().effective.draft_enabled, false, 'the tenant setting is untouched');
    const bad = await c.call('meeting_join', { url: fake.newRoom().url, draft_max_new_words: 51 });
    assert.equal(bad.isError, true);
    await c.call('meeting_leave', { meeting_id: m2.id });
    await c.close();
  });
});
