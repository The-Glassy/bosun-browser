import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { migrateData, prepareSandboxData } from '../src/migrate-data.mjs';
import { tmpDir } from './helpers.mjs';

const tenantFiles = {
  alice: {
    'profiles/alice/work/bosun-profile.json': '{"egress":"office","keep_session_cookies":true}',
    'profiles/alice/work/session-cookies.json': '[{"name":"sid","value":"fixture"}]',
    'profiles/alice/work/Default/Cookies': 'browser cookie database',
    'macros/alice/check.json': '{"version":1}',
    'speech-settings/alice.json': '{"alone_leave_sec":45}',
    'secret-settings/alice.json': '{"secrets_reveal":true}',
    'recordings/alice/m123.ogg': 'audio',
    'recordings/alice/m123.webm': 'video',
    'recordings/alice/m123.speakers.json': '[]',
    'downloads/alice/d123/file.txt': 'download',
    'uploads/alice/u123/file.txt': 'upload',
    'shots/alice/session/shot.png': 'screenshot',
  },
  bob: {
    'profiles/bob/work/bosun-profile.json': '{"egress":"default"}',
    'macros/bob/check.json': '{"version":2}',
  },
};

const keepalive = {
  version: 1,
  entries: [
    { tenant: 'alice', profile: 'work', url: 'https://example.test/dashboard',
      watch: { kind: 'count', selector: '#inbox' }, watchState: { value: 4, at: 123 }, history: [{ status: 'ok' }] },
    { tenant: 'bob', profile: 'work', url: 'https://example.test/inbox' },
  ],
};
const usage = { day: '2026-10-21', tenants: { alice: 32.5, bob: 12 } };

function fixture(t) {
  const data = tmpDir();
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const location = (file) => path.join(data, file);
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(location(file)), { recursive: true });
    fs.writeFileSync(location(file), typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  };
  const read = (file) => fs.readFileSync(location(file), 'utf8');
  const json = (file) => JSON.parse(read(file));
  const exists = (file) => fs.existsSync(location(file));
  for (const files of Object.values(tenantFiles)) for (const [file, value] of Object.entries(files)) put(file, value);
  put('keepalive.json', keepalive);
  put('live-transcript-usage.json', usage);
  put('tmp/browser/unclaimed.txt', 'ephemeral');
  put('unrelated.txt', 'local data');
  return { data, location, put, read, json, exists };
}

function cli(data, ...options) {
  return spawnSync(process.execPath, ['bin/bosun.mjs', 'migrate-data', '--data', data, ...options], { encoding: 'utf8' });
}

test('migration CLI previews all tenants without changing the tree or creating an archive', (t) => {
  const f = fixture(t);
  const run = cli(f.data, '--dry-run');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Move .*profiles\/alice.* -> .*tenants\/alice\/profiles\/alice/);
  assert.match(run.stdout, /Repartition .*keepalive\.json/);
  assert.match(run.stdout, /Write .*tenants\/bob\/live-transcript-usage\.json/);
  assert.equal(f.exists('tenants'), false);
  assert.equal(f.exists('.bosun-backups'), false);
  assert.equal(f.exists('.bosun-migrate'), false);
  assert.deepEqual(f.json('keepalive.json'), keepalive);
});

test('forward migration backs up state, preserves tenant files and repartitions both stores; retry is a no-op', (t) => {
  const f = fixture(t);
  const run = cli(f.data);
  assert.equal(run.status, 0, run.stderr);
  const archive = run.stdout.match(/^Backup: (.+)\n/)?.[1];
  assert.ok(archive);
  assert.equal(fs.statSync(archive).mode & 0o777, 0o600);
  const archived = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.match(archived, /\.\/profiles\/alice\/work\/session-cookies\.json/);
  assert.match(archived, /\.\/keepalive\.json/);
  assert.doesNotMatch(archived, /\.bosun-(backups|migrate)/);
  for (const [tenant, files] of Object.entries(tenantFiles)) {
    for (const [file, value] of Object.entries(files)) {
      assert.equal(f.exists(file), false, file);
      assert.equal(f.read(`tenants/${tenant}/${file}`), value, file);
    }
    assert.deepEqual(f.json(`tenants/${tenant}/keepalive.json`),
      { version: 1, entries: keepalive.entries.filter((entry) => entry.tenant === tenant) });
    assert.deepEqual(f.json(`tenants/${tenant}/live-transcript-usage.json`), { day: usage.day, tenants: { [tenant]: usage.tenants[tenant] } });
  }
  assert.equal(f.exists('keepalive.json'), false);
  assert.equal(f.exists('live-transcript-usage.json'), false);
  assert.equal(f.exists('tmp/browser/unclaimed.txt'), true);
  assert.equal(f.exists('unrelated.txt'), true);
  const retry = cli(f.data);
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /^No data to migrate\./);
  assert.equal(fs.readdirSync(f.location('.bosun-backups')).length, 1);
});

test('conflicts refuse all writes unless forced; the forced backup contains both layouts', (t) => {
  const f = fixture(t);
  const target = 'tenants/bob/macros/bob/check.json';
  f.put(target, 'existing destination');
  for (const options of [['--dry-run'], []]) {
    const run = cli(f.data, ...options);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Migration conflict.*--force/);
    assert.equal(f.read(target), 'existing destination');
    assert.equal(f.exists('profiles/alice/work'), true);
    assert.equal(f.exists('.bosun-backups'), false);
  }
  const archive = migrateData({ dataDir: f.data, force: true, log: () => {} });
  assert.equal(f.read(target), tenantFiles.bob['macros/bob/check.json']);
  assert.equal(execFileSync('tar', ['-xOzf', archive, `./${target}`], { encoding: 'utf8' }), 'existing destination');
});

test('reverse migration restores 0.27 paths, combines both stores and backs up updated data', (t) => {
  const f = fixture(t);
  const silent = { dataDir: f.data, log: () => {} };
  migrateData(silent);
  const alice = { ...keepalive.entries[0], watchState: { value: 8, at: 456 } };
  f.put('tenants/alice/keepalive.json', { version: 1, entries: [alice] });
  const preview = cli(f.data, '--reverse', '--dry-run');
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(f.exists('profiles/alice'), false);
  const archive = migrateData({ ...silent, reverse: true });
  assert.ok(archive);
  assert.deepEqual(f.json('keepalive.json'), { version: 1, entries: [alice, keepalive.entries[1]] });
  assert.deepEqual(f.json('live-transcript-usage.json'), usage);
  for (const [tenant, files] of Object.entries(tenantFiles)) for (const [file, value] of Object.entries(files)) {
    assert.equal(f.read(file), value, file);
    assert.equal(f.exists(`tenants/${tenant}/${file}`), false, file);
  }
  assert.equal(migrateData({ ...silent, reverse: true }), undefined);
  assert.equal(fs.readdirSync(f.location('.bosun-backups')).length, 2);
});

test('sandbox startup requires explicit migration, and auto migration takes the same backup', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.location('tenants/alice'), { recursive: true });
  assert.throws(() => prepareSandboxData(f.data, false), /Legacy BROWSER_DATA layout.*bosun migrate-data/);
  assert.equal(f.exists('.bosun-backups'), false);
  const log = t.mock.method(console, 'error', () => {});
  prepareSandboxData(f.data, true);
  assert.ok(log.mock.calls.some(({ arguments: [line] }) => line.includes('Backup:')));
  assert.deepEqual(f.json('tenants/alice/keepalive.json').entries, [keepalive.entries[0]]);
  assert.doesNotThrow(() => prepareSandboxData(f.data, false));
});

test('migration refuses a symlinked destination before changing data', (t) => {
  const f = fixture(t);
  const outside = tmpDir();
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(f.location('tenants'));
  fs.symlinkSync(outside, f.location('tenants/alice'), 'dir');
  assert.throws(() => migrateData({ dataDir: f.data }), /Expected a regular directory/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(f.exists('profiles/alice'), true);
});
