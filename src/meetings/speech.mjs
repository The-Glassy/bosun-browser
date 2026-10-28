// Speech for a meeting: text to audio (TTS backends), a piece at a time, and the length of an audio file. What is played
// goes into the meeting's microphone (audio.mjs play); when to speak is the agent's call, never Bosun's. Text is split
// into sentences (splitSpeech) so the first one plays while the next are synthesized: a local TTS on a busy CPU takes
// about as long as the audio lasts, and a long first sentence would keep the meeting waiting.
//
// Backends:
//   supertonic  (default) a local OpenAI-style TTS service: POST <TTS_URL>/v1/audio/speech {input, voice, lang,
//               response_format: wav}; voices supertonic-F1..F5, supertonic-M1..M5.
//   elevenlabs  POST https://api.elevenlabs.io/v1/text-to-speech/<voice_id>?output_format=wav_24000&enable_logging=false
//               {text, model_id: ELEVENLABS_TTS_MODEL (eleven_v4_turbo), language_code}; voice = an ElevenLabs voice id.
import fs from 'fs';
import { execFile } from 'child_process';
import { nodeDebugOn, NODE_DEBUG_REFUSED } from './transcript.mjs';

export const BACKENDS = ['supertonic', 'elevenlabs'];
export const SUPERTONIC_VOICES = [...'FM'].flatMap((g) => [1, 2, 3, 4, 5].map((i) => `supertonic-${g}${i}`));
export const EL_DEFAULT_TTS_MODEL = 'eleven_v4_turbo'; // ELEVENLABS_TTS_MODEL
export const EL_DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // "Sarah", one of ElevenLabs' premade voices
const TTS_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const FIRST_MAX = 80; // a longer first sentence is cut at its first comma (after FIRST_MIN characters)
const FIRST_MIN = 12;
const REST_MAX = 160;

// Text -> the pieces it is synthesized in: sentences (after . ! ? … and line breaks), the first one also cut at a comma
// or semicolon when it is long, so the first audio comes soon.
export function splitSpeech(text) {
  const parts = String(text).replace(/\s+\n|\n\s*/g, '\n').split(/(?<=[.!?…])\s+|\n+/).map((t) => t.trim()).filter(Boolean);
  if (parts[0]?.length > FIRST_MAX) {
    const m = /^(.{12,}?[,;:])\s+(.+)$/su.exec(parts[0]);
    if (m && m[1].length >= FIRST_MIN) parts.splice(0, 1, m[1], m[2]);
  }
  if (!parts.length) return [String(text).trim()];
  // After the first piece, sentences go together up to REST_MAX characters (fewer requests, steadier voice).
  const out = [parts[0]];
  for (const t of parts.slice(1)) {
    if (out.length > 1 && out.at(-1).length + 1 + t.length <= REST_MAX) out[out.length - 1] += ` ${t}`;
    else out.push(t);
  }
  return out;
}

// A response body, read up to max bytes: more is cut off (cut: true) and the rest of the body is not read.
async function readUpTo(r, max) {
  const parts = [];
  let n = 0;
  const reader = r.body?.getReader();
  if (!reader) return { buf: Buffer.alloc(0), cut: false };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { buf: Buffer.concat(parts), cut: false };
    if (n + value.length > max) {
      parts.push(Buffer.from(value.subarray(0, max - n)));
      await reader.cancel().catch(() => {});
      return { buf: Buffer.concat(parts), cut: true };
    }
    parts.push(Buffer.from(value));
    n += value.length;
  }
}

async function fetchAudio(url, init, what) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TTS_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal, redirect: 'error' });
    if (!r.ok) {
      const { buf } = await readUpTo(r, 2000).catch(() => ({ buf: Buffer.alloc(0) }));
      const body = buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`${what} answered HTTP ${r.status}${body ? `: ${body}` : ''}`);
    }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_AUDIO_BYTES) { await r.body?.cancel().catch(() => {}); throw new Error(`${what} sent ${len} bytes of audio (more than ${MAX_AUDIO_BYTES})`); }
    const { buf, cut } = await readUpTo(r, MAX_AUDIO_BYTES);
    if (cut) throw new Error(`${what} sent more than ${MAX_AUDIO_BYTES} bytes of audio`);
    return buf;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${what} took longer than ${TTS_TIMEOUT_MS / 1000} s`);
    if (/^(?:supertonic|ElevenLabs)/.test(e.message)) throw e;
    throw new Error(`${what} could not be reached: ${e.cause?.code || e.cause?.message || e.message}`);
  } finally { clearTimeout(t); }
}

// One piece of text -> WAV audio. Returns {pcm: {rate, channels}, data (s16le samples), seconds, voice}.
export async function synthesizeWav(cfg, { text, backend = 'supertonic', voice, lang }) {
  let buf;
  if (backend === 'supertonic') {
    if (!cfg.ttsUrl) throw new Error('no TTS service configured (TTS_URL): pass audio_file_id, or backend "elevenlabs"');
    voice ??= cfg.ttsVoice || undefined;
    if (voice && !SUPERTONIC_VOICES.includes(voice)) throw new Error(`voice must be one of ${SUPERTONIC_VOICES.join(', ')} for supertonic`);
    buf = await fetchAudio(`${cfg.ttsUrl}/v1/audio/speech`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: text, ...(voice ? { voice } : {}), ...(lang ? { lang } : {}), response_format: 'wav' }),
    }, 'supertonic');
  } else if (backend === 'elevenlabs') {
    if (!cfg.elevenlabs?.apiKey) throw new Error('no ElevenLabs key configured (ELEVENLABS_API_KEY)');
    if (nodeDebugOn()) throw new Error(NODE_DEBUG_REFUSED);
    voice ??= cfg.elevenlabs.voice || EL_DEFAULT_VOICE;
    if (!/^[A-Za-z0-9]{10,40}$/.test(voice)) throw new Error('voice must be an ElevenLabs voice id for backend elevenlabs');
    const u = new URL(`/v1/text-to-speech/${voice}`, cfg.elevenlabs.baseUrl);
    u.searchParams.set('output_format', 'wav_24000');
    u.searchParams.set('enable_logging', 'false');
    buf = await fetchAudio(u.href, {
      method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': cfg.elevenlabs.apiKey },
      body: JSON.stringify({ text, model_id: cfg.elevenlabs.ttsModel || EL_DEFAULT_TTS_MODEL, ...(lang ? { language_code: lang } : {}) }),
    }, 'ElevenLabs text-to-speech');
  } else throw new Error(`backend must be one of ${BACKENDS.join(', ')}`);
  const w = parseWav(buf);
  if (!w || w.bits !== 16 || w.format !== 1) throw new Error(`${backend} did not send 16-bit PCM WAV audio`);
  return { pcm: { rate: w.rate, channels: w.channels }, data: w.data, seconds: w.seconds, ...(voice ? { voice } : {}) };
}

// A WAV file's format and samples (RIFF chunks 'fmt ' and 'data'); null if it is no WAV. A streamed WAV whose data size
// is unknown (0 or 0xFFFFFFFF) has the bytes there are.
export function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 24 <= buf.length) {
      fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), byteRate: buf.readUInt32LE(p + 16), bits: buf.readUInt16LE(p + 22) };
    }
    if (id === 'data') {
      if (!fmt?.byteRate) return null;
      const have = buf.length - (p + 8);
      const n = size && size !== 0xffffffff ? Math.min(size, have) : have;
      const data = buf.subarray(p + 8, p + 8 + n - (n % Math.max(1, fmt.channels * (fmt.bits / 8))));
      return { ...fmt, data, seconds: data.length / fmt.byteRate };
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

export const wavSeconds = (buf) => parseWav(buf)?.seconds ?? null;

// An uploaded file's container, from its first bytes, as the ffmpeg demuxer that reads it: only formats that hold
// their audio themselves (a playlist or a concat list could make ffmpeg read other files: another tenant's recording).
// null: not one of them.
export function audioFormat(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try { head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  } catch { return null; }
  const a = (from, to) => head.toString('latin1', from, to);
  if (a(0, 4) === 'RIFF' && a(8, 12) === 'WAVE') return 'wav';
  if (a(0, 4) === 'OggS') return 'ogg';
  if (a(0, 4) === 'fLaC') return 'flac';
  if (a(4, 8) === 'ftyp') return 'mov'; // m4a / mp4 (external data references are off by default)
  if (head.readUInt32BE(0) === 0x1a45dfa3) return 'matroska'; // webm / mka
  if (a(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe6) === 0xe2)) return 'mp3';
  return null;
}

// The length of an audio file in a format from audioFormat, in seconds (null if it can't tell). The demuxer is fixed,
// so nothing in the file chooses another one.
export function probeSeconds(file, format) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-f', format, '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 10_000 }, (e, out) => {
      const n = Number(String(out).trim());
      resolve(!e && Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}
