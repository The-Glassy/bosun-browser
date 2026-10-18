// Service-level guarantees over real WebSocket MCP clients and headless Chromium against a local page server:
// authentication, navigation scheme allowlist, malformed upgrades, per-connection ownership, limits, cleanup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { startBosun, startPageServer, connect, rawRequest, until, TOKEN, TOKEN_B } from './helpers.mjs';
import { WsTransport } from '../src/wsserver.mjs';

let pages, svc;
before(async () => { pages = await startPageServer(); svc = await startBosun({ MAX_SESSIONS: '3' }); });
after(async () => { await svc.stop(); await pages.close(); });

const expectHttp = (url, opts) => new Promise((resolve) => {
  const ws = new WebSocket(url, opts);
  ws.on('unexpected-response', (_r, res) => resolve(res.statusCode));
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('error', () => resolve('error'));
});

test('WebSocket upgrade requires a valid token (header or legacy query)', async () => {
  assert.equal(await expectHttp(svc.wsUrl), 401);
  assert.equal(await expectHttp(svc.wsUrl, { headers: { authorization: 'Bearer wrong-token-wrong-token' } }), 401);
  assert.equal(await expectHttp(`${svc.wsUrl}/?token=${TOKEN.slice(0, -1)}`), 401);
  assert.equal(await expectHttp(svc.wsUrl, { headers: { authorization: `Bearer ${TOKEN}` } }), 'open');
  assert.equal(await expectHttp(`${svc.wsUrl}/?token=${TOKEN}`), 'open');
});

test('browser Origins are refused unless allowed', async () => {
  assert.equal(await expectHttp(svc.wsUrl, { headers: { authorization: `Bearer ${TOKEN}` }, origin: 'https://evil.example' }), 403);
});

test('malformed upgrade request targets do not crash the service', async () => {
  for (const target of ['//[', '/%', '//[::1', '/?token=%zz']) {
    const res = await rawRequest(svc.ws.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    assert.match(res, /^HTTP\/1\.1 (400|401)/, target);
    const live = await rawRequest(svc.live.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    assert.match(live, /^HTTP\/1\.1 (400|404)/, target);
  }
  // A garbage frame on an authenticated socket only closes that socket.
  const ws = new WebSocket(svc.wsUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
  await new Promise((r) => ws.on('open', r));
  ws._socket.write(Buffer.from([0x8f, 0x80, 0, 0, 0, 0])); // reserved opcode, masked, empty
  await new Promise((r) => ws.on('close', r));
  const c = await connect(svc);
  assert.equal((await c.call('sessions')).isError, false);
  await c.close();
});

test('navigate allows only http(s)', async () => {
  const c = await connect(svc);
  const s = await c.open();
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome://version', 'about:blank', 'view-source:http://example.com', 'ftp://example.com/']) {
    const r = await c.call('navigate', { session: s, url });
    assert.equal(r.isError, true, url);
  }
  const r = await c.call('navigate', { session: s, url: `${pages.base}/` });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json().title, 'Home');
  await c.call('session_close', { session: s });
  await c.close();
});

test('sessions belong to the connection that opened them', async () => {
  const a = await connect(svc, TOKEN);
  const b = await connect(svc, TOKEN); // same tenant, different connection
  const other = await connect(svc, TOKEN_B);
  const s = await a.open();
  await a.call('navigate', { session: s, url: `${pages.base}/` });
  for (const c of [b, other]) {
    assert.deepEqual((await c.call('sessions')).json(), []);
    for (const [tool, args] of [['read', {}], ['navigate', { url: `${pages.base}/second` }], ['click', { text: 'next' }], ['screenshot', {}], ['request_human', { reason: 'x' }], ['handoff_wait', {}], ['session_close', {}]]) {
      const r = await c.call(tool, { session: s, ...args });
      assert.equal(r.isError, true, tool);
      assert.match(r.text, new RegExp(`no session ${s}`), tool);
    }
  }
  const mine = (await a.call('sessions')).json();
  assert.equal(mine.length, 1);
  assert.equal(mine[0].url, `${pages.base}/`);
  await a.call('session_close', { session: s });
  await Promise.all([a.close(), b.close(), other.close()]);
});

test('persistent profiles are namespaced per tenant and locked while open', async () => {
  const a = await connect(svc, TOKEN);
  const b = await connect(svc, TOKEN_B);
  const s1 = await a.open({ profile: 'work' });
  const busy = await a.call('session_open', { profile: 'work' });
  assert.equal(busy.isError, true);
  assert.match(busy.text, /already open/);
  const s2 = await b.open({ profile: 'work' }); // bob's "work" is a different directory
  assert.ok(fs.existsSync(path.join(svc.dataDir, 'profiles', 'alice', 'work')));
  assert.ok(fs.existsSync(path.join(svc.dataDir, 'profiles', 'bob', 'work')));
  assert.equal((await a.call('session_open', { profile: '../bob' })).isError, true);
  await a.call('session_close', { session: s1 });
  await b.call('session_close', { session: s2 });
  const again = await a.open({ profile: 'work' }); // lock released after close
  await a.call('session_close', { session: again });
  await Promise.all([a.close(), b.close()]);
});

test('session cap holds under concurrent opens and the browser launches once', async () => {
  const s2 = await startBosun({ MAX_SESSIONS: '2' });
  try {
    const c = await connect(s2);
    const res = await Promise.all(Array.from({ length: 6 }, () => c.call('session_open', {})));
    assert.equal(res.filter((r) => !r.isError).length, 2);
    assert.equal(res.filter((r) => r.isError && /session limit 2/.test(r.text)).length, 4);
    assert.equal(s2.manager.launches, 1);
    assert.equal(s2.manager.used, 2);
    await c.close();
    await until(() => s2.manager.used === 0);
  } finally {
    await s2.stop();
  }
});

test('disconnecting closes the connection\'s sessions (lease) and frees capacity', async () => {
  const c = await connect(svc);
  await c.open();
  await c.open();
  const before = svc.manager.used;
  await c.close();
  await until(() => svc.manager.used === before - 2);
});

test('idle sessions are reaped', async () => {
  const s2 = await startBosun({ IDLE_TIMEOUT_SEC: '1' });
  try {
    const c = await connect(s2);
    const id = await c.open();
    await until(() => s2.manager.sessions.size === 0, 5000);
    const r = await c.call('read', { session: id });
    assert.match(r.text, /no session/);
    await c.close();
  } finally {
    await s2.stop();
  }
});

test('browser crash: sessions are dropped and the next open relaunches', async () => {
  const s2 = await startBosun();
  try {
    const c = await connect(s2);
    const id = await c.open();
    const browser = await s2.manager.browserP;
    await browser.close(); // same 'disconnected' path as a crash
    await until(() => s2.manager.sessions.size === 0);
    await until(() => s2.manager.used === 0);
    assert.match((await c.call('read', { session: id })).text, /no session/);
    const id2 = await c.open();
    assert.equal(s2.manager.launches, 2);
    assert.equal((await c.call('navigate', { session: id2, url: `${pages.base}/` })).isError, false);
    // A closed main page ends its session too.
    await s2.manager.sessions.get(id2).page.close();
    await until(() => s2.manager.sessions.size === 0);
    await c.close();
  } finally {
    await s2.stop();
  }
});

test('page-opened popups are capped per session', async () => {
  const s2 = await startBosun({ MAX_PAGES_PER_SESSION: '3' });
  try {
    const c = await connect(s2);
    const id = await c.open();
    await c.call('navigate', { session: id, url: `${pages.base}/popups` });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(s2.manager.sessions.get(id).ctx.pages().length <= 3);
    await c.close();
  } finally {
    await s2.stop();
  }
});

test('screenshots are not kept by default; with SAVE_SHOTS they are capped and removed on close', async () => {
  const c = await connect(svc);
  const id = await c.open();
  await c.call('navigate', { session: id, url: `${pages.base}/` });
  const r = await c.call('screenshot', { session: id });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.content[0].type, 'image');
  assert.match(r.text, /not saved/);
  assert.ok(!fs.existsSync(path.join(svc.dataDir, 'shots')) || fs.readdirSync(path.join(svc.dataDir, 'shots'), { recursive: true }).filter((f) => f.endsWith('.jpg')).length === 0);
  await c.call('session_close', { session: id });
  await c.close();

  const s2 = await startBosun({ SAVE_SHOTS: '1', SHOTS_PER_SESSION: '2' });
  try {
    const c2 = await connect(s2);
    const id2 = await c2.open();
    await c2.call('navigate', { session: id2, url: `${pages.base}/` });
    const files = [];
    for (let i = 0; i < 4; i++) files.push((await c2.call('screenshot', { session: id2 })).text);
    const dir = path.join(s2.dataDir, 'shots', 'alice', id2);
    assert.equal(path.dirname(files[3]), dir);
    assert.equal(fs.readdirSync(dir).length, 2);
    assert.equal(fs.statSync(files[3]).mode & 0o777, 0o600);
    const full = await c2.call('screenshot', { session: id2, fullPage: true });
    assert.equal(full.isError, false, full.text);
    await c2.call('session_close', { session: id2 });
    assert.ok(!fs.existsSync(dir));
    await c2.close();
  } finally {
    await s2.stop();
  }
});

test('argument bounds are enforced', async () => {
  const c = await connect(svc);
  const id = await c.open();
  await c.call('navigate', { session: id, url: `${pages.base}/` });
  assert.equal((await c.call('read', { session: id, maxChars: -1 })).isError, true);
  assert.equal((await c.call('read', { session: id, maxChars: 10_000_000 })).isError, true);
  assert.equal((await c.call('wait_for', { session: id, text: 'x', timeoutMs: 3_600_000 })).isError, true);
  assert.equal((await c.call('request_human', { session: id, reason: 'x'.repeat(301) })).isError, true);
  const r = await c.call('read', { session: id, mode: 'text', maxChars: 5 });
  assert.match(r.text, /truncated to 5/);
  assert.ok(r.text.endsWith('\n\nHello'));
  await c.call('session_close', { session: id });
  await c.close();
});

test('per-connection in-flight cap', async () => {
  const s2 = await startBosun({ MAX_INFLIGHT: '2' });
  try {
    const c = await connect(s2);
    const id = await c.open();
    await c.call('navigate', { session: id, url: `${pages.base}/` });
    const res = await Promise.all(Array.from({ length: 5 }, () => c.call('wait_for', { session: id, selector: '#never', timeoutMs: 400 })));
    assert.equal(res.filter((r) => /too many concurrent requests/.test(r.text)).length, 3);
    await c.close();
  } finally {
    await s2.stop();
  }
});

test('transport send rejects on a closed socket and close fires once', async () => {
  const fake = new (await import('events')).EventEmitter();
  fake.readyState = WebSocket.CLOSED;
  fake.close = () => {};
  const t = new WsTransport(fake);
  let closes = 0;
  t.onclose = () => closes++;
  await assert.rejects(t.send({ jsonrpc: '2.0', id: 1, result: {} }), /not open/);
  fake.emit('close');
  await t.close();
  assert.equal(closes, 1);
});

test('shutdown is idempotent and closes everything', async () => {
  const s2 = await startBosun();
  const c = await connect(s2);
  await c.open();
  const p1 = s2.shutdown();
  const p2 = s2.shutdown();
  assert.equal(p1, p2);
  await p1;
  assert.equal(s2.manager.sessions.size, 0);
  assert.equal(s2.manager.used, 0);
  assert.match((await c.call('session_open', {})).text, /./);
  await s2.stop();
});

test('a disconnect while session_open is still launching does not leak the session', async () => {
  const s2 = await startBosun();
  try {
    const c = await connect(s2);
    c.callTool({ name: 'session_open', arguments: {} }).catch(() => {});
    await until(() => s2.manager.used === 1, 2000, 1);
    await c.close();
    await until(() => s2.manager.pendingOpens.size === 0);
    await until(() => s2.manager.used === 0);
    assert.equal(s2.manager.sessions.size, 0);
    assert.equal(s2.manager.goneOwners.size, 0);
  } finally {
    await s2.stop();
  }
});

test('shutdown waits for disposals already in progress', async () => {
  const s2 = await startBosun();
  const c = await connect(s2);
  const id = await c.open();
  const s = s2.manager.sessions.get(id);
  const realClose = s.ctx.close.bind(s.ctx);
  let closed = false;
  s.ctx.close = async () => { await new Promise((r) => setTimeout(r, 500)); await realClose(); closed = true; };
  s2.manager.dispose(s, 'closed');
  await s2.shutdown();
  assert.equal(closed, true);
  assert.equal(s2.manager.used, 0);
  await s2.stop();
});

test('a screenshot finishing after its session closed is not kept', async () => {
  const s2 = await startBosun({ SAVE_SHOTS: '1' });
  try {
    const c = await connect(s2);
    const id = await c.open();
    const s = s2.manager.sessions.get(id);
    const save = s2.manager.saveShot(s, Buffer.from('jpeg'));
    const disp = s2.manager.dispose(s, 'closed');
    await assert.rejects(save, /was closed/);
    await disp;
    assert.ok(!fs.existsSync(path.join(s2.dataDir, 'shots', 'alice', id)));
    await c.close();
  } finally {
    await s2.stop();
  }
});

test('DOM-size guard counts shadow roots too', async () => {
  const s2 = await startBosun({ MAX_DOM_NODES: '100' });
  try {
    const c = await connect(s2);
    const id = await c.open();
    await c.call('navigate', { session: id, url: `${pages.base}/bigshadow` });
    assert.match((await c.call('read', { session: id })).text, /more than 100 elements/);
    assert.equal((await c.call('read', { session: id, selector: 'body' })).isError, false);
    await c.close();
  } finally {
    await s2.stop();
  }
});

test('transport disconnects clients that keep too many requests open or stop reading', async () => {
  const { EventEmitter } = await import('events');
  const mk = () => { const w = new EventEmitter(); w.readyState = WebSocket.OPEN; w.bufferedAmount = 0; w.terminated = 0; w.terminate = () => { w.terminated++; }; w.send = (_d, cb) => cb(); return w; };
  const w1 = mk();
  const t1 = new WsTransport(w1, { maxOpenRequests: 3 });
  let got = 0;
  t1.onmessage = () => got++;
  for (let i = 0; i < 5; i++) w1.emit('message', JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' }));
  assert.equal(got, 3);
  assert.ok(w1.terminated >= 1);
  const w2 = mk();
  const t2 = new WsTransport(w2, { maxOpenRequests: 3 });
  t2.onmessage = () => {};
  for (let i = 0; i < 10; i++) { w2.emit('message', JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/list' })); await t2.send({ jsonrpc: '2.0', id: i, result: {} }); }
  assert.equal(w2.terminated, 0); // answered requests don't count
  w2.bufferedAmount = 9 * 1024 * 1024;
  await assert.rejects(t2.send({ jsonrpc: '2.0', id: 99, result: {} }), /not reading/);
  assert.equal(w2.terminated, 1);
});
