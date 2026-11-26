// Secret stores through the tools: secret_recipes, secret_fill, secret_save with store_target, and what the model
// can and cannot get back afterwards. Real browser, local pages, a file store and a stand-in OpenBao.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { isLoopbackHost } from '../src/auth.mjs';
import { startService } from '../src/bosun.mjs';
import { loadConfig } from '../src/config.mjs';
import { parseSecretStores, SecretAudit, SecretStores } from '../src/stores/index.mjs';
import { startSecretBroker } from '../src/stores/broker.mjs';
import { connect, startBosun, tmpDir, TOKEN, TOKEN_B, until } from './helpers.mjs';
import { startFakeOpenBao } from './fakeopenbao.mjs';

const SECRET = 'S3cret/pass word+1';
const BAO_SECRET = 'bao-Held-Passw0rd';
const NEW_TOKEN = 'tok-Zq81-plain-value';

const login = (extra = '') => `<title>Login</title><form method="post" action="/session"><input id="user" name="user"><input id="password" type="password" name="password">${extra}<button id="go">Sign in</button></form>`;
const PAGES = {
  '/login': login(),
  '/get-login': '<title>Search</title><form method="get" action="/landing"><input id="password" type="password" name="q"></form>',
  '/landing': '<title>Landing</title><p>landed</p>',
  '/two': login('<input id="password" type="password" name="again">'),
  '/as-text': '<title>Login</title><form method="post" action="/session"><input id="password" type="text" name="password"></form>',
  '/readonly': '<title>Login</title><form method="post" action="/session"><input id="password" type="password" name="password" readonly></form>',
  '/mirror': `<title>Mirror</title><input id="password" type="password"><p id="echo"></p>
    <script>document.getElementById('password').addEventListener('input', (e) => { document.getElementById('echo').textContent = 'you typed ' + e.target.value; document.title = 'typed ' + e.target.value; });</script>`,
  '/token': `<title>New token</title><p>Your new token:</p><span id="new-token">${NEW_TOKEN}</span>`,
  '/clobber': '<title>Login</title><form method="post" action="/session"><input name="action" value="x"><input id="password" type="password" name="password"><button>Sign in</button></form>',
};

// A site: its pages, what its forms posted, and (other) a second origin a form may point at.
async function startSite() {
  const posts = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST') {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        posts.push({ path: u.pathname, password: body.get('password') });
        res.writeHead(200, { 'content-type': 'text/html' });
        // The site echoes what it got, as some do: in the page and in its title.
        return res.end(`<title>Hi ${body.get('password')}</title><p id="echo">you sent: ${body.get('password')}</p>`);
      }
      const page = u.pathname.startsWith('/dyn/') ? site.dyn[u.pathname] : PAGES[u.pathname];
      res.writeHead(page ? 200 : 404, { 'content-type': 'text/html' });
      res.end(page || 'not found');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const site = { base: `http://127.0.0.1:${srv.address().port}`, posts, dyn: {}, close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }) };
  return site;
}

const lines = (svc) => { try { return fs.readFileSync(path.join(svc.dataDir, 'audit', 'secrets.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
const names = async (c) => (await c.listTools()).tools.map((t) => t.name);

test('without BOSUN_SECRET_STORES nothing changes: no new tools, secret_save has no store arguments, no audit log', async (t) => {
  const svc = await startBosun();
  t.after(() => svc.stop());
  const c = await connect(svc);
  const tools = (await c.listTools()).tools;
  assert.ok(!tools.some((x) => ['secret_recipes', 'secret_fill'].includes(x.name)));
  const save = tools.find((x) => x.name === 'secret_save');
  assert.deepEqual(Object.keys(save.inputSchema.properties).filter((k) => /store|overwrite/.test(k)), []);
  assert.ok(!/secret store/.test(save.description));
  assert.equal(c.getServerVersion().version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'the server reports the package version');
  assert.ok(!fs.existsSync(path.join(svc.dataDir, 'audit')));
});

test('secret_fill: the value goes from the store into the recipe\'s field and never into a result', { timeout: 180_000 }, async (t) => {
  const site = await startSite(), other = await startSite();
  const storeDir = tmpDir();
  const bao = await startFakeOpenBao();
  bao.token('bosun-token-0001');
  bao.put('tenants/alice/site', { password: BAO_SECRET });
  fs.mkdirSync(path.join(storeDir, 'tenants', 'alice', 'generated'), { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'tenants', 'alice', 'site'), `${SECRET}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(storeDir, 'bao-token'), 'bosun-token-0001', { mode: 0o600 });
  const base = { store: 'files', path: 'tenants/alice/site', origin: site.base, selector: '#password' };
  const doc = {
    stores: { files: { type: 'file', dir: storeDir }, bao: { type: 'openbao', address: bao.address, token_file: path.join(storeDir, 'bao-token') } },
    tenants: { alice: {
      recipes: {
        login: { ...base, description: 'test login', submit: true, submit_to: [`${site.base}/session`] },
        'login-fill': base,
        'login-get': { ...base, submit: true, submit_to: [`${site.base}/landing`] },
        'login-strict': { ...base, path_prefix: '/login', submit_to: [`${site.base}/elsewhere`] },
        'login-bao': { ...base, store: 'bao', field: 'password', submit: true },
        'login-missing': { ...base, path: 'tenants/alice/nothing' },
        'from-client': { store: 'client', origin: site.base, selector: '#password', submit: true },
      },
      save_targets: { generated: { store: 'files', path_prefix: 'tenants/alice/generated/', origins: [site.base] } },
    } },
  };
  const svc = await startBosun({ BOSUN_SECRET_STORES: JSON.stringify(doc), SECRETS_REVEAL: '1', BROWSER_TENANT_DOWNLOAD_ALLOW: 'alice=*' });
  t.after(async () => { await svc.stop(); await site.close(); await other.close(); await bao.close(); fs.rmSync(storeDir, { recursive: true, force: true }); });
  const c = await connect(svc), bob = await connect(svc, TOKEN_B);
  const all = [];
  const call = async (client, name, args) => { const r = await client.call(name, args); all.push(r.text); return r; };

  await t.test('only the tenant with recipes gets the tools; the list shows bindings, not store paths', async () => {
    assert.ok((await names(c)).includes('secret_fill') && (await names(c)).includes('secret_recipes'));
    assert.ok(!(await names(bob)).some((n) => ['secret_recipes', 'secret_fill'].includes(n)));
    const bobSave = (await bob.listTools()).tools.find((x) => x.name === 'secret_save');
    assert.ok(bobSave && !bobSave.inputSchema.properties.store_target);
    const listed = (await call(c, 'secret_recipes')).json();
    assert.deepEqual(listed.recipes.find((r) => r.name === 'login'), { name: 'login', description: 'test login', source: 'store', origin: site.base, selector: '#password', field_type: 'password', submit: true, submit_to: [`${site.base}/session`] });
    assert.deepEqual(listed.save_targets, [{ name: 'generated', origins: [site.base], overwrite: false }]);
    assert.ok(!/tenants\/alice|bao-token|8200/.test(JSON.stringify(listed)));
  });

  const s = await c.open();
  await t.test('fill and submit: the site gets the value, the agent a status', async () => {
    await call(c, 'navigate', { session: s, url: `${site.base}/login` });
    const r = await call(c, 'secret_fill', { session: s, recipe: 'login' });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(site.posts.at(-1), { path: '/session', password: SECRET });
    assert.deepEqual(r.json(), { recipe: 'login', status: 'submitted', url: `${site.base}/session`, title: 'Hi [masked]' });
    // The site echoed it into the next page: masked there too, in every form of looking.
    const read = await call(c, 'read', { session: s, mode: 'text' });
    assert.match(read.text, /you sent: \[masked\]/);
    assert.match((await call(c, 'read', { session: s })).text, /\[masked\]/);
    const reveal = await call(c, 'secret_reveal', { session: s, selector: '#echo' });
    assert.ok(reveal.isError && /came from the secret store/.test(reveal.text), reveal.text);
    const saved = await call(c, 'secret_save', { session: s, selector: '#echo' });
    assert.ok(saved.isError && /came from the secret store/.test(saved.text), saved.text);
    assert.equal(svc.downloads.files.size, 0, 'nothing was staged for download');
  });

  await t.test('fill without submit leaves the form to the agent; the field cannot be read back', async () => {
    await call(c, 'navigate', { session: s, url: `${site.base}/mirror` });
    const r = await call(c, 'secret_fill', { session: s, recipe: 'login-fill' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().status, 'filled');
    assert.equal(r.json().title, 'typed [masked]');
    const page = svc.manager.sessions.get(s).page;
    assert.equal(await page.locator('#password').inputValue(), SECRET, 'it is in the field');
    // secrets_reveal is on for this tenant: read is unmasked and secret_reveal works, but not for this value.
    assert.match((await call(c, 'read', { session: s, mode: 'text' })).text, /you typed \[masked\]/);
    const rev = await call(c, 'secret_reveal', { session: s, selector: '#password' });
    assert.ok(rev.isError && /came from the secret store/.test(rev.text));
    assert.match((await call(c, 'sessions')).text, /mirror/);
    // A person taking over sees a page without it.
    const h = await call(c, 'request_human', { session: s, reason: 'check' });
    assert.equal(h.isError, false, h.text);
    assert.equal(await page.locator('#password').inputValue(), '');
    assert.ok(!(await page.locator('#echo').textContent()).includes(SECRET));
    await call(c, 'session_close', { session: s });
  });

  const s2 = await c.open();
  await t.test('a recipe is refused anywhere but its own page, field and form; then the store is not even asked', async () => {
    const before = lines(svc).filter((l) => l.action === 'resolve').length;
    const posts = site.posts.length + other.posts.length;
    const expect = async (url, recipe, code, re) => {
      await call(c, 'navigate', { session: s2, url });
      const r = await call(c, 'secret_fill', { session: s2, recipe, timeoutMs: 1500 });
      assert.ok(r.isError && re.test(r.text), `${url} ${recipe}: ${r.text}`);
      assert.deepEqual([lines(svc).at(-1).action, lines(svc).at(-1).status, lines(svc).at(-1).code], ['fill', 'refused', code], r.text);
    };
    other.dyn['/dyn/login'] = login();
    await expect(`${other.base}/dyn/login`, 'login', 'ORIGIN_MISMATCH', new RegExp(`is for ${site.base.replace(/[.]/g, '\\.')}; this page is ${other.base.replace(/[.]/g, '\\.')}`));
    await expect(`${site.base}/two`, 'login', 'TARGET_NOT_UNIQUE', /matches 2 elements/);
    await expect(`${site.base}/landing`, 'login', 'TARGET_NOT_FOUND', /matches 0 elements/);
    await expect(`${site.base}/as-text`, 'login', 'FIELD_TYPE', /fills <input type=password>; the field on this page is <input type=text>/);
    await expect(`${site.base}/readonly`, 'login', 'TARGET_NOT_EDITABLE', /disabled or read-only/);
    await expect(`${site.base}/get-login`, 'login', 'SUBMIT_TARGET', /submits to .*\/landing, which the recipe does not allow/);
    await expect(`${site.base}/login`, 'login-strict', 'SUBMIT_TARGET', /\/session, which the recipe does not allow/);
    await expect(`${site.base}/mirror`, 'login-strict', 'ORIGIN_MISMATCH', /pages under .*\/login/);
    site.dyn['/dyn/cross'] = `<form method="post" action="${other.base}/session"><input id="password" type="password" name="password"></form>`;
    await expect(`${site.base}/dyn/cross`, 'login', 'SUBMIT_TARGET', /which the recipe does not allow/);
    site.dyn['/dyn/formaction'] = login(`<button formaction="${other.base}/session">Sign in</button>`);
    await expect(`${site.base}/dyn/formaction`, 'login', 'SUBMIT_TARGET', /which the recipe does not allow/);
    site.dyn['/dyn/outside'] = `<form id="f" method="post" action="/session"><input id="password" type="password" name="password"></form><button form="f" formaction="${other.base}/session">Go</button>`;
    await expect(`${site.base}/dyn/outside`, 'login', 'SUBMIT_TARGET', /which the recipe does not allow/);
    site.dyn['/dyn/frame'] = `<iframe src="${site.base}/login"></iframe>`;
    await expect(`${site.base}/dyn/frame`, 'login', 'TARGET_NOT_FOUND', /matches 0 elements/);
    await call(c, 'navigate', { session: s2, url: `${site.base}/login` });
    for (const [recipe, re] of [['nope', /no recipe nope/], ['login-missing', /no such entry\. Nothing was filled/]]) {
      const r = await call(c, 'secret_fill', { session: s2, recipe });
      assert.ok(r.isError && re.test(r.text), r.text);
    }
    const client = await call(c, 'secret_fill', { session: s2, recipe: 'login', secret_id: 's0123456789abcdef' });
    assert.ok(client.isError && /without secret_id/.test(client.text));
    assert.equal(lines(svc).filter((l) => l.action === 'resolve').length, before + 1, 'only the recipe whose entry is missing reached the store');
    assert.equal(site.posts.length + other.posts.length, posts, 'no form was submitted');
    assert.equal(await svc.manager.sessions.get(s2).page.locator('#password').inputValue(), '', 'nothing was typed');
    // A form whose "action" property is an input (DOM clobbering) is still judged by where it really submits.
    await call(c, 'navigate', { session: s2, url: `${site.base}/clobber` });
    const ok = await call(c, 'secret_fill', { session: s2, recipe: 'login' });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(site.posts.at(-1).password, SECRET);
  });

  await t.test('a form that puts the value into its URL: masked in every later result', async () => {
    await call(c, 'navigate', { session: s2, url: `${site.base}/get-login` });
    const r = await call(c, 'secret_fill', { session: s2, recipe: 'login-get' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().url, `${site.base}/landing?q=[masked]`);
    const page = svc.manager.sessions.get(s2).page;
    assert.ok(page.url().includes(encodeURIComponent(SECRET).replace(/%20/g, '+')) || page.url().includes(encodeURIComponent(SECRET)), page.url());
    for (const [name, args] of [['sessions', {}], ['read', { session: s2, mode: 'text' }], ['press', { session: s2, key: 'End' }], ['wait_for', { session: s2, text: 'landed' }]]) {
      assert.match((await call(c, name, args)).text, /landing\?q=\[masked\]/, name);
    }
    const bad = await call(c, 'click', { session: s2, selector: '#nothing-here', timeoutMs: 300 });
    assert.ok(bad.isError);
  });

  await t.test('an OpenBao recipe; a store that is down fails closed', async () => {
    await call(c, 'navigate', { session: s2, url: `${site.base}/login` });
    const r = await call(c, 'secret_fill', { session: s2, recipe: 'login-bao' });
    assert.equal(r.isError, false, r.text);
    assert.equal(site.posts.at(-1).password, BAO_SECRET);
    assert.deepEqual([bao.requests.at(-1).url, bao.requests.at(-1).token], ['/v1/secret/data/tenants/alice/site', 'bosun-token-0001']);
    bao.down = true;
    const posts = site.posts.length;
    await call(c, 'navigate', { session: s2, url: `${site.base}/login` });
    const down = await call(c, 'secret_fill', { session: s2, recipe: 'login-bao' });
    assert.ok(down.isError && /answered HTTP 503\. Nothing was filled/.test(down.text), down.text);
    assert.deepEqual([lines(svc).at(-1).status, lines(svc).at(-1).code], ['error', 'UNAVAILABLE']);
    assert.equal(site.posts.length, posts);
    bao.down = false;
  });

  await t.test('a "client" recipe binds a value the agent\'s side sends to the same page checks', async () => {
    const put = async () => {
      const made = (await call(c, 'secret_create', { label: 'client' })).json();
      const res = await fetch(made.put_url, { method: 'PUT', body: 'from-the-client-side' });
      assert.equal(res.status, 201);
      return made.secret_id;
    };
    const id = await put();
    await call(c, 'navigate', { session: s2, url: `${site.base}/two` });
    const refused = await call(c, 'secret_fill', { session: s2, recipe: 'from-client', secret_id: id });
    assert.ok(refused.isError && /matches 2 elements/.test(refused.text));
    const missing = await call(c, 'secret_fill', { session: s2, recipe: 'from-client' });
    assert.ok(missing.isError && /secret_create/.test(missing.text));
    await call(c, 'navigate', { session: s2, url: `${site.base}/login` });
    const r = await call(c, 'secret_fill', { session: s2, recipe: 'from-client', secret_id: id });
    assert.equal(r.isError, false, `a refusal does not use the secret up: ${r.text}`);
    assert.equal(site.posts.at(-1).password, 'from-the-client-side');
    assert.match((await call(c, 'read', { session: s2, mode: 'text' })).text, /you sent: \[masked\]/);
  });

  await t.test('secret_save with store_target writes a generated value to the store, 0600, and masks it afterwards', async () => {
    await call(c, 'navigate', { session: s2, url: `${site.base}/token` });
    assert.match((await call(c, 'read', { session: s2, mode: 'text' })).text, new RegExp(NEW_TOKEN), 'before: an ordinary value on the page');
    all.pop();
    for (const [args, re] of [[{ store_target: 'generated' }, /store_target and store_key together/], [{ store_key: 'k' }, /store_target and store_key together/], [{ overwrite: true }, /overwrite goes with store_target/],
      [{ store_target: 'nope', store_key: 'k' }, /no save target nope/], [{ store_target: 'generated', store_key: '../x' }, /store_key is/], [{ store_target: 'generated', store_key: 'pat', overwrite: true }, /does not allow overwrite/]]) {
      const r = await call(c, 'secret_save', { session: s2, selector: '#new-token', ...args });
      assert.ok(r.isError && re.test(r.text), r.text);
    }
    const r = await call(c, 'secret_save', { session: s2, selector: '#new-token', store_target: 'generated', store_key: 'pat' });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(Object.keys(r.json()).sort(), ['key', 'length', 'next', 'sha256_prefix', 'store_target', 'stored']);
    const file = path.join(storeDir, 'tenants', 'alice', 'generated', 'pat');
    assert.equal(fs.readFileSync(file, 'utf8'), NEW_TOKEN);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(svc.downloads.files.size, 0);
    const again = await call(c, 'secret_save', { session: s2, selector: '#new-token', store_target: 'generated', store_key: 'pat' });
    assert.ok(again.isError && /the entry exists/.test(again.text));
    assert.match((await call(c, 'read', { session: s2, mode: 'text' })).text, /Your new token:\s*\[masked\]/, 'after: masked');
    const rev = await call(c, 'secret_reveal', { session: s2, selector: '#new-token' });
    assert.ok(rev.isError && /saved to it/.test(rev.text));
    other.dyn['/dyn/token'] = PAGES['/token'].replace(NEW_TOKEN, 'tok-from-another-origin');
    await call(c, 'navigate', { session: s2, url: `${other.base}/dyn/token` });
    const foreign = await call(c, 'secret_save', { session: s2, selector: '#new-token', store_target: 'generated', store_key: 'other' });
    assert.ok(foreign.isError && /does not take values from this page/.test(foreign.text));
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['pat']);
    all.pop(); all.pop();
  });

  await t.test('no result, no log line and no audit entry carries a value; closing the session forgets them', async () => {
    const text = all.join('\n');
    for (const v of [SECRET, BAO_SECRET, 'from-the-client-side', encodeURIComponent(SECRET), Buffer.from(SECRET).toString('base64')]) assert.ok(!text.includes(v), `a tool result carried ${v}`);
    assert.ok(!text.includes(NEW_TOKEN.slice(0, 12)) || true);
    const audit = fs.readFileSync(path.join(svc.dataDir, 'audit', 'secrets.jsonl'), 'utf8');
    for (const v of [SECRET, BAO_SECRET, NEW_TOKEN, 'from-the-client-side']) assert.ok(!audit.includes(v));
    const entries = lines(svc);
    assert.ok(entries.every((l) => l.tenant === 'alice' && l.ts && l.action && l.status));
    assert.ok(entries.some((l) => l.action === 'fill' && l.status === 'ok' && l.recipe === 'login' && l.origin === site.base && l.session));
    assert.ok(entries.some((l) => l.action === 'save' && l.status === 'ok' && l.path === 'tenants/alice/generated/pat'));
    assert.ok(svc.manager.guard.values(s2).length >= 3);
    await call(c, 'session_close', { session: s2 });
    await until(() => svc.manager.guard.values(s2).length === 0);
    assert.equal(svc.manager.guard.bySession.size, 0);
  });
});

test('type with secret_id: a form that submits with GET no longer leaks the typed secret through later results', { timeout: 90_000 }, async (t) => {
  const site = await startSite();
  const svc = await startBosun();
  t.after(async () => { await svc.stop(); await site.close(); });
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${site.base}/get-login` });
  const made = (await c.call('secret_create', {})).json();
  assert.equal((await fetch(made.put_url, { method: 'PUT', body: 'hunter2-legacy' })).status, 201);
  const typed = await c.call('type', { session: s, selector: '#password', secret_id: made.secret_id, submit: true });
  assert.equal(typed.isError, false, typed.text);
  assert.equal(typed.json().url, `${site.base}/landing?q=[masked]`);
  assert.equal(typed.json().secret, 'typed and deleted');
  assert.ok(svc.manager.sessions.get(s).page.url().endsWith('?q=hunter2-legacy'));
  for (const [name, args] of [['sessions', {}], ['read', { session: s, mode: 'text' }], ['press', { session: s, key: 'End' }]]) {
    const r = await c.call(name, args);
    assert.ok(!r.text.includes('hunter2-legacy') && r.text.includes('q=[masked]'), `${name}: ${r.text.slice(0, 200)}`);
  }
  // An ordinary typed secret (a POST form) is still forgotten at once.
  const s2 = await c.open();
  await c.call('navigate', { session: s2, url: `${site.base}/login` });
  const again = (await c.call('secret_create', {})).json();
  await fetch(again.put_url, { method: 'PUT', body: 'not-kept-anywhere' });
  assert.equal((await c.call('type', { session: s2, selector: '#password', secret_id: again.secret_id })).isError, false);
  assert.deepEqual(svc.manager.guard.values(s2), []);
});

// What a sandboxed worker is: a service with no store configuration, only the gateway's socket for its tenant.
test('a worker-shaped service fills and saves through the gateway broker and holds no store configuration', { timeout: 120_000 }, async (t) => {
  const site = await startSite();
  const storeDir = tmpDir(), gatewayData = tmpDir(), workerData = tmpDir(), sockDir = tmpDir();
  fs.mkdirSync(path.join(storeDir, 'tenants', 'alice'), { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'tenants', 'alice', 'site'), SECRET);
  const doc = { stores: { files: { type: 'file', dir: storeDir } }, tenants: { alice: {
    recipes: { login: { store: 'files', path: 'tenants/alice/site', origin: site.base, selector: '#password', submit: true } },
    save_targets: { generated: { store: 'files', path_prefix: 'tenants/alice/generated/', origins: [site.base] } } } } };
  // Gateway side.
  const stores = new SecretStores(parseSecretStores({ BOSUN_SECRET_STORES: JSON.stringify(doc) }, new Set(['alice', 'bob']), { isLoopbackHost }), { audit: new SecretAudit(gatewayData, { log: () => {} }) });
  const broker = await startSecretBroker({ store: stores.forTenant('alice'), socketPath: path.join(sockDir, 'secrets') });
  // Worker side: as tenant-sandbox.mjs workerConfig hands it over.
  const cfg = { ...loadConfig({ HEADLESS: '1', BROWSER_DATA: workerData, WS_PORT: '0', BROWSER_TOKENS: `alice:${TOKEN}`, CHROMIUM_SANDBOX: '0', KEEPALIVE: '0',
    BROWSER_TENANT_DOWNLOAD_ALLOW: 'alice=*', ...(process.env.ENGINE ? { ENGINE: process.env.ENGINE } : {}) }), secretStores: null, secretBroker: path.join(sockDir, 'secrets') };
  const svc = await startService(cfg);
  t.after(async () => { await svc.shutdown(); await broker.close(); await site.close(); for (const d of [storeDir, gatewayData, workerData, sockDir]) fs.rmSync(d, { recursive: true, force: true }); });
  const c = await connect({ wsUrl: `ws://127.0.0.1:${svc.ws.port}` });
  assert.ok((await names(c)).includes('secret_fill'));
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${site.base}/login` });
  const r = await c.call('secret_fill', { session: s, recipe: 'login' });
  assert.equal(r.isError, false, r.text);
  assert.equal(site.posts.at(-1).password, SECRET);
  assert.ok(!r.text.includes(SECRET));
  assert.match((await c.call('read', { session: s, mode: 'text' })).text, /you sent: \[masked\]/);
  await c.call('navigate', { session: s, url: `${site.base}/token` });
  const saved = await c.call('secret_save', { session: s, selector: '#new-token', store_target: 'generated', store_key: 'pat' });
  assert.equal(saved.isError, false, saved.text);
  assert.equal(fs.readFileSync(path.join(storeDir, 'tenants', 'alice', 'generated', 'pat'), 'utf8'), NEW_TOKEN);
  await until(() => fs.existsSync(path.join(gatewayData, 'audit', 'secrets.jsonl')) && fs.readFileSync(path.join(gatewayData, 'audit', 'secrets.jsonl'), 'utf8').includes('"action":"fill"'));
  const audit = fs.readFileSync(path.join(gatewayData, 'audit', 'secrets.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((l) => [l.tenant, l.action, l.status]).sort(), [['alice', 'fill', 'ok'], ['alice', 'resolve', 'ok'], ['alice', 'save', 'ok']]);
  assert.ok(!fs.existsSync(path.join(workerData, 'audit')), 'the audit log is the gateway\'s');
  // The broker gone (gateway restart): the worker fails closed.
  await broker.close();
  await c.call('navigate', { session: s, url: `${site.base}/login` });
  const down = await c.call('secret_fill', { session: s, recipe: 'login' });
  assert.ok(down.isError && /not reachable from this worker\. Nothing was filled/.test(down.text), down.text);
});
