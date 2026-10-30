// One-time GET URLs for a meeting's recording (recording_get). The file stays where it is (BROWSER_DATA/recordings/<tenant>,
// 0600, deleted by the retention sweep or meeting_recording_delete); only the URL is spent. It is bound to the tenant
// that asked, valid DOWNLOAD_URL_TTL_SEC, and the file is looked up again when it is fetched, so a recording that was
// deleted (an opt-out, meeting_recording_delete) after the URL was issued is gone for the URL too, even mid-transfer.
import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';

const ID_RE = /^m[0-9a-f]{12}$/;
const GETS_PER_TENANT = 4; // recordings streaming at once, per tenant
const GET_IDLE_MS = 60_000; // a GET whose client reads nothing for this long is dropped
const GET_MAX_MS = 60 * 60_000;

export class RecordingLinks {
  // resolve(tenant, id) -> absolute path of a finished recording, or throws (not yours, still recording, deleted).
  constructor({ cfg, resolve }) {
    Object.assign(this, { cfg, resolve });
    this.links = new Map(); // meeting id -> {tenant, secret, expiresAt}: a URL not used yet
    this.transfers = new Set(); // GETs streaming now: {id, tenant, abort}
  }

  // A new URL secret for the tenant's meeting; it replaces the previous one.
  issue(tenant, id) {
    const secret = crypto.randomBytes(24).toString('base64url');
    this.links.set(id, { tenant, secret, expiresAt: Date.now() + this.cfg.downloadUrlTtlMs });
    return secret;
  }

  // The tenant's recording is gone (deleted): no URL works any more and a transfer under way is cut off. Another
  // tenant's links and transfers are not touched, whatever id it names.
  revoke(tenant, id) {
    if (this.links.get(id)?.tenant === tenant) this.links.delete(id);
    for (const t of this.transfers) if (t.id === id && t.tenant === tenant) t.abort();
  }

  sweep(now = Date.now()) {
    for (const [id, l] of this.links) if (now > l.expiresAt) this.links.delete(id);
  }

  // GET /recording/<meeting_id>?t=<secret>; Authorization (the tenant's token) is optional but must match when sent.
  // Answers the request itself; returns true when the path was ours.
  async handle(req, res, { authTenant }) {
    const u = new URL(req.url, 'http://x');
    const m = /^\/recording\/([^/]+)$/.exec(u.pathname);
    if (!m) return false;
    const reply = (code, body) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body) + '\n');
      req.resume();
    };
    if (req.method !== 'GET') { reply(405, { error: 'GET only' }); return true; }
    const id = m[1];
    const secret = u.searchParams.get('t');
    if (secret === null) { reply(401, { error: 'give the URL from recording_get (with ?t=)' }); return true; }
    const l = ID_RE.test(id) ? this.links.get(id) : null;
    const ok = !!l && Buffer.byteLength(secret) === l.secret.length && crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(l.secret));
    if (!ok || Date.now() > l.expiresAt) { reply(404, { error: 'no such recording URL (used, expired, or never issued); call recording_get again' }); return true; }
    const hdr = authTenant(req);
    if (hdr === false || (hdr !== null && hdr !== l.tenant)) { reply(403, { error: 'this token may not fetch that recording' }); return true; }
    if ([...this.transfers].filter((x) => x.tenant === l.tenant).length >= GETS_PER_TENANT) {
      reply(429, { error: `too many recordings being fetched at once (${GETS_PER_TENANT} per token); retry this URL in a moment` });
      return true;
    }
    let file;
    try { file = this.resolve(l.tenant, id); } catch (e) { this.links.delete(id); reply(409, { error: e.message }); return true; }
    // The URL is spent from here on (a transfer that breaks needs a new recording_get).
    this.links.delete(id);
    const ac = new AbortController();
    const transfer = { id, tenant: l.tenant, abort: () => ac.abort() };
    this.transfers.add(transfer);
    res.setTimeout(GET_IDLE_MS, () => ac.abort());
    const deadline = setTimeout(() => ac.abort(), GET_MAX_MS);
    let stream = null;
    try {
      stream = fs.createReadStream(file);
      await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
      const { size } = fs.fstatSync(stream.fd);
      res.writeHead(200, {
        'content-type': 'audio/ogg', 'content-length': String(size), 'content-disposition': `attachment; filename="${id}.ogg"`,
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store', connection: 'close',
      });
      await pipeline(stream, res, { signal: ac.signal });
    } catch {
      stream?.destroy();
      if (!res.headersSent) reply(500, { error: 'could not read the recording; call recording_get again' });
      else res.destroy();
    } finally {
      clearTimeout(deadline);
      this.transfers.delete(transfer);
    }
    return true;
  }
}
