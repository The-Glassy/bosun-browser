// Typing secrets without them passing through the agent: secret_create, a one-time PUT from the agent's shell, then
// type with secret_id. The value reaches the page (the form posts it), and never a tool result, an error, a PUT
// answer or a log line; it is typed once, stays with its tenant, expires, and goes only into a password field unless
// allowed; a field that got one is masked in read and screenshot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { Readable } from 'stream';
import { maskedScreenshot } from '../src/redact.mjs';
import { startBosun, connect, until, TOKEN, TOKEN_B } from './helpers.mjs';

const TOKEN_E = 'test-token-eeeeeeeeeeeeeeee';
const PW = 'Pä$$ wörd ✓ \'q" <x>&amp;';
const OTP = 'otp-773311-secret';

// /login posts to /recv, which records the fields it got. /search submits with GET to /echo, which puts the query
// into its title and body.
const PAGES = {
  '/login': `<title>Login</title><form method="post" action="/recv" novalidate>
    <label>User <input id="user" name="user"></label>
    <label>Password <input id="pw" type="password" name="pw"></label>
    <label>Contact <input id="email" type="email" name="email"></label>
    <label>Notes <textarea id="notes" name="notes"></textarea></label>
    <input id="agree" type="checkbox" name="agree"><div id="box">a div</div>
    <button id="go">Log in</button></form>`,
  '/search': `<title>Search</title><form method="get" action="/echo"><input id="pw" type="password" name="q"></form>`,
};

let pages, base, svc, received, logs, results;
const origLog = { error: console.error, log: console.log, warn: console.warn };
before(async () => {
  received = [];
  logs = [];
  results = [];
  for (const k of Object.keys(origLog)) console[k] = (...a) => { logs.push(a.join(' ')); origLog[k](...a); };
  pages = http.createServer((req, res) => {
    if (req.url === '/recv' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        received.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>Welcome</title><p id="r">logged in</p>');
      });
      return;
    }
    if (req.url.startsWith('/echo')) {
      const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
      const esc = q.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<title>Results for ${esc}</title><p>you searched ${esc}</p>`);
    }
    const body = PAGES[req.url];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body || 'not found');
  });
  await new Promise((r) => pages.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${pages.address().port}`;
  svc = await startBosun({ BROWSER_TOKENS: `alice:${TOKEN},bob:${TOKEN_B},swarm:${TOKEN_E}`, BROWSER_TOKEN_POLICIES: 'swarm=ephemeral' });
});
after(async () => {
  await svc.stop();
  await new Promise((r) => { pages.closeAllConnections(); pages.close(() => r()); });
  Object.assign(console, origLog);
});

// Every tool result of these tests is kept, to check at the end that no secret is in any of them.
async function client(token) {
  const c = await connect(svc, token);
  const call = c.call;
  c.call = async (...a) => { const r = await call(...a); results.push(r.text); return r; };
  return c;
}

function put(url, body, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(url, { method: 'PUT', headers: { ...(Buffer.isBuffer(body) ? { 'content-length': body.length } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (d) => { t += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json, text: t }); });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    if (Buffer.isBuffer(body)) req.end(body);
    else body.pipe(req);
  });
}

// secret_create + PUT; returns the secret_id.
async function send(c, value, label) {
  const r = await c.call('secret_create', label ? { label } : {});
  assert.equal(r.isError, false, r.text);
  const p = await put(r.json().put_url, Buffer.from(value));
  assert.equal(p.status, 201, p.text);
  results.push(p.text);
  return r.json().secret_id;
}

// A shell command with input on stdin, run without blocking the service in this process.
function sh(cmd, input) {
  return new Promise((resolve) => {
    const p = spawn('sh', ['-c', cmd]);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(input);
  });
}

const value = async (c, s, sel) => svc.manager.sessions.get(s).page.$eval(sel, (e) => e.value);

test('the curl line from secret_create, fed on stdin, then type into a password field: the form posts it', async () => {
  const c = await client(TOKEN);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${base}/login` });
  const r = await c.call('secret_create', { label: 'site password' });
  assert.equal(r.isError, false, r.text);
  const x = r.json();
  assert.match(x.secret_id, /^s[0-9a-f]{16}$/);
  assert.equal(x.label, 'site password');
  assert.match(x.put_url, /^http:\/\/127\.0\.0\.1:\d+\/secret\/s[0-9a-f]{16}\?t=/);
  assert.match(x.curl, /^curl -sS --fail-with-body -T - 'http:\/\/127\.0\.0\.1:\d+\/secret\//);
  assert.equal(x.valid_min, 15);
  assert.equal(x.max_bytes, 4096);
  // As an agent's shell runs it: the secret on stdin with the newline echo adds, chunked, nothing on the command line.
  const run = await sh(x.curl, `${PW}\n`);
  assert.equal(run.status, 0, run.stderr);
  const got = JSON.parse(run.stdout);
  assert.equal(got.secret_id, x.secret_id);
  assert.equal(got.bytes, Buffer.byteLength(PW));
  assert.ok(!run.stdout.includes(PW));
  assert.equal((await put(x.put_url, Buffer.from('again'))).status, 404); // the URL works once
  await c.call('type', { session: s, selector: '#user', value: 'tomsmith' });
  const t = await c.call('type', { session: s, selector: '#pw', secret_id: x.secret_id });
  assert.equal(t.isError, false, t.text);
  assert.equal(t.json().secret, 'typed and deleted');
  assert.equal(t.json().title, 'Login');
  assert.equal(await value(c, s, '#pw'), PW);
  for (const mode of ['a11y', 'text']) assert.ok(!(await c.call('read', { session: s, mode })).text.includes(PW));
  await c.call('click', { session: s, selector: '#go' });
  await until(() => received.length > 0);
  assert.deepEqual(received.pop(), { user: 'tomsmith', pw: PW, email: '', notes: '' });
  await c.close();
});

test('a secret is typed once: a second type is refused like an id that never existed', async () => {
  const c = await client(TOKEN);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${base}/login` });
  const id = await send(c, 'once-only-secret');
  assert.equal((await c.call('type', { session: s, selector: '#pw', secret_id: id })).isError, false);
  const again = await c.call('type', { session: s, selector: '#pw', secret_id: id });
  assert.equal(again.isError, true);
  assert.match(again.text, /no secret s[0-9a-f]{16}/);
  const never = await c.call('type', { session: s, selector: '#pw', secret_id: 's0000000000000000' });
  assert.equal(again.text.replace(id, 'X'), never.text.replace('s0000000000000000', 'X'));
  assert.equal(svc.secrets.items.has(id), false);
  // Not arrived yet: says so, and the slot stays.
  const w = (await c.call('secret_create')).json().secret_id;
  assert.match((await c.call('type', { session: s, selector: '#pw', secret_id: w })).text, /has not arrived yet/);
  // value and secret_id: one of them.
  assert.match((await c.call('type', { session: s, selector: '#pw', value: 'x', secret_id: w })).text, /give value or secret_id \(not both\)/);
  assert.match((await c.call('type', { session: s, selector: '#pw' })).text, /give value or secret_id/);
  svc.secrets.remove(svc.secrets.items.get(w));
  await c.close();
});

test('expiry: an unused PUT URL after 15 min, an untyped secret after 10 min; the service drops all of them on stop', async () => {
  const c = await client(TOKEN);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${base}/login` });
  const x = (await c.call('secret_create')).json();
  const item = svc.secrets.items.get(x.secret_id);
  assert.ok(Math.abs(item.urlExpiresAt - Date.now() - 15 * 60_000) < 5000);
  item.urlExpiresAt = Date.now() - 1;
  assert.equal((await put(x.put_url, Buffer.from('too-late-secret'))).status, 404);
  svc.secrets.sweep();
  assert.equal(svc.secrets.items.has(x.secret_id), false);
  const id = await send(c, 'expiring-secret');
  const ready = svc.secrets.items.get(id);
  assert.ok(Math.abs(ready.expiresAt - Date.now() - 10 * 60_000) < 5000);
  const held = ready.value;
  ready.expiresAt = Date.now() - 1;
  svc.secrets.sweep();
  assert.equal(svc.secrets.items.has(id), false);
  assert.ok(held.every((b) => b === 0)); // the buffer is wiped, not just dropped
  assert.match((await c.call('type', { session: s, selector: '#pw', secret_id: id })).text, /no secret/);
  assert.ok(logs.some((l) => l.includes(`secret ${id} of tenant alice: expired untyped`)));
  await c.close();
  // In memory only: a service that stops holds none, and nothing of them is in its data directory.
  const s2 = await startBosun();
  try {
    const c2 = await connect(s2, TOKEN);
    const r = (await c2.call('secret_create')).json();
    assert.equal((await put(r.put_url, Buffer.from('restart-secret'))).status, 201);
    const v = s2.secrets.items.get(r.secret_id).value;
    const grep = spawnSync('grep', ['-rl', 'restart-secret', s2.dataDir], { encoding: 'utf8' });
    assert.equal(grep.stdout, '');
    await c2.close();
    await s2.shutdown();
    assert.equal(s2.secrets.items.size, 0);
    assert.ok(v.every((b) => b === 0));
  } finally { await s2.stop(); }
});

test('size: 4096 bytes (and one trailing newline) fit, more is 413 with or without Content-Length; empty and non-UTF-8 are refused', async () => {
  const c = await client(TOKEN);
  const url = async () => (await c.call('secret_create')).json().put_url;
  const ok1 = await put(await url(), Buffer.alloc(4096, 'a'));
  assert.equal(ok1.status, 201, ok1.text);
  assert.equal(ok1.json.bytes, 4096);
  const ok2 = await put(await url(), Buffer.from('a'.repeat(4096) + '\n'));
  assert.equal(ok2.status, 201, ok2.text);
  assert.equal(ok2.json.bytes, 4096);
  const big = await put(await url(), Buffer.alloc(4097, 'b'));
  assert.equal(big.status, 413);
  assert.match(big.json.error, /at most 4096 bytes/);
  assert.equal((await put(await url(), Buffer.from('b'.repeat(4096) + '\n\n'))).status, 413);
  const chunked = await put(await url(), Readable.from([Buffer.alloc(3000, 'c'), Buffer.alloc(3000, 'c')]));
  assert.ok(chunked.status === 413 || chunked.status === 0, JSON.stringify(chunked)); // or the socket closed mid-write
  for (const body of ['', '\n']) assert.match((await put(await url(), Buffer.from(body))).json.error, /empty/);
  const bad = await put(await url(), Buffer.from([0x70, 0x77, 0xff, 0xfe]));
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /not valid UTF-8/);
  // Refused bodies leave no secret behind (a Content-Length over the cap is refused before the URL is spent).
  assert.equal([...svc.secrets.items.values()].filter((x) => x.value).length, 2);
  for (const x of [...svc.secrets.items.values()]) svc.secrets.remove(x);
  await c.close();
});

test("secrets never cross tenants: another tenant's secret_id and PUT header are refused; ephemeral tokens get no secrets", async () => {
  const a = await client(TOKEN);
  const b = await client(TOKEN_B);
  const e = await client(TOKEN_E);
  const id = await send(a, 'alice-only-secret');
  const sb = await b.open();
  await b.call('navigate', { session: sb, url: `${base}/login` });
  const r = await b.call('type', { session: sb, selector: '#pw', secret_id: id });
  assert.equal(r.isError, true);
  assert.match(r.text, /no secret/);
  assert.equal(await value(b, sb, '#pw'), '');
  assert.ok(svc.secrets.items.has(id)); // still alice's to type
  // alice's PUT URL with bob's, a bad or an ephemeral token in the header.
  const u = (await a.call('secret_create')).json().put_url;
  for (const t of [TOKEN_B, 'nope-nope-nope-nope', TOKEN_E]) assert.equal((await put(u, Buffer.from('x-secret'), { authorization: `Bearer ${t}` })).status, 403);
  // Her own token instead of the URL's; nothing at all is 401; a wrong token in the URL is 404.
  const bare = (await a.call('secret_create')).json().put_url.replace(/\?t=.*/, '');
  assert.equal((await put(bare, Buffer.from('h-secret'))).status, 401);
  assert.equal((await put(bare, Buffer.from('h-secret'), { authorization: `Bearer ${TOKEN}` })).status, 201);
  assert.equal((await put(u.replace(/t=.*/, 't=wrong'), Buffer.from('x-secret'))).status, 404);
  // Ephemeral: secret_create neither listed nor callable, type with secret_id refused.
  assert.ok(!(await e.listTools()).tools.map((t) => t.name).includes('secret_create'));
  assert.match((await e.call('secret_create')).text, /not allowed for this token/);
  const se = await e.open();
  await e.call('navigate', { session: se, url: `${base}/login` });
  assert.match((await e.call('type', { session: se, selector: '#pw', secret_id: id })).text, /not allowed for this token/);
  for (const x of [...svc.secrets.items.values()]) svc.secrets.remove(x);
  await Promise.all([a.close(), b.close(), e.close()]);
});

test('only into a password field, unless allow_non_password; such a field is masked in read and screenshot', async () => {
  const c = await client(TOKEN);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${base}/login` });
  const id = await send(c, OTP);
  const refused = await c.call('type', { session: s, selector: '#email', secret_id: id });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /<input type=email>, not a password field; pass allow_non_password: true/);
  assert.match((await c.call('type', { session: s, selector: '#notes', secret_id: id })).text, /a <textarea>, not a password field/);
  for (const sel of ['#agree', '#box']) {
    assert.match((await c.call('type', { session: s, selector: sel, secret_id: id, allow_non_password: true })).text, /only into a text field/);
  }
  assert.equal(await value(c, s, '#email'), '');
  assert.ok(svc.secrets.items.has(id)); // a refusal doesn't use the secret up
  const t = await c.call('type', { session: s, selector: '#email', secret_id: id, allow_non_password: true });
  assert.equal(t.isError, false, t.text);
  assert.equal(await value(c, s, '#email'), OTP);
  // "Contact" is no credential word and type=email no credential type: masked because a secret went in.
  for (const mode of ['a11y', 'text']) {
    const r = await c.call('read', { session: s, mode });
    assert.ok(!r.text.includes(OTP), r.text);
  }
  assert.match((await c.call('read', { session: s })).text, /textbox "Contact"(?: \[[^\]]*\])*: \[masked\]/);
  const page = svc.manager.sessions.get(s).page;
  const masked = await maskedScreenshot(page, async () => page.$eval('#email', (el) => el.hasAttribute('data-bosun-sensitive')));
  assert.equal(masked, true);
  assert.equal((await c.call('screenshot', { session: s })).isError, false);
  // A textarea, with one of two trailing newlines dropped; the form posts both fields as typed.
  const n = await send(c, 'two\nlines\n\n');
  assert.equal((await c.call('type', { session: s, selector: '#notes', secret_id: n, allow_non_password: true })).isError, false);
  await c.call('click', { session: s, selector: '#go' });
  await until(() => received.length > 0);
  const got = received.pop();
  assert.equal(got.email, OTP);
  assert.equal(got.notes.replace(/\r\n/g, '\n'), 'two\nlines\n');
  await c.close();
});

test('a page that echoes the secret into its URL and title: type submit returns them masked', async () => {
  const c = await client(TOKEN);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${base}/search` });
  const secret = 'echo me & you/100%';
  const id = await send(c, secret);
  const t = await c.call('type', { session: s, selector: '#pw', secret_id: id, submit: true });
  assert.equal(t.isError, false, t.text);
  const page = svc.manager.sessions.get(s).page;
  assert.equal(new URL(page.url()).searchParams.get('q'), secret); // the page did get it
  assert.ok(!t.text.includes(secret) && !t.text.includes(encodeURIComponent(secret)) && !t.text.includes('echo+me'), t.text);
  assert.match(t.json().url, /\?q=\[masked\]$/);
  assert.equal(t.json().title, 'Results for [masked]');
  await c.close();
});

test('no secret of these tests is in any tool result, PUT answer or log line; the log has id and length', () => {
  const all = [PW, OTP, 'once-only-secret', 'expiring-secret', 'alice-only-secret', 'two\nlines', 'echo me & you/100%', 'echo+me'];
  for (const text of results) for (const v of all) assert.ok(!text.includes(v), `${v} in a result: ${text}`);
  for (const line of logs) for (const v of all) assert.ok(!line.includes(v), `${v} in the log: ${line}`);
  assert.ok(logs.some((l) => /^bosun: secret s[0-9a-f]{16} of tenant alice: received, \d+ bytes$/.test(l)));
  assert.ok(logs.some((l) => /^bosun: secret s[0-9a-f]{16} of tenant alice: typed in session \S+, \d+ bytes$/.test(l)));
});
