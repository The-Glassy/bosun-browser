// Session registry and lifecycle: ownership, capacity, single-flight browser launch, crash handling, idle reaping,
// per-session operation serialization and the handoff state that blinds the agent.
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { clearSensitive, installTracker, notePasswords, passwordTracker } from './redact.mjs';
import { createEngines, claimProfile, unclaimProfile, recordProfileUse } from './engines.mjs';
import { NOT_ALLOWED, PROFILES_REFUSED, policyOf } from './auth.mjs';
import { allowFor, allowsUrl } from './allow.mjs';
import { startTenantProxy } from './proxy.mjs';
import { currentCall, timeoutMessage } from './deadline.mjs';

export const HANDOFF_ACTIVE = 'a human is working in this tab (handoff active) — call handoff_wait first';
const CLOSE_DEADLINE_MS = 10_000; // default; manager.closeDeadlineMs
const NOTE_POLL_MS = 500;
// After a call ran out of time (deadline.mjs): a page that doesn't evaluate 1 this fast counts as wedged; what the
// call started gets this long to stop on a page that still answers before the tab is replaced to stop it; opening
// the replacement tab; what the call started gets this long to fail once its tab is closed.
const PROBE_MS = 3_000;
const SETTLE_MS = 20_000;
const NEW_PAGE_MS = 15_000;
const NEW_PAGE_FIRST_MS = 8_000; // then the stuck tab is closed first, and the rest of NEW_PAGE_MS waited
const CLOSE_SETTLE_MS = 3_000;

// Where a navigation landed, without query and fragment (a challenge page reloads itself with fresh tokens).
export const urlKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return String(u); } };

// Pages the agent (navigate) or a keepalive visit may load: the web only. file:, javascript:, data:, blob:, chrome:,
// about:, view-source:, ftp: … are refused.
export function httpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http:// and https:// URLs are allowed (got ${u.protocol})`);
  return u.href;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

// Browser processes started for a persistent context carry its directory on their command line
// (--user-data-dir=… / -profile …), which is how they're found when a close hangs.
export function procsUsing(dir) {
  const abs = path.resolve(dir);
  try {
    return execFileSync('ps', ['-A', '-ww', '-o', 'pid=,command='], { maxBuffer: 64 << 20 }).toString().split('\n')
      .filter((l) => { const i = `${l} `.indexOf(abs); return i >= 0 && /[\s/]/.test(`${l} `[i + abs.length]); }) // not …/work2 for …/work
      .map((l) => Number(l.trim().split(/\s+/)[0])).filter((p) => p && p !== process.pid);
  } catch { return []; }
}

// Make sure nothing is running on dir any more: SIGKILL what's left and wait until it's gone. false = still alive.
export async function terminate(dir) {
  let pids = procsUsing(dir);
  if (!pids.length) return true;
  for (const p of pids) { try { process.kill(p, 'SIGKILL'); } catch {} }
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    pids = procsUsing(dir);
    if (!pids.length) return true;
  }
  return false;
}

// Password fields are noted as a page loads: by an init script of the context ('init', set up at open), or for
// engines without one in Bosun's world, on every navigation of every frame ('navigate').
async function trackPasswords(page, tracker) {
  if (tracker !== 'navigate') return;
  page.on('framenavigated', (f) => { f.evaluate(passwordTracker).catch(() => {}); });
  await installTracker(page);
}

// FIFO of async jobs with a bound on queued work. Jobs never overlap.
class SerialQueue {
  constructor(max) { this.max = max; this.size = 0; this.tail = Promise.resolve(); }
  run(fn) {
    if (this.size >= this.max) return Promise.reject(new Error('too many queued operations on this session'));
    this.size++;
    const res = this.tail.then(fn);
    const done = () => { this.size--; };
    this.tail = res.then(done, done);
    return res;
  }
}

export class SessionManager {
  constructor(cfg, { live = null, engines = createEngines() } = {}) {
    this.cfg = cfg;
    this.live = live;
    this.engines = engines;
    this.sessions = new Map(); // id -> session
    this.used = 0; // reserved + open + still closing
    this.tenantUse = new Map();
    this.profilesInUse = new Set();
    this.pendingOpens = new Set();
    this.disposals = new Set(); // disposals still closing their context
    this.ownerOpens = new Map(); // owner -> number of opens in progress
    this.goneOwners = new Set(); // disconnected owners that still have opens in progress
    this.closingProfiles = new Map(); // tenant/profile -> disposal still closing it (an open waits for it)
    this.preemptible = new Map(); // tenant/profile -> () => Promise: give the profile up (background keepalive runs)
    this.closed = new Map(); // recently closed id -> {owner, reason}, so the owner learns why (bounded)
    this.closeDeadlineMs = CLOSE_DEADLINE_MS;
    this.stuck = new Set(); // per-session browsers that survived SIGKILL; their slots stay reserved
    this.browserP = null;
    this.launches = 0;
    this.closing = false;
    this.proxies = new Map(); // tenant -> Promise<Playwright proxy options> (per-tenant forward proxy)
    fs.mkdirSync(path.join(cfg.dataDir, 'profiles'), { recursive: true });
    // Temp profiles of ephemeral per-browser sessions: anything left here is from a process that was killed.
    fs.rmSync(path.join(cfg.dataDir, 'tmp'), { recursive: true, force: true });
    if (cfg.idleTimeoutMs > 0) {
      this.reaper = setInterval(() => this.reapIdle(), Math.min(30_000, Math.max(250, cfg.idleTimeoutMs / 4)));
      this.reaper.unref();
    }
  }

  // The shared browser of the shared engine (chromium): launched once, relaunched after it goes away. Only tenants
  // without a host allowlist use it, so it is launched exactly as 0.7.0 launched it; a proxied tenant's sessions
  // each get a browser of their own (engines.mjs open).
  getBrowser(def, bt) {
    if (!this.browserP) {
      this.launches++;
      const p = this.browserP = def.launchShared(bt, this.cfg).then((b) => {
        b.on('disconnected', () => this.onBrowserGone(b, p));
        return b;
      }, (e) => { if (this.browserP === p) this.browserP = null; throw e; });
    }
    return this.browserP;
  }

  onBrowserGone(browser, p) {
    if (this.browserP === p) this.browserP = null; // next open relaunches
    for (const s of this.sessions.values()) if (s.browser === browser) this.dispose(s, 'browser-crashed');
  }

  // media: {args, env} for a meeting's own browser process (see engines.mjs). downloads: the session may keep what
  // its pages download, if the tenant's download allowlist lets it (sessions the agent opens; keepalive visits and
  // meetings never download).
  async open({ owner, tenant, profile, locale, timezone, engine, preempt = true, media = null, downloads = false }) {
    if (this.closing) throw new Error('service is shutting down');
    const def = this.engines.get(engine || this.cfg.engine);
    // Only engines this deployment enabled (FEATURES_ENGINES, plus the default ENGINE).
    if (!this.cfg.engines.includes(def.name)) throw new Error(`engine ${def.name} is not enabled on this service (FEATURES_ENGINES)`);
    if (this.goneOwners.has(owner)) throw new Error('connection closed');
    const ephemeral = policyOf(this.cfg, tenant) === 'ephemeral';
    if (ephemeral && (profile || media)) throw new Error(profile ? PROFILES_REFUSED : NOT_ALLOWED);
    // Only the default engine, which startup checked: another one may fetch its browser into a shared cache.
    if (ephemeral && def.name !== this.cfg.engine) throw new Error(`engine ${def.name} is ${NOT_ALLOWED}; use the default (${this.cfg.engine})`);
    const profileKey = profile ? `${tenant}/${profile}` : null;
    // Counted as this owner's open from here, so a disconnect while it waits below still makes it close itself.
    this.ownerOpens.set(owner, (this.ownerOpens.get(owner) || 0) + 1);
    let tracked = true;
    const untrack = () => {
      if (!tracked) return;
      tracked = false;
      const n = this.ownerOpens.get(owner) - 1;
      if (n) this.ownerOpens.set(owner, n);
      else { this.ownerOpens.delete(owner); this.goneOwners.delete(owner); }
    };
    try {
      // agent: a session the agent opened (it hears why a download was refused even when its tenant may not download).
      return await this.openTracked({ owner, tenant, profile, profileKey, locale, timezone, def, preempt, media, ephemeral, downloads: downloads && !media && !!this.downloads?.allowFor(tenant), agent: downloads && !media && !ephemeral });
    } finally {
      untrack();
    }
  }

  async openTracked({ owner, tenant, profile, profileKey, locale, timezone, def, preempt, media, ephemeral, downloads, agent = false }) {
    // The profile was just closed (by session_close, a dropped connection, idle or crash) and its browser is still
    // shutting down; or a background keepalive holds it. Wait for it rather than refusing.
    if (profileKey && this.profilesInUse.has(profileKey)) {
      const yieldP = preempt && this.preemptible.get(profileKey);
      if (yieldP) await yieldP().catch(() => {});
      const closing = this.closingProfiles.get(profileKey);
      if (closing) await Promise.race([closing.catch(() => {}), sleep(this.closeDeadlineMs + 6000)]);
      if (this.closing) throw new Error('service is shutting down');
      if (this.goneOwners.has(owner)) throw new Error('connection closed');
    }
    if (this.used >= this.cfg.maxSessions) throw new Error(`session limit ${this.cfg.maxSessions} reached; close one`);
    const tUse = this.tenantUse.get(tenant) || 0;
    const tMax = ephemeral ? this.cfg.ephemeralMaxSessions : this.cfg.maxSessionsPerTenant;
    if (tUse >= tMax) throw new Error(`session limit ${tMax} for this tenant reached; close one`);
    if (profileKey && this.profilesInUse.has(profileKey)) throw new Error(`profile ${profile} is already open in another session`);
    // Reserve synchronously, before any await, so concurrent opens can't overshoot the caps.
    this.used++;
    this.tenantUse.set(tenant, tUse + 1);
    if (profileKey) this.profilesInUse.add(profileKey);
    const release = () => {
      this.used--;
      this.tenantUse.set(tenant, this.tenantUse.get(tenant) - 1);
      if (profileKey) this.profilesInUse.delete(profileKey);
    };

    const p = (async () => {
      let ctx = null, browser = null, dir = null, tmpDir = null, profileDir = null, claimed = false, dlDir = null;
      try {
        // A tenant with a host allowlist only reaches the network through its own forward proxy, which is what its
        // browser contexts are launched with. A failure here fails the open rather than opening a session that is
        // not restricted.
        const proxy = await this.tenantProxy(tenant);
        // Where this session's browser writes downloads: a directory of its own on the data volume.
        if (downloads) dlDir = this.downloads.incoming(tenant);
        if (profile) {
          profileDir = path.join(this.cfg.dataDir, 'profiles', tenant, profile);
          fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
          await this.engines.load(def.name); // a missing engine must not claim the profile for its family
          claimed = claimProfile(profileDir, def);
        }
        try {
          ({ ctx, browser = null, dir = null, tmpDir = null } = await this.engines.open(def.name, {
            cfg: this.cfg, profileDir, locale: locale || 'de-AT', timezone: timezone || 'Europe/Vienna', media, proxy, downloads: dlDir,
            shared: (d, bt) => this.getBrowser(d, bt),
          }));
        } catch (e) {
          ({ dir = null, tmpDir = null } = e);
          throw e;
        }
        if (def.tracker === 'init') await ctx.addInitScript(passwordTracker);
        const page = ctx.pages()[0] || await ctx.newPage();
        await trackPasswords(page, def.tracker);
        if (this.closing) throw new Error('service is shutting down');
        if (this.goneOwners.has(owner)) throw new Error('connection closed'); // owner left while we were launching
        if (profileDir) recordProfileUse(profileDir, { engine: def.name, headless: this.cfg.headless });
        const s = {
          id: `s${crypto.randomBytes(6).toString('hex')}`, owner, tenant, profile: profile || null, engine: def.name, cdp: def.cdp, tracker: def.tracker, ctx, page, browser, dir, tmpDir,
          queue: new SerialQueue(8), handoff: null, gen: 0, busy: 0, lastUsed: Date.now(), shots: [], writes: new Set(), disposed: false, release,
          navs: [], ctxErrors: [], wallSeen: null, // recent main-frame navigations {t, at: origin+path}, "context destroyed" failures, last bot check seen (bot-check loops)
          dlDir, // null: the context refuses downloads
        };
        this.sessions.set(s.id, s);
        this.watchPage(s, page);
        if (dlDir || (agent && this.downloads)) this.downloads.watch(s);
        ctx.on('close', () => this.dispose(s, 'context-closed'));
        // Popups over the cap are closed; not the page that replaces a wedged one (recover).
        ctx.on('page', (extra) => {
          if (s.replacing) { s.replacing--; return; }
          if (ctx.pages().length > this.cfg.maxPagesPerSession) extra.close().catch(() => {});
        });
        return s;
      } catch (e) {
        if (ctx) await Promise.race([ctx.close().catch(() => {}), sleep(CLOSE_DEADLINE_MS)]);
        if (await this.reclaim({ dir, tmpDir, release, what: `failed open (${def.name})` })) {
          if (claimed) unclaimProfile(profileDir);
        }
        if (dlDir) await fs.promises.rm(dlDir, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
    })();
    this.pendingOpens.add(p);
    p.catch(() => {}).finally(() => this.pendingOpens.delete(p));
    return p;
  }

  // Same error for "doesn't exist" and "belongs to someone else", so IDs can't be probed.
  get(owner, id) {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) {
      const c = this.closed.get(id);
      throw new Error(`no session ${id}${c && c.owner === owner ? ` (closed: ${c.reason})` : ''}`);
    }
    return s;
  }

  list(owner) { return [...this.sessions.values()].filter((s) => s.owner === owner); }

  // The session's page: its main-frame navigations (bot-check loops), and its close or crash ending the session.
  // Only while it is the session's page: one being replaced after a timeout (s.retiring) closes without closing the
  // session.
  watchPage(s, page) {
    page.on('framenavigated', (f) => {
      if (f !== page.mainFrame() || s.page !== page) return;
      s.navs.push({ t: Date.now(), at: urlKey(f.url()) });
      if (s.navs.length > 100) s.navs.shift();
    });
    const mine = () => s.page === page && s.retiring !== page;
    page.on('close', () => { if (mine()) this.dispose(s, 'page-closed'); });
    page.on('crash', () => { if (mine()) this.dispose(s, 'page-crashed'); });
  }

  // After a call ran out of time, before the session's next operation may run: what the call started must have
  // stopped (settled), or its tab must be gone. A page that still answers keeps it up to SETTLE_MS; then, or at once
  // when the page doesn't answer, the tab is replaced by a new one in the same context (cookies kept), and only once
  // the old tab is closed and the call stopped (or CLOSE_SETTLE_MS passed) does s.page point to the new one. If no
  // new tab opens, the session is closed. Sets call.state as it goes; returns 'responsive', 'replaced' or 'closed'.
  async recover(s, settled, call) {
    if (s.disposed) return 'closed';
    const probe = s.page.evaluate(() => 1).then(() => true, () => false);
    if (await Promise.race([probe, sleep(PROBE_MS).then(() => false)])) {
      call.state = 'responsive';
      if (await Promise.race([settled.then(() => true), sleep(SETTLE_MS).then(() => false)])) return 'responsive';
      console.error(`bosun: session ${s.id} (${s.engine}): ${call.name} kept running ${SETTLE_MS / 1000} s after its deadline; replacing the tab to stop it`);
    } else call.state = 'checking';
    if (s.disposed) return 'closed';
    const old = s.page;
    const bounded = (p, ms = CLOSE_SETTLE_MS) => Promise.race([Promise.resolve(p).catch(() => {}), sleep(ms)]);
    const retire = () => { s.retiring = old; return bounded(old.close({ runBeforeUnload: false })); };
    const wedged = async (why) => {
      console.error(`bosun: session ${s.id} (${s.engine}): ${why}; closing the session`);
      await this.dispose(s, 'page-wedged');
      return 'closed';
    };
    let page = null, lost = false;
    s.replacing = 1; // the ctx 'page' listener lets the first new page through: this one
    try {
      const opening = s.ctx.newPage();
      const opened = (ms) => Promise.race([opening.catch(() => null), sleep(ms).then(() => null)]);
      page = await opened(NEW_PAGE_FIRST_MS);
      // Firefox may open no new tab while the stuck one's content process is busy (about 5 s, measured): close that
      // one first.
      if (!page) { await retire(); page = await opened(NEW_PAGE_MS - NEW_PAGE_FIRST_MS); }
      if (!page) opening.then((p) => p.close().catch(() => {}), () => {}); // a late one is not left behind
    } finally { s.replacing = 0; }
    if (!page) return wedged('page stopped responding and no new one opened');
    // From now on, the new tab going away before it is the session's page fails the replacement.
    page.once('close', () => { lost = true; });
    page.once('crash', () => { lost = true; });
    const drop = async (why) => { await bounded(page.close()); return s.disposed ? 'closed' : wedged(why); };
    if (s.disposed) return drop('closed while replacing the page');
    await bounded(trackPasswords(page, s.tracker), PROBE_MS);
    // Closing the old tab ends what still waits on it. Until the call has stopped, the old tab stays s.page, so
    // nothing it still does reaches the new one; a call that doesn't stop even then closes the session.
    if (!old.isClosed()) await retire();
    const stopped = await Promise.race([settled.then(() => true), sleep(CLOSE_SETTLE_MS).then(() => false)]);
    if (s.disposed) return drop('closed while replacing the page');
    if (!stopped) return drop(`${call.name} did not stop after its tab was closed`);
    if (lost || page.isClosed()) return drop('the new tab went away before it was used');
    s.page = page;
    this.watchPage(s, page);
    if (page.isClosed()) { await this.dispose(s, 'page-closed'); return 'closed'; }
    s.navs.length = 0; s.ctxErrors.length = 0; s.wallSeen = null;
    // Popups opened meanwhile beyond the cap (the replacement was let through) are closed, newest first.
    const extra = s.ctx.pages().filter((p) => p !== page && p !== old && !p.isClosed());
    while (extra.length > this.cfg.maxPagesPerSession - 1) extra.pop().close().catch(() => {});
    console.error(`bosun: session ${s.id} (${s.engine}): replaced the tab after ${call.name} ran out of time`);
    return 'replaced';
  }

  // The tenant's host allowlist, or null when it has none (then nothing is restricted).
  allowList(tenant) { return allowFor(this.cfg, tenant); }

  // The tenant's forward proxy (Playwright proxy options), started on first use. null for a tenant without an
  // allowlist: it gets no proxy at all, which is upstream behaviour.
  tenantProxy(tenant) {
    const allow = this.allowList(tenant);
    if (!allow) return null;
    if (!this.proxies.has(tenant)) {
      this.proxies.set(tenant, startTenantProxy({ tenant, allow }).catch((e) => { this.proxies.delete(tenant); throw e; }));
    }
    return this.proxies.get(tenant);
  }

  // Whether the tenant's allowlist covers this URL (true when it has no allowlist).
  isAllowed(tenant, url) {
    const allow = this.allowList(tenant);
    return !allow || allowsUrl(allow, url);
  }

  // host:port targets the tenant's proxy refused since time t (ms); [] for a tenant without one.
  async deniedSince(tenant, t) {
    const p = this.proxies.get(tenant);
    return p ? (await p).deniedSince(t) : [];
  }

  // Returns the URL, or throws because the tenant's allowlist doesn't cover its host. The message names host and
  // port only, never the rest of the URL.
  checkAllowed(tenant, url) {
    const allow = this.allowList(tenant);
    if (!allow || allowsUrl(allow, url)) return url;
    let host = 'that URL';
    try { host = new URL(url).host; } catch {}
    throw new Error(`${host} is not in the host allowlist of this token (BROWSER_TENANT_ALLOW)`);
  }

  // Every page action and observation goes through here: serialized per session, refused during a handoff, and
  // discarded if a handoff began while it ran.
  // Inside a tool call with a deadline (deadline.mjs), the operation is cut off before it runs out, the page is
  // checked (recover), and only then does the queue move on.
  async run(owner, id, fn) {
    const s = this.get(owner, id);
    if (s.handoff) throw new Error(HANDOFF_ACTIVE);
    const call = currentCall();
    if (call) call.queued = true;
    return s.queue.run(async () => {
      if (s.disposed) throw new Error(`session ${id} was closed (${s.closeReason})`);
      if (s.handoff) throw new Error(HANDOFF_ACTIVE);
      // Too little of its time left to run and still check the page: not run at all.
      if (call && (call.expired || Date.now() >= call.at - call.reserveMs)) throw new Error(timeoutMessage(call, 'queued'));
      if (call) call.inPage = true;
      const gen = s.gen;
      s.busy++;
      s.lastUsed = Date.now();
      try {
        const r = call ? await this.within(s, fn(s), call) : await fn(s);
        if (s.gen !== gen || s.handoff) throw new Error(HANDOFF_ACTIVE);
        return r;
      } catch (e) {
        if (s.gen !== gen || s.handoff) throw new Error(HANDOFF_ACTIVE);
        throw e;
      } finally {
        s.busy--;
        s.lastUsed = Date.now();
      }
    });
  }

  // The operation's result, or a timeout error: the operation is cut off call.reserveMs before the deadline, which
  // leaves time to check the page (recover) before the call is answered. The session's queue moves on only after
  // recover, so nothing the operation started overlaps the next one.
  async within(s, work, call) {
    let timer;
    const late = new Promise((r) => { timer = setTimeout(r, Math.max(0, call.at - call.reserveMs - Date.now())); });
    try {
      const won = await Promise.race([work.then((v) => ({ v })), late.then(() => null)]);
      if (won) return won.v;
    } finally { clearTimeout(timer); }
    call.expired = true;
    const settled = work.then(() => {}, () => {}); // it may still fail later, once nobody waits for it
    const state = await this.recover(s, settled, call).catch(() => 'closed');
    call.state = state;
    console.error(`bosun: session ${s.id}: ${call.name} ran out of time (${Math.round(call.limitMs / 1000)} s); page ${state}`);
    throw new Error(timeoutMessage(call, state));
  }

  // Starts (or returns the active) handoff. Queues behind in-flight operations, so nothing the agent started can
  // observe the page once the human has it.
  async requestHuman(owner, id, reason) {
    if (!this.live) throw new Error('live view not configured (LIVE_PORT/LIVE_BASE_URL)');
    const s = this.get(owner, id);
    if (s.handoff) return s.handoff;
    return s.queue.run(async () => {
      if (s.disposed) throw new Error(`session ${id} was closed (${s.closeReason})`);
      if (s.handoff) return s.handoff;
      s.gen++;
      await notePasswords(s.page).catch(() => {});
      const h = this.live.start(s.page, reason, { ttlMs: this.cfg.handoffTtlMs, driver: s.cdp ? 'cdp' : 'playwright' });
      s.handoff = h;
      // settled: resolves with the status once the session is usable by the agent again.
      s.lastHandoff = null;
      // While the human works, keep noting password inputs (new pages, new fields) before they can be revealed.
      const poll = setInterval(() => { if (!s.disposed) notePasswords(s.page).catch(() => {}); }, NOTE_POLL_MS);
      poll.unref();
      h.wait.finally(() => clearInterval(poll));
      // The human may have got past a bot check: earlier navigation history no longer says anything about a loop.
      const end = (status) => { if (s.handoff === h) { s.handoff = null; s.lastHandoff = status; s.gen++; s.lastUsed = Date.now(); s.navs.length = 0; s.ctxErrors.length = 0; s.wallSeen = null; } };
      h.settled = h.wait.then((status) => s.queue.run(async () => {
        // Human input that could not be drained: the page may still change under the agent. Give the session up.
        if (h.drainFailed) throw new Error('live-view input did not drain');
        // Give up / timeout / cancel may leave half-typed credentials in the form: clear them before the agent
        // resumes. If that fails or hangs, the session is closed rather than handed back with them in it.
        if (status !== 'human-done' && !s.disposed) {
          const cleared = await Promise.race([clearSensitive(s.page).then(() => true, () => false), sleep(5000).then(() => false)]);
          if (!cleared) throw new Error('could not clear credential fields');
        }
        end(status);
        return status;
      }).catch(async () => {
        if (!s.disposed) await this.dispose(s, 'handoff-cleanup-failed');
        end(status);
        return status;
      }));
      return h;
    });
  }

  // Resolves with the handoff status, 'still_waiting' after timeoutMs, or null if no handoff is active. A handoff
  // that ended before anyone waited reports its status once.
  async waitHandoff(owner, id, timeoutMs, signal) {
    const s = this.get(owner, id);
    const h = s.handoff;
    if (!h) { const st = s.lastHandoff ?? null; s.lastHandoff = null; return st; }
    let timer, onAbort;
    try {
      return await Promise.race([
        h.settled,
        new Promise((r) => { timer = setTimeout(() => r('still_waiting'), timeoutMs); }),
        new Promise((_, rej) => {
          if (!signal) return;
          onAbort = () => rej(new Error('cancelled'));
          if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async saveShot(s, buf) {
    if (!this.cfg.saveShots || policyOf(this.cfg, s.tenant) === 'ephemeral') return null; // ephemeral: nothing on disk
    if (s.disposed) throw new Error(`session ${s.id} was closed (${s.closeReason})`);
    const dir = path.join(this.cfg.dataDir, 'shots', s.tenant, s.id);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.jpg`);
    const gone = async () => { await fs.promises.rm(dir, { recursive: true, force: true }); return new Error(`session ${s.id} was closed (${s.closeReason})`); };
    if (s.disposed) throw await gone();
    const write = fs.promises.writeFile(file, buf, { mode: 0o600, flag: 'wx' });
    s.writes.add(write);
    try { await write; } finally { s.writes.delete(write); }
    if (s.disposed) throw await gone(); // closed while writing: the disposal may already have removed the directory
    s.shots.push(file);
    while (s.shots.length > this.cfg.shotsPerSession) await fs.promises.rm(s.shots.shift(), { force: true });
    return file;
  }

  // One teardown path for close, crash, idle, disconnect and shutdown. Idempotent.
  dispose(s, reason) {
    if (s.disposing) return s.disposing;
    s.disposed = true;
    s.closeReason = reason;
    this.sessions.delete(s.id);
    this.closed.set(s.id, { owner: s.owner, reason });
    if (this.closed.size > 200) this.closed.delete(this.closed.keys().next().value);
    if (s.handoff) s.handoff.cancel();
    const profileKey = s.profile ? `${s.tenant}/${s.profile}` : null;
    s.disposing = (async () => {
      let reclaimed = false;
      try {
        await Promise.race([s.ctx.close().catch(() => {}), sleep(this.closeDeadlineMs)]);
        await Promise.allSettled([...s.writes]); // a screenshot being written must not outlive the directory removal
        await fs.promises.rm(path.join(this.cfg.dataDir, 'shots', s.tenant, s.id), { recursive: true, force: true }).catch(() => {});
        reclaimed = await this.reclaim({ dir: s.dir, tmpDir: s.tmpDir, release: s.release, what: `session ${s.id} (${s.engine})` });
      } catch {
        if (!reclaimed && !s.dir) s.release(); // shared-browser context: nothing per session left to wait for
      }
      // Files this session put into its pages: the browser that could still read them is gone.
      await this.uploads?.sessionClosed(s.id, (id) => this.sessions.has(id)).catch(() => {});
      // Its download directory (finished downloads were moved out of it and stay).
      await this.downloads?.sessionClosed(s).catch(() => {});
    })();
    this.disposals.add(s.disposing);
    if (profileKey) this.closingProfiles.set(profileKey, s.disposing);
    s.disposing.finally(() => {
      this.disposals.delete(s.disposing);
      if (this.closingProfiles.get(profileKey) === s.disposing) this.closingProfiles.delete(profileKey);
    });
    return s.disposing;
  }

  // After a persistent context closed (or its close timed out): no process may still run on its directory before the
  // temp profile is deleted and the capacity released. If one survives SIGKILL, the slot stays taken (and is logged).
  async reclaim({ dir, tmpDir, release, what }) {
    if (dir && !(await terminate(dir))) {
      console.error(`bosun: ${what}: browser still running on ${dir} after SIGKILL; keeping its slot`);
      this.stuck.add({ dir, tmpDir, release, what });
      return false;
    }
    if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    release();
    return true;
  }

  close(owner, id) { return this.dispose(this.get(owner, id), 'closed'); }

  // The owner is gone: close its sessions, and make opens still in progress for it close themselves.
  disposeOwner(owner) {
    if (this.ownerOpens.has(owner)) this.goneOwners.add(owner);
    const done = Promise.all(this.list(owner).map((s) => this.dispose(s, 'owner-disconnected')));
    for (const [id, c] of this.closed) if (c.owner === owner) this.closed.delete(id); // nobody left to tell
    return done;
  }

  reapIdle(now = Date.now()) {
    for (const s of this.sessions.values()) {
      if (!s.handoff && s.busy === 0 && s.queue.size === 0 && now - s.lastUsed > this.cfg.idleTimeoutMs) this.dispose(s, 'idle');
    }
  }

  async closeAll() {
    this.closing = true;
    clearInterval(this.reaper);
    await Promise.race([Promise.allSettled([...this.pendingOpens]), sleep(CLOSE_DEADLINE_MS)]);
    for (const s of [...this.sessions.values()]) this.dispose(s, 'shutdown');
    // Includes disposals that started earlier (explicit close, disconnect) and are still closing.
    await Promise.race([Promise.allSettled([...this.disposals]), sleep(CLOSE_DEADLINE_MS + 1000)]);
    for (const x of [...this.stuck]) { this.stuck.delete(x); await this.reclaim(x); }
    const bp = this.browserP;
    this.browserP = null;
    if (bp) await Promise.race([bp.then((b) => b.close(), () => {}), sleep(CLOSE_DEADLINE_MS)]).catch(() => {});
    const proxies = [...this.proxies.values()];
    this.proxies.clear();
    await Promise.allSettled(proxies.map((p) => p.then((x) => x.close(), () => {})));
  }
}
