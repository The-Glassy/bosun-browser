// Secret store adapters, recipes/targets configuration, the audit log, the guard and the sandbox broker: no browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isLoopbackHost } from '../src/auth.mjs';
import { loadConfig } from '../src/config.mjs';
import { createStore, envName, StoreError } from '../src/stores/adapters.mjs';
import { parseSecretStores, SecretAudit, SecretGuard, SecretStores } from '../src/stores/index.mjs';
import { connectSecretBroker, startSecretBroker } from '../src/stores/broker.mjs';
import { startFakeOpenBao } from './fakeopenbao.mjs';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-stores-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const code = (c) => (e) => e instanceof StoreError && e.code === c;
const CANARY = 'canary-Value-9f3b1c7e';
const tokenFile = (dir, name, token) => { const f = path.join(dir, name); fs.writeFileSync(f, `${token}\n`, { mode: 0o600 }); return f; };

test('file store: raw files and JSON fields, 0600 writes, create-only unless overwrite, no escape from its directory', async (t) => {
  const dir = tmp(t);
  const outside = tmp(t);
  fs.writeFileSync(path.join(outside, 'host-secret'), 'outside');
  const s = createStore('files', { type: 'file', dir });
  fs.mkdirSync(path.join(dir, 'acme'));
  fs.writeFileSync(path.join(dir, 'acme', 'github'), `${CANARY}\n`);
  fs.writeFileSync(path.join(dir, 'acme', 'login.json'), JSON.stringify({ username: 'bot', password: CANARY, n: 5 }));
  assert.equal((await s.read('acme/github')).toString(), CANARY, 'one trailing newline is not part of the secret');
  assert.equal((await s.read('acme/login.json', 'password')).toString(), CANARY);
  await assert.rejects(s.read('acme/login.json', 'n'), code('NOT_FOUND'), 'only string fields');
  await assert.rejects(s.read('acme/login.json', 'toString'), code('NOT_FOUND'), 'no inherited members');
  await assert.rejects(s.read('acme/missing'), code('NOT_FOUND'));
  await assert.rejects(s.read('acme'), code('NOT_FOUND'), 'a directory is not an entry');
  for (const bad of ['../x', '/etc/passwd', 'a//b', 'a/../b', '.hidden', 'a b', '']) await assert.rejects(s.read(bad), code('INVALID'), bad);
  fs.symlinkSync(path.join(outside, 'host-secret'), path.join(dir, 'acme', 'link'));
  await assert.rejects(s.read('acme/link'), code('FORBIDDEN'), 'a link out of the store is refused');
  fs.symlinkSync(outside, path.join(dir, 'out'));
  await assert.rejects(s.write('out/new', null, Buffer.from('x')), code('FORBIDDEN'), 'also for writes');
  assert.deepEqual(fs.readdirSync(outside), ['host-secret']);

  await s.write('acme/generated/pat', null, Buffer.from(CANARY));
  const file = path.join(dir, 'acme', 'generated', 'pat');
  assert.equal(fs.readFileSync(file, 'utf8'), CANARY);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  await assert.rejects(s.write('acme/generated/pat', null, Buffer.from('other')), code('EXISTS'));
  assert.equal(fs.readFileSync(file, 'utf8'), CANARY, 'a refused write changes nothing');
  await s.write('acme/generated/pat', null, Buffer.from('rotated'), { overwrite: true });
  assert.equal((await s.read('acme/generated/pat')).toString(), 'rotated');
  await s.write('acme/doc.json', 'token', Buffer.from('t1'));
  await s.write('acme/doc.json', 'other', Buffer.from('t2'));
  await assert.rejects(s.write('acme/doc.json', 'token', Buffer.from('t3')), code('EXISTS'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'acme', 'doc.json'), 'utf8')), { token: 't1', other: 't2' }, 'other fields are kept');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'acme')).filter((n) => n.endsWith('.tmp')), [], 'no temporary file is left');

  fs.writeFileSync(path.join(dir, 'big'), 'x'.repeat(5000));
  await assert.rejects(s.read('big'), code('TOO_LARGE'));
  fs.writeFileSync(path.join(dir, 'empty'), '\n');
  await assert.rejects(s.read('empty'), code('NOT_FOUND'));
  fs.writeFileSync(path.join(dir, 'binary'), Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(s.read('binary'), code('INVALID'));
  const ro = createStore('ro', { type: 'file', dir, read_only: true });
  await assert.rejects(ro.write('x', null, Buffer.from('x')), code('UNSUPPORTED'));
  assert.throws(() => createStore('rel', { type: 'file', dir: 'relative' }), /absolute path/);
  assert.throws(() => createStore('typo', { type: 'file', dir, mode: 1 }), /unknown key "mode"/);
});

test('env store: values are taken at start, by prefix; read-only', async () => {
  const env = { BOSUN_SECRET_ACME_GITHUB: CANARY, BOSUN_SECRET_ACME_LOGIN_PASSWORD: 'pw', OTHER: 'no', BOSUN_SECRET_EMPTY: '' };
  const s = createStore('env', { type: 'env' }, { env });
  assert.equal(envName('BOSUN_SECRET_', 'acme/github', null), 'BOSUN_SECRET_ACME_GITHUB');
  assert.deepEqual(s.envKeys.sort(), ['BOSUN_SECRET_ACME_GITHUB', 'BOSUN_SECRET_ACME_LOGIN_PASSWORD']);
  delete env.BOSUN_SECRET_ACME_GITHUB; // what main() does to process.env
  assert.equal((await s.read('acme/github')).toString(), CANARY);
  assert.equal((await s.read('acme/login', 'password')).toString(), 'pw');
  await assert.rejects(s.read('acme/none'), code('NOT_FOUND'));
  await assert.rejects(s.read('empty'), code('NOT_FOUND'));
  await assert.rejects(s.write('acme/x', null, Buffer.from('x')), code('UNSUPPORTED'));
  assert.equal(s.writable, false);
  assert.throws(() => createStore('env', { type: 'env', prefix: 'lower_' }), /prefix/);
});

test('openbao store (KV v2): read, field, create-only and overwrite under check-and-set, errors without values', async (t) => {
  const dir = tmp(t);
  const bao = await startFakeOpenBao();
  t.after(() => bao.close());
  bao.token('root-token-0001');
  bao.token('acme-token-0001', { read: /^tenants\/acme\//, write: /^tenants\/acme\/generated\// });
  bao.put('tenants/acme/github', { password: CANARY, username: 'bot', count: 3 });
  bao.put('tenants/other/github', { password: 'other-tenant' });
  const s = createStore('bao', { type: 'openbao', address: bao.address, token_file: tokenFile(dir, 't', 'acme-token-0001'), namespace: 'team/a' }, { isLoopbackHost });
  assert.equal((await s.read('tenants/acme/github', 'password')).toString(), CANARY);
  assert.deepEqual(bao.requests.at(-1), { method: 'GET', url: '/v1/secret/data/tenants/acme/github', token: 'acme-token-0001', namespace: 'team/a', body: '' });
  await assert.rejects(s.read('tenants/acme/github'), code('NOT_FOUND'), 'the default field is "value"');
  await assert.rejects(s.read('tenants/acme/github', 'count'), code('NOT_FOUND'), 'only string fields');
  await assert.rejects(s.read('tenants/acme/none', 'password'), code('NOT_FOUND'));
  await assert.rejects(s.read('tenants/other/github', 'password'), code('FORBIDDEN'), "the store's own policy holds");
  await assert.rejects(s.read('../sys/health', 'x'), code('INVALID'), 'a path cannot leave the mount');

  assert.deepEqual(await s.write('tenants/acme/generated/pat', null, Buffer.from(CANARY)), { version: 1 });
  assert.deepEqual(bao.entries.get('tenants/acme/generated/pat'), { data: { value: CANARY }, version: 1 });
  assert.deepEqual(JSON.parse(bao.requests.at(-1).body).options, { cas: 0 }, 'a new entry is create-only');
  await assert.rejects(s.write('tenants/acme/generated/pat', null, Buffer.from('second')), code('EXISTS'));
  assert.deepEqual(await s.write('tenants/acme/generated/pat', null, Buffer.from('second'), { overwrite: true }), { version: 2 });
  assert.deepEqual(JSON.parse(bao.requests.at(-1).body).options, { cas: 1 }, 'an overwrite is bound to the version it read');
  await s.write('tenants/acme/generated/pat', 'note', Buffer.from('n'));
  assert.deepEqual(bao.entries.get('tenants/acme/generated/pat').data, { value: 'second', note: 'n' }, 'other fields are kept');
  await assert.rejects(s.write('tenants/acme/github', 'new', Buffer.from('x')), code('FORBIDDEN'));

  // A writer that got in between the read and the write is noticed, not overwritten.
  const racing = createStore('bao', { type: 'openbao', address: bao.address, token_file: tokenFile(dir, 't2', 'root-token-0001') }, { isLoopbackHost });
  const orig = bao.entries.get.bind(bao.entries);
  let raced = false;
  bao.entries.get = (p) => { const e = orig(p); if (p === 'race' && !raced && bao.requests.at(-1).method === 'GET') { raced = true; queueMicrotask(() => bao.put('race', { value: 'theirs' })); } return e; };
  await assert.rejects(racing.write('race', null, Buffer.from('mine')), code('EXISTS'));
  bao.entries.get = orig;
  assert.equal(bao.entries.get('race').data.value, 'theirs');

  for (const [state, expect] of [['down', /answered HTTP 503/], ['redirect', /redirected the request/]]) {
    bao[state] = true;
    await assert.rejects(s.read('tenants/acme/github', 'password'), (e) => code('UNAVAILABLE')(e) && expect.test(e.message) && !e.message.includes(CANARY));
    bao[state] = false;
  }
  await bao.close();
  await assert.rejects(s.read('tenants/acme/github', 'password'), (e) => code('UNAVAILABLE')(e) && /cannot be reached/.test(e.message));
});

test('openbao store: a wrapping token is unwrapped once and never reused; KV v1; configuration checks', async (t) => {
  const dir = tmp(t);
  const bao = await startFakeOpenBao({ kv: 1 });
  t.after(() => bao.close());
  bao.token('real-token-0001');
  bao.wrap('wrap-token-0001', 'real-token-0001');
  bao.put('acme/login', { password: CANARY });
  const cfg = { type: 'openbao', address: bao.address, kv_version: 1, wrapping_token_file: tokenFile(dir, 'w', 'wrap-token-0001') };
  const s = createStore('bao', cfg, { isLoopbackHost });
  assert.equal(bao.requests.length, 0, 'nothing is sent before the first use');
  assert.equal((await s.read('acme/login', 'password')).toString(), CANARY);
  assert.equal((await s.read('acme/login', 'password')).toString(), CANARY);
  assert.deepEqual(bao.requests.map((r) => [r.url, r.token]), [['/v1/sys/wrapping/unwrap', 'wrap-token-0001'], ['/v1/secret/acme/login', 'real-token-0001'], ['/v1/secret/acme/login', 'real-token-0001']]);
  await s.write('acme/new', null, Buffer.from('v'));
  assert.deepEqual(bao.entries.get('acme/new').data, { value: 'v' });
  // A second process with the same (spent) wrapping token gets nothing: that is how a stolen file is noticed.
  const again = createStore('bao', cfg, { isLoopbackHost });
  await assert.rejects(again.read('acme/login', 'password'), (e) => code('FORBIDDEN')(e) && /single-use/.test(e.message));

  // wrapping_creation_path: looked up first, and a token wrapped elsewhere is left unused.
  bao.wrap('wrap-token-0002', 'real-token-0001', 'cubbyhole/planted');
  const planted = createStore('bao', { ...cfg, wrapping_token_file: tokenFile(dir, 'w2', 'wrap-token-0002'), wrapping_creation_path: 'auth/token/create' }, { isLoopbackHost });
  await assert.rejects(planted.read('acme/login', 'password'), (e) => code('FORBIDDEN')(e) && /not created at wrapping_creation_path/.test(e.message));
  assert.ok(!bao.requests.some((r) => r.url === '/v1/sys/wrapping/unwrap' && r.token === 'wrap-token-0002'), 'not unwrapped');
  bao.wrap('wrap-token-0003', 'real-token-0001');
  const checked = createStore('bao', { ...cfg, wrapping_token_file: tokenFile(dir, 'w3', 'wrap-token-0003'), wrapping_creation_path: 'auth/token/create' }, { isLoopbackHost });
  assert.equal((await checked.read('acme/login', 'password')).toString(), CANARY);
  assert.throws(() => createStore('b', { type: 'openbao', address: bao.address, token_file: '/x/t', wrapping_creation_path: 'auth/token/create' }, { isLoopbackHost }), /goes with wrapping_token_file/);

  const base = { type: 'openbao', token_file: '/x/t' };
  assert.throws(() => createStore('b', { ...base, address: 'http://bao.example:8200' }, { isLoopbackHost }), /must be https/);
  assert.throws(() => createStore('b', { ...base, address: 'https://user:pw@bao.example' }, { isLoopbackHost }), /scheme, host and port only/);
  assert.throws(() => createStore('b', { ...base, address: 'https://bao.example/v1' }, { isLoopbackHost }), /scheme, host and port only/);
  assert.throws(() => createStore('b', { type: 'openbao', address: 'https://bao.example' }, { isLoopbackHost }), /token_file or wrapping_token_file/);
  assert.throws(() => createStore('b', { ...base, address: 'https://bao.example', token: 'inline' }, { isLoopbackHost }), /unknown key "token"/);
  assert.throws(() => createStore('b', { ...base, address: 'https://bao.example', kv_version: 3 }, { isLoopbackHost }), /kv_version/);
  const missing = createStore('b', { ...base, address: bao.address }, { isLoopbackHost });
  await assert.rejects(missing.read('acme/login', 'password'), (e) => code('UNAVAILABLE')(e) && /token file cannot be read/.test(e.message));
});

test('1password and bitwarden stores call their CLI with the token in the environment only (stand-in CLIs)', async (t) => {
  const dir = tmp(t);
  const log = path.join(dir, 'calls');
  const cli = (name, script) => { const f = path.join(dir, name); fs.writeFileSync(f, `#!/bin/sh\n${script}\n`, { mode: 0o700 }); return f; };
  const op = cli('op', `echo "args=$* token=$OP_SERVICE_ACCOUNT_TOKEN extra=$CANARY_ENV" >> ${log}
case "$3" in op://Agents/github/password) printf '%s' '${CANARY}';; op://Agents/github/otp) printf '123456\\n';; *) echo "no item $3 ${CANARY}" >&2; exit 1;; esac`);
  const bws = cli('bws', `echo "args=$* token=$BWS_ACCESS_TOKEN" >> ${log}
case "$3" in 11111111-2222-3333-4444-555555555555) printf '{"id":"x","key":"gh","value":"${CANARY}","note":"n"}';; *) exit 1;; esac`);
  process.env.CANARY_ENV = 'must-not-be-inherited';
  t.after(() => { delete process.env.CANARY_ENV; });
  const one = createStore('op', { type: '1password', command: op, token_file: tokenFile(dir, 'opt', 'ops_token_0001') });
  assert.equal((await one.read('Agents/github')).toString(), CANARY, 'the default field is password');
  assert.equal((await one.read('Agents/github', 'otp')).toString(), '123456');
  await assert.rejects(one.read('Agents/none'), (e) => code('NOT_FOUND')(e) && !e.message.includes(CANARY), "the CLI's own output is not repeated");
  await assert.rejects(one.write('Agents/github', null, Buffer.from('x')), code('UNSUPPORTED'));
  const bw = createStore('bw', { type: 'bitwarden', command: bws, token_file: tokenFile(dir, 'bwt', 'bws_token_0001') });
  assert.equal((await bw.read('11111111-2222-3333-4444-555555555555')).toString(), CANARY);
  assert.equal((await bw.read('11111111-2222-3333-4444-555555555555', 'note')).toString(), 'n');
  await assert.rejects(bw.read('00000000-2222-3333-4444-555555555555'), code('NOT_FOUND'));
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls[0], 'args=read --no-newline op://Agents/github/password token=ops_token_0001 extra=');
  assert.match(calls.at(-1), /^args=secret get 00000000-2222-3333-4444-555555555555 --output json token=bws_token_0001$/);
  const gone = createStore('op', { type: '1password', command: path.join(dir, 'not-installed') });
  await assert.rejects(gone.read('Agents/github'), (e) => code('UNAVAILABLE')(e) && /not installed/.test(e.message));
  assert.throws(() => createStore('op', { type: '1password', command: 'op; rm -rf /' }), /program name or an absolute path/);
  assert.throws(() => createStore('x', { type: 'keychain' }), /type must be one of/);
});

const recipe = (over = {}) => ({ store: 'files', path: 'tenants/{tenant}/github', origin: 'https://github.com', selector: '#password', ...over });
const storesDoc = (dir, over = {}) => ({ stores: { files: { type: 'file', dir }, ro: { type: 'env' } }, ...over });
const parse = (doc, tenants = ['alice', 'bob']) => parseSecretStores({ BOSUN_SECRET_STORES: JSON.stringify(doc) }, new Set(tenants), { isLoopbackHost });

test('recipes and save targets: installation level for every tenant, tenant level replaces or removes; strict validation', (t) => {
  const dir = tmp(t);
  assert.equal(parseSecretStores({}, new Set(['alice']), { isLoopbackHost }), null, 'off unless configured');
  const p = parse(storesDoc(dir, {
    recipes: { 'github-password': recipe({ description: 'GitHub login' }), shared: recipe({ path: 'shared/x' }) },
    save_targets: { generated: { store: 'files', path_prefix: 'tenants/{tenant}/generated/', origins: ['https://github.com'] } },
    tenants: { bob: { recipes: { shared: null, 'github-password': recipe({ path: 'bob-own/github', submit: true, submit_to: ['https://github.com/session'] }), otp: recipe({ store: 'client', path: undefined, field_type: 'text' }) },
      save_targets: { generated: null } } },
  }));
  assert.deepEqual([...p.recipes.get('alice').keys()], ['github-password', 'shared']);
  assert.equal(p.recipes.get('alice').get('github-password').path, 'tenants/alice/github', '{tenant} keeps tenants apart');
  assert.deepEqual([...p.recipes.get('bob').keys()], ['github-password', 'otp']);
  assert.equal(p.recipes.get('bob').get('github-password').path, 'bob-own/github');
  assert.deepEqual(p.recipes.get('bob').get('github-password').submitTo, [{ origin: 'https://github.com', path: '/session' }]);
  assert.deepEqual(p.recipes.get('alice').get('github-password').submitTo, [{ origin: 'https://github.com', path: '/' }], 'default: the recipe origin');
  assert.equal(p.targets.get('alice').get('generated').pathPrefix, 'tenants/alice/generated/');
  assert.equal(p.targets.get('bob').size, 0);

  const file = path.join(dir, 'stores.json');
  fs.writeFileSync(file, JSON.stringify(storesDoc(dir, { recipes: { r: recipe() } })));
  assert.equal(parseSecretStores({ BOSUN_SECRET_STORES: file }, new Set(['alice']), { isLoopbackHost }).recipes.get('alice').size, 1, 'a file path works too');

  const bad = (doc, re, tenants) => assert.throws(() => parse(doc, tenants), re);
  bad(storesDoc(dir, { recipes: { r: recipe({ origin: 'http://github.com' }) } }), /must be https/);
  bad(storesDoc(dir, { recipes: { r: recipe({ origin: 'https://github.com/login' }) } }), /scheme, host and port only/);
  bad(storesDoc(dir, { recipes: { r: recipe({ selector: '' }) } }), /selector is required/);
  bad(storesDoc(dir, { recipes: { r: recipe({ store: 'nope' }) } }), /store "nope" is not defined/);
  bad(storesDoc(dir, { recipes: { r: recipe({ path: '../etc/passwd' }) } }), /not a valid store path/);
  bad(storesDoc(dir, { recipes: { r: recipe({ field_type: 'file' }) } }), /field_type must be one of/);
  bad(storesDoc(dir, { recipes: { r: recipe({ submit_to: ['http://evil.example/x'] }) } }), /must be https/);
  bad(storesDoc(dir, { recipes: { r: recipe({ value: 'inline-secret' }) } }), /unknown key "value"/);
  bad(storesDoc(dir, { recipes: { 'Bad Name': recipe() } }), /lowercase letters/);
  bad(storesDoc(dir, { recipes: { r: null } }), /must be an object/);
  bad(storesDoc(dir, { save_targets: { t: { store: 'ro', path_prefix: 'x/', origins: ['*'] } } }), /read-only/);
  bad(storesDoc(dir, { save_targets: { t: { store: 'files', path_prefix: 'x', origins: ['*'] } } }), /must end with \//);
  bad(storesDoc(dir, { save_targets: { t: { store: 'files', path_prefix: 'x/' } } }), /origins is required/);
  bad(storesDoc(dir, { tenants: { carol: {} } }), /tenant "carol", which has no token/);
  bad(storesDoc(dir, { stores: { client: { type: 'env' } } }), /not "client"/);
  bad({ storez: {} }, /unknown key "storez"/);
  assert.throws(() => parseSecretStores({ BOSUN_SECRET_STORES: `{"stores": {"x": "${CANARY}` }, new Set(), { isLoopbackHost }), (e) => /invalid JSON/.test(e.message) && !e.message.includes(CANARY));
  assert.throws(() => parseSecretStores({ BOSUN_SECRET_STORES: '/nonexistent/stores.json' }, new Set(), { isLoopbackHost }), /ENOENT/);
});

test('loadConfig: BOSUN_SECRET_STORES is off by default, validated at start, and refused for a read-only tenant', (t) => {
  const dir = tmp(t);
  assert.equal(loadConfig({}).secretStores, null);
  const env = { BROWSER_TOKENS: 'alice:alice-token-0123456789,swarm:swarm-token-0123456789', BROWSER_TOKEN_POLICIES: 'swarm=ephemeral' };
  const cfg = loadConfig({ ...env, BOSUN_SECRET_STORES: JSON.stringify(storesDoc(dir, { tenants: { alice: { recipes: { r: recipe() } } } })) });
  assert.equal(cfg.secretStores.recipes.get('alice').size, 1);
  assert.equal(cfg.secretStores.recipes.get('swarm').size, 0);
  assert.throws(() => loadConfig({ ...env, BOSUN_SECRET_STORES: JSON.stringify(storesDoc(dir, { tenants: { swarm: { recipes: { r: recipe() } } } })) }), /policy is ephemeral/);
  const both = loadConfig({ ...env, BOSUN_SECRET_STORES: JSON.stringify(storesDoc(dir, { recipes: { r: recipe() } })) }).secretStores.recipes;
  assert.deepEqual([both.get('alice').size, both.get('swarm').size], [1, 0], 'an installation recipe reaches full-policy tenants only');
  assert.equal(loadConfig({ BOSUN_SECRET_STORES: JSON.stringify(storesDoc(dir, { recipes: { r: recipe() } })) }).secretStores.recipes.get('default').size, 1, 'the local default tenant');
});

test('SecretStores: a tenant resolves and saves only through its own recipes and targets; every operation is audited without the value', async (t) => {
  const dir = tmp(t), data = tmp(t);
  fs.mkdirSync(path.join(dir, 'tenants', 'alice'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tenants', 'bob'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tenants', 'alice', 'github'), CANARY);
  fs.writeFileSync(path.join(dir, 'tenants', 'bob', 'github'), 'bob-secret-value');
  const logged = [];
  const stores = new SecretStores(parse(storesDoc(dir, {
    recipes: { github: recipe(), fromclient: recipe({ store: 'client', path: undefined }) },
    save_targets: { generated: { store: 'files', path_prefix: 'tenants/{tenant}/generated/', origins: ['https://github.com'] } },
    tenants: { alice: { recipes: { mine: recipe({ path: 'tenants/alice/github' }) }, save_targets: { rotating: { store: 'files', path_prefix: 'tenants/alice/rot/', origins: ['*'], overwrite: true } } } },
  })), { audit: new SecretAudit(data, { log: (l) => logged.push(l) }) });
  const alice = stores.forTenant('alice'), bob = stores.forTenant('bob'), nobody = stores.forTenant('carol');
  assert.equal(nobody.enabled, false);
  assert.deepEqual(alice.list().recipes.map((r) => r.name), ['github', 'fromclient', 'mine']);
  assert.deepEqual(alice.binding('github'), { name: 'github', source: 'store', origin: 'https://github.com', selector: '#password', field_type: 'password', submit: false, submit_to: ['https://github.com'] });
  assert.ok(!JSON.stringify(alice.list()).includes('tenants/'), 'an agent never sees a store path');
  assert.equal((await alice.resolve('github', { session: 's1', origin: 'https://github.com' })).toString(), CANARY);
  assert.equal((await bob.resolve('github')).toString(), 'bob-secret-value');
  await assert.rejects(bob.resolve('mine'), code('NOT_FOUND'), "another tenant's recipe does not exist");
  await assert.rejects(alice.resolve('fromclient'), code('INVALID'));
  await assert.rejects(alice.resolve('__proto__'), code('NOT_FOUND'));

  const value = Buffer.from(CANARY);
  assert.deepEqual(await alice.save('generated', 'gh-pat', value, { origin: 'https://github.com', session: 's1' }), { store_target: 'generated', key: 'gh-pat' });
  assert.ok(value.every((b) => b === 0), 'the buffer is wiped');
  assert.equal(fs.readFileSync(path.join(dir, 'tenants', 'alice', 'generated', 'gh-pat'), 'utf8'), CANARY);
  await assert.rejects(alice.save('generated', 'gh-pat', Buffer.from('x'), { origin: 'https://github.com' }), code('EXISTS'));
  await assert.rejects(alice.save('generated', 'gh-pat', Buffer.from('x'), { origin: 'https://github.com', overwrite: true }), code('FORBIDDEN'), 'overwrite only where the operator allowed it');
  await assert.rejects(alice.save('generated', 'k', Buffer.from('x'), { origin: 'https://evil.example' }), code('FORBIDDEN'));
  await assert.rejects(alice.save('generated', '../../bob/github', Buffer.from('x'), { origin: 'https://github.com' }), code('INVALID'));
  await assert.rejects(alice.save('generated', 'a/b', Buffer.from('x'), { origin: 'https://github.com' }), code('INVALID'));
  await assert.rejects(bob.save('rotating', 'k', Buffer.from('x'), { origin: 'https://x.example' }), code('NOT_FOUND'));
  await assert.rejects(alice.save('generated', 'big', Buffer.alloc(5000, 97), { origin: 'https://github.com' }), code('TOO_LARGE'));
  await alice.save('rotating', 'k', Buffer.from('v1'), { origin: 'https://anything.example' });
  await alice.save('rotating', 'k', Buffer.from('v2'), { origin: 'https://anything.example', overwrite: true });
  assert.equal(fs.readFileSync(path.join(dir, 'tenants', 'alice', 'rot', 'k'), 'utf8'), 'v2');
  assert.equal(fs.readFileSync(path.join(dir, 'tenants', 'bob', 'github'), 'utf8'), 'bob-secret-value');
  alice.note({ action: 'fill', recipe: 'github', session: 's1', origin: 'https://github.com', status: 'ok', value: CANARY, anything: 'else' });

  const file = path.join(data, 'audit', 'secrets.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(CANARY) && !logged.join('\n').includes(CANARY), 'no value in the audit log or on stderr');
  assert.deepEqual({ ...lines[0], ts: 0 }, { ts: 0, tenant: 'alice', action: 'resolve', recipe: 'github', store: 'files', path: 'tenants/alice/github', session: 's1', origin: 'https://github.com', status: 'ok' });
  assert.deepEqual(lines.filter((l) => l.status === 'error').map((l) => [l.tenant, l.action, l.code]), [
    ['bob', 'resolve', undefined], ['alice', 'save', 'EXISTS'], ['alice', 'save', 'FORBIDDEN'], ['alice', 'save', 'FORBIDDEN'], ['alice', 'save', 'INVALID'], ['alice', 'save', 'INVALID'], ['bob', 'save', 'NOT_FOUND'], ['alice', 'save', 'TOO_LARGE'],
  ].filter(([, , c]) => c));
  assert.deepEqual({ ...lines.at(-1), ts: 0 }, { ts: 0, tenant: 'alice', action: 'fill', recipe: 'github', session: 's1', origin: 'https://github.com', status: 'ok' }, 'a note carries only the known fields');
});

test('SecretGuard scrubs a value and its encodings from text, per tenant, until the session is dropped', () => {
  const g = new SecretGuard();
  const v = 'p@ss word/1+2';
  g.add('alice', 's1', v);
  g.add('alice', 's1', 'ab'); // too short to mask safely
  const forms = [v, encodeURIComponent(v), 'p%40ss+word%2F1%2B2', Buffer.from(v).toString('base64'), Buffer.from(v).toString('hex'), JSON.stringify(v).slice(1, -1)];
  for (const f of forms) assert.equal(g.scrub('alice', `x ${f} y`), 'x [masked] y', f);
  assert.equal(g.scrub('bob', `x ${v} y`), `x ${v} y`, "another tenant's output is not touched");
  assert.equal(g.scrub('alice', 'about tabs'), 'about tabs');
  assert.ok(g.holds('alice', `<${v}>`) && !g.holds('bob', v) && !g.holds('alice', 'other'));
  assert.deepEqual(g.values('s1'), [v]);
  g.drop('s1');
  assert.equal(g.scrub('alice', v), v);
});

test('sandbox broker: the socket is the tenant; values cross it as bytes and errors keep their codes', async (t) => {
  const dir = tmp(t), data = tmp(t), sock = tmp(t);
  fs.mkdirSync(path.join(dir, 'tenants', 'alice'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tenants', 'alice', 'github'), CANARY);
  const stores = new SecretStores(parse(storesDoc(dir, {
    recipes: { github: recipe() }, save_targets: { generated: { store: 'files', path_prefix: 'tenants/{tenant}/generated/', origins: ['https://github.com'] } },
    tenants: { bob: { recipes: { github: null } } },
  })), { audit: new SecretAudit(data, { log: () => {} }) });
  const brokers = [await startSecretBroker({ store: stores.forTenant('alice'), socketPath: path.join(sock, 'a') }), await startSecretBroker({ store: stores.forTenant('bob'), socketPath: path.join(sock, 'b') })];
  t.after(() => Promise.all(brokers.map((b) => b.close())));
  assert.equal(fs.statSync(path.join(sock, 'a')).mode & 0o777, 0o600);
  const alice = await connectSecretBroker(path.join(sock, 'a')), bob = await connectSecretBroker(path.join(sock, 'b'));
  assert.deepEqual(alice.list(), stores.forTenant('alice').list());
  assert.deepEqual(alice.binding('github'), stores.forTenant('alice').binding('github'));
  assert.equal((await alice.resolve('github', { session: 's1', origin: 'https://github.com' })).toString(), CANARY);
  assert.deepEqual(bob.list().recipes, []);
  assert.throws(() => bob.binding('github'), code('NOT_FOUND'));
  await assert.rejects(bob.resolve('github'), code('NOT_FOUND'), 'asking the broker directly does not help');
  assert.deepEqual(await alice.save('generated', 'pat', Buffer.from('saved-1'), { origin: 'https://github.com', session: 's1' }), { store_target: 'generated', key: 'pat' });
  assert.equal(fs.readFileSync(path.join(dir, 'tenants', 'alice', 'generated', 'pat'), 'utf8'), 'saved-1');
  await assert.rejects(alice.save('generated', 'pat', Buffer.from('saved-2'), { origin: 'https://github.com' }), code('EXISTS'));
  await assert.rejects(alice.save('generated', 'x', Buffer.from('v'), { origin: 'https://evil.example' }), code('FORBIDDEN'));
  await assert.rejects(alice.save('generated', 'huge', Buffer.alloc(20000, 97), { origin: 'https://github.com' }), (e) => e instanceof StoreError);
  alice.note({ action: 'fill', recipe: 'github', status: 'ok', tenant: 'bob' });
  await new Promise((r) => setTimeout(r, 100));
  const lines = fs.readFileSync(path.join(data, 'audit', 'secrets.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).tenant, 'alice', 'a worker cannot write audit lines for another tenant');
  await brokers[0].close();
  await assert.rejects(alice.resolve('github'), code('UNAVAILABLE'));
});
