// MCPL push events (spec §6 feature sets, §9 push/event, §16 tags) for things that need the agent's attention while
// no tool call is running: a kept-alive profile that is logged out or stuck at a bot check (feature set
// bosun.handoff), a watched value that changed on a keepalive visit (feature set bosun.watch), what happens in a
// meeting Bosun attends: chat messages, an opt-out, the end with the recording (feature set bosun.meeting), and a
// download that finished or was refused (feature set bosun.download).
// A connection receives push/event only if its client asked for MCPL at initialize (capabilities.experimental.mcpl)
// and the host's featureSets/update Request granted pushEvents with the event's feature set enabled. Events for a
// tenant with no such connection wait (bounded) for the next one.
//
// MCPL channels (spec §14): a meeting Bosun is in is a channel bosun:meeting:<id> (bidirectional), registered with
// every connection of the tenant whose grant has channels.register. What is said in the meeting goes to the host as
// channels/incoming (channels.incoming); what the host publishes to the channel (channels/publish, channels.publish)
// is spoken there; channels/outgoing/chunk and complete (channels.streaming) are taken too (spoken only when the
// tenant's speech settings say so: the spec has publish as the delivery). Channels are never queued for later: a
// connection that comes later is told about the channels open then.
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { z } from 'zod';

export const FEATURE_SET = 'bosun.handoff';
export const NEEDS_HUMAN = 'bosun:needs-human';
export const WATCH_SET = 'bosun.watch';
export const WATCH_CHANGED = 'bosun:watch-changed';
export const MEETING_SET = 'bosun.meeting';
export const MEETING_TAGS = {
  chat: 'bosun:meeting-chat', optout: 'bosun:meeting-optout', ended: 'bosun:meeting-ended', announce: 'bosun:meeting-announce',
  transcript: 'bosun:meeting-transcript', 'transcript-stopped': 'bosun:meeting-transcript-stopped', speech: 'bosun:meeting-speech',
  'mic-open': 'bosun:meeting-mic-open',
};
export const CHANNEL_PREFIX = 'bosun:meeting:';
export const DOWNLOAD_SET = 'bosun.download';
export const DOWNLOAD = 'bosun:download';
export const MANIFEST = {
  version: '0.5',
  pushEvents: true,
  channels: { register: true, incoming: true, publish: true, streaming: true },
  featureSets: {
    [FEATURE_SET]: {
      description: 'Push events when a human is needed: a kept-alive persistent profile is logged out or stuck at a bot check (then open the profile and call request_human).',
      uses: ['pushEvents'],
      tagOntology: {
        tags: { [NEEDS_HUMAN]: { desc: 'a person has to act in the browser (log in again, solve a check)' } },
        keyed: { 'bosun:source': { values: ['keepalive'] }, 'bosun:reason': { values: ['logged-out', 'bot-check'] }, 'bosun:profile': { open: true } },
      },
    },
    [WATCH_SET]: {
      description: 'Push events when a value watched on a keepalive visit changed (a counter went up, a text differs), e.g. new messages; origin carries profile, label, old, new and url.',
      uses: ['pushEvents'],
      tagOntology: {
        tags: { [WATCH_CHANGED]: { desc: 'a watched value on a kept-alive profile changed' } },
        keyed: { 'bosun:source': { values: ['keepalive'] }, 'bosun:profile': { open: true } },
      },
    },
    [MEETING_SET]: {
      description: 'Push events from a meeting Bosun attends as a notetaker (meeting_join): every chat message, a participant opting out of the recording (recording stopped and deleted), an announcement that reached fewer people than asked (the host only, or nobody), the end of the meeting with a reference to the audio recording; with live_transcript the transcript as it is spoken (partials and finals, only to connections there at the time) and its end; the end of what Bosun said with meeting_speak.',
      uses: ['pushEvents'],
      tagOntology: {
        tags: {
          [MEETING_TAGS.chat]: { desc: 'a chat message in the meeting (origin: meeting_id, sender, text)' },
          [MEETING_TAGS.optout]: { desc: 'someone asked not to be recorded; the recording was stopped and deleted' },
          [MEETING_TAGS.ended]: { desc: 'Bosun left the meeting; origin carries duration and the recording (if any)' },
          [MEETING_TAGS.announce]: { desc: 'the recording announcement reached only the host, or could not be posted (origin: mode, sent_to host|failed, reason, error); Bosun records anyway' },
          [MEETING_TAGS.transcript]: { desc: 'live transcript text (origin: meeting_id, seq, start_s, end_s, text, final, lang, speaker if known); partials (final false) carry the seq their final will have' },
          [MEETING_TAGS['transcript-stopped']]: { desc: 'the live transcript stopped while the meeting goes on (origin: reason daily-cap|error|opted-out|stopped|recording-failed|audio-ended, error)' },
          [MEETING_TAGS.speech]: { desc: 'an utterance of meeting_speak (or of text published to the meeting channel) ended (origin: utterance_id, state done|interrupted|failed, played_s, mic_open when not muted again)' },
          [MEETING_TAGS['mic-open']]: { desc: 'WARNING: Bosun could not mute its microphone again after speaking; it may still be on (origin: mute_error, gave_up when the retries are over). meeting_mute {on: true} takes it over' },
        },
        keyed: { 'bosun:meeting': { open: true }, 'bosun:platform': { values: ['meet', 'zoom'] } },
      },
    },
    [DOWNLOAD_SET]: {
      description: 'Push events when a download a page started has finished (ready to fetch with download_get), was refused (host not allowed, too big, quota) or failed; origin carries download_id, state, filename, size, source_host and reason.',
      uses: ['pushEvents'],
      tagOntology: {
        tags: { [DOWNLOAD]: { desc: 'a download finished, was refused or failed' } },
        keyed: { 'bosun:state': { values: ['ready', 'refused', 'failed'] }, 'bosun:session': { open: true } },
      },
    },
  },
};
const MAX_PENDING = 20; // per tenant
const PUSH_TIMEOUT_MS = 15_000;

// needs-human from a keepalive visit -> push/event params.
export function needsHumanEvent({ profile, url, reason, kind }) {
  const what = kind === 'bot_check' ? 'is stuck at a bot check' : `is logged out (${reason})`;
  return {
    featureSet: FEATURE_SET,
    eventId: `bosun:${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    tags: [NEEDS_HUMAN, 'bosun:source=keepalive', `bosun:reason=${kind === 'bot_check' ? 'bot-check' : 'logged-out'}`, `bosun:profile=${profile}`],
    origin: { server: 'bosun', source: 'keepalive', profile, url, reason: kind === 'bot_check' ? 'bot check' : reason },
    payload: { content: [{ type: 'text', text: `Bosun keepalive: profile "${profile}" ${what} at ${url}. Open a session with this profile, navigate there and call request_human so your human can log in again.` }] },
  };
}

// A watched value changed on a keepalive visit -> push/event params. old/new are the extracted values only.
export function watchEvent({ profile, label, old, new: now, url }) {
  const show = (v) => (v === null ? 'nothing' : JSON.stringify(v));
  return {
    featureSet: WATCH_SET,
    eventId: `bosun:${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    tags: [WATCH_CHANGED, 'bosun:source=keepalive', `bosun:profile=${profile}`],
    origin: { server: 'bosun', source: 'keepalive', profile, label, old, new: now, url },
    payload: { content: [{ type: 'text', text: `Bosun watch "${label}" on profile "${profile}" changed: ${show(old)} -> ${show(now)} (${url}).` }] },
  };
}

// Meeting events -> push/event params. kind: chat | optout | announce | ended | transcript | transcript-stopped |
// speech; data goes into origin.
export function meetingEvent(kind, { meeting_id, platform, ...data }) {
  const text = kind === 'chat' ? `Meeting ${meeting_id} chat — ${data.sender || 'someone'}: ${data.text}`
    : kind === 'transcript' ? `Meeting ${meeting_id} ${data.final ? 'said' : 'is saying'} (#${data.seq}, ${data.start_s}-${data.end_s} s${data.speaker ? `, ${data.speaker}` : ''}): ${data.text}`
    : kind === 'transcript-stopped' ? `Meeting ${meeting_id}: the live transcript stopped (${data.reason}${data.error ? `: ${data.error}` : ''}); the meeting goes on.`
    : kind === 'speech' ? `${data.mute_error ? `WARNING: Bosun's microphone may still be ON in meeting ${meeting_id}. ` : ''}Meeting ${meeting_id}: utterance ${data.utterance_id} ${data.state} after ${data.played_s} s${data.error ? ` (${data.error})` : ''}.${data.mute_error ? ` Not muted again: ${data.mute_error}.` : ''}`
    : kind === 'mic-open' ? `WARNING: Bosun's microphone may still be ON in meeting ${meeting_id}: ${data.mute_error}.${data.gave_up ? ' Bosun stopped retrying.' : ' Bosun keeps trying to mute it.'} meeting_mute {on: true} or meeting_leave if it must be off.`
    : kind === 'optout' ? `Meeting ${meeting_id}: ${data.sender || 'someone'} asked not to be recorded ("${data.text}"). The recording was stopped and deleted${data.left ? ' and Bosun left the meeting' : ''}.`
    : kind === 'announce' ? `Meeting ${meeting_id}: the recording announcement ${data.sent_to === 'host' ? 'went to the host only' : 'could not be posted in the chat'} (${data.reason}: ${data.error}). Bosun records anyway; a request not to be recorded in the chat still stops it.`
    : `Meeting ${meeting_id} ended for Bosun (${data.reason}) after ${data.duration_s} s.${data.recording ? ` Recording: ${data.recording.bytes} bytes, ${data.recording.path}.` : ' No recording.'}`;
  const content = [{ type: 'text', text }];
  if (kind === 'ended' && data.recording) {
    content.push({ type: 'resource_link', uri: data.recording.uri, name: `${meeting_id}.ogg`, mimeType: 'audio/ogg', size: data.recording.bytes });
  }
  return {
    featureSet: MEETING_SET,
    eventId: `bosun:${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    tags: [MEETING_TAGS[kind], `bosun:meeting=${meeting_id}`, `bosun:platform=${platform}`],
    origin: { server: 'bosun', source: 'meeting', meeting_id, platform, ...data },
    payload: { content },
  };
}

// A download settled -> push/event params. d: what download_wait returns (Downloads.info) plus session.
export function downloadEvent({ session, ...d }) {
  const text = d.state === 'ready'
    ? `Bosun download ready: "${d.filename}" (${d.size} bytes, ${d.mime}, from ${d.source_host}) in session ${session}. Fetch it with download_get { download_id: "${d.download_id}" } within ${d.expires_in_min} min.`
    : `Bosun download ${d.state}: "${d.filename}" from ${d.source_host} in session ${session}: ${d.reason}`;
  return {
    featureSet: DOWNLOAD_SET,
    eventId: `bosun:${crypto.randomUUID()}`,
    timestamp: new Date().toISOString(),
    tags: [DOWNLOAD, `bosun:state=${d.state}`, `bosun:session=${session}`],
    origin: { server: 'bosun', source: 'download', session, ...d },
    payload: { content: [{ type: 'text', text }] },
  };
}

// Delivery per tenant is serialized: an event waits in `pending` until a connection accepts it; every attach and
// every new event triggers a pass over what is pending, so a connection that attaches while a delivery is in flight
// still gets offered what that delivery failed to place. A connection that refused an event isn't asked again.
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.sinks = new Map(); // tenant -> Set<sink(params) => Promise<boolean>>
    this.pending = new Map(); // tenant -> [{params, refused: WeakSet<sink>}]
    this.passes = new Map(); // tenant -> tail of the delivery chain
    this.channels = new Map(); // tenant -> Map<channel id, {descriptor, handler}>
    this.channelConns = new Map(); // tenant -> Set<connection channel side {add, remove, incoming, ready}>
  }

  // A channel of the tenant (a meeting): announced to its connections now and to those that come later. handler:
  // {publish(text, params) -> {messageId}, chunk(params), complete(params)}, called for what the host sends to it.
  openChannel(tenant, descriptor, handler) {
    if (!this.channels.has(tenant)) this.channels.set(tenant, new Map());
    this.channels.get(tenant).set(descriptor.id, { descriptor, handler });
    for (const c of this.channelConns.get(tenant) || []) c.add(descriptor);
  }

  closeChannel(tenant, id) {
    if (!this.channels.get(tenant)?.delete(id)) return;
    for (const c of this.channelConns.get(tenant) || []) c.remove(id);
  }

  channel(tenant, id) { return this.channels.get(tenant)?.get(id) || null; }

  // A connection's channel side. Returns detach().
  attachChannels(tenant, conn) {
    if (!this.channelConns.has(tenant)) this.channelConns.set(tenant, new Set());
    this.channelConns.get(tenant).add(conn);
    for (const { descriptor } of this.channels.get(tenant)?.values() || []) conn.add(descriptor);
    return () => this.channelConns.get(tenant)?.delete(conn);
  }

  // Whether some connection has the channel registered and may take incoming messages on it.
  channelReady(tenant, id) { return [...(this.channelConns.get(tenant) || [])].some((c) => c.ready(id)); }

  // channels/incoming to every connection that has the channel; true once one of them accepted all of messages.
  async channelIncoming(tenant, id, messages) {
    const conns = [...(this.channelConns.get(tenant) || [])].filter((c) => c.ready(id));
    const r = await Promise.all(conns.map((c) => c.incoming(id, messages).catch(() => false)));
    return r.some(Boolean);
  }

  // A connection that may receive pushes. Returns detach().
  attach(tenant, sink) {
    if (!this.sinks.has(tenant)) this.sinks.set(tenant, new Set());
    this.sinks.get(tenant).add(sink);
    this.deliver(tenant).catch(() => {});
    return () => this.sinks.get(tenant)?.delete(sink);
  }

  // Resolves true once some connection of the tenant accepted it, false if it stays pending.
  async publish(tenant, params) {
    const q = this.pending.get(tenant) || [];
    const item = { params, refused: new WeakSet() };
    q.push(item);
    if (q.length > MAX_PENDING) q.shift();
    this.pending.set(tenant, q);
    await this.deliver(tenant);
    return !this.pending.get(tenant)?.includes(item);
  }

  deliver(tenant) {
    const run = (this.passes.get(tenant) || Promise.resolve()).then(() => this.pass(tenant));
    const tail = run.catch(() => {});
    this.passes.set(tenant, tail);
    tail.then(() => { if (this.passes.get(tenant) === tail) this.passes.delete(tenant); });
    return run;
  }

  async pass(tenant) {
    for (const item of [...(this.pending.get(tenant) || [])]) {
      const sinks = [...(this.sinks.get(tenant) || [])].filter((s) => !item.refused.has(s));
      const results = await Promise.all(sinks.map((s) => s(item.params).catch(() => false)));
      results.forEach((ok, i) => { if (!ok) item.refused.add(sinks[i]); });
      if (results.some(Boolean)) {
        const q = this.pending.get(tenant) || [];
        const i = q.indexOf(item);
        if (i >= 0) q.splice(i, 1);
        if (!q.length) this.pending.delete(tenant);
      }
    }
  }

  // From the keepalive scheduler: e = {tenant, profile, url, reason, kind}.
  needsHuman(e) {
    this.emit('needs-human', e);
    return this.publish(e.tenant, needsHumanEvent(e));
  }

  // From the meeting manager: kind chat | optout | announce | ended | speech | mic-open, e = {tenant, meeting_id, platform, ...}.
  meeting(kind, { tenant, ...e }) {
    this.emit(`meeting-${kind}`, { tenant, ...e });
    return this.publish(tenant, meetingEvent(kind, e));
  }

  // Live meeting events (transcript text): offered to the tenant's connections now, never kept for later.
  meetingLive(kind, { tenant, ...e }) {
    this.emit(`meeting-${kind}`, { tenant, ...e });
    const params = meetingEvent(kind, e);
    return Promise.all([...(this.sinks.get(tenant) || [])].map((s) => s(params).catch(() => false))).then((r) => r.some(Boolean));
  }

  // From the downloads: info = Downloads.info(f) plus session.
  download(tenant, info) {
    this.emit('download', { tenant, ...info });
    return this.publish(tenant, downloadEvent(info));
  }

  // From a keepalive visit's watch: e = {tenant, profile, label, old, new, url}.
  watchChanged(e) {
    this.emit('watch-changed', e);
    return this.publish(e.tenant, watchEvent(e));
  }
}

// Pattern match for effectiveCapabilities entries: exact paths, '*', or 'prefix.*'. `cap` may itself be a pattern.
const grants = (patterns, cap) => patterns.some((p) => p === cap || p === '*' || (p.endsWith('.*') && cap.startsWith(p.slice(0, -1))));
// A capability path granted by the effective grant (MCPL §5.4): full paths, segment by segment, where `*` matches
// exactly one segment and the segment counts are equal (a bare `*` grants only depth-1 paths, `channels.*` grants
// `channels.publish` and nothing deeper).
const capGranted = (patterns, path) => {
  const want = path.split('.');
  return patterns.some((p) => { const s = p.split('.'); return s.length === want.length && s.every((x, i) => x === '*' || x === want[i]); });
};
// Two patterns overlap when some capability path matches both.
const overlaps = (a, b) => grants([a], b) || grants([b], a);

// MCPL on one MCP connection: the manifest is advertised statically (plain MCP clients ignore experimental); the
// grant comes from featureSets/update. Attaches the connection to the bus once push is allowed for some feature set;
// each event is only offered for its own feature set.
export function mcplConnection(server, { bus, tenant }) {
  let grant = null; // {caps: string[], enabled: Set<string>} after a featureSets/update Request
  let detach = null;
  const wantsMcpl = () => !!server.getClientCapabilities()?.experimental?.mcpl;
  const allowed = (set) => !!grant && wantsMcpl() && capGranted(grant.caps, 'pushEvents') && grant.enabled.has(set);
  const pushAllowed = () => Object.keys(MANIFEST.featureSets).some(allowed);
  const sink = async (params) => {
    if (!allowed(params.featureSet)) return false;
    const r = await server.request({ method: 'push/event', params }, z.object({ accepted: z.boolean() }).passthrough(), { timeout: PUSH_TIMEOUT_MS });
    return r.accepted === true || r.reason === 'duplicate';
  };
  const apply = (p, form) => {
    const caps = Array.isArray(p?.effectiveCapabilities) ? p.effectiveCapabilities.filter((c) => typeof c === 'string') : [];
    const denied = Array.isArray(p?.deniedCapabilities) ? p.deniedCapabilities : [];
    if (caps.some((c) => denied.some((d) => typeof d === 'string' && overlaps(c, d)))) { grant = { caps: [], enabled: new Set() }; return false; } // malformed: fail closed
    // Hosts resolve their recipe's patterns and send names; '*' and 'bosun.*' are accepted too.
    const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null);
    const selected = names(p?.enabled), disabled = names(p?.disabled) || [];
    const wanted = Object.keys(MANIFEST.featureSets).filter((n) => (selected === null || grants(selected, n)) && !grants(disabled, n));
    const enabled = new Set(wanted.filter((n) => MANIFEST.featureSets[n].uses.every((u) => capGranted(caps, u))));
    if (form === 'notification') { // a notification can narrow the grant, never widen it
      if (!grant) return true;
      grant = { caps: grant.caps.filter((c) => grants(caps, c)), enabled: new Set([...grant.enabled].filter((n) => enabled.has(n))) };
    } else grant = { caps, enabled, wanted };
    return true;
  };
  // A new grant (Request) re-attaches with a fresh sink: events refused under the old grant (say, a feature set that
  // was not enabled yet) are offered again.
  const chans = channelSide(server, { bus, tenant, can: (cap) => !!grant && wantsMcpl() && capGranted(grant.caps, cap) });
  const update = (regrant = false) => {
    if (pushAllowed() && (!detach || regrant)) { detach?.(); detach = bus.attach(tenant, (p) => sink(p)); }
    else if (!pushAllowed() && detach) { detach(); detach = null; }
    chans.sync();
  };
  server.setRequestHandler(z.object({ method: z.literal('featureSets/update'), params: z.any().optional() }), async (req) => {
    if (!apply(req.params, 'request')) { update(); throw Object.assign(new Error('effectiveCapabilities and deniedCapabilities overlap; nothing is granted'), { code: -32602 }); }
    update(true);
    // Feature sets the host asked for but did not grant the capabilities of (ones it left out are simply off).
    const unavailableFeatures = grant.wanted.filter((n) => !grant.enabled.has(n))
      .map((featureSet) => ({ featureSet, missingCapabilities: MANIFEST.featureSets[featureSet].uses.filter((u) => !capGranted(grant.caps, u)), effect: 'disabled' }));
    return { accepted: true, unavailableFeatures, notes: [], ...(unavailableFeatures.length ? { mode: 'degraded' } : {}) };
  });
  server.setNotificationHandler(z.object({ method: z.literal('featureSets/update'), params: z.any().optional() }), async (n) => { apply(n.params, 'notification'); update(); }); // malformed: grant already cleared
  server.setRequestHandler(z.object({ method: z.literal('mcpl/manifest'), params: z.any().optional() }), async () => MANIFEST);
  return { close: () => { detach?.(); detach = null; chans.close(); }, get pushAllowed() { return pushAllowed(); }, channels: chans };
}

const REGISTER_TIMEOUT_MS = 15_000;
const INCOMING_TIMEOUT_MS = 15_000;
const textOf = (content) => (Array.isArray(content) ? content : []).filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
const channelError = (code, message, data) => Object.assign(new Error(message), { code, ...(data ? { data } : {}) });

// One connection's side of the tenant's channels: registered with the host while the grant has channels.register (and
// taken back with channels/changed when a meeting ends or the grant narrows); channels/incoming only on channels the
// host accepted, checked against the grant as it is now; channels/publish, chunk and complete only for channels
// registered on this connection.
function channelSide(server, { bus, tenant, can }) {
  const registered = new Set(); // channel ids the host accepted on this connection
  let detach = null;
  let gen = 0; // bumped when the grant loses channels.register: a registration answered after that is taken back
  let queue = Promise.resolve(); // register and remove go out in order
  const later = (fn) => { queue = queue.then(fn).catch(() => {}); return queue; };
  const unregister = (id) => server.notification({ method: 'channels/changed', params: { added: [], removed: [id], updated: [] } }).catch(() => {});
  const conn = {
    add: (d) => later(async () => {
      await new Promise((r) => setTimeout(r, 0)); // after the answer to the featureSets/update that granted it
      if (!can('channels.register') || registered.has(d.id) || !bus.channel(tenant, d.id)) return;
      const g = gen;
      const r = await server.request({ method: 'channels/register', params: { channels: [d] } }, z.object({}).passthrough(), { timeout: REGISTER_TIMEOUT_MS });
      const item = Array.isArray(r.results) ? r.results.find((x) => x?.id === d.id) : null;
      const ok = item ? item.accepted === true : Array.isArray(r.registered) && r.registered.includes(d.id);
      if (!ok) return;
      // The meeting ended, or the grant lost channels.register, while the host answered: taken back at once.
      if (g === gen && can('channels.register') && bus.channel(tenant, d.id)) registered.add(d.id);
      else await unregister(d.id);
    }),
    remove: (id) => later(async () => { if (registered.delete(id)) await unregister(id); }),
    ready: (id) => registered.has(id) && can('channels.incoming'),
    async incoming(id, messages) {
      if (!conn.ready(id)) return false;
      const r = await server.request({ method: 'channels/incoming', params: { messages } }, z.object({}).passthrough(), { timeout: INCOMING_TIMEOUT_MS });
      const results = Array.isArray(r.results) ? r.results : [];
      return messages.every((m) => results.some((x) => x?.messageId === m.messageId && x.accepted === true));
    },
  };
  // The grant changed: attach while channels.register is granted; channels registered under a grant that no longer
  // has it are taken back.
  const sync = () => {
    if (can('channels.register')) { if (!detach) detach = bus.attachChannels(tenant, conn); }
    else if (detach) { gen++; detach(); detach = null; for (const id of [...registered]) conn.remove(id); }
  };
  // What the host sends to a channel: only to one registered here, of this tenant, with the capability granted now.
  const target = (p, cap) => {
    if (!can(cap)) throw channelError(-32002, `capability denied: ${cap}`, { capability: cap });
    const id = typeof p?.channelId === 'string' ? p.channelId : '';
    const ch = registered.has(id) ? bus.channel(tenant, id) : null;
    if (!ch) throw channelError(-32023, `unknown channel ${id.slice(0, 80)}`);
    return ch;
  };
  const publish = async (p) => {
    const ch = target(p, 'channels.publish');
    const r = await ch.handler.publish(textOf(p.content), p);
    return { delivered: true, messageId: r.messageId };
  };
  const any = z.object({}).passthrough().optional();
  server.setRequestHandler(z.object({ method: z.literal('channels/publish'), params: any }), async (req) => publish(req.params));
  server.setNotificationHandler(z.object({ method: z.literal('channels/publish'), params: any }), async (n) => { await publish(n.params).catch(() => {}); });
  for (const [method, fn] of [['channels/outgoing/chunk', 'chunk'], ['channels/outgoing/complete', 'complete']]) {
    server.setNotificationHandler(z.object({ method: z.literal(method), params: any }), async (n) => {
      try { target(n.params, 'channels.streaming').handler[fn]?.(n.params); } catch {}
    });
  }
  server.setRequestHandler(z.object({ method: z.literal('channels/list'), params: any }), async () => {
    if (!can('channels.register')) throw channelError(-32002, 'capability denied: channels.register', { capability: 'channels.register' });
    return { channels: [...registered].map((id) => bus.channel(tenant, id)?.descriptor).filter(Boolean) };
  });
  return { sync, close: () => { detach?.(); detach = null; registered.clear(); }, registered };
}
