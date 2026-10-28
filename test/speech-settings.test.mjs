// Speech settings per tenant (src/meetings/settings.mjs): validation like the env values, persisted per tenant,
// precedence tenant setting > env > built-in default (a call's own value wins over all of them: meeting-live tests),
// elevenlabs without a key falls back to supertonic with a warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.mjs';
import { SpeechSettings } from '../src/meetings/settings.mjs';
import { tmpDir } from './helpers.mjs';

const KEY = { ELEVENLABS_API_KEY: 'el-key-0123456789' };
const settings = (env) => { const dataDir = tmpDir('speech-'); return new SpeechSettings({ ...loadConfig(env), dataDir }); };

test('defaults without env or settings; env fallbacks; the tenant\'s settings over them', () => {
  const none = settings(KEY).get('a');
  assert.deepEqual(none, {
    settings: {},
    effective: { backend: 'supertonic', elevenlabs_model: 'eleven_v4_turbo', elevenlabs_voice: 'EXAVITQu4vr4xnSDxMaL', supertonic_voice: null, vad_silence_s: 0.5 },
    from: { backend: 'default', elevenlabs_model: 'default', elevenlabs_voice: 'default', supertonic_voice: 'default', vad_silence_s: 'default' },
  });
  const s = settings({ ...KEY, TTS_DEFAULT_BACKEND: 'elevenlabs', ELEVENLABS_TTS_MODEL: 'eleven_flash_v2_5', ELEVENLABS_VOICE: 'SAz9YHcvj6GT2YYXdXww', TTS_VOICE: 'supertonic-F2', LIVE_TRANSCRIPT_VAD_SILENCE_S: '0.8' });
  assert.deepEqual(s.get('a').effective, { backend: 'elevenlabs', elevenlabs_model: 'eleven_flash_v2_5', elevenlabs_voice: 'SAz9YHcvj6GT2YYXdXww', supertonic_voice: 'supertonic-F2', vad_silence_s: 0.8 });
  assert.deepEqual(new Set(Object.values(s.get('a').from)), new Set(['env']));
  const r = s.set('a', { backend: 'supertonic', elevenlabs_model: 'eleven_v4_turbo', vad_silence_s: 0.3, supertonic_voice: 'supertonic-M1' });
  assert.deepEqual(r.settings, { backend: 'supertonic', elevenlabs_model: 'eleven_v4_turbo', vad_silence_s: 0.3, supertonic_voice: 'supertonic-M1' });
  assert.deepEqual(r.effective, { backend: 'supertonic', elevenlabs_model: 'eleven_v4_turbo', elevenlabs_voice: 'SAz9YHcvj6GT2YYXdXww', supertonic_voice: 'supertonic-M1', vad_silence_s: 0.3 });
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
