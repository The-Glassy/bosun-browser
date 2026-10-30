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
import { httpUrl } from '../sessions.mjs';
import { readProfileMeta } from '../engines.mjs';
import { TENANT_RE } from '../auth.mjs';
import { matchOptOut, normalize } from './optout.mjs';
import { cleanChatText, cleanSender } from './platforms/common.mjs';
import { meet } from './platforms/meet.mjs';
import { zoom } from './platforms/zoom.mjs';
import { pulseAudio } from './audio.mjs';
import { LiveTranscript, TranscriptUsage, nodeDebugOn, NODE_DEBUG_REFUSED } from './transcript.mjs';
import { synthesizeWav, splitSpeech, takeSentences, probeSeconds, audioFormat } from './speech.mjs';
import { SpeechSettings, SETTINGS, PER_CALL } from './settings.mjs';
import { CHANNEL_PREFIX } from '../events.mjs';
import { RecordingLinks } from './recording-links.mjs';

export const ID_RE = /^m[0-9a-f]{12}$/;
const ORPHAN_QUIET_MS = 60_000; // a file of an earlier run changed this recently may still be growing
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
// Muting again after an utterance: how long its end waits for it; a microphone still on then is tried again every
// MUTE_RETRY_MS, MUTE_RETRIES times more.
const MUTE_WAIT_MS = 20_000;
const MUTE_RETRY_MS = 5000;
const MUTE_RETRIES = 6;
const STREAM_IDLE_MS = 300; // an utterance from the channel waits this long after its audio for more text
const SPEAKER_POLL_MS = 500; // who the page shows as speaking is read this often (the page logs changes every 200 ms)
const SPEAKER_LOG_MS = 600_000; // and kept this long
const PREPARED_MS = 60_000; // a sentence synthesized ahead from chunks is kept this long for its publish
const PREPARED_MAX = 20; // and this many at most per meeting (synthesized or still synthesizing)
const PREPARE_SENTENCE_MAX = 400; // a longer sentence is not synthesized ahead (its publish synthesizes it)
const PUBLISH_MAX = 2000; // characters in one publish to the channel (as meeting_speak's text)
const CHANNEL_BACKLOG = 6000; // characters from the channel waiting to be synthesized, at most
const CHANNEL_AHEAD_S = 120; // and seconds of its audio written but not played yet
const CHUNK_BUF_MAX = 2000; // characters of an open chunk sentence kept
const ACK_CACHE = 64; // acknowledgement clips kept (per voice and phrase)
const ACK_RETRY_MS = 60_000; // a clip that could not be synthesized is tried again after this
const TURN_END = /[.!?…]["'”»)]*$/u; // a final ending like this ends someone's turn
const TURN_QUESTION = /\?["'”»)]*$/u;
const TRAILING_OFF = /(?:…|\.\.\.)["'”»)]*$/u;
// A final ending in one of these words ends no sentence, whatever its full stop ("... and.", "... що."): held turn_hold_ms.
const TRAILING_WORD = /(?:^|[\s,])(?:and|or|but|so|because|the|a|an|to|of|for|with|that|if|when|then|i|і|й|та|а|але|що|бо|чи|и|но|что|или|und|oder|aber|weil|dass|der|die|das|ale|že|lebo|alebo|aj)\s*[.!]*["'”»)]*$/iu;
const TURN_PARTIAL_WAIT_MS = 2500; // new speech in a held turn (partials) whose final doesn't come: the turn goes this long after the pause (vad_silence_s)
const TURN_MAX_MS = 30_000; // a turn held this long since its first final goes at the next final, however much more comes
const STALE_HEARD_MS = 5000; // speech heard this long ago that never became a turn (Scribe committed nothing) supersedes nothing
const SAID_ECHO_MS = 8000; // what Bosun said counts as its own voice coming back this long after it ended
const ECHO_SHARE = 0.6; // text that is at least this share words Bosun is saying (or just said) is its own voice
const LABEL_FRESH_MS = 120_000; // speaker labels count as working this long after the page last named someone
// Words that never count towards barge_in_min_words (someone agreeing while Bosun speaks is no interruption).
const BACKCHANNEL = new Set(['mhm', 'mhmm', 'mm', 'hm', 'hmm', 'uh', 'huh', 'um', 'yeah', 'yes', 'yep', 'ok', 'okay', 'right', 'sure', 'ага', 'угу', 'так', 'да', 'ну', 'ja', 'jo', 'genau', 'áno', 'hej']);
const words = (text) => normalize(text || '').split(' ').filter(Boolean);
const DRAFT_SENTENCE_MAX = 400; // a drafted first sentence longer than this is refused (it would not be quick to say)
const DRAFT_SAID_MS = 120_000; // a publish this long after a drafted sentence was said is no longer checked for it
// Words that, added by the final after a draft was marked ready, may turn the meaning around ("... but not today"):
// the draft is not said, however few words came.
const MEANING_FLIP = new Set(['not', 'no', 'never', 'dont', "don't", 'doesnt', "doesn't", 'didnt', "didn't", 'cant', "can't", 'wont', "won't", 'isnt', "isn't", 'arent', "aren't",
  'but', 'however', 'except', 'unless', 'instead', 'nicht', 'kein', 'keine', 'keinen', 'nie', 'niemals', 'nein', 'aber', 'sondern', 'außer',
  'не', 'ні', 'нет', 'ніколи', 'никогда', 'але', 'но', 'однак', 'однако', 'ale', 'však', 'okrem', 'nikdy']);
const SPEC_MATCH_MS = 10_000; // a publish this long after its speculative stream's last chunk or complete is matched by its text
const SPEC_STREAMS = 8; // speculative streams kept per meeting
const SPEC_EARLY_MAX = 200; // chunks that came ahead of a missing one, kept per stream

// The sentences of a text: as takeSentences cuts them, the open rest as the last one.
export function sentencesOf(text) {
  const { done, rest } = takeSentences(String(text || ''));
  return rest.trim() ? [...done, rest.trim()] : done;
}

// Where `text` goes on after a prefix that says the same words as `prefix` (case, punctuation and spacing aside): the
// index after it (and the space after it), or -1 when text doesn't start with those words. An empty prefix: 0.
export function afterPrefix(text, prefix) {
  const want = normalize(prefix || '');
  if (!want) return 0;
  const t = String(text || '');
  for (const mt of t.matchAll(/\S+/g)) {
    const end = mt.index + mt[0].length, n = normalize(t.slice(0, end));
    if (n === want) return end + (/^\s*/.exec(t.slice(end))[0].length);
    if (n && !want.startsWith(n)) return -1;
  }
  return -1;
}

// The words of `after` left over once it is lined up with `before` (longest common subsequence, in order): what the
// final added to (or changed in) what had been heard.
export function addedWords(before, after) {
  const a = before, b = after;
  if (!a.length) return [...b];
  if (a.length * b.length > 250_000) return [...b];
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) { i++; j++; } else if (i < a.length && L[i + 1][j] >= L[i][j + 1]) i++; else out.push(b[j++]);
  }
  return out;
}

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
    // Speech settings per tenant (speech_settings_get/set): what a call leaves out.
    this.settings = new SpeechSettings(cfg);
    this.ackCache = new Map(); // acknowledgement clips: JSON [tts, phrase] -> {text, clip, error, failedAt}
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.links = new RecordingLinks({ cfg, resolve: (tenant, id) => this.recordingFile(tenant, id).file });
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), 3_600_000);
    this.sweeper.unref();
  }

  sweep() {
    this.links.sweep();
    const keep = new Set([...this.active.values()].filter((m) => m.rec).map((m) => m.file));
    const removed = sweepRecordings(this.dir, this.cfg.recordingRetentionDays, { now: this.now(), keep });
    // A URL out for a recording the retention just deleted is dead too, and so is a transfer of it under way.
    for (const p of removed) this.links.revoke(path.basename(path.dirname(p)), path.basename(p, '.ogg'));
    return removed;
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
    liveTranscript = false, transcriptPartials = true, vadSilenceS, settings: perCall = {} }) {
    if (!ANNOUNCE_MODES.includes(announce)) throw new Error(`announce must be one of ${ANNOUNCE_MODES.join(', ')}`);
    // Speech settings for this meeting only (PER_CALL), over the tenant's.
    const overrides = {};
    for (const [k, v] of Object.entries(perCall || {})) {
      if (v === undefined || v === null) continue;
      if (!PER_CALL.includes(k)) throw new Error(`${k} cannot be set per meeting`);
      const err = SETTINGS[k](v);
      if (err) throw new Error(err);
      overrides[k] = v;
    }
    if (vadSilenceS !== undefined && SETTINGS.vad_silence_s(vadSilenceS)) throw new Error(SETTINGS.vad_silence_s(vadSilenceS));
    vadSilenceS ??= this.settings.effective(tenant).values.vad_silence_s;
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
      live: liveTranscript, partials: transcriptPartials, vadSilenceS, transcript: null, speech: null, speechSeq: 0,
      announceMode: announce, announced: { sent_to: null, failures: [] }, chatTo: announce === 'host' ? 'host' : 'everyone', chatError: null,
      maxWaitMs: maxWaitAdmitMin * 60_000, state: 'joining', reason: null, error: null,
      createdAt: this.now(), admittedAt: null, endedAt: null, rig: null, session: null, rec: null, stopping: null, recMs: 0, file: null, deleted: false,
      info: {}, noRecord: false, chat: [], chatSeq: 0, chatTexts: new Map(), pendingOwn: [], echoes: new Map(), participants: null, aloneSince: null, optedOut: null, chatKey: `__b${crypto.randomBytes(8).toString('hex')}`,
      ac: new AbortController(), joined: deferred(), announceDone: deferred(), finishing: null,
      // Speaking from the meeting's MCPL channel, acknowledgements, who the page shows as speaking.
      channelId: null, channelOpen: false, channelQueue: Promise.resolve(), channelGen: 0, channelBacklog: 0, channelSaid: [], chunkStreams: new Map(), prepared: new Map(),
      channelMsgs: 0, speechFollows: 0, consentGen: 0,
      ackTimer: null, ackPlaying: null, lastAck: 0, lastAckText: null, acks: 0, lastSpokeAt: 0, partialSentAt: 0,
      speakerKey: `__s${crypto.randomBytes(8).toString('hex')}`, speakerLog: [], speakerTimer: null, speakersSeen: false, lastNamedAt: 0,
      // Turns: finals held for more of the same turn (turn_hold_ms), speech heard since the last turn went to the agent,
      // the open segment's text (what a barge-in counts from), what Bosun said lately (its own voice coming back).
      hold: null, lastHumanAt: 0, heardSeq: 0, lastTurnSeq: 0, partialNow: null, saidRecent: [], bargeIns: 0, interrupts: 0,
      // The last turn the agent was given ({seq, segs, speaker, at}), the newest turn it answered, turns reopened.
      lastTurn: null, answeredSeq: 0, extendedSeqs: new Set(), turnsExtended: 0, publishesDropped: 0,
      // meeting_draft: the agent's draft for the turn still being said, the drafted sentence said for a turn (a publish
      // starting with it skips it), when each segment was first heard. Speculative streams (speculative_speech).
      overrides, draft: null, draftSaid: null, firstHeard: new Map(), draftsSpoken: 0, draftsDropped: 0, specStreams: new Map(), specSpoken: 0, specCancelled: 0,
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
      if (platform.watchSpeakers) await platform.watchSpeakers(p, m.speakerKey, { self: [m.name, m.info.selfName].filter(Boolean) }).catch(() => {});
    });
    await this.announce(m);
    if (m.state === 'ended' || signal.aborted) return;
    this.pollSpeakers(m);
    this.openChannel(m);
    this.prepareAcks(m);
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
      partials: true, vadSilenceS: m.vadSilenceS, now: this.now,
      on: {
        // Never thrown into the transcript's socket or timers (that would end the process): the text is emitted as it was.
        partial: (seg) => { try { this.onPartial(m, seg); } catch (e) { console.error(`bosun meeting ${m.id}: partial: ${oneLine(e)}`); } },
        final: (seg) => { try { this.onFinal(m, seg); } catch (e) { console.error(`bosun meeting ${m.id}: final: ${oneLine(e)}`); this.emitLive(m, 'transcript', seg); } },
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
    if (clear) { t.clear(); m.consentGen++; } // gone before the capture has ended (and not sent later)
    await stopping;
    return was;
  }

  // Transcript segments go to the connections there are now, never into the queue for later (meeting_transcript has them).
  emitLive(m, kind, data) {
    Promise.resolve().then(() => this.bus?.meetingLive?.(kind, { tenant: m.tenant, meeting_id: m.id, platform: m.platform.name, ...data })).catch(() => {});
  }

  // The meeting's MCPL channel bosun:meeting:<id> (speech setting meeting_channel), once the announcement is out:
  // registered with the tenant's connections whose host grants channels. What the host publishes to it is spoken;
  // chunks are only synthesized ahead (channel_prepare_chunks). Closed at the end, and at an opt-out.
  openChannel(m) {
    if (!this.bus?.openChannel || m.channelId || m.optedOut || !this.settings.effective(m.tenant).values.meeting_channel) return;
    m.channelId = `${CHANNEL_PREFIX}${m.id}`;
    m.channelOpen = true;
    const label = `${m.platform.name === 'zoom' ? 'Zoom' : 'Google Meet'} meeting ${m.id}`;
    // speculative_speech: the channel takes text streamed while the agent still writes it (docs/STREAMING.md). Said in
    // the descriptor's capabilities, and the same in its metadata for hosts that keep only that.
    const streaming = this.opts(m).speculative_speech ? { streaming: { speculative: true } } : {};
    m.speculative = !!streaming.streaming;
    this.bus.openChannel(m.tenant, {
      id: m.channelId, type: 'bosun.meeting', label, direction: 'bidirectional', initiallyOpen: true,
      ...(m.speculative ? { capabilities: streaming } : {}),
      metadata: { meeting_id: m.id, platform: m.platform.name, url: m.url, ...streaming },
    }, {
      // Said all the same; superseded_by_new_speech: someone has spoken since the last turn the agent was given (a
      // segment after it heard: a turn still held, or still being said), so this may answer only part of it.
      // last_turn_seq: that turn's seq.
      // A publish answers the turn current when it came (or the turn_seq it names). That turn reopened since
      // (turn_extended): dropped with superseded_publish "drop" (delivered: false, so the host doesn't count it as said).
      // Text already said from a speculative stream of the same text (speculative) is not said again; a publish that
      // starts with the drafted sentence said for its turn (meeting_draft) skips it (draft_prefix_skipped).
      publish: (text, p) => {
        const named = [p?.turn_seq, p?.metadata?.turn_seq].find((x) => Number.isInteger(x) && x >= 0 && x <= m.lastTurnSeq);
        const turn = named ?? m.lastTurnSeq;
        const superseded = m.extendedSeqs.has(turn) || (m.heardSeq > m.lastTurnSeq && (!!m.hold || this.now() - m.lastHumanAt < STALE_HEARD_MS));
        const receipt = (r = {}) => ({ messageId: `${m.id}:out${++m.channelMsgs}`, superseded_by_new_speech: superseded, turn_seq: turn, last_turn_seq: m.lastTurnSeq, ...r });
        const spec = this.specPublish(m, text, p, turn);
        if (spec?.dropped) {
          this.inCall(m, 'speaking');
          m.publishesDropped++;
          return { delivered: false, dropped: true, reason: 'superseded_by_new_speech', superseded_by_new_speech: true, turn_seq: spec.turn, last_turn_seq: m.lastTurnSeq, speculative: true, stream_id: spec.stream_id };
        }
        if (spec) { this.inCall(m, 'speaking'); m.answeredSeq = Math.max(m.answeredSeq, turn); return receipt(spec); }
        if (m.extendedSeqs.has(turn) && this.settings.effective(m.tenant).values.superseded_publish === 'drop') {
          this.inCall(m, 'speaking');
          m.publishesDropped++;
          return { delivered: false, dropped: true, reason: 'superseded_by_new_speech', superseded_by_new_speech: true, turn_seq: turn, last_turn_seq: m.lastTurnSeq };
        }
        let say = text, draft = {};
        const ds = m.draftSaid;
        if (ds && ds.turnSeq === turn && this.now() - ds.at < DRAFT_SAID_MS) {
          const at = afterPrefix(text, ds.text);
          draft = { draft_prefix_skipped: at >= 0, draft_said: ds.text };
          if (at >= 0) say = String(text).slice(at);
        }
        this.sayOnChannel(m, say);
        if (ds && draft.draft_said) m.draftSaid = null; // checked once: the publish after it may repeat the words
        m.answeredSeq = Math.max(m.answeredSeq, turn);
        return receipt(draft);
      },
      chunk: (p) => this.onStream(m, p, false),
      complete: (p) => this.onStream(m, p, true),
    });
  }

  closeChannel(m) {
    if (!m.channelOpen) return;
    m.channelOpen = false;
    this.bus?.closeChannel?.(m.tenant, m.channelId);
  }

  // channels/outgoing/chunk and complete (channel_prepare_chunks): each sentence, once complete, is synthesized ahead
  // in the voice a publish would get, and kept PREPARED_MS for the publish that delivers it (MCPL §14.5: chunks are
  // never delivered themselves). Sentences of text published already are not synthesized again.
  onChunk(m, p, complete) {
    if (!this.settings.effective(m.tenant).values.channel_prepare_chunks || !m.channelOpen) return;
    const key = `${p?.inferenceId ?? ''}`;
    const st = m.chunkStreams.get(key) || { buf: '' };
    m.chunkStreams.set(key, st);
    if (m.chunkStreams.size > 20) m.chunkStreams.delete(m.chunkStreams.keys().next().value);
    const sentences = [];
    if (!complete) {
      st.buf += typeof p?.delta === 'string' ? p.delta : '';
      const { done, rest } = takeSentences(st.buf);
      sentences.push(...done);
      st.buf = rest.length > CHUNK_BUF_MAX ? '' : rest;
    } else {
      sentences.push(st.buf);
      m.chunkStreams.delete(key);
    }
    for (const t of sentences) this.prepare(m, t);
  }

  // What the host streams to the channel: speculative (speculative: true, while the agent still writes its publish;
  // spoken with speculative_speech) or not (MCPL §14.3: only synthesized ahead, with channel_prepare_chunks).
  onStream(m, p, complete) {
    if (p?.speculative === true && this.opts(m).speculative_speech) return complete ? this.specComplete(m, p) : this.specChunk(m, p);
    const delta = typeof p?.delta === 'string' ? p.delta : typeof p?.content === 'string' ? p.content : '';
    return this.onChunk(m, { ...p, delta, inferenceId: p?.inferenceId ?? p?.streamId }, complete);
  }

  // The settings that hold for this meeting: the tenant's, and what meeting_join set for it.
  opts(m) {
    const v = this.settings.effective(m.tenant).values;
    return m.overrides && Object.keys(m.overrides).length ? { ...v, ...m.overrides } : v;
  }

  // A speculative stream (docs/STREAMING.md): {id, turn it answers, buf (text not yet a sentence), next seq, early
  // (chunks ahead of a missing one), sent (sentences handed to speech; skipped: the drafted one, said already), nos
  // (each one's piece number in its utterance), u (that utterance), stopAt (sentences from here on not to be said),
  // state open | final | cancelled | interrupted | dropped, final text and when}.
  specStream(m, id) {
    let st = m.specStreams.get(id);
    if (st) return st;
    // Full: the oldest stream that has nothing being said and is no longer open (or open but silent for a minute)
    // makes room; a stream with speech under way is never forgotten (its cancel must still find it). None: refused.
    if (m.specStreams.size >= SPEC_STREAMS) {
      const busy = (x) => x.queued > 0 || (x.u && !x.u.ending && !x.u.cancelled) || (x.state === 'open' && this.now() - x.at < 60_000);
      const old = [...m.specStreams.values()].find((x) => !busy(x));
      if (!old) return null;
      m.specStreams.delete(old.id);
    }
    st = { id, turn: m.lastTurnSeq, gen: m.channelGen, at: this.now(), buf: '', next: 0, early: new Map(), sent: [], nos: [], u: null, stopAt: Infinity, state: 'open', final: null, finalNorm: null, finalAt: 0 };
    m.specStreams.set(id, st);
    return st;
  }

  // A stream that skipped the drafted sentence was published (or completed): the publish check for it is used up.
  useDraftSaid(m, st) {
    if (st.draftSkipped && m.draftSaid?.turnSeq === st.turn) m.draftSaid = null;
  }

  // The stream's turn was reopened since and superseded_publish is "drop": nothing more of it is said.
  specSuperseded(m, st) {
    return m.extendedSeqs.has(st.turn) && this.settings.effective(m.tenant).values.superseded_publish === 'drop';
  }

  // channels/outgoing/chunk {streamId, seq, content (the new text), speculative: true}: in seq order, each sentence
  // spoken as soon as it is complete, as a publish's would be (the same queue, voice and barge-in).
  specChunk(m, p) {
    if (!m.channelOpen || typeof p?.streamId !== 'string' || !p.streamId) return;
    const st = this.specStream(m, p.streamId.slice(0, 200));
    if (!st || st.state !== 'open') return;
    st.at = this.now();
    const delta = typeof p.content === 'string' ? p.content : typeof p.delta === 'string' ? p.delta : '';
    const seq = Number.isInteger(p.seq) ? p.seq : Number.isInteger(p.index) ? p.index : st.next;
    if (seq < st.next) return; // a chunk seen already
    if (seq > st.next) { if (st.early.size < SPEC_EARLY_MAX) st.early.set(seq, delta); return; } // one before it is missing yet
    st.buf += delta;
    st.next++;
    for (let d; (d = st.early.get(st.next)) !== undefined; st.next++) { st.early.delete(st.next); st.buf += d; }
    const { done, rest } = takeSentences(st.buf);
    st.buf = rest;
    // A sentence too long to wait for its end is said as far as it goes.
    if (st.buf.length > PREPARE_SENTENCE_MAX) { done.push(st.buf.trim()); st.buf = ''; }
    for (const t of done) if (t) this.specSay(m, st, t);
  }

  // One sentence of a speculative stream to speech. Not when the stream was stopped since it began (a barge-in,
  // meeting_stop_speaking, an opt-out: channelGen) or its turn was reopened (superseded_publish "drop"). The sentence
  // Bosun already said from the draft for that turn is not said again.
  specSay(m, st, text) {
    if (st.state !== 'open') return;
    if (st.gen !== m.channelGen) { st.state = 'interrupted'; return; }
    if (this.specSuperseded(m, st)) { st.state = 'dropped'; return; }
    const i = st.sent.length;
    const ds = m.draftSaid;
    if (i === 0 && ds && ds.turnSeq === st.turn && this.now() - ds.at < DRAFT_SAID_MS && normalize(text) === ds.norm) {
      st.sent.push(text);
      st.draftSkipped = true; // m.draftSaid stays until a publish (or complete) of the stream uses it up
      return;
    }
    // The queue is full: nothing more of the stream is said now, but it stays open, so its publish (or complete)
    // settles it against what was said and says the rest.
    if (st.paused) return;
    try {
      this.prepare(m, text);
      this.sayOnChannel(m, text, { whole: true, spec: { st, i } });
    } catch { st.paused = true; return; }
    st.sent.push(text);
    m.specSpoken++;
    m.answeredSeq = Math.max(m.answeredSeq, st.turn);
  }

  // channels/outgoing/complete of a speculative stream: cancelled (the publish was not made) stops what of it is being
  // said at once and drops the rest; the full text settles it (specSettle). A stream the publish settled already keeps
  // that (the publish is what counts).
  specComplete(m, p) {
    if (typeof p?.streamId !== 'string') return;
    const st = m.specStreams.get(p.streamId.slice(0, 200));
    if (!st) return;
    const text = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : '';
    if (p.cancelled === true || !text.trim()) {
      if (st.state === 'final' || st.state === 'cancelled') return; // a publish settled it: that counts
      st.state = 'cancelled';
      m.specCancelled++;
      this.specCut(m, st, 0, { stop: true }); // also what a stream dropped or interrupted half-way still has under way
      return;
    }
    if (st.state === 'final' && normalize(text) === st.finalNorm) return;
    if (st.state === 'open' && this.specSuperseded(m, st)) st.state = 'dropped';
    if (st.state === 'open' || st.state === 'final') {
      try { this.specSettle(m, st, text); this.useDraftSaid(m, st); } catch {}
    }
    else Object.assign(st, { final: text, finalNorm: normalize(text), finalAt: this.now() }); // a publish of it is not said either
  }

  // The full text of a stream: what was said of it that differs from the text is stopped (from the first sentence
  // that differs), and the text from there on is said. Returns what was said again ('' when nothing).
  specSettle(m, st, text) {
    // The drafted sentence said for this turn, at the start of a stream that has said nothing yet: skipped.
    const ds = m.draftSaid;
    if (!st.sent.length && ds && ds.turnSeq === st.turn && this.now() - ds.at < DRAFT_SAID_MS && afterPrefix(text, ds.text) >= 0) {
      st.sent.push(ds.text);
      st.draftSkipped = true;
    }
    let at = 0, k = 0;
    for (; k < st.sent.length; k++) {
      const n = afterPrefix(text.slice(at), st.sent[k]);
      if (n < 0) break;
      at += n;
    }
    if (k < st.sent.length) { this.specCut(m, st, k); st.sent.length = k; st.nos.length = Math.min(st.nos.length, k); }
    const rest = text.slice(at).trim();
    // Said first, settled after: a rest the queue refuses (too much waiting) leaves the stream open, so the publish
    // that follows (or this one, refused) can try again.
    if (rest && st.gen === m.channelGen) { this.sayOnChannel(m, rest); m.answeredSeq = Math.max(m.answeredSeq, st.turn); }
    Object.assign(st, { state: 'final', final: text, finalNorm: normalize(text), finalAt: this.now(), stopAt: Math.min(st.stopAt, k) });
    st.early.clear();
    st.buf = '';
    return st.gen === m.channelGen ? rest : '';
  }

  // Stops the sentences of a stream from k on: those not yet taken up for synthesis are blanked in their utterance
  // (silently; blanked, not removed, so every piece keeps its number); when one is already being synthesized or
  // played, the utterance is stopped and ended at once, also while its first piece is still being synthesized (stop:
  // muted again after it, as meeting_stop_speaking would; otherwise the text that follows keeps the microphone).
  specCut(m, st, k, { stop = false } = {}) {
    st.stopAt = Math.min(st.stopAt, k);
    const u = st.u;
    if (!u || u.ending || u.cancelled) return;
    const nos = st.nos.slice(k).filter((x) => x !== undefined);
    if (!nos.length) return;
    if (Math.min(...nos) < u.taken) {
      // What else the utterance had not begun to play (another stream's sentences, published text) is said again
      // after it, in order, with its stream's records moved along.
      const mine = (no) => { const o = u.owners.get(no); return o?.st === st && o.i >= k; };
      const played = u.startedAt ? this.now() - u.startedAt : 0;
      const left = [];
      if (u.startedAt) for (const x of u.timeline || []) { if (x.start >= played && x.no !== undefined) left.push([x.no, x.text]); }
      else if (u.head) left.push([0, u.head]);
      if (u.synthPiece) left.push([u.synthNo, u.synthPiece]);
      u.pieces.forEach((t, pos) => left.push([u.taken + pos, t]));
      const keep = left.filter(([no, t]) => t && t.trim() && !mine(no));
      Object.assign(u, { cancelled: true, ...(stop ? { stopped: true } : {}) });
      u.pieces.length = 0;
      u.wake?.();
      u.player?.stop();
      this.endUtterance(m, u, 'interrupted', null).catch(() => {});
      for (const [no, t] of keep) { try { this.sayOnChannel(m, t, { whole: true, spec: u.owners.get(no) || null }); } catch {} }
      return;
    }
    for (let j = k; j < st.sent.length; j++) {
      const pos = st.nos[j] === undefined ? -1 : st.nos[j] - u.taken;
      if (pos >= 0 && u.pieces[pos] === st.sent[j]) u.pieces[pos] = '';
    }
  }

  // A publish that delivers a speculative stream (its streamId, or the same text): matched to it, and not said twice.
  // Returns the receipt's additions, or null (said as usual): speculative "settled" (the stream was still open: the
  // publish settles it), "already_spoken" (complete came first with this text) or "interrupted" (a barge-in stopped
  // it; the rest is not said).
  // Without a streamId only a stream for the same turn is matched. A stream whose turn was reopened since
  // (superseded_publish "drop") answers {dropped: true}: the publish is dropped as any for that turn.
  specPublish(m, text, p, turn) {
    if (!m.specStreams.size) return null;
    const id = [p?.streamId, p?.metadata?.streamId, p?._meta?.streamId].find((x) => typeof x === 'string' && x);
    const norm = normalize(text);
    let st = id ? m.specStreams.get(id.slice(0, 200)) : null;
    if (!st && !id) {
      const recent = (x) => this.now() - Math.max(x.at, x.finalAt) < SPEC_MATCH_MS;
      const said = (x) => normalize([...x.sent, x.buf].join(' '));
      // An open stream's buffer may end in the middle of a word ("The bud"): then a character prefix will do.
      const starts = (x) => { const a = said(x); return !!a && (norm === a || norm.startsWith(`${a} `) || (/\S$/.test(x.buf) && norm.startsWith(a))); };
      st = [...m.specStreams.values()].reverse().find((x) => !x.published && x.turn === turn && recent(x) && (x.final !== null ? x.finalNorm === norm
        : (x.state === 'open' || x.state === 'interrupted') && starts(x))) || null;
    }
    if (st && (st.state === 'open' || st.state === 'dropped') && this.specSuperseded(m, st)) { st.state = 'dropped'; st.published = true; return { dropped: true, turn: st.turn, stream_id: st.id }; }
    if (!st || st.state === 'dropped' || st.state === 'cancelled') return null;
    const base = { speculative: true, stream_id: st.id, ...(st.draftSkipped ? { draft_prefix_skipped: true } : {}) };
    if (st.state === 'open' && st.gen !== m.channelGen) st.state = 'interrupted'; // meeting_stop_speaking since
    // A stream delivers one publish: the same text published again is said. Marked only once settled (a publish the
    // queue refuses can be sent again and still match).
    const done = (r) => { st.published = true; this.useDraftSaid(m, st); return { ...base, ...(st.draftSkipped ? { draft_prefix_skipped: true } : {}), ...r }; };
    if (st.state === 'interrupted') {
      Object.assign(st, { final: text, finalNorm: norm, finalAt: this.now() });
      return done({ spoken: 'interrupted' });
    }
    if (st.state === 'final' && st.finalNorm === norm) return done({ spoken: 'already_spoken' });
    if (st.state === 'final' && st.gen !== m.channelGen) return done({ spoken: 'interrupted' });
    const again = this.specSettle(m, st, text);
    return done({ spoken: 'settled', ...(again ? { said_after_stream: again.length } : {}) });
  }

  // meeting_draft: the agent's draft reply to the turn still being said. ready: its first sentence is synthesized now,
  // and said the moment the turn reaches the agent (draftOutcome), if the final added at most draft_max_new_words words
  // to what had been heard when it was marked ready. text "" clears it.
  setDraft(tenant, id, { text, ready = false, forTurnSeq }) {
    const m = this.get(tenant, id);
    this.inCall(m, 'drafting');
    if (!this.opts(m).draft_enabled) throw new Error('drafts are off: speech_settings_set {draft_enabled: true}, or meeting_join with draft_enabled');
    const t = String(text ?? '').trim();
    if (!t) { const had = !!m.draft; m.draft = null; return { meeting_id: id, draft: had ? 'cleared' : 'none' }; }
    const inHold = (q) => !!m.hold && (m.hold.extends === q || m.hold.segs.some((x) => x.seq === q));
    if (forTurnSeq !== undefined && forTurnSeq !== null && forTurnSeq <= m.lastTurnSeq && !inHold(forTurnSeq)) {
      return { meeting_id: id, draft: 'too_late', turn_seq: forTurnSeq, last_turn_seq: m.lastTurnSeq, note: 'that turn has reached you already: publish your answer' };
    }
    const sentence = sentencesOf(t)[0] || t;
    if (sentence.length > DRAFT_SENTENCE_MAX) throw new Error(`the first sentence is longer than ${DRAFT_SENTENCE_MAX} characters; make it short, it is said as soon as the turn ends`);
    const prev = m.draft;
    const d = { text: t, sentence, ready: !!ready, forTurnSeq: forTurnSeq ?? null, setAt: this.now(), heard: null, readyAt: 0, key: null, wav: null };
    if (d.ready) {
      // What had been heard when it was marked ready (kept while the same draft is sent again).
      const same = prev?.ready && prev.text === t && prev.forTurnSeq === d.forTurnSeq;
      Object.assign(d, same ? { heard: prev.heard, readyAt: prev.readyAt, setAt: prev.setAt } : { heard: this.heardSoFar(m), readyAt: this.now() });
      let tts = null;
      try { tts = this.tts(m.tenant); } catch {}
      if (tts) {
        d.key = this.preparedKey(tts, sentence);
        if (prev?.key === d.key && prev.wav) d.wav = prev.wav;
        else { d.wav = synthesizeWav(this.cfg, { text: sentence, ...tts }); d.wav.catch(() => {}); }
      }
    }
    m.draft = d;
    return { meeting_id: id, draft: 'set', ready: d.ready, sentence, ...(d.forTurnSeq !== null ? { for_turn_seq: d.forTurnSeq } : {}), ...(d.ready ? { heard_words: words(d.heard).length } : {}), last_turn_seq: m.lastTurnSeq };
  }

  // The text of the turn still being said: the finals held for it and the open segment after them.
  heardSoFar(m) {
    const parts = [];
    let last = m.lastTurnSeq;
    if (m.hold) { parts.push(...m.hold.segs.map((x) => x.text)); last = Math.max(last, m.hold.lastSeq ?? last); }
    const p = m.partialNow;
    if (p?.human && p.seq > last) parts.push(p.text);
    return parts.join(' ');
  }

  // A turn reaches the agent (draft_enabled): what became of the draft for it. Said ("spoken") when it was ready, set
  // for this turn (for_turn_seq one of its segments; without one: set after the turn began) and the final added at most
  // draft_max_new_words words (none of them a "not" or "but") to what had been heard when it was marked ready, and
  // nothing else is being said. A draft for a later turn stays; any other is used up.
  draftOutcome(m, seg, d) {
    const dr = m.draft;
    if (!dr) return { draft: 'none' };
    const segs = seg.parts || [seg];
    const last = seg.seq;
    if (dr.forTurnSeq !== null && dr.forTurnSeq > last) return { draft: 'none' };
    m.draft = null;
    const drop = (reason, extra = {}) => { m.draftsDropped++; return { draft: 'dropped', draft_reason: reason, draft_text: dr.sentence, ...extra }; };
    const began = Math.min(...segs.map((x) => m.firstHeard.get(x.seq) ?? Infinity));
    if (dr.forTurnSeq !== null ? !segs.some((x) => x.seq === dr.forTurnSeq) : Number.isFinite(began) && dr.setAt < began) return drop('other_turn');
    if (!dr.ready) return drop('not_ready');
    const added = addedWords(words(dr.heard), words(seg.text));
    if (added.length > d.draft_max_new_words) return drop('new_words', { draft_new_words: added.length });
    if (added.some((w) => MEANING_FLIP.has(w))) return drop('meaning_may_change', { draft_new_words: added.length });
    if ((m.speech && m.speech.kind !== 'ack') || m.channelBacklog > 0) return drop('speaking');
    if (!m.rig?.play || (m.state !== 'admitted' && m.state !== 'recording')) return drop('cannot_speak');
    if (dr.wav && dr.key) this.putPrepared(m, dr.key, dr.wav);
    try { this.sayOnChannel(m, dr.sentence, { whole: true }); } catch (e) { return drop('cannot_speak', { error: oneLine(e) }); }
    m.draftSaid = { turnSeq: seg.seq, text: dr.sentence, norm: normalize(dr.sentence), at: this.now() };
    m.answeredSeq = Math.max(m.answeredSeq, seg.seq);
    m.draftsSpoken++;
    return { draft: 'spoken', draft_text: dr.sentence, draft_new_words: added.length };
  }

  // At most PREPARED_MAX sentences (synthesized or synthesizing) at a time, each at most PREPARE_SENTENCE_MAX
  // characters: what doesn't fit is simply not prepared (its publish synthesizes it). Nothing is evicted while it is
  // still being synthesized, so the number of requests is bounded too.
  prepare(m, text) {
    const t = String(text || '').trim(), n = normalize(t);
    if (!n || t.length > PREPARE_SENTENCE_MAX || m.channelSaid.some((x) => this.now() - x.at < PREPARED_MS && x.norm.includes(n))) return;
    let tts;
    try { tts = this.tts(m.tenant); } catch { return; }
    const key = this.preparedKey(tts, t);
    if (m.prepared.has(key)) return;
    for (const [k, x] of m.prepared) if (x.done && this.now() - x.at > PREPARED_MS) m.prepared.delete(k);
    if (m.prepared.size >= PREPARED_MAX) return;
    const e = { at: this.now(), done: false, wav: synthesizeWav(this.cfg, { text: t, ...tts }) };
    e.wav.then(() => { e.done = true; }, () => { m.prepared.delete(key); });
    m.prepared.set(key, e);
  }

  // Audio synthesized elsewhere (a draft) put among the prepared, under the same bounds: expired entries go first,
  // then the oldest if it is still full; a failed synthesis is removed.
  putPrepared(m, key, wav) {
    for (const [k, x] of m.prepared) if (x.done && this.now() - x.at > PREPARED_MS) m.prepared.delete(k);
    while (m.prepared.size >= PREPARED_MAX) m.prepared.delete(m.prepared.keys().next().value);
    const e = { at: this.now(), done: false, wav };
    wav.then(() => { e.done = true; }, () => { if (m.prepared.get(key) === e) m.prepared.delete(key); });
    m.prepared.set(key, e);
  }

  // Which prepared audio fits a piece: exactly the same text (trimmed), backend, voice, model and language.
  preparedKey({ backend, voice, model, lang }, text) { return JSON.stringify([String(text).trim(), backend, voice ?? null, backend === 'elevenlabs' ? model : null, lang ?? null]); }

  // A piece's audio: synthesized ahead from chunks (taken, once), else now.
  synth(m, { text, ...tts }) {
    const key = this.preparedKey(tts, text);
    const e = m.prepared.get(key);
    if (e && this.now() - e.at <= PREPARED_MS) { m.prepared.delete(key); return e.wav; }
    return synthesizeWav(this.cfg, { text, ...tts });
  }

  // A partial of the live transcript: a bosun:meeting-transcript event (transcript_partials, transcript_events) and,
  // with agent_partials, at most every agent_partials_interval_s on the channel.
  onPartial(m, seg) {
    const d = this.settings.effective(m.tenant).values;
    this.maybeBargeIn(m, seg, d);
    const human = this.heard(m, seg);
    this.openSegment(m, seg, human);
    if (human) this.maybeExtend(m, seg, d);
    // New speech while a turn is held: it waits for this speech's final (or TURN_PARTIAL_WAIT_MS after the pause).
    if (human && m.hold && seg.seq > m.hold.lastSeq) this.holdFor(m, this.partialWait(m, d));
    const onChannel = m.channelOpen && this.bus?.channelReady?.(m.tenant, m.channelId);
    if (m.partials && d.transcript_events !== 'never' && !(d.transcript_events === 'auto' && onChannel)) this.emitLive(m, 'transcript', seg);
    if (!onChannel || !d.agent_partials || this.now() - m.partialSentAt < d.agent_partials_interval_s * 1000) return;
    m.partialSentAt = this.now();
    this.incoming(m, { ...seg, ...this.speakerFor(m, seg, { open: true }) }).catch(() => {});
  }

  // A final of the live transcript, stamped with who the page showed speaking: held turn_hold_ms (turn_hold_complete_ms
  // after a complete sentence) for more of the same turn, then delivered (deliver) as one turn. Not held: with
  // turn_hold_ms 0, while the meeting ends, and Bosun's own voice coming back (delivered at once, echo_suspected).
  // Someone else's final ends the turn held before it.
  onFinal(m, seg) {
    Object.assign(seg, this.speakerFor(m, seg));
    const d = this.settings.effective(m.tenant).values;
    this.maybeBargeIn(m, seg, d);
    const human = this.heard(m, seg);
    this.openSegment(m, seg, human);
    if (!human) { if (words(seg.text).length) seg.echo = true; return this.deliver(m, seg, d); }
    if (d.turn_hold_ms && !m.finishing && m.state !== 'ended') this.maybeExtend(m, seg, d);
    if (!d.turn_hold_ms || m.finishing || m.state === 'ended') { this.flushHold(m); return this.deliver(m, seg, d); }
    if (m.hold && m.hold.speaker && seg.speaker && m.hold.speaker !== seg.speaker) this.flushHold(m);
    const h = m.hold ??= { segs: [], timer: null, first: this.now(), gen: m.consentGen, speaker: null };
    h.segs.push(seg);
    h.lastSeq = seg.seq;
    h.lastAt = this.now();
    h.speaker ??= seg.speaker || null;
    // A later segment already being said (its partial came before this final's timestamped copy) holds it like a
    // partial during the hold would.
    const later = m.partialNow && m.partialNow.seq > seg.seq && m.partialNow.human;
    const ms = later ? this.partialWait(m, d) : this.turnComplete(seg.text) ? Math.min(d.turn_hold_complete_ms, d.turn_hold_ms) : d.turn_hold_ms;
    if (!ms || this.now() - h.first >= TURN_MAX_MS) return this.flushHold(m);
    this.holdFor(m, ms);
  }

  // The newest segment heard (a final never replaces a later segment's partial): what a barge-in counts from.
  openSegment(m, seg, human) {
    if (!m.partialNow || seg.seq >= m.partialNow.seq) m.partialNow = { seq: seg.seq, text: seg.text, human };
  }

  partialWait(m, d) { return Math.max(d.turn_hold_ms, m.vadSilenceS * 1000 + TURN_PARTIAL_WAIT_MS); }

  // Still thinking (addendum to item 3): the speaker goes on after their turn went to the agent and before it answered
  // it (no publish, no meeting_speak for it, nothing of Bosun's but an acknowledgement playing), within turn_extend_s.
  // The turn is reopened: it is held again with what comes now and goes once more, merged (extends_turn), when they
  // are done. The agent hears at once (bosun:meeting-turn-extended); its publishes for the old turn are dropped
  // (superseded_publish). The old turn's acknowledgement, if still to come, is not played; the merged turn gets one.
  maybeExtend(m, seg, d) {
    const t = m.lastTurn;
    // A turn whose text was forgotten since (a deletion) is never reopened: its text would be sent again.
    if (!t || t.gen !== m.consentGen || !d.turn_extend_s || !d.turn_hold_ms || seg.seq <= t.seq || m.hold || m.extendedSeqs.has(t.seq) || m.answeredSeq >= t.seq) return;
    if (this.now() - t.at > d.turn_extend_s * 1000 || (m.speech && m.speech.kind !== 'ack')) return;
    const who = seg.speaker || this.speakerFor(m, seg, { open: !seg.final }).speaker || null;
    if (t.speaker && who && t.speaker !== who) return; // someone else: a turn of their own
    m.extendedSeqs.add(t.seq);
    if (m.extendedSeqs.size > 50) m.extendedSeqs.delete(m.extendedSeqs.values().next().value);
    m.turnsExtended++;
    m.draft = null; // a draft made for the turn as it was is not said for the longer one
    if (m.ackTimer) m.lastAck = 0; // a clip that never played doesn't hold back the real end's (one played already does)
    clearTimeout(m.ackTimer);
    m.ackTimer = null;
    m.hold = { segs: [...t.segs], timer: null, first: this.now(), gen: t.gen, speaker: t.speaker, lastSeq: t.seq, lastAt: this.now(), extends: t.seq };
    this.holdFor(m, this.partialWait(m, d));
    const text = t.segs.map((x) => x.text).join(' ');
    const data = { turn_seq: t.seq, turn_text: text, text_so_far: seg.text, ...(who ? { speaker: who } : {}) };
    if (m.channelOpen && this.bus?.channelReady?.(m.tenant, m.channelId)) {
      this.bus.channelIncoming(m.tenant, m.channelId, [{
        channelId: m.channelId, messageId: `${m.id}:ext${t.seq}`, threadId: m.id,
        author: { id: 'bosun', name: botName(m.name) }, timestamp: new Date(this.now()).toISOString(),
        content: [{ type: 'text', text: `(${who || 'the speaker'} went on after "${text}": "${seg.text}" — wait for the whole turn; it comes again, merged, when they are done)` }],
        metadata: { meeting_id: m.id, platform: m.platform.name, turn_extended: true, ...data },
        tags: ['bosun:meeting-turn-extended', `bosun:meeting=${m.id}`],
      }]).catch(() => {});
    } else if (d.transcript_events !== 'never') this.emitLive(m, 'turn-extended', data);
  }

  // A final that clearly ends a sentence: a question, or a sentence of at least three words with a full stop that
  // doesn't trail off (… or a last word such as "and", "the", "що").
  turnComplete(text) {
    const t = String(text || '').trim();
    if (TURN_QUESTION.test(t)) return true;
    return TURN_END.test(t) && !TRAILING_OFF.test(t) && !TRAILING_WORD.test(t) && words(t).length >= 3;
  }

  // The held turn goes ms from now, unless more comes; TURN_MAX_MS after its first final at the latest.
  holdFor(m, ms) {
    const h = m.hold;
    clearTimeout(h.timer);
    ms = Math.max(0, Math.min(ms, h.first + TURN_MAX_MS - this.now()));
    h.timer = setTimeout(() => {
      if (m.hold !== h) return;
      try { this.flushHold(m); } catch (e) { console.error(`bosun meeting ${m.id}: turn: ${oneLine(e)}`); }
    }, ms);
    h.timer.unref?.();
  }

  // The held turn to the agent now: one final (merged_seqs when it was more than one), held_ms after its last final. A
  // turn forgotten meanwhile (an opt-out, a deletion) is dropped.
  flushHold(m) {
    const h = m.hold;
    if (!h) return;
    m.hold = null;
    clearTimeout(h.timer);
    if (h.gen !== m.consentGen) return;
    const seg = h.segs.length === 1 && !h.extends ? h.segs[0] : this.mergeTurn(m, h.segs);
    if (h.extends) seg.extends_turn = h.extends;
    // Reopened, but nothing came of it (Scribe committed nothing): the same turn again, answerable again.
    if (h.extends && seg.seq === h.extends) m.extendedSeqs.delete(h.extends);
    seg.held_ms = this.now() - h.lastAt;
    this.deliver(m, seg, this.settings.effective(m.tenant).values);
  }

  mergeTurn(m, segs) {
    const a = segs[0], z = segs.at(-1);
    const seg = {
      seq: z.seq, start_s: a.start_s, end_s: z.end_s, text: segs.map((s) => s.text).join(' '), final: true,
      ...(z.lang || a.lang ? { lang: z.lang || a.lang } : {}), at: z.at, ...(z.lag_s !== undefined ? { lag_s: z.lag_s } : {}), merged_seqs: segs.map((s) => s.seq),
    };
    Object.defineProperty(seg, 'parts', { value: segs }); // the finals it is made of (a turn reopened starts from them), not sent
    const who = this.speakerFor(m, seg), named = segs.find((s) => s.speaker);
    Object.assign(seg, who.speaker ? who : named ? { speaker: named.speaker, ...(named.speakers ? { speakers: named.speakers } : {}) } : {});
    return seg;
  }

  // Speech that is not Bosun's own voice coming back: someone has spoken since the last turn went to the agent.
  heard(m, seg) {
    const w = words(seg.text);
    if (!w.length || this.ownVoice(m, w)) return false;
    m.lastHumanAt = this.now();
    m.heardSeq = Math.max(m.heardSeq, seg.seq);
    if (!m.firstHeard.has(seg.seq)) {
      m.firstHeard.set(seg.seq, this.now());
      if (m.firstHeard.size > 200) m.firstHeard.delete(m.firstHeard.keys().next().value);
    }
    return true;
  }

  // Words Bosun is saying now (also an acknowledgement playing out) or said within SAID_ECHO_MS. Not those of a reply
  // still being prepared: nothing of it can come back yet, and someone may be saying the same words.
  saidWords(m) {
    const out = new Set();
    for (const u of [m.speech, m.ackPlaying]) for (const w of this.playedWords(u)) out.add(w);
    const cut = this.now() - SAID_ECHO_MS;
    m.saidRecent = m.saidRecent.filter((x) => x.at >= cut);
    for (const x of m.saidRecent) for (const w of x.words) out.add(w);
    return out;
  }

  // The words of an utterance's pieces that have begun to play (not those still waiting or being synthesized).
  playedWords(u) {
    if (!u?.startedAt || !u.timeline) return [];
    const t = this.now() - u.startedAt;
    return u.timeline.filter((p) => p.start <= t).flatMap((p) => words(p.text));
  }

  // Text that is mostly what Bosun is saying or just said: its own voice, back through someone's microphone (or the mix).
  ownVoice(m, w) {
    const said = this.saidWords(m);
    return said.size > 0 && w.filter((x) => said.has(x)).length / w.length >= ECHO_SHARE;
  }

  // Barge-in (barge_in): someone else speaks while Bosun's audio plays. Counted from where the open segment was when it
  // started playing: at least barge_in_min_words new words (agreeing words such as "mhm", "yes" don't count), or one
  // while the page has shown someone speaking barge_in_min_s since then. Never Bosun's own voice coming back; where
  // the page names speakers, someone other than Bosun must be shown speaking during the segment.
  // An acknowledgement playing in front of a reply still being prepared counts as Bosun speaking: both are stopped.
  maybeBargeIn(m, seg, d) {
    const playing = (x) => x?.startedAt && x.base && !x.cancelled && !x.ending && x.state === 'speaking';
    const p = playing(m.speech) ? m.speech : playing(m.ackPlaying) ? m.ackPlaying : null;
    const u = m.speech;
    // Audio without text (an uploaded file): its echo can't be told from someone speaking, so it is never cut off.
    if (!d.barge_in || !p || !p.timeline || u?.cancelled || u?.ending || seg.seq < p.base.seq) return;
    // Only what was said while it played: a final whose audio ended before (its timestamped copy came late) is not
    // an interruption; of one that began before, the words of its part before are left out (by share of its time).
    let cut = seg.seq === p.base.seq ? p.base.n : 0;
    const all = words(seg.text);
    if (seg.final && m.transcript?.wallAt) {
      const a = m.transcript.wallAt(seg.start_s), b = m.transcript.wallAt(seg.end_s);
      if (b !== null && b < p.startedAt) return;
      if (a !== null && b !== null && b > a && a < p.startedAt) cut = Math.max(cut, Math.floor((all.length * (p.startedAt - a)) / (b - a)));
    }
    const w = all.slice(cut);
    if (!w.length || this.ownVoice(m, w)) return;
    const labels = m.speakersSeen && (m.speakerLog.at(-1)?.name || this.now() - m.lastNamedAt < LABEL_FRESH_MS);
    const who = labels ? this.speakersIn(m, p.startedAt, this.now()) : {}; // only while Bosun's audio plays
    if (labels && !who.speaker) return;
    const counted = w.filter((x) => !BACKCHANNEL.has(x)).length;
    if (counted < d.barge_in_min_words && !(counted >= 1 && labels && this.shownMs(m, p.startedAt) >= d.barge_in_min_s * 1000)) return;
    this.bargeIn(m, u || p, { heard: w.join(' '), speaker: who.speaker || null }).catch((e) => console.error(`bosun meeting ${m.id}: barge-in: ${oneLine(e)}`));
  }

  // How long since `from` the page has shown someone (not Bosun) speaking.
  shownMs(m, from) {
    const log = m.speakerLog;
    let ms = 0;
    for (let i = 0; i < log.length; i++) {
      const s = Math.max(log[i].t, from), e = log[i + 1]?.t ?? this.now();
      if (log[i].name && e > s) ms += e - s;
    }
    return ms;
  }

  // Stops the utterance as meeting_stop_speaking does (text from the channel still waiting is dropped, the microphone
  // muted again), and tells the agent what was said of it: bosun:meeting-speech (barge_in, said) and, on the channel, a
  // bosun:meeting-interrupted message. An acknowledgement just stops.
  async bargeIn(m, u, by) {
    m.bargeIns++;
    m.draft = null; // a draft waiting for the turn is dropped: the interrupter's turn comes next
    for (const st of m.specStreams.values()) if (st.state === 'open') st.state = 'interrupted';
    const { said, unsaid } = this.spokenSoFar(u);
    u.bargeIn = { said, speaker: by.speaker };
    m.channelGen++;
    clearTimeout(m.ackTimer);
    m.ackTimer = null;
    Object.assign(u, { cancelled: true, stopped: true });
    u.pieces.length = 0;
    u.wake?.();
    const stopping = Promise.all([this.stopAck(m), u.player?.stop()]);
    if (u.kind !== 'ack' && said !== null) this.noteInterrupted(m, u, { said, unsaid, ...by });
    await stopping;
    await this.endUtterance(m, u, 'interrupted', null);
  }

  noteInterrupted(m, u, { said, unsaid, speaker, heard }) {
    if (!m.channelOpen || !this.bus?.channelReady?.(m.tenant, m.channelId)) return;
    const text = said ? `(interrupted at "${said}"${speaker ? ` by ${speaker}` : ''}; the rest was not said)` : `(interrupted${speaker ? ` by ${speaker}` : ''} before any of it was said)`;
    this.bus.channelIncoming(m.tenant, m.channelId, [{
      channelId: m.channelId, messageId: `${m.id}:int${++m.interrupts}`, threadId: m.id,
      author: { id: 'bosun', name: botName(m.name) }, timestamp: new Date(this.now()).toISOString(), content: [{ type: 'text', text }],
      metadata: { meeting_id: m.id, platform: m.platform.name, interrupted: true, utterance_id: u.id, said, unsaid: unsaid.slice(0, 2000), heard, ...(speaker ? { speaker } : {}), last_turn_seq: m.lastTurnSeq },
      tags: ['bosun:meeting-interrupted', `bosun:meeting=${m.id}`],
    }]).catch(() => {});
  }

  // What of an utterance has played by now (by its pieces' times; a piece cut off counts as far as its whole words
  // went), and what had not: {said, unsaid}; said null for audio without text (a file).
  spokenSoFar(u) {
    const join = (a) => a.map((x) => x?.trim()).filter(Boolean).join(' ');
    if (!u.startedAt && u.head !== undefined) return { said: '', unsaid: join([u.head, u.synthPiece, ...u.pieces]) }; // not playing yet
    if (!u.timeline) return { said: null, unsaid: '' };
    const t = this.now() - u.startedAt, said = [], unsaid = [];
    for (const p of u.timeline) {
      if (p.end <= t) said.push(p.text);
      else if (p.start >= t) unsaid.push(p.text);
      else {
        const k = Math.round((p.text.length * (t - p.start)) / (p.end - p.start));
        const cut = p.text.slice(0, k + 1).search(/\s\S*$/);
        said.push(cut > 0 ? p.text.slice(0, cut) : '');
        unsaid.push(p.text.slice(cut > 0 ? cut : 0));
      }
    }
    if (u.synthPiece) unsaid.push(u.synthPiece);
    unsaid.push(...u.pieces);
    return { said: join(said), unsaid: join(unsaid) };
  }

  // A turn to the agent: acknowledged (ack_on_final), sent on the meeting's channel, and as a bosun:meeting-transcript
  // event unless the channel took it (transcript_events).
  // With draft_enabled, a new turn first says the drafted sentence (draftOutcome), and the turn carries what became of
  // the draft (draft, draft_text, draft_reason).
  deliver(m, seg, d) {
    let draft = null;
    if (!seg.echo && seg.seq >= m.lastTurnSeq) { // Bosun's own voice is not someone's turn
      m.lastTurnSeq = seg.seq;
      m.lastTurn = { seq: seg.seq, segs: seg.merged_seqs ? (seg.parts || [seg]) : [seg], speaker: seg.speaker || null, at: this.now(), gen: m.consentGen };
      const o = this.opts(m);
      if (o.draft_enabled) draft = this.draftOutcome(m, seg, o);
    }
    if (!seg.echo && draft?.draft !== 'spoken') this.maybeAck(m, seg, d);
    const out = draft ? { ...seg, ...draft } : seg;
    const onChannel = m.channelOpen && this.bus?.channelReady?.(m.tenant, m.channelId);
    if (!onChannel) { if (d.transcript_events !== 'never') this.emitLive(m, 'transcript', out); return; }
    if (d.transcript_events === 'always') this.emitLive(m, 'transcript', out);
    // A text forgotten meanwhile (an opt-out, a deletion) is not sent as the event after all.
    const gen = m.consentGen;
    this.incoming(m, seg, draft).then((ok) => { if (!ok && d.transcript_events === 'auto' && gen === m.consentGen) this.emitLive(m, 'transcript', out); }, () => {});
  }

  // A transcript segment as channels/incoming on the meeting's channel. Partials carry the seq of their final and
  // final: false (tag bosun:partial), so a wake policy can tell them apart.
  // draft: what became of the agent's draft for this turn (deliver), in the metadata and, when it was said or dropped,
  // as a second text block.
  async incoming(m, seg, draft = null) {
    const who = seg.speaker || null;
    const note = draft?.draft === 'spoken' ? `(Bosun has already said the first sentence of your draft: "${draft.draft_text}" Go on after it; a publish that starts with it skips it.)`
      : draft?.draft === 'dropped' ? `(your draft was not said: ${draft.draft_reason}${draft.draft_new_words !== undefined ? `, ${draft.draft_new_words} new words` : ''}; answer in full)` : null;
    const msg = {
      channelId: m.channelId, messageId: `${m.id}:${seg.seq}${seg.final ? '' : `:p${Math.round(this.now() % 1e9)}`}`, threadId: m.id,
      author: { id: who ? `speaker:${who}` : 'meeting', name: who || 'Meeting' }, timestamp: seg.at || new Date(this.now()).toISOString(),
      content: [{ type: 'text', text: seg.text }, ...(note ? [{ type: 'text', text: note }] : [])],
      metadata: {
        meeting_id: m.id, platform: m.platform.name, seq: seg.seq, start_s: seg.start_s, end_s: seg.end_s, final: !!seg.final, ...(seg.lang ? { lang: seg.lang } : {}), ...(who ? { speaker: who } : {}), ...(seg.speakers ? { speakers: seg.speakers } : {}),
        ...(seg.final && !seg.echo ? { turn_seq: seg.seq } : {}), ...(seg.extends_turn ? { extends_turn: seg.extends_turn } : {}),
        ...(seg.merged_seqs ? { merged_seqs: seg.merged_seqs } : {}), ...(seg.held_ms !== undefined ? { held_ms: seg.held_ms } : {}), ...(seg.echo ? { echo_suspected: true } : {}),
        ...(draft || {}),
      },
      tags: ['bosun:meeting-transcript', `bosun:meeting=${m.id}`, ...(seg.final ? [] : ['bosun:partial']), ...(seg.echo ? ['bosun:echo-suspected'] : []), ...(draft && draft.draft !== 'none' ? [`bosun:draft-${draft.draft}`] : [])],
    };
    return this.bus.channelIncoming(m.tenant, m.channelId, [msg]);
  }

  // Acknowledgement clips for the tenant's voice now (synthesized once per voice and phrase, kept in ackCache): the
  // entries, each with clip once it is there. Started at admission and again whenever the settings changed.
  ackClips(m) {
    const d = this.settings.effective(m.tenant).values;
    let tts;
    try { tts = this.tts(m.tenant, { lang: d.ack_lang ?? undefined }); } catch { return []; }
    return d.ack_phrases.map((text) => {
      const key = JSON.stringify([tts, text]);
      let e = this.ackCache.get(key);
      if (e?.error && this.now() - e.failedAt > ACK_RETRY_MS) e = null;
      if (!e) {
        e = { text, clip: null, error: null, failedAt: 0 };
        e.ready = synthesizeWav(this.cfg, { text, ...tts }).then((c) => { e.clip = c; }, (err) => { e.error = oneLine(err); e.failedAt = this.now(); });
        this.ackCache.set(key, e);
        while (this.ackCache.size > ACK_CACHE) this.ackCache.delete(this.ackCache.keys().next().value);
      }
      return e;
    });
  }

  prepareAcks(m) {
    try { if (this.settings.effective(m.tenant).values.ack_on_final && m.rig?.play) this.ackClips(m); } catch {}
  }

  // A final that ends someone's turn (at least ack_min_words, ending a sentence) gets a short cached clip after
  // ack_delay_ms, unless something is being said (or the agent starts speaking meanwhile), one played within
  // ack_cooldown_s, or no clip is ready yet (never waited for).
  maybeAck(m, seg, d) {
    if (!d.ack_on_final || !m.rig?.play || m.speech || m.optedOut || (m.state !== 'admitted' && m.state !== 'recording')) return;
    const text = String(seg.text || '').trim();
    if (text.split(/\s+/).filter(Boolean).length < d.ack_min_words || !TURN_END.test(text)) return;
    if (this.now() - m.lastAck < d.ack_cooldown_s * 1000) return;
    const ready = [...new Map(this.ackClips(m).filter((e) => e.clip).map((e) => [e.text, e])).values()];
    if (!ready.length) return;
    const others = ready.filter((e) => e.text !== m.lastAckText);
    const pool = others.length ? others : ready;
    const e = pool[Math.floor(Math.random() * pool.length)];
    m.lastAck = this.now();
    m.lastAckText = e.text;
    clearTimeout(m.ackTimer);
    const gen = m.consentGen;
    m.ackTimer = setTimeout(() => {
      m.ackTimer = null;
      if (m.speech || gen !== m.consentGen || (m.state !== 'admitted' && m.state !== 'recording')) return;
      this.utter(m, { clip: e.clip, clipText: e.text, kind: 'ack' }).catch(() => {});
    }, d.ack_delay_ms);
    m.ackTimer.unref?.();
  }

  // Who the page shows as speaking (platform.watchSpeakers), read every SPEAKER_POLL_MS outside the page queue (a
  // read only; the queue may be busy for seconds), kept as changes {t, name} for SPEAKER_LOG_MS.
  pollSpeakers(m) {
    if (!m.platform.drainSpeakers || m.speakerTimer) return;
    let busy = false;
    m.speakerTimer = setInterval(async () => {
      if (busy || m.state === 'ended' || !m.session || m.session.disposed) return;
      busy = true;
      try {
        let got = await m.platform.drainSpeakers(m.session.page, m.speakerKey).catch(() => []);
        if (got === null) { // the page was replaced: watch again
          await this.page(m, (p) => m.platform.watchSpeakers(p, m.speakerKey, { self: [m.name, m.info.selfName].filter(Boolean) })).catch(() => {});
          got = [];
        }
        for (const c of got) { m.speakerLog.push(c); if (c.name) { m.speakersSeen = true; m.lastNamedAt = this.now(); } }
        const cut = this.now() - SPEAKER_LOG_MS;
        while (m.speakerLog.length > 1 && m.speakerLog[1].t < cut) m.speakerLog.shift();
      } finally { busy = false; }
    }, SPEAKER_POLL_MS);
    m.speakerTimer.unref?.();
  }

  // The speaker of a segment: who the page showed speaking longest while it was said (its audio times as wall clock,
  // from when the transcript sent that audio), 300 ms earlier included. {speaker, speakers (all of them, when more
  // than one)} or {} when nobody was shown. open: a partial, still being said (up to now).
  speakerFor(m, seg, { open = false } = {}) {
    const t = m.transcript, log = m.speakerLog;
    if (!t?.wallAt || !log.length) return {};
    const a = t.wallAt(seg.start_s), b = open ? this.now() : t.wallAt(seg.end_s);
    if (a === null || b === null) return {};
    return this.speakersIn(m, a - 300, b);
  }

  // Who the page showed speaking between from and until (wall clock): {speaker: the one shown longest, speakers} or {}.
  speakersIn(m, from, b) {
    const log = m.speakerLog, until = Math.max(b, from + 1);
    const time = new Map();
    for (let i = 0; i < log.length; i++) {
      const s = Math.max(log[i].t, from), e = Math.min(log[i + 1]?.t ?? this.now(), until);
      if (e > s && log[i].name) time.set(log[i].name, (time.get(log[i].name) || 0) + e - s);
    }
    if (!time.size) return {};
    const names = [...time].sort((x, y) => y[1] - x[1]).map(([n]) => n);
    return { speaker: names[0], ...(names.length > 1 ? { speakers: names } : {}) };
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
    // Nothing automatic any more: no acknowledgement, no channel (the transcript it carried stops), and channel text
    // still waiting is dropped. The agent can still speak (meeting_speak).
    m.consentGen++;
    m.channelGen++;
    clearTimeout(m.ackTimer);
    m.ackTimer = null;
    clearTimeout(m.hold?.timer);
    m.hold = null; // a turn still held is forgotten with the transcript, and one given can't be reopened
    m.lastTurn = null;
    m.draft = null;
    m.draftSaid = null;
    m.specStreams.clear();
    this.closeChannel(m);
    m.prepared.clear();
    // An acknowledgement or text from the channel, preparing or playing (also an acknowledgement still playing out
    // behind a reply): ended now, and the microphone muted again, without waiting for its synthesis.
    this.stopAck(m).catch(() => {});
    const u = m.speech;
    if (u && (u.kind === 'ack' || u.kind === 'stream')) {
      Object.assign(u, { cancelled: true, stopped: true });
      u.pieces.length = 0;
      u.player?.stop();
      this.endUtterance(m, u, 'interrupted', null).catch(() => {});
    }
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
    // A deletion unlinks the file first, then stops the recorder (which holds it open): a crash in between leaves no
    // file for the next run to serve (recordingFile looks at the disk).
    if (del && m.file) {
      this.links.revoke(m.tenant, m.id);
      fs.rmSync(m.file, { force: true });
      m.deleted = true;
      m.file = null;
    }
    if (rec) {
      m.stopping = rec;
      try { await (del ? rec.kill() : rec.stop()); } finally { if (m.stopping === rec) m.stopping = null; }
    }
    let bytes = null;
    if (m.file) bytes = fs.statSync(m.file, { throwIfNoEntry: false })?.size ?? null;
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
      clearInterval(m.speakerTimer);
      clearTimeout(m.ackTimer);
      // What the transcript still had committed, and a turn still held, go to the agent before the channel closes.
      const stoppingTranscript = this.stopTranscript(m, 'ended').catch(() => {});
      try { this.flushHold(m); } catch {}
      this.closeChannel(m);
      const rec = m.rec;
      await Promise.all([
        (async () => {
          if (rec) { m.rec = null; m.recMs += this.now() - rec.startedAt; m.stopping = rec; await rec.stop().catch(() => {}); }
          else if (m.stopping) await m.stopping.stop().catch(() => {});
        })(),
        stoppingTranscript,
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
        recording: m.file && bytes ? { path: m.file, bytes, mime_type: 'audio/ogg', seconds: Math.round(m.recMs / 1000), next: `call recording_get { meeting_id: "${m.id}" }` } : null,
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
      recording: m.file ? { path: m.file, bytes, ...(m.state === 'ended' && bytes ? { next: `call recording_get { meeting_id: "${m.id}" }` } : {}) } : m.deleted ? 'deleted' : null,
      ...(m.recError ? { recording_error: m.recError } : {}),
      ...(m.optedOut ? { opted_out: { sender: m.optedOut.sender, at: m.optedOut.at } } : {}),
      announce: { mode: m.announceMode, sent_to: m.announced.sent_to, ...(m.announced.failures.length ? { reason: m.announced.failures[0].reason, failures: m.announced.failures } : {}) },
      ...(m.chatError ? { chat_error: m.chatError } : {}),
      ...(m.live ? { live_transcript: m.transcript ? m.transcript.status() : { state: m.transcriptError ? 'unavailable' : m.state === 'ended' || m.noRecord ? 'off' : 'not-started', ...(m.transcriptError ? { error: m.transcriptError } : {}) } } : {}),
      ...(m.speech ? { speaking: { utterance_id: m.speech.id, ...(m.speech.kind !== 'speak' ? { kind: m.speech.kind } : {}), state: m.speech.state, ...(m.speech.seconds ? { duration_s: m.speech.seconds } : {}) } } : {}),
      ...(m.muteError && m.state !== 'ended' ? { ...(m.speechUnmuted ? { mic_open: true } : {}), mute_error: `the microphone may still be on: ${m.muteError}` } : {}),
      ...(m.channelId ? { channel: { id: m.channelId, open: m.channelOpen, ...(m.channelOpen ? { registered: !!this.bus?.channelReady?.(m.tenant, m.channelId) } : {}), published: m.channelMsgs } } : {}),
      ...(m.acks ? { acks: m.acks } : {}), ...(m.bargeIns ? { barge_ins: m.bargeIns } : {}),
      ...(Object.keys(m.overrides || {}).length ? { settings: m.overrides } : {}),
      ...(m.draft ? { draft: { ready: m.draft.ready, sentence: m.draft.sentence, ...(m.draft.forTurnSeq !== null ? { for_turn_seq: m.draft.forTurnSeq } : {}) } } : {}),
      ...(m.draftsSpoken || m.draftsDropped ? { drafts: { spoken: m.draftsSpoken, dropped: m.draftsDropped } } : {}),
      ...(m.speculative ? { speculative: { sentences: m.specSpoken, cancelled: m.specCancelled } } : {}), ...(m.turnsExtended ? { turns_extended: m.turnsExtended } : {}), ...(m.publishesDropped ? { publishes_dropped: m.publishesDropped } : {}),
      ...(m.platform.drainSpeakers && m.admittedAt ? { speaker_labels: m.speakersSeen ? 'seen' : 'none-seen' } : {}),
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

  // What a call leaves out of backend, voice and model: the tenant's speech settings, then the environment, then
  // Bosun's defaults.
  tts(tenant, { backend, voice, model, lang } = {}) {
    const d = this.settings.effective(tenant).values;
    backend ??= d.backend;
    if (model !== undefined && backend !== 'elevenlabs') throw new Error('model is an ElevenLabs model id: only with backend "elevenlabs"');
    model ??= d.elevenlabs_model;
    voice ??= (backend === 'elevenlabs' ? d.elevenlabs_voice : d.supertonic_voice) ?? undefined;
    return { backend, voice, model, lang };
  }

  // Plays text (synthesized: supertonic, or elevenlabs; what the call leaves out: speech settings) or an uploaded audio file into the meeting's microphone. The
  // microphone is unmuted for it and muted again after (autoMute; a microphone that was on stays on). Text is
  // synthesized a sentence at a time: the first one plays as soon as it is there, the rest is added while it plays.
  // Returns once all of it is synthesized (wait: once it has played). A second utterance while one plays is refused
  // unless interrupt (an acknowledgement playing is no reason: it plays out first).
  async speak(tenant, id, { text, audioFileId, voice, lang, backend, model, autoMute = true, interrupt = false, wait = false }) {
    const m = this.get(tenant, id);
    const tts = this.tts(tenant, { backend, voice, model, lang });
    this.inCall(m, 'speaking');
    await m.announceDone.p; // nothing is said before the announcement went out
    this.inCall(m, 'speaking');
    if (!m.rig?.play) throw new Error('this audio backend cannot play into the meeting');
    if (!text === !audioFileId) throw new Error('pass text or audio_file_id (one of them)');
    const prev = m.speech;
    if (prev && !interrupt && prev.kind !== 'ack') throw new Error(`already speaking (utterance ${prev.id}); meeting_stop_speaking first, or pass interrupt: true`);
    m.answeredSeq = Math.max(m.answeredSeq, m.lastTurnSeq); // the agent answers: the turn is no longer reopened
    return this.utter(m, { text, audioFileId, ...tts, autoMute, interrupt, wait });
  }

  // One utterance into the microphone. kind: 'speak' (meeting_speak), 'stream' (text published to the meeting's channel:
  // open, so more text is added while it plays, until it has played out with nothing new), 'ack' (a cached clip).
  // m.speech is this utterance from the start (synchronously), so what comes next sees it.
  // whole: the text is one piece (a sentence synthesized ahead as it is).
  async utter(m, { text, audioFileId, clip, clipText, backend, voice, lang, model, autoMute = true, interrupt = false, wait = false, kind = 'speak', open = false, whole = false }) {
    if (kind !== 'ack') { clearTimeout(m.ackTimer); m.ackTimer = null; } // the agent speaks: no acknowledgement now
    const prev = m.speech;
    const t0 = this.now();
    const consent = m.consentGen; // an opt-out meanwhile stops automatic speech (stream, ack) before it plays
    const pieces = text ? (whole ? [String(text).trim()] : splitSpeech(text, { group: !(kind === 'stream' && this.prepareOn(m)) })) : null;
    // taken: pieces taken up for synthesis so far (the first one at once): the piece at pieces[i] is number taken + i.
    const u = { id: `u${++m.speechSeq}`, kind, state: 'preparing', player: null, autoMute, cancelled: false, seconds: 0, t0, open: !!(text && open), pieces: pieces ? pieces.slice(1) : [], wake: null,
      head: pieces ? pieces[0] : undefined, taken: 1, owners: new Map() }; // owners: piece number -> {st, i} of a speculative stream
    u.finished = new Promise((r) => { u.finish = r; });
    m.speech = u;
    // The previous utterance stops without muting: this one takes the microphone over (m.speechUnmuted: whether
    // speaking turned it on, so that the last utterance mutes it again). An acknowledgement already playing plays out
    // (it is short) and this one starts right after it; one still waiting for the microphone never plays.
    let after = null;
    if (prev) {
      if (prev.kind === 'ack' && prev.player && !interrupt) after = m.ackPlaying = prev; // still reachable (stopAck) while it plays out
      else { prev.cancelled = true; prev.wake?.(); await prev.player?.stop(); }
    }
    if (!after) await this.stopAck(m); // an acknowledgement still playing behind the one replaced now stops too
    if (!autoMute) m.speechUnmuted = false; // the agent handles the microphone itself now
    const first = (async () => {
      if (clip) return clip;
      if (text) return this.synth(m, { text: pieces[0], backend, voice, lang, model });
      const f = this.manager.uploads?.use(m.tenant, [audioFileId], m.session.id)[0];
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
    if (after) await Promise.race([after.player.done, sleep(after.seconds * 1000 + 2000)]);
    const prepMs = this.now() - t0;
    if (kind !== 'speak' && consent !== m.consentGen) u.cancelled = true;
    const fail = a.status === 'rejected' ? a.reason : b.status === 'rejected' ? b.reason : u.cancelled || m.speech !== u ? new Error('stopped before it played')
      : m.state !== 'admitted' && m.state !== 'recording' ? new Error(`meeting ${m.id} is ${m.state}`) : null;
    if (fail) {
      const r = await this.endUtterance(m, u, u.cancelled ? 'interrupted' : 'failed', fail, { t0 });
      if (u.cancelled) return r;
      throw new Error(`nothing was said: ${oneLine(fail)}`);
    }
    const head = a.value;
    const pcm = !!(text || clip);
    u.player = m.rig.play(pcm ? { pcm: head.pcm } : { file: head.file, format: head.format });
    if (pcm) u.player.write(head.data);
    u.state = 'speaking';
    u.startedAt = this.now();
    u.seconds = head.seconds;
    // What a barge-in counts from: the words of the open segment already heard when this started playing.
    u.base = { seq: m.partialNow?.seq ?? 0, n: words(m.partialNow?.text).length };
    // When each piece plays (ms from the start), for what was said of it when it is cut off.
    u.timeline = text || clipText ? [{ text: text ? pieces[0] : clipText, start: 0, end: head.seconds * 1000, no: 0 }] : null;
    m.lastSpokeAt = u.startedAt;
    u.player.done.then((ok) => this.endUtterance(m, u, u.cancelled ? 'interrupted' : ok ? 'done' : 'failed', ok || u.cancelled ? null : new Error(u.player.error() || 'playback failed'), { t0, tail: ok }));
    // The rest, synthesized while the piece before plays (in the voice the first one got). gapMs: the longest silence
    // between pieces, when a piece was written after what was written before it had played (playEnd: when that is,
    // in ms from the start of playback, so a little later than the real one). An open utterance waits for more text
    // until what it has written has played out (STREAM_IDLE_MS more).
    let error = null, gapMs = 0, playEnd = head.seconds * 1000, count = 1;
    u.playEnd = playEnd;
    if (text) {
      for (let piece; (piece = await this.nextPiece(m, u, () => playEnd)) !== null;) {
        const no = u.taken - 1;
        if (!piece.trim()) continue; // taken back (specCut)
        u.synthPiece = piece;
        u.synthNo = no;
        const w = await this.synth(m, { text: piece, backend, voice: head.voice ?? voice, lang, model }).catch((e) => { error = e; return null; });
        if (!w || u.cancelled || u.state !== 'speaking') break;
        u.synthPiece = null;
        const owner = u.owners.get(no);
        if (owner && owner.i >= owner.st.stopAt) continue; // its stream took it back meanwhile
        if (w.pcm.rate !== head.pcm.rate || w.pcm.channels !== head.pcm.channels) { error = new Error(`${backend} changed its audio format mid-text`); break; }
        const at = this.now() - u.startedAt;
        gapMs = Math.max(gapMs, Math.round(at - playEnd));
        const from = Math.max(at, playEnd);
        playEnd = from + w.seconds * 1000;
        u.timeline.push({ text: piece, start: from, end: playEnd, no });
        u.playEnd = playEnd;
        u.player.write(w.data);
        u.seconds += w.seconds;
        count++;
      }
      u.open = false;
    }
    if (pcm) u.player.end();
    // Playback that doesn't end when it should (ffmpeg stuck) is cut off, and the microphone muted again. Counted from
    // now, when all of it is written: waiting for the synthesis paused the audio, so what played so far isn't known.
    if (!u.ending) {
      u.watchdog = setTimeout(() => { if (!u.ending) { u.cancelled = true; u.player.stop(); this.endUtterance(m, u, 'failed', new Error('playback did not end in time')); } },
        u.seconds * 1000 + this.speechGraceMs);
      u.watchdog.unref?.();
    }
    const started = {
      meeting_id: m.id, utterance_id: u.id, speaking: u.state === 'speaking', duration_s: Math.round(u.seconds * 100) / 100, source: clip ? 'ack' : text ? backend : 'file',
      ...(head.voice ? { voice: head.voice } : {}), ...(text && backend === 'elevenlabs' ? { model } : {}), ...(text ? { pieces: count } : {}),
      prepare_ms: prepMs, start_ms: u.startedAt - t0, ...(text ? { synth_ms: this.now() - t0 } : {}), ...(count > 1 ? { gap_ms: gapMs } : {}),
      unmuted: !!m.speechUnmuted,
      ...(error ? { error: `cut short, the rest could not be synthesized: ${oneLine(error)}` } : {}),
    };
    if (!wait) return started;
    const end = await Promise.race([u.finished, sleep((u.seconds + 30) * 1000).then(() => null)]);
    return end ? { ...started, ...end, speaking: false } : { ...started, error: 'still not over 30 s after it should have ended' };
  }

  // An acknowledgement that plays out behind the reply that replaced it in m.speech: stopped.
  async stopAck(m) {
    const a = m.ackPlaying;
    m.ackPlaying = null;
    if (a && !a.ending) { a.cancelled = true; await a.player?.stop(); }
  }

  // The next piece of text an utterance plays, or null when it is over: stopped, or nothing left and (open) nothing new
  // came by STREAM_IDLE_MS after what was written has played (then it is closed: more text starts a new one).
  async nextPiece(m, u, playEnd) {
    for (;;) {
      if (u.cancelled || u.state !== 'speaking') return null;
      if (u.pieces.length) { u.taken++; return u.pieces.shift(); } // numbered as taken in the same step (specCut)
      if (!u.open) return null;
      const left = playEnd() + STREAM_IDLE_MS - (this.now() - u.startedAt);
      if (left <= 0) { u.open = false; return null; }
      await new Promise((r) => { u.wake = r; setTimeout(r, left).unref?.(); });
      u.wake = null;
    }
  }

  // Text for the meeting from its channel (channels/publish): said right away, after what is being said now; text that
  // comes while an earlier one plays is added to it (one utterance, the microphone stays on). Throws (the publish is
  // refused) when nothing can be said in this meeting now, the text is longer than PUBLISH_MAX, or more than
  // CHANNEL_BACKLOG characters from the channel are still waiting to be said.
  // whole: the text is one piece (a sentence); spec {st, i}: sentence i of speculative stream st (specCut can take it
  // back while it waits).
  sayOnChannel(m, text, { whole = false, spec = null } = {}) {
    this.inCall(m, 'speaking');
    if (!m.rig?.play) throw new Error('this audio backend cannot play into the meeting');
    const t = String(text || '').trim();
    if (!t) return;
    if (t.length > PUBLISH_MAX) throw Object.assign(new Error(`at most ${PUBLISH_MAX} characters per publish (got ${t.length}); publish shorter pieces`), { code: -32602 });
    const u = m.speech?.kind === 'stream' && m.speech.open ? m.speech : null;
    const open = u ? u.pieces.reduce((n, x) => n + x.length, 0) : 0;
    const ahead = u?.startedAt ? (u.playEnd - (this.now() - u.startedAt)) / 1000 : 0;
    if (m.channelBacklog + open + t.length > CHANNEL_BACKLOG || ahead > CHANNEL_AHEAD_S) {
      throw Object.assign(new Error(`too much is still waiting to be said in meeting ${m.id} (${m.channelBacklog + open} characters, ${Math.round(ahead)} s of audio); try again when it has caught up`), { code: -32603 });
    }
    m.channelSaid.push({ norm: normalize(t), at: this.now() });
    if (m.channelSaid.length > 50) m.channelSaid.shift();
    m.channelBacklog += t.length;
    const gen = m.channelGen;
    if (spec) spec.st.queued = (spec.st.queued || 0) + 1; // a stream with text still in the queue is never evicted
    m.channelQueue = m.channelQueue.then(() => this.channelUtter(m, t, gen, { whole, spec })).catch(() => {}).finally(() => { m.channelBacklog -= t.length; if (spec) spec.st.queued--; });
  }

  // gen: m.channelGen when the text came; an opt-out or meeting_stop_speaking since then drops it (and a speculative
  // sentence its stream took back).
  async channelUtter(m, text, gen, { whole = false, spec = null } = {}) {
    const live = () => gen === m.channelGen && (m.state === 'admitted' || m.state === 'recording') && !(spec && spec.i >= spec.st.stopAt);
    await m.announceDone.p;
    if (!live()) return;
    // A stream from the channel that still takes text (open, not stopped or ending): this is added to it.
    const appendable = (u) => u?.kind === 'stream' && u.open && !u.cancelled && !u.ending;
    const append = (u) => {
      if (spec) { const no = u.taken + u.pieces.length; spec.st.u = u; spec.st.nos[spec.i] = no; u.owners.set(no, spec); }
      u.pieces.push(...(whole ? [text] : splitSpeech(text, { group: !this.prepareOn(m) })));
      u.wake?.();
    };
    if (appendable(m.speech)) return append(m.speech);
    // Anything else being said (meeting_speak, a stream that closed or is being stopped): this follows it, and the
    // microphone is not muted in between. It waits as long as that utterance can last (its length as it grows, the
    // watchdog's grace, muting again); one that still hasn't ended then is not cut off: this text is dropped instead.
    for (let c = m.speech; c && c.kind !== 'ack' && !appendable(c); c = m.speech) {
      m.speechFollows++;
      try {
        const t0 = this.now();
        while (m.speech === c && !c.ending && this.now() - t0 < (c.seconds || 0) * 1000 + this.speechGraceMs + 30_000) await Promise.race([c.finished, sleep(500)]);
        if (m.speech === c && !c.ending) {
          this.emit(m, 'speech', { utterance_id: null, kind: 'stream', state: 'failed', played_s: 0, error: `not said: utterance ${c.id} did not end` });
          return;
        }
        await c.finished;
      } finally { m.speechFollows--; }
      // Dropped meanwhile (opt-out, meeting_stop_speaking): the microphone that utterance left on for this is muted
      // again, as the end of an utterance would (retries, mic_open and the warning when it fails).
      if (!live()) { if (!m.speech && !m.speechFollows) await this.muteAfterSpeech(m); return; }
    }
    if (appendable(m.speech)) return append(m.speech);
    let tts;
    try { tts = this.tts(m.tenant); } catch (e) { this.emit(m, 'speech', { utterance_id: null, kind: 'stream', state: 'failed', played_s: 0, error: oneLine(e) }); return; }
    // Not awaited: the utterance is m.speech at once (what comes next is added to it) and runs until it has played.
    this.utter(m, { text, ...tts, kind: 'stream', open: true, whole }).catch((e) => {
      this.emit(m, 'speech', { utterance_id: null, kind: 'stream', state: 'failed', played_s: 0, error: oneLine(e) });
    });
    if (spec && m.speech?.head === text) { spec.st.u = m.speech; spec.st.nos[spec.i] = 0; m.speech.owners.set(0, spec); }
  }

  prepareOn(m) {
    try { return !!this.settings.effective(m.tenant).values.channel_prepare_chunks; } catch { return false; }
  }

  // An utterance is over (played, interrupted, failed): the microphone is muted again if speaking turned it on (not
  // while text from the channel waits to follow it), and bosun:meeting-speech says how it ended (not for an
  // acknowledgement). A microphone that could not be muted again is also a bosun:meeting-mic-open event.
  async endUtterance(m, u, state, error, { t0 = u.t0, tail = false } = {}) {
    if (u.ending) return u.finished;
    u.ending = true;
    u.wake?.();
    clearTimeout(u.watchdog);
    if (tail) await sleep(SPEECH_TAIL_MS);
    u.state = state;
    if (m.speech === u) m.speech = null;
    if (m.ackPlaying === u) m.ackPlaying = null;
    const own = this.playedWords(u);
    if (own.length) { m.saidRecent.push({ words: new Set(own), at: this.now() }); if (m.saidRecent.length > 6) m.saidRecent.shift(); }
    // The last utterance mutes again what speaking turned on; one followed by another (interrupt) leaves it to that one.
    const muteError = u.autoMute && !m.speech && (!m.speechFollows || u.stopped) ? await this.muteAfterSpeech(m, { report: false }) : null;
    const played = u.startedAt ? Math.round((this.now() - u.startedAt) / 10) / 100 : 0;
    const r = {
      utterance_id: u.id, ...(u.kind !== 'speak' ? { kind: u.kind } : {}), state, played_s: Math.min(played, Math.round(u.seconds * 100) / 100 || played), ...(error ? { error: oneLine(error) } : {}),
      ...(muteError ? { mic_open: true, mute_error: `the microphone may still be on: ${muteError}` } : {}), total_ms: this.now() - t0,
      ...(u.bargeIn ? { barge_in: true, ...(u.bargeIn.said !== null ? { said: u.bargeIn.said } : {}), ...(u.bargeIn.speaker ? { interrupted_by: u.bargeIn.speaker } : {}) } : {}),
    };
    if (u.kind === 'ack' && u.startedAt) m.acks++;
    if ((u.startedAt || u.bargeIn) && u.kind !== 'ack') this.emit(m, 'speech', r);
    if (muteError) this.emit(m, 'mic-open', { utterance_id: u.id, mic_open: true, mute_error: muteError });
    u.finish(r);
    return r;
  }

  // Mutes again what speaking turned on (when nobody speaks and the meeting goes on): waits MUTE_WAIT_MS at most; one
  // that fails is retried in the background (keepMuting) and returned (report: also a bosun:meeting-mic-open event).
  async muteAfterSpeech(m, { report = true } = {}) {
    if (!m.speechUnmuted || m.speech || (m.state !== 'admitted' && m.state !== 'recording')) return null;
    const tried = this.page(m, (p) => this.muteAgain(m, p)).catch((e) => (m.muteError = oneLine(e)));
    const muteError = await Promise.race([tried, sleep(MUTE_WAIT_MS).then(() => `muting again took longer than ${MUTE_WAIT_MS / 1000} s`)]);
    if (muteError) {
      m.muteError ??= muteError;
      this.keepMuting(m, tried);
      if (report) this.emit(m, 'mic-open', { mic_open: true, mute_error: muteError });
    }
    return muteError;
  }

  // A microphone that speaking turned on and that did not mute again: tried again (after the try still running, first)
  // every MUTE_RETRY_MS, while nobody speaks, until it is muted, the agent takes the microphone over (meeting_mute) or
  // the meeting ends. Until then meeting_status says mic_open; retries that run out are a bosun:meeting-mic-open event
  // (gave_up).
  async keepMuting(m, first) {
    if (m.muteRetrying) return;
    m.muteRetrying = true;
    const open = () => m.muteError && m.speechUnmuted && !m.speech && (m.state === 'admitted' || m.state === 'recording');
    try {
      await first;
      for (let i = 0; i < MUTE_RETRIES && open(); i++) {
        await sleep(MUTE_RETRY_MS);
        if (!open()) break;
        await this.page(m, (p) => this.muteAgain(m, p)).catch((e) => { m.muteError = oneLine(e); });
      }
      if (open()) this.emit(m, 'mic-open', { mic_open: true, mute_error: m.muteError, gave_up: true });
    } finally { m.muteRetrying = false; }
  }

  // Mutes again what speaking turned on, inside a page operation: up to three tries, a menu left open closed in between.
  // One that fails keeps it owned (the next utterance and keepMuting try again) and is reported (m.muteError,
  // meeting_status mic_open). Returns the error or null.
  async muteAgain(m, p) {
    let err = null;
    for (let i = 0; i < 3; i++) {
      if (i) { await p.keyboard.press('Escape').catch(() => {}); await p.waitForTimeout(500).catch(() => {}); }
      // Not when someone speaks now, the meeting is over, or the microphone isn't speaking's any more (meeting_mute
      // took it over, also while this waited in the page queue).
      if (m.speech || !m.speechUnmuted || (m.state !== 'admitted' && m.state !== 'recording')) return null;
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
    m.channelGen++; // text from the channel still waiting is dropped too, and an acknowledgement about to play
    for (const st of m.specStreams.values()) if (st.state === 'open') st.state = 'interrupted'; // and what a stream still sends
    clearTimeout(m.ackTimer);
    m.ackTimer = null;
    await this.stopAck(m);
    const u = m.speech;
    if (!u) return { meeting_id: id, stopped: false };
    u.cancelled = true;
    u.stopped = true; // muted again even with channel text waiting to follow (it is dropped)
    u.wake?.();
    await u.player?.stop();
    // Ended here too, should the player never report its end; the answer waits for the microphone at most 12 s.
    this.endUtterance(m, u, 'interrupted', null);
    const r = await Promise.race([u.finished, sleep(12_000).then(() => ({ utterance_id: u.id, state: 'interrupted', error: 'the microphone was still being muted' }))]);
    return { meeting_id: id, stopped: true, ...r };
  }

  async endSpeech(m) {
    await this.stopAck(m);
    const u = m.speech;
    if (!u) return;
    u.cancelled = true;
    u.wake?.();
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
    // The agent decides now: speaking leaves the microphone as it is. Said inside the page operation, so that a retry of
    // muting again queued behind it (keepMuting) already sees it.
    const r = await this.page(m, async (p) => {
      const s = await m.platform.setMic(p, !on);
      m.speechUnmuted = false;
      m.muteError = null;
      return s;
    });
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

  // The finished recording of the tenant's meeting (also one of an earlier run, not in memory any more): its file and
  // size. Not another tenant's, not while it is being written, not a deleted one.
  recordingFile(tenant, id) {
    if (!ID_RE.test(String(id))) throw new Error(`no recording for meeting ${id}`);
    const m = this.active.get(id) || this.ended.get(id);
    if (m && m.tenant !== tenant) throw new Error(`no recording for meeting ${id}`);
    if (m && (m.rec || m.stopping) && this.active.has(id)) throw new Error(`meeting ${id} is still recording; call recording_get once it has ended (meeting_leave) or its recording was stopped without delete`);
    if (m?.deleted) throw new Error(`the recording of meeting ${id} was deleted`);
    const file = this.file(tenant, id);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st?.size) throw new Error(`no recording for meeting ${id}`);
    // Not in memory (a run before a restart): the file may still be written by a recorder that outlived Bosun.
    if (!m && this.now() - st.mtimeMs < ORPHAN_QUIET_MS) throw new Error(`the recording of meeting ${id} was written to a moment ago (an earlier run); try again in a minute`);
    return { file, bytes: st.size, seconds: m ? Math.round(m.recMs / 1000) : null };
  }

  // recording_get: a one-time GET URL for the recording.
  recordingGet(tenant, id) {
    const r = this.recordingFile(tenant, id);
    return { ...r, secret: this.links.issue(tenant, id) };
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
    if (existed || m) this.links.revoke(tenant, id); // only the tenant's own
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
