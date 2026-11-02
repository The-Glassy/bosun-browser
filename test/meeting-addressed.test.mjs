// The addressed mark (0.20.0): every final says whether it names the agent (the join name, the account name the call
// shows, the speech setting name_aliases), whatever the case, accents, spelling or Ukrainian/Russian form; Bosun only
// marks it. Unit cases for the matcher, then through MCP against the Meet and ElevenLabs stand-ins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { startFakeElevenLabs, tonePcm, toneWav } from './fakeelevenlabs.mjs';
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

import { aliasKeys, isAddressed, nameKey } from '../src/meetings/addressed.mjs';
import fs from 'fs';
import path from 'path';

test('addressed matcher: the join name in any case, accents, spelling and its Ukrainian/Russian forms; whole words only', () => {
  const keys = aliasKeys({ names: ['Glassy (notetaker)', 'Glassy Notetaker'], aliases: ['Гласька', 'AI', 'Mr Bot'] });
  for (const t of ['Glassy, what do you think?', 'glassy?', 'GLÁSSY!', 'Glassi, can you check?', 'Glassy’s notes are wrong', 'Гласі, що скажеш?',
    'Глассі, привіт', 'Гласси, ответь пожалуйста', 'а що думає гласі', 'Hey Гласька', 'ask mr. bot', 'Glassy Notetaker please', 'Hlassi?']) {
    assert.equal(isAddressed(t, keys), true, t);
  }
  for (const t of ['a glass of water', 'we talked about glasses', 'AI will do it', 'Notetaker please', 'Mr Smith and a bot', 'Класи', '', 'Гласько']) {
    assert.equal(isAddressed(t, keys), false, t);
  }
  // Keys: one per spelling family; too short to count on its own: nothing.
  assert.deepEqual([nameKey('Glassy'), nameKey('Гласі'), nameKey('Глассі'), nameKey('Гласси'), nameKey('GLÁSSY')], ['glasi', 'glasi', 'glasi', 'glasi', 'glasi']);
  assert.deepEqual(aliasKeys({ names: ['AI'] }), []);
  assert.equal(isAddressed('Glassy?', []), false);
});

test('addressed on the channel: every final carries addressed true|false (join name, Ukrainian form, name_aliases); events too; Bosun only marks', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const set = await c.call('speech_settings_set', { turn_hold_ms: 0, name_aliases: ['Notetaker Bot'], transcript_events: 'always' });
    assert.equal(set.isError, false, set.text);
    assert.deepEqual(set.json().effective.name_aliases, ['Notetaker Bot']);
    const { id } = await admitted(c);
    phrases('Glassy, can you check the numbers?', 'The plan looks good to me.', 'Гласі, що скажеш?', 'Ask the notetaker bot later.');
    audio.say(Buffer.concat([tonePcm(1.2), silence(2.5), tonePcm(1.2), silence(2.5), tonePcm(1.2), silence(2.5), tonePcm(1.2)]));
    await until(() => c.finals().length === 4, 30_000);
    assert.deepEqual(c.finals().map((f) => [f.content[0].text, f.metadata.addressed]), [
      ['Glassy, can you check the numbers?', true], ['The plan looks good to me.', false], ['Гласі, що скажеш?', true], ['Ask the notetaker bot later.', true]]);
    // Partials carry no mark; the bosun:meeting-transcript events of finals do.
    assert.ok(c.incoming.filter((m) => !m.metadata.final).every((m) => !('addressed' in m.metadata)));
    await until(() => ev.transcript.filter((e) => e.final).length === 4, 5000);
    assert.deepEqual(ev.transcript.filter((e) => e.final).map((e) => e.addressed), [true, false, true, true]);
    // Nothing is said or posted for being addressed: that is the agent's call.
    assert.equal(audio.players.length, 0);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('name_aliases: checked (up to 20 names of 1-60 characters), null removes it; another tenant\'s file is untouched', async () => {
  await withService(async (svc) => {
    const c = await host(svc);
    for (const bad of [[''], ['x'.repeat(61)], Array(21).fill('a'), 'Glassy', [3]]) {
      const r = await c.call('speech_settings_set', { name_aliases: bad });
      assert.equal(r.isError, true, JSON.stringify(bad));
    }
    assert.deepEqual((await c.call('speech_settings_get')).json().effective.name_aliases, []);
    assert.deepEqual((await c.call('speech_settings_set', { name_aliases: ['Гласька', 'Glassy AI'] })).json().settings.name_aliases, ['Гласька', 'Glassy AI']);
    const r = (await c.call('speech_settings_set', { name_aliases: null })).json();
    assert.equal('name_aliases' in r.settings, false);
    assert.equal(r.from.name_aliases, 'default');
    assert.equal(fs.existsSync(path.join(svc.dataDir, 'speech-settings', 'bob.json')), false);
    await c.close();
  });
});

test('addressed: with a signed-in profile the account name the call shows counts too (Meet: our own tile)', async () => {
  await withService(async (svc, ev, audio) => {
    const c = await host(svc);
    const s0 = await c.open({ profile: 'google', engine: 'chromium' });
    await c.call('session_close', { session: s0 });
    await c.call('speech_settings_set', { turn_hold_ms: 0 });
    const { code, url } = fake.newRoom();
    fake.set(code, { signedIn: true, open: true, selfName: 'Alex Account' });
    const id = (await c.call('meeting_join', { url, profile: 'google', name: 'Glassy', live_transcript: true })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    await until(() => c.registered.length === 1, 10_000);
    phrases('Alex, what do you think?', 'Glassy, and you?', 'Nobody named here.');
    audio.say(Buffer.concat([tonePcm(1.2), silence(2.5), tonePcm(1.2), silence(2.5), tonePcm(1.2)]));
    await until(() => c.finals().length === 3, 30_000);
    assert.deepEqual(c.finals().map((f) => f.metadata.addressed), [true, true, false]);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});
