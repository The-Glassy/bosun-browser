// Fork: the host allowlist on redirect chains and on WebSockets — the two ways a page could otherwise send the
// browser somewhere the tenant may not go. Built from the review's probes: two loopback servers, only the first one
// allowed, every check through the real MCP tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import zlib from 'zlib';
import { WebSocketServer } from 'ws';
import { allowsUrl, parseHostPattern } from '../src/allow.mjs';
import { CHROMIUM_ARGS, createEngines } from '../src/engines.mjs';
import { startBosun, connect, until, TOKEN, TOKEN_B } from './helpers.mjs';

// The server a tenant may reach: redirects (code and target are in the query), a page with a relative image, and a
// page that opens a WebSocket to ?to=.
function allowedServer(denied) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const hit = () => srv.hits.push(u.pathname);
    hit();
    if (u.pathname === '/redirect') { // -> wherever ?to= says
      res.writeHead(Number(u.searchParams.get('code') || 302), { location: u.searchParams.get('to') });
      return res.end();
    }
    if (u.pathname === '/hop1') { res.writeHead(302, { location: '/hop2', 'set-cookie': 'hop=1; Path=/' }); return res.end(); }
    if (u.pathname === '/hop2') { res.writeHead(302, { location: '/deep/landed' }); return res.end(); }
    if (u.pathname === '/deep/landed') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<html><head><title>Landed</title></head><body><p>cookie=${req.headers.cookie || 'none'}</p>`
        + '<img src="pixel.png" onload="document.title=\'img-ok\'" onerror="document.title=\'img-fail\'"></body></html>');
    }
    if (u.pathname === '/gzip') { // real servers compress; the proxy must hand the page over intact
      const gz = zlib.gzipSync(Buffer.from('<html><head><title>Gzipped</title></head><body><p>gzip ok Grüße 日本語</p></body></html>', 'utf8'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': String(gz.length) });
      return res.end(gz);
    }
    if (u.pathname === '/to-gzip') { res.writeHead(302, { location: '/gzip' }); return res.end(); }
    if (u.pathname === '/deep/pixel.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex'));
    }
    if (u.pathname === '/img-page') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<title>Img</title><img src="/redirect?to=' + encodeURIComponent(`${denied}/leaked-image?secret=shh`)
        + '" onload="document.title=\'img-ok\'" onerror="document.title=\'img-fail\'">');
    }
    if (u.pathname === '/ws') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<title>WS</title><p id="out">pending</p><script>
        const to = new URL(location.href).searchParams.get('to');
        const say = (t) => { document.getElementById('out').textContent = t; };
        const w = new WebSocket(to);
        w.onmessage = (e) => say('ws message ' + e.data);
        w.onclose = (e) => say('ws closed ' + e.code);
        w.onerror = () => say('ws error');
      </script>`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>Allowed</title><p>allowed</p>');
  });
  srv.hits = [];
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => { srv.hits.push('WEBSOCKET'); ws.send('from-allowed'); });
  return srv;
}

// The server it may not reach: it records every request and WebSocket that got through.
function deniedServer() {
  const srv = http.createServer((req, res) => { srv.hits.push(req.url); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>DENIED</title>private'); });
  srv.hits = [];
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws) => { srv.hits.push('WEBSOCKET'); ws.send('from-denied'); });
  return srv;
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const close = (srv) => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });

// Chromium's Local Network Access checks see a response this service fulfilled as coming from no address at all, so
// a page of an allowlisted tenant may not open a WebSocket to a loopback address the way this test's servers do (a
// deployment on public hosts is not affected; see docs/FORK-SECURITY-REVIEW.md). The WebSocket tests therefore use a
// browser with that check off: then nothing but the host allowlist can be what stops the denied connection.
const engineWithoutLna = () => {
  const real = createEngines().get('chromium');
  return createEngines({ overrides: { chromium: { ...real,
    launchShared: (bt, cfg) => bt.launch({ headless: cfg.headless, chromiumSandbox: cfg.chromiumSandbox, args: [...CHROMIUM_ARGS, '--disable-features=LocalNetworkAccessChecks'] }),
  } } });
};

let denied, deniedBase, allowed, base, svc, wsSvc, bothSvc, logs, origError;
before(async () => {
  denied = deniedServer();
  deniedBase = await listen(denied);
  allowed = allowedServer(deniedBase);
  base = await listen(allowed);
  const allow = { BROWSER_TENANT_ALLOW: `alice=127.0.0.1:${new URL(base).port}` };
  svc = await startBosun(allow);
  wsSvc = await startBosun(allow, { engines: engineWithoutLna() });
  // A tenant that may reach both servers, for the cross-origin case below.
  bothSvc = await startBosun({ BROWSER_TENANT_ALLOW: `alice=127.0.0.1:${new URL(base).port},127.0.0.1:${new URL(deniedBase).port}` });
  logs = [];
  origError = console.error;
  console.error = (...a) => { logs.push(a.join(' ')); };
});
after(async () => {
  console.error = origError;
  await svc.stop();
  await wsSvc.stop();
  await bothSvc.stop();
  await close(allowed);
  await close(denied);
});

const denials = () => logs.filter((l) => l.includes('blocked request to'));

test('a redirect to a host outside the allowlist is blocked before the hop is sent (301/302/303/307/308)', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const s = await c.open();
    for (const code of [301, 302, 303, 307, 308]) {
      denied.hits.length = 0;
      logs.length = 0;
      const to = `${deniedBase}/via-redirect-${code}?secret=shh`;
      const r = await c.call('navigate', { session: s, url: `${base}/redirect?code=${code}&to=${encodeURIComponent(to)}` });
      assert.equal(r.isError, true, `${code}: ${r.text}`);
      assert.deepEqual(denied.hits, [], `${code}: the hop reached the host outside the allowlist`);
      const line = await until(() => denials()[0], 5000);
      assert.equal(line, `bosun: tenant alice: blocked request to ${deniedBase}/via-redirect-${code} (host allowlist)`);
      assert.ok(!logs.some((l) => l.includes('shh')), logs.join('\n'));
      // The page never shows the denied host's content.
      assert.ok(!(await c.call('read', { session: s, mode: 'text' })).text.includes('private'));
    }
  } finally { await c.close(); }
});

test('an allowed redirect chain still works: cookies, relative URLs and the final URL', async () => {
  const c = await connect(svc, TOKEN);
  try {
    logs.length = 0;
    allowed.hits.length = 0;
    const s = await c.open();
    const r = await c.call('navigate', { session: s, url: `${base}/hop1` });
    assert.equal(r.isError, false, r.text);
    const j = r.json();
    assert.match(j.title, /^(Landed|img-ok)$/); // the image's onload renames it
    assert.equal(j.redirected_to, `${base}/deep/landed`); // the tab keeps the asked-for URL, so navigate says so
    assert.deepEqual(denied.hits, []);
    // Every hop was taken, the cookie the redirect set came back, and the relative image resolved against the
    // document's real location (the injected <base>), not against /hop1.
    assert.deepEqual(allowed.hits, ['/hop1', '/hop2', '/deep/landed', '/deep/pixel.png']);
    assert.match((await c.call('read', { session: s, mode: 'text' })).text, /cookie=hop=1/);
    const imgOk = await until(async () => {
      const t = (await c.call('read', { session: s, mode: 'text' })).text;
      return /img-ok|img-fail/.test(t) ? t : null;
    }, 5000);
    assert.match(imgOk, /img-ok/, 'the relative image did not load against the document\'s real location');
    assert.deepEqual(denials(), []);
  } finally { await c.close(); }
});

test('a subresource redirect to a denied host is blocked too', async () => {
  const c = await connect(svc, TOKEN);
  try {
    logs.length = 0;
    denied.hits.length = 0;
    const s = await c.open();
    assert.equal((await c.call('navigate', { session: s, url: `${base}/img-page` })).isError, false);
    const title = await until(async () => /img-(ok|fail)/.exec((await c.call('read', { session: s, mode: 'text' })).text)?.[0], 5000);
    assert.equal(title, 'img-fail'); // the redirected image never arrived
    assert.deepEqual(denied.hits, []);
    const line = await until(() => denials()[0], 5000);
    assert.equal(line, `bosun: tenant alice: blocked request to ${deniedBase}/leaked-image (host allowlist)`);
    assert.ok(!logs.some((l) => l.includes('shh')), logs.join('\n'));
  } finally { await c.close(); }
});

test('ws:// is allowed only where the allowlist allows it, and a denied one never reaches the server', async () => {
  const c = await connect(wsSvc, TOKEN);
  try {
    const s = await c.open();
    // Allowed: the page talks to the server.
    allowed.hits.length = 0;
    await c.call('navigate', { session: s, url: `${base}/ws?to=${encodeURIComponent(`${base.replace('http', 'ws')}/sock`)}` });
    assert.equal((await c.call('wait_for', { session: s, text: 'ws message from-allowed', timeoutMs: 10000 })).isError, false);
    assert.ok(allowed.hits.includes('WEBSOCKET'));
    // Denied: closed with 1008 before it reaches the other server, logged without the query.
    logs.length = 0;
    denied.hits.length = 0;
    const to = `${deniedBase.replace('http', 'ws')}/sock?secret=shh`;
    await c.call('navigate', { session: s, url: `${base}/ws?to=${encodeURIComponent(to)}` });
    assert.equal((await c.call('wait_for', { session: s, text: 'ws closed 1008', timeoutMs: 10000 })).isError, false);
    assert.deepEqual(denied.hits, []);
    const line = await until(() => denials()[0], 5000);
    assert.equal(line, `bosun: tenant alice: blocked request to ${deniedBase.replace('http', 'ws')}/sock (host allowlist)`);
    assert.ok(!logs.some((l) => l.includes('shh')), logs.join('\n'));
  } finally { await c.close(); }
});

test('ws and wss are matched by the same host rules, with their own default ports', () => {
  const p = [parseHostPattern('*.example.org'), parseHostPattern('127.0.0.1:4848')];
  for (const u of ['ws://a.example.org/sock', 'wss://a.example.org/sock', 'ws://a.example.org:8080/s', 'ws://127.0.0.1:4848/s']) assert.ok(allowsUrl(p, u), u);
  for (const u of ['ws://evil.test/sock', 'wss://evil.test/sock', 'ws://127.0.0.1:4849/s', 'ws://example.org/s']) assert.ok(!allowsUrl(p, u), u);
  // Default ports: ws is 80, wss is 443.
  assert.ok(allowsUrl([parseHostPattern('example.org:80')], 'ws://example.org/s'));
  assert.ok(!allowsUrl([parseHostPattern('example.org:80')], 'wss://example.org/s'));
  assert.ok(allowsUrl([parseHostPattern('example.org:443')], 'wss://example.org/s'));
});

test('a tenant without an allowlist keeps redirects and WebSockets as upstream has them', async () => {
  const c = await connect(wsSvc, TOKEN_B);
  try {
    const s = await c.open();
    denied.hits.length = 0;
    const r = await c.call('navigate', { session: s, url: `${base}/redirect?to=${encodeURIComponent(`${deniedBase}/anywhere`)}` });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().url, `${deniedBase}/anywhere`); // followed by the browser, so the tab moves with it
    assert.equal(r.json().redirected_to, undefined);
    assert.deepEqual(denied.hits, ['/anywhere']);
    await c.call('navigate', { session: s, url: `${base}/ws?to=${encodeURIComponent(`${deniedBase.replace('http', 'ws')}/sock`)}` });
    assert.equal((await c.call('wait_for', { session: s, text: 'ws message from-denied', timeoutMs: 10000 })).isError, false);
  } finally { await c.close(); }
});

test('a compressed document survives the walk, with and without a redirect', async () => {
  const c = await connect(svc, TOKEN);
  try {
    const s = await c.open();
    for (const [path, redirected] of [['/gzip', undefined], ['/to-gzip', `${base}/gzip`]]) {
      const r = await c.call('navigate', { session: s, url: `${base}${path}` });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.json().title, 'Gzipped', path);
      assert.equal(r.json().redirected_to, redirected, path);
      assert.match((await c.call('read', { session: s, mode: 'text' })).text, /gzip ok Grüße 日本語/, path);
    }
  } finally { await c.close(); }
});

// Known limitation of walking the chain in the service: the browser only ever sees the request it made, so a
// document that came from another allowed origin is served under the origin that was asked for. Two hosts inside
// one allowlist are therefore not isolated from each other across a redirect — keep allowlists to the hosts a
// tenant really needs, and prefer exact hosts over *. (docs/FORK-SECURITY-REVIEW.md, H1).
test('a redirect to another allowed origin is served under the origin that was asked for', async () => {
  const c = await connect(bothSvc, TOKEN);
  try {
    const s = await c.open();
    const r = await c.call('navigate', { session: s, url: `${base}/redirect?to=${encodeURIComponent(`${deniedBase}/other-origin`)}` });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().url, `${base}/redirect?to=${encodeURIComponent(`${deniedBase}/other-origin`)}`);
    assert.equal(r.json().redirected_to, `${deniedBase}/other-origin`); // navigate says where it really came from
    assert.match((await c.call('read', { session: s, mode: 'text' })).text, /private/); // the other origin's content
  } finally { await c.close(); }
});
