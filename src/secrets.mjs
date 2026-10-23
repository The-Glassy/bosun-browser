// Secrets an agent types into a page without seeing them (type with secret_id). The value comes in over a one-time
// HTTP PUT on the MCP port, straight from the agent's shell (e.g. piped from sops), so it is never part of a tool
// call or its result. Held in memory only (never on disk, never logged: log lines carry the id and the length),
// deleted once typed or SECRET_TTL_MS after it arrived, and gone on a restart. Every lookup is by tenant: a secret
// id of another tenant is "no such secret".
import crypto from 'crypto';

export const SECRET_MAX_BYTES = 4096;
export const SECRET_URL_TTL_MS = 15 * 60_000; // the PUT URL
export const SECRET_TTL_MS = 10 * 60_000; // a secret that arrived and was not typed
const SECRETS_PER_TENANT = 20; // waiting or ready, per tenant
const SECRETS_TOTAL = 200; // and across the service
const PUT_IDLE_MS = 30_000; // a PUT that sends nothing for this long is dropped
const ID_RE = /^s[0-9a-f]{16}$/;

const wipe = (b) => { if (b) b.fill(0); };

export class Secrets {
  constructor({ log = (...a) => console.error(...a) } = {}) {
    this.log = log;
    this.items = new Map(); // id -> {id, tenant, label, state: pending|receiving|ready, token, urlExpiresAt, expiresAt, value}
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  count(tenant) { let n = 0; for (const x of this.items.values()) if (x.tenant === tenant) n++; return n; }

  // A slot that waits for its PUT (token in the URL) for SECRET_URL_TTL_MS.
  create(tenant, { label = null } = {}) {
    if (this.closed) throw new Error('service is shutting down');
    if (this.items.size >= SECRETS_TOTAL) throw new Error(`the service holds ${SECRETS_TOTAL} secrets already; try again later`);
    if (this.count(tenant) >= SECRETS_PER_TENANT) throw new Error(`this token holds ${SECRETS_PER_TENANT} secrets already (waiting or not typed yet); type them, or let them expire`);
    const id = `s${crypto.randomBytes(8).toString('hex')}`;
    const x = {
      id, tenant, label, state: 'pending', token: crypto.randomBytes(24).toString('base64url'),
      urlExpiresAt: Date.now() + SECRET_URL_TTL_MS, expiresAt: null, value: null,
    };
    this.items.set(id, x);
    return x;
  }

  // Same message for "never existed", "another tenant's", "already typed" and "expired", so ids can't be probed.
  find(tenant, id) {
    const x = this.items.get(id);
    if (!x || x.tenant !== tenant) throw new Error(`no secret ${String(id).slice(0, 40)} (each one is deleted once typed, ${SECRET_TTL_MS / 60000} min after it arrived, or on a service restart); call secret_create again`);
    if (x.state !== 'ready') throw new Error(`secret ${x.id} has not arrived yet: PUT it first (the curl line from secret_create), then call type`);
    return x;
  }

  // The value, as a Buffer the caller wipes; the secret is deleted at once, so it can be typed only once.
  take(tenant, id) {
    const x = this.find(tenant, id);
    const v = x.value;
    x.value = null;
    this.remove(x);
    return v;
  }

  remove(x) {
    wipe(x.value);
    x.value = null;
    x.token = null;
    x.state = 'deleted';
    x.abort?.();
    if (this.items.get(x.id) === x) this.items.delete(x.id);
  }

  sweep(now = Date.now()) {
    for (const x of [...this.items.values()]) {
      if ((x.state === 'pending' && now > x.urlExpiresAt) || (x.state === 'ready' && now > x.expiresAt)) {
        if (x.state === 'ready') this.log(`bosun: secret ${x.id} of tenant ${x.tenant}: expired untyped`);
        this.remove(x);
      }
    }
  }

  // PUT /secret/<id>?t=<token>, or PUT /secret/<id> with the tenant's token in Authorization. Answers the request
  // itself; returns true when the path was ours. authTenant(req): the tenant of an Authorization header, null
  // without one, false for a token that doesn't authenticate. With both, both must hold. No answer and no log line
  // ever carries the body.
  async handle(req, res, { authTenant, policyOf }) {
    const u = new URL(req.url, 'http://x');
    const m = /^\/secret\/([^/]+)$/.exec(u.pathname);
    if (!m) return false;
    const reply = (code, body) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(code, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body) + '\n');
      req.resume();
    };
    if (req.method !== 'PUT') { reply(405, { error: 'PUT only' }); return true; }
    const x = ID_RE.test(m[1]) ? this.items.get(m[1]) : null;
    const token = u.searchParams.get('t');
    const okToken = token === null || (!!x?.token && Buffer.byteLength(token) === x.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(x.token)));
    const hdr = authTenant(req);
    if (token === null && !hdr) { reply(401, { error: 'give the URL from secret_create (with ?t=), or your token in Authorization: Bearer' }); return true; }
    if (!x || !okToken || x.state !== 'pending' || Date.now() > x.urlExpiresAt) { reply(404, { error: 'no such secret URL (used, expired, or never issued); call secret_create again' }); return true; }
    if (hdr === false || (hdr !== null && hdr !== x.tenant)) { reply(403, { error: 'this token may not send to that URL' }); return true; }
    if (policyOf(x.tenant) === 'ephemeral') { reply(403, { error: 'secrets are not allowed for this token' }); return true; }
    const len = req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : null;
    if (len !== null && (!Number.isSafeInteger(len) || len < 0)) { reply(400, { error: 'bad Content-Length' }); return true; }
    if (len !== null && len > SECRET_MAX_BYTES + 1) { reply(413, { error: `a secret is at most ${SECRET_MAX_BYTES} bytes` }); return true; }
    if (req.headers.expect && !/^100-continue$/i.test(req.headers.expect)) { reply(417, { error: 'unsupported Expect' }); return true; }

    // The URL is spent from here on: a second PUT, even while this one runs, gets 404.
    x.state = 'receiving';
    x.token = null;
    if (req.headers.expect) res.writeContinue();
    const body = Buffer.alloc(SECRET_MAX_BYTES + 1); // the secret and one trailing newline, at most
    let size = 0, why = null;
    try {
      await new Promise((resolve, reject) => {
        const fail = (code, msg) => { why ??= { code, msg }; reject(new Error(msg)); };
        x.abort = () => fail(400, 'cancelled');
        req.setTimeout(PUT_IDLE_MS, () => fail(400, 'nothing arrived for 30 s'));
        req.on('data', (chunk) => {
          if (why) return wipe(chunk);
          if (size + chunk.length > body.length) {
            wipe(chunk);
            return fail(413, `a secret is at most ${SECRET_MAX_BYTES} bytes`);
          }
          chunk.copy(body, size);
          size += chunk.length;
          wipe(chunk);
        });
        req.on('end', resolve);
        req.on('error', () => fail(400, 'upload interrupted'));
        req.on('close', () => { if (!req.complete) fail(400, 'upload interrupted'); });
      });
      x.abort = null;
      let n = size;
      if (n > 0 && body[n - 1] === 0x0a) n--; // one trailing newline (echo, a here-string) is not part of the secret
      if (n > SECRET_MAX_BYTES) throw Object.assign(new Error(`a secret is at most ${SECRET_MAX_BYTES} bytes`), { code: 413 });
      if (n === 0) throw Object.assign(new Error('the secret is empty'), { code: 400 });
      const value = Buffer.from(body.subarray(0, n));
      try { new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { wipe(value); throw Object.assign(new Error('the secret is not valid UTF-8'), { code: 400 }); }
      if (x.state !== 'receiving') { wipe(value); throw Object.assign(new Error('cancelled'), { code: 400 }); }
      x.value = value;
      x.state = 'ready';
      x.expiresAt = Date.now() + SECRET_TTL_MS;
      if (this.closed) this.remove(x);
      this.log(`bosun: secret ${x.id} of tenant ${x.tenant}: received, ${n} bytes`);
      reply(201, { secret_id: x.id, ...(x.label ? { label: x.label } : {}), bytes: n, valid_min: SECRET_TTL_MS / 60000, next: `call type with secret_id ${x.id}` });
    } catch (e) {
      const code = why?.code ?? e.code ?? 400;
      const msg = why?.msg ?? e.message;
      x.abort = null;
      this.remove(x);
      if (code === 413) {
        if (!res.headersSent) { res.writeHead(413, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify({ error: msg }) + '\n', () => req.socket?.destroy()); }
        else req.socket?.destroy();
      } else if (!req.socket?.destroyed) reply(400, { error: `${msg}; call secret_create again` });
    } finally {
      wipe(body);
      x.abort = null;
    }
    return true;
  }

  close() {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const x of [...this.items.values()]) this.remove(x);
  }
}
