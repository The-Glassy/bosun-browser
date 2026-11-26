// Tenant sandbox: a worker has no network and no store token. The gateway serves each worker its own Unix socket
// (in that worker's read-only relay directory); the socket is the tenant, so a worker can only ever ask for its own
// tenant's recipes and save targets. The client side gives the tools the same interface as SecretStores.forTenant.
import fs from 'node:fs';
import http from 'node:http';
import { StoreError, STORE_VALUE_MAX_BYTES } from './index.mjs';

const MAX_BODY = STORE_VALUE_MAX_BYTES + 4096;

function body(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); reject(new StoreError('TOO_LARGE', 'request too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// store: SecretStores.forTenant(tenant). Returns { close }.
export async function startSecretBroker({ store, socketPath }) {
  const server = http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    try {
      const u = new URL(req.url, 'http://broker');
      if (req.method === 'GET' && u.pathname === '/list') return json(200, store.list());
      if (req.method !== 'POST') return json(405, { code: 'INVALID', error: 'POST only' });
      const raw = await body(req);
      if (u.pathname === '/resolve') {
        const a = JSON.parse(raw.toString('utf8'));
        const value = await store.resolve(a.recipe, { session: a.session, origin: a.origin });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': value.length });
        return res.end(value, () => value.fill(0));
      }
      if (u.pathname === '/save') {
        const q = u.searchParams;
        return json(200, await store.save(q.get('target'), q.get('key'), raw, { overwrite: q.get('overwrite') === '1', session: q.get('session') ?? undefined, origin: q.get('origin') ?? undefined }));
      }
      if (u.pathname === '/note') { store.note(JSON.parse(raw.toString('utf8'))); raw.fill(0); return json(200, {}); }
      return json(404, { code: 'NOT_FOUND', error: 'no such operation' });
    } catch (e) {
      const known = e instanceof StoreError;
      if (res.headersSent) return res.destroy();
      return json(known ? 400 : 500, { code: known ? e.code : 'UNAVAILABLE', error: known ? e.message : 'the secret store failed' });
    }
  });
  server.on('clientError', (_e, sock) => sock.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: socketPath }, () => { server.off('error', reject); resolve(); });
  });
  fs.chmodSync(socketPath, 0o600);
  return { close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }) };
}

function call(socketPath, method, url, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: url, timeout: 70_000,
      headers: payload ? { 'content-type': 'application/octet-stream', 'content-length': payload.length } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

// The worker side. load() fetches the tenant's recipes and targets once (they change only with a restart).
export async function connectSecretBroker(socketPath) {
  const ask = async (method, url, payload) => {
    let r;
    try { r = await call(socketPath, method, url, payload); } catch { throw new StoreError('UNAVAILABLE', 'the secret store is not reachable from this worker'); }
    if (r.status !== 200) {
      let doc = null;
      try { doc = JSON.parse(r.body.toString('utf8')); } catch {}
      throw new StoreError(doc?.code || 'UNAVAILABLE', doc?.error || 'the secret store failed');
    }
    return r;
  };
  const listed = JSON.parse((await ask('GET', '/list')).body.toString('utf8'));
  const json = (obj) => Buffer.from(JSON.stringify(obj), 'utf8');
  return {
    enabled: listed.recipes.length > 0 || listed.save_targets.length > 0,
    list: () => listed,
    binding: (name) => {
      const r = listed.recipes.find((x) => x.name === name);
      if (!r) throw new StoreError('NOT_FOUND', `no recipe ${String(name).slice(0, 64)} for this token (secret_recipes lists them)`);
      return r;
    },
    resolve: async (name, where = {}) => (await ask('POST', '/resolve', json({ recipe: name, session: where.session, origin: where.origin }))).body,
    save: async (target, key, value, { overwrite = false, session, origin } = {}) => {
      const q = new URLSearchParams({ target: String(target), key: String(key), ...(overwrite ? { overwrite: '1' } : {}), ...(session ? { session } : {}), ...(origin ? { origin } : {}) });
      try { return JSON.parse((await ask('POST', `/save?${q}`, value)).body.toString('utf8')); } finally { value.fill(0); }
    },
    note: (e) => { ask('POST', '/note', json(e)).catch(() => {}); },
  };
}
