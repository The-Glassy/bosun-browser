// Macros: a multi-step site flow an agent saves once (macro_save) and reruns with one call (macro_run). A macro is a
// per-tenant, named, versioned JSON document: the hosts it may run on (site), its parameters, and steps in the
// vocabulary of the page tools (navigate, click, type, select, press, wait_for, upload, download_wait, read,
// screenshot) plus assert. Strings in steps take {{param}}. No element refs (they change with every read), no
// script, no code: a step is run by the same handler as the tool of that name, with that tool's deadline.
// Stored under <BROWSER_DATA>/macros/<tenant>/<name>.json (every kept version in one file, written atomically).
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { allowsUrl, parseHostPattern, showPattern } from './allow.mjs';
import { TENANT_RE } from './auth.mjs';

export const MACRO_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,60}$/; // a file_id or secret_id passed as an argument
export const PARAM_TYPES = ['string', 'number', 'file_id', 'secret_id'];
export const MAX_STEPS = 100;
export const MAX_PARAMS = 30;
export const MAX_SITES = 20;
export const MAX_MACROS = 200; // per tenant
export const VERSIONS_KEPT = 20; // older versions of a macro are dropped
export const MAX_DOC_BYTES = 256 * 1024;
export const RUN_DEFAULT_SEC = 300;
export const RUN_MAX_SEC = 900;
export const STEP_TOOLS = ['navigate', 'click', 'type', 'select', 'press', 'wait_for', 'upload', 'download_wait', 'read', 'screenshot', 'assert'];
const ASSERT_WAIT_MS = 5000; // default wait of an assert step

// What a step may not do without confirm_risky at save time: pay, buy, order, check out, delete an account.
// Matched against every string of a step (and, when it runs, against the text of the element a click hits).
export const RISKY_RE = /\b(pay(?:\s+now)?|buy(?:\s+now)?|purchase|submit\s+(?:the\s+|my\s+|your\s+)?order|place\s+(?:the\s+|my\s+|your\s+)?order|check[\s-]?out|delete\s+(?:my\s+|your\s+|the\s+)?account|jetzt\s+kaufen|kaufen|bezahlen|zahlungspflichtig|kostenpflichtig\s+bestellen|konto\s+l(?:ö|oe)schen)\b/i;
export const riskyIn = (text) => RISKY_RE.exec(String(text ?? ''))?.[0] ?? null;

const s = (n) => z.string().max(n);
const target = { role: s(40).optional(), name: s(1000).optional(), selector: s(2000).optional(), text: s(1000).optional() };
const common = { optional: z.boolean().optional().describe('a failure of this step is noted and the run goes on'), note: s(300).optional() };
const ms = (max) => z.number().int().min(0).max(max).optional();
const STEP_SCHEMAS = {
  navigate: { url: s(4096), wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional() },
  click: { ...target },
  type: { ...target, value: s(10000).optional(), secret_id: s(60).optional(), allow_non_password: z.boolean().optional(), submit: z.boolean().optional() },
  select: { ...target, value: s(1000) },
  press: { key: s(50) },
  wait_for: { text: s(1000).optional(), selector: s(2000).optional(), timeoutMs: z.number().int().min(1).max(60000).optional() },
  upload: { ...target, file_id: s(60).optional(), files: z.array(s(60)).min(1).max(20).optional(), method: z.enum(['auto', 'input', 'chooser', 'drop']).optional() },
  download_wait: { timeoutMs: ms(120000) },
  read: { mode: z.enum(['a11y', 'text']).optional(), selector: s(2000).optional(), maxChars: z.number().int().min(1).max(200000).optional(), as: s(40).optional() },
  screenshot: { ...target, fullPage: z.boolean().optional() },
  assert: { text: s(1000).optional(), selector: s(2000).optional(), url_contains: s(1000).optional(), timeoutMs: ms(60000) },
};
const stepSchema = Object.fromEntries(Object.entries(STEP_SCHEMAS).map(([t, shape]) => [t, z.object({ tool: z.literal(t), ...shape, ...common }).strict()]));
// Fields that hold an id from upload_create / secret_create: only ever a {{param}} of that type, never stored.
const ID_FIELDS = { secret_id: 'secret_id', file_id: 'file_id', files: 'file_id' };
const hasTarget = (x) => !!(x.role || x.selector || x.text);

const TEMPLATE_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;
const placeholders = (str) => [...String(str).matchAll(TEMPLATE_RE)].map((m) => m[1]);
const WHOLE_RE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

const fail = (msg) => { throw new Error(msg); };
const firstIssue = (e) => {
  const i = e.issues?.[0];
  if (!i) return String(e.message || e);
  const where = i.path?.length ? `${i.path.join('.')}: ` : '';
  return `${where}${i.code === 'unrecognized_keys' ? `unknown field(s) ${i.keys.join(', ')}` : i.message}`;
};

// One step as given -> the step to store. Throws with the step's number (1-based) and what is wrong.
function checkStep(raw, i, params) {
  const at = `step ${i + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`${at}: must be an object with "tool"`);
  if (!STEP_TOOLS.includes(raw.tool)) fail(`${at}: tool must be one of ${STEP_TOOLS.join(', ')} (got ${JSON.stringify(raw.tool)?.slice(0, 40)})`);
  const head = `${at} (${raw.tool})`;
  if ('ref' in raw) fail(`${head}: ref is not allowed in a macro (refs change with every read); use role+name, selector or text`);
  if ('session' in raw) fail(`${head}: no session in a step; macro_run is given the session`);
  const r = stepSchema[raw.tool].safeParse(raw);
  if (!r.success) fail(`${head}: ${firstIssue(r.error)}`);
  const st = r.data;
  const needsTarget = ['click', 'type', 'select', 'upload'];
  if (st.name !== undefined && !st.role) fail(`${head}: name goes with role`);
  if (needsTarget.includes(st.tool) && !hasTarget(st)) fail(`${head}: give the element: role (+name), selector or text`);
  if (st.tool === 'type' && (st.value === undefined) === (st.secret_id === undefined)) fail(`${head}: give value or secret_id (not both)`);
  if (st.tool === 'upload' && (st.file_id === undefined) === (st.files === undefined)) fail(`${head}: give file_id or files (not both)`);
  if (st.tool === 'wait_for' && !st.text && !st.selector) fail(`${head}: give text or selector`);
  if (st.tool === 'assert' && st.text === undefined && st.selector === undefined && st.url_contains === undefined) fail(`${head}: give text, selector and/or url_contains`);
  // Placeholders: declared, and of the type the field takes.
  for (const [k, v] of Object.entries(st)) {
    if (k === 'tool' || k === 'note') continue;
    for (const one of Array.isArray(v) ? v : [v]) {
      if (typeof one !== 'string') continue;
      const idType = ID_FIELDS[k];
      if (idType) {
        const m = WHOLE_RE.exec(one);
        if (!m) fail(`${head}: ${k} must be a {{param}} of type ${idType} (an id from ${idType === 'secret_id' ? 'secret_create' : 'upload_create'} is used once, so it is passed to macro_run, never stored)`);
        if (params[m[1]]?.type !== idType) fail(`${head}: ${k} {{${m[1]}}} must name a param of type ${idType}`);
        continue;
      }
      for (const p of placeholders(one)) {
        if (!PARAM_RE.test(p) || !params[p]) fail(`${head}: ${k} uses {{${p}}}, which is not a declared param`);
        if (params[p].type !== 'string' && params[p].type !== 'number') fail(`${head}: ${k} uses {{${p}}} of type ${params[p].type}; a ${params[p].type} goes only into ${params[p].type === 'secret_id' ? 'type secret_id' : 'upload file_id/files'}`);
      }
    }
  }
  return st;
}

// The strings of a step that say what it does (not its note or ids).
const stepText = (st) => Object.entries(st).filter(([k, v]) => typeof v === 'string' && k !== 'tool' && k !== 'note' && !ID_FIELDS[k]).map(([, v]) => v).join(' • ');

// Input of macro_save -> the version to store (without version/created_*). Throws on anything malformed or unsafe.
export function checkMacro(input) {
  const name = String(input.name ?? '');
  if (!MACRO_NAME_RE.test(name)) fail(`name must match ${MACRO_NAME_RE} (lowercase letters, digits, . _ -; up to 64)`);
  const description = String(input.description ?? '');
  if (description.length > 2000) fail('description is longer than 2000 characters');
  const sites = Array.isArray(input.site) ? input.site : fail('site must be a list of hosts the macro may run on, e.g. ["web.plaud.ai", "*.plaud.ai"]');
  if (!sites.length || sites.length > MAX_SITES) fail(`site needs 1 to ${MAX_SITES} hosts`);
  const site = sites.map((h) => {
    let p;
    try { p = parseHostPattern(h); } catch (e) { fail(`site: ${e.message}`); }
    if (p.any) fail('site: "*" is not allowed; name the hosts the macro runs on');
    return showPattern(p);
  });
  const params = {};
  const given = input.params ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) fail('params must be an object: {name: {type, required}}');
  if (Object.keys(given).length > MAX_PARAMS) fail(`at most ${MAX_PARAMS} params`);
  for (const [k, v] of Object.entries(given)) {
    if (!PARAM_RE.test(k)) fail(`param name "${k.slice(0, 40)}" must match ${PARAM_RE}`);
    const r = z.object({ type: z.enum(PARAM_TYPES), required: z.boolean().optional(), description: s(300).optional(), default: z.union([s(10000), z.number()]).optional() }).strict().safeParse(v);
    if (!r.success) fail(`param ${k}: ${firstIssue(r.error)}`);
    const p = r.data;
    if (p.default !== undefined) {
      if (p.type === 'file_id' || p.type === 'secret_id') fail(`param ${k}: a ${p.type} has no default (it is used once)`);
      if (typeof p.default !== (p.type === 'number' ? 'number' : 'string')) fail(`param ${k}: default must be a ${p.type}`);
    }
    params[k] = { type: p.type, required: p.required ?? p.default === undefined, ...(p.description ? { description: p.description } : {}), ...(p.default !== undefined ? { default: p.default } : {}) };
  }
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > MAX_STEPS) fail(`steps must be a list of 1 to ${MAX_STEPS} steps`);
  const steps = input.steps.map((st, i) => checkStep(st, i, params));
  const risky = [];
  steps.forEach((st, i) => { const m = riskyIn(stepText(st)); if (m) risky.push({ step: i + 1, tool: st.tool, matched: m }); });
  if (risky.length && input.confirm_risky !== true) {
    fail(`refused: ${risky.map((r) => `step ${r.step} (${r.tool}) matches "${r.matched}"`).join('; ')}. A macro that may pay, buy, order, check out or delete an account is saved only with confirm_risky: true`);
  }
  const doc = { name, description, site, params, steps, confirm_risky: input.confirm_risky === true, risky_steps: risky };
  if (Buffer.byteLength(JSON.stringify(doc)) > MAX_DOC_BYTES) fail(`the macro is larger than ${MAX_DOC_BYTES / 1024} KB`);
  return doc;
}

// BROWSER_MACRO_SOURCE='swarm=me' -> Map read-only tenant -> the tenant whose macros it lists, gets and runs.
export function parseMacroSource(env, tokens, policies) {
  const out = new Map();
  const tenants = new Set(tokens.map((t) => t.tenant));
  for (const part of String(env.BROWSER_MACRO_SOURCE || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1) fail('BROWSER_MACRO_SOURCE entries must look like <read-only tenant>=<tenant whose macros it runs>');
    const reader = part.slice(0, i).trim(), source = part.slice(i + 1).trim();
    for (const t of [reader, source]) {
      if (!TENANT_RE.test(t)) fail(`BROWSER_MACRO_SOURCE: tenant name "${t}" must match ${TENANT_RE}`);
      if (!tenants.has(t) && t !== 'default') fail(`BROWSER_MACRO_SOURCE names tenant "${t}", which has no token`);
    }
    if (out.has(reader)) fail(`BROWSER_MACRO_SOURCE names tenant "${reader}" twice`);
    if (reader === source) fail(`BROWSER_MACRO_SOURCE: tenant "${reader}" reads its own macros already`);
    // A full tenant saves macros of its own; reading someone else's would leave it unclear where a save goes.
    if (policies.get(reader) !== 'ephemeral') fail(`BROWSER_MACRO_SOURCE names tenant "${reader}", whose policy is full: only a read-only (ephemeral) tenant runs another tenant's macros`);
    out.set(reader, source);
  }
  return out;
}

// One view of a stored version for macro_list.
const summary = (v) => ({
  name: v.name, version: v.version, description: v.description, site: v.site,
  params: Object.fromEntries(Object.entries(v.params).map(([k, p]) => [k, `${p.type}${p.required ? '' : '?'}`])),
  steps: v.steps.length, confirm_risky: v.confirm_risky, ...(v.risky_steps.length ? { risky_steps: v.risky_steps } : {}),
  created_by: v.created_by, created_at: v.created_at,
});

export class Macros {
  constructor(cfg) {
    this.dir = path.join(cfg.dataDir, 'macros');
    this.sources = cfg.macroSource ?? new Map();
  }

  // The tenant whose macros this one reads (itself, unless BROWSER_MACRO_SOURCE names another).
  source(tenant) { return this.sources.get(tenant) ?? tenant; }
  file(tenant, name) { return path.join(this.dir, tenant, `${name}.json`); }

  load(tenant, name) {
    if (!MACRO_NAME_RE.test(String(name))) fail(`no macro ${String(name).slice(0, 64)}`);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(this.file(tenant, name), 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`macro ${name} cannot be read (${e.code || 'invalid JSON'})`);
    }
    return Array.isArray(doc?.versions) && doc.versions.length ? doc : null;
  }

  write(tenant, name, doc) {
    const f = this.file(tenant, name);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, f);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`cannot save macro ${name}: ${e.code || e.message}`);
    }
  }

  names(tenant) {
    try { return fs.readdirSync(path.join(this.dir, tenant)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((n) => MACRO_NAME_RE.test(n)).sort(); } catch { return []; }
  }

  // A new macro, or a new version of one (older versions beyond VERSIONS_KEPT are dropped).
  save(tenant, input, { createdBy, now = new Date() } = {}) {
    const v = checkMacro(input);
    const old = this.load(tenant, v.name);
    if (!old && this.names(tenant).length >= MAX_MACROS) fail(`this tenant has ${MAX_MACROS} macros already; delete one first`);
    const version = old ? old.versions[old.versions.length - 1].version + 1 : 1;
    const doc = { name: v.name, versions: [...(old?.versions ?? []), { ...v, version, created_by: createdBy, created_at: now.toISOString() }].slice(-VERSIONS_KEPT) };
    this.write(tenant, v.name, doc);
    return doc.versions[doc.versions.length - 1];
  }

  list(tenant) {
    const t = this.source(tenant);
    return this.names(t).map((n) => { try { const d = this.load(t, n); return d && summary(d.versions[d.versions.length - 1]); } catch { return null; } }).filter(Boolean);
  }

  get(tenant, name, version) {
    const d = this.load(this.source(tenant), name);
    if (!d) fail(`no macro ${name}`);
    if (version === undefined) return { ...d.versions[d.versions.length - 1], versions: d.versions.map((x) => x.version) };
    const v = d.versions.find((x) => x.version === version);
    if (!v) fail(`macro ${name} has no version ${version} (kept: ${d.versions.map((x) => x.version).join(', ')})`);
    return { ...v, versions: d.versions.map((x) => x.version) };
  }

  delete(tenant, name) {
    if (!this.load(tenant, name)) fail(`no macro ${name}`);
    fs.rmSync(this.file(tenant, name), { force: true });
    return { deleted: name };
  }
}

// args of macro_run -> {name: value} for every param that has one. Throws on unknown, missing or mistyped args.
export function checkArgs(m, args = {}) {
  if (typeof args !== 'object' || Array.isArray(args) || args === null) fail('args must be an object');
  for (const k of Object.keys(args)) if (!Object.hasOwn(m.params, k)) fail(`macro ${m.name} has no param ${k.slice(0, 40)} (params: ${Object.keys(m.params).join(', ') || 'none'})`);
  const out = {};
  for (const [k, p] of Object.entries(m.params)) {
    const v = args[k] ?? p.default;
    if (v === undefined) { if (p.required) fail(`param ${k} (${p.type}) is required`); continue; }
    if (p.type === 'number' ? typeof v !== 'number' || !Number.isFinite(v) : typeof v !== 'string') fail(`param ${k} must be a ${p.type === 'number' ? 'number' : 'string'}`);
    if ((p.type === 'file_id' || p.type === 'secret_id') && !ID_RE.test(v)) fail(`param ${k} is not a ${p.type}`);
    if (typeof v === 'string' && v.length > 10000) fail(`param ${k} is longer than 10000 characters`);
    out[k] = v;
  }
  return out;
}

// A stored step with {{param}} filled in, or {missing} when it names a param that was not given (the step is then
// skipped: an optional param switches the steps that use it off).
export function resolveStep(st, values) {
  const missing = new Set();
  const fill = (str) => String(str).replace(TEMPLATE_RE, (_, p) => { if (!Object.hasOwn(values, p)) { missing.add(p); return ''; } return String(values[p]); });
  const out = {};
  for (const [k, v] of Object.entries(st)) out[k] = typeof v === 'string' && k !== 'note' ? fill(v) : Array.isArray(v) ? v.map(fill) : v;
  return missing.size ? { missing: [...missing] } : { step: out };
}

const isBlank = (u) => !u || u === 'about:blank';
// Is url within the macro's site? about:blank counts as no page at all (a new session, a navigation that became a
// download); anything else outside site, error pages included, is off-site.
export const onSite = (patterns, url) => isBlank(url) || allowsUrl(patterns, url);
const hostOf = (u) => { try { return new URL(u).host || u.slice(0, 60); } catch { return String(u).slice(0, 60); } };

// Runs macro m (a stored version) step by step. ops is the page side, given by tools.mjs:
//   allowed(tool) -> null | why not;  step(tool, args, limitMs, signal) -> MCP result of that tool;
//   limitOf(tool) -> ms | null;  assert(cond, limitMs);  element(target, limitMs) -> {label, kind} of the element;
//   url() -> current URL;  watch(isOff) -> {seen() -> first off-site URL navigated to, stop()};
//   failure(why) -> {url, title, a11y, screenshot} (best effort);  progress(done, total, message).
// Returns { result (JSON-able), images: [{step, data}] }.
export async function runMacro(m, { args, dryRun = false, maxMs = RUN_DEFAULT_SEC * 1000, signal, ops }) {
  const values = checkArgs(m, args);
  const patterns = m.site.map(parseHostPattern);
  const off = (u) => !onSite(patterns, u);
  const resolved = m.steps.map((st) => resolveStep(st, values));
  const res = { macro: m.name, version: m.version, ok: true, steps: [] };
  // Refusals that hold whatever the page shows: a tool this token may not use, a navigate off the site, risky text
  // that the args brought in.
  for (const [i, r] of resolved.entries()) {
    if (!r.step) continue;
    const st = r.step;
    const why = ops.allowed(st.tool);
    if (why) fail(`step ${i + 1} (${st.tool}): ${why}`);
    if (st.tool === 'navigate' && off(st.url)) fail(`step ${i + 1} (navigate): ${hostOf(st.url)} is not in this macro's site (${m.site.join(', ')})`);
    const risky = riskyIn(stepText(st));
    if (risky && !m.confirm_risky) fail(`step ${i + 1} (${st.tool}): refused, "${risky}" (the args make it a step that may pay, buy, order, check out or delete an account; the macro was not saved with confirm_risky)`);
  }
  if (dryRun) {
    return { result: { ...res, dry_run: true, steps: resolved.map((r, i) => (r.step ? { step: i + 1, ...r.step } : { step: i + 1, tool: m.steps[i].tool, skip: `param ${r.missing.join(', ')} not given` })) }, images: [] };
  }
  // downloads: every one a step reported. pending: those a click or navigate reported (click waits up to 5 s for
  // one to finish, and then download_wait would not see it again) that no download_wait step has taken yet.
  const images = [], reads = [], downloads = [], pending = [];
  const end = Date.now() + maxMs;
  const total = m.steps.length;
  let failure = null;
  for (let i = 0; i < total; i++) {
    const r = resolved[i], tool = m.steps[i].tool, n = i + 1;
    const t0 = Date.now();
    const rec = { step: n, tool };
    res.steps.push(rec);
    if (!r.step) { Object.assign(rec, { status: 'skipped', reason: `param ${r.missing.join(', ')} not given` }); continue; }
    const st = r.step;
    if (signal?.aborted) { failure = { step: n, tool, error: 'the run was cancelled (the MCP request was cancelled or timed out on the client)', fatal: true, noPage: true }; break; }
    const left = end - Date.now();
    if (left < 1000) { failure = { step: n, tool, error: `the run's time ran out (timeout_sec ${Math.round(maxMs / 1000)})`, fatal: true }; break; }
    let w = null;
    try {
      const here = ops.url();
      if (st.tool !== 'navigate' && off(here)) throw Object.assign(new Error(`the page is at ${hostOf(here)}, outside this macro's site (${m.site.join(', ')})`), { fatal: true });
      w = ops.watch(off);
      const out = await runStep(st, { ops, left, signal, confirmRisky: m.confirm_risky, pending });
      Object.assign(rec, out.rec);
      if (out.read !== undefined) reads.push({ step: n, ...(st.as ? { as: st.as } : {}), text: out.read });
      if (out.downloads) {
        downloads.push(...out.downloads.map((d) => ({ step: n, ...d })));
        if (st.tool !== 'download_wait') pending.push(...out.downloads.filter((d) => d.state !== 'downloading'));
      }
      if (out.image) images.push({ step: n, data: out.image });
    } catch (e) {
      rec.error = String(e?.message || e).slice(0, 1000);
      if (e?.fatal || !st.optional) failure = { step: n, tool, error: rec.error, fatal: !!e?.fatal, noPage: !!e?.noPage };
    } finally {
      const seen = w?.seen();
      w?.stop();
      // Navigation elsewhere aborts the run, also when the step failed or was optional.
      let now = null;
      try { now = ops.url(); } catch {}
      const away = seen ?? (now && off(now) ? now : null);
      if (away && !(failure && failure.step === n)) failure = { step: n, tool, error: `the page went to ${hostOf(away)}, outside this macro's site (${m.site.join(', ')}); the run stopped`, fatal: true };
      else if (away && failure) failure.error += `; the page went to ${hostOf(away)}, outside this macro's site`;
      rec.ms = Date.now() - t0;
    }
    if (failure) { rec.status = 'failed'; break; }
    rec.status = rec.error ? 'failed_optional' : 'ok';
    await ops.progress?.(n, total, `${n}/${total} ${tool} ${rec.status}`); // sent before the answer, in order
  }
  for (let i = res.steps.length; i < total; i++) res.steps.push({ step: i + 1, tool: m.steps[i].tool, status: 'not_run' });
  if (reads.length) res.reads = reads;
  if (downloads.length) res.downloads = downloads;
  if (failure) {
    res.ok = false;
    const { noPage, fatal, ...f } = failure;
    res.failure = { ...f, ...(noPage ? {} : await ops.failure().catch(() => ({}))) };
    if (res.failure.screenshot) { images.push({ step: failure.step, data: res.failure.screenshot, failure: true }); res.failure.screenshot = 'attached (image after this text)'; }
    res.next = 'fix the step (macro_get, then macro_save a new version) or the page state, and run again';
  }
  return { result: res, images };
}

const json = (r) => { const t = r?.content?.find((c) => c.type === 'text')?.text; try { return JSON.parse(t); } catch { return t ?? null; } };

// One step; returns { rec (what to report), read?, downloads?, image? } or throws.
async function runStep(st, { ops, left, signal, confirmRisky, pending }) {
  const { tool, optional, note, as, ...a } = st;
  const limit = (name) => Math.min(ops.limitOf(name) ?? left, left);
  if (tool === 'assert') {
    await ops.assert(a, Math.min(left, (a.timeoutMs ?? ASSERT_WAIT_MS) + 15_000));
    return { rec: {} };
  }
  if (tool === 'click' && !confirmRisky) {
    // What the element says, not only how the step finds it: a selector can point at a "Buy now" button.
    const el = await ops.element(a, Math.min(left, 20_000)).catch(() => null);
    const risky = riskyIn(el?.label);
    if (risky) throw Object.assign(new Error(`refused: the element says "${risky}" (a macro that may pay, buy, order, check out or delete an account needs confirm_risky at save time)`), { fatal: true });
  }
  if (tool === 'type' && a.value !== undefined) {
    // A password goes into a macro only by secret_id: never stored in it, nor passed through the agent as an arg.
    const el = await ops.element(a, Math.min(left, 20_000)).catch(() => null);
    if (el?.kind === 'password') throw Object.assign(new Error('refused: this is a password field; in a macro it takes only secret_id: "{{param}}" (a param of type secret_id)'), { fatal: true });
  }
  if (tool === 'download_wait') {
    const took = pending.shift() ?? null; // already in the run's downloads
    const r = took ?? json(await ops.step(tool, { timeoutMs: Math.min(a.timeoutMs ?? 30000, Math.max(0, left - 1000)) }, null, signal));
    if (r?.state !== 'ready') throw new Error(r?.state === 'none' || !r?.state ? 'no download finished in time' : `download ${r.state}${r.reason ? `: ${r.reason}` : ''}`);
    return { rec: { download_id: r.download_id, filename: r.filename }, ...(took ? {} : { downloads: [r] }) };
  }
  const r = await ops.step(tool, a, limit(tool), signal);
  if (tool === 'screenshot') return { rec: {}, image: r.content.find((c) => c.type === 'image')?.data };
  if (tool === 'read') {
    // "url: …\ntitle: …\nchars: N[ (truncated to M)]\n\n<text>": the step reports the head, reads get the text.
    const all = r.content.find((c) => c.type === 'text')?.text ?? '';
    const cut = all.indexOf('\n\n');
    const chars = /^chars: (\d+)( \(truncated)?/m.exec(all.slice(0, cut));
    return { rec: { chars: Number(chars?.[1] ?? 0), ...(chars?.[2] ? { truncated: true } : {}) }, read: cut < 0 ? '' : all.slice(cut + 2) };
  }
  const info = json(r) ?? {};
  if (info.refused) throw new Error(`refused by the host allowlist of this token (${info.url ? hostOf(info.url) : 'the page'})`);
  if (info.blocked) throw new Error(`blocked: ${info.blocked} (call request_human for a person to solve it, then run the macro again)`);
  if (tool === 'upload' && info.method === 'drop' && info.accepted === false) throw new Error(`nothing on the page took the files (${info.note})`);
  const rec = {};
  if (info.status !== undefined) rec.http_status = info.status;
  if (tool === 'upload') Object.assign(rec, { method: info.method, files: info.files?.map((f) => f.filename) });
  const dl = (info.downloads ?? []).filter((d) => d.state);
  return { rec, ...(dl.length ? { downloads: dl } : {}) };
}
