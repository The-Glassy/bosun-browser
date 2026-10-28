// MCPL push events: manifest at initialize, grant via featureSets/update, push/event only where granted, queueing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { startBosun, connect, until, sleep, TOKEN_B } from './helpers.mjs';
import { FEATURE_SET, NEEDS_HUMAN, WATCH_SET, WATCH_CHANGED, MEETING_SET, MEETING_TAGS, DOWNLOAD_SET, MANIFEST } from '../src/events.mjs';

let svc;
before(async () => { svc = await startBosun({ KEEPALIVE: '0' }); });
after(async () => { await svc.stop(); });

const MCPL = { experimental: { mcpl: { version: '0.5', pushEvents: true } } };
const ALL = { enabled: ['*'], effectiveCapabilities: ['tools', 'pushEvents'] };
const event = (profile = 'shop') => ({ tenant: 'alice', profile, url: 'https://shop.example/account', kind: 'logged_out', reason: 'text not found' });

// An MCPL host: answers push/event and records it.
async function host({ token, capabilities = MCPL, accept = true } = {}) {
  const c = await connect(svc, token, { capabilities });
  c.pushes = [];
  c.setRequestHandler(z.object({ method: z.literal('push/event'), params: z.any() }), async (r) => { c.pushes.push(r.params); return { accepted: accept }; });
  c.grant = (params) => c.request({ method: 'featureSets/update', params }, z.any());
  return c;
}

test('the manifest declares bosun.handoff and bosun.watch with pushEvents; mcpl/manifest returns it', async () => {
  const c = await host();
  const m = c.getServerCapabilities().experimental.mcpl;
  assert.equal(m.pushEvents, true);
  assert.deepEqual(Object.keys(m.featureSets), [FEATURE_SET, WATCH_SET, MEETING_SET, DOWNLOAD_SET]);
  assert.deepEqual(Object.keys(m.featureSets[MEETING_SET].tagOntology.tags), Object.values(MEETING_TAGS));
  assert.deepEqual(m.featureSets[FEATURE_SET].uses, ['pushEvents']);
  assert.deepEqual(m.featureSets[WATCH_SET].uses, ['pushEvents']);
  assert.ok(m.featureSets[WATCH_SET].tagOntology.tags[WATCH_CHANGED]);
  assert.deepEqual(await c.request({ method: 'mcpl/manifest' }, z.any()), m);
  await c.close();
});

test('push/event goes to a granted MCPL connection of the tenant only, with tags, origin and text', async () => {
  const a = await host();
  const plain = await connect(svc); // plain MCP client of the same tenant
  plain.pushes = [];
  plain.fallbackRequestHandler = async (r) => { plain.pushes.push(r); return {}; };
  const b = await host({ token: TOKEN_B }); // other tenant
  const receipt = await a.grant(ALL);
  assert.deepEqual(receipt, { accepted: true, unavailableFeatures: [], notes: [] });
  await b.grant(ALL);
  await svc.events.needsHuman(event());
  await until(() => a.pushes.length === 1);
  const p = a.pushes[0];
  assert.equal(p.featureSet, FEATURE_SET);
  assert.match(p.eventId, /^bosun:[0-9a-f-]{36}$/);
  assert.ok(!Number.isNaN(Date.parse(p.timestamp)));
  assert.deepEqual(p.tags, [NEEDS_HUMAN, 'bosun:source=keepalive', 'bosun:reason=logged-out', 'bosun:profile=shop']);
  assert.deepEqual(p.origin, { server: 'bosun', source: 'keepalive', profile: 'shop', url: 'https://shop.example/account', reason: 'text not found' });
  assert.match(p.payload.content[0].text, /profile "shop" is logged out \(text not found\) at https:\/\/shop\.example\/account.*request_human/);
  await sleep(100);
  assert.equal(b.pushes.length, 0);
  assert.equal(plain.pushes.length, 0);
  await Promise.all([a.close(), b.close(), plain.close()]);
});

test('no push before the grant, or without pushEvents, or with the feature set disabled; a notification cannot widen', async () => {
  const c = await host();
  const send = async () => { await svc.events.needsHuman(event()); await sleep(100); };
  await send(); // before featureSets/update: nothing is granted
  for (const g of [{ effectiveCapabilities: ['tools'] }, { effectiveCapabilities: ['pushEvents'], disabled: [FEATURE_SET] }, { enabled: ['other.set'], effectiveCapabilities: ['pushEvents'] }]) {
    const r = await c.grant(g);
    assert.equal(r.accepted, true);
    await send();
  }
  assert.equal(c.pushes.length, 0);
  await c.notification({ method: 'featureSets/update', params: ALL });
  await send();
  assert.equal(c.pushes.length, 0);
  // Overlapping allow/deny is malformed (also through wildcards): refused, nothing granted.
  for (const [eff, den] of [[['pushEvents'], ['pushEvents']], [['*'], ['pushEvents']], [['pushEvents'], ['*']], [['push*', 'pushEvents'], ['pushEvents']]]) {
    await assert.rejects(c.grant({ effectiveCapabilities: eff, deniedCapabilities: den }), /overlap/, JSON.stringify([eff, den]));
  }
  // The queued events arrive once the host grants (bounded queue).
  await c.grant({ effectiveCapabilities: ['p*', 'pushEvents'] });
  await until(() => c.pushes.length === 5);
  // A narrowing notification stops further pushes.
  await c.notification({ method: 'featureSets/update', params: { effectiveCapabilities: ['tools'] } });
  await sleep(50);
  await send();
  assert.equal(c.pushes.length, 5);
  await c.close();
  svc.events.pending.clear();
});

test('an event while no agent is connected waits for the next MCPL connection; a refused push stays queued', async () => {
  svc.events.pending.clear();
  assert.equal(await svc.events.needsHuman(event('later')), false);
  const refusing = await host({ accept: false });
  await refusing.grant(ALL);
  await sleep(200);
  assert.equal(refusing.pushes.length, 1); // offered, refused
  await refusing.close();
  const c = await host();
  await c.grant(ALL);
  await until(() => c.pushes.length === 1);
  assert.match(c.pushes[0].payload.content[0].text, /profile "later"/);
  assert.equal(svc.events.pending.get('alice'), undefined);
  await c.close();
});

test('the queue per tenant is bounded', async () => {
  svc.events.pending.clear();
  for (let i = 0; i < 30; i++) await svc.events.needsHuman(event(`p${i}`));
  assert.equal(svc.events.pending.get('alice').length, 20);
  assert.match(svc.events.pending.get('alice')[0].params.payload.content[0].text, /"p10"/);
  svc.events.pending.clear();
});

test('wildcard overlap in a request or notification clears an existing grant', async () => {
  svc.events.pending.clear();
  const c = await host();
  await c.grant(ALL);
  await c.notification({ method: 'featureSets/update', params: { effectiveCapabilities: ['*'], deniedCapabilities: ['pushEvents'] } });
  await sleep(50);
  await svc.events.needsHuman(event());
  await sleep(100);
  assert.equal(c.pushes.length, 0);
  await c.close();
  svc.events.pending.clear();
});

test('a connection attaching while a delivery is failing still gets the event', async () => {
  const { EventBus } = await import('../src/events.mjs');
  const bus = new EventBus();
  let fail;
  bus.attach('t', () => new Promise((r) => { fail = () => r(false); })); // old connection, about to drop
  const p = bus.publish('t', { eventId: 'x' });
  await until(() => fail);
  const got = [];
  bus.attach('t', async (params) => { got.push(params.eventId); return true; }); // its replacement
  fail();
  await p;
  await until(() => got.length === 1);
  assert.equal(bus.pending.size, 0);
});

test('watch-changed goes out under bosun.watch only: a host that enabled just bosun.handoff gets it once it grants bosun.watch', async () => {
  svc.events.pending.clear();
  const c = await host();
  const receipt = await c.grant({ enabled: [FEATURE_SET], effectiveCapabilities: ['pushEvents'] });
  assert.deepEqual(receipt, { accepted: true, unavailableFeatures: [], notes: [] }); // not asked for, so not degraded
  const change = { tenant: 'alice', profile: 'wh', label: 'willhaben messages', old: 43, new: 45, url: 'https://www.willhaben.at/iad/myprofile/chat' };
  assert.equal(await svc.events.watchChanged(change), false);
  assert.equal(await svc.events.needsHuman(event()), true); // the handoff set still works
  await until(() => c.pushes.length === 1);
  assert.equal(c.pushes[0].featureSet, FEATURE_SET);
  // Asking for bosun.watch without pushEvents: reported as unavailable.
  assert.deepEqual((await c.grant({ enabled: [WATCH_SET], effectiveCapabilities: ['tools'] })).unavailableFeatures,
    [{ featureSet: WATCH_SET, missingCapabilities: ['pushEvents'], effect: 'disabled' }]);
  // The new grant offers the queued event again.
  await c.grant({ enabled: ['bosun.*'], effectiveCapabilities: ['pushEvents'] }); // a pattern works too
  await until(() => c.pushes.length === 2);
  const p = c.pushes[1];
  assert.equal(p.featureSet, WATCH_SET);
  assert.match(p.eventId, /^bosun:[0-9a-f-]{36}$/);
  assert.deepEqual(p.tags, [WATCH_CHANGED, 'bosun:source=keepalive', 'bosun:profile=wh']);
  assert.deepEqual(p.origin, { server: 'bosun', source: 'keepalive', profile: 'wh', label: 'willhaben messages', old: 43, new: 45, url: change.url });
  assert.match(p.payload.content[0].text, /watch "willhaben messages" on profile "wh" changed: 43 -> 45/);
  await until(() => svc.events.pending.get('alice') === undefined); // once Bosun has the host's answer, not just sent it
  await c.close();
});

test('meeting events go out under bosun.meeting: chat, opt-out, an announcement that fell short, and the end with a resource_link to the recording', async () => {
  svc.events.pending.clear();
  const c = await host();
  await c.grant({ enabled: [MEETING_SET], effectiveCapabilities: ['pushEvents'] });
  const base = { tenant: 'alice', meeting_id: 'm0123456789ab', platform: 'meet' };
  await svc.events.meeting('chat', { ...base, sender: 'Alex Example', text: 'Hello' });
  await svc.events.meeting('optout', { ...base, sender: 'Alex Example', text: 'please do not record', left: true });
  const recording = { path: '/data/recordings/alice/m0123456789ab.ogg', uri: 'file:///data/recordings/alice/m0123456789ab.ogg', bytes: 4096, mime_type: 'audio/ogg', seconds: 60 };
  await svc.events.meeting('ended', { ...base, reason: 'left', duration_s: 61, recording, bytes: 4096 });
  const failures = [{ to: 'everyone', reason: 'chat-restricted', error: "the Zoom chat can't be sent to everyone" }, { to: 'host', reason: 'host-unreachable', error: 'no Host and co-hosts' }];
  await svc.events.meeting('announce', { ...base, platform: 'zoom', mode: 'chat', sent_to: 'failed', reason: 'chat-restricted', error: failures[0].error, failures });
  await until(() => c.pushes.length === 4);
  const [chat, optout, ended, announce] = c.pushes;
  for (const p of c.pushes) assert.equal(p.featureSet, MEETING_SET);
  assert.deepEqual(chat.tags, [MEETING_TAGS.chat, 'bosun:meeting=m0123456789ab', 'bosun:platform=meet']);
  assert.deepEqual(chat.origin, { server: 'bosun', source: 'meeting', meeting_id: 'm0123456789ab', platform: 'meet', sender: 'Alex Example', text: 'Hello' });
  assert.equal(optout.tags[0], MEETING_TAGS.optout);
  assert.match(optout.payload.content[0].text, /stopped and deleted and Bosun left/);
  assert.equal(ended.tags[0], MEETING_TAGS.ended);
  assert.deepEqual(ended.origin.recording, recording);
  assert.deepEqual(ended.payload.content[1], { type: 'resource_link', uri: recording.uri, name: 'm0123456789ab.ogg', mimeType: 'audio/ogg', size: 4096 });
  assert.deepEqual(announce.tags, [MEETING_TAGS.announce, 'bosun:meeting=m0123456789ab', 'bosun:platform=zoom']);
  assert.deepEqual([announce.origin.mode, announce.origin.sent_to, announce.origin.reason, announce.origin.failures], ['chat', 'failed', 'chat-restricted', failures]);
  assert.match(announce.payload.content[0].text, /could not be posted in the chat \(chat-restricted: .*\)\. Bosun records anyway/);
  assert.ok(MANIFEST.featureSets[MEETING_SET].tagOntology.tags[MEETING_TAGS.announce]);
  await c.close();
});
