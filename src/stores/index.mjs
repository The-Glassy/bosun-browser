// Secret stores, recipes and save targets (BOSUN_SECRET_STORES): credentials that live in a store and reach a page
// without passing through the model. The operator defines everything here; an agent can only name a recipe
// (secret_fill) or a save target (secret_save store_target). Off unless configured.
//
// Trust: this module runs in the gateway (tenant sandbox on) or in the single process (sandbox off). A sandboxed
// worker holds no store configuration and no store token; it asks the gateway over its own Unix socket
// (broker.mjs), which answers for that worker's tenant only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createStore, checkField, checkPath, FIELD_RE, StoreError, STORE_VALUE_MAX_BYTES } from './adapters.mjs';

export { StoreError, STORE_VALUE_MAX_BYTES };
export const RECIPE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const FIELD_TYPES = ['password', 'text', 'email', 'tel', 'number', 'url', 'search', 'textarea', 'any'];
const AUDIT_MAX_BYTES = 10 * 1024 * 1024;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (what, obj, keys) => {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new Error(`${what}: unknown key "${k}" (known: ${keys.join(', ')})`);
};

// An origin a recipe binds to: https (http on loopback only, for local development and tests), no path.
function origin(what, raw, isLoopbackHost) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`${what} must be an origin such as https://app.example.org`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) throw new Error(`${what} must be https:// (http only on loopback)`);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error(`${what} is scheme, host and port only (no path, query or credentials)`);
  return u.origin;
}
// Where a form may send the value: an origin, optionally with a path prefix.
function destination(what, raw, isLoopbackHost) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`${what} must be a URL such as https://app.example.org/session`); }
  if (u.username || u.password || u.search || u.hash) throw new Error(`${what} has no query, fragment or credentials`);
  return { origin: origin(what, u.origin, isLoopbackHost), path: u.pathname || '/' };
}
const storePath = (what, raw, { prefix = false } = {}) => {
  if (typeof raw !== 'string') throw new Error(`${what} must be a string`);
  // {tenant} is filled in per tenant, so one installation-level entry cannot make tenants share a path by accident.
  const probe = raw.replaceAll('{tenant}', 'tenant');
  try { checkPath(prefix ? probe.replace(/\/$/, '') : probe); } catch { throw new Error(`${what} is not a valid store path`); }
  if (prefix && !raw.endsWith('/')) throw new Error(`${what} must end with / (a directory the keys go under)`);
  return raw;
};

function parseRecipe(what, r, stores, isLoopbackHost) {
  if (!isObject(r)) throw new Error(`${what} must be an object`);
  only(what, r, ['description', 'store', 'path', 'field', 'origin', 'path_prefix', 'selector', 'field_type', 'submit', 'submit_to']);
  if (r.store !== 'client' && !stores.has(r.store)) throw new Error(`${what}: store "${r.store}" is not defined (or "client" for a value the agent's side sends with secret_create)`);
  const out = { description: null, store: r.store, path: null, field: null, origin: origin(`${what}: origin`, r.origin, isLoopbackHost), pathPrefix: '/', selector: null, fieldType: 'password', submit: false, submitTo: null };
  if (r.description !== undefined) { if (typeof r.description !== 'string' || r.description.length > 300) throw new Error(`${what}: description is a string of at most 300 characters`); out.description = r.description; }
  if (r.store === 'client') { if (r.path !== undefined || r.field !== undefined) throw new Error(`${what}: a "client" recipe has no path or field (the value comes with secret_create)`); }
  else {
    out.path = storePath(`${what}: path`, r.path);
    if (r.field !== undefined) { if (typeof r.field !== 'string' || !FIELD_RE.test(r.field)) throw new Error(`${what}: field is not valid`); out.field = r.field; }
  }
  if (r.path_prefix !== undefined) { if (typeof r.path_prefix !== 'string' || !r.path_prefix.startsWith('/') || r.path_prefix.length > 500) throw new Error(`${what}: path_prefix must start with /`); out.pathPrefix = r.path_prefix; }
  if (typeof r.selector !== 'string' || !r.selector.trim() || r.selector.length > 2000) throw new Error(`${what}: selector is required (a CSS selector that matches exactly one field)`);
  out.selector = r.selector;
  if (r.field_type !== undefined) { if (!FIELD_TYPES.includes(r.field_type)) throw new Error(`${what}: field_type must be one of ${FIELD_TYPES.join(', ')}`); out.fieldType = r.field_type; }
  if (r.submit !== undefined) { if (typeof r.submit !== 'boolean') throw new Error(`${what}: submit must be true or false`); out.submit = r.submit; }
  const to = r.submit_to ?? [out.origin];
  if (!Array.isArray(to) || !to.length || to.length > 10) throw new Error(`${what}: submit_to is a list of 1-10 URLs`);
  out.submitTo = to.map((d, i) => destination(`${what}: submit_to[${i}]`, d, isLoopbackHost));
  return out;
}

function parseTarget(what, t, stores, isLoopbackHost) {
  if (!isObject(t)) throw new Error(`${what} must be an object`);
  only(what, t, ['description', 'store', 'path_prefix', 'field', 'origins', 'overwrite']);
  const store = stores.get(t.store);
  if (!store) throw new Error(`${what}: store "${t.store}" is not defined`);
  if (!store.writable) throw new Error(`${what}: store "${t.store}" (${store.type}) is read-only`);
  const out = { description: null, store: t.store, pathPrefix: storePath(`${what}: path_prefix`, t.path_prefix, { prefix: true }), field: null, origins: null, overwrite: false };
  if (t.description !== undefined) { if (typeof t.description !== 'string' || t.description.length > 300) throw new Error(`${what}: description is a string of at most 300 characters`); out.description = t.description; }
  if (t.field !== undefined) { if (typeof t.field !== 'string' || !FIELD_RE.test(t.field)) throw new Error(`${what}: field is not valid`); out.field = t.field; }
  // The pages a value may be taken from. "*" is every page, and has to be written out.
  if (!Array.isArray(t.origins) || !t.origins.length || t.origins.length > 50) throw new Error(`${what}: origins is required: the origins a value may be saved from, or ["*"] for any page`);
  out.origins = t.origins.includes('*') ? ['*'] : t.origins.map((o, i) => origin(`${what}: origins[${i}]`, o, isLoopbackHost));
  if (t.overwrite !== undefined) { if (typeof t.overwrite !== 'boolean') throw new Error(`${what}: overwrite must be true or false`); out.overwrite = t.overwrite; }
  return out;
}

// BOSUN_SECRET_STORES: a JSON object, or the absolute path of a file that holds one. -> null (not configured) or
// { stores: Map name -> adapter, recipes: Map tenant -> Map name -> recipe, targets: Map tenant -> Map name ->
// target, envKeys }. tenants: the tenant names that exist (tokens, or "default").
export function parseSecretStores(env, tenants, { isLoopbackHost, readOnly = new Set() }) {
  const raw = env.BOSUN_SECRET_STORES;
  if (raw === undefined || raw === '') return null;
  let doc;
  try {
    doc = JSON.parse(raw.trimStart().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8'));
  } catch (e) {
    // Neither the JSON nor the parser's message (which can quote it) is repeated.
    throw new Error(`BOSUN_SECRET_STORES must be a JSON object or the path of a JSON file (${e.code || 'invalid JSON'})`);
  }
  if (!isObject(doc)) throw new Error('BOSUN_SECRET_STORES must be a JSON object');
  only('BOSUN_SECRET_STORES', doc, ['stores', 'recipes', 'save_targets', 'tenants']);
  const stores = new Map();
  const envKeys = [];
  for (const [name, cfg] of Object.entries(doc.stores ?? {})) {
    if (!RECIPE_NAME_RE.test(name) || name === 'client') throw new Error(`secret store name "${name}" must be lowercase letters, digits, . _ - (and not "client")`);
    const store = createStore(name, cfg, { env, isLoopbackHost });
    if (store.envKeys) envKeys.push(...store.envKeys);
    stores.set(name, store);
  }
  const section = (what, obj, parse, allowNull) => {
    const out = new Map();
    if (obj === undefined) return out;
    if (!isObject(obj)) throw new Error(`${what} must be an object`);
    for (const [name, v] of Object.entries(obj)) {
      if (!RECIPE_NAME_RE.test(name)) throw new Error(`${what}: name "${name}" must be lowercase letters, digits, . _ -`);
      out.set(name, v === null && allowNull ? null : parse(`${what}.${name}`, v, stores, isLoopbackHost));
    }
    return out;
  };
  const baseRecipes = section('recipes', doc.recipes, parseRecipe, false);
  const baseTargets = section('save_targets', doc.save_targets, parseTarget, false);
  const perTenant = new Map();
  if (doc.tenants !== undefined && !isObject(doc.tenants)) throw new Error('tenants must be an object');
  for (const [tenant, t] of Object.entries(doc.tenants ?? {})) {
    if (!tenants.has(tenant)) throw new Error(`BOSUN_SECRET_STORES names tenant "${tenant}", which has no token`);
    if (readOnly.has(tenant)) throw new Error(`BOSUN_SECRET_STORES names tenant "${tenant}", whose policy is ephemeral (read-only tokens cannot use secrets)`);
    if (!isObject(t)) throw new Error(`tenants.${tenant} must be an object`);
    only(`tenants.${tenant}`, t, ['recipes', 'save_targets']);
    perTenant.set(tenant, {
      recipes: section(`tenants.${tenant}.recipes`, t.recipes, parseRecipe, true),
      targets: section(`tenants.${tenant}.save_targets`, t.save_targets, parseTarget, true),
    });
  }
  // Installation entries apply to every tenant; a tenant's own entry of the same name replaces it, null removes it.
  const merged = (base, own, pathKey) => {
    const out = new Map();
    for (const tenant of tenants) {
      const m = new Map();
      if (readOnly.has(tenant)) { out.set(tenant, m); continue; }
      for (const [name, v] of base) m.set(name, v);
      for (const [name, v] of own(tenant) ?? []) { if (v === null) m.delete(name); else m.set(name, v); }
      for (const [name, v] of m) m.set(name, v[pathKey] ? { ...v, [pathKey]: v[pathKey].replaceAll('{tenant}', tenant) } : v);
      out.set(tenant, m);
    }
    return out;
  };
  return {
    stores, envKeys,
    recipes: merged(baseRecipes, (t) => perTenant.get(t)?.recipes, 'path'),
    targets: merged(baseTargets, (t) => perTenant.get(t)?.targets, 'pathPrefix'),
  };
}

// What an agent may know about a recipe or target: the binding, never the store path or field.
const publicRecipe = (name, r) => ({ name, ...(r.description ? { description: r.description } : {}), source: r.store === 'client' ? 'client' : 'store',
  origin: r.origin, ...(r.pathPrefix !== '/' ? { path_prefix: r.pathPrefix } : {}), selector: r.selector, field_type: r.fieldType, submit: r.submit,
  submit_to: r.submitTo.map((d) => `${d.origin}${d.path === '/' ? '' : d.path}`) });
const publicTarget = (name, t) => ({ name, ...(t.description ? { description: t.description } : {}), origins: t.origins, overwrite: t.overwrite });

// Append-only JSON lines, one per store operation, without any value: who (tenant), what (action, recipe or target,
// store, path, field), where (the page's origin, the session) and how it ended (status, code). 0600 in a 0700
// directory; at AUDIT_MAX_BYTES the file is renamed to .1 (one generation kept).
export class SecretAudit {
  constructor(dataDir, { log = (...a) => console.error(...a) } = {}) {
    this.dir = path.join(dataDir, 'audit');
    this.file = path.join(this.dir, 'secrets.jsonl');
    this.log = log;
  }
  write(event) {
    const clean = {};
    for (const [k, v] of Object.entries(event)) {
      if (v === undefined || v === null) continue;
      clean[k] = typeof v === 'string' ? v.slice(0, 300) : typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 300);
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...clean });
    this.log(`bosun: secret-audit ${line}`);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      try { if (fs.statSync(this.file).size > AUDIT_MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`); } catch {}
      fs.appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
    } catch (e) {
      this.log(`bosun: WARNING — the secret audit log cannot be written (${e.code || 'error'})`);
    }
  }
}

const AUDIT_FIELDS = ['action', 'recipe', 'target', 'key', 'session', 'origin', 'status', 'code'];

export class SecretStores {
  constructor(parsed, { audit }) {
    this.stores = parsed.stores;
    this.recipes = parsed.recipes;
    this.targets = parsed.targets;
    this.audit = audit;
  }

  // The interface the tools use (and broker.mjs serves to a sandboxed worker), bound to one tenant.
  forTenant(tenant) {
    const recipes = this.recipes.get(tenant) ?? new Map();
    const targets = this.targets.get(tenant) ?? new Map();
    const event = (e) => this.audit.write({ tenant, ...e });
    const recipe = (name) => {
      const r = typeof name === 'string' ? recipes.get(name) : null;
      // The same answer for a name that never existed and one that belongs to another tenant.
      if (!r) throw new StoreError('NOT_FOUND', `no recipe ${String(name).slice(0, 64)} for this token (secret_recipes lists them)`);
      return r;
    };
    return {
      enabled: recipes.size > 0 || targets.size > 0,
      list: () => ({ recipes: [...recipes].map(([n, r]) => publicRecipe(n, r)), save_targets: [...targets].map(([n, t]) => publicTarget(n, t)) }),
      binding: (name) => publicRecipe(name, recipe(name)),
      // The value of a recipe, as a Buffer the caller wipes. where: { session, origin } for the audit line.
      resolve: async (name, where = {}) => {
        const r = recipe(name);
        if (r.store === 'client') throw new StoreError('INVALID', `recipe ${name} takes its value from secret_create (pass secret_id)`);
        const base = { action: 'resolve', recipe: name, store: r.store, path: r.path, field: r.field, session: where.session, origin: where.origin };
        try {
          const value = await this.stores.get(r.store).read(r.path, r.field);
          event({ ...base, status: 'ok' });
          return value;
        } catch (e) {
          event({ ...base, status: 'error', code: e instanceof StoreError ? e.code : 'UNAVAILABLE' });
          throw e instanceof StoreError ? e : new StoreError('UNAVAILABLE', 'the secret store failed');
        }
      },
      // Writes value (a Buffer; wiped here) to <target path_prefix><key>. where: { session, origin }.
      save: async (targetName, key, value, { overwrite = false, session, origin: from } = {}) => {
        const t = typeof targetName === 'string' ? targets.get(targetName) : null;
        const base = { action: 'save', target: String(targetName).slice(0, 64), key: String(key).slice(0, 64), session, origin: from };
        try {
          if (!t) throw new StoreError('NOT_FOUND', `no save target ${String(targetName).slice(0, 64)} for this token (secret_recipes lists them)`);
          if (typeof key !== 'string' || !KEY_RE.test(key)) throw new StoreError('INVALID', 'store_key is 1-64 letters, digits, . _ - (it starts with a letter or digit)');
          if (!t.origins.includes('*') && !t.origins.includes(from)) throw new StoreError('FORBIDDEN', `save target ${targetName} does not take values from this page (its origins: ${t.origins.join(', ')})`);
          if (overwrite && !t.overwrite) throw new StoreError('FORBIDDEN', `save target ${targetName} does not allow overwrite`);
          if (!value.length || value.length > STORE_VALUE_MAX_BYTES) throw new StoreError('TOO_LARGE', `a stored secret is 1-${STORE_VALUE_MAX_BYTES} bytes`);
          const p = `${t.pathPrefix}${key}`;
          checkPath(p); checkField(t.field);
          const r = await this.stores.get(t.store).write(p, t.field, value, { overwrite });
          event({ ...base, store: t.store, path: p, field: t.field, status: 'ok' });
          return { store_target: targetName, key, ...(r?.version !== undefined ? { version: r.version } : {}) };
        } catch (e) {
          event({ ...base, store: t?.store, status: 'error', code: e instanceof StoreError ? e.code : 'UNAVAILABLE' });
          throw e instanceof StoreError ? e : new StoreError('UNAVAILABLE', 'the secret store failed');
        } finally { value.fill(0); }
      },
      // What the browser side did with a value (fill, refused, …): only these fields, and never a value.
      note: (e) => { const out = {}; for (const k of AUDIT_FIELDS) if (e?.[k] !== undefined) out[k] = e[k]; event(out); },
    };
  }

  close() { for (const s of this.stores.values()) s.close?.(); }
}

// Values that came from (or went to) a store, per tenant and session, kept only in memory until the session closes:
// every text a tool returns to that tenant is scrubbed of them (also URL-, base64- and hex-encoded), secret_reveal
// and secret_save to a download refuse them, screenshots cover them, and a handoff starts with them taken out of
// the page. This is what makes "the value never reaches the model" hold after the fill, whatever the page does
// with it (echoes it, puts it into its URL, mirrors it into another field).
export class SecretGuard {
  constructor() { this.bySession = new Map(); } // session id -> { tenant, values: Set<string>, forms: Set<string> }
  add(tenant, session, value) {
    if (typeof value !== 'string' || value.length < 3) return;
    let x = this.bySession.get(session);
    if (!x) this.bySession.set(session, x = { tenant, values: new Set(), forms: new Set() });
    x.values.add(value);
    const b = Buffer.from(value, 'utf8');
    for (const f of [value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2), JSON.stringify(value).slice(1, -1),
      b.toString('base64'), b.toString('base64').replace(/=+$/, ''), b.toString('base64url'), b.toString('hex')]) if (f.length >= 3) x.forms.add(f);
  }
  drop(session) { this.bySession.delete(session); }
  values(session) { return [...(this.bySession.get(session)?.values ?? [])]; }
  holds(tenant, text) {
    for (const x of this.bySession.values()) if (x.tenant === tenant) for (const v of x.values) if (String(text).includes(v)) return true;
    return false;
  }
  scrub(tenant, text) {
    if (!this.bySession.size || typeof text !== 'string') return text;
    let out = text;
    for (const x of this.bySession.values()) {
      if (x.tenant !== tenant) continue;
      for (const f of [...x.forms].sort((a, b) => b.length - a.length)) if (out.includes(f)) out = out.split(f).join('[masked]');
    }
    return out;
  }
  close() { this.bySession.clear(); }
}

export const sha256Prefix = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 8);
