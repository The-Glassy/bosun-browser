// Live transcript of a meeting: the meeting's audio (audio.mjs capture: raw PCM, 16 kHz mono) streamed to ElevenLabs
// Scribe v2 Realtime over its WebSocket API, the partial and final texts handed back as they come.
//
//   wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000
//     &commit_strategy=vad&include_timestamps=true&include_language_detection=true&enable_logging=false
//   header xi-api-key; client -> {message_type: input_audio_chunk, audio_base_64, commit: false, sample_rate}
//   server -> session_started, partial_transcript, committed_transcript, committed_transcript_with_timestamps
//     (words with start/end seconds, language_code), warning, and error types (auth_error, quota_exceeded, ...)
//
// No language is set: Scribe detects it per segment (a uk/ru/en/de/sk mix is normal). Zero retention
// (enable_logging=false) is always asked for; ElevenLabs applies it only on enterprise and trial plans and says so
// in a warning otherwise: status() reports whether it applied. The connection is opened again when it drops (audio
// meanwhile is kept, up to BUFFER_SEC, and sent once it is back; the last words go along as previous_text).
//
// Times (start_s, end_s) are seconds of meeting audio since the transcript started. A segment's partials carry the
// seq its final will have; a final replaces them.
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { PCM_RATE } from './audio.mjs';

export const EL_MODEL = 'scribe_v2_realtime';
export const EL_PATH = '/v1/speech-to-text/realtime';
const BYTES_PER_SEC = PCM_RATE * 2;
const CHUNK_BYTES = BYTES_PER_SEC / 4; // 250 ms per message (ElevenLabs: 0.1 - 1 s)
const BUFFER_SEC = 20; // audio kept while the connection is down
const PARTIAL_MS = 500; // at most two partials a second
const VAD_SILENCE_SEC = 1.0; // a pause this long ends a segment (ElevenLabs' default 1.5)
const FINAL_WAIT_MS = 1500; // committed_transcript without its timestamped copy: emitted after this
const MAX_RETRIES = 8; // connection attempts in a row without a session
// Errors after which another connection would fail the same way: the transcript stops.
const FATAL = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'invalid_request', 'input_error', 'chunk_size_exceeded']);
const PREVIOUS_TEXT = 50; // characters of context sent with the first chunk after a reconnect

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The realtime URL for a base URL (https://api.elevenlabs.io, or a test server).
export function realtimeUrl(base, { zeroRetention = true } = {}) {
  const u = new URL(EL_PATH, base);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  const q = { model_id: EL_MODEL, audio_format: `pcm_${PCM_RATE}`, commit_strategy: 'vad', vad_silence_threshold_secs: String(VAD_SILENCE_SEC), include_timestamps: 'true', include_language_detection: 'true' };
  if (zeroRetention) q.enable_logging = 'false';
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.href;
}

// Seconds of live transcript per tenant and local day (tz), kept in a file so a restart doesn't reset the cap.
export class TranscriptUsage {
  constructor({ file, tz, capMin, now = Date.now }) {
    Object.assign(this, { file, tz, capSec: capMin * 60, now });
    this.state = { day: this.day(), tenants: {} };
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s && typeof s.day === 'string' && s.tenants && typeof s.tenants === 'object') this.state = s;
    } catch {}
    this.dirty = false;
  }

  day() { return new Intl.DateTimeFormat('en-CA', { timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now()); }

  roll() {
    const d = this.day();
    if (this.state.day !== d) { this.state = { day: d, tenants: {} }; this.dirty = true; }
  }

  used(tenant) { this.roll(); return Number(this.state.tenants[tenant]) || 0; }
  left(tenant) { return Math.max(0, this.capSec - this.used(tenant)); }

  add(tenant, sec) {
    this.roll();
    this.state.tenants[tenant] = this.used(tenant) + sec;
    this.dirty = true;
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error(`bosun: live transcript usage not saved (${e.code || e.message})`); }
  }
}

// One meeting's live transcript. source: {stream (PCM s16le 16 kHz mono), stop(), exited}; on: {partial(seg),
// final(seg), stopped({reason, error})}. Stops by itself at the tenant's daily cap (reason daily-cap), on an error
// that a new connection would not fix (reason error), or when the audio ends (reason audio-ended).
export class LiveTranscript {
  constructor({ apiKey, baseUrl, source, tenant, usage, on, partials = true, now = Date.now, retryMs = 1000 }) {
    Object.assign(this, { apiKey, baseUrl, source, tenant, usage, on, partials, now, retryMs });
    this.url = realtimeUrl(baseUrl);
    this.state = 'connecting'; // connecting | live | reconnecting | stopped
    this.reason = null; this.error = null;
    this.startedAt = now();
    this.pos = 0; // seconds of audio taken from the source (the transcript's clock)
    this.sentAt = []; // [audio seconds, wall ms] per chunk sent, for the lag of finals
    this.buffer = []; // chunks not sent yet: {buf, at (audio seconds at its start)}
    this.pending = Buffer.alloc(0);
    this.seq = 0; // the open segment's number (its partials and its final)
    this.segStart = 0; // where the open segment starts (the last final's end)
    this.finals = [];
    this.lastPartial = { text: '', at: 0, timer: null, queued: null };
    this.committed = null; // committed_transcript waiting for its timestamped copy
    this.ws = null; this.session = null; this.sessionBase = 0; this.sessions = 0; this.failures = 0;
    this.zeroRetention = null; this.warnings = [];
    this.streamedSec = 0;
    this.lags = [];
  }

  start() {
    if (this.usage.left(this.tenant) <= 0) { this.stop('daily-cap'); return this; }
    this.source.stream.on('data', (d) => this.onAudio(d));
    this.source.stream.on('error', () => {});
    this.source.exited?.then(() => { if (this.state !== 'stopped') this.stop('audio-ended', this.source.error?.() || null); });
    this.saver = setInterval(() => this.usage.save(), 15_000);
    this.saver.unref?.();
    this.connect();
    return this;
  }

  onAudio(d) {
    if (this.state === 'stopped') return;
    this.pending = Buffer.concat([this.pending, d]);
    while (this.pending.length >= CHUNK_BYTES) {
      const buf = this.pending.subarray(0, CHUNK_BYTES);
      this.pending = this.pending.subarray(CHUNK_BYTES);
      this.buffer.push({ buf, at: this.pos });
      this.pos += CHUNK_BYTES / BYTES_PER_SEC;
    }
    // Down for longer than BUFFER_SEC: the oldest audio goes (that stretch gets no transcript).
    while (this.buffer.length > (BUFFER_SEC * BYTES_PER_SEC) / CHUNK_BYTES) this.buffer.shift();
    this.flush();
  }

  flush() {
    if (this.state !== 'live' || this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.buffer.length && this.state === 'live') {
      const { buf, at } = this.buffer.shift();
      const first = !this.sessionSent;
      if (first) { this.sessionSent = true; this.sessionBase = at; }
      const msg = { message_type: 'input_audio_chunk', audio_base_64: buf.toString('base64'), commit: false, sample_rate: PCM_RATE };
      if (first && this.sessions > 1 && this.finals.length) msg.previous_text = this.finals.at(-1).text.slice(-PREVIOUS_TEXT);
      this.ws.send(JSON.stringify(msg));
      const sec = buf.length / BYTES_PER_SEC;
      this.sentAt.push([at + sec, this.now()]);
      if (this.sentAt.length > 400) this.sentAt.splice(0, 100);
      this.streamedSec += sec;
      this.usage.add(this.tenant, sec);
      if (this.usage.left(this.tenant) <= 0) { this.stop('daily-cap'); return; }
    }
  }

  connect() {
    if (this.state === 'stopped') return;
    this.sessionSent = false;
    const ws = this.ws = new WebSocket(this.url, { headers: { 'xi-api-key': this.apiKey }, handshakeTimeout: 15_000 });
    let started = false;
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode;
      res.resume();
      this.dropped(ws, code === 401 || code === 403 ? 'auth_error' : 'error', `HTTP ${code} from ElevenLabs`);
    });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.message_type === 'session_started') {
        started = true;
        this.sessions++;
        this.failures = 0;
        this.session = m.session_id || null;
        // Zero retention applied: the session's config says logging is off, and no warning said otherwise.
        this.zeroRetention = m.config?.disable_logging === true || m.config?.enable_logging === false;
        this.state = 'live';
        this.flush();
        return;
      }
      if (ws !== this.ws) return;
      this.onMessage(m);
    });
    ws.on('close', () => this.dropped(ws, started ? null : 'error', started ? null : 'the connection closed before the session started'));
    ws.on('error', (e) => this.dropped(ws, 'error', String(e?.message || e).slice(0, 200)));
  }

  onMessage(m) {
    switch (m.message_type) {
      case 'partial_transcript': return this.partial(String(m.text || '').trim());
      case 'committed_transcript':
        clearTimeout(this.committed?.timer);
        this.committed = { text: String(m.text || '').trim(), timer: setTimeout(() => this.final({ text: this.committed?.text ?? '' }), FINAL_WAIT_MS) };
        return;
      case 'committed_transcript_with_timestamps': return this.final(m);
      case 'warning':
        if (/zero retention/i.test(m.warning || '')) this.zeroRetention = false;
        if (this.warnings.length < 5) this.warnings.push(String(m.warning || '').slice(0, 300));
        return;
      default:
        if (m.error !== undefined || /error|exceeded|limited|overflow|exhausted|terms|insufficient|throttled/.test(m.message_type || '')) {
          if (m.message_type === 'commit_throttled') return;
          this.dropped(this.ws, m.message_type, String(m.error || m.message_type).slice(0, 300));
        }
    }
  }

  // The open segment's text so far, at most every PARTIAL_MS (the newest one wins), never twice the same.
  partial(text) {
    if (!this.partials || !text || text === this.lastPartial.text) return;
    const lp = this.lastPartial;
    lp.queued = text;
    const send = () => {
      lp.timer = null;
      if (this.state === 'stopped' || lp.queued === null) return;
      const t = lp.queued; lp.queued = null;
      lp.text = t; lp.at = this.now();
      this.on.partial?.({ seq: this.seq + 1, start_s: round(this.segStart), end_s: round(this.sentPos()), text: t, final: false });
    };
    const wait = PARTIAL_MS - (this.now() - lp.at);
    if (wait <= 0 && !lp.timer) send();
    else if (!lp.timer) lp.timer = setTimeout(send, Math.max(0, wait));
  }

  sentPos() { return this.sentAt.length ? this.sentAt.at(-1)[0] : this.segStart; }

  final(m) {
    clearTimeout(this.committed?.timer);
    this.committed = null;
    const lp = this.lastPartial;
    clearTimeout(lp.timer); lp.timer = null; lp.queued = null; lp.text = '';
    const text = String(m.text || '').trim();
    const words = Array.isArray(m.words) ? m.words.filter((w) => w.type === 'word' && Number.isFinite(w.start) && Number.isFinite(w.end)) : [];
    const start = words.length ? this.sessionBase + words[0].start : this.segStart;
    const end = words.length ? this.sessionBase + words.at(-1).end : this.sentPos();
    if (!text) { this.segStart = Math.max(this.segStart, end); return; }
    const speakers = [...new Set(words.map((w) => w.speaker_id).filter(Boolean))];
    // How long after its last word was sent the final arrived.
    const sent = this.sentAt.find(([s]) => s >= end - 1e-6);
    const lag = sent ? (this.now() - sent[1]) / 1000 : null;
    if (lag !== null) { this.lags.push(lag); if (this.lags.length > 200) this.lags.shift(); }
    const seg = {
      seq: ++this.seq, start_s: round(start), end_s: round(end), text, final: true,
      ...(m.language_code ? { lang: m.language_code } : {}), ...(speakers.length === 1 ? { speaker: speakers[0] } : {}),
      at: new Date(this.now()).toISOString(), ...(lag !== null ? { lag_s: round(lag) } : {}),
    };
    this.segStart = end;
    this.finals.push(seg);
    if (this.finals.length > 5000) this.finals.shift();
    this.on.final?.(seg);
  }

  // A connection ended or failed. kind null: closed after a session (opened again); a fatal kind stops the
  // transcript; anything else is retried with a growing pause, MAX_RETRIES times in a row at most.
  dropped(ws, kind, error) {
    if (ws !== this.ws || this.state === 'stopped') return;
    this.ws = null;
    try { ws.terminate(); } catch {}
    if (this.committed) this.final({ text: this.committed.text });
    if (kind && FATAL.has(kind)) return this.stop('error', `${kind}: ${error}`);
    if (kind) { this.failures++; this.lastError = `${kind}: ${error}`; }
    if (this.failures > MAX_RETRIES) return this.stop('error', this.lastError || 'ElevenLabs kept closing the connection');
    this.state = 'reconnecting';
    const wait = Math.min(30_000, this.retryMs * 2 ** Math.max(0, this.failures - 1));
    this.retry = setTimeout(() => this.connect(), kind ? wait : 0);
  }

  // Ends the stream and the audio capture. reason: left | opted-out | stopped | daily-cap | error | audio-ended ...
  async stop(reason, error = null) {
    if (this.state === 'stopped') return this.stopping;
    this.state = 'stopped';
    this.reason = reason;
    this.error = error;
    clearTimeout(this.retry);
    clearTimeout(this.lastPartial.timer);
    clearTimeout(this.committed?.timer);
    clearInterval(this.saver);
    this.buffer = [];
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(1000); } catch {}
    setTimeout(() => { try { ws?.terminate(); } catch {} }, 2000).unref?.();
    this.usage.save();
    this.stopping = Promise.resolve(this.source.stop?.()).catch(() => {}).then(() => {
      this.on.stopped?.({ reason, ...(error ? { error } : {}) });
    });
    return this.stopping;
  }

  // Finals with seq > since.
  since(since = 0) { return this.finals.filter((f) => f.seq > since); }

  // Forgets every final (an opt-out deletes them with the recording).
  clear() { this.finals = []; }

  status() {
    const avg = this.lags.length ? this.lags.reduce((a, b) => a + b, 0) / this.lags.length : null;
    return {
      state: this.state, ...(this.reason ? { reason: this.reason } : {}), ...(this.error ? { error: this.error } : {}),
      model: EL_MODEL, zero_retention: this.zeroRetention, ...(this.warnings.length ? { warnings: this.warnings } : {}),
      segments: this.seq, streamed_min: round(this.streamedSec / 60), today_min: round(this.usage.used(this.tenant) / 60), daily_cap_min: round(this.usage.capSec / 60),
      ...(avg !== null ? { final_lag_s: { avg: round(avg), max: round(Math.max(...this.lags)) } } : {}),
      started_at: new Date(this.startedAt).toISOString(),
    };
  }
}

const round = (x) => Math.round(x * 100) / 100;

// Waits until fn() is true or ms passed (tests and shutdown).
export async function waitFor(fn, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (fn()) return true;
  return fn();
}
