// Keepalive: visit persistent profiles on a schedule so sliding login sessions don't expire. No model involved: the
// service opens the profile with the engine and mode it is normally used with, loads one URL, moves the mouse and
// scrolls a little like a person reading (no clicks, no typing, no navigation), checks that it is still logged in,
// and closes it again. A logged-out profile or a bot check is reported as a needs-human event; nothing is retried
// before the next scheduled visit. Only the check result is kept, never page content.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { glidePath } from './liveview.mjs';
import { readProfileMeta } from './engines.mjs';

export const HISTORY = 10; // results kept per profile
const MIN_GAP_MS = 15 * 60_000; // a visit is never scheduled closer than this to the previous one
const BUSY_RETRY_MIN = [10, 20]; // service at capacity: try again in 10–20 min
const TICK_MS = 30_000;
const GAP_MS = [60_000, 300_000]; // between two visits of different profiles
const ACTIVITY_MS = [20_000, 60_000];
const CHECK_TIMEOUT_MS = 5000;

const between = (rnd, [a, b]) => a + (b - a) * rnd();

// When the next visit is due: everyHours after `from`, shifted by up to ±jitterMin, never sooner than MIN_GAP_MS.
export function nextRun(from, { everyHours, jitterMin }, rnd = Math.random) {
  const at = from + everyHours * 3_600_000 + (rnd() * 2 - 1) * jitterMin * 60_000;
  return Math.round(Math.max(from + MIN_GAP_MS, at));
}

// logged_in_check: every given condition must hold. Returns {ok, reason}; reason names the failed condition, not
// anything from the page.
export async function evaluateCheck(page, check) {
  if (check.url_not_contains && page.url().includes(check.url_not_contains)) return { ok: false, reason: 'url contains url_not_contains' };
  if (check.selector) {
    const seen = await page.locator(check.selector).first().waitFor({ state: 'visible', timeout: CHECK_TIMEOUT_MS }).then(() => true, () => false);
    if (!seen) return { ok: false, reason: 'selector not visible' };
  }
  if (check.text) {
    const seen = await page.getByText(check.text).first().waitFor({ state: 'visible', timeout: CHECK_TIMEOUT_MS }).then(() => true, () => false);
    if (!seen) return { ok: false, reason: 'text not found' };
  }
  return { ok: true };
}

const sleep = (ms, signal) => new Promise((r) => {
  const t = setTimeout(r, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

// About `ms` of reading-like activity: 3–6 pointer glides along the live view's human path, 1–3 scrolls (mostly
// down), sometimes a pause over a link, with pauses in between. Only page.mouse.move / wheel: nothing is clicked.
export async function humanActivity(page, ms, { rnd = Math.random, signal } = {}) {
  const vp = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const point = () => ({ x: Math.round(vp.width * between(rnd, [0.08, 0.92])), y: Math.round(vp.height * between(rnd, [0.1, 0.9])) });
  let pos = point();
  await page.mouse.move(pos.x, pos.y);
  const glide = async (to) => {
    for (const pt of glidePath(pos, to, rnd)) {
      if (signal?.aborted) return;
      await page.mouse.move(pt.x, pt.y);
      await sleep(between(rnd, [8, 22]), signal);
    }
    pos = to;
  };
  const actions = [
    ...Array(3 + Math.floor(rnd() * 4)).fill('move'),
    ...Array(1 + Math.floor(rnd() * 3)).fill('scroll'),
    ...(rnd() < 0.6 ? ['hover'] : []),
  ];
  for (let i = actions.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [actions[i], actions[j]] = [actions[j], actions[i]]; }
  const end = Date.now() + ms;
  const done = { move: 0, scroll: 0, hover: 0 };
  for (let i = 0; i < actions.length && !signal?.aborted; i++) {
    const a = actions[i];
    if (a === 'move') await glide(point());
    else if (a === 'scroll') {
      const dir = rnd() < 0.8 ? 1 : -1, total = between(rnd, [150, 600]);
      for (let left = total; left > 0 && !signal?.aborted; left -= 100) { await page.mouse.wheel(0, dir * Math.min(100, left)); await sleep(between(rnd, [30, 90]), signal); }
    } else {
      const links = page.locator('a[href]:visible');
      const n = Math.min(await links.count().catch(() => 0), 20);
      const box = n ? await links.nth(Math.floor(rnd() * n)).boundingBox({ timeout: 1000 }).catch(() => null) : null;
      const inView = box && box.y >= 0 && box.y + box.height <= vp.height;
      await glide(inView ? { x: Math.round(box.x + box.width * between(rnd, [0.3, 0.7])), y: Math.round(box.y + box.height / 2) } : point());
    }
    done[a]++;
    const left = end - Date.now(), steps = actions.length - i;
    await sleep(Math.max(0, left / steps * between(rnd, [0.6, 1.4])), signal);
  }
  const rest = end - Date.now();
  if (rest > 0) await sleep(rest, signal);
  return done;
}

// Persisted configuration and results, one file on the data volume next to profiles/.
class Store {
  constructor(file) {
    this.file = file;
    this.entries = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const e of data.entries || []) this.entries.set(`${e.tenant}/${e.profile}`, e);
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`keepalive: cannot read ${file}: ${e.message}`);
    }
  }
  save() {
    const tmp = `${this.file}.${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...this.entries.values()] }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

export class Keepalive {
  // opts: emit(event) for needs-human; rnd/now for tests; tickMs, gapMs, activityMs, wall (bot-check detector).
  constructor({ cfg, manager, emit = () => {}, wall = async () => null, rnd = Math.random, now = Date.now, tickMs = TICK_MS, gapMs = GAP_MS, activityMs = ACTIVITY_MS }) {
    Object.assign(this, { cfg, manager, emit, wall, rnd, now, tickMs, gapMs, activityMs });
    this.store = new Store(path.join(cfg.dataDir, 'keepalive.json'));
    this.current = null; // {key, abort, done}
    this.notBefore = 0; // spacing between visits
    this.timer = null;
    this.stopped = false;
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.tickMs);
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.current) { this.current.abort(); await this.current.done; }
  }

  profileDir(tenant, profile) { return path.join(this.cfg.dataDir, 'profiles', tenant, profile); }

  set(tenant, { profile, url, everyHours = 12, jitterMin = 30, check, enabled = true }) {
    if (!fs.existsSync(this.profileDir(tenant, profile))) throw new Error(`no profile ${profile}: open it once with session_open({profile}) and log in first`);
    if (jitterMin * 2 > everyHours * 60) throw new Error('jitter_min must be at most half of every_hours');
    if (!check || !(check.text || check.selector || check.url_not_contains)) throw new Error('logged_in_check needs text, selector or url_not_contains');
    const key = `${tenant}/${profile}`;
    const old = this.store.entries.get(key);
    const e = {
      tenant, profile, url, everyHours, jitterMin, enabled,
      check: Object.fromEntries(['text', 'selector', 'url_not_contains'].filter((k) => check[k]).map((k) => [k, check[k]])),
      nextAt: old?.nextAt ?? null, history: old?.history ?? [], lastSkip: old?.lastSkip ?? null, created: old?.created ?? this.now(),
    };
    const rescheduled = !old || !old.enabled || old.everyHours !== everyHours || old.jitterMin !== jitterMin;
    if (enabled && (rescheduled || !e.nextAt)) e.nextAt = nextRun(this.now(), e, this.rnd);
    this.store.entries.set(key, e);
    this.store.save();
    return this.view(e);
  }

  remove(tenant, profile) {
    const key = `${tenant}/${profile}`;
    if (!this.store.entries.delete(key)) throw new Error(`no keepalive for profile ${profile}`);
    this.store.save();
    if (this.current?.key === key) this.current.abort();
    return { removed: profile };
  }

  list(tenant) { return [...this.store.entries.values()].filter((e) => e.tenant === tenant).map((e) => this.view(e)); }

  view(e) {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    return {
      profile: e.profile, url: e.url, every_hours: e.everyHours, jitter_min: e.jitterMin, logged_in_check: e.check, enabled: e.enabled,
      next_run: e.enabled ? iso(e.nextAt) : null, running: this.current?.key === `${e.tenant}/${e.profile}`,
      last: e.history.slice(-HISTORY).reverse().map((r) => ({ at: iso(r.at), status: r.status, duration_ms: r.durationMs, ...(r.reason ? { reason: r.reason } : {}) })),
      ...(e.lastSkip ? { last_skip: { at: iso(e.lastSkip.at), reason: e.lastSkip.reason } } : {}),
    };
  }

  // Runs at most one due visit. Visits are spread: one at a time, gapMs apart, the most overdue first.
  async tick() {
    if (this.current || this.stopped || this.manager.closing) return null;
    const now = this.now();
    if (now < this.notBefore) return null;
    const due = [...this.store.entries.values()].filter((e) => e.enabled && e.nextAt && e.nextAt <= now).sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!due) return null;
    const key = `${due.tenant}/${due.profile}`;
    const m = this.manager;
    // An agent has the profile open (or it is still closing): the profile is in use anyway; the next visit comes a
    // full period later.
    if (m.profilesInUse.has(key)) return this.skip(due, 'profile in use', nextRun(now, due, this.rnd));
    // Leave agents a free slot (where there is more than one): a visit is background work.
    const room = (used, max) => used < max - (max > 1 ? 1 : 0);
    if (!room(m.used, this.cfg.maxSessions) || !room(m.tenantUse.get(due.tenant) || 0, this.cfg.maxSessionsPerTenant)) {
      return this.skip(due, 'session limit reached', now + Math.round(between(this.rnd, BUSY_RETRY_MIN) * 60_000));
    }
    const ac = new AbortController();
    const run = { key, abort: () => ac.abort(), session: null };
    run.done = this.visit(due, ac.signal, run).finally(() => {
      if (this.current === run) this.current = null;
      m.preemptible.delete(key);
      this.notBefore = this.now() + Math.round(between(this.rnd, this.gapMs));
    });
    this.current = run;
    // An agent opening this profile meanwhile takes it over: the visit stops and its session closes first.
    m.preemptible.set(key, async () => { ac.abort(); if (run.session) await m.dispose(run.session, 'keepalive-preempted'); await run.done; });
    return run.done;
  }

  skip(e, reason, nextAt) {
    e.lastSkip = { at: this.now(), reason };
    e.nextAt = nextAt;
    this.store.save();
    return { skipped: reason };
  }

  engineFor(meta) {
    if (meta?.engine) return meta.engine;
    if (meta?.family === 'firefox') return 'camoufox';
    return this.cfg.engine === 'camoufox' ? 'chromium' : this.cfg.engine;
  }

  async visit(e, signal, run) {
    const t0 = this.now();
    const m = this.manager;
    const owner = `keepalive:${e.tenant}`;
    let status = 'error', reason = null, s = null;
    try {
      const meta = readProfileMeta(this.profileDir(e.tenant, e.profile));
      // Same mode as normal use, so the fingerprint stays consistent: never open a headful profile headless.
      if (this.cfg.headless && meta?.headless !== true) throw new Error('profile is used headful; keepalive will not open it headless (run the service headful)');
      s = run.session = await m.open({ owner, tenant: e.tenant, profile: e.profile, engine: this.engineFor(meta), preempt: false });
      if (signal.aborted) throw new Error('aborted');
      const r = await m.run(owner, s.id, async (ss) => {
        await ss.page.goto(e.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await ss.page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
        if (await this.wall(ss.page)) return { status: 'bot_check', reason: 'bot check page' };
        await humanActivity(ss.page, Math.round(between(this.rnd, this.activityMs)), { rnd: this.rnd, signal });
        if (signal.aborted) throw new Error('aborted');
        if (await this.wall(ss.page)) return { status: 'bot_check', reason: 'bot check page' };
        const c = await evaluateCheck(ss.page, e.check);
        return c.ok ? { status: 'ok' } : { status: 'logged_out', reason: c.reason };
      });
      ({ status, reason = null } = r);
    } catch (err) {
      if (signal.aborted) status = 'aborted';
      else reason = String(err?.message || err).split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200);
    } finally {
      if (s) await m.dispose(s, 'keepalive-done');
    }
    if (!this.store.entries.has(`${e.tenant}/${e.profile}`)) return { status };
    if (status === 'aborted') {
      this.skip(e, this.stopped ? 'service stopped' : 'taken over by an agent', e.nextAt <= this.now() && !this.stopped ? nextRun(this.now(), e, this.rnd) : e.nextAt);
      return { status };
    }
    e.history.push({ at: t0, status, durationMs: this.now() - t0, ...(reason ? { reason } : {}) });
    if (e.history.length > HISTORY) e.history.splice(0, e.history.length - HISTORY);
    e.nextAt = nextRun(this.now(), e, this.rnd);
    this.store.save();
    if (status === 'logged_out' || status === 'bot_check') {
      this.emit({ tenant: e.tenant, profile: e.profile, url: e.url, kind: status, reason });
    }
    return { status, reason };
  }
}
