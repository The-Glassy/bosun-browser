// Session registry and lifecycle: ownership, capacity, single-flight browser launch, crash handling, idle reaping,
// per-session operation serialization and the handoff state that blinds the agent.
import { chromium } from 'playwright';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { clearSensitive } from './redact.mjs';

export const HANDOFF_ACTIVE = 'a human is working in this tab (handoff active) — call handoff_wait first';
const LAUNCH_ARGS = ['--disable-blink-features=AutomationControlled'];
const CLOSE_DEADLINE_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

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
  constructor(cfg, { live = null, launcher = chromium } = {}) {
    this.cfg = cfg;
    this.live = live;
    this.launcher = launcher;
    this.sessions = new Map(); // id -> session
    this.used = 0; // reserved + open + still closing
    this.tenantUse = new Map();
    this.profilesInUse = new Set();
    this.pendingOpens = new Set();
    this.browserP = null;
    this.launches = 0;
    this.closing = false;
    fs.mkdirSync(path.join(cfg.dataDir, 'profiles'), { recursive: true });
    if (cfg.idleTimeoutMs > 0) {
      this.reaper = setInterval(() => this.reapIdle(), Math.min(30_000, Math.max(250, cfg.idleTimeoutMs / 4)));
      this.reaper.unref();
    }
  }

  getBrowser() {
    if (!this.browserP) {
      this.launches++;
      const p = this.browserP = this.launcher.launch({ headless: this.cfg.headless, args: LAUNCH_ARGS }).then((b) => {
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

  ctxOpts(o) {
    return { viewport: { width: 1366, height: 900 }, locale: o.locale || 'de-AT', timezoneId: o.timezone || 'Europe/Vienna' };
  }

  async open({ owner, tenant, profile, locale, timezone }) {
    if (this.closing) throw new Error('service is shutting down');
    if (this.used >= this.cfg.maxSessions) throw new Error(`session limit ${this.cfg.maxSessions} reached; close one`);
    const tUse = this.tenantUse.get(tenant) || 0;
    if (tUse >= this.cfg.maxSessionsPerTenant) throw new Error(`session limit ${this.cfg.maxSessionsPerTenant} for this tenant reached; close one`);
    const profileKey = profile ? `${tenant}/${profile}` : null;
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
      let ctx = null, browser = null;
      try {
        const o = this.ctxOpts({ locale, timezone });
        if (profile) {
          const dir = path.join(this.cfg.dataDir, 'profiles', tenant, profile);
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          ctx = await this.launcher.launchPersistentContext(dir, { headless: this.cfg.headless, args: LAUNCH_ARGS, ...o });
        } else {
          browser = await this.getBrowser();
          ctx = await browser.newContext(o);
        }
        const page = ctx.pages()[0] || await ctx.newPage();
        if (this.closing) throw new Error('service is shutting down');
        const s = {
          id: `s${crypto.randomBytes(6).toString('hex')}`, owner, tenant, profile: profile || null, ctx, page, browser,
          queue: new SerialQueue(8), handoff: null, gen: 0, busy: 0, lastUsed: Date.now(), shots: [], disposed: false, release,
        };
        this.sessions.set(s.id, s);
        page.on('close', () => this.dispose(s, 'page-closed'));
        page.on('crash', () => this.dispose(s, 'page-crashed'));
        ctx.on('close', () => this.dispose(s, 'context-closed'));
        ctx.on('page', (extra) => { if (ctx.pages().length > this.cfg.maxPagesPerSession) extra.close().catch(() => {}); });
        return s;
      } catch (e) {
        if (ctx) await Promise.race([ctx.close().catch(() => {}), sleep(CLOSE_DEADLINE_MS)]);
        release();
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
    if (!s || s.owner !== owner) throw new Error(`no session ${id}`);
    return s;
  }

  list(owner) { return [...this.sessions.values()].filter((s) => s.owner === owner); }

  // Every page action and observation goes through here: serialized per session, refused during a handoff, and
  // discarded if a handoff began while it ran.
  async run(owner, id, fn) {
    const s = this.get(owner, id);
    if (s.handoff) throw new Error(HANDOFF_ACTIVE);
    return s.queue.run(async () => {
      if (s.disposed) throw new Error(`session ${id} was closed (${s.closeReason})`);
      if (s.handoff) throw new Error(HANDOFF_ACTIVE);
      const gen = s.gen;
      s.busy++;
      s.lastUsed = Date.now();
      try {
        const r = await fn(s);
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
      const h = this.live.start(s.page, reason, { ttlMs: this.cfg.handoffTtlMs });
      s.handoff = h;
      // settled: resolves with the status once the session is usable by the agent again.
      s.lastHandoff = null;
      const end = (status) => { if (s.handoff === h) { s.handoff = null; s.lastHandoff = status; s.gen++; s.lastUsed = Date.now(); } };
      h.settled = h.wait.then((status) => s.queue.run(async () => {
        // Give up / timeout / cancel may leave half-typed credentials in the form: clear them before the agent resumes.
        if (status !== 'human-done' && !s.disposed) await Promise.race([clearSensitive(s.page).catch(() => {}), sleep(5000)]);
        end(status);
        return status;
      }).catch(() => { end(status); return status; }));
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
    if (!this.cfg.saveShots) return null;
    const dir = path.join(this.cfg.dataDir, 'shots', s.tenant, s.id);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${Date.now()}-${s.shots.length}.jpg`);
    await fs.promises.writeFile(file, buf, { mode: 0o600, flag: 'wx' });
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
    if (s.handoff) s.handoff.cancel();
    s.disposing = (async () => {
      try {
        await Promise.race([s.ctx.close().catch(() => {}), sleep(CLOSE_DEADLINE_MS)]);
        await fs.promises.rm(path.join(this.cfg.dataDir, 'shots', s.tenant, s.id), { recursive: true, force: true }).catch(() => {});
      } finally {
        s.release();
      }
    })();
    return s.disposing;
  }

  close(owner, id) { return this.dispose(this.get(owner, id), 'closed'); }

  disposeOwner(owner) { return Promise.all(this.list(owner).map((s) => this.dispose(s, 'owner-disconnected'))); }

  reapIdle(now = Date.now()) {
    for (const s of this.sessions.values()) {
      if (!s.handoff && s.busy === 0 && s.queue.size === 0 && now - s.lastUsed > this.cfg.idleTimeoutMs) this.dispose(s, 'idle');
    }
  }

  async closeAll() {
    this.closing = true;
    clearInterval(this.reaper);
    await Promise.race([Promise.allSettled([...this.pendingOpens]), sleep(CLOSE_DEADLINE_MS)]);
    await Promise.allSettled([...this.sessions.values()].map((s) => this.dispose(s, 'shutdown')));
    const bp = this.browserP;
    this.browserP = null;
    if (bp) await Promise.race([bp.then((b) => b.close(), () => {}), sleep(CLOSE_DEADLINE_MS)]).catch(() => {});
  }
}
