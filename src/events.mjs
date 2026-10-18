// MCPL push events (spec §6 feature sets, §9 push/event, §16 tags) for things that need the agent's attention while
// no tool call is running — today: a kept-alive profile that is logged out or stuck at a bot check.
// A connection receives push/event only if its client asked for MCPL at initialize (capabilities.experimental.mcpl)
// and the host's featureSets/update Request granted pushEvents with feature set bosun.handoff enabled. Events for a
// tenant with no such connection wait (bounded) for the next one.
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { z } from 'zod';

export const FEATURE_SET = 'bosun.handoff';
export const NEEDS_HUMAN = 'bosun:needs-human';
export const MANIFEST = {
  version: '0.5',
  pushEvents: true,
  featureSets: {
    [FEATURE_SET]: {
      description: 'Push events when a human is needed: a kept-alive persistent profile is logged out or stuck at a bot check (then open the profile and call request_human).',
      uses: ['pushEvents'],
      tagOntology: {
        tags: { [NEEDS_HUMAN]: { desc: 'a person has to act in the browser (log in again, solve a check)' } },
        keyed: { 'bosun:source': { values: ['keepalive'] }, 'bosun:reason': { values: ['logged-out', 'bot-check'] }, 'bosun:profile': { open: true } },
      },
    },
  },
};
const MAX_PENDING = 20; // per tenant
const PUSH_TIMEOUT_MS = 15_000;

// needs-human from a keepalive visit -> push/event params.
export function pushEvent({ profile, url, reason, kind }) {
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

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.sinks = new Map(); // tenant -> Set<sink(params) => Promise<boolean>>
    this.pending = new Map(); // tenant -> [params]
  }

  // A connection that may receive pushes. Returns detach().
  attach(tenant, sink) {
    if (!this.sinks.has(tenant)) this.sinks.set(tenant, new Set());
    this.sinks.get(tenant).add(sink);
    this.flush(tenant).catch(() => {});
    return () => this.sinks.get(tenant)?.delete(sink);
  }

  // Delivered to every ready connection of the tenant; kept for the next one if none accepted it.
  async publish(tenant, params) {
    const results = await Promise.all([...(this.sinks.get(tenant) || [])].map((s) => s(params).catch(() => false)));
    if (results.some(Boolean)) return true;
    const q = this.pending.get(tenant) || [];
    q.push(params);
    if (q.length > MAX_PENDING) q.shift();
    this.pending.set(tenant, q);
    return false;
  }

  async flush(tenant) {
    const q = this.pending.get(tenant);
    if (!q?.length) return;
    this.pending.delete(tenant);
    for (const p of q) await this.publish(tenant, p);
  }

  // From the keepalive scheduler: e = {tenant, profile, url, reason, kind}.
  needsHuman(e) {
    this.emit('needs-human', e);
    return this.publish(e.tenant, pushEvent(e));
  }
}

// Pattern match for effectiveCapabilities entries: exact paths, '*', or 'prefix.*'.
const grants = (patterns, cap) => patterns.some((p) => p === cap || p === '*' || (p.endsWith('.*') && cap.startsWith(p.slice(0, -1))));

// MCPL on one MCP connection: the manifest is advertised statically (plain MCP clients ignore experimental); the
// grant comes from featureSets/update. Attaches the connection to the bus once push is allowed.
export function mcplConnection(server, { bus, tenant }) {
  let grant = null; // {caps: string[], enabled: Set<string>} after a featureSets/update Request
  let detach = null;
  const wantsMcpl = () => !!server.getClientCapabilities()?.experimental?.mcpl;
  const pushAllowed = () => !!grant && wantsMcpl() && grants(grant.caps, 'pushEvents') && grant.enabled.has(FEATURE_SET);
  const sink = async (params) => {
    if (!pushAllowed()) return false;
    const r = await server.request({ method: 'push/event', params }, z.object({ accepted: z.boolean() }).passthrough(), { timeout: PUSH_TIMEOUT_MS });
    return r.accepted === true || r.reason === 'duplicate';
  };
  const apply = (p, form) => {
    const caps = Array.isArray(p?.effectiveCapabilities) ? p.effectiveCapabilities.filter((c) => typeof c === 'string') : [];
    const denied = Array.isArray(p?.deniedCapabilities) ? p.deniedCapabilities : [];
    if (caps.some((c) => denied.includes(c))) { grant = { caps: [], enabled: new Set() }; return false; } // malformed: fail closed
    const selected = Array.isArray(p?.enabled) ? p.enabled : null;
    const disabled = Array.isArray(p?.disabled) ? p.disabled : [];
    const enabled = new Set(Object.entries(MANIFEST.featureSets)
      .filter(([n, d]) => (selected === null || selected.includes(n) || selected.includes('*')) && !disabled.includes(n) && d.uses.every((u) => grants(caps, u)))
      .map(([n]) => n));
    if (form === 'notification') { // a notification can narrow the grant, never widen it
      if (!grant) return true;
      grant = { caps: grant.caps.filter((c) => grants(caps, c)), enabled: new Set([...grant.enabled].filter((n) => enabled.has(n))) };
    } else grant = { caps, enabled };
    return true;
  };
  const update = () => {
    if (pushAllowed() && !detach) detach = bus.attach(tenant, sink);
    else if (!pushAllowed() && detach) { detach(); detach = null; }
  };
  server.setRequestHandler(z.object({ method: z.literal('featureSets/update'), params: z.any().optional() }), async (req) => {
    if (!apply(req.params, 'request')) { update(); throw Object.assign(new Error('effectiveCapabilities and deniedCapabilities overlap; nothing is granted'), { code: -32602 }); }
    update();
    const unavailableFeatures = Object.keys(MANIFEST.featureSets).filter((n) => !grant.enabled.has(n))
      .map((featureSet) => ({ featureSet, missingCapabilities: MANIFEST.featureSets[featureSet].uses.filter((u) => !grants(grant.caps, u)), effect: 'disabled' }));
    return { accepted: true, unavailableFeatures, notes: [], ...(unavailableFeatures.length ? { mode: 'degraded' } : {}) };
  });
  server.setNotificationHandler(z.object({ method: z.literal('featureSets/update'), params: z.any().optional() }), async (n) => { apply(n.params, 'notification'); update(); });
  server.setRequestHandler(z.object({ method: z.literal('mcpl/manifest'), params: z.any().optional() }), async () => MANIFEST);
  return { close: () => { detach?.(); detach = null; }, get pushAllowed() { return pushAllowed(); } };
}
