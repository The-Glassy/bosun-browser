// Move a stopped service's state between the shared volume and worker volumes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { TENANT_RE } from './auth.mjs';

const BACKUPS = '.bosun-backups';
const LOCK = '.bosun-migrate';
const COMMAND = 'bosun migrate-data';
const TENANT_PATHS = {
  profiles: 'directory', macros: 'directory', recordings: 'directory', shots: 'directory',
  downloads: 'directory', uploads: 'directory', 'speech-settings': 'json', 'secret-settings': 'json',
};
const KEEPALIVE = 'keepalive.json';
const USAGE = 'live-transcript-usage.json';
const STORES = [KEEPALIVE, USAGE];

function stat(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false });
}

function expect(file, info, kind) {
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`Expected a regular ${kind} at ${file}`);
  }
}

function children(dir) {
  const info = stat(dir);
  if (!info) return [];
  expect(dir, info, 'directory');
  return fs.readdirSync(dir).sort();
}

function readStore(file, name, owner) {
  const info = stat(file);
  if (!info) return null;
  expect(file, info, 'file');
  const invalid = () => new Error(`Invalid tenant state in ${file}`);
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw invalid(); throw error; }
  const records = new Map();
  const add = (tenant, key, data) => {
    if (!TENANT_RE.test(tenant) || (owner && tenant !== owner) || records.has(key)) throw invalid();
    records.set(key, { tenant, data });
  };
  if (name === KEEPALIVE) {
    if (value?.version !== 1 || !Array.isArray(value.entries)) throw invalid();
    for (const entry of value.entries) {
      if (typeof entry?.tenant !== 'string' || typeof entry.profile !== 'string' || !TENANT_RE.test(entry.profile)) throw invalid();
      add(entry.tenant, `${entry.tenant}/${entry.profile}`, entry);
    }
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value?.day) || !value.tenants || typeof value.tenants !== 'object' || Array.isArray(value.tenants)) throw invalid();
    for (const [tenant, seconds] of Object.entries(value.tenants)) {
      if (!Number.isFinite(seconds) || seconds < 0) throw invalid();
      add(tenant, tenant, seconds);
    }
  }
  return { day: value.day, records };
}

const tenantRoot = (root, tenant) => path.join(root, 'tenants', tenant);

function collect(root, sandboxed) {
  const files = [], stores = [];
  const roots = sandboxed ? children(path.join(root, 'tenants')).filter((name) => TENANT_RE.test(name)) : [null];
  for (const owner of roots) {
    const base = owner ? tenantRoot(root, owner) : root;
    children(base); // Reject a symlink in place of a tenant root.
    for (const [category, kind] of Object.entries(TENANT_PATHS)) {
      for (const name of children(path.join(base, category))) {
        const tenant = kind === 'json' && name.endsWith('.json') ? name.slice(0, -5) : name;
        if (!TENANT_RE.test(tenant) || (kind === 'json' && name === tenant)) continue;
        const relative = path.join(category, name), source = path.join(base, relative);
        if (owner && tenant !== owner) throw new Error(`Unexpected tenant data at ${source}`);
        expect(source, stat(source), kind === 'json' ? 'file' : kind);
        files.push({ tenant, relative, source });
      }
    }
    for (const name of STORES) {
      const source = path.join(base, name);
      const store = readStore(source, name, owner);
      if (store?.records.size) stores.push({ name, source, ...store });
    }
  }
  return { files, stores };
}

function checkParents(root, target) {
  let dir = path.dirname(target);
  while (dir !== root) {
    const info = stat(dir);
    if (info) expect(dir, info, 'directory');
    dir = path.dirname(dir);
  }
}

function migrationPlan(root, reverse, force) {
  const { files, stores } = collect(root, reverse);
  const targetRoot = (tenant) => reverse ? root : tenantRoot(root, tenant);
  const conflict = (target) => { throw new Error(`Migration conflict at ${target}; inspect the data or rerun with --force`); };
  const moves = files.map(({ tenant, relative, source }) => {
    const target = path.join(targetRoot(tenant), relative);
    checkParents(root, target);
    const info = stat(target);
    if (info) {
      expect(target, info, relative.endsWith('.json') ? 'file' : 'directory');
      if (!force) conflict(target);
    }
    return { source, target };
  });
  const writes = new Map();
  for (const { name, day, records } of stores) {
    for (const [key, record] of records) {
      const target = path.join(targetRoot(record.tenant), name);
      if (!writes.has(target)) {
        checkParents(root, target);
        const existing = readStore(target, name, reverse ? null : record.tenant);
        writes.set(target, { name, day: existing?.records.size ? existing.day : day, records: existing?.records ?? new Map() });
      }
      const dest = writes.get(target);
      if (day !== dest.day) {
        if (!force) conflict(`${target} (different transcript quota dates)`);
        if (day < dest.day) continue;
        dest.day = day;
        dest.records.clear();
      }
      const old = dest.records.get(key);
      if (old && !isDeepStrictEqual(old.data, record.data) && !force) conflict(`${target} (${key})`);
      dest.records.set(key, record);
    }
  }
  return { moves, writes, remove: stores.map(({ source }) => source) };
}

function backup(root, log) {
  const dir = path.join(root, BACKUPS);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  expect(dir, stat(dir), 'directory');
  const archiveDir = fs.mkdtempSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}-`));
  const archive = path.join(archiveDir, 'bosun-data.tar.gz');
  try {
    const fd = fs.openSync(archive, 'wx', 0o600);
    try {
      const env = { ...process.env };
      delete env.TAR_OPTIONS;
      const result = spawnSync('tar', ['-C', root, `--exclude=./${BACKUPS}`, `--exclude=./${LOCK}`, '-czf', '-', '.'],
        { env, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' });
      if (result.error || result.status !== 0) throw new Error(`Backup failed: ${result.error?.message || result.stderr || result.signal}`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    fs.rmSync(archiveDir, { recursive: true, force: true });
    throw error;
  }
  log(`Backup: ${archive}`);
  return archive;
}

function applyPlan(plan, lock) {
  const undo = [];
  const rename = (source, target) => {
    fs.renameSync(source, target);
    undo.push(() => fs.renameSync(target, source));
  };
  let sequence = 0;
  const hold = (file) => { if (stat(file)) rename(file, path.join(lock, String(sequence++))); };
  try {
    for (const { source, target } of plan.moves) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      hold(target);
      rename(source, target);
    }
    for (const [target, { name, day, records }] of plan.writes) {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const data = name === KEEPALIVE
        ? { version: 1, entries: [...records.values()].map(({ data }) => data) }
        : { day, tenants: Object.fromEntries([...records].map(([tenant, { data }]) => [tenant, data])) };
      const temp = path.join(lock, String(sequence++));
      fs.writeFileSync(temp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
      hold(target);
      rename(temp, target);
    }
    for (const source of plan.remove) hold(source);
  } catch (error) {
    const errors = [];
    for (const restore of undo.reverse()) {
      try { restore(); } catch (failure) { errors.push(failure); }
    }
    if (errors.length) throw new AggregateError([error, ...errors], 'Migration could not roll back; restore the printed backup into an empty data directory');
    throw error;
  }
}

export function migrateData({ dataDir = process.env.BROWSER_DATA || './data', dryRun = false, reverse = false, force = false, log = console.log } = {}) {
  if (!stat(dataDir)) { log('No data to migrate.'); return; }
  const root = fs.realpathSync(dataDir);
  expect(root, stat(root), 'directory');
  const lock = path.join(root, LOCK);
  if (!dryRun) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Migration lock exists at ${lock}; check for an interrupted or running migration`);
      throw error;
    }
  }
  let cleanup = !dryRun;
  try {
    const plan = migrationPlan(root, reverse, force);
    if (!plan.moves.length && !plan.remove.length) { log('No data to migrate.'); return; }
    const archive = dryRun ? null : backup(root, log);
    for (const { source, target } of plan.moves) log(`Move ${source} -> ${target}`);
    for (const source of plan.remove) log(`Repartition ${source}`);
    for (const target of plan.writes.keys()) log(`Write ${target}`);
    if (dryRun) return;
    try { applyPlan(plan, lock); }
    catch (error) {
      if (error instanceof AggregateError) cleanup = false;
      throw error;
    }
    return archive;
  } finally {
    if (cleanup) fs.rmSync(lock, { recursive: true, force: true });
  }
}

export function prepareSandboxData(dataDir, autoMigrate) {
  if (!stat(dataDir)) return;
  const root = fs.realpathSync(dataDir);
  if (stat(path.join(root, LOCK))) throw new Error(`BROWSER_DATA has a migration lock; finish or recover ${COMMAND} before starting`);
  const { files, stores } = collect(root, false);
  if (!files.length && !stores.length) return;
  if (!autoMigrate) throw new Error(`Legacy BROWSER_DATA layout at ${root}; stop the service and run ${COMMAND} on BROWSER_DATA before enabling the tenant sandbox`);
  migrateData({ dataDir: root, log: (line) => console.error(`bosun: ${line}`) });
}
