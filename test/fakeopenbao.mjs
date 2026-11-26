// A stand-in for OpenBao / Vault: KV v2 (data/<path>, check-and-set, versions), KV v1, tokens with path policies,
// and single-use response-wrapping tokens (sys/wrapping/unwrap). Enough to exercise the adapter; no TLS.
import http from 'node:http';

export async function startFakeOpenBao({ mount = 'secret', kv = 2 } = {}) {
  const entries = new Map(); // path -> { data, version }
  const tokens = new Map(); // token -> { read: RegExp, write: RegExp }
  const wraps = new Map(); // wrapping token -> token (deleted on unwrap)
  const requests = []; // { method, url, token, namespace, body }
  let down = false, redirect = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const token = req.headers['x-vault-token'] ?? null;
      requests.push({ method: req.method, url: req.url, token, namespace: req.headers['x-vault-namespace'] ?? null, body: raw });
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === null ? '' : JSON.stringify(obj)); };
      if (down) return json(503, { errors: ['sealed'] });
      if (redirect) { res.writeHead(307, { location: 'http://127.0.0.1:1/elsewhere' }); return res.end(); }
      if (req.method === 'POST' && req.url === '/v1/sys/wrapping/lookup') {
        const w = wraps.get(JSON.parse(raw).token);
        return w ? json(200, { data: { creation_path: w.creationPath, creation_ttl: 60 } }) : json(400, { errors: ['wrapping token is not valid or does not exist'] });
      }
      if (req.method === 'POST' && req.url === '/v1/sys/wrapping/unwrap') {
        const inner = wraps.get(token);
        if (!inner) return json(400, { errors: ['wrapping token is not valid or does not exist'] });
        wraps.delete(token);
        return json(200, { auth: { client_token: inner.token } });
      }
      const prefix = kv === 2 ? `/v1/${mount}/data/` : `/v1/${mount}/`;
      if (!req.url.startsWith(prefix)) return json(404, { errors: [] });
      const p = req.url.slice(prefix.length);
      const policy = tokens.get(token);
      if (!policy) return json(403, { errors: ['permission denied'] });
      if (req.method === 'GET') {
        if (!policy.read.test(p)) return json(403, { errors: ['permission denied'] });
        const e = entries.get(p);
        if (!e) return json(404, { errors: [] });
        return json(200, kv === 2 ? { data: { data: e.data, metadata: { version: e.version } } } : { data: e.data });
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        if (!policy.write.test(p)) return json(403, { errors: ['permission denied'] });
        const doc = JSON.parse(raw);
        const e = entries.get(p);
        if (kv === 2) {
          const cas = doc.options?.cas;
          if (cas !== undefined && cas !== (e?.version ?? 0)) return json(400, { errors: ['check-and-set parameter did not match the current version'] });
          const version = (e?.version ?? 0) + 1;
          entries.set(p, { data: doc.data, version });
          return json(200, { data: { version } });
        }
        entries.set(p, { data: doc, version: 0 });
        return json(204, null);
      }
      return json(405, { errors: [] });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    address: `http://127.0.0.1:${server.address().port}`, entries, requests,
    put(p, data) { entries.set(p, { data, version: (entries.get(p)?.version ?? 0) + 1 }); },
    token(token, { read = /^/, write = /^/ } = {}) { tokens.set(token, { read, write }); return token; },
    wrap(wrapping, token, creationPath = 'auth/token/create') { wraps.set(wrapping, { token, creationPath }); return wrapping; },
    set down(v) { down = v; }, set redirect(v) { redirect = v; },
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}
