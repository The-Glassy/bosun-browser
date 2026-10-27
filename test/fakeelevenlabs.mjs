// A local stand-in for ElevenLabs (Scribe v2 Realtime over its WebSocket, and text-to-speech) and for the Supertonic
// TTS service (OpenAI-style /v1/audio/speech), for tests. The realtime side behaves like the real one as far as Bosun
// relies on it: session_started (and, like a plan without zero retention, a warning when enable_logging=false), then
// per stretch of speech in the audio it receives (a simple level detector): partial_transcript while it lasts and,
// after 1 s of silence, committed_transcript and committed_transcript_with_timestamps with word times in seconds of
// that connection's audio. The texts are `phrases`, one per stretch (the last one repeats).
import http from 'http';
import { WebSocketServer } from 'ws';

// A WAV file (16-bit mono) with a tone of `seconds`.
export function toneWav(seconds, { rate = 24000, freq = 440, amp = 0.3 } = {}) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * amp * 32767), 44 + i * 2);
  return b;
}

// PCM s16le 16 kHz mono: `seconds` of a tone (someone speaking, as far as the stand-in can tell).
export const tonePcm = (seconds) => toneWav(seconds, { rate: 16000 }).subarray(44);

const LEVEL = 500; // int16 RMS above which a chunk counts as speech
const SILENCE_SEC = 1.0;

export async function startFakeElevenLabs({ key = 'el-test-key-0123456789', phrases = ['Hello Misha, this is a test.'], ttsDelayMs = 0, zeroRetention = false } = {}) {
  const st = { conns: [], tts: [], speech: [], rejectNext: null, phrases, phraseAt: 0 };
  const wss = new WebSocketServer({ noServer: true });
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const wav = (seconds) => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(toneWav(seconds)); };
    if (req.method === 'POST' && u.pathname === '/v1/audio/speech') { // Supertonic
      const b = await body(req);
      st.speech.push({ ...b, at: Date.now() });
      if (ttsDelayMs) await new Promise((r) => setTimeout(r, ttsDelayMs));
      if (b.response_format !== 'wav') { res.writeHead(400); return res.end('wav only here'); }
      return wav(Math.max(0.5, String(b.input || '').split(/\s+/).length * 0.3));
    }
    const m = /^\/v1\/text-to-speech\/([A-Za-z0-9]+)$/.exec(u.pathname);
    if (req.method === 'POST' && m) {
      if (req.headers['xi-api-key'] !== key) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"detail":{"status":"invalid_api_key"}}'); }
      const b = await body(req);
      st.tts.push({ voice: m[1], query: Object.fromEntries(u.searchParams), body: b, at: Date.now() });
      if (ttsDelayMs) await new Promise((r) => setTimeout(r, ttsDelayMs));
      return wav(Math.max(0.5, String(b.text || '').split(/\s+/).length * 0.3));
    }
    res.writeHead(404); res.end();
  });
  srv.on('upgrade', (req, sock, head) => {
    const u = new URL(req.url, 'http://x');
    const refuse = (code) => { sock.end(`HTTP/1.1 ${code} No\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); };
    if (u.pathname !== '/v1/speech-to-text/realtime') return refuse(404);
    if (req.headers['xi-api-key'] !== key) return refuse(401);
    if (st.rejectNext) { const c = st.rejectNext; st.rejectNext = null; return refuse(c); }
    wss.handleUpgrade(req, sock, head, (ws) => session(ws, u.searchParams));
  });

  function session(ws, query) {
    const c = { ws, query: Object.fromEntries(query), bytes: 0, chunks: 0, previousText: [], sampleRates: new Set(), closed: false, sent: [] };
    st.conns.push(c);
    const send = (m) => { c.sent.push(m); if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
    send({ message_type: 'session_started', session_id: `s${st.conns.length}`, config: { sample_rate: 16000, audio_format: query.get('audio_format'), model_id: query.get('model_id'), disable_logging: zeroRetention && query.get('enable_logging') === 'false' } });
    if (query.get('enable_logging') === 'false' && !zeroRetention) send({ message_type: 'warning', warning: 'Zero retention mode was requested (enable_logging=false) but was not applied. Only users from the enterprise or trial tier can use ZRM mode. This session is still being logged.' });
    let pos = 0, speaking = false, segStart = 0, lastVoice = 0, lastPartial = 0, k = 0;
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.message_type !== 'input_audio_chunk') return send({ message_type: 'input_error', error: 'unknown message' });
      const pcm = Buffer.from(m.audio_base_64 || '', 'base64');
      c.chunks++; c.bytes += pcm.length; c.sampleRates.add(m.sample_rate);
      if (m.previous_text !== undefined) {
        if (c.chunks > 1) return send({ message_type: 'invalid_request', error: 'previous_text only with the first chunk' });
        c.previousText.push(m.previous_text);
      }
      let sum = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
      const rms = Math.sqrt(sum / Math.max(1, pcm.length / 2));
      const sec = pcm.length / 32000;
      pos += sec;
      const phrase = st.phrases[Math.min(st.phraseAt, st.phrases.length - 1)];
      const words = phrase.split(' ');
      if (rms > LEVEL) {
        if (!speaking) { speaking = true; segStart = pos - sec; k = 0; lastPartial = pos; }
        lastVoice = pos;
        if (pos - lastPartial >= 0.5 && k < words.length - 1) { lastPartial = pos; k++; send({ message_type: 'partial_transcript', text: words.slice(0, k).join(' ') }); }
      } else if (speaking && pos - lastVoice >= SILENCE_SEC) {
        speaking = false;
        st.phraseAt++;
        const step = (lastVoice - segStart) / words.length;
        send({ message_type: 'committed_transcript', text: phrase });
        send({
          message_type: 'committed_transcript_with_timestamps', text: phrase, language_code: 'en',
          words: words.flatMap((w, i) => [{ text: w, start: segStart + i * step, end: segStart + (i + 0.8) * step, type: 'word', speaker_id: null }, { text: ' ', start: 0, end: 0, type: 'spacing' }]),
        });
      }
    });
    ws.on('close', () => { c.closed = true; });
  }

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return {
    base, key, st,
    get conns() { return st.conns; },
    // An error of this type to every open session, then the close ElevenLabs follows it with.
    fail(type, error = 'test') { for (const c of st.conns) if (!c.closed) { c.ws.send(JSON.stringify({ message_type: type, error })); c.ws.close(1000); } },
    // Every open session dropped without a word.
    drop() { for (const c of st.conns) if (!c.closed) c.ws.terminate(); },
    rejectNext(code) { st.rejectNext = code; },
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); srv.close(r); srv.closeAllConnections(); }),
  };
}
