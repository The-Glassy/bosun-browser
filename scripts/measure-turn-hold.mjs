#!/usr/bin/env node
// What turn_hold_complete_ms does to a meeting turn (not part of npm test; needs the test stand-ins only, no internet):
//   node scripts/measure-turn-hold.mjs [holds_ms...] [--gaps 0.6,1.0,1.4]
// For each hold value, a speaker says a full sentence, pauses `gap` seconds and goes on. Measured through MCP against the
// Meet and ElevenLabs stand-ins (the stand-in commits a final after 1 s of silence; its first partial comes ~0.5 s into
// new speech): how long the final was held before it reached the agent's channel (held_ms), and whether the
// continuation was merged into the same turn or arrived as a second turn. Writes docs/measurements/turn-hold.json.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { startBosun, connect, until, sleep } from '../test/helpers.mjs';
import { startFakeMeet, fakeAudio } from '../test/fakemeet.mjs';
import { startFakeElevenLabs, tonePcm } from '../test/fakeelevenlabs.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { MEETING_SET } from '../src/events.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const gi = args.indexOf('--gaps');
const gaps = gi >= 0 ? args.splice(gi, 2)[1].split(',').map(Number) : [1.2, 1.5, 1.8, 2.1];
const holds = args.length ? args.map(Number) : [0, 150, 300, 500, 800];
const MCPL = { experimental: { mcpl: { version: '0.5', pushEvents: true, channels: { register: true, publish: true, incoming: true, streaming: true } } } };
const silence = (s) => Buffer.alloc(Math.round(s * 16000) * 2);

const fake = await startFakeMeet();
const el = await startFakeElevenLabs();
const rows = [];
try {
  for (const hold of holds) {
    for (const gap of gaps) {
      const audio = fakeAudio();
      const svc = await startBosun({ KEEPALIVE: '0', ELEVENLABS_API_KEY: el.key, ELEVENLABS_BASE_URL: el.base, TTS_URL: el.base }, {
        meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 },
      });
      try {
        const c = await connect(svc, undefined, { capabilities: MCPL });
        const incoming = [], registered = [];
        c.setRequestHandler(z.object({ method: z.literal('push/event'), params: z.any() }), async () => ({ accepted: true }));
        c.setRequestHandler(z.object({ method: z.literal('channels/register'), params: z.any() }), async (r) => (registered.push(...r.params.channels), { registered: r.params.channels.map((d) => d.id), results: r.params.channels.map((d) => ({ id: d.id, accepted: true })) }));
        c.setRequestHandler(z.object({ method: z.literal('channels/incoming'), params: z.any() }), async (r) => { incoming.push(...r.params.messages.map((m) => ({ ...m, at: Date.now() }))); return { results: r.params.messages.map((m) => ({ messageId: m.messageId, accepted: true })) }; });
        c.setNotificationHandler(z.object({ method: z.literal('channels/changed'), params: z.any() }), async () => {});
        await c.request({ method: 'featureSets/update', params: { enabled: [MEETING_SET], effectiveCapabilities: ['tools', 'pushEvents', 'channels.*'] } }, z.any());
        // turn_hold_ms stays at its default (900): only the hold after a complete sentence changes.
        await c.call('speech_settings_set', { turn_hold_complete_ms: hold, turn_extend_s: 0 });
        const { code, url } = fake.newRoom();
        const id = (await c.call('meeting_join', { url, live_transcript: true })).json().meeting_id;
        fake.admit(code);
        await until(async () => (await c.call('meeting_status', { meeting_id: id })).json().state === 'recording', 15_000);
        await until(() => registered.length === 1, 10_000);
        el.st.phrases = ['The plan looks good to me.', 'And the budget is fine too.'];
        el.st.phraseAt = 0;
        audio.say(Buffer.concat([tonePcm(1.5), silence(gap), tonePcm(1.5), silence(4)]));
        const finals = () => incoming.filter((m) => m.metadata.final);
        await until(() => finals().some((f) => /budget/.test(f.content[0].text)), 25_000).catch((e) => { console.log(JSON.stringify(incoming.map((m) => [m.metadata.final, m.content[0].text]))); throw e; });
        await sleep(300);
        const f = finals();
        rows.push({ turn_hold_complete_ms: hold, gap_s: gap, turns: f.length, merged: f.length === 1, first_held_ms: f[0].metadata.held_ms });
        console.log(`hold ${hold} ms, pause ${gap} s: ${f.length === 1 ? 'one turn (merged)' : `${f.length} turns (split)`}, first final held ${f[0].metadata.held_ms} ms`);
        await c.call('meeting_leave', { meeting_id: id });
        await c.close();
      } finally { await svc.stop(); }
    }
  }
} finally { await fake.close(); await el.close(); }
fs.mkdirSync(path.join(ROOT, 'docs', 'measurements'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', 'measurements', 'turn-hold.json'), JSON.stringify({ at: new Date().toISOString(), stand_in: { commit_after_silence_s: 1, first_partial_s: 0.5 }, rows }, null, 1));
