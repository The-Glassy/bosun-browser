import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { Downloads, SAVED_SECRET_TTL_MS } from '../src/downloads.mjs';
import { SecretSettings } from '../src/secret-settings.mjs';
import { connect, startBosun, startPageServer, TOKEN, TOKEN_B, tmpDir, until } from './helpers.mjs';

const run = promisify(execFile);
const key = 'lin_api_BosunFixtureOnly1234567890abcdef';
const input = 'bosun-fixture-clé-from-input';
const swarm = 'test-token-ephemeral-0123456789';
const fixture = `<input id="password" type="password" aria-label="Password" value="old">
  <p>New API key</p><code>another code</code><code id="key"><span id="key-text">${key}</span></code>
  <p>End</p><div id="empty" style="height:1px"> </div><textarea id="custom">initial</textarea>
  <script>document.getElementById('password').value = ${JSON.stringify(input)};
    document.getElementById('custom').value = 'changed';</script>`;

test('reveal settings persist per tenant with env fallback and private permissions', (t) => {
  const dataDir = tmpDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const cfg = loadConfig({ BROWSER_DATA: dataDir, SECRETS_REVEAL: '1' });
  const s = new SecretSettings(cfg);
  assert.deepEqual(s.get('alice'), { settings: {}, effective: { secrets_reveal: true }, from: { secrets_reveal: 'env' } });
  assert.deepEqual(s.set('alice', false), { settings: { secrets_reveal: false }, effective: { secrets_reveal: false }, from: { secrets_reveal: 'tenant' } });
  assert.equal(s.get('bob').effective.secrets_reveal, true);
  assert.throws(() => s.set('alice', 'true'), /must be true, false or null/);
  assert.equal(new SecretSettings(cfg).get('alice').effective.secrets_reveal, false);
  assert.equal(fs.statSync(s.file('alice')).mode & 0o777, 0o600);
  assert.equal(s.set('alice', null).from.secrets_reveal, 'env');
  fs.writeFileSync(s.file('alice'), '{"secrets_reveal":"true"}');
  const safe = new SecretSettings(loadConfig({ BROWSER_DATA: dataDir, SECRETS_REVEAL: '0' }));
  assert.equal(safe.get('alice').effective.secrets_reveal, false);
  assert.throws(() => loadConfig({ SECRETS_REVEAL: 'yes' }), /SECRETS_REVEAL must be 0 or 1/);
});

test('secret files reserve download quota while being written and expire on schedule', async (t) => {
  const dataDir = tmpDir();
  const files = new Downloads(loadConfig({
    BROWSER_DATA: dataDir, DOWNLOAD_MAX_BYTES: '5', DOWNLOAD_TENANT_QUOTA_BYTES: '5', DOWNLOAD_URL_TTL_SEC: '3600',
  }));
  t.after(async () => { await files.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const saving = files.saveSecret('alice', 'saved.txt', Buffer.from('12345'));
  await assert.rejects(files.saveSecret('alice', 'other.txt', Buffer.from('x')), /download quota/);
  const f = await saving;
  files.issue(f);
  assert.equal(f.urlExpiresAt, f.expiresAt);
  assert.equal(await files.inline(f), null);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
  assert.equal(files.used('alice'), 5);
  files.sweep(f.expiresAt - 1);
  assert.ok(fs.existsSync(f.file));
  files.sweep(f.expiresAt + 1);
  await until(() => !fs.existsSync(f.file));
  assert.equal(files.used('alice'), 0);
});

async function service(t, env = {}) {
  const site = await startPageServer();
  t.after(() => site.close());
  const svc = await startBosun({
    FEATURES_MEETINGS: '0', KEEPALIVE: '0', BROWSER_TOKEN_POLICIES: 'swarm=ephemeral',
    BROWSER_TOKENS: `alice:${TOKEN},bob:${TOKEN_B},swarm:${swarm}`, ...env,
  });
  t.after(() => svc.stop());
  const client = async (token) => {
    const c = await connect(svc, token);
    t.after(() => c.close());
    return c;
  };
  const open = async (c) => {
    const session = await c.open();
    const nav = await c.call('navigate', { session, url: site.base });
    assert.equal(nav.isError, false, nav.text);
    const page = svc.manager.sessions.get(session).page;
    await page.setContent(fixture);
    return { session, page };
  };
  return { svc, client, open, host: new URL(site.base).host };
}

async function json(c, name, args) {
  const r = await c.call(name, args);
  assert.equal(r.isError, false, r.text);
  return r.json();
}

test('save text and the live input value to a private one-time GET without a download host', async (t) => {
  const { svc, client, open, host } = await service(t);
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const c = await client(TOKEN), b = await client(TOKEN_B), sameTenant = await client(TOKEN);
  const { session } = await open(c);
  const addr = { session, selector: 'code', nth: 1, after: 'New API key', before: 'End' };
  const denied = await sameTenant.call('secret_save', addr);
  assert.equal(denied.isError, true);
  assert.match(denied.text, /no session/);
  const saved = await json(c, 'secret_save', { ...addr, filename: "linear's key.txt" });
  assert.equal(saved.length, Buffer.byteLength(key));
  assert.equal(saved.sha256_prefix, crypto.createHash('sha256').update(key).digest('hex').slice(0, 8));
  assert.match(saved.curl, /curl -fsS -o .*get_url from download_get/);
  assert.ok(!JSON.stringify(saved).includes(key));
  const f = svc.downloads.files.get(saved.download_id);
  assert.equal(f.tenant, 'alice');
  assert.equal(svc.downloads.allowFor('alice'), null);
  assert.ok(f.expiresAt > Date.now() + SAVED_SECRET_TTL_MS - 5000);
  assert.match((await b.call('download_get', { download_id: saved.download_id })).text, /no download/);
  const url = await json(sameTenant, 'download_get', { download_id: saved.download_id, inline: true });
  assert.equal(url.inline, false);
  assert.equal(url.content, undefined);
  assert.ok(!JSON.stringify(url).includes(key));
  const ownHeaders = { authorization: `Bearer ${TOKEN}` };
  const otherHeaders = { authorization: `Bearer ${TOKEN_B}` };
  assert.equal((await fetch(url.get_url.split('?')[0], { headers: ownHeaders })).status, 403);
  assert.equal((await fetch(url.get_url, { headers: otherHeaders })).status, 403);
  const fetched = path.join(svc.dataDir, url.filename);
  await run('sh', ['-c', url.curl], { cwd: svc.dataDir });
  assert.equal(fs.readFileSync(fetched, 'utf8'), key);
  assert.equal(fs.statSync(fetched).mode & 0o777, 0o600);
  assert.ok([404, 410].includes((await fetch(url.get_url)).status));
  await until(() => !fs.existsSync(f.file));

  const snapshot = await c.call('read', { session });
  const ref = /textbox "Password".*?\[ref=(e\d+)\]/.exec(snapshot.text)?.[1];
  assert.ok(ref, snapshot.text);
  const password = await json(c, 'secret_save', { session, ref });
  assert.equal(password.length, Buffer.byteLength(input));
  assert.ok(!JSON.stringify(password).includes(input));
  const pwUrl = await json(c, 'download_get', { download_id: password.download_id, inline: false });
  assert.equal(await (await fetch(pwUrl.get_url)).text(), input);
  assert.match((await c.call('secret_save', { session, selector: '#password', attribute: 'text' })).text, /empty value/);
  assert.match((await c.call('secret_save', { session, selector: '#empty' })).text, /empty value/);
  const custom = await json(c, 'secret_save', { session, selector: '#custom', attribute: 'value' });
  const customUrl = await json(c, 'download_get', { download_id: custom.download_id, inline: false });
  assert.equal(await (await fetch(customUrl.get_url)).text(), 'changed');
  const err = await c.call('secret_save', { session, text: key, filename: key });
  assert.match(err.text, /use a filename without the secret value/);
  assert.ok(!err.text.includes(key));
  const expired = await json(c, 'secret_save', { session, selector: '#key', attribute: 'text' });
  const expiredUrl = await json(c, 'download_get', { download_id: expired.download_id, inline: false });
  svc.downloads.sweep(Date.now() + SAVED_SECRET_TTL_MS + 1);
  assert.ok([404, 410].includes((await fetch(expiredUrl.get_url)).status));
  assert.match((await c.call('download_get', { download_id: expired.download_id })).text, /no download/);
  for (const value of [key, input]) assert.ok(!logs.join('\n').includes(value));
  assert.ok(logs.some((line) => line.includes(`secret_save tenant=alice host=${host} element=selector <code> length=${Buffer.byteLength(key)} status=ok`)));
});

test('read and reveal follow tenant opt-in while screenshot still masks and audits omit values', async (t) => {
  const { client, open, host } = await service(t);
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  const a = await client(TOKEN), b = await client(TOKEN_B);
  const { session, page } = await open(a);
  const bob = await open(b);

  async function checkRead(c, id, reveal) {
    for (const mode of ['a11y', 'text']) {
      const r = await c.call('read', { session: id, mode });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.text.includes(key), reveal, r.text);
      assert.equal(r.text.includes(input), reveal && mode === 'a11y', r.text);
    }
  }

  assert.equal((await json(a, 'secret_settings_get')).effective.secrets_reveal, false);
  await checkRead(a, session, false);
  const target = { session, selector: '#key' };
  const off = await a.call('secret_reveal', target);
  assert.equal(off.isError, true);
  assert.match(off.text, /secrets_reveal is off.*use secret_save/);
  await json(a, 'secret_settings_set', { secrets_reveal: true });
  assert.deepEqual(await json(a, 'secret_reveal', target), { value: key });
  assert.deepEqual(await json(a, 'secret_reveal', { session, role: 'textbox', name: 'Password' }), { value: input });
  await checkRead(a, session, true);
  await checkRead(b, bob.session, false);
  assert.match((await b.call('secret_reveal', { session: bob.session, selector: '#key' })).text, /secrets_reveal is off/);

  const screenshot = page.screenshot.bind(page);
  let masked;
  t.mock.method(page, 'screenshot', async (opts) => {
    masked = await opts.mask[0].evaluateAll((els) => els.map((el) => el.id));
    return screenshot(opts);
  });
  const shot = await a.call('screenshot', { session });
  assert.equal(shot.isError, false, shot.text);
  assert.ok(masked.includes('password') && masked.includes('key-text'));
  await json(a, 'secret_settings_set', { secrets_reveal: false });
  await checkRead(a, session, false);
  assert.ok(logs.some((line) => line.includes(`secret_reveal tenant=alice host=${host} element=role <input> length=${Buffer.byteLength(input)} status=ok`)));
  for (const value of [key, input]) assert.ok(!logs.join('\n').includes(value));
});

test('an ephemeral swarm token cannot save or reveal and reads stay masked with a true env fallback', async (t) => {
  const { client, open } = await service(t, { SECRETS_REVEAL: '1' });
  const c = await client(swarm);
  const { session } = await open(c);
  const names = (await c.listTools()).tools.map(({ name }) => name);
  for (const tool of ['secret_save', 'secret_reveal', 'secret_settings_set', 'download_get']) {
    assert.ok(!names.includes(tool));
    const r = await c.call(tool, { session, selector: '#key' });
    assert.equal(r.isError, true);
    assert.match(r.text, /not allowed for this token|not found/i);
  }
  const r = await c.call('read', { session });
  assert.equal(r.isError, false, r.text);
  assert.ok(!r.text.includes(key) && !r.text.includes(input), r.text);
});
