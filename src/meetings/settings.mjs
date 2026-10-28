// Speech settings per tenant (speech_settings_get / speech_settings_set): the backend meeting_speak uses, the ElevenLabs
// model and voice, the Supertonic voice, and the pause that ends a live transcript segment. What a call passes wins,
// then the tenant's setting, then the environment (TTS_DEFAULT_BACKEND, ELEVENLABS_TTS_MODEL, ELEVENLABS_VOICE,
// TTS_VOICE, LIVE_TRANSCRIPT_VAD_SILENCE_S), then Bosun's own default.
// Stored under <BROWSER_DATA>/speech-settings/<tenant>.json (written atomically, 0600).
import fs from 'fs';
import path from 'path';
import { BACKENDS, SUPERTONIC_VOICES, EL_DEFAULT_TTS_MODEL, EL_DEFAULT_VOICE } from './speech.mjs';

export const EL_MODEL_RE = /^[a-z0-9_]{3,60}$/;
export const EL_VOICE_RE = /^[A-Za-z0-9]{10,40}$/;
export const VAD_MIN_S = 0.2;
export const VAD_MAX_S = 3;
export const VAD_DEFAULT_S = 0.5;

// Each setting: its check (returns an error or null).
export const SETTINGS = {
  backend: (v) => (BACKENDS.includes(v) ? null : `backend must be one of ${BACKENDS.join(', ')}`),
  elevenlabs_model: (v) => (typeof v === 'string' && EL_MODEL_RE.test(v) ? null : 'elevenlabs_model must be an ElevenLabs model id such as eleven_v4_turbo ([a-z0-9_], 3-60 characters)'),
  elevenlabs_voice: (v) => (typeof v === 'string' && EL_VOICE_RE.test(v) ? null : 'elevenlabs_voice must be an ElevenLabs voice id ([A-Za-z0-9], 10-40 characters)'),
  supertonic_voice: (v) => (SUPERTONIC_VOICES.includes(v) ? null : `supertonic_voice must be one of ${SUPERTONIC_VOICES.join(', ')}`),
  vad_silence_s: (v) => (typeof v === 'number' && v >= VAD_MIN_S && v <= VAD_MAX_S ? null : `vad_silence_s must be a number of seconds from ${VAD_MIN_S} to ${VAD_MAX_S}`),
};

export class SpeechSettings {
  constructor(cfg) {
    this.cfg = cfg;
    this.dir = path.join(cfg.dataDir, 'speech-settings');
  }

  file(tenant) { return path.join(this.dir, `${tenant}.json`); }

  // What the tenant set (only known settings that still pass their check: a file edited by hand can't inject others).
  stored(tenant) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(this.file(tenant), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw new Error(`the speech settings cannot be read (${e.code || 'invalid JSON'})`);
    }
    const out = {};
    for (const [k, check] of Object.entries(SETTINGS)) if (doc && Object.hasOwn(doc, k) && !check(doc[k])) out[k] = doc[k];
    return out;
  }

  // Changes the given settings; null removes one (back to the environment's or Bosun's default). All or nothing.
  set(tenant, patch) {
    const next = this.stored(tenant);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (!Object.hasOwn(SETTINGS, k)) throw new Error(`no speech setting ${k}`);
      if (v === null) { delete next[k]; continue; }
      const err = SETTINGS[k](v);
      if (err) throw new Error(err);
      next[k] = v;
    }
    const f = this.file(tenant);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`cannot save the speech settings: ${e.code || e.message}`);
    }
    return this.get(tenant);
  }

  // What a call without its own values gets: {backend, elevenlabs_model, elevenlabs_voice, supertonic_voice,
  // vad_silence_s}, and where each comes from (tenant, env, default). backend elevenlabs without a key: supertonic,
  // with a warning.
  effective(tenant) {
    const s = this.stored(tenant);
    const cfg = this.cfg;
    const pick = (k, env, def) => (s[k] !== undefined ? [s[k], 'tenant'] : env != null ? [env, 'env'] : [def, 'default']);
    const out = {}, from = {};
    for (const [k, [v, f]] of Object.entries({
      backend: pick('backend', cfg.ttsDefaultBackendEnv ?? null, 'supertonic'),
      elevenlabs_model: pick('elevenlabs_model', cfg.elevenlabsTtsModelEnv ?? null, EL_DEFAULT_TTS_MODEL),
      elevenlabs_voice: pick('elevenlabs_voice', cfg.elevenlabs?.voice ?? null, EL_DEFAULT_VOICE),
      supertonic_voice: pick('supertonic_voice', cfg.ttsVoice ?? null, null),
      vad_silence_s: pick('vad_silence_s', cfg.vadSilenceEnv ?? null, VAD_DEFAULT_S),
    })) { out[k] = v; from[k] = f; }
    let warning = null;
    if (out.backend === 'elevenlabs' && !cfg.elevenlabs) {
      warning = `backend elevenlabs (from ${from.backend === 'tenant' ? 'this tenant\'s setting' : 'TTS_DEFAULT_BACKEND'}) but ELEVENLABS_API_KEY is not set: meeting_speak uses supertonic`;
      out.backend = 'supertonic';
    }
    return { values: out, from, warning };
  }

  get(tenant) {
    const e = this.effective(tenant);
    return { settings: this.stored(tenant), effective: e.values, from: e.from, ...(e.warning ? { warning: e.warning } : {}) };
  }
}
