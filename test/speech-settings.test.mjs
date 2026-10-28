// Speech settings per tenant (src/meetings/settings.mjs): validation like the env values, persisted per tenant,
// precedence tenant setting > env > built-in default (a call's own value wins over all of them: meeting-live tests),
// elevenlabs without a key falls back to supertonic with a warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.mjs';
import { SpeechSettings, DEFAULTS } from '../src/meetings/settings.mjs';
import { tmpDir } from './helpers.mjs';

const KEY = { ELEVENLABS_API_KEY: 'el-key-0123456789' };
const settings = (env) => { const dataDir = tmpDir('speech-'); return new SpeechSettings({ ...loadConfig(env), dataDir }); };

test('defaults without env or settings; env fallbacks; the tenant\'s settings over them', () => {
  const none = settings(KEY).get('a');
  assert.deepEqual(none, {
    settings: {},
    effective: { backend: 'supertonic', elevenlabs_model: 'eleven_v4_turbo', elevenlabs_voice: 'EXAVITQu4vr4xnSDxMaL', supertonic_voice: null, vad_silence_s: 0.5, ...DEFAULTS },
    from: { backend: 'default', elevenlabs_model: 'default', elevenlabs_voice: 'default', supertonic_voice: 'default', vad_silence_s: 'default', ...Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, 'default'])) },
  });
  assert.deepEqual(DEFAULTS, {
    meeting_channel: true, transcript_events: 'auto', agent_partials: false, agent_partials_interval_s: 1.5, channel_prepare_chunks: false,
    ack_on_final: false, ack_phrases: ['Mhm.', 'One sec.', 'Okay.', 'Right.'], ack_lang: null, ack_delay_ms: 100, ack_min_words: 3, ack_cooldown_s: 8,
    turn_hold_ms: 900, turn_hold_complete_ms: 300, barge_in: true, barge_in_min_words: 2, barge_in_min_s: 0.6,
  });
  const s = settings({ ...KEY, TTS_DEFAULT_BACKEND: 'elevenlabs', ELEVENLABS_TTS_MODEL: 'eleven_flash_v2_5', ELEVENLABS_VOICE: 'SAz9YHcvj6GT2YYXdXww', TTS_VOICE: 'supertonic-F2', LIVE_TRANSCRIPT_VAD_SILENCE_S: '0.8' });
  assert.deepEqual(s.get('a').effective, { backend: 'elevenlabs', elevenlabs_model: 'eleven_flash_v2_5', elevenlabs_voice: 'SAz9YHcvj6GT2YYXdXww', supertonic_voice: 'supertonic-F2', vad_silence_s: 0.8, ...DEFAULTS });
  assert.deepEqual(new Set(Object.entries(s.get('a').from).filter(([k]) => !(k in DEFAULTS)).map(([, v]) => v)), new Set(['env']));
  const r = s.set('a', { backend: 'supertonic', elevenlabs_model: 'eleven_v4_turbo', vad_silence_s: 0.3, supertonic_voice: 'supertonic-M1' });
  assert.deepEqual(r.settings, { backend: 'supertonic', elevenlabs_model: 'eleven_v4_turbo', vad_silence_s: 0.3, supertonic_voice: 'supertonic-M1' });
  assert.deepEqual(r.effective, { backend: 'supertonic', elevenlabs_model: 'eleven_v4_turbo', elevenlabs_voice: 'SAz9YHcvj6GT2YYXdXww', supertonic_voice: 'supertonic-M1', vad_silence_s: 0.3, ...DEFAULTS });
  assert.equal(r.from.backend, 'tenant');
  assert.equal(r.from.elevenlabs_voice, 'env');
  // Per tenant: another one still has the env values.
  assert.equal(s.get('b').effective.backend, 'elevenlabs');
  // null removes a setting; undefined leaves it.
  const r2 = s.set('a', { backend: null, vad_silence_s: undefined });
  assert.deepEqual(r2.settings, { elevenlabs_model: 'eleven_v4_turbo', vad_silence_s: 0.3, supertonic_voice: 'supertonic-M1' });
  assert.equal(r2.effective.backend, 'elevenlabs');
  // Kept across restarts (a new instance on the same directory), in a file only the service reads.
  const again = new SpeechSettings(s.cfg);
  assert.deepEqual(again.get('a').settings, r2.settings);
  assert.equal(fs.statSync(path.join(s.cfg.dataDir, 'speech-settings', 'a.json')).mode & 0o777, 0o600);
});

test('validated like the env values; all or nothing', () => {
  const s = settings(KEY);
  for (const [k, v, re] of [
    ['backend', 'openai', /backend must be one of supertonic, elevenlabs/],
    ['elevenlabs_model', 'Eleven-V4', /elevenlabs_model must be/], ['elevenlabs_model', 'ab', /elevenlabs_model must be/],
    ['elevenlabs_voice', 'short', /elevenlabs_voice must be/], ['elevenlabs_voice', '../../etc/passwd', /elevenlabs_voice must be/],
    ['supertonic_voice', 'alloy', /supertonic_voice must be one of/],
    ['vad_silence_s', 0.1, /vad_silence_s must be/], ['vad_silence_s', 3.1, /vad_silence_s must be/], ['vad_silence_s', '1', /vad_silence_s must be/],
    ['language', 'uk', /no speech setting language/],
  ]) assert.throws(() => s.set('a', { [k]: v }), re, `${k}=${v}`);
  assert.throws(() => s.set('a', { backend: 'elevenlabs', vad_silence_s: 9 }), /vad_silence_s/);
  assert.deepEqual(s.get('a').settings, {}, 'nothing was saved');
  // A file edited by hand: unknown keys and values that fail their check are ignored.
  fs.mkdirSync(path.join(s.cfg.dataDir, 'speech-settings'), { recursive: true });
  fs.writeFileSync(path.join(s.cfg.dataDir, 'speech-settings', 'a.json'), JSON.stringify({ backend: 'elevenlabs', vad_silence_s: 99, __proto__x: 1, apiKey: 'x' }));
  assert.deepEqual(s.get('a').settings, { backend: 'elevenlabs' });
  fs.writeFileSync(path.join(s.cfg.dataDir, 'speech-settings', 'a.json'), '{nope');
  assert.throws(() => s.get('a'), /speech settings cannot be read \(invalid JSON\)/);
});

test('backend elevenlabs without an ElevenLabs key: supertonic, with a warning (env or tenant setting)', () => {
  const env = settings({ TTS_DEFAULT_BACKEND: 'elevenlabs' }).get('a');
  assert.equal(env.effective.backend, 'supertonic');
  assert.match(env.warning, /backend elevenlabs \(from TTS_DEFAULT_BACKEND\) but ELEVENLABS_API_KEY is not set: meeting_speak uses supertonic/);
  const s = settings({});
  const t = s.set('a', { backend: 'elevenlabs' });
  assert.equal(t.effective.backend, 'supertonic');
  assert.match(t.warning, /from this tenant's setting/);
  assert.equal(settings(KEY).set('a', { backend: 'elevenlabs' }).warning, undefined);
});

test('channel and acknowledgement settings: validated, set and removed per tenant', () => {
  const s = settings(KEY);
  const r = s.set('a', { meeting_channel: false, transcript_events: 'never', agent_partials: true, agent_partials_interval_s: 2, channel_prepare_chunks: true,
    ack_on_final: true, ack_phrases: ['Мгм.', 'Секунду.'], ack_lang: 'uk', ack_delay_ms: 0, ack_min_words: 2, ack_cooldown_s: 0 });
  assert.deepEqual(r.effective.ack_phrases, ['Мгм.', 'Секунду.']);
  assert.equal(r.effective.transcript_events, 'never');
  assert.equal(r.from.ack_on_final, 'tenant');
  assert.equal(s.set('a', { ack_phrases: null }).effective.ack_phrases.length, 4);
  for (const [k, v, re] of [
    ['meeting_channel', 'yes', /meeting_channel must be true or false/], ['transcript_events', 'sometimes', /transcript_events must be one of auto, always, never/],
    ['agent_partials_interval_s', 0.1, /agent_partials_interval_s/], ['channel_prepare_chunks', 'chunks', /channel_prepare_chunks must be true or false/],
    ['ack_phrases', [], /ack_phrases must be 1 to 12/], ['ack_phrases', ['x'.repeat(41)], /ack_phrases/], ['ack_phrases', [' '], /ack_phrases/], ['ack_phrases', 'Mhm.', /ack_phrases/],
    ['ack_lang', 'ukrainian', /ack_lang/], ['ack_delay_ms', 2001, /ack_delay_ms/], ['ack_delay_ms', 1.5, /ack_delay_ms/], ['ack_min_words', 0, /ack_min_words/], ['ack_cooldown_s', -1, /ack_cooldown_s/],
    ['turn_hold_ms', 5001, /turn_hold_ms/], ['turn_hold_ms', 0.5, /turn_hold_ms/], ['turn_hold_complete_ms', -1, /turn_hold_complete_ms/],
    ['barge_in', 'yes', /barge_in/], ['barge_in_min_words', 0, /barge_in_min_words/], ['barge_in_min_s', 0.1, /barge_in_min_s/],
  ]) assert.throws(() => s.set('a', { [k]: v }), re, `${k}=${JSON.stringify(v)}`);
});
