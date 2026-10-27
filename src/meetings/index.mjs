// Meetings (PoC): Bosun joins a video meeting as a notetaker (a guest, or with a signed-in profile), says so in the chat, records the
// meeting's audio to a file and leaves again. With live_transcript the audio is also transcribed as it is spoken
// (transcript.mjs, ElevenLabs realtime), under the same consent as the recording: it starts and stops with it. The agent
// can speak into the call (speech.mjs: text to speech, or an uploaded file, played into the browser's microphone),
// unmute and mute, and raise a hand; when to do any of that is the agent's call, never Bosun's. Consent: the chat is told before recording starts (announce: everyone, else the host where the host allows
// chat with the host only; or, when the caller says so, the host only or nobody), every chat message reaches the agent
// as an event, and a clear request not to be recorded (any of five languages, see optout.mjs) stops the recording and
// deletes the file at once, whatever the announcement mode.
//
// A meeting runs in a session of its own (owner meeting:<id>, so it outlives the agent's connection), in a browser
// process of its own whose audio goes to a private PulseAudio server (audio.mjs). Platforms (platforms/*.mjs) hold
// everything site-specific: Google Meet (meet.mjs) and Zoom's web client (zoom.mjs).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pathToFileURL } from 'url';
import { httpUrl } from '../sessions.mjs';
import { readProfileMeta } from '../engines.mjs';
import { TENANT_RE } from '../auth.mjs';
import { matchOptOut, normalize } from './optout.mjs';
import { cleanChatText, cleanSender } from './platforms/common.mjs';
import { meet } from './platforms/meet.mjs';
import { zoom } from './platforms/zoom.mjs';
import { pulseAudio } from './audio.mjs';
import { LiveTranscript, TranscriptUsage, nodeDebugOn, NODE_DEBUG_REFUSED } from './transcript.mjs';
import { synthesizeWav, splitSpeech, probeSeconds, audioFormat } from './speech.mjs';

export const ID_RE = /^m[0-9a-f]{12}$/;
export const ANNOUNCE_MODES = ['chat', 'host', 'none'];
export const PLATFORMS = [meet, zoom];
const POLL_MS = 1000;
const ALONE_MS = 120_000; // alone in the call this long while nobody else has been there yet: leave
const ALONE_LEAVE_MS = 30_000; // alone this long after everyone else left: leave (meeting_join alone_leave_sec)
const ECHO_MS = 60_000; // after posting, senderless copies of the post are ours however often the panel renders them
const ECHO_LONG = 40; // a senderless exact copy of a post at least this long (normalized) is ours at any time
const JOIN_REPLY_MS = 60_000; // meeting_join answers once the join request is out (or after this)
const MAX_CHAT = 500; // kept per meeting
const MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const SELF_SENDERS = /^(?:you|du|sie|ich|me|myself)$/i; // how a chat UI labels our own messages
const MAX_STARTING = 50; // meetings still setting up, across tenants
const SPEECH_TAIL_MS = 400; // the microphone stays on this long after the audio ends (what is still on its way)
const SPEECH_GRACE_MS = 15_000; // playback still going this long after the audio should have ended is cut off

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
// The default announcement, English then German. owner: whose notetaker it is (MEETING_OWNER), or nobody named. live: the
// audio is also transcribed live.
export function announcement(name, owner, { live = false } = {}) {
  const n = botName(name);
  if (live) {
    return [
      `Hi, I'm ${n}, ${owner ? `${owner}'s` : 'an'} AI notetaker. This call is recorded and transcribed live for notes. If you'd rather not be recorded, just say so here in chat (e.g. 'please don't record') and I'll stop both and delete the recording.`,
      `Hallo, ich bin ${n}, ${owner ? `KI-Notizassistent von ${owner}` : 'ein KI-Notizassistent'}. Dieser Anruf wird für Notizen aufgezeichnet und live transkribiert. Wenn ihr nicht aufgenommen werden wollt, schreibt es einfach hier in den Chat (z. B. „bitte nicht aufnehmen“), dann stoppe ich beides und lösche die Aufnahme.`,
    ];
  }
  return [
    `Hi, I'm ${n}, ${owner ? `${owner}'s` : 'an'} AI notetaker. I'm recording audio for notes. If you'd rather not be recorded, just say so here in chat (e.g. 'please don't record') and I'll stop and delete the recording.`,
    `Hallo, ich bin ${n}, ${owner ? `KI-Notizassistent von ${owner}` : 'ein KI-Notizassistent'}. Ich nehme den Ton für Notizen auf. Wenn ihr nicht aufgenommen werden wollt, schreibt es einfach hier in den Chat (z. B. „bitte nicht aufnehmen“), dann stoppe und lösche ich die Aufnahme.`,
  ];
}
export const CONFIRM_DELETED = 'Recording stopped and deleted. / Aufnahme gestoppt und gelöscht.';
export const CONFIRM_DELETED_LIVE = 'Recording and live transcript stopped and deleted. / Aufnahme und Live-Transkript gestoppt und gelöscht.';
// Google turned the guest away before anyone could admit it ("You can't join this video call").
export const REFUSED_BY_GOOGLE = "Google refused to let this guest join (\"You can't join this video call\") before anyone could admit it. " +
  'Google often does this for automated guests, especially from datacenter IPs. Join with a Bosun profile that is signed in to a ' +
  'Google account (meeting_join with profile), or run Bosun from a residential IP.';

// How a join that didn't get in ends: lobby/state outcome -> [reason, error]. Platforms may word the error.
function outcome(m, s) {
  const say = m.platform.messages || {};
  switch (s) {
    case 'denied': return ['denied', 'the request to join was denied'];
    case 'refused': return [m.platform.refusedReason || 'refused_by_google', say.refused || REFUSED_BY_GOOGLE];
    case 'ended': return ['meeting-ended', 'the meeting has ended'];
    case 'invalid': return ['invalid-meeting', m.info.error || say.invalid || 'the meeting link is not valid'];
    case 'sign-in': return ['sign-in-required', say.signIn || 'only signed-in users can join this meeting; join with a signed-in profile'];
    case 'captcha': return ['captcha', say.captcha || 'the meeting page asked for a captcha before joining'];
    default: return null;
  }
}

const sleep = (ms, signal) => new Promise((r) => {
  if (signal?.aborted) return r();
  const onAbort = () => { clearTimeout(t); r(); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); r(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});
const oneLine = (e) => String(e?.message || e).split('\n')[0].slice(0, 300);
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
    now = Date.now, pollMs = POLL_MS, aloneMs = ALONE_MS, aloneLeaveMs = ALONE_LEAVE_MS, speechGraceMs = SPEECH_GRACE_MS }) {
    Object.assign(this, { cfg, manager, bus, audio, platformFor, now, pollMs, aloneMs, aloneLeaveMs, speechGraceMs });
    this.dir = path.join(cfg.dataDir, 'recordings');
    this.active = new Map(); // id -> meeting
    this.dryRuns = new Set(); // dry runs in progress: {tenant, session} (capacity)
    this.ended = new Map(); // id -> meeting (bounded), for status and chat after the end
    this.stopped = false;
    // Live transcript minutes per tenant and day (LIVE_TRANSCRIPT_DAILY_MIN).
    this.usage = new TranscriptUsage({ file: path.join(cfg.dataDir, 'live-transcript-usage.json'), tz: cfg.tz, capMin: cfg.liveTranscriptDailyMin ?? 180, now });
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

  // Validation shared by join and inspect: the platform, a signed-in profile (an existing Bosun profile, logged in to
  // Google or Zoom with session_open + request_human first, opened with the engine it was last used with unless one is
  // given), the engine, the audio backend.
  async check(tenant, { url, profile, engine }) {
    if (this.stopped || this.manager.closing) throw new Error('service is shutting down');
    url = httpUrl(url);
    const platform = this.platformFor(url);
    if (!platform) throw new Error('only Google Meet (https://meet.google.com/abc-defg-hij) and Zoom (https://zoom.us/j/<id>?pwd=…) links are supported for now');
    let meta = null;
    if (profile) {
      if (!TENANT_RE.test(profile)) throw new Error('invalid profile name');
      const dir = path.join(this.cfg.dataDir, 'profiles', tenant, profile);
      if (!fs.existsSync(dir)) throw new Error(`no profile ${profile}: open it with session_open({profile}), sign in to Google (request_human), close it, then join with it`);
      meta = readProfileMeta(dir);
      if (meta?.family === 'firefox') throw new Error(`profile ${profile} is a Firefox (camoufox) profile; meetings need a Chromium profile`);
    }
    const eng = engine || meta?.engine || (this.manager.engines.get(this.cfg.engine).family === 'chromium' ? this.cfg.engine : 'chromium');
    if (this.manager.engines.get(eng).family !== 'chromium') throw new Error(`meetings need a Chromium engine (chromium or patchright); ${eng} is not supported for meetings`);
    const why = await this.audio.unsupported();
    if (why) throw new Error(why);
    if (this.audio.needsHeadful && this.cfg.headless) throw new Error('meetings need a headful browser (headless Chromium plays no audio): run the service without HEADLESS=1, under Xvfb');
    return { url, platform, eng };
  }

  // Capacity, synchronously: a meeting still setting up (audio server, browser launch) has no session yet but will
  // need one, so it counts. No audio server starts for a meeting that could not get a session.
  capacity(tenant) {
    // Dry runs that have not got their session yet count like meetings still setting up.
    const starting = [...this.active.values(), ...this.dryRuns].filter((x) => !x.session && !x.finishing && !x.handedOver);
    if (this.manager.used + starting.length >= this.cfg.maxSessions || starting.length >= MAX_STARTING) throw new Error(`session limit ${this.cfg.maxSessions} reached; close one`);
    const tUse = (this.manager.tenantUse.get(tenant) || 0) + starting.filter((x) => x.tenant === tenant).length;
    if (tUse >= this.cfg.maxSessionsPerTenant) throw new Error(`session limit ${this.cfg.maxSessionsPerTenant} for this tenant reached; close one`);
  }

  // dry_run: loads the meeting page exactly as a join would (same profile, engine, devices and language) and reports
  // what Bosun sees there (platform.inspect): the lobby kind, the button it would click, microphone and camera,
  // whether a challenge is shown. Nothing is joined: the session is closed again right after.
  async inspect(tenant, { url, profile, engine }) {
    const checked = await this.check(tenant, { url, profile, engine });
    const { platform, eng } = checked;
    url = checked.url;
    this.capacity(tenant);
    // Reserved before anything is awaited, so concurrent dry runs can't overshoot the caps; released below.
    const slot = { tenant, session: null, finishing: false, handedOver: false, task: null, rig: null };
    this.dryRuns.add(slot);
    const owner = `meeting-dry-run:${crypto.randomBytes(4).toString('hex')}`;
    let rig = null, session = null;
    const task = (async () => {
      rig = slot.rig = await this.audio.open();
      if (this.stopped) throw new Error('service is shutting down');
      // The session manager reserves its own slot synchronously in open(), unless the profile is still busy (a
      // keepalive visit, a closing session): then this slot keeps counting until the session is there.
      const busy = profile && this.manager.profilesInUse.has(`${tenant}/${profile}`);
      const opening = this.manager.open({ owner, tenant, profile: profile || undefined, engine: eng, locale: platform.locale, media: { args: [...MEDIA_ARGS, ...(rig.args || [])], env: rig.browserEnv } });
      slot.handedOver = !busy;
      session = slot.session = await opening;
      const target = platform.joinUrl ? platform.joinUrl(url) : url;
      for (const origin of new Set([new URL(url).origin, new URL(target).origin, ...(platform.origins ? platform.origins(url) : [])])) {
        await session.ctx.grantPermissions(['microphone', 'camera'], { origin }).catch(() => {});
      }
      if (platform.prepare) await platform.prepare(session.ctx);
      const r = await this.manager.run(owner, session.id, async (s) => {
        await s.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        const seen = await platform.inspect(s.page, { profile });
        const u = new URL(s.page.url());
        return { ...seen, page: `${u.origin}${u.pathname}`, title: await s.page.title().catch(() => '') };
      });
      return { dry_run: true, platform: platform.name, ...(profile ? { profile } : {}), engine: eng, ...r, note: 'nothing was joined or clicked except the page\'s own tips and device questions' };
    })();
    // The slot stays tracked until its cleanup is done, so shutdown can wait for it.
    slot.task = task.finally(async () => {
      slot.finishing = true;
      if (session) await this.manager.dispose(session, 'meeting-dry-run').catch(() => {});
      await (slot.closing ??= rig?.close())?.catch(() => {});
      this.dryRuns.delete(slot);
    });
    return slot.task;
  }

  // Starts joining; resolves once the join request is out (state waiting or admitted), or rejects with the reason the
  // meeting could not be joined (denied, not a meeting page, no audio, ...).
  async join(tenant, { url, name = 'Glassy (notetaker)', announceText, announce = 'chat', maxWaitAdmitMin = 10, profile, engine, leaveOnOptOut = true, aloneLeaveSec = null,
    liveTranscript = false, transcriptPartials = true }) {
    if (!ANNOUNCE_MODES.includes(announce)) throw new Error(`announce must be one of ${ANNOUNCE_MODES.join(', ')}`);
    if (liveTranscript) {
      if (!this.cfg.elevenlabs) throw new Error('live_transcript needs ElevenLabs (ELEVENLABS_API_KEY is not set on this Bosun); join without it');
      if (nodeDebugOn()) throw new Error(`live_transcript is refused: ${NODE_DEBUG_REFUSED}`);
      if (this.usage.left(tenant) <= 0) throw new Error(`the daily live transcript limit (${this.usage.capSec / 60} min) is used up for today; join without live_transcript`);
    }
    const checked = await this.check(tenant, { url, profile, engine });
    const { platform, eng } = checked;
    url = checked.url;
    this.capacity(tenant);
    const id = `m${crypto.randomBytes(6).toString('hex')}`;
    const m = {
      id, tenant, url, name, platform, profile: profile || null, engine: eng, owner: `meeting:${id}`, leaveOnOptOut,
      aloneLeaveMs: aloneLeaveSec !== null ? aloneLeaveSec * 1000 : this.aloneLeaveMs, othersSeen: false,
      announce: announceText ? [announceText] : announcement(name, this.cfg.meetingOwner, { live: liveTranscript }),
      live: liveTranscript, partials: transcriptPartials, transcript: null, speech: null, speechSeq: 0,
      announceMode: announce, announced: { sent_to: null, failures: [] }, chatTo: announce === 'host' ? 'host' : 'everyone', chatError: null,
      maxWaitMs: maxWaitAdmitMin * 60_000, state: 'joining', reason: null, error: null,
      createdAt: this.now(), admittedAt: null, endedAt: null, rig: null, session: null, rec: null, stopping: null, recMs: 0, file: null, deleted: false,
      info: {}, noRecord: false, chat: [], chatSeq: 0, chatTexts: new Map(), pendingOwn: [], echoes: new Map(), participants: null, aloneSince: null, optedOut: null, chatKey: `__b${crypto.randomBytes(8).toString('hex')}`,
      ac: new AbortController(), joined: deferred(), announceDone: deferred(), finishing: null,
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
    // finish() may run while these are being acquired and miss them: whatever arrives after it is released here.
    const rig = await this.audio.open();
    m.rig = rig;
    if (m.finishing) { await rig.close().catch(() => {}); return; }
    const session = await this.manager.open({
      owner: m.owner, tenant: m.tenant, profile: m.profile || undefined, engine: m.engine, locale: platform.locale,
      media: { args: [...MEDIA_ARGS, ...(rig.args || [])], env: rig.browserEnv },
    }).catch(async (e) => { await rig.close().catch(() => {}); throw e; });
    m.session = session;
    if (m.finishing) { await this.manager.dispose(session, 'meeting-ended').catch(() => {}); await rig.close().catch(() => {}); return; }
    const target = platform.joinUrl ? platform.joinUrl(m.url) : m.url;
    for (const origin of new Set([new URL(m.url).origin, new URL(target).origin, ...(platform.origins ? platform.origins(m.url) : [])])) {
      await m.session.ctx.grantPermissions(['microphone', 'camera'], { origin }).catch(() => {});
    }
    if (platform.prepare) await platform.prepare(m.session.ctx);
    await this.page(m, (p) => p.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 })).catch((e) => {
      throw new Error(`could not load the meeting page: ${String(e?.message || e).split('\n')[0].slice(0, 200)}`);
    });
    const first = await this.page(m, (p) => platform.lobby(p, { name: m.name, info: m.info, profile: m.profile, url: m.url }));
    if (outcome(m, first)) return this.finish(m, ...outcome(m, first));
    if (first === 'removed') return this.finish(m, 'denied', 'the request to join was denied');
    if (first === 'waiting' || first === 'asked') {
      m.knocked = first === 'waiting'; // the waiting room was seen: the request reached the meeting
      transition(m, 'waiting');
      m.joined.resolve();
      const until = this.now() + m.maxWaitMs;
      for (;;) {
        await sleep(this.pollMs, signal);
        if (signal.aborted || m.state === 'ended') return;
        const s = await this.page(m, (p) => platform.state(p, { admitted: false }));
        if (s === 'admitted') break;
        if (s === 'waiting') m.knocked = true;
        // "Can't join" after the waiting room: the request was turned down. Without one: Google turned the guest away.
        // Removed from the waiting room (Zoom): turned down too.
        if (s === 'denied' || s === 'removed' || (s === 'refused' && m.knocked)) return this.finish(m, 'denied', 'the request to join was denied');
        if (outcome(m, s)) return this.finish(m, ...outcome(m, s));
        if (this.now() > until) return this.finish(m, 'not-admitted', `not admitted within ${Math.round(m.maxWaitMs / 60_000)} min`);
      }
    }
    transition(m, 'admitted');
    m.admittedAt = this.now();
    m.joined.resolve();
    // Consent first: the chat hears about the recording before it starts. The chat is watched in every announce mode.
    await this.page(m, async (p) => {
      if (platform.afterAdmit) await platform.afterAdmit(p); // Zoom: computer audio joined, mic and camera off
      m.participants = await platform.participants(p);
      if (m.participants > 1) m.othersSeen = true; // someone else was here: leaving after alone_leave_sec once they go
      // A chat that won't open (turned off by the host) is no reason to leave; the announcement then says why it failed.
      await platform.openChat(p).catch((e) => { m.chatError = oneLine(e); });
      await platform.watchChat(p, m.chatKey);
    });
    await this.announce(m);
    if (m.state === 'ended' || signal.aborted) return;
    await this.pollChat(m); // an objection that arrived meanwhile counts before anything is recorded
    if (m.state === 'ended' || signal.aborted) return;
    if (!m.optedOut && !m.noRecord) { this.startRecording(m); this.startTranscript(m); }
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
      // The recorder died on its own (ffmpeg error): the meeting goes on without recording, and without the live
      // transcript, which only runs with the recording (the text so far is kept, like the file).
      m.recMs += this.now() - m.rec.startedAt;
      m.recError = m.rec.error() || 'recorder exited';
      m.rec = null;
      transition(m, 'admitted');
      this.stopTranscript(m, 'recording-failed').catch(() => {});
    });
  }

  // The live transcript, once the recording may start (same consent), for a meeting that asked for it.
  startTranscript(m) {
    if (!m.live || m.transcript || m.noRecord || m.optedOut || m.state === 'ended') return;
    if (!m.rig.capture) { m.transcriptError = 'this audio backend cannot capture the meeting audio'; return; }
    m.transcript = new LiveTranscript({
      apiKey: this.cfg.elevenlabs.apiKey, baseUrl: this.cfg.elevenlabs.baseUrl, source: m.rig.capture(), tenant: m.tenant, usage: this.usage,
      partials: m.partials, now: this.now,
      on: {
        partial: (seg) => this.emitLive(m, 'transcript', seg),
        final: (seg) => this.emitLive(m, 'transcript', seg),
        // Not when the meeting ends (bosun:meeting-ended says that) or Bosun shuts down.
        stopped: ({ reason, error }) => { if (reason !== 'ended') this.emit(m, 'transcript-stopped', { reason, ...(error ? { error } : {}), minutes: m.transcript?.status().streamed_min ?? 0 }); },
      },
    }).start();
  }

  // Stops the live transcript (the recording's opt-out, stop and deletion stop it too); clear: forget its text.
  async stopTranscript(m, reason, { clear = false } = {}) {
    const t = m.transcript;
    if (!t) return false;
    const was = t.state !== 'stopped';
    const stopping = t.stop(reason, null, { discard: clear }); // takes no more text at once
    if (clear) t.clear(); // gone before the capture has ended
    await stopping;
    return was;
  }

  // Transcript segments go to the connections there are now, never into the queue for later (meeting_transcript has them).
  emitLive(m, kind, data) {
    Promise.resolve().then(() => this.bus?.meetingLive?.(kind, { tenant: m.tenant, meeting_id: m.id, platform: m.platform.name, ...data })).catch(() => {});
  }

  async tick(m) {
    const s = await this.page(m, (p) => m.platform.state(p, { admitted: true }));
    if (s === 'ended' || s === 'removed') {
      // An objection already in the chat counts before the recording is kept: the page usually still holds it.
      await this.pollChat(m).catch(() => {});
      if (m.state === 'ended') return;
      return this.finish(m, s === 'ended' ? 'meeting-ended' : 'removed');
    }
    await this.pollChat(m);
    if (m.state === 'ended') return;
    const n = await this.page(m, (p) => m.platform.participants(p));
    m.participants = n;
    if (n !== null && n <= 1) {
      // Everyone else left: leave soon (aloneLeaveMs). Nobody else has been here yet: wait longer for them (aloneMs).
      m.aloneSince ??= this.now();
      if (this.now() - m.aloneSince > (m.othersSeen ? m.aloneLeaveMs : this.aloneMs)) return this.finish(m, 'alone');
    } else {
      m.aloneSince = null;
      if (n !== null && n > 1) m.othersSeen = true;
    }
  }

  // The announcement, by mode: 'chat' to everyone, or to the host where the chat can't reach everyone; 'host' to the
  // host only; 'none' to nobody (the caller answers for it). Recording goes ahead whatever came of it: m.announced says
  // where it went (sent_to everyone | host | none | failed) and why not further (failures: [{to, reason, error}]), and
  // an outcome short of the mode asked for is a bosun:meeting-announce event. Later posts (meeting_chat_send, the
  // opt-out confirmation) go where the announcement went.
  async announce(m) {
    try { await this.sendAnnouncement(m); } finally { m.announceDone.resolve(); }
  }

  async sendAnnouncement(m) {
    const a = m.announced;
    if (m.announceMode === 'none') { a.sent_to = 'none'; return; }
    const targets = m.announceMode === 'host' ? ['host'] : ['everyone', 'host'];
    for (const to of targets) {
      try {
        await this.page(m, async (p) => { for (const t of m.announce) await this.say(m, p, t, { to }); });
        a.sent_to = m.chatTo = to;
        break;
      } catch (e) {
        if (m.state === 'ended' || m.ac.signal.aborted) return;
        a.failures.push({ to, reason: e?.code || 'send-failed', error: oneLine(e) });
      }
    }
    a.sent_to ??= 'failed';
    if (a.sent_to !== targets[0]) {
      const first = a.failures[0];
      this.emit(m, 'announce', { mode: m.announceMode, sent_to: a.sent_to, reason: first.reason, error: first.error, failures: a.failures });
    }
  }

  // Posts in the chat (to: everyone, or the host) and remembers it, so the copy that shows up in the chat panel is
  // recognized as ours.
  async say(m, page, text, { to = m.chatTo } = {}) {
    const e = m.echoes.get(text.trim()) || { count: 0, until: 0, norm: normalize(text) };
    m.echoes.set(text.trim(), { ...e, count: e.count + 1, until: this.now() + ECHO_MS }); // see withoutOwn
    m.pendingOwn.push(text.trim());
    if (m.pendingOwn.length > 50) m.pendingOwn.shift();
    await m.platform.sendChat(page, text, { selfName: m.info.selfName || m.name, to });
    m.chatError = null; // the chat works after all
  }

  // What is left of a message once Bosun's own posts are taken out of it (live Meet shows our messages with no sender,
  // inside UI text, and may render one twice: as sent, then again under a new id once confirmed). Only for a message
  // without a participant's name on it: a named participant's message is always judged whole.
  // - A whole-message copy of a post is ours within ECHO_MS of posting, however often the panel renders it, and at any
  //   time if the post is long (ECHO_LONG).
  // - Inside a larger message, only a long post (ECHO_LONG) is taken out, as whole words and only as often as Bosun
  //   posted it; every copy recognised as ours, by either ledger, uses one up. A short post ("recording", "No") is
  //   ours only as a whole copy, so it never takes words out of someone's "please stop recording"; the same short
  //   words written by someone later are heard.
  // Taking out, not dropping: a message that pastes our announcement and adds "please stop recording" keeps it.
  withoutOwn(m, text) {
    const whole = normalize(text);
    for (const e of m.echoes.values()) {
      if (e.norm === whole && (this.now() <= e.until || e.norm.length >= ECHO_LONG)) { this.retire(m, e); return ''; }
    }
    const flat = (t) => String(t).replace(/[‘’ʼ]/g, "'").replace(/[“”„]/g, '"');
    let rest = flat(text);
    for (const [sent, e] of [...m.echoes].sort((a, b) => b[0].length - a[0].length)) {
      if (e.count <= 0 || e.norm.length < ECHO_LONG) continue;
      const words = flat(sent).trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (!words.length) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
      while (e.count > 0 && re.test(rest)) { rest = rest.replace(re, ' '); this.retire(m, e); }
    }
    return rest;
  }

  // One of Bosun's posts was seen: both ledgers (echoes, and pendingOwn for copies labelled as ours) let it go once.
  retire(m, e) {
    e.count = Math.max(0, e.count - 1);
    const i = m.pendingOwn.findIndex((t) => normalize(t) === e.norm);
    if (i >= 0) m.pendingOwn.splice(i, 1);
  }

  // Ours only if we just sent exactly this text AND the chat shows it as from us; each sent message matches once.
  // A participant named "You" or after the bot, or repeating something the bot said, is not taken for the bot.
  own(m, msg) {
    const sender = (msg.sender || '').trim(), text = (msg.text || '').trim();
    if (!(SELF_SENDERS.test(sender) || sender === m.name || (m.info.selfName && sender === m.info.selfName))) return false;
    const i = m.pendingOwn.indexOf(text);
    if (i < 0) return false;
    m.pendingOwn.splice(i, 1);
    const e = m.echoes?.get(text); // the same post can't be taken out of a later senderless message as well
    if (e) e.count = Math.max(0, e.count - 1);
    return true;
  }

  async pollChat(m) {
    let msgs = await this.page(m, (p) => m.platform.drainChat(p, m.chatKey));
    if (msgs === null) { // the page was replaced (Meet re-rendered): watch again
      await this.page(m, (p) => m.platform.watchChat(p, m.chatKey));
      msgs = [];
    }
    for (const raw of msgs) {
      // The bubble's text and sender without the UI around them (times, pin control).
      const msg = { ...raw, text: cleanChatText(raw.text), sender: cleanSender(raw.sender) };
      if (!msg.text || m.chatTexts.get(msg.id) === msg.text) continue;
      const edited = m.chatTexts.has(msg.id); // the panel filled in or changed a message after it first appeared
      m.chatTexts.set(msg.id, msg.text);
      if (m.chatTexts.size > 2 * MAX_CHAT) m.chatTexts.delete(m.chatTexts.keys().next().value);
      if (!edited && this.own(m, msg)) continue;
      // A participant's own name on it: theirs, judged whole. Otherwise only what is not Bosun's own words; nothing
      // left means it was our own message (no event, never an objection).
      const named = !!msg.sender && !SELF_SENDERS.test(msg.sender) && msg.sender !== m.name && msg.sender !== m.info.selfName;
      const rest = named ? msg.text : this.withoutOwn(m, msg.text);
      if (!normalize(rest)) continue;
      const entry = { seq: ++m.chatSeq, at: new Date(this.now()).toISOString(), sender: msg.sender || null, text: msg.text, ...(edited ? { edited: true } : {}) };
      m.chat.push(entry);
      if (m.chat.length > MAX_CHAT) m.chat.shift();
      this.emit(m, 'chat', { sender: entry.sender, text: entry.text, ...(edited ? { edited: true } : {}) });
      if (!m.optedOut && matchOptOut(rest)) await this.optOut(m, entry);
      if (m.state === 'ended') return;
    }
  }

  // Someone asked not to be recorded: stop, delete, confirm in the chat, tell the agent, leave (or stay, unrecorded).
  async optOut(m, msg) {
    m.optedOut = { sender: msg.sender, text: msg.text, at: msg.at };
    m.noRecord = true;
    // Both at once: the recording (stopped, deleted) and the live transcript (stopped, its text forgotten).
    const [, live] = await Promise.all([this.stopRecording(m, { del: true }), this.stopTranscript(m, 'opted-out', { clear: true })]);
    await this.page(m, (p) => this.say(m, p, live || m.live ? CONFIRM_DELETED_LIVE : CONFIRM_DELETED)).catch(() => {});
    this.emit(m, 'optout', { sender: msg.sender, text: msg.text, left: m.leaveOnOptOut });
    if (m.leaveOnOptOut) await this.finish(m, 'opted-out');
  }

  // A graceful stop still in progress (m.stopping) is escalated to a kill when a deletion comes in meanwhile.
  async stopRecording(m, { del = true } = {}) {
    const rec = m.rec || m.stopping;
    if (m.rec) {
      m.rec = null;
      m.recMs += this.now() - rec.startedAt;
      if (m.state === 'recording') transition(m, 'admitted');
    }
    if (rec) {
      m.stopping = rec;
      try { await (del ? rec.kill() : rec.stop()); } finally { if (m.stopping === rec) m.stopping = null; }
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
      if (error) m.error = typeof error === 'string' ? error : oneLine(error);
      const wasIn = !!m.admittedAt;
      if (m.state !== 'ended') m.state = 'ended';
      m.endedAt = this.now();
      m.ac.abort();
      m.joined.resolve();
      m.announceDone.resolve();
      const rec = m.rec;
      await Promise.all([
        (async () => {
          if (rec) { m.rec = null; m.recMs += this.now() - rec.startedAt; m.stopping = rec; await rec.stop().catch(() => {}); }
          else if (m.stopping) await m.stopping.stop().catch(() => {});
        })(),
        this.stopTranscript(m, 'ended').catch(() => {}),
        this.endSpeech(m).catch(() => {}),
      ]);
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
      meeting_id: m.id, platform: m.platform.name, url: m.url, state: m.state, ...(m.info.joinedAs ? { joined_as: m.info.joinedAs } : {}),
      ...(m.info.warning ? { warning: m.info.warning } : {}),
      ...(m.reason ? { reason: m.reason } : {}), ...(m.error ? { error: m.error } : {}),
      participants: m.participants, recording_seconds: Math.round(recMs / 1000),
      recording: m.file ? { path: m.file, bytes } : m.deleted ? 'deleted' : null,
      ...(m.recError ? { recording_error: m.recError } : {}),
      ...(m.optedOut ? { opted_out: { sender: m.optedOut.sender, at: m.optedOut.at } } : {}),
      announce: { mode: m.announceMode, sent_to: m.announced.sent_to, ...(m.announced.failures.length ? { reason: m.announced.failures[0].reason, failures: m.announced.failures } : {}) },
      ...(m.chatError ? { chat_error: m.chatError } : {}),
      ...(m.live ? { live_transcript: m.transcript ? m.transcript.status() : { state: m.transcriptError ? 'unavailable' : m.state === 'ended' || m.noRecord ? 'off' : 'not-started', ...(m.transcriptError ? { error: m.transcriptError } : {}) } } : {}),
      ...(m.speech ? { speaking: { utterance_id: m.speech.id, state: m.speech.state, ...(m.speech.seconds ? { duration_s: m.speech.seconds } : {}) } } : {}),
      ...(m.muteError && m.state !== 'ended' ? { mute_error: `the microphone may still be on: ${m.muteError}` } : {}),
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
    await m.announceDone.p; // where the announcement went decides where this goes
    if (m.state === 'ended') throw new Error(`meeting ${id} is ended`);
    await this.page(m, (p) => this.say(m, p, text));
    return { sent: true };
  }

  // Also before recording has started: the meeting then never records. The live transcript stops with it (its text is
  // forgotten too when the recording is deleted).
  async stopRecordingTool(tenant, id, del = true) {
    const m = this.get(tenant, id);
    m.noRecord = true;
    const live = await this.stopTranscript(m, 'stopped', { clear: del });
    if (!m.rec && !m.stopping && !(del && m.file)) return { stopped: false, deleted: false, recording_disabled: true, ...(m.live ? { live_transcript_stopped: live } : {}), state: m.state };
    const r = await this.stopRecording(m, { del });
    return { ...r, recording_disabled: true, ...(m.live ? { live_transcript_stopped: live } : {}), state: m.state };
  }

  // Finals of the live transcript so far (seq > since).
  transcript(tenant, id, since = 0) {
    const m = this.get(tenant, id);
    if (!m.live) throw new Error(`meeting ${id} has no live transcript (meeting_join with live_transcript: true)`);
    return { meeting_id: id, state: m.state, live_transcript: this.view(m).live_transcript, segments: m.transcript ? m.transcript.since(since) : [] };
  }

  inCall(m, what) {
    if (m.state !== 'admitted' && m.state !== 'recording') throw new Error(`meeting ${m.id} is ${m.state}; ${what} is possible once admitted`);
  }

  // Plays text (synthesized: supertonic, or elevenlabs) or an uploaded audio file into the meeting's microphone. The
  // microphone is unmuted for it and muted again after (autoMute; a microphone that was on stays on). Text is
  // synthesized a sentence at a time: the first one plays as soon as it is there, the rest is added while it plays.
  // Returns once all of it is synthesized (wait: once it has played). A second utterance while one plays is refused
  // unless interrupt.
  async speak(tenant, id, { text, audioFileId, voice, lang, backend = 'supertonic', autoMute = true, interrupt = false, wait = false }) {
    const m = this.get(tenant, id);
    this.inCall(m, 'speaking');
    await m.announceDone.p; // nothing is said before the announcement went out
    this.inCall(m, 'speaking');
    if (!m.rig?.play) throw new Error('this audio backend cannot play into the meeting');
    if (!text === !audioFileId) throw new Error('pass text or audio_file_id (one of them)');
    const prev = m.speech;
    if (prev && !interrupt) throw new Error(`already speaking (utterance ${prev.id}); meeting_stop_speaking first, or pass interrupt: true`);
    const t0 = this.now();
    const u = { id: `u${++m.speechSeq}`, state: 'preparing', player: null, autoMute, cancelled: false, seconds: 0, t0: this.now() };
    u.finished = new Promise((r) => { u.finish = r; });
    m.speech = u;
    // The previous utterance stops without muting: this one takes the microphone over (m.speechUnmuted: whether
    // speaking turned it on, so that the last utterance mutes it again).
    if (prev) { prev.cancelled = true; await prev.player?.stop(); }
    if (!autoMute) m.speechUnmuted = false; // the agent handles the microphone itself now
    const pieces = text ? splitSpeech(text) : null;
    const first = (async () => {
      if (text) return synthesizeWav(this.cfg, { text: pieces[0], backend, voice, lang });
      const f = this.manager.uploads?.use(tenant, [audioFileId], m.session.id)[0];
      if (!f) throw new Error('uploads are off on this Bosun (FEATURES_UPLOADS=0)');
      const format = audioFormat(f.file);
      if (!format) throw new Error(`file ${audioFileId} is not WAV, Ogg, FLAC, MP3, M4A or WebM audio`);
      const seconds = await probeSeconds(f.file, format);
      if (seconds === null) throw new Error(`file ${audioFileId} is not audio ffmpeg can read`);
      return { file: f.file, format, seconds };
    })();
    // The microphone goes on while the first audio is prepared.
    // Speaking owns the unmute when it clicked the microphone on (also when the click half-worked: it is muted again). An
    // utterance that ended meanwhile (stopped) mutes again here what it turned on, unless another one speaks now.
    const mic = autoMute ? this.page(m, async (p) => {
      if (u.ending) return;
      let r;
      // A click that turned it on (also one whose check then failed) is owned by this utterance while it is the one
      // speaking, or handed to the one that took over if that one mutes after itself; otherwise (stopped meanwhile, or
      // taken over by one that leaves the microphone alone) it is muted again right here.
      const own = async () => {
        m.speechUnmuted = true;
        if ((m.speech === u && !u.ending) || (m.speech && m.speech !== u && m.speech.autoMute)) return;
        if (!m.speech) await this.muteAgain(m, p); // its result is out already: meeting_status shows a failure
        else m.speechUnmuted = false; // the one speaking now handles the microphone itself (auto_mute false)
      };
      try { r = await m.platform.setMic(p, true); } catch (e) { if (e.clicked) await own(); throw e; }
      if (r.changed) await own();
    }) : Promise.resolve(null);
    const [a, b] = await Promise.allSettled([first, mic]);
    const prepMs = this.now() - t0;
    const fail = a.status === 'rejected' ? a.reason : b.status === 'rejected' ? b.reason : u.cancelled || m.speech !== u ? new Error('stopped before it played')
      : m.state !== 'admitted' && m.state !== 'recording' ? new Error(`meeting ${m.id} is ${m.state}`) : null;
    if (fail) {
      const r = await this.endUtterance(m, u, u.cancelled ? 'interrupted' : 'failed', fail, { t0 });
      if (u.cancelled) return r;
      throw new Error(`nothing was said: ${oneLine(fail)}`);
    }
    const head = a.value;
    u.player = m.rig.play(text ? { pcm: head.pcm } : { file: head.file, format: head.format });
    if (text) u.player.write(head.data);
    u.state = 'speaking';
    u.startedAt = this.now();
    u.seconds = head.seconds;
    u.player.done.then((ok) => this.endUtterance(m, u, u.cancelled ? 'interrupted' : ok ? 'done' : 'failed', ok || u.cancelled ? null : new Error(u.player.error() || 'playback failed'), { t0, tail: ok }));
    // The rest, synthesized while the first piece plays (in the voice the first one got).
    let error = null;
    if (text) {
      for (const piece of pieces.slice(1)) {
        if (u.cancelled || u.state !== 'speaking') break;
        const w = await synthesizeWav(this.cfg, { text: piece, backend, voice: head.voice ?? voice, lang }).catch((e) => { error = e; return null; });
        if (!w || u.cancelled || u.state !== 'speaking') break;
        if (w.pcm.rate !== head.pcm.rate || w.pcm.channels !== head.pcm.channels) { error = new Error(`${backend} changed its audio format mid-text`); break; }
        u.player.write(w.data);
        u.seconds += w.seconds;
      }
      u.player.end();
    }
    // Playback that doesn't end when it should (ffmpeg stuck) is cut off, and the microphone muted again. Counted from
    // now, when all of it is written: waiting for the synthesis paused the audio, so what played so far isn't known.
    if (!u.ending) {
      u.watchdog = setTimeout(() => { if (!u.ending) { u.cancelled = true; u.player.stop(); this.endUtterance(m, u, 'failed', new Error('playback did not end in time')); } },
        u.seconds * 1000 + this.speechGraceMs);
      u.watchdog.unref?.();
    }
    const started = {
      meeting_id: m.id, utterance_id: u.id, speaking: u.state === 'speaking', duration_s: Math.round(u.seconds * 100) / 100, source: text ? backend : 'file',
      ...(head.voice ? { voice: head.voice } : {}), ...(text ? { pieces: pieces.length } : {}),
      prepare_ms: prepMs, start_ms: u.startedAt - t0, ...(text ? { synth_ms: this.now() - t0 } : {}), unmuted: !!m.speechUnmuted,
      ...(error ? { error: `cut short, the rest could not be synthesized: ${oneLine(error)}` } : {}),
    };
    if (!wait) return started;
    const end = await Promise.race([u.finished, sleep((u.seconds + 30) * 1000).then(() => null)]);
    return end ? { ...started, ...end, speaking: false } : { ...started, error: 'still not over 30 s after it should have ended' };
  }

  // An utterance is over (played, interrupted, failed): the microphone is muted again if speaking turned it on, and
  // bosun:meeting-speech says how it ended.
  async endUtterance(m, u, state, error, { t0 = u.t0, tail = false } = {}) {
    if (u.ending) return u.finished;
    u.ending = true;
    clearTimeout(u.watchdog);
    if (tail) await sleep(SPEECH_TAIL_MS);
    u.state = state;
    if (m.speech === u) m.speech = null;
    // The last utterance mutes again what speaking turned on; one followed by another (interrupt) leaves it to that one.
    let muteError = null;
    if (u.autoMute && m.speechUnmuted && !m.speech && (m.state === 'admitted' || m.state === 'recording')) {
      const tried = this.page(m, (p) => this.muteAgain(m, p)).catch((e) => oneLine(e));
      muteError = await Promise.race([tried, sleep(30_000).then(() => 'muting again took longer than 30 s')]);
      if (muteError) m.muteError = muteError;
    }
    const played = u.startedAt ? Math.round((this.now() - u.startedAt) / 10) / 100 : 0;
    const r = {
      utterance_id: u.id, state, played_s: Math.min(played, Math.round(u.seconds * 100) / 100 || played), ...(error ? { error: oneLine(error) } : {}),
      ...(muteError ? { mute_error: `the microphone may still be on: ${muteError}` } : {}), total_ms: this.now() - t0,
    };
    if (u.startedAt) this.emit(m, 'speech', r);
    u.finish(r);
    return r;
  }

  // Mutes again what speaking turned on, inside a page operation: up to three tries. One that fails keeps it owned (the
  // next utterance tries again) and is reported (m.muteError, meeting_status). Returns the error or null.
  async muteAgain(m, p) {
    let err = null;
    for (let i = 0; i < 3; i++) {
      if (i) await p.waitForTimeout(500).catch(() => {});
      if (m.speech || (m.state !== 'admitted' && m.state !== 'recording')) return null;
      err = await m.platform.setMic(p, false).then(() => null, (e) => oneLine(e));
      if (!err) break;
    }
    if (!err) m.speechUnmuted = false;
    m.muteError = err;
    return err;
  }

  // Barge-in: the utterance playing now stops at once (and the microphone is muted again, if speaking turned it on).
  async stopSpeaking(tenant, id) {
    const m = this.get(tenant, id);
    const u = m.speech;
    if (!u) return { meeting_id: id, stopped: false };
    u.cancelled = true;
    await u.player?.stop();
    // Ended here too, should the player never report its end; the answer waits for the microphone at most 12 s.
    this.endUtterance(m, u, 'interrupted', null);
    const r = await Promise.race([u.finished, sleep(12_000).then(() => ({ utterance_id: u.id, state: 'interrupted', error: 'the microphone was still being muted' }))]);
    return { meeting_id: id, stopped: true, ...r };
  }

  async endSpeech(m) {
    const u = m.speech;
    if (!u) return;
    u.cancelled = true;
    m.speechUnmuted = false; // the meeting is ending
    await u.player?.stop();
  }

  // on: true mutes, false unmutes. Muting while an utterance plays cuts it off for the meeting (it keeps playing into a
  // muted microphone) and keeps the microphone muted after.
  async mute(tenant, id, on) {
    const m = this.get(tenant, id);
    this.inCall(m, on ? 'muting' : 'unmuting');
    await m.announceDone.p;
    this.inCall(m, on ? 'muting' : 'unmuting');
    const r = await this.page(m, (p) => m.platform.setMic(p, !on));
    m.speechUnmuted = false; // the agent decides now: speaking leaves the microphone as it is
    m.muteError = null;
    return { meeting_id: id, muted: r.state === 'off' };
  }

  async raiseHand(tenant, id, on) {
    const m = this.get(tenant, id);
    this.inCall(m, 'raising a hand');
    const r = await this.page(m, (p) => m.platform.setHand(p, on));
    return { meeting_id: id, hand_raised: r.state === 'on' };
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
    if (m && m.state !== 'ended') m.noRecord = true; // a meeting not recording yet never starts (nor its transcript)
    if (m) await this.stopTranscript(m, 'stopped', { clear: true }); // the transcript goes with the recording
    if (m && (m.rec || m.stopping)) { m.noRecord = true; return { ...(await this.stopRecording(m, { del: true })), meeting_id: id }; }
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
    // A dry run still loading a page is cut short by closing its session; its audio server goes in its own cleanup,
    // or here, if the dry run is still stuck in setup (a browser launch) when the wait is over.
    for (const d of this.dryRuns) if (d.session) this.manager.dispose(d.session, 'shutdown').catch(() => {});
    await Promise.race([Promise.allSettled([...[...this.active.values()].map((m) => this.finish(m, 'shutdown')), ...[...this.dryRuns].map((d) => d.task)]), sleep(15_000)]);
    await Promise.race([Promise.allSettled([...this.dryRuns].map((d) => (d.closing ??= d.rig?.close()))), sleep(5_000)]);
  }
}
