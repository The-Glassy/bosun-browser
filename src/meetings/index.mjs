// Meetings (PoC): Bosun joins a video meeting as an unauthenticated guest notetaker, says so in the chat, records the
// meeting's audio to a file and leaves again. Transcription is not done here; it happens after the meeting, from the
// recording. Consent: everyone in the chat is told before recording starts, every chat message reaches the agent as
// an event, and a clear request not to be recorded (any of five languages, see optout.mjs) stops the recording and
// deletes the file at once.
//
// A meeting runs in a session of its own (owner meeting:<id>, so it outlives the agent's connection), in a browser
// process of its own whose audio goes to a private PulseAudio server (audio.mjs). Platforms (platforms/*.mjs) hold
// everything site-specific; Google Meet is the only one so far.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { httpUrl } from '../sessions.mjs';
import { matchOptOut } from './optout.mjs';
import { meet } from './platforms/meet.mjs';
import { pulseAudio } from './audio.mjs';

export const ID_RE = /^m[0-9a-f]{12}$/;
export const PLATFORMS = [meet];
const POLL_MS = 1000;
const ALONE_MS = 120_000; // alone in the call this long: leave
const JOIN_REPLY_MS = 60_000; // meeting_join answers once the join request is out (or after this)
const MAX_CHAT = 500; // kept per meeting
const MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const SELF_SENDERS = /^(?:you|du|sie|ich|me|myself)$/i; // how a chat UI labels our own messages

// state: joining -> waiting -> admitted -> recording -> ended (recording -> admitted when it is stopped early).
const NEXT = {
  joining: ['waiting', 'admitted', 'ended'],
  waiting: ['admitted', 'ended'],
  admitted: ['recording', 'ended'],
  recording: ['admitted', 'ended'],
  ended: [],
};
export function transition(m, to) {
  if (!NEXT[m.state]?.includes(to)) throw new Error(`meeting ${m.id}: ${m.state} -> ${to} is not allowed`);
  m.state = to;
}

const botName = (name) => String(name).replace(/\s*\(.*\)\s*$/, '').trim() || 'Bosun';
// The default announcement, English then German. owner: whose notetaker it is (MEETING_OWNER), or nobody named.
export function announcement(name, owner) {
  const n = botName(name);
  return [
    `Hi, I'm ${n}, ${owner ? `${owner}'s` : 'an'} AI notetaker. I'm recording audio for notes. If you'd rather not be recorded, just say so here in chat (e.g. 'please don't record') and I'll stop and delete the recording.`,
    `Hallo, ich bin ${n}, ${owner ? `KI-Notizassistent von ${owner}` : 'ein KI-Notizassistent'}. Ich nehme den Ton für Notizen auf. Wenn ihr nicht aufgenommen werden wollt, schreibt es einfach hier in den Chat (z. B. „bitte nicht aufnehmen“), dann stoppe und lösche ich die Aufnahme.`,
  ];
}
export const CONFIRM_DELETED = 'Recording stopped and deleted. / Aufnahme gestoppt und gelöscht.';

const sleep = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return r();
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

// Recordings older than `days` (by modification time) are deleted, except those still being written.
export function sweepRecordings(dir, days, { now = Date.now(), keep = new Set() } = {}) {
  const removed = [];
  let tenants = [];
  try { tenants = fs.readdirSync(dir); } catch { return removed; }
  for (const t of tenants) {
    let files = [];
    try { files = fs.readdirSync(path.join(dir, t)); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, t, f);
      if (!/^m[0-9a-f]{12}\.ogg$/.test(f) || keep.has(p)) continue;
      try { if (now - fs.statSync(p).mtimeMs > days * 86_400_000) { fs.rmSync(p, { force: true }); removed.push(p); } } catch {}
    }
  }
  return removed;
}

export class Meetings {
  // audio: {unsupported() -> reason|null, open() -> {browserEnv, args?, record(file), close()}, needsHeadful};
  // platformFor(url) -> platform|null; bus: EventBus (meeting events).
  constructor({ cfg, manager, bus, audio = pulseAudio, platformFor = (url) => PLATFORMS.find((p) => p.matches(url)) || null,
    now = Date.now, pollMs = POLL_MS, aloneMs = ALONE_MS }) {
    Object.assign(this, { cfg, manager, bus, audio, platformFor, now, pollMs, aloneMs });
    this.dir = path.join(cfg.dataDir, 'recordings');
    this.active = new Map(); // id -> meeting
    this.ended = new Map(); // id -> meeting (bounded), for status and chat after the end
    this.stopped = false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), 3_600_000);
    this.sweeper.unref();
  }

  sweep() {
    const keep = new Set([...this.active.values()].filter((m) => m.rec).map((m) => m.file));
    return sweepRecordings(this.dir, this.cfg.recordingRetentionDays, { now: this.now(), keep });
  }

  file(tenant, id) { return path.join(this.dir, tenant, `${id}.ogg`); }

  emit(m, kind, data) {
    Promise.resolve().then(() => this.bus?.meeting(kind, { tenant: m.tenant, meeting_id: m.id, platform: m.platform.name, ...data })).catch(() => {});
  }

  get(tenant, id) {
    const m = (ID_RE.test(String(id)) && (this.active.get(id) || this.ended.get(id))) || null;
    if (!m || m.tenant !== tenant) throw new Error(`no meeting ${id}`);
    return m;
  }

  // Starts joining; resolves once the join request is out (state waiting or admitted), or rejects with the reason the
  // meeting could not be joined (denied, not a meeting page, no audio, ...).
  async join(tenant, { url, name = 'Glassy (notetaker)', announceText, maxWaitAdmitMin = 10, profile, engine, leaveOnOptOut = true }) {
    if (this.stopped || this.manager.closing) throw new Error('service is shutting down');
    url = httpUrl(url);
    const platform = this.platformFor(url);
    if (!platform) throw new Error('only Google Meet links (https://meet.google.com/abc-defg-hij) are supported for now');
    const eng = engine || (this.manager.engines.get(this.cfg.engine).family === 'chromium' ? this.cfg.engine : 'chromium');
    if (this.manager.engines.get(eng).family !== 'chromium') throw new Error(`meetings need a Chromium engine (chromium or patchright); ${eng} is not supported for meetings`);
    const why = await this.audio.unsupported();
    if (why) throw new Error(why);
    if (this.audio.needsHeadful && this.cfg.headless) throw new Error('meetings need a headful browser (headless Chromium plays no audio): run the service without HEADLESS=1, under Xvfb');
    const id = `m${crypto.randomBytes(6).toString('hex')}`;
    const m = {
      id, tenant, url, name, platform, profile: profile || null, engine: eng, owner: `meeting:${id}`, leaveOnOptOut,
      announce: announceText ? [announceText] : announcement(name, this.cfg.meetingOwner),
      maxWaitMs: maxWaitAdmitMin * 60_000, state: 'joining', reason: null, error: null,
      createdAt: this.now(), admittedAt: null, endedAt: null, rig: null, session: null, rec: null, recMs: 0, file: null, deleted: false,
      chat: [], chatSeq: 0, sent: new Set(), participants: null, aloneSince: null, optedOut: null, chatKey: `__b${crypto.randomBytes(8).toString('hex')}`,
      ac: new AbortController(), joined: deferred(), finishing: null,
    };
    this.active.set(id, m);
    m.task = this.run(m).catch((e) => this.finish(m, 'error', e));
    const ac = new AbortController();
    await Promise.race([m.joined.p, sleep(JOIN_REPLY_MS, ac.signal)]);
    ac.abort();
    if (m.state === 'ended' && !m.admittedAt) throw new Error(m.error || `could not join (${m.reason})`);
    return this.view(m);
  }

  // One page operation at a time, through the session's queue (also keeps the session from idling out).
  page(m, fn) { return this.manager.run(m.owner, m.session.id, (s) => fn(s.page)); }

  async run(m) {
    const { platform } = m;
    const signal = m.ac.signal;
    m.rig = await this.audio.open();
    if (signal.aborted) return;
    m.session = await this.manager.open({
      owner: m.owner, tenant: m.tenant, profile: m.profile || undefined, engine: m.engine,
      media: { args: [...MEDIA_ARGS, ...(m.rig.args || [])], env: m.rig.browserEnv },
    });
    if (signal.aborted) return;
    await m.session.ctx.grantPermissions(['microphone', 'camera'], { origin: new URL(m.url).origin }).catch(() => {});
    await this.page(m, (p) => p.goto(m.url, { waitUntil: 'domcontentloaded', timeout: 45_000 })).catch((e) => {
      throw new Error(`could not load the meeting page: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
    });
    const first = await this.page(m, (p) => platform.lobby(p, { name: m.name }));
    if (first === 'denied') return this.finish(m, 'denied', "can't join this call (denied, or guests are not allowed)");
    if (first === 'ended') return this.finish(m, 'meeting-ended', 'the meeting has ended');
    if (first === 'waiting') {
      transition(m, 'waiting');
      m.joined.resolve();
      const until = this.now() + m.maxWaitMs;
      for (;;) {
        await sleep(this.pollMs, signal);
        if (signal.aborted || m.state === 'ended') return;
        const s = await this.page(m, (p) => platform.state(p));
        if (s === 'admitted') break;
        if (s === 'denied') return this.finish(m, 'denied', 'the request to join was denied');
        if (s === 'ended' || s === 'removed') return this.finish(m, 'meeting-ended', 'the meeting has ended');
        if (this.now() > until) return this.finish(m, 'not-admitted', `not admitted within ${Math.round(m.maxWaitMs / 60_000)} min`);
      }
    }
    transition(m, 'admitted');
    m.admittedAt = this.now();
    m.joined.resolve();
    // Consent first: the chat hears about the recording before it starts.
    await this.page(m, async (p) => {
      m.participants = await platform.participants(p);
      await platform.openChat(p);
      await platform.watchChat(p, m.chatKey);
      for (const t of m.announce) { m.sent.add(t.trim()); await platform.sendChat(p, t); }
    });
    await this.pollChat(m); // an objection that arrived meanwhile counts before anything is recorded
    if (m.state === 'ended' || signal.aborted) return;
    if (!m.optedOut) this.startRecording(m);
    while (!signal.aborted && m.state !== 'ended') {
      await sleep(this.pollMs, signal);
      if (signal.aborted || m.state === 'ended') return;
      await this.tick(m);
    }
  }

  startRecording(m) {
    m.file = this.file(m.tenant, m.id);
    m.rec = m.rig.record(m.file);
    transition(m, 'recording');
    m.rec.exited.then(() => {
      if (m.rec?.file !== m.file || m.state !== 'recording') return;
      // The recorder died on its own (ffmpeg error): the meeting goes on without recording.
      m.recMs += this.now() - m.rec.startedAt;
      m.recError = m.rec.error() || 'recorder exited';
      m.rec = null;
      transition(m, 'admitted');
    });
  }

  async tick(m) {
    const s = await this.page(m, (p) => m.platform.state(p));
    if (s === 'ended') return this.finish(m, 'meeting-ended');
    if (s === 'removed') return this.finish(m, 'removed');
    await this.pollChat(m);
    if (m.state === 'ended') return;
    const n = await this.page(m, (p) => m.platform.participants(p));
    m.participants = n;
    if (n !== null && n <= 1) {
      m.aloneSince ??= this.now();
      if (this.now() - m.aloneSince > this.aloneMs) return this.finish(m, 'alone');
    } else m.aloneSince = null;
  }

  own(m, msg) {
    const sender = (msg.sender || '').trim();
    return SELF_SENDERS.test(sender) || sender === m.name || m.sent.has((msg.text || '').trim());
  }

  async pollChat(m) {
    let msgs = await this.page(m, (p) => m.platform.drainChat(p, m.chatKey));
    if (msgs === null) { // the page was replaced (Meet re-rendered): watch again
      await this.page(m, (p) => m.platform.watchChat(p, m.chatKey));
      msgs = [];
    }
    for (const msg of msgs) {
      if (this.own(m, msg) || !msg.text) continue;
      const entry = { seq: ++m.chatSeq, at: new Date(this.now()).toISOString(), sender: msg.sender || null, text: msg.text };
      m.chat.push(entry);
      if (m.chat.length > MAX_CHAT) m.chat.shift();
      this.emit(m, 'chat', { sender: entry.sender, text: entry.text });
      if (!m.optedOut && !m.deleted && matchOptOut(msg.text)) await this.optOut(m, entry);
      if (m.state === 'ended') return;
    }
  }

  // Someone asked not to be recorded: stop, delete, confirm in the chat, tell the agent, leave (or stay, unrecorded).
  async optOut(m, msg) {
    m.optedOut = { sender: msg.sender, text: msg.text, at: msg.at };
    await this.stopRecording(m, { del: true });
    m.sent.add(CONFIRM_DELETED);
    await this.page(m, (p) => m.platform.sendChat(p, CONFIRM_DELETED)).catch(() => {});
    this.emit(m, 'optout', { sender: msg.sender, text: msg.text, left: m.leaveOnOptOut });
    if (m.leaveOnOptOut) await this.finish(m, 'opted-out');
  }

  async stopRecording(m, { del = true } = {}) {
    const rec = m.rec;
    if (rec) {
      m.rec = null;
      m.recMs += this.now() - rec.startedAt;
      if (m.state === 'recording') transition(m, 'admitted');
      await (del ? rec.kill() : rec.stop());
    }
    let bytes = null;
    if (del && m.file) {
      fs.rmSync(m.file, { force: true });
      m.deleted = true;
      m.file = null;
    } else if (m.file) bytes = fs.statSync(m.file, { throwIfNoEntry: false })?.size ?? null;
    return { stopped: !!rec, deleted: del && m.deleted, ...(bytes !== null ? { bytes } : {}) };
  }

  // Leave and clean up. Idempotent; every path ends here (leave, end, removal, alone, opt-out, error, shutdown).
  finish(m, reason, error = null) {
    if (m.finishing) return m.finishing;
    m.finishing = (async () => {
      m.reason = reason;
      if (error) m.error = typeof error === 'string' ? error : String(error?.message || error).split('\n')[0].slice(0, 300);
      const wasIn = !!m.admittedAt;
      if (m.state !== 'ended') m.state = 'ended';
      m.endedAt = this.now();
      m.ac.abort();
      m.joined.resolve();
      const rec = m.rec;
      if (rec) { m.rec = null; m.recMs += this.now() - rec.startedAt; await rec.stop().catch(() => {}); }
      if (m.session && !m.session.disposed) {
        if (wasIn && reason !== 'meeting-ended' && reason !== 'removed') {
          await Promise.race([this.page(m, (p) => m.platform.leave(p)).catch(() => {}), sleep(5000)]);
        }
        await this.manager.dispose(m.session, 'meeting-ended').catch(() => {});
      }
      await m.rig?.close().catch(() => {});
      const bytes = m.file ? fs.statSync(m.file, { throwIfNoEntry: false })?.size ?? 0 : 0;
      this.active.delete(m.id);
      this.ended.set(m.id, m);
      if (this.ended.size > 50) this.ended.delete(this.ended.keys().next().value);
      this.emit(m, 'ended', {
        reason, ...(m.error ? { error: m.error } : {}),
        duration_s: Math.round(((m.endedAt - (m.admittedAt ?? m.endedAt))) / 1000),
        recording: m.file && bytes ? { path: m.file, uri: pathToFileURL(m.file).href, bytes, mime_type: 'audio/ogg', seconds: Math.round(m.recMs / 1000) } : null,
        bytes,
      });
    })();
    return m.finishing;
  }

  view(m) {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    const recMs = m.recMs + (m.rec ? this.now() - m.rec.startedAt : 0);
    const bytes = m.file ? fs.statSync(m.file, { throwIfNoEntry: false })?.size ?? 0 : null;
    return {
      meeting_id: m.id, platform: m.platform.name, url: m.url, state: m.state,
      ...(m.reason ? { reason: m.reason } : {}), ...(m.error ? { error: m.error } : {}),
      participants: m.participants, recording_seconds: Math.round(recMs / 1000),
      recording: m.file ? { path: m.file, bytes } : m.deleted ? 'deleted' : null,
      ...(m.recError ? { recording_error: m.recError } : {}),
      ...(m.optedOut ? { opted_out: { sender: m.optedOut.sender, at: m.optedOut.at } } : {}),
      chat_messages: m.chatSeq, joined_at: iso(m.createdAt), admitted_at: iso(m.admittedAt), ended_at: iso(m.endedAt),
    };
  }

  status(tenant, id) {
    if (id) return this.view(this.get(tenant, id));
    return [...this.active.values(), ...this.ended.values()].filter((m) => m.tenant === tenant).map((m) => this.view(m));
  }

  chatRead(tenant, id, since = 0) {
    const m = this.get(tenant, id);
    return { meeting_id: id, state: m.state, messages: m.chat.filter((c) => c.seq > since) };
  }

  async chatSend(tenant, id, text) {
    const m = this.get(tenant, id);
    if (m.state !== 'admitted' && m.state !== 'recording') throw new Error(`meeting ${id} is ${m.state}; chat is available once admitted`);
    m.sent.add(text.trim());
    await this.page(m, (p) => m.platform.sendChat(p, text));
    return { sent: true };
  }

  async stopRecordingTool(tenant, id, del = true) {
    const m = this.get(tenant, id);
    if (!m.rec && !(del && m.file)) return { stopped: false, deleted: false, state: m.state };
    const r = await this.stopRecording(m, { del });
    return { ...r, state: m.state };
  }

  async leave(tenant, id) {
    const m = this.get(tenant, id);
    await this.finish(m, 'left');
    return this.view(m);
  }

  // Deletes a recording: a meeting still recording stops first. Works for recordings of earlier runs too.
  async deleteRecording(tenant, id) {
    if (!ID_RE.test(String(id))) throw new Error(`no meeting ${id}`);
    const m = this.active.get(id) || this.ended.get(id);
    if (m && m.tenant !== tenant) throw new Error(`no meeting ${id}`);
    if (m?.rec) return { ...(await this.stopRecording(m, { del: true })), meeting_id: id };
    const f = this.file(tenant, id);
    const existed = fs.existsSync(f);
    fs.rmSync(f, { force: true });
    if (m && m.file === f) { m.file = null; m.deleted = true; }
    if (!existed && !m) throw new Error(`no recording for meeting ${id}`);
    return { meeting_id: id, deleted: existed };
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.sweeper);
    await Promise.race([Promise.allSettled([...this.active.values()].map((m) => this.finish(m, 'shutdown'))), sleep(15_000)]);
  }
}
