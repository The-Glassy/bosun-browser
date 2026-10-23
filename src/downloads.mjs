// Files a page downloads, kept for the agent (download_wait, downloads, download_get). Only a tenant named in
// BROWSER_TENANT_DOWNLOAD_ALLOW gets them; every other tenant's browser refuses downloads outright, as before.
//
// Which download is kept: one whose URL's host is on the tenant's list, or one started by a page whose top-level
// origin is (a popup with no origin of its own counts as its opener). blob: and data: URLs are made by the page
// itself and have no host of their own, so only the page decides for them. Anything else is cancelled, and the reason
// goes to the agent (click, download_wait, downloads, the bosun:download event).
//
// Where the bytes go: the session's browser writes them itself, streamed, into a directory of its own on the data
// volume (BROWSER_DATA/downloads/<tenant>/.in-<random>, the browser's downloadsPath), never into /tmp and never
// through this process. Its size is checked every POLL_MS while it grows: past DOWNLOAD_MAX_BYTES, or past the
// tenant's DOWNLOAD_TENANT_QUOTA_BYTES, the download is cancelled and the browser deletes what it wrote. A finished
// file moves (same volume) to BROWSER_DATA/downloads/<tenant>/<id>/<filename>, 0600, where it outlives its session.
// It goes away once fetched (a one-time GET on the MCP port, or inline), DOWNLOAD_TTL_SEC after it finished, and
// with every other download when the service starts. Every lookup is by tenant: another tenant's id is "no such
// download".
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { pipeline } from 'stream/promises';
import { allowsUrl } from './allow.mjs';
import { policyOf } from './auth.mjs';
import { safeName } from './uploads.mjs';

export const INLINE_MAX_BYTES = 256 * 1024;
const POLL_MS = 250; // how often a running download's size is checked
const FILES_PER_TENANT = 50; // downloads a tenant holds at a time (running or ready)
const NOTICES_PER_TENANT = 100; // refused and failed downloads remembered per tenant, for the agent to read
const GETS_PER_TENANT = 4; // GETs streaming at once, per tenant
const SETTLE_MS = 5000; // click waits this long for a download it started to finish
const GET_IDLE_MS = 60_000; // a GET whose client reads nothing for this long is dropped
const GET_MAX_MS = 60 * 60_000; // and none may take longer than an hour
const ID_RE = /^d[0-9a-f]{16}$/;

const MIME = {
  txt: 'text/plain', srt: 'application/x-subrip', vtt: 'text/vtt', csv: 'text/csv', tsv: 'text/tab-separated-values', md: 'text/markdown',
  json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html', ics: 'text/calendar', log: 'text/plain',
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
};
// The type by the file name's extension (the browser does not tell us the response's Content-Type).
export const mimeOf = (name) => MIME[String(name).toLowerCase().split('.').pop()] || 'application/octet-stream';

const mb = (n) => `${Math.round(n / 1024 / 1024)} MB`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
const hostOf = (raw) => { try { const u = new URL(raw); return /^https?:$/.test(u.protocol) ? u.host : null; } catch { return null; } };

// Where the bytes come from: the URL's host, or for blob: the origin that made it (data: has none).
function sourceOf(raw) {
  let u;
  try { u = new URL(raw); } catch { return 'unknown'; }
  if (u.protocol === 'http:' || u.protocol === 'https:') return u.host;
  if (u.protocol === 'blob:') return `blob from ${hostOf(u.pathname) || 'an opaque origin'}`;
  return u.protocol.slice(0, -1); // data, …
}

// The http(s) URL of the page's top-level document; a popup that has none (about:blank) is judged by its opener.
async function topUrl(page) {
  for (let p = page, i = 0; p && i < 3; i++) {
    const u = p.url();
    if (/^https?:/i.test(u)) return u;
    p = await p.opener().catch(() => null);
  }
  return null;
}

// Content-Disposition with a plain fallback and the exact (UTF-8) name.
const disposition = (name) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name.toWellFormed?.() ?? name)}`;

export class Downloads extends EventEmitter {
  constructor(cfg, { events = null } = {}) {
    super();
    this.setMaxListeners(0); // one per waiting download_wait / click
    this.cfg = cfg;
    this.events = events;
    this.root = path.join(cfg.dataDir, 'downloads');
    this.files = new Map(); // id -> {id, tenant, session, seq, state: downloading|ready|refused|failed|deleted, name, size, …}
    this.seq = 0;
    // Anything left here is from an earlier process: nobody holds an id for it any more.
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  // The tenant's download host patterns, or null: no downloads for it (not named, or a read-only token).
  allowFor(tenant) {
    if (policyOf(this.cfg, tenant) === 'ephemeral') return null;
    return this.cfg.downloadAllow?.get(tenant) ?? null;
  }

  // Running and kept downloads, and deleted ones whose file is not gone yet (a removal that failed keeps its bytes
  // and its slot until the sweep's retry succeeds).
  holding(f) { return f.state === 'downloading' || f.state === 'ready' || (f.state === 'deleted' && !!f.dir); }
  // Bytes of the tenant's running and kept downloads.
  used(tenant) { let n = 0; for (const f of this.files.values()) if (f.tenant === tenant && this.holding(f)) n += f.size; return n; }
  count(tenant) { let n = 0; for (const f of this.files.values()) if (f.tenant === tenant && this.holding(f)) n++; return n; }

  // A new directory for one session's browser to write downloads into (its downloadsPath).
  incoming(tenant) {
    const dir = path.join(this.root, tenant, `.in-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  // Every page of the session's context, now and later, reports its downloads here; a session without a download
  // directory (a tenant that may not download) only to say why it was refused. The directory is watched, so a write
  // triggers the size check at once rather than at the next POLL_MS.
  watch(s) {
    const on = (p) => p.on('download', (d) => { this.onDownload(s, d).catch((e) => console.error(`bosun: download in session ${s.id}: ${e.message}`)); });
    for (const p of s.ctx.pages()) on(p);
    s.ctx.on('page', on);
    if (s.dlDir) {
      try {
        s.dlWatcher = fs.watch(s.dlDir, () => { for (const f of this.files.values()) if (f.session === s.id && f.state === 'downloading') f.check?.(); });
        s.dlWatcher.on('error', () => {});
      } catch {} // without it, the poll still runs
    }
  }

  // Why this download may not be kept, or null.
  overLimit(f) {
    if (f.size > this.cfg.downloadMaxBytes) return `larger than the download limit (${mb(this.cfg.downloadMaxBytes)}, DOWNLOAD_MAX_BYTES)`;
    if (this.used(f.tenant) > this.cfg.downloadQuotaBytes) return `download quota of this token used up (${mb(this.cfg.downloadQuotaBytes)}, DOWNLOAD_TENANT_QUOTA_BYTES; fetch or let the kept files expire)`;
    return null;
  }

  async onDownload(s, d) {
    const url = d.url();
    if (!s.dlDir) { // the context refuses it anyway (acceptDownloads false); this records why
      return this.refuse(this.track(s, d, url), null, 'downloads are off for this token (it is not in BROWSER_TENANT_DOWNLOAD_ALLOW)');
    }
    const f = this.track(s, d, url);
    const top = await topUrl(d.page()).catch(() => null);
    f.page = hostOf(top);
    return this.keep(s, d, url, f, top);
  }

  // A new record for a download that just started.
  track(s, d, url) {
    const f = {
      id: `d${crypto.randomBytes(8).toString('hex')}`, tenant: s.tenant, session: s.id, seq: ++this.seq, state: 'downloading',
      name: (() => { try { return safeName(d.suggestedFilename()); } catch { return 'download'; } })(),
      source: sourceOf(url), page: null, by: null, size: 0, reason: null, startedAt: Date.now(), delivered: false,
      dir: null, file: null, secret: null, urlExpiresAt: 0, expiresAt: Date.now() + this.cfg.downloadTtlMs, sending: false,
    };
    f.mime = mimeOf(f.name);
    this.files.set(f.id, f);
    this.trimNotices(f.tenant);
    this.emit('change', f);
    return f;
  }

  async keep(s, d, url, f, top) {
    const allow = this.allowFor(s.tenant) || [];
    if (allowsUrl(allow, url)) f.by = 'url';
    else if (top && allowsUrl(allow, top)) f.by = 'page';
    else {
      const what = f.source.startsWith('blob') || f.source === 'data' ? `a ${f.source.split(' ')[0]}: download` : f.source;
      return this.refuse(f, d, `${what} from page ${f.page || 'without an http(s) origin'}: neither is in the download allowlist of this token (BROWSER_TENANT_DOWNLOAD_ALLOW)`);
    }
    if (this.closed) return this.refuse(f, d, 'service is shutting down');
    if (this.count(f.tenant) > FILES_PER_TENANT) return this.refuse(f, d, `this token holds ${FILES_PER_TENANT} downloads already; fetch them or let them expire`);
    if (this.used(f.tenant) >= this.cfg.downloadQuotaBytes) return this.refuse(f, d, this.overLimit({ ...f, size: 0 }) || 'download quota used up');

    // The browser's own file while it grows: <guid>.crdownload (Chromium) or <guid> (Firefox), next to where it ends
    // up. Without that path (a Playwright that no longer exposes it), the session's whole download directory is
    // measured instead, which is stricter.
    const abs = d._artifact?._initializer?.absolutePath ?? null;
    const measure = abs
      ? async () => { let n = 0; for (const p of [abs, `${abs}.crdownload`]) { try { n = Math.max(n, (await fs.promises.stat(p)).size); } catch {} } return n; }
      : () => dirBytes(s.dlDir);
    let over = null, busy = false;
    const check = f.check = async () => {
      if (busy || over || f.state !== 'downloading') return;
      busy = true;
      try {
        f.size = await measure();
        over = this.overLimit(f);
        if (over) await d.cancel().catch(() => {});
      } finally { busy = false; }
    };
    const timer = setInterval(check, POLL_MS);
    timer.unref?.();
    let failure;
    try { failure = await d.failure(); } catch (e) { failure = String(e?.message || e); } finally { clearInterval(timer); f.check = null; }
    while (busy) await sleep(10); // a check still running when the download ended
    if (over) return this.refuse(f, d, over);
    if (failure) return this.fail(f, d, s.disposed ? `session closed (${s.closeReason})` : failure);
    let src;
    try { src = abs ?? await d.path(); f.size = (await fs.promises.stat(src)).size; } catch { return this.fail(f, d, s.disposed ? `session closed (${s.closeReason})` : 'the downloaded file is gone'); }
    over = this.overLimit(f);
    if (over) return this.refuse(f, d, over);
    // Out of the browser's directory, which its context empties when it closes.
    f.dir = path.join(this.root, f.tenant, f.id);
    f.file = path.join(f.dir, f.name);
    try {
      await fs.promises.mkdir(f.dir, { recursive: true, mode: 0o700 });
      await fs.promises.rename(src, f.file);
      await fs.promises.chmod(f.file, 0o600);
    } catch (e) {
      await fs.promises.rm(f.dir, { recursive: true, force: true }).catch(() => {});
      return this.fail(f, d, s.disposed ? `session closed (${s.closeReason})` : `could not keep the file (${e.code || e.message})`);
    }
    if (this.closed || f.state !== 'downloading') return this.remove(f);
    f.state = 'ready';
    f.expiresAt = Date.now() + this.cfg.downloadTtlMs;
    this.settle(f);
  }

  // d: null when the browser refused the download itself (nothing to cancel).
  async refuse(f, d, reason) {
    f.state = 'refused';
    f.reason = reason;
    f.size = 0;
    await d?.cancel().catch(() => {});
    await d?.delete().catch(() => {}); // a small download may have finished before the cancel landed
    console.error(`bosun: tenant ${f.tenant}: refused download from ${f.source}: ${reason}`);
    this.settle(f);
  }

  async fail(f, d, reason) {
    f.state = 'failed';
    f.reason = reason;
    f.size = 0;
    await d.delete().catch(() => {});
    this.settle(f);
  }

  settle(f) {
    f.settledAt = Date.now();
    f.expiresAt = Math.max(f.expiresAt, f.settledAt + (f.state === 'ready' ? this.cfg.downloadTtlMs : 0));
    this.emit('change', f);
    this.events?.download(f.tenant, { ...this.info(f), session: f.session })?.catch(() => {});
  }

  // Refused and failed downloads are remembered for a while, but only so many per tenant.
  trimNotices(tenant) {
    const notes = [...this.files.values()].filter((f) => f.tenant === tenant && (f.state === 'refused' || f.state === 'failed'));
    for (const f of notes.slice(0, Math.max(0, notes.length - NOTICES_PER_TENANT))) this.files.delete(f.id);
  }

  // What the agent sees of a download.
  info(f) {
    const base = { download_id: f.id, state: f.state, filename: f.name, source_host: f.source, page_host: f.page };
    if (f.state === 'ready') return { ...base, size: f.size, mime: f.mime, allowed_by: f.by === 'url' ? 'download host' : 'page origin', expires_in_min: Math.max(0, Math.round((f.expiresAt - Date.now()) / 60000)), next: `download_get { download_id: "${f.id}" }` };
    if (f.state === 'downloading') return { ...base, bytes_so_far: f.size, next: 'call download_wait' };
    return { ...base, reason: f.reason };
  }

  // seq to pass to since() later: downloads that start after this point.
  mark() { return this.seq; }

  // The session's downloads that started after mark; waits up to SETTLE_MS for running ones to finish. Finished ones
  // count as reported (download_wait does not return them again). expectMs: wait that long for one to start (a
  // navigation the browser turned into a download fails before the download is announced).
  async since(sessionId, mark, { expectMs = 0 } = {}) {
    const mine = () => [...this.files.values()].filter((f) => f.session === sessionId && f.seq > mark && f.state !== 'deleted');
    const until = Date.now() + expectMs;
    while (!mine().length && Date.now() < until) await this.next(until - Date.now());
    const end = Date.now() + SETTLE_MS;
    while (mine().some((f) => f.state === 'downloading') && Date.now() < end) await this.next(end - Date.now());
    const out = mine().sort((a, b) => a.seq - b.seq);
    for (const f of out) if (f.state !== 'downloading') f.delivered = true;
    return out;
  }

  // Resolves on the next change (a download started or settled), after ms, or when signal aborts.
  next(ms, signal) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.off('change', done); signal?.removeEventListener('abort', done); resolve(); };
      const t = setTimeout(done, Math.max(0, ms));
      this.on('change', done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  // The session's oldest settled download not yet reported, waiting up to ms for one. null: none settled in time; a
  // running one is returned as such.
  async wait(tenant, sessionId, ms, signal) {
    const end = Date.now() + ms;
    for (;;) {
      const mine = [...this.files.values()].filter((f) => f.tenant === tenant && f.session === sessionId && f.state !== 'deleted').sort((a, b) => a.seq - b.seq);
      const f = mine.find((x) => !x.delivered && x.state !== 'downloading');
      if (f) { f.delivered = true; return f; }
      if (Date.now() >= end || signal?.aborted) return mine.find((x) => x.state === 'downloading') || null;
      await this.next(end - Date.now(), signal);
    }
  }

  list(tenant, sessionId = null) {
    return [...this.files.values()].filter((f) => f.tenant === tenant && f.state !== 'deleted' && (!sessionId || f.session === sessionId)).sort((a, b) => a.seq - b.seq);
  }

  // Same message for "never existed", "another tenant's" and "already fetched", so ids can't be probed.
  get(tenant, id) {
    const f = this.files.get(id);
    if (!f || f.tenant !== tenant || f.state === 'deleted') throw new Error(`no download ${String(id).slice(0, 40)} (deleted once fetched, ${Math.round(this.cfg.downloadTtlMs / 60000)} min after it finished, or on a service restart)`);
    if (f.state === 'downloading') throw new Error(`download ${id} is still running (${f.size} bytes so far); call download_wait`);
    if (f.state !== 'ready') throw new Error(`download ${id} was ${f.state}: ${f.reason}`);
    if (f.sending) throw new Error(`download ${id} is being fetched right now; it is deleted once that completes (call download_get again if it fails)`);
    return f;
  }

  // A one-time GET URL secret, valid DOWNLOAD_URL_TTL_SEC; a new one replaces the previous one.
  issue(f) {
    f.secret = crypto.randomBytes(24).toString('base64url');
    f.urlExpiresAt = Date.now() + this.cfg.downloadUrlTtlMs;
    return f.secret;
  }

  // The file's text, if it is small and UTF-8 text (no NUL), and then it counts as fetched; otherwise null.
  async inline(f) {
    if (f.size > INLINE_MAX_BYTES || f.sending) return null;
    f.sending = true; // claimed before anything is awaited: a second fetch meanwhile is refused (get())
    let text = null;
    try {
      const buf = await fs.promises.readFile(f.file);
      if (!buf.includes(0)) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {} }
    } finally { f.sending = false; }
    if (text === null) return null;
    await this.remove(f);
    return text;
  }

  // The file is unusable at once; its bytes (quota) and its slot are released only once the directory is gone. A
  // removal that fails is retried by the sweep.
  remove(f) {
    if (f.state !== 'deleted') {
      f.state = 'deleted';
      f.secret = null;
    }
    if (!f.dir) { this.files.delete(f.id); return Promise.resolve(); }
    f.removing ??= fs.promises.rm(f.dir, { recursive: true, force: true }).then(() => {
      if (this.files.get(f.id) === f) this.files.delete(f.id);
    }, (e) => {
      console.error(`bosun: download ${f.id} of tenant ${f.tenant} not deleted yet (${e.code || e.message}); retrying`);
    }).finally(() => { f.removing = null; });
    return f.removing;
  }

  sweep(now = Date.now()) {
    for (const f of [...this.files.values()]) {
      if (f.secret && now > f.urlExpiresAt) f.secret = null;
      // A GET still sending past the file's expiry is cut off (its client has stalled), then the file goes.
      if (f.sending && now > f.expiresAt + GET_IDLE_MS) f.abort?.();
      if (f.state === 'deleted' || ((f.state === 'ready' || f.state === 'refused' || f.state === 'failed') && now > f.expiresAt && !f.sending)) this.remove(f);
    }
  }

  // The session's browser is gone (its context deleted whatever was still running): drop its download directory.
  async sessionClosed(s) {
    s.dlWatcher?.close();
    if (s.dlDir) await fs.promises.rm(s.dlDir, { recursive: true, force: true }).catch(() => {});
  }

  // GET /download/<id>?t=<secret>, or GET /download/<id> with the tenant's token in Authorization. Answers the
  // request itself; returns true when the path was ours. authTenant(req): the tenant of an Authorization header, null
  // without one, false for a token that doesn't authenticate. With both, both must hold. Once the whole file is sent
  // it is deleted; an interrupted GET leaves it (call download_get for a new URL).
  async handle(req, res, { authTenant }) {
    const u = new URL(req.url, 'http://x');
    const m = /^\/download\/([^/]+)$/.exec(u.pathname);
    if (!m) return false;
    const reply = (code, body) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body) + '\n');
      req.resume();
    };
    if (req.method !== 'GET') { reply(405, { error: 'GET only' }); return true; }
    const f = ID_RE.test(m[1]) ? this.files.get(m[1]) : null;
    const secret = u.searchParams.get('t');
    const okSecret = secret === null || (!!f?.secret && Buffer.byteLength(secret) === f.secret.length && crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(f.secret)));
    const hdr = authTenant(req);
    if (secret === null && !hdr) { reply(401, { error: 'give the URL from download_get (with ?t=), or your token in Authorization: Bearer' }); return true; }
    if (!f || !okSecret || f.state !== 'ready' || f.sending || (secret !== null && Date.now() > f.urlExpiresAt)) { reply(404, { error: 'no such download URL (used, expired, or never issued); call download_get again' }); return true; }
    if (hdr === false || (hdr !== null && hdr !== f.tenant)) { reply(403, { error: 'this token may not fetch that download' }); return true; }
    if (!this.allowFor(f.tenant)) { reply(403, { error: 'downloads are not allowed for this token' }); return true; }
    if ([...this.files.values()].filter((x) => x.tenant === f.tenant && x.sending).length >= GETS_PER_TENANT) {
      reply(429, { error: `too many downloads being fetched at once (${GETS_PER_TENANT} per token); retry this URL in a moment` });
      return true;
    }
    // The URL is spent from here on.
    f.secret = null;
    f.sending = true;
    let stream = null;
    const ac = new AbortController();
    f.abort = () => ac.abort();
    // A client that stops reading is dropped: GET_IDLE_MS without progress, GET_MAX_MS in all.
    res.setTimeout(GET_IDLE_MS, () => ac.abort());
    const deadline = setTimeout(() => ac.abort(), GET_MAX_MS);
    try {
      const headers = {
        'content-type': f.mime, 'content-length': String(f.size), 'content-disposition': disposition(f.name),
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store', connection: 'close',
      };
      stream = fs.createReadStream(f.file);
      await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
      res.writeHead(200, headers);
      await pipeline(stream, res, { signal: ac.signal });
      f.sending = false;
      await this.remove(f); // fetched
    } catch {
      stream?.destroy();
      f.sending = false;
      if (!res.headersSent) reply(500, { error: 'could not read the file; call download_get again' });
      else res.destroy();
    } finally {
      clearTimeout(deadline);
      f.abort = null;
    }
    return true;
  }

  async close() {
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.files.values()].map((f) => this.remove(f)));
    await Promise.race([fs.promises.rm(this.root, { recursive: true, force: true }).catch(() => {}), sleep(5000)]);
  }
}

// Bytes of the files in dir (not recursive); 0 when it is gone.
async function dirBytes(dir) {
  let n = 0;
  try {
    for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (e.isFile()) n += (await fs.promises.stat(path.join(dir, e.name)).catch(() => ({ size: 0 }))).size;
    }
  } catch {}
  return n;
}
