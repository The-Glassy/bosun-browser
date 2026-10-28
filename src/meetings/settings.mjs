// Speech settings per tenant (speech_settings_get / speech_settings_set): the backend meeting_speak uses, the ElevenLabs
// model and voice, the Supertonic voice, and the pause that ends a live transcript segment; how a meeting talks with
// the agent over its MCPL channel (meeting_channel, transcript_events, agent_partials, channel_prepare_chunks); the
// acknowledgement played when someone finishes (ack_*); how long a final is held for more of the same turn (turn_hold_*)
// and whether someone speaking over Bosun stops it (barge_in*). What a call passes wins, then the tenant's setting, then the
// environment (TTS_DEFAULT_BACKEND, ELEVENLABS_TTS_MODEL, ELEVENLABS_VOICE, TTS_VOICE, LIVE_TRANSCRIPT_VAD_SILENCE_S),
// then Bosun's own default.
// Stored under <BROWSER_DATA>/speech-settings/<tenant>.json (written atomically, 0600).
import fs from 'fs';
import path from 'path';
import { BACKENDS, SUPERTONIC_VOICES, EL_DEFAULT_TTS_MODEL, EL_DEFAULT_VOICE } from './speech.mjs';

export const EL_MODEL_RE = /^[a-z0-9_]{3,60}$/;
export const EL_VOICE_RE = /^[A-Za-z0-9]{10,40}$/;
export const VAD_MIN_S = 0.2;
export const VAD_MAX_S = 3;
export const VAD_DEFAULT_S = 0.5;
export const TRANSCRIPT_EVENTS = ['auto', 'always', 'never'];
export const ACK_PHRASES_DEFAULT = ['Mhm.', 'One sec.', 'Okay.', 'Right.'];
const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/;
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

// Each setting: its check (returns an error or null).
export const SETTINGS = {
  backend: (v) => (BACKENDS.includes(v) ? null : `backend must be one of ${BACKENDS.join(', ')}`),
  elevenlabs_model: (v) => (typeof v === 'string' && EL_MODEL_RE.test(v) ? null : 'elevenlabs_model must be an ElevenLabs model id such as eleven_v4_turbo ([a-z0-9_], 3-60 characters)'),
  elevenlabs_voice: (v) => (typeof v === 'string' && EL_VOICE_RE.test(v) ? null : 'elevenlabs_voice must be an ElevenLabs voice id ([A-Za-z0-9], 10-40 characters)'),
  supertonic_voice: (v) => (SUPERTONIC_VOICES.includes(v) ? null : `supertonic_voice must be one of ${SUPERTONIC_VOICES.join(', ')}`),
  vad_silence_s: (v) => (typeof v === 'number' && v >= VAD_MIN_S && v <= VAD_MAX_S ? null : `vad_silence_s must be a number of seconds from ${VAD_MIN_S} to ${VAD_MAX_S}`),
  // A channel per meeting (bosun:meeting:<id>) on connections whose host grants MCPL channels.
  meeting_channel: (v) => (typeof v === 'boolean' ? null : 'meeting_channel must be true or false'),
  // The bosun:meeting-transcript push events: auto (only when no channel took the text), always, never.
  transcript_events: (v) => (TRANSCRIPT_EVENTS.includes(v) ? null : `transcript_events must be one of ${TRANSCRIPT_EVENTS.join(', ')}`),
  // Partial transcript text to the agent over the channel, at most every agent_partials_interval_s.
  agent_partials: (v) => (typeof v === 'boolean' ? null : 'agent_partials must be true or false'),
  agent_partials_interval_s: (v) => (num(v, 0.5, 10) ? null : 'agent_partials_interval_s must be a number of seconds from 0.5 to 10'),
  // Sentences of channels/outgoing/chunk synthesized ahead, so the publish that delivers them plays at once (only
  // channels/publish is ever spoken: MCPL §14.5).
  channel_prepare_chunks: (v) => (typeof v === 'boolean' ? null : 'channel_prepare_chunks must be true or false'),
  // A short cached clip when a final ends someone's turn, unless the agent speaks first.
  ack_on_final: (v) => (typeof v === 'boolean' ? null : 'ack_on_final must be true or false'),
  ack_phrases: (v) => (Array.isArray(v) && v.length >= 1 && v.length <= 12 && v.every((p) => typeof p === 'string' && p.trim().length >= 1 && p.length <= 40)
    ? null : 'ack_phrases must be 1 to 12 texts of at most 40 characters'),
  ack_lang: (v) => (typeof v === 'string' && LANG_RE.test(v) ? null : 'ack_lang must be a language code such as en, uk, de'),
  ack_delay_ms: (v) => (Number.isInteger(v) && v >= 0 && v <= 2000 ? null : 'ack_delay_ms must be a whole number of milliseconds from 0 to 2000'),
  ack_min_words: (v) => (Number.isInteger(v) && v >= 1 && v <= 50 ? null : 'ack_min_words must be a whole number from 1 to 50'),
  ack_cooldown_s: (v) => (num(v, 0, 300) ? null : 'ack_cooldown_s must be a number of seconds from 0 to 300'),
  // A final is held this long for more speech before it goes to the agent (0: at once); what comes meanwhile is merged
  // into one turn. A final that clearly ends a sentence (a question, or a full sentence) is held turn_hold_complete_ms.
  turn_hold_ms: (v) => (Number.isInteger(v) && v >= 0 && v <= 5000 ? null : 'turn_hold_ms must be a whole number of milliseconds from 0 to 5000'),
  turn_hold_complete_ms: (v) => (Number.isInteger(v) && v >= 0 && v <= 5000 ? null : 'turn_hold_complete_ms must be a whole number of milliseconds from 0 to 5000'),
  // Someone else speaking while Bosun speaks (at least barge_in_min_words new words, or a word and barge_in_min_s
  // shown speaking on the page) stops it, as meeting_stop_speaking would.
  barge_in: (v) => (typeof v === 'boolean' ? null : 'barge_in must be true or false'),
  barge_in_min_words: (v) => (Number.isInteger(v) && v >= 1 && v <= 20 ? null : 'barge_in_min_words must be a whole number from 1 to 20'),
  barge_in_min_s: (v) => (num(v, 0.2, 5) ? null : 'barge_in_min_s must be a number of seconds from 0.2 to 5'),
};
// Bosun's defaults for the settings without an environment fallback.
export const DEFAULTS = {
  meeting_channel: true, transcript_events: 'auto', agent_partials: false, agent_partials_interval_s: 1.5, channel_prepare_chunks: false,
  ack_on_final: false, ack_phrases: ACK_PHRASES_DEFAULT, ack_lang: null, ack_delay_ms: 100, ack_min_words: 3, ack_cooldown_s: 8,
  turn_hold_ms: 900, turn_hold_complete_ms: 300, barge_in: true, barge_in_min_words: 2, barge_in_min_s: 0.6,
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
  // vad_silence_s, and the channel and ack settings}, and where each comes from (tenant, env, default). backend
  // elevenlabs without a key: supertonic, with a warning.
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
      ...Object.fromEntries(Object.entries(DEFAULTS).map(([k, def]) => [k, pick(k, null, def)])),
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
