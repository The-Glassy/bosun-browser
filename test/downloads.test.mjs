// Downloads a page starts. Off for every tenant unless BROWSER_TENANT_DOWNLOAD_ALLOW names it; a named tenant keeps
// downloads whose URL host, or whose page's top-level origin, is on its list (blob: and data: by the page), streamed
// by the browser into the data volume, cancelled past DOWNLOAD_MAX_BYTES or the tenant's quota, fetched once over a
// GET on the MCP port (or inline), and gone after that, after DOWNLOAD_TTL_SEC, or on a restart. Driven through the
// real MCP tools against two local servers: A (allowed) and B (not allowed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { z } from 'zod';
import { loadConfig } from '../src/config.mjs';
import { DOWNLOAD, DOWNLOAD_SET } from '../src/events.mjs';
import { startBosun, connect, until, sleep, tmpDir, TOKEN, TOKEN_B } from './helpers.mjs';

const TOKEN_E = 'test-token-eeeeeeeeeeeeeeee';
const MB = 1024 * 1024;
const TEXT = 'WEBVTT\n\n00:00.000 --> 00:01.000\nHallo, Glassy — ünïcødé\n';

// What each server sent of /big, and whether the client went away before the end.
const big = { sent: 0, aborted: false, done: false };

function server() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = (k, d) => u.searchParams.get(k) ?? d;
    const html = (body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    if (u.pathname === '/dl') {
      const kb = Number(q('kb', 0));
      const body = kb ? Buffer.alloc(kb * 1024, 0x61) : Buffer.from(TEXT);
      res.writeHead(200, { 'content-type': q('type', 'text/vtt'), 'content-disposition': `attachment; filename="${q('name', 'transcript.vtt')}"`, 'content-length': String(body.length) });
      return res.end(body);
    }
    if (u.pathname === '/bin') { // binary (NUL bytes): never inline
      const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 1, 2, 3]);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="export.docx"', 'content-length': String(body.length) });
      return res.end(body);
    }
    if (u.pathname === '/big') { // streams mb MiB in 256 KiB chunks, about 25 MB/s
      const total = Number(q('mb', 64)) * MB;
      Object.assign(big, { sent: 0, aborted: false, done: false });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="big.bin"', 'content-length': String(total) });
      const chunk = Buffer.alloc(256 * 1024, 0x62);
      const t = setInterval(() => {
        if (res.destroyed) { clearInterval(t); big.aborted = true; return; }
        res.write(chunk);
        big.sent += chunk.length;
        if (big.sent >= total) { clearInterval(t); big.done = true; res.end(); }
      }, 10);
      res.on('close', () => { if (!big.done) big.aborted = true; clearInterval(t); });
      return;
    }
    if (u.pathname === '/page') return html(`<title>Page</title><a id="go" href="${q('to', '/dl')}">go</a>`);
    if (u.pathname === '/blob') {
      return html(`<title>Blob</title><button id="go">export</button><script>document.getElementById('go').onclick = () => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['hello blob'], { type: 'text/plain' })); a.download = 'notes.txt'; a.click(); };</script>`);
    }
    if (u.pathname === '/data') return html('<title>Data</title><a id="go" download="d.txt" href="data:text/plain;charset=utf-8,hello%20data">data</a>');
    if (u.pathname === '/popup') return html(`<title>Popup</title><button id="go" onclick="window.open('${q('to', '/dl')}')">open</button>`);
    res.writeHead(404);
    res.end();
  });
}

let A, B, a, b, logs, origError;
before(async () => {
  for (const which of ['A', 'B']) {
    const srv = server();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const s = { srv, base: `http://127.0.0.1:${srv.address().port}`, host: `127.0.0.1:${srv.address().port}` };
    if (which === 'A') A = s; else B = s;
  }
  a = A.base; b = B.base;
  logs = [];
  origError = console.error;
  console.error = (...x) => { logs.push(x.join(' ')); };
});
after(async () => {
  console.error = origError;
  for (const s of [A, B]) await new Promise((r) => { s.srv.closeAllConnections(); s.srv.close(() => r()); });
});

// alice may keep downloads from server A; bob too (for the cross-tenant checks); swarm is read-only.
const start = (env = {}) => startBosun({
  BROWSER_TOKENS: `alice:${TOKEN},bob:${TOKEN_B},swarm:${TOKEN_E}`, BROWSER_TOKEN_POLICIES: 'swarm=ephemeral',
  BROWSER_TENANT_DOWNLOAD_ALLOW: `alice=${A.host}; bob=${A.host}`, ...env,
});

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => {
    const parts = [];
    res.on('data', (d) => parts.push(d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', reject);
});

async function openAt(c, url) {
  const id = await c.open();
  const r = await c.call('navigate', { session: id, url });
  assert.equal(r.isError, false, r.text);
  return id;
}
async function clickGo(c, id) {
  const r = await c.call('click', { session: id, selector: '#go' });
  assert.equal(r.isError, false, r.text);
  return r.json();
}
const files = (dir) => { try { return fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()); } catch { return []; } };

test('config: off by default, per-tenant host patterns, limits, and the old switches refused', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.downloadAllow.size, 0);
  assert.equal(cfg.downloadMaxBytes, 300 * MB);
  assert.equal(cfg.downloadQuotaBytes, 1024 * MB);
  assert.equal(cfg.downloadTtlMs, 3600_000);
  assert.equal(cfg.downloadUrlTtlMs, 900_000);
  const tokens = { BROWSER_TOKENS: `glassy:${TOKEN},swarm:${TOKEN_E}` };
  const g = loadConfig({ ...tokens, BROWSER_TENANT_DOWNLOAD_ALLOW: 'glassy=web.plaud.ai,*.plaud.ai' }).downloadAllow.get('glassy');
  assert.deepEqual(g.map((p) => [p.host, p.wild]), [['web.plaud.ai', false], ['plaud.ai', true]]);
  assert.throws(() => loadConfig({ ...tokens, BROWSER_TENANT_DOWNLOAD_ALLOW: 'nobody=x.org' }), /BROWSER_TENANT_DOWNLOAD_ALLOW names tenant "nobody", which has no token/);
  assert.throws(() => loadConfig({ ...tokens, BROWSER_TENANT_DOWNLOAD_ALLOW: 'glassy=' }), /names no host; remove the entry to keep downloads off/);
  assert.throws(() => loadConfig({ ...tokens, BROWSER_TOKEN_POLICIES: 'swarm=ephemeral', BROWSER_TENANT_DOWNLOAD_ALLOW: 'swarm=x.org' }), /policy is ephemeral/);
  assert.throws(() => loadConfig({ ...tokens, BROWSER_TENANT_DOWNLOAD_ALLOW: 'glassy=http://x.org/' }), /BROWSER_TENANT_DOWNLOAD_ALLOW, tenant "glassy"/);
  assert.equal(loadConfig({ DOWNLOADS: '0' }).downloadAllow.size, 0);
  assert.throws(() => loadConfig({ DOWNLOADS: '1' }), /DOWNLOADS=1 was replaced in 0\.11 by BROWSER_TENANT_DOWNLOAD_ALLOW/);
  assert.throws(() => loadConfig({ DOWNLOADS: 'yes' }), /DOWNLOADS must be 0 or 1/);
  assert.throws(() => loadConfig({ DOWNLOADS_MAX_MB: '100' }), /DOWNLOADS_MAX_MB was replaced in 0\.11 by DOWNLOAD_MAX_BYTES/);
  assert.throws(() => loadConfig({ DOWNLOADS_TOTAL_MAX_MB: '500' }), /DOWNLOADS_TOTAL_MAX_MB was replaced/);
  assert.equal(loadConfig({ DOWNLOAD_MAX_BYTES: String(2048 * MB) }).downloadQuotaBytes, 2048 * MB); // never below the per-file cap
  assert.throws(() => loadConfig({ DOWNLOAD_MAX_BYTES: '10', DOWNLOAD_TENANT_QUOTA_BYTES: '5' }), /DOWNLOAD_TENANT_QUOTA_BYTES must be between 10/);
});

test('a tenant that is not named cannot download at all, and has no download tools', async () => {
  const svc = await start({ BROWSER_TENANT_DOWNLOAD_ALLOW: `alice=${A.host}` });
  try {
    const c = await connect(svc, TOKEN_B);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ['download_wait', 'downloads', 'download_get']) assert.ok(!names.includes(n), n);
    const id = await openAt(c, `${a}/page?to=/dl`);
    const s = svc.manager.sessions.get(id);
    assert.equal(s.dlDir, null);
    const wait = s.page.waitForEvent('download', { timeout: 15000 });
    const r = await clickGo(c, id);
    assert.match(String(await (await wait).failure()), /acceptDownloads/); // the context refused it
    // ...and click says why.
    assert.deepEqual(r.downloads.map((x) => [x.state, x.reason]), [['refused', 'downloads are off for this token (it is not in BROWSER_TENANT_DOWNLOAD_ALLOW)']]);
    assert.deepEqual(files(path.join(svc.dataDir, 'downloads')), []);
    // alice (named) has them.
    const al = await connect(svc, TOKEN);
    const an = (await al.listTools()).tools.map((t) => t.name);
    for (const n of ['download_wait', 'downloads', 'download_get']) assert.ok(an.includes(n), n);
    await Promise.all([c.close(), al.close()]);
  } finally { await svc.stop(); }
});

test('allowed host: click reports it, download_get gives a one-time GET URL, and the file is gone once fetched', async () => {
  const svc = await start();
  try {
    const c = await connect(svc, TOKEN);
    const id = await openAt(c, `${a}/page?to=${encodeURIComponent('/dl?secret=shh')}`);
    const r = await clickGo(c, id);
    assert.equal(r.downloads.length, 1, JSON.stringify(r));
    const d = r.downloads[0];
    assert.equal(d.state, 'ready');
    assert.match(d.download_id, /^d[0-9a-f]{16}$/);
    assert.equal(d.filename, 'transcript.vtt');
    assert.equal(d.size, Buffer.byteLength(TEXT));
    assert.equal(d.mime, 'text/vtt');
    assert.equal(d.source_host, A.host);
    assert.equal(d.page_host, A.host);
    assert.equal(d.allowed_by, 'download host');
    // On the data volume, under the tenant, 0600; the browser's own directory is left empty.
    const f = svc.downloads.files.get(d.download_id);
    assert.equal(f.file, path.join(svc.dataDir, 'downloads', 'alice', d.download_id, 'transcript.vtt'));
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.deepEqual(files(svc.manager.sessions.get(id).dlDir), []);
    // click already reported it: download_wait has nothing more.
    assert.equal((await c.call('download_wait', { session: id, timeoutMs: 300 })).json().state, 'none');
    assert.deepEqual((await c.call('downloads', {})).json().map((x) => x.download_id), [d.download_id]);
    const g = (await c.call('download_get', { download_id: d.download_id })).json();
    assert.match(g.get_url, new RegExp(`^http://127\\.0\\.0\\.1:${svc.ws.port}/download/${d.download_id}\\?t=`));
    assert.equal(g.curl, `curl -sS --fail-with-body -o 'transcript.vtt' '${g.get_url}'`);
    assert.equal(g.valid_min, 15);
    const res = await get(g.get_url);
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), TEXT);
    assert.equal(res.headers['content-type'], 'text/vtt');
    assert.equal(res.headers['content-disposition'], `attachment; filename="transcript.vtt"; filename*=UTF-8''transcript.vtt`);
    await until(() => !fs.existsSync(f.dir), 15_000); // deleted once the response has closed (slow under load)
    assert.equal((await get(g.get_url)).status, 404); // once
    assert.match((await c.call('download_get', { download_id: d.download_id })).text, /no download d[0-9a-f]{16}/);
    assert.deepEqual((await c.call('downloads', {})).json(), []);
    assert.ok(!logs.some((l) => l.includes('shh')), 'the query is never logged');
    await c.close();
  } finally { await svc.stop(); }
});

test('the decision: download host or top-level page origin; anything else is cancelled with the reason', async () => {
  const svc = await start();
  try {
    logs.length = 0;
    const c = await connect(svc, TOKEN);
    // Page on A (allowed), file from B: kept because of the page.
    let id = await openAt(c, `${a}/page?to=${encodeURIComponent(`${b}/dl?name=from-b.txt&type=text/plain`)}`);
    let d = (await clickGo(c, id)).downloads[0];
    assert.equal(d.state, 'ready', JSON.stringify(d));
    assert.equal(d.source_host, B.host);
    assert.equal(d.allowed_by, 'page origin');
    // Page on B, file from A: kept because of the host.
    id = await openAt(c, `${b}/page?to=${encodeURIComponent(`${a}/dl?name=from-a.txt`)}`);
    d = (await clickGo(c, id)).downloads[0];
    assert.equal(d.state, 'ready');
    assert.equal(d.allowed_by, 'download host');
    // Page on B, file from B: refused, nothing kept.
    const s = svc.manager.sessions.get(await openAt(c, `${b}/page?to=${encodeURIComponent('/dl?name=nope.txt&secret=shh')}`));
    d = (await clickGo(c, s.id)).downloads[0];
    assert.equal(d.state, 'refused');
    assert.equal(d.filename, 'nope.txt');
    assert.match(d.reason, new RegExp(`^${B.host.replace(/\./g, '\\.')} from page ${B.host.replace(/\./g, '\\.')}: neither is in the download allowlist of this token \\(BROWSER_TENANT_DOWNLOAD_ALLOW\\)$`));
    assert.match((await c.call('download_get', { download_id: d.download_id })).text, /was refused: .*download allowlist/);
    await sleep(500);
    assert.deepEqual(files(s.dlDir), []);
    assert.equal(svc.downloads.used('alice'), 2 * Buffer.byteLength(TEXT));
    assert.ok(logs.some((l) => l === `bosun: tenant alice: refused download from ${B.host}: ${d.reason}`), logs.join('\n'));
    assert.ok(!logs.some((l) => l.includes('shh')));
    // downloads lists all three, the refused one with its reason.
    assert.deepEqual((await c.call('downloads', {})).json().map((x) => x.state), ['ready', 'ready', 'refused']);
    assert.deepEqual((await c.call('downloads', { session: s.id })).json().map((x) => x.filename), ['nope.txt']);
    await c.close();
  } finally { await svc.stop(); }
});

test('blob: and data: downloads count by their page; a popup by its opener; navigate to a download URL reports it', async () => {
  const svc = await start();
  try {
    const c = await connect(svc, TOKEN);
    const done = async (id) => c.call('session_close', { session: id }); // MAX_SESSIONS is 4 in the tests
    let id = await openAt(c, `${a}/blob`);
    let d = (await clickGo(c, id)).downloads[0];
    assert.equal(d.state, 'ready', JSON.stringify(d));
    assert.equal(d.filename, 'notes.txt');
    assert.equal(d.source_host, `blob from ${A.host}`);
    assert.equal(d.allowed_by, 'page origin');
    assert.deepEqual((await c.call('download_get', { download_id: d.download_id, inline: true })).json().content, 'hello blob');
    await done(id);
    id = await openAt(c, `${b}/blob`);
    d = (await clickGo(c, id)).downloads[0];
    assert.equal(d.state, 'refused');
    assert.match(d.reason, new RegExp(`^a blob: download from page ${B.host.replace(/\./g, '\\.')}: neither`));
    await done(id);
    id = await openAt(c, `${a}/data`);
    d = (await clickGo(c, id)).downloads[0];
    assert.equal(d.state, 'ready', JSON.stringify(d));
    assert.equal(d.source_host, 'data');
    assert.equal((await c.call('download_get', { download_id: d.download_id, inline: true })).json().content, 'hello data');
    await done(id);
    // window.open of a file on B from a page on A: the popup has no page of its own, its opener decides.
    const pop = await openAt(c, `${a}/popup?to=${encodeURIComponent(`${b}/dl?name=popup.txt`)}`);
    await c.call('click', { session: pop, selector: '#go' });
    d = (await c.call('download_wait', { session: pop, timeoutMs: 15000 })).json();
    if (d.state === 'none') d = (await c.call('downloads', { session: pop })).json()[0]; // click already reported it
    assert.equal(d.state, 'ready', JSON.stringify(d));
    assert.equal(d.page_host, A.host);
    await done(pop);
    // navigate straight to a download: the page stays, the download is the answer.
    const nav = await openAt(c, `${a}/page`);
    const r = (await c.call('navigate', { session: nav, url: `${a}/dl?name=direct.txt` }));
    assert.equal(r.isError, false, r.text);
    const dl = r.json().downloads;
    assert.ok(dl, r.text);
    assert.equal(dl[0].filename, 'direct.txt');
    await c.close();
  } finally { await svc.stop(); }
});

test('too big: cancelled while it streams, nothing kept, the disk never holds much more than the limit', async () => {
  const svc = await start({ DOWNLOAD_MAX_BYTES: String(2 * MB) });
  try {
    const c = await connect(svc, TOKEN);
    const id = await openAt(c, `${a}/page?to=/big?mb=64`);
    const dir = svc.manager.sessions.get(id).dlDir;
    let maxSeen = 0, watching = true;
    const watcher = (async () => {
      while (watching) {
        for (const f of files(dir)) { try { maxSeen = Math.max(maxSeen, fs.statSync(path.join(dir, f)).size); } catch {} }
        await sleep(20);
      }
    })();
    const rss0 = process.memoryUsage().rss;
    const r = await clickGo(c, id);
    let d = r.downloads[0];
    if (d.state === 'downloading') d = (await c.call('download_wait', { session: id, timeoutMs: 20000 })).json();
    watching = false;
    await watcher;
    assert.equal(d.state, 'refused', JSON.stringify(d));
    assert.match(d.reason, /larger than the download limit \(2 MB, DOWNLOAD_MAX_BYTES\)/);
    await until(() => big.aborted, 10000);
    assert.ok(big.sent < 40 * MB, `server sent ${big.sent}`); // cut off mid-stream
    assert.ok(maxSeen < 2 * MB + 16 * MB, `disk held ${maxSeen}`);
    await until(() => files(dir).length === 0, 5000);
    assert.equal(svc.downloads.used('alice'), 0);
    assert.ok(process.memoryUsage().rss - rss0 < 64 * MB, 'the service did not hold the bytes');
    await c.close();
  } finally { await svc.stop(); }
});

test('quota: a download past the tenant quota is refused; fetching one frees the room', async () => {
  const svc = await start({ DOWNLOAD_MAX_BYTES: String(1 * MB), DOWNLOAD_TENANT_QUOTA_BYTES: String(1.5 * MB) });
  try {
    const c = await connect(svc, TOKEN);
    const id = await openAt(c, `${a}/page?to=/dl?kb=800%26name=one.bin`);
    const first = (await clickGo(c, id)).downloads[0];
    assert.equal(first.state, 'ready');
    const second = (await clickGo(c, id)).downloads[0];
    assert.equal(second.state, 'refused');
    assert.match(second.reason, /download quota of this token used up \(2 MB, DOWNLOAD_TENANT_QUOTA_BYTES/);
    assert.equal(svc.downloads.used('alice'), 800 * 1024);
    // bob has his own quota.
    const cb = await connect(svc, TOKEN_B);
    assert.equal((await clickGo(cb, await openAt(cb, `${a}/page?to=/dl?kb=800`))).downloads[0].state, 'ready');
    const g = (await c.call('download_get', { download_id: first.download_id })).json();
    assert.equal((await get(g.get_url)).body.length, 800 * 1024);
    await until(() => svc.downloads.used('alice') === 0);
    assert.equal((await clickGo(c, id)).downloads[0].state, 'ready');
    await Promise.all([c.close(), cb.close()]);
  } finally { await svc.stop(); }
});

test("downloads never cross tenants: another tenant's id and GET header are refused; Bearer works without ?t=", async () => {
  const svc = await start();
  try {
    const c = await connect(svc, TOKEN), cb = await connect(svc, TOKEN_B);
    const d = (await clickGo(c, await openAt(c, `${a}/page?to=/dl`))).downloads[0];
    assert.match((await cb.call('download_get', { download_id: d.download_id })).text, /no download/);
    assert.deepEqual((await cb.call('downloads', {})).json(), []);
    const g = (await c.call('download_get', { download_id: d.download_id })).json();
    const bare = g.get_url.replace(/\?t=.*/, '');
    assert.equal((await get(bare)).status, 401);
    assert.equal((await get(g.get_url, { authorization: `Bearer ${TOKEN_B}` })).status, 403);
    assert.equal((await get(bare, { authorization: `Bearer ${TOKEN_B}` })).status, 403);
    assert.equal((await get(`${g.get_url}x`)).status, 404); // wrong secret
    assert.equal((await get(`http://127.0.0.1:${svc.ws.port}/download/d0000000000000000`, { authorization: `Bearer ${TOKEN}` })).status, 404); // no such id
    assert.equal((await get(`http://127.0.0.1:${svc.ws.port}/download/dzzzz`)).status, 401);
    const own = await get(bare, { authorization: `Bearer ${TOKEN}` });
    assert.equal(own.status, 200);
    assert.equal(own.body.toString(), TEXT);
    assert.equal((await get(g.get_url)).status, 404); // fetched, so gone for the URL too
    await Promise.all([c.close(), cb.close()]);
  } finally { await svc.stop(); }
});

test('inline: UTF-8 text up to 256 KB comes back in the result; anything else gets the URL', async () => {
  const svc = await start();
  try {
    const c = await connect(svc, TOKEN);
    const id = await openAt(c, `${a}/page?to=/dl`);
    const d = (await clickGo(c, id)).downloads[0];
    const r = (await c.call('download_get', { download_id: d.download_id, inline: true })).json();
    assert.equal(r.inline, true);
    assert.equal(r.content, TEXT);
    assert.match((await c.call('download_get', { download_id: d.download_id })).text, /no download/); // fetched
    await c.call('navigate', { session: id, url: `${a}/page?to=/bin` });
    const bin = (await clickGo(c, id)).downloads[0];
    assert.equal(bin.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const rb = (await c.call('download_get', { download_id: bin.download_id, inline: true })).json();
    assert.equal(rb.inline, false);
    assert.match(rb.inline_note, /only UTF-8 text up to 256 KB/);
    assert.equal((await get(rb.get_url)).body.length, 10);
    await c.call('navigate', { session: id, url: `${a}/page?to=/dl?kb=300` });
    const large = (await clickGo(c, id)).downloads[0];
    assert.equal((await c.call('download_get', { download_id: large.download_id, inline: true })).json().inline, false);
    await c.close();
  } finally { await svc.stop(); }
});

test('expiry and cleanup: kept past its session, gone after DOWNLOAD_TTL_SEC, URLs expire, all wiped on start', async () => {
  const dataDir = tmpDir();
  fs.mkdirSync(path.join(dataDir, 'downloads', 'alice', 'dold'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'downloads', 'alice', 'dold', 'left.txt'), 'from an earlier process');
  const svc = await start({ BROWSER_DATA: dataDir });
  try {
    assert.deepEqual(files(path.join(dataDir, 'downloads')), []);
    const c = await connect(svc, TOKEN);
    const id = await openAt(c, `${a}/page?to=/dl`);
    const dir = svc.manager.sessions.get(id).dlDir;
    const d = (await clickGo(c, id)).downloads[0];
    await c.call('session_close', { session: id });
    assert.ok(!fs.existsSync(dir), 'the session download directory goes with it');
    const f = svc.downloads.files.get(d.download_id);
    assert.ok(fs.existsSync(f.file), 'a finished download outlives its session');
    const g = (await c.call('download_get', { download_id: d.download_id })).json();
    svc.downloads.sweep(Date.now() + 15 * 60_000 + 1000);
    assert.equal((await get(g.get_url)).status, 404, 'the URL expired');
    assert.ok(fs.existsSync(f.file));
    svc.downloads.sweep(Date.now() + 3600_000 + 1000);
    await until(() => !fs.existsSync(f.dir));
    assert.match((await c.call('download_get', { download_id: d.download_id })).text, /no download/);
    await c.close();
  } finally { await svc.stop(); }
  assert.ok(!fs.existsSync(path.join(dataDir, 'downloads')), 'shutdown removes them all');
});

test('read-only (ephemeral) tokens never download', async () => {
  const svc = await start();
  try {
    const c = await connect(svc, TOKEN_E);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith('download')), names.join());
    assert.match((await c.call('download_get', { download_id: 'd0000000000000000' })).text, /not allowed for this token|not found/i);
    const id = await openAt(c, `${a}/page?to=/dl`);
    const s = svc.manager.sessions.get(id);
    assert.equal(s.dlDir, null);
    const wait = s.page.waitForEvent('download', { timeout: 15000 });
    await clickGo(c, id);
    assert.match(String(await (await wait).failure()), /acceptDownloads/);
    assert.equal(svc.downloads.allowFor('swarm'), null);
    await c.close();
  } finally { await svc.stop(); }
});

test('bosun:download is pushed to an MCPL host when a download finishes or is refused', async () => {
  const svc = await start();
  try {
    const c = await connect(svc, TOKEN, { capabilities: { experimental: { mcpl: { version: '0.5', pushEvents: true } } } });
    c.pushes = [];
    c.setRequestHandler(z.object({ method: z.literal('push/event'), params: z.any() }), async (r) => { c.pushes.push(r.params); return { accepted: true }; });
    const m = c.getServerCapabilities().experimental.mcpl;
    assert.deepEqual(m.featureSets[DOWNLOAD_SET].uses, ['pushEvents']);
    await c.request({ method: 'featureSets/update', params: { enabled: ['*'], effectiveCapabilities: ['tools', 'pushEvents'] } }, z.any());
    const id = await openAt(c, `${a}/page?to=/dl`);
    const d = (await clickGo(c, id)).downloads[0];
    await until(() => c.pushes.length === 1, 10000);
    const p = c.pushes[0];
    assert.equal(p.featureSet, DOWNLOAD_SET);
    assert.deepEqual(p.tags, [DOWNLOAD, 'bosun:state=ready', `bosun:session=${id}`]);
    assert.equal(p.origin.download_id, d.download_id);
    assert.equal(p.origin.size, Buffer.byteLength(TEXT));
    assert.match(p.payload.content[0].text, /^Bosun download ready: "transcript.vtt" \(\d+ bytes, text\/vtt, from 127\.0\.0\.1:\d+\) in session s[0-9a-f]+\. Fetch it with download_get/);
    await c.call('navigate', { session: id, url: `${b}/page?to=/dl` });
    await clickGo(c, id);
    await until(() => c.pushes.length === 2, 10000);
    assert.deepEqual(c.pushes[1].tags, [DOWNLOAD, 'bosun:state=refused', `bosun:session=${id}`]);
    assert.match(c.pushes[1].origin.reason, /download allowlist/);
    await c.close();
  } finally { await svc.stop(); }
});

test('robustness: a long name with an emoji, a failed delete keeps its quota, two inline fetches at once, a stalled GET', async () => {
  const svc = await start();
  const origErr = console.error; console.error = () => {};
  try {
    const { safeName } = await import('../src/uploads.mjs');
    const n = safeName('a'.repeat(197) + '😀');
    assert.equal(n, 'a'.repeat(197)); // cut by whole characters, never half an emoji
    const c = await connect(svc, TOKEN);
    const id = await openAt(c, `${a}/page?to=/dl`);
    // Two inline fetches at once: one gets the content, the other is refused.
    const d1 = (await clickGo(c, id)).downloads[0];
    const both = await Promise.all([1, 2].map(() => c.call('download_get', { download_id: d1.download_id, inline: true })));
    assert.equal(both.filter((r) => !r.isError && r.json().inline === true).length, 1, both.map((r) => r.text).join('\n'));
    // A removal that fails keeps the bytes charged until it succeeds.
    const d2 = (await clickGo(c, id)).downloads[0];
    const f = svc.downloads.files.get(d2.download_id);
    fs.chmodSync(path.dirname(f.dir), 0o500);
    await svc.downloads.remove(f);
    assert.equal(svc.downloads.used('alice'), f.size);
    fs.chmodSync(path.dirname(f.dir), 0o700);
    svc.downloads.sweep();
    await until(() => svc.downloads.used('alice') === 0);
    // A refused download whose partial file can't be removed stays charged until it is gone.
    const inDir = path.join(svc.dataDir, 'downloads', 'alice', '.in-test');
    fs.mkdirSync(inDir, { recursive: true });
    fs.writeFileSync(path.join(inDir, 'guid.crdownload'), Buffer.alloc(5000));
    // Refused before its size was ever measured (size 0): charged at what is still on disk.
    const fr = { id: 'dtest', tenant: 'alice', session: 'sx', seq: 0, state: 'downloading', name: 'x', source: 'h', size: 0, abs: path.join(inDir, 'guid'), expiresAt: Date.now() + 3600_000 };
    svc.downloads.files.set(fr.id, fr);
    fs.chmodSync(inDir, 0o500);
    await svc.downloads.refuse(fr, null, 'too big');
    assert.equal(fr.leftover, true);
    assert.equal(svc.downloads.used('alice'), 5000);
    fs.chmodSync(inDir, 0o700);
    svc.downloads.sweep();
    await until(() => svc.downloads.used('alice') === 0);
    // A GET whose client reads nothing is cut off once the file is past its expiry; then the file goes.
    const d3 = (await clickGo(c, await openAt(c, `${a}/page?to=/dl?kb=4096`))).downloads[0];
    const g = (await c.call('download_get', { download_id: d3.download_id })).json();
    const req = http.get(g.get_url, (res) => res.pause()); // never reads
    req.on('error', () => {});
    const f3 = svc.downloads.files.get(d3.download_id);
    await until(() => f3.sending, 5000);
    svc.downloads.sweep(Date.now() + 3600_000 + 120_000);
    await until(() => !f3.sending, 5000);
    svc.downloads.sweep(Date.now() + 3600_000 + 120_000);
    await until(() => !fs.existsSync(f3.dir), 5000);
    req.destroy();
    await c.close();
  } finally { console.error = origErr; await svc.stop(); }
});
