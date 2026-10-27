// Speech for a meeting: text to an audio file (TTS backends), and the length of an audio file. What is played goes into
// the meeting's microphone (audio.mjs play); when to speak is the agent's call, never Bosun's.
//
// Backends:
//   supertonic  (default) a local OpenAI-style TTS service: POST <TTS_URL>/v1/audio/speech {input, voice, lang,
//               response_format: wav}; voices supertonic-F1..F5, supertonic-M1..M5.
//   elevenlabs  POST https://api.elevenlabs.io/v1/text-to-speech/<voice_id>?output_format=wav_24000&enable_logging=false
//               {text, model_id: eleven_flash_v2_5, language_code}; voice = an ElevenLabs voice id.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';

export const BACKENDS = ['supertonic', 'elevenlabs'];
export const SUPERTONIC_VOICES = [...'FM'].flatMap((g) => [1, 2, 3, 4, 5].map((i) => `supertonic-${g}${i}`));
export const EL_TTS_MODEL = 'eleven_flash_v2_5';
export const EL_DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL'; // "Sarah", one of ElevenLabs' premade voices
const TTS_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

// A temporary directory of its own (0700) for one utterance; removed with remove().
export function tempAudio(ext = 'wav') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-speak-'));
  fs.chmodSync(dir, 0o700);
  return { dir, file: path.join(dir, `speech.${ext}`), remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function fetchAudio(url, init, what) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TTS_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal, redirect: 'error' });
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`${what} answered HTTP ${r.status}${body ? `: ${body}` : ''}`);
    }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_AUDIO_BYTES) throw new Error(`${what} sent ${len} bytes of audio (more than ${MAX_AUDIO_BYTES})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_AUDIO_BYTES) throw new Error(`${what} sent more than ${MAX_AUDIO_BYTES} bytes of audio`);
    return buf;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${what} took longer than ${TTS_TIMEOUT_MS / 1000} s`);
    if (/^(?:supertonic|ElevenLabs)/.test(e.message)) throw e;
    throw new Error(`${what} could not be reached: ${e.cause?.code || e.cause?.message || e.message}`);
  } finally { clearTimeout(t); }
}

// text -> a WAV file. Returns {file, remove(), bytes, backend, voice}.
export async function synthesize(cfg, { text, backend = 'supertonic', voice, lang }) {
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
    voice ??= cfg.elevenlabs.voice || EL_DEFAULT_VOICE;
    if (!/^[A-Za-z0-9]{10,40}$/.test(voice)) throw new Error('voice must be an ElevenLabs voice id for backend elevenlabs');
    const u = new URL(`/v1/text-to-speech/${voice}`, cfg.elevenlabs.baseUrl);
    u.searchParams.set('output_format', 'wav_24000');
    u.searchParams.set('enable_logging', 'false');
    buf = await fetchAudio(u.href, {
      method: 'POST', headers: { 'content-type': 'application/json', 'xi-api-key': cfg.elevenlabs.apiKey },
      body: JSON.stringify({ text, model_id: EL_TTS_MODEL, ...(lang ? { language_code: lang } : {}) }),
    }, 'ElevenLabs text-to-speech');
  } else throw new Error(`backend must be one of ${BACKENDS.join(', ')}`);
  if (wavSeconds(buf) === null) throw new Error(`${backend} did not send WAV audio`);
  const t = tempAudio('wav');
  fs.writeFileSync(t.file, buf, { mode: 0o600 });
  return { ...t, bytes: buf.length, backend, ...(voice ? { voice } : {}), seconds: wavSeconds(buf) };
}

// The length of a WAV file from its header (RIFF chunks 'fmt ' and 'data'); null if it is no WAV. A streamed WAV
// whose data size is unknown (0 or 0xFFFFFFFF) is measured by the bytes there are.
export function wavSeconds(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 16 <= buf.length) byteRate = buf.readUInt32LE(p + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const have = buf.length - (p + 8);
      return (size && size !== 0xffffffff ? Math.min(size, have) : have) / byteRate;
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

// The length of any audio file ffprobe reads, in seconds (null if it can't tell).
export function probeSeconds(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { timeout: 10_000 }, (e, out) => {
      const n = Number(String(out).trim());
      resolve(!e && Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}
