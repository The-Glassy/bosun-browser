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
// Node's own diagnostics (NODE_DEBUG=net, http, fetch, ...) print request headers: the key is not sent while it is set.
export const nodeDebugOn = () => !!String(process.env.NODE_DEBUG || '').trim();
export const NODE_DEBUG_REFUSED = 'NODE_DEBUG is set (Node would log the request headers with the ElevenLabs key); the operator has to switch it off';
export const EL_PATH = '/v1/speech-to-text/realtime';
const BYTES_PER_SEC = PCM_RATE * 2;
const CHUNK_BYTES = BYTES_PER_SEC / 4; // 250 ms per message (ElevenLabs: 0.1 - 1 s)
const BUFFER_SEC = 20; // audio kept while the connection is down
const PARTIAL_MS = 500; // at most two partials a second
const VAD_SILENCE_SEC = 0.5; // a pause this long ends a segment (ElevenLabs' default 1.5; vad_silence_s, 0.2-3)
const FINAL_WAIT_MS = 1500; // committed_transcript without its timestamped copy: emitted after this
const MAX_RETRIES = 8; // connection attempts in a row without a session
// Errors after which another connection would fail the same way: the transcript stops.
const FATAL = new Set(['auth_error', 'quota_exceeded', 'unaccepted_terms', 'invalid_request', 'input_error', 'chunk_size_exceeded']);
const PREVIOUS_TEXT = 50; // characters of context sent with the first chunk after a reconnect
const SHORT_SESSION_MS = 10_000; // a session closed sooner than this counts as a failed attempt
const START_MS = 15_000; // session_started must come this long after connecting
const MAX_UNSENT_BYTES = 1024 * 1024; // audio the socket may hold unsent (about 25 s as base64 JSON); then it waits
const STALL_MS = 15_000; // a socket that keeps that much unsent this long is given up and opened again

// The realtime URL for a base URL (https://api.elevenlabs.io, or a test server).
export function realtimeUrl(base, { zeroRetention = true, vadSilenceS = VAD_SILENCE_SEC } = {}) {
  const u = new URL(EL_PATH, base);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  if (typeof vadSilenceS !== 'number' || !(vadSilenceS >= 0.2 && vadSilenceS <= 3)) throw new Error('vad_silence_s must be seconds from 0.2 to 3');
  const q = { model_id: EL_MODEL, audio_format: `pcm_${PCM_RATE}`, commit_strategy: 'vad', vad_silence_threshold_secs: String(vadSilenceS), include_timestamps: 'true', include_language_detection: 'true' };
  if (zeroRetention) q.enable_logging = 'false';
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.href;
}

// Seconds of live transcript per tenant and local day (tz), kept in a file so a restart doesn't reset the cap.
export class TranscriptUsage {
  constructor({ file, tz, capMin, now = Date.now }) {
    Object.assign(this, { file, tz, capSec: capMin * 60, now });
    // Tenants in a dictionary without a prototype: a tenant named __proto__ is counted like any other.
    this.state = { day: this.day(), tenants: Object.create(null) };
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s && typeof s.day === 'string' && s.tenants && typeof s.tenants === 'object') this.state = { day: s.day, tenants: Object.assign(Object.create(null), s.tenants) };
    } catch {}
    this.dirty = false;
  }

  day() { return new Intl.DateTimeFormat('en-CA', { timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now()); }

  roll() {
    const d = this.day();
    if (this.state.day !== d) { this.state = { day: d, tenants: Object.create(null) }; this.dirty = true; }
  }

  used(tenant) { this.roll(); return Number(this.state.tenants[tenant]) || 0; }
  left(tenant) { return Math.max(0, this.capSec - this.used(tenant)); }

  add(tenant, sec) {
    this.roll();
    this.state.tenants[tenant] = this.used(tenant) + sec;
    this.dirty = true;
  }

  // Written by rename. A write that fails stays due and is tried again in 30 s (also when no stream runs any more).
  save() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.error(`bosun: live transcript usage not saved (${e.code || e.message}); trying again in 30 s`);
      if (!this.retry) { this.retry = setTimeout(() => { this.retry = null; this.save(); }, 30_000); this.retry.unref?.(); }
    }
  }
}

// One meeting's live transcript. source: {stream (PCM s16le 16 kHz mono), stop(), exited}; on: {partial(seg),
// final(seg), stopped({reason, error})}. Stops by itself at the tenant's daily cap (reason daily-cap), on an error
// that a new connection would not fix (reason error), or when the audio ends (reason audio-ended).
export class LiveTranscript {
  // limits (tests): {startMs, unsentBytes, stallMs, shortSessionMs}.
  constructor({ apiKey, baseUrl, source, tenant, usage, on, partials = true, now = Date.now, retryMs = 1000, limits = {}, vadSilenceS = VAD_SILENCE_SEC }) {
    Object.assign(this, { apiKey, baseUrl, source, tenant, usage, on, partials, now, retryMs, vadSilenceS });
    this.limits = { startMs: START_MS, unsentBytes: MAX_UNSENT_BYTES, stallMs: STALL_MS, shortSessionMs: SHORT_SESSION_MS, ...limits };
    this.url = realtimeUrl(baseUrl, { vadSilenceS });
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
    this.commits = []; // committed_transcript waiting for its timestamped copy, in order
    this.stampedAhead = 0; // copies that came before their committed_transcript
    this.evicted = 0; // finals made without their copy and no longer in commits
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
    // Down (or too slow) for longer than BUFFER_SEC: the oldest audio goes, and that stretch gets no transcript. A session
    // that already had audio would now get it with a hole, and its word times would be off: it is replaced, and the next
    // one starts at the first chunk kept.
    let gap = false;
    while (this.buffer.length > (BUFFER_SEC * BYTES_PER_SEC) / CHUNK_BYTES) { this.buffer.shift(); gap = true; }
    if (gap && this.state === 'live' && this.sessionSent) return this.dropped(this.ws, 'stalled', `ElevenLabs fell more than ${BUFFER_SEC} s behind`);
    this.flush();
  }

  flush() {
    if (this.state !== 'live' || this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.buffer.length && this.state === 'live') {
      // ElevenLabs not reading: keep the audio in the bounded buffer, and after STALL_MS open a new connection.
      if (this.ws.bufferedAmount > this.limits.unsentBytes) {
        this.stallSince ??= this.now();
        if (this.now() - this.stallSince > this.limits.stallMs) this.dropped(this.ws, 'stalled', `ElevenLabs took no audio for ${this.limits.stallMs / 1000} s`);
        return;
      }
      this.stallSince = null;
      // The tenant's allowance is shared by its meetings: a chunk is sent only if it still fits.
      if (this.usage.left(this.tenant) < this.buffer[0].buf.length / BYTES_PER_SEC) { this.stop('daily-cap'); return; }
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
    if (nodeDebugOn()) { this.stop('error', NODE_DEBUG_REFUSED); return; }
    this.sessionSent = false;
    this.stallSince = null;
    const ws = this.ws = new WebSocket(this.url, { headers: { 'xi-api-key': this.apiKey }, handshakeTimeout: 15_000 });
    let started = false;
    clearTimeout(this.startTimer);
    this.startTimer = setTimeout(() => this.dropped(ws, 'error', `no session_started within ${this.limits.startMs / 1000} s`), this.limits.startMs);
    ws.on('unexpected-response', (_req, res) => {
      const code = res.statusCode;
      res.resume();
      this.dropped(ws, code === 401 || code === 403 ? 'auth_error' : 'error', `HTTP ${code} from ElevenLabs`);
    });
    ws.on('message', (data) => {
      if (ws !== this.ws) return;
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.message_type === 'session_started') {
        clearTimeout(this.startTimer);
        started = this.sessionStartedAt = this.now();
        this.sessions++;
        this.session = m.session_id || null;
        // Zero retention applied: the session's config says logging is off, and no warning said otherwise.
        this.zeroRetention = m.config?.disable_logging === true || m.config?.enable_logging === false;
        this.state = 'live';
        this.flush();
        return;
      }
      this.onMessage(m);
    });
    // Closed after a session: opened again at once, unless the session was short (then it counts as a failure).
    ws.on('close', (code) => {
      if (!started) return this.dropped(ws, 'error', `the connection closed before the session started (${code})`);
      const short = this.now() - started < this.limits.shortSessionMs;
      this.dropped(ws, short ? 'closed' : null, `closed after ${Math.round((this.now() - started) / 1000)} s (${code})`);
    });
    ws.on('error', (e) => this.dropped(ws, 'error', String(e?.message || e).slice(0, 200)));
  }

  onMessage(m) {
    switch (m.message_type) {
      case 'partial_transcript': return this.partial(String(m.text || '').trim());
      // A segment comes as committed_transcript and then its timestamped copy, in order. The final is made once: from
      // the copy, or from the plain text when the copy is late (FINAL_WAIT_MS). A late copy, or one that came first, is
      // not a second segment: plain texts and copies are paired by their order, never by their text.
      case 'committed_transcript': {
        if (this.stampedAhead > 0) { this.stampedAhead--; return; }
        // The segment's number is taken now: partials that come before its copy belong to the next one, and a partial
        // of this segment still waiting for its turn is dropped (its text is committed).
        const lp = this.lastPartial;
        clearTimeout(lp.timer); lp.timer = null; lp.queued = null; lp.text = '';
        const text = String(m.text || '').trim();
        const c = { text, end: this.sentPos(), fell: false, seq: text ? ++this.seq : null };
        c.timer = setTimeout(() => this.commitFallback(c), FINAL_WAIT_MS);
        this.commits.push(c);
        // Copies that never come: plain texts already made into finals don't pile up (counted, for their late copies).
        while (this.commits.length > 50 && this.commits[0].fell) { this.commits.shift(); this.evicted++; }
        return;
      }
      case 'committed_transcript_with_timestamps': {
        if (this.evicted > 0) { this.evicted--; return; } // the copy of a final made long ago
        const c = this.commits.shift();
        if (!c) { this.stampedAhead++; return this.final(m); }
        if (c.fell) return; // its final was made without it
        clearTimeout(c.timer);
        return this.final(m, { seq: c.seq });
      }
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
  // A partial belongs to the open segment (seq + 1) when it comes, and keeps that number while it waits for its turn.
  partial(text) {
    const lp = this.lastPartial;
    const seq = this.seq + 1;
    if (!this.partials || !text || (text === lp.text && lp.textSeq === seq)) return;
    lp.queued = text; lp.queuedSeq = seq;
    const send = () => {
      lp.timer = null;
      if (this.state === 'stopped' || lp.queued === null) return;
      const t = lp.queued, q = lp.queuedSeq; lp.queued = null;
      lp.text = t; lp.textSeq = q; lp.at = this.now();
      this.on.partial?.({ seq: q, start_s: round(this.segStart), end_s: round(this.sentPos()), text: t, final: false });
    };
    const wait = PARTIAL_MS - (this.now() - lp.at);
    if (wait <= 0 && !lp.timer) send();
    else if (!lp.timer) lp.timer = setTimeout(send, Math.max(0, wait));
  }

  sentPos() { return this.sentAt.length ? this.sentAt.at(-1)[0] : this.segStart; }

  // The final from committed_transcript alone (no word times; it ends where the audio sent was when it came); its
  // timestamped copy, should it still come, is dropped. Earlier ones waiting go first, in order.
  commitFallback(c) {
    const i = this.commits.indexOf(c);
    if (i < 0) return;
    for (const x of this.commits.slice(0, i + 1)) {
      if (x.fell) continue;
      clearTimeout(x.timer);
      x.fell = true;
      this.final({ text: x.text }, { end: x.end, seq: x.seq });
    }
  }

  final(m, { end: plainEnd = null, seq = null } = {}) {
    // Only this segment's waiting partial goes (the next one's, should it be waiting already, stays).
    const lp = this.lastPartial, fseq = seq ?? this.seq + 1;
    if (lp.queuedSeq === fseq) { clearTimeout(lp.timer); lp.timer = null; lp.queued = null; }
    if (lp.textSeq === fseq) lp.text = '';
    const text = String(m.text || '').trim();
    const words = Array.isArray(m.words) ? m.words.filter((w) => w.type === 'word' && Number.isFinite(w.start) && Number.isFinite(w.end)) : [];
    const start = words.length ? this.sessionBase + words[0].start : this.segStart;
    const end = words.length ? this.sessionBase + words.at(-1).end : Math.max(start, plainEnd ?? this.sentPos());
    if (!text) { this.segStart = Math.max(this.segStart, end); return; }
    const speakers = [...new Set(words.map((w) => w.speaker_id).filter(Boolean))];
    // How long after its last word was sent the final arrived.
    const sent = this.sentAt.find(([s]) => s >= end - 1e-6);
    const lag = sent ? (this.now() - sent[1]) / 1000 : null;
    if (lag !== null) { this.lags.push(lag); if (this.lags.length > 200) this.lags.shift(); }
    const seg = {
      seq: seq ?? ++this.seq, start_s: round(start), end_s: round(end), text, final: true,
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
    clearTimeout(this.startTimer);
    // A session that lasted: the count of failures in a row starts over, whether it ended by an error or a close.
    if (this.sessionStartedAt && this.now() - this.sessionStartedAt >= this.limits.shortSessionMs) this.failures = 0;
    this.sessionStartedAt = null;
    try { ws.terminate(); } catch {}
    if (this.commits.length) this.commitFallback(this.commits.at(-1));
    this.commits = []; this.stampedAhead = 0; this.evicted = 0; // a new connection starts its own pairing
    if (kind && FATAL.has(kind)) return this.stop('error', `${kind}: ${error}`);
    if (kind) { this.failures++; this.lastError = `${kind}: ${error}`; }
    if (this.failures > MAX_RETRIES) return this.stop('error', this.lastError || 'ElevenLabs kept closing the connection');
    this.state = 'reconnecting';
    const wait = Math.min(30_000, this.retryMs * 2 ** Math.max(0, this.failures - 1));
    this.retry = setTimeout(() => this.connect(), kind ? wait : 0);
  }

  // Ends the stream and the audio capture. reason: left | opted-out | stopped | daily-cap | error | audio-ended ...
  // Text ElevenLabs already committed becomes a final, unless discard (an opt-out or a deletion forgets it anyway).
  async stop(reason, error = null, { discard = false } = {}) {
    if (this.state === 'stopped') return this.stopping;
    if (!discard && this.commits.length) this.commitFallback(this.commits.at(-1));
    this.state = 'stopped';
    this.reason = reason;
    this.error = error;
    clearTimeout(this.retry);
    clearTimeout(this.startTimer);
    clearTimeout(this.lastPartial.timer);
    for (const c of this.commits) clearTimeout(c.timer);
    this.commits = [];
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
      model: EL_MODEL, vad_silence_s: this.vadSilenceS, zero_retention: this.zeroRetention, ...(this.warnings.length ? { warnings: this.warnings } : {}),
      segments: this.seq, streamed_min: round(this.streamedSec / 60), today_min: round(this.usage.used(this.tenant) / 60), daily_cap_min: round(this.usage.capSec / 60),
      ...(avg !== null ? { final_lag_s: { avg: round(avg), max: round(Math.max(...this.lags)) } } : {}),
      started_at: new Date(this.startedAt).toISOString(),
    };
  }
}

const round = (x) => Math.round(x * 100) / 100;

