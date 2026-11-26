// Secret store adapters. One interface for every store:
//   read(path, field)  -> Buffer (the caller wipes it)
//   write(path, field, value: Buffer, { overwrite }) -> { version? }
//   close()
// A failure is a StoreError with a fixed code and a message that never carries a value, a token or a response body.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

export const STORE_VALUE_MAX_BYTES = 4096; // what type takes (secrets.mjs SECRET_MAX_BYTES)
export const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,9}$/;
export const FIELD_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export const STORE_CODES = ['NOT_FOUND', 'FORBIDDEN', 'EXISTS', 'INVALID', 'TOO_LARGE', 'UNSUPPORTED', 'UNAVAILABLE'];

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new StoreError(code, message); };

export function checkPath(p) {
  if (typeof p !== 'string' || !PATH_RE.test(p) || p.length > 200) fail('INVALID', 'a store path is 1-10 segments of letters, digits, . _ - separated by / (each starts with a letter or digit)');
  return p;
}
export function checkField(f) {
  if (f === undefined || f === null) return null;
  if (typeof f !== 'string' || !FIELD_RE.test(f)) fail('INVALID', 'a store field is 1-64 letters, digits, . _ -');
  return f;
}

// What a store hands out as a secret: non-empty UTF-8 of at most STORE_VALUE_MAX_BYTES, one trailing newline dropped
// (files, CLI output). Returns a fresh Buffer and wipes the input.
export function secretBytes(raw, { trimNewline = false } = {}) {
  let n = raw.length;
  if (trimNewline && n && raw[n - 1] === 0x0a) { n--; if (n && raw[n - 1] === 0x0d) n--; }
  try {
    if (n === 0) fail('NOT_FOUND', 'the store entry is empty');
    if (n > STORE_VALUE_MAX_BYTES) fail('TOO_LARGE', `a secret is at most ${STORE_VALUE_MAX_BYTES} bytes`);
    const out = Buffer.from(raw.subarray(0, n));
    try { new TextDecoder('utf-8', { fatal: true }).decode(out); } catch { out.fill(0); fail('INVALID', 'the store entry is not valid UTF-8'); }
    return out;
  } finally { raw.fill(0); }
}

const only = (cfg, name, keys) => {
  for (const k of Object.keys(cfg)) if (!keys.includes(k)) throw new Error(`secret store "${name}": unknown key "${k}" (known: ${keys.join(', ')})`);
};
const absolute = (name, key, v) => {
  if (typeof v !== 'string' || !path.isAbsolute(v)) throw new Error(`secret store "${name}": ${key} must be an absolute path`);
  return v;
};

// --- file: one secret per file under dir. Without a field the file is the value; with one the file is a JSON
// object and the field one of its string members. Written 0600 in 0700 directories, atomically.
function fileStore(name, cfg) {
  only(cfg, name, ['type', 'dir', 'read_only']);
  const dir = absolute(name, 'dir', cfg.dir);
  const readOnly = cfg.read_only === true;
  // The file a path names, inside dir after links are resolved (a link out of dir is refused).
  const locate = (p, { forWrite = false } = {}) => {
    const file = path.join(dir, ...checkPath(p).split('/'));
    let root;
    try { root = fs.realpathSync(dir); } catch { fail('UNAVAILABLE', `file store ${name}: its directory is not there`); }
    if (forWrite) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let real;
    try { real = fs.realpathSync(forWrite ? path.dirname(file) : file); } catch (e) { fail(e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'NOT_FOUND' : 'FORBIDDEN', `file store ${name}: no such entry`); }
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) fail('FORBIDDEN', `file store ${name}: the entry is outside the store directory`);
    return forWrite ? path.join(real, path.basename(file)) : real;
  };
  const load = (file) => {
    let st;
    try { st = fs.statSync(file); } catch (e) { fail(e.code === 'ENOENT' ? 'NOT_FOUND' : 'FORBIDDEN', `file store ${name}: no such entry`); }
    if (!st.isFile()) fail('NOT_FOUND', `file store ${name}: no such entry`);
    if (st.size > 64 * 1024) fail('TOO_LARGE', `file store ${name}: the entry is too large`);
    try { return fs.readFileSync(file); } catch { fail('FORBIDDEN', `file store ${name}: the entry cannot be read`); }
  };
  const object = (raw) => {
    let doc;
    try { doc = JSON.parse(raw.toString('utf8')); } catch { doc = null; } finally { raw.fill(0); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('INVALID', `file store ${name}: the entry is not a JSON object (a field was asked for)`);
    return doc;
  };
  return {
    type: 'file', name, writable: !readOnly,
    async read(p, field) {
      const raw = load(locate(p));
      if (!checkField(field)) return secretBytes(raw, { trimNewline: true });
      const doc = object(raw);
      if (typeof doc[field] !== 'string' || !Object.hasOwn(doc, field)) fail('NOT_FOUND', `file store ${name}: no such field`);
      return secretBytes(Buffer.from(doc[field], 'utf8'));
    },
    async write(p, field, value, { overwrite = false } = {}) {
      if (readOnly) fail('UNSUPPORTED', `file store ${name} is read-only`);
      const file = locate(p, { forWrite: true });
      let content = value;
      const exists = fs.existsSync(file);
      if (checkField(field)) {
        const doc = exists ? object(load(file)) : {};
        if (Object.hasOwn(doc, field) && !overwrite) fail('EXISTS', `file store ${name}: the entry exists (pass overwrite to replace it)`);
        doc[field] = value.toString('utf8');
        content = Buffer.from(`${JSON.stringify(doc)}\n`, 'utf8');
      } else if (exists && !overwrite) fail('EXISTS', `file store ${name}: the entry exists (pass overwrite to replace it)`);
      const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
        // link fails when the name was taken meanwhile: a create never replaces what another writer just put there.
        if (!exists && !overwrite) { fs.linkSync(tmp, file); fs.rmSync(tmp, { force: true }); } else fs.renameSync(tmp, file);
      } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch {}
        if (e.code === 'EEXIST') fail('EXISTS', `file store ${name}: the entry exists (pass overwrite to replace it)`);
        fail('UNAVAILABLE', `file store ${name}: the entry cannot be written (${e.code || 'error'})`);
      } finally { if (content !== value) content.fill(0); }
      return {};
    },
    close() {},
  };
}

// --- env: read-only, PREFIX + the path in capitals (non-alphanumerics become _). The values are taken once, at
// start (config.mjs), and the variables are removed from the process environment so no browser inherits them.
export const envName = (prefix, p, field) => `${prefix}${[p, field].filter(Boolean).join('_').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
function envStore(name, cfg, { env }) {
  only(cfg, name, ['type', 'prefix']);
  const prefix = cfg.prefix ?? 'BOSUN_SECRET_';
  if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9_]{2,40}$/.test(prefix)) throw new Error(`secret store "${name}": prefix must be capitals, digits and _ (3-41 characters), e.g. BOSUN_SECRET_`);
  const values = new Map();
  for (const [k, v] of Object.entries(env)) if (k.startsWith(prefix) && typeof v === 'string' && v !== '') values.set(k, Buffer.from(v, 'utf8'));
  return {
    type: 'env', name, writable: false, envKeys: [...values.keys()],
    async read(p, field) {
      const v = values.get(envName(prefix, checkPath(p), checkField(field)));
      if (!v) fail('NOT_FOUND', `env store ${name}: no such variable`);
      return secretBytes(Buffer.from(v));
    },
    async write() { fail('UNSUPPORTED', `env store ${name} is read-only`); },
    close() { for (const v of values.values()) v.fill(0); values.clear(); },
  };
}

// --- openbao (and HashiCorp Vault): KV version 2 (default) or 1 over HTTPS. The token comes from token_file, or
// from wrapping_token_file: a single-use response-wrapping token that is unwrapped once, on first use, at
// sys/wrapping/unwrap (so the long-lived token never sits in a file Bosun's user can read later).
function request({ url, method, headers, body, ca, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) }, ...(ca ? { ca } : {}), timeout: timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { res.destroy(); reject(new Error('response too large')); } else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function openbaoStore(name, cfg, { isLoopbackHost }) {
  only(cfg, name, ['type', 'address', 'mount', 'kv_version', 'token_file', 'wrapping_token_file', 'wrapping_creation_path', 'namespace', 'ca_file', 'timeout_ms', 'read_only']);
  let base;
  try { base = new URL(cfg.address); } catch { throw new Error(`secret store "${name}": address is not a valid URL`); }
  const loopback = base.protocol === 'http:' && isLoopbackHost(base.hostname);
  if (base.protocol !== 'https:' && !loopback) throw new Error(`secret store "${name}": address must be https:// (http only on loopback)`);
  if (base.username || base.password || base.search || base.hash || base.pathname.replace(/\/+$/, '') !== '') throw new Error(`secret store "${name}": address is scheme, host and port only`);
  const mount = cfg.mount ?? 'secret';
  if (typeof mount !== 'string' || !PATH_RE.test(mount)) throw new Error(`secret store "${name}": mount must be a path such as secret`);
  const kv = cfg.kv_version ?? 2;
  if (kv !== 1 && kv !== 2) throw new Error(`secret store "${name}": kv_version must be 1 or 2`);
  if (!!cfg.token_file === !!cfg.wrapping_token_file) throw new Error(`secret store "${name}": give token_file or wrapping_token_file (one of them)`);
  const tokenFile = absolute(name, cfg.token_file ? 'token_file' : 'wrapping_token_file', cfg.token_file ?? cfg.wrapping_token_file);
  // Where the wrapping token must have been created (e.g. auth/token/create): checked for equality before the
  // unwrap, so a token wrapped by someone else on another path is not accepted.
  const creationPath = cfg.wrapping_creation_path ?? null;
  if (creationPath !== null && (!cfg.wrapping_token_file || typeof creationPath !== 'string' || !/^[A-Za-z0-9_./-]{1,200}$/.test(creationPath))) throw new Error(`secret store "${name}": wrapping_creation_path goes with wrapping_token_file and is a path such as auth/token/create`);
  if (cfg.namespace !== undefined && (typeof cfg.namespace !== 'string' || !/^[A-Za-z0-9_./-]{1,200}$/.test(cfg.namespace))) throw new Error(`secret store "${name}": namespace is not valid`);
  const ca = cfg.ca_file ? fs.readFileSync(absolute(name, 'ca_file', cfg.ca_file)) : null;
  const timeoutMs = cfg.timeout_ms ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error(`secret store "${name}": timeout_ms must be 100-60000`);
  const readOnly = cfg.read_only === true;
  const what = `openbao store ${name}`;

  const call = async (method, pathname, token, body) => {
    let res;
    try {
      res = await request({ url: new URL(`/v1/${pathname}`, base), method, body: body ? JSON.stringify(body) : null, ca, timeoutMs,
        headers: { ...(token ? { 'x-vault-token': token } : {}), 'x-vault-request': 'true', ...(cfg.namespace ? { 'x-vault-namespace': cfg.namespace } : {}) } });
    } catch (e) { fail('UNAVAILABLE', `${what} cannot be reached (${e.code || e.message})`); }
    let doc = null;
    try { doc = res.body.length ? JSON.parse(res.body.toString('utf8')) : null; } catch { doc = null; } finally { res.body.fill(0); }
    return { status: res.status, doc };
  };
  const refuse = (status, doc, { exists = false } = {}) => {
    if (status === 404) fail('NOT_FOUND', `${what}: no such entry`);
    if (status === 403 || status === 401) fail('FORBIDDEN', `${what}: the token may not do that (HTTP ${status})`);
    // KV v2 answers a failed check-and-set with 400 and an error that names it.
    if (exists && status === 400 && /check-and-set/i.test(String(doc?.errors?.[0] ?? ''))) fail('EXISTS', `${what}: the entry exists (pass overwrite to replace it)`);
    if (status >= 300 && status < 400) fail('UNAVAILABLE', `${what} redirected the request (HTTP ${status}); point address at the active node`);
    fail('UNAVAILABLE', `${what} answered HTTP ${status}`);
  };

  let tokenP = null;
  const token = () => (tokenP ??= (async () => {
    let raw;
    try { raw = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { fail('UNAVAILABLE', `${what}: its token file cannot be read (${e.code || 'error'})`); }
    if (!/^[\x21-\x7e]{8,4096}$/.test(raw)) fail('UNAVAILABLE', `${what}: its token file does not hold a token`);
    if (!cfg.wrapping_token_file) return raw;
    if (creationPath) {
      const looked = await call('POST', 'sys/wrapping/lookup', '', { token: raw });
      if (looked.status !== 200) fail('FORBIDDEN', `${what}: the wrapping token is not valid (HTTP ${looked.status}): it is single-use and short-lived, issue a new one`);
      if (looked.doc?.data?.creation_path !== creationPath) fail('FORBIDDEN', `${what}: the wrapping token was not created at wrapping_creation_path; it was not used`);
    }
    const { status, doc } = await call('POST', 'sys/wrapping/unwrap', raw, null);
    if (status !== 200) fail(status === 400 || status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE', `${what}: the wrapping token was refused (HTTP ${status}): it is single-use and short-lived, issue a new one`);
    const t = doc?.auth?.client_token ?? doc?.data?.token;
    if (typeof t !== 'string' || !t) fail('UNAVAILABLE', `${what}: the wrapped response holds no token`);
    return t;
  })().catch((e) => { tokenP = null; throw e; }));

  const dataPath = (p) => (kv === 2 ? `${mount}/data/${p}` : `${mount}/${p}`);
  return {
    type: 'openbao', name, writable: !readOnly,
    async read(p, field) {
      checkPath(p);
      const f = checkField(field) ?? 'value';
      const { status, doc } = await call('GET', dataPath(p), await token());
      if (status !== 200) refuse(status, doc);
      const data = kv === 2 ? doc?.data?.data : doc?.data;
      // A deleted KV v2 version answers 200/404 with data null.
      if (!data || typeof data !== 'object') fail('NOT_FOUND', `${what}: no such entry`);
      if (!Object.hasOwn(data, f) || typeof data[f] !== 'string') fail('NOT_FOUND', `${what}: no such field`);
      return secretBytes(Buffer.from(data[f], 'utf8'));
    },
    async write(p, field, value, { overwrite = false } = {}) {
      if (readOnly) fail('UNSUPPORTED', `${what} is read-only`);
      checkPath(p);
      const f = checkField(field) ?? 'value';
      const t = await token();
      // Other fields of the entry are kept: read, merge, write back under check-and-set (KV v2), so a concurrent
      // writer is noticed instead of overwritten.
      const cur = await call('GET', dataPath(p), t);
      if (cur.status !== 200 && cur.status !== 404) refuse(cur.status, cur.doc);
      const old = cur.status === 200 ? (kv === 2 ? cur.doc?.data?.data : cur.doc?.data) : null;
      const version = kv === 2 && cur.status === 200 ? Number(cur.doc?.data?.metadata?.version ?? 0) : 0;
      if (old && Object.hasOwn(old, f) && !overwrite) fail('EXISTS', `${what}: the entry exists (pass overwrite to replace it)`);
      const data = { ...(old && typeof old === 'object' ? old : {}), [f]: value.toString('utf8') };
      const { status, doc } = await call('POST', dataPath(p), t, kv === 2 ? { options: { cas: old ? version : 0 }, data } : data);
      if (status !== 200 && status !== 204) refuse(status, doc, { exists: true });
      return kv === 2 && Number.isInteger(doc?.data?.version) ? { version: doc.data.version } : {};
    },
    close() { tokenP = null; },
  };
}

// --- command stores (1Password's op, Bitwarden Secrets Manager's bws): read-only, one CLI call per read with a
// minimal environment. The CLI's token comes from token_file and is passed in its environment variable, never on the
// command line. Experimental: exercised against stand-in CLIs in the tests, not against the real services.
function commandStore(name, cfg, spec) {
  only(cfg, name, ['type', 'command', 'token_file', 'timeout_ms']);
  const command = cfg.command ?? spec.command;
  if (typeof command !== 'string' || (!path.isAbsolute(command) && !/^[A-Za-z0-9._-]+$/.test(command))) throw new Error(`secret store "${name}": command must be a program name or an absolute path`);
  const tokenFile = cfg.token_file ? absolute(name, 'token_file', cfg.token_file) : null;
  const timeoutMs = cfg.timeout_ms ?? 10000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error(`secret store "${name}": timeout_ms must be 100-60000`);
  const what = `${spec.type} store ${name}`;
  return {
    type: spec.type, name, writable: false,
    async read(p, field) {
      const args = spec.args(checkPath(p), checkField(field));
      const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || '/nonexistent' };
      if (tokenFile) {
        try { env[spec.tokenEnv] = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (e) { fail('UNAVAILABLE', `${what}: its token file cannot be read (${e.code || 'error'})`); }
      }
      const out = await new Promise((resolve, reject) => {
        execFile(command, args, { env, timeout: timeoutMs, maxBuffer: 256 * 1024, encoding: 'buffer', windowsHide: true }, (err, stdout) => {
          // The CLI's stderr and stdout stay here: either may quote what was asked for.
          if (err) { stdout?.fill?.(0); return reject(new StoreError(err.code === 'ENOENT' ? 'UNAVAILABLE' : err.killed ? 'UNAVAILABLE' : 'NOT_FOUND', err.code === 'ENOENT' ? `${what}: ${command} is not installed` : err.killed ? `${what}: ${command} timed out` : `${what}: ${command} found no such entry (exit ${err.code})`)); }
          resolve(stdout);
        });
      });
      return spec.parse(out, field, what);
    },
    async write() { fail('UNSUPPORTED', `${what} is read-only`); },
    close() {},
  };
}
const onePassword = {
  type: '1password', command: 'op', tokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN',
  // path: <vault>/<item>[/<section>], field: the field (default password).
  args: (p, field) => ['read', '--no-newline', `op://${p}/${field ?? 'password'}`],
  parse: (out) => secretBytes(out, { trimNewline: true }),
};
const bitwarden = {
  type: 'bitwarden', command: 'bws', tokenEnv: 'BWS_ACCESS_TOKEN',
  // path: the secret's id; the answer is JSON with the value under "value" (or another field asked for).
  args: (p) => ['secret', 'get', p, '--output', 'json'],
  parse: (out, field, what) => {
    let doc;
    try { doc = JSON.parse(out.toString('utf8')); } catch { doc = null; } finally { out.fill(0); }
    const v = doc?.[field ?? 'value'];
    if (typeof v !== 'string') fail('NOT_FOUND', `${what}: no such field`);
    return secretBytes(Buffer.from(v, 'utf8'));
  },
};

export const STORE_TYPES = ['file', 'env', 'openbao', 'vault', '1password', 'bitwarden'];

// name, its configuration object -> adapter. Throws (plain Error) on a configuration mistake.
export function createStore(name, cfg, { env = {}, isLoopbackHost = () => false } = {}) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`secret store "${name}" must be an object`);
  switch (cfg.type) {
    case 'file': return fileStore(name, cfg);
    case 'env': return envStore(name, cfg, { env });
    case 'openbao': case 'vault': return openbaoStore(name, cfg, { isLoopbackHost });
    case '1password': return commandStore(name, cfg, onePassword);
    case 'bitwarden': return commandStore(name, cfg, bitwarden);
    default: throw new Error(`secret store "${name}": type must be one of ${STORE_TYPES.join(', ')}`);
  }
}
