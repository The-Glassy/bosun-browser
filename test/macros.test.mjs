// Macros: saved step sequences (macro_save … macro_run). Validation and the store as units; runs through the real
// MCP tools against two local servers: A (the macro's site, with an import / generate / export flow like Plaud's)
// and B (off the site).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { loadConfig } from '../src/config.mjs';
import { Macros, checkArgs, checkMacro, onSite, parseMacroSource, resolveStep, riskyIn, runMacro } from '../src/macros.mjs';
import { parseHostPattern } from '../src/allow.mjs';
import { startBosun, connect, tmpDir, TOKEN } from './helpers.mjs';

const TOKEN_E = 'test-token-eeeeeeeeeeeeeeee';
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const received = []; // what the page uploaded: { name, text }

function serverA() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = (k) => u.searchParams.get(k) ?? '';
    if (u.pathname === '/app') {
      return html(res, `<title>App</title><h1>Files</h1>
        <button onclick="document.getElementById('menu').hidden = false">Add audio</button>
        <div id="menu" hidden><button onclick="document.getElementById('f').click()">Import audio</button></div>
        <input type="file" id="f" hidden>
        <p id="st"></p><label>Title <input id="title"></label><label>Password <input id="pw" type="password"></label>
        <a id="away" href="${q('away')}">Help</a>
        <button id="b1">Buy now</button>
        <button id="ib" aria-label="Buy now"><span id="icon">→</span></button>
        <button id="lt" aria-label="Buy now">${'all the details you could want '.repeat(30)}</button>
        <button id="nav" onclick='location.href = ${JSON.stringify(q('away'))}'>Attach</button>
        <script>document.getElementById('f').onchange = async (e) => {
          const file = e.target.files[0];
          await fetch('/up?name=' + encodeURIComponent(file.name), { method: 'POST', body: await file.text() });
          document.getElementById('st').textContent = 'Uploaded: ' + file.name;
        };</script>`);
    }
    if (u.pathname === '/redir') return html(res, `<title>Redirect</title><script>setTimeout(() => { location.href = ${JSON.stringify(q('to'))}; }, ${Number(q('ms')) || 700})</script>`);
    if (u.pathname === '/late') { // a password field and a "Buy now" button that show up after a second
      return html(res, `<title>Late</title><p>loading</p><script>setTimeout(() => {
        document.body.insertAdjacentHTML('beforeend', '<input id="lpw" type="password"><button id="lb">Buy now</button>');
      }, 1000);</script>`);
    }
    if (u.pathname === '/up') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { received.push({ name: q('name'), text: body }); res.end('ok'); });
      return;
    }
    if (u.pathname === '/file') {
      return html(res, `<title>File ${q('name')}</title><div class="opts"><div>Generate</div><div>Generate later</div></div>
        <button id="gen" hidden>Generate now</button><div id="out"></div>
        <script>
          document.querySelector('.opts div').onclick = () => { document.getElementById('gen').hidden = false; };
          document.getElementById('gen').onclick = () => {
            document.getElementById('out').innerHTML = '<p>Transcript ready</p><p id="summary">Summary of ' + ${JSON.stringify(q('name'))} + '</p><a href="/export?name=' + encodeURIComponent(${JSON.stringify(q('name'))}) + '">Export</a>';
          };
        </script>`);
    }
    if (u.pathname === '/export') {
      const body = Buffer.from(`transcript of ${q('name')}\n`);
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': `attachment; filename="${q('name')}.txt"`, 'content-length': String(body.length) });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
}
const pressedOnB = [];
const serverB = () => http.createServer((req, res) => {
  if (req.url.startsWith('/pressed')) { pressedOnB.push(req.url); res.end('ok'); return; }
  html(res, `<title>Elsewhere</title><p>off the site</p><input id="q" autofocus><input id="bpw" type="password">
    <select id="choice"><option>a</option><option>b</option></select>
    <script>addEventListener('keydown', () => fetch('/pressed'));
      document.getElementById('choice').onchange = () => fetch('/pressed?select');
      new MutationObserver((ms) => { if (ms.some((m) => [...m.addedNodes].some((n) => n.type === 'file'))) fetch('/pressed?fileinput'); })
        .observe(document.documentElement, { childList: true, subtree: true });</script>`);
});

let A, B, svc, c;
before(async () => {
  const listen = async (srv) => { await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return { srv, base: `http://127.0.0.1:${srv.address().port}`, host: `127.0.0.1:${srv.address().port}` }; };
  A = await listen(serverA());
  B = await listen(serverB());
  svc = await startBosun({
    BROWSER_TOKENS: `alice:${TOKEN},swarm:${TOKEN_E}`, BROWSER_TOKEN_POLICIES: 'swarm=ephemeral', BROWSER_MACRO_SOURCE: 'swarm=alice',
    BROWSER_TENANT_DOWNLOAD_ALLOW: `alice=${A.host}`,
  });
  c = await connect(svc);
});
after(async () => {
  await c?.close();
  await svc?.stop();
  for (const s of [A, B]) if (s) await new Promise((r) => { s.srv.closeAllConnections(); s.srv.close(() => r()); });
});

// The flow from the brief, against server A: import a file through a chooser, re-navigate, generate, export.
const importFlow = () => ({
  name: 'import-audio',
  description: 'Import an audio file, generate the transcript, export it',
  site: [A.host],
  params: { audio: { type: 'file_id' }, title: { type: 'string' } },
  steps: [
    { tool: 'navigate', url: `${A.base}/app` },
    { tool: 'click', role: 'button', name: 'Add audio' },
    { tool: 'upload', role: 'button', name: 'Import audio', file_id: '{{audio}}' },
    { tool: 'wait_for', text: 'Uploaded: ' },
    { tool: 'type', selector: '#title', value: '{{title}}' },
    { tool: 'navigate', url: `${A.base}/file?name={{title}}` },
    { tool: 'click', selector: 'div:text-is("Generate")' },
    { tool: 'click', role: 'button', name: 'Generate now' },
    { tool: 'assert', text: 'Transcript ready' },
    { tool: 'read', mode: 'text', selector: '#summary', as: 'summary' },
    { tool: 'click', text: 'Export' },
    { tool: 'download_wait', timeoutMs: 20000 },
    { tool: 'screenshot' },
  ],
});

// --- units ---

test('checkMacro: a valid macro is stored as given, with defaults filled in', () => {
  const m = checkMacro({ name: 'x', site: ['Web.Plaud.ai', '*.plaud.ai'], params: { t: { type: 'string', default: 'a' }, f: { type: 'file_id' } }, steps: [{ tool: 'navigate', url: 'https://web.plaud.ai/{{t}}' }, { tool: 'upload', text: 'Import', file_id: '{{ f }}' }] });
  assert.deepEqual(m.site, ['web.plaud.ai', '*.plaud.ai']);
  assert.deepEqual(m.params, { t: { type: 'string', required: false, default: 'a' }, f: { type: 'file_id', required: true } });
  assert.equal(m.confirm_risky, false);
  assert.deepEqual(m.risky_steps, []);
});

test('examples/plaud-import.json is a valid macro', () => {
  const m = checkMacro(JSON.parse(fs.readFileSync(new URL('../examples/plaud-import.json', import.meta.url), 'utf8')));
  assert.equal(m.name, 'plaud-import');
  assert.deepEqual(m.site, ['web.plaud.ai', '*.plaud.ai']);
  assert.deepEqual(m.risky_steps, []);
  assert.ok(m.steps.some((st) => st.tool === 'upload') && m.steps.some((st) => st.tool === 'download_wait'));
});

test('checkMacro refuses refs, sessions, undeclared params, stored ids, code and "*"', () => {
  const base = { name: 'x', site: ['example.org'], steps: [{ tool: 'navigate', url: 'https://example.org/' }] };
  const bad = (patch, re) => assert.throws(() => checkMacro({ ...base, ...patch }), re);
  bad({ name: 'Bad Name' }, /name must match/);
  bad({ site: ['*'] }, /"\*" is not allowed/);
  bad({ site: [] }, /site needs 1/);
  bad({ site: ['exa mple.org'] }, /site: host pattern/);
  bad({ steps: [] }, /steps must be a list/);
  bad({ steps: [{ tool: 'evaluate', script: '1' }] }, /tool must be one of/);
  bad({ steps: [{ tool: 'click', ref: 'e12' }] }, /ref is not allowed/);
  bad({ steps: [{ tool: 'click', selector: '#a', session: 's1' }] }, /no session in a step/);
  bad({ steps: [{ tool: 'click', selector: '#a', script: 'x' }] }, /unknown field\(s\) script/);
  bad({ steps: [{ tool: 'click' }] }, /give the element/);
  bad({ steps: [{ tool: 'click', name: 'OK' }] }, /name goes with role/);
  bad({ steps: [{ tool: 'type', selector: '#a' }] }, /give value or secret_id/);
  bad({ steps: [{ tool: 'type', selector: '#pw', secret_id: 'sabc' }] }, /secret_id must be a \{\{param\}\} of type secret_id/);
  bad({ params: { p: { type: 'string' } }, steps: [{ tool: 'type', selector: '#pw', secret_id: '{{p}}' }] }, /must name a param of type secret_id/);
  bad({ params: { pw: { type: 'secret_id' } }, steps: [{ tool: 'type', selector: '#a', value: 'x{{pw}}' }] }, /a secret_id goes only into type secret_id/);
  bad({ steps: [{ tool: 'upload', selector: '#f', file_id: 'f123' }] }, /file_id must be a \{\{param\}\} of type file_id/);
  bad({ steps: [{ tool: 'navigate', url: 'https://example.org/{{nope}}' }] }, /\{\{nope\}\}, which is not a declared param/);
  bad({ params: { s: { type: 'secret_id', default: 'x' } } }, /has no default/);
  bad({ params: { n: { type: 'number', default: '3' } } }, /default must be a number/);
  bad({ params: { n: { type: 'date' } } }, /param n: type/);
  bad({ steps: [{ tool: 'assert' }] }, /give text, selector and\/or url_contains/);
  bad({ steps: [{ tool: 'wait_for' }] }, /give text or selector/);
});

test('risky steps: refused without confirm_risky, kept and listed with it', () => {
  const base = { name: 'shop', site: ['shop.example'] };
  for (const [st, word] of [
    [{ tool: 'click', role: 'button', name: 'Pay now' }, 'Pay now'],
    [{ tool: 'click', text: 'Buy' }, 'Buy'],
    [{ tool: 'click', selector: 'button:has-text("Submit order")' }, 'Submit order'],
    [{ tool: 'navigate', url: 'https://shop.example/checkout' }, 'checkout'],
    [{ tool: 'click', text: 'Delete account' }, 'Delete account'],
    [{ tool: 'click', text: 'Zahlungspflichtig bestellen' }, 'Zahlungspflichtig'],
  ]) {
    assert.throws(() => checkMacro({ ...base, steps: [st] }), new RegExp(`step 1 \\(${st.tool}\\) matches "${word}".*confirm_risky: true`));
    const m = checkMacro({ ...base, steps: [st], confirm_risky: true });
    assert.deepEqual(m.risky_steps, [{ step: 1, tool: st.tool, matched: word }]);
  }
  for (const fine of ['PayPal account settings', 'Payment history', 'Submit', 'Export', 'Generate now', 'buyer guide']) assert.equal(riskyIn(fine), null, fine);
});

test('checkArgs and resolveStep: types, defaults, unknown args; a step using an absent optional param is skipped', () => {
  const m = checkMacro({ name: 'x', site: ['a.example'], params: { t: { type: 'string' }, n: { type: 'number', required: false }, f: { type: 'file_id', required: false }, d: { type: 'string', default: 'dflt' } }, steps: [{ tool: 'navigate', url: 'https://a.example/' }] });
  assert.deepEqual(checkArgs({ ...m, name: 'x' }, { t: 'hi' }), { t: 'hi', d: 'dflt' });
  assert.throws(() => checkArgs(m, {}), /param t \(string\) is required/);
  assert.throws(() => checkArgs(m, { t: 'a', zz: 1 }), /has no param zz/);
  assert.throws(() => checkArgs(m, { t: 1 }), /param t must be a string/);
  assert.throws(() => checkArgs(m, { t: 'a', n: '3' }), /param n must be a number/);
  assert.throws(() => checkArgs(m, { t: 'a', f: '../etc' }), /param f is not a file_id/);
  assert.deepEqual(resolveStep({ tool: 'type', selector: '#a', value: '{{t}}-{{ n }}' }, { t: 'x', n: 2 }), { step: { tool: 'type', selector: '#a', value: 'x-2' } });
  assert.deepEqual(resolveStep({ tool: 'upload', text: 'Up', files: ['{{f}}'] }, { t: 'x' }), { missing: ['f'] });
  assert.deepEqual(resolveStep({ tool: 'click', text: 'a', note: '{{t}} stays' }, { t: 'x' }).step.note, '{{t}} stays');
});

test('onSite: about:blank is no page, error pages and other hosts or ports are off the site', () => {
  const p = ['web.plaud.ai', '*.plaud.ai', '127.0.0.1:4848'].map(parseHostPattern);
  for (const u of ['about:blank', 'https://web.plaud.ai/x', 'https://app.plaud.ai/', 'http://127.0.0.1:4848/']) assert.equal(onSite(p, u), true, u);
  for (const u of ['https://plaud.ai.evil.example/', 'http://127.0.0.1:4849/', 'chrome-error://chromewebdata/', 'data:text/html,x', 'https://evil.example/?https://web.plaud.ai']) assert.equal(onSite(p, u), false, u);
});

// A page side that records what the runner asks of it.
const fakeOps = (over = {}) => {
  const calls = [];
  return {
    calls,
    allowed: () => null, limitOf: (t) => (t === 'assert' ? 1500 : 60000), url: () => 'https://a.example/',
    watch: () => ({ seen: () => null, stop() {} }), failure: async () => ({ url: 'https://a.example/' }),
    step: async (tool, args, limitMs, _signal, hooks) => { calls.push({ tool, args, limitMs, hooks }); return { content: [{ type: 'text', text: '{}' }] }; },
    assert: async (c, limitMs, hooks) => { calls.push({ tool: 'assert', c, limitMs, hooks }); },
    ...over,
  };
};

test('runMacro: assert gets the wait_for deadline; every step the guard, click and type the vet; cancelled runs say not_run', async () => {
  const m = { ...checkMacro({ name: 'u', site: ['a.example'], steps: [{ tool: 'assert', text: 'x', timeoutMs: 60000 }, { tool: 'click', text: 'Go' }, { tool: 'type', selector: '#q', value: 'v' }, { tool: 'press', key: 'Enter' }] }), version: 1 };
  let url = 'https://a.example/';
  const ops = fakeOps({ url: () => url });
  const { result } = await runMacro(m, { args: {}, ops });
  assert.equal(result.ok, true);
  assert.equal(ops.calls[0].limitMs, 1500); // TOOL_TIMEOUTS wait_for, not the assert's own 60 s
  assert.equal(ops.calls[0].c.timeoutMs, 500); // and the wait ends before that: 1500 - 500 reserve - 500
  for (const c of ops.calls) assert.equal(typeof c.hooks.guard, 'function', c.tool);
  assert.deepEqual(ops.calls.map((c) => [c.tool, typeof c.hooks.vet]), [['assert', 'undefined'], ['click', 'function'], ['type', 'function'], ['press', 'object']]);
  // The guard refuses a page off the site.
  ops.calls[3].hooks.guard();
  url = 'https://b.example/';
  assert.throws(() => ops.calls[3].hooks.guard(), /the page is at b\.example, outside this macro's site/);
  // The failure report gets what is left of timeout_sec: the steps stop a third of a short run before its end.
  let until = null;
  const fails = { ...m, steps: [{ tool: 'press', key: 'x' }] };
  const t0 = Date.now();
  const r2 = (await runMacro(fails, { args: {}, maxMs: 30_000, ops: fakeOps({ step: async () => { throw new Error('boom'); }, failure: async (u) => { until = u; return {}; } }) })).result;
  assert.equal(r2.failure.error, 'boom');
  assert.ok(until > t0 + 29_000 && until <= t0 + 30_100, String(until - t0));
  const ab = new AbortController();
  ab.abort();
  const cancelled = (await runMacro(m, { args: {}, ops: fakeOps(), signal: ab.signal })).result;
  assert.deepEqual(cancelled.steps.map((x) => x.status), ['not_run', 'not_run', 'not_run', 'not_run']);
  assert.match(cancelled.failure.error, /cancelled/);
  const late = (await runMacro(m, { args: {}, ops: fakeOps(), maxMs: 500 })).result;
  assert.equal(late.steps[0].status, 'not_run');
  assert.match(late.failure.error, /time ran out \(timeout_sec 1\)/);
});

test('BROWSER_MACRO_SOURCE: only a read-only tenant reads another tenant\'s macros', () => {
  const env = { BROWSER_TOKENS: 'me:aaaaaaaaaaaaaaaaaaaa,swarm:bbbbbbbbbbbbbbbbbbbb', BROWSER_TOKEN_POLICIES: 'swarm=ephemeral' };
  assert.deepEqual([...loadConfig({ ...env, BROWSER_MACRO_SOURCE: 'swarm=me' }).macroSource], [['swarm', 'me']]);
  assert.equal(loadConfig(env).macroSource.size, 0);
  assert.throws(() => loadConfig({ ...env, BROWSER_MACRO_SOURCE: 'me=swarm' }), /whose policy is full/);
  assert.throws(() => loadConfig({ ...env, BROWSER_MACRO_SOURCE: 'swarm=nobody' }), /"nobody", which has no token/);
  assert.throws(() => loadConfig({ ...env, BROWSER_MACRO_SOURCE: 'swarm' }), /<read-only tenant>=<tenant/);
  assert.throws(() => loadConfig({ ...env, BROWSER_MACRO_SOURCE: 'swarm=swarm' }), /reads its own macros already/);
  assert.throws(() => parseMacroSource({ BROWSER_MACRO_SOURCE: 'swarm=me,swarm=me' }, [{ tenant: 'me' }, { tenant: 'swarm' }], new Map([['swarm', 'ephemeral']])), /twice/);
});

test('the store: versions, list, get, delete; files 0600 in the data volume, kept across a restart', () => {
  const dataDir = tmpDir();
  try {
    const st = new Macros({ dataDir });
    const def = { name: 'm1', description: 'one', site: ['a.example'], steps: [{ tool: 'navigate', url: 'https://a.example/' }] };
    assert.equal(st.save('t', def, { createdBy: 'glassy' }).version, 1);
    assert.equal(st.save('t', { ...def, description: 'two' }, { createdBy: 'glassy' }).version, 2);
    const f = path.join(dataDir, 'macros', 't', 'm1.json');
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    const again = new Macros({ dataDir }); // a restart
    assert.deepEqual(again.list('t').map((m) => [m.name, m.version, m.description, m.created_by]), [['m1', 2, 'two', 'glassy']]);
    assert.equal(again.get('t', 'm1', 1).description, 'one');
    assert.deepEqual(again.get('t', 'm1').versions, [1, 2]);
    assert.throws(() => again.get('t', 'm1', 7), /no version 7 \(kept: 1, 2\)/);
    assert.deepEqual(again.list('other'), []); // per tenant
    assert.throws(() => again.get('other', 'm1'), /no macro m1/);
    assert.throws(() => again.get('t', '../t/m1'), /no macro/);
    for (let i = 3; i <= 25; i++) again.save('t', def, { createdBy: 'glassy' });
    assert.deepEqual(again.get('t', 'm1').versions, Array.from({ length: 20 }, (_, i) => i + 6)); // the last 20 kept
    assert.deepEqual(again.delete('t', 'm1'), { deleted: 'm1' });
    assert.equal(fs.existsSync(f), false);
    assert.throws(() => again.delete('t', 'm1'), /no macro m1/);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

// --- runs through the MCP tools ---

test('a multi-step macro: upload through a chooser, a param, re-navigate, generate, assert, read, download', async () => {
  const saved = await c.call('macro_save', importFlow());
  assert.equal(saved.isError, false, saved.text);
  assert.equal(saved.json().version, 1);
  const list = (await c.call('macro_list')).json();
  assert.deepEqual(list.map((m) => [m.name, m.steps, m.params]), [['import-audio', 13, { audio: 'file_id', title: 'string' }]]);
  const file = (await c.call('upload_create', { filename: 'memo.m4a', content_base64: Buffer.from('fake audio bytes').toString('base64') })).json().file_id;
  const s = await c.open();
  // dry run: resolved steps, nothing touched
  const dry = await c.call('macro_run', { name: 'import-audio', session: s, dry_run: true, args: { audio: file, title: 'standup' } });
  assert.equal(dry.isError, false, dry.text);
  assert.equal(dry.json().steps[5].url, `${A.base}/file?name=standup`);
  assert.equal(received.length, 0);
  const progress = [];
  const r = await c.call('macro_run', { name: 'import-audio', session: s, args: { audio: file, title: 'standup' } }, { onprogress: (p) => progress.push(p), timeout: 120_000 });
  assert.equal(r.isError, false, r.text);
  const out = r.json();
  assert.equal(out.ok, true);
  assert.deepEqual(out.steps.map((x) => x.status), Array(13).fill('ok'));
  assert.deepEqual(received, [{ name: 'memo.m4a', text: 'fake audio bytes' }]);
  assert.deepEqual(out.reads, [{ step: 10, as: 'summary', text: 'Summary of standup' }]);
  assert.equal(out.downloads.length, 1);
  assert.equal(out.downloads[0].filename, 'standup.txt');
  assert.equal(out.steps[11].download_id, out.downloads[0].download_id);
  const got = (await c.call('download_get', { download_id: out.downloads[0].download_id, inline: true })).json();
  assert.equal(got.content, 'transcript of standup\n');
  assert.equal(r.result.content.filter((x) => x.type === 'image').length, 1); // the screenshot step
  // One per step, sent before the answer. The SDK client handles a notification a microtask late, so one that
  // arrives in the same read as the answer is dropped: the last one may be missing.
  assert.ok(progress.length >= 12, JSON.stringify(progress));
  assert.deepEqual(progress.map((p) => [p.progress, p.total]), Array.from({ length: progress.length }, (_, i) => [i + 1, 13]));
  // A missing required arg is refused before anything runs.
  assert.match((await c.call('macro_run', { name: 'import-audio', session: s, args: { title: 'x' } })).text, /param audio \(file_id\) is required/);
  await c.call('session_close', { session: s });
});

test('a failing assert stops the run with the step, the error, the URL, the page and a screenshot', async () => {
  assert.equal((await c.call('macro_save', {
    name: 'fails', site: [A.host], params: { t: { type: 'string' } },
    steps: [
      { tool: 'navigate', url: `${A.base}/app` },
      { tool: 'wait_for', text: 'Not on this page', timeoutMs: 300, optional: true },
      { tool: 'type', selector: '#title', value: '{{t}}' },
      { tool: 'assert', text: 'Transcript ready', timeoutMs: 500 },
      { tool: 'click', role: 'button', name: 'Add audio' },
    ],
  })).isError, false);
  const s = await c.open();
  const r = await c.call('macro_run', { name: 'fails', session: s, args: { t: 'hello' } }, { timeout: 120_000 });
  assert.equal(r.isError, true);
  const out = r.json();
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps.map((x) => x.status), ['ok', 'failed_optional', 'ok', 'failed', 'not_run']);
  assert.match(out.steps[1].error, /Timeout|waiting for/i);
  assert.doesNotMatch(r.text, /Call log/); // errors as the tools give them: no Playwright call log
  assert.equal(out.failure.step, 4);
  assert.equal(out.failure.tool, 'assert');
  assert.match(out.failure.error, /assert failed: text "Transcript ready" is not visible within 500 ms/);
  assert.equal(out.failure.url, `${A.base}/app`);
  assert.equal(out.failure.title, 'App');
  assert.match(out.failure.page, /button "Add audio"/);
  assert.match(out.next, /macro_save a new version/);
  assert.equal(r.result.content.filter((x) => x.type === 'image').length, 1);
  await c.call('session_close', { session: s });
});

test('off the site: a click that leaves it stops the run; a navigate outside it is refused before anything runs', async () => {
  assert.equal((await c.call('macro_save', {
    name: 'leaves', site: [A.host],
    steps: [
      { tool: 'navigate', url: `${A.base}/app?away=${encodeURIComponent(`${B.base}/x`)}` },
      { tool: 'click', selector: '#away', optional: true },
      { tool: 'click', role: 'button', name: 'Add audio' },
    ],
  })).isError, false);
  const s = await c.open();
  const r = await c.call('macro_run', { name: 'leaves', session: s }, { timeout: 120_000 });
  const out = r.json();
  assert.equal(out.ok, false);
  assert.deepEqual(out.steps.map((x) => x.status), ['ok', 'failed', 'not_run']);
  assert.equal(out.failure.step, 2);
  assert.match(out.failure.error, new RegExp(`the page went to ${B.host.replace(/\./g, '\\.')}, outside this macro's site \\(${A.host.replace(/\./g, '\\.')}\\); the run stopped`));
  // A macro whose navigate goes elsewhere (here through a param) is refused whole.
  assert.equal((await c.call('macro_save', { name: 'goes', site: [A.host], params: { u: { type: 'string' } }, steps: [{ tool: 'navigate', url: '{{u}}' }] })).isError, false);
  const g = await c.call('macro_run', { name: 'goes', session: s, args: { u: `${B.base}/` } });
  assert.equal(g.isError, true);
  assert.match(g.text, new RegExp(`step 1 \\(navigate\\): ${B.host.replace(/\./g, '\\.')} is not in this macro's site`));
  // The session is still off the site: a macro that starts with a click is not run there.
  const again = (await c.call('macro_run', { name: 'leaves', session: s, version: 1 })).json();
  assert.equal(again.steps[0].status, 'ok'); // navigate brings it back first
  await c.call('session_close', { session: s });
});

test('risky at run time: a selector that hits a "Buy now" button, and risky text brought in by args', async () => {
  assert.equal((await c.call('macro_save', { name: 'sneaky', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/app` }, { tool: 'click', selector: '#b1' }] })).isError, false);
  const s = await c.open();
  const out = (await c.call('macro_run', { name: 'sneaky', session: s })).json();
  assert.equal(out.failure.step, 2);
  assert.match(out.failure.error, /refused: the element says "Buy now"/);
  // What the click reaches counts: an icon inside a "Buy now" button, a label longer than anything a person reads.
  for (const sel of ['#icon', '#lt']) {
    assert.equal((await c.call('macro_save', { name: 'sneaky2', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/app` }, { tool: 'click', selector: sel }] })).isError, false);
    assert.match((await c.call('macro_run', { name: 'sneaky2', session: s })).json().failure.error, /refused: the element says "Buy now"/, sel);
  }
  assert.equal((await c.call('macro_save', { name: 'clicker', site: [A.host], params: { what: { type: 'string' } }, steps: [{ tool: 'click', text: '{{what}}' }] })).isError, false);
  assert.match((await c.call('macro_run', { name: 'clicker', session: s, args: { what: 'Checkout' } })).text, /step 1 \(click\): refused, "Checkout"/);
  await c.call('session_close', { session: s });
});

test('a read-only token lists, gets and runs the macros of its source tenant, but saves and deletes nothing', async () => {
  const e = await connect(svc, TOKEN_E);
  try {
    const names = (await e.listTools()).tools.map((t) => t.name);
    for (const t of ['macro_list', 'macro_get', 'macro_run']) assert.ok(names.includes(t), t);
    for (const t of ['macro_save', 'macro_delete']) {
      assert.ok(!names.includes(t), t);
      assert.match((await e.call(t, { name: 'fails' })).text, /not allowed for this token/);
    }
    assert.ok((await e.call('macro_list')).json().some((m) => m.name === 'fails'));
    assert.equal((await e.call('macro_get', { name: 'fails' })).json().steps.length, 5);
    // Its steps hold to its policy: no uploads, downloads or secrets.
    const up = await e.call('macro_run', { name: 'import-audio', dry_run: true, args: { audio: 'u0123', title: 'x' } });
    assert.match(up.text, /step 3 \(upload\): upload is not available for this token/);
    const s = await e.open();
    const r = (await e.call('macro_run', { name: 'leaves', session: s })).json();
    assert.equal(r.failure.step, 2); // runs, and stops off the site as for alice
    await e.call('session_close', { session: s });
  } finally { await e.close(); }
});

test('a secret goes in only through a secret_id param, typed by the type handler', async () => {
  assert.equal((await c.call('macro_save', {
    name: 'login', site: [A.host], params: { pw: { type: 'secret_id' } },
    steps: [{ tool: 'navigate', url: `${A.base}/app` }, { tool: 'type', selector: '#title', secret_id: '{{pw}}' }],
  })).isError, false);
  const s = await c.open();
  // #title is not a password field: the type handler refuses, and the secret stays unused.
  const x = (await c.call('secret_create', { label: 't' })).json();
  assert.equal((await fetch(x.put_url, { method: 'PUT', body: 'hunter2-macro' })).status, 201);
  const r = (await c.call('macro_run', { name: 'login', session: s, args: { pw: x.secret_id } })).json();
  assert.equal(r.failure.step, 2);
  assert.match(r.failure.error, /not a password field; pass allow_non_password/);
  assert.match((await c.call('macro_run', { name: 'login', session: s, args: { pw: 'nope' } })).json().failure.error, /no secret nope/);
  // A plain value into a password field is refused, whether stored or passed as an arg.
  assert.equal((await c.call('macro_save', { name: 'pw-arg', site: [A.host], params: { p: { type: 'string' } }, steps: [{ tool: 'navigate', url: `${A.base}/app` }, { tool: 'type', selector: '#pw', value: '{{p}}' }] })).isError, false);
  const pw = (await c.call('macro_run', { name: 'pw-arg', session: s, args: { p: 'hunter2' } })).json();
  assert.equal(pw.failure.step, 2);
  assert.match(pw.failure.error, /refused: this is a password field; in a macro it takes only secret_id/);
  // Also through its label, which Playwright follows to the field.
  assert.equal((await c.call('macro_save', { name: 'pw-label', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/app` }, { tool: 'type', selector: 'label:has(#pw)', value: 'plain' }] })).isError, false);
  assert.match((await c.call('macro_run', { name: 'pw-label', session: s })).json().failure.error, /refused: this is a password field/);
  // A secret step whose page leaves the site while it waits for the field: nothing typed, the secret not used.
  const y = (await c.call('secret_create', { label: 'redir' })).json();
  assert.equal((await fetch(y.put_url, { method: 'PUT', body: 'never-off-site' })).status, 201);
  assert.equal((await c.call('macro_save', { name: 'pw-redir', site: [A.host], params: { pw: { type: 'secret_id' } }, steps: [{ tool: 'navigate', url: `${A.base}/redir?ms=3000&to=${encodeURIComponent(`${B.base}/`)}` }, { tool: 'type', selector: '#bpw', secret_id: '{{pw}}' }] })).isError, false);
  const off = (await c.call('macro_run', { name: 'pw-redir', session: s, args: { pw: y.secret_id } })).json();
  assert.equal(off.failure.step, 2);
  assert.match(off.failure.error, new RegExp(`(went to|is at|document at) ${B.host.replace(/\./g, '\\.')}`));
  const sess = [...svc.manager.sessions.values()].find((x) => x.id === s);
  assert.equal(await sess.page.evaluate(() => document.getElementById('bpw')?.value ?? 'no field'), '');
  assert.doesNotThrow(() => svc.secrets.find('alice', y.secret_id)); // still there, unused
  await c.call('session_close', { session: s });
});

test('a step queued behind a navigation off the site is not run there', async () => {
  assert.equal((await c.call('macro_save', { name: 'queued', site: [A.host], steps: [
    { tool: 'navigate', url: `${A.base}/app` },
    { tool: 'wait_for', text: 'never', timeoutMs: 1500, optional: true },
    { tool: 'press', key: 'x' },
  ] })).isError, false);
  const s = await c.open();
  pressedOnB.length = 0;
  const run = c.call('macro_run', { name: 'queued', session: s });
  await new Promise((r) => setTimeout(r, 1400)); // the macro's step 1 is done and step 2 holds the session
  const nav = await c.call('navigate', { session: s, url: `${B.base}/` }); // queued behind step 2
  assert.equal(nav.json().title, 'Elsewhere');
  const out = (await run).json();
  assert.equal(out.ok, false);
  assert.equal(out.failure.step, 3);
  assert.match(out.failure.error, new RegExp(`the page (is at|went to) ${B.host.replace(/\./g, '\\.')}, outside this macro's site`));
  assert.equal(out.steps[2].status, 'failed');
  assert.deepEqual(pressedOnB, []); // the key never reached the page off the site
  await c.call('session_close', { session: s });
});

test('select and upload do nothing on a page that left the site while they waited', async () => {
  const s = await c.open();
  pressedOnB.length = 0;
  assert.equal((await c.call('macro_save', { name: 'sel-redir', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/redir?ms=3000&to=${encodeURIComponent(`${B.base}/`)}` }, { tool: 'select', selector: '#choice', value: 'b' }] })).isError, false);
  const sel = (await c.call('macro_run', { name: 'sel-redir', session: s })).json();
  assert.equal(sel.failure.step, 2);
  assert.match(sel.failure.error, new RegExp(`(went to|is at|document at) ${B.host.replace(/\./g, '\\.')}`));
  const page = () => [...svc.manager.sessions.values()].find((x) => x.id === s).page;
  assert.equal(await page().evaluate(() => document.getElementById('choice').value), 'a');
  // upload (auto): the button navigates off the site instead of opening a chooser; no input gets the file there.
  const file = (await c.call('upload_create', { filename: 'private.txt', content_base64: Buffer.from('private').toString('base64') })).json().file_id;
  assert.equal((await c.call('macro_save', { name: 'up-redir', site: [A.host], params: { f: { type: 'file_id' } }, steps: [{ tool: 'navigate', url: `${A.base}/app?away=${encodeURIComponent(`${B.base}/`)}` }, { tool: 'upload', selector: '#nav', file_id: '{{f}}' }] })).isError, false);
  pressedOnB.length = 0;
  const up = (await c.call('macro_run', { name: 'up-redir', session: s, args: { f: file } }, { timeout: 120_000 })).json();
  assert.equal(up.failure.step, 2);
  assert.match(up.failure.error, new RegExp(`(went to|is at|document at) ${B.host.replace(/\./g, '\\.')}`));
  assert.deepEqual(pressedOnB.filter((u) => u.includes('fileinput')), []); // no file input was added to B's page
  await c.call('session_close', { session: s });
});

test('click and type look at the element they act on, and refuse when they cannot (late elements too)', async () => {
  assert.equal((await c.call('macro_save', { name: 'late-pw', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/late` }, { tool: 'type', selector: '#lpw', value: 'plain' }] })).isError, false);
  assert.equal((await c.call('macro_save', { name: 'late-buy', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/late` }, { tool: 'click', selector: '#lb' }] })).isError, false);
  assert.equal((await c.call('macro_save', { name: 'gone', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/late` }, { tool: 'click', selector: '#never', optional: true }] })).isError, false);
  const s = await c.open();
  const page = () => [...svc.manager.sessions.values()].find((x) => x.id === s).page;
  const pw = (await c.call('macro_run', { name: 'late-pw', session: s })).json();
  assert.match(pw.failure.error, /refused: this is a password field/);
  assert.equal(await page().evaluate(() => document.getElementById('lpw').value), '');
  const buy = (await c.call('macro_run', { name: 'late-buy', session: s })).json();
  assert.match(buy.failure.error, /refused: the element says "Buy now"/);
  const gone = (await c.call('macro_run', { name: 'gone', session: s })).json();
  assert.equal(gone.steps[1].status, 'failed_optional'); // no element: nothing clicked, the run goes on
  await c.call('session_close', { session: s });
});

test('the run cap bounds a long step', async () => {
  assert.equal((await c.call('macro_save', { name: 'long', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/app` }, { tool: 'wait_for', text: 'never', timeoutMs: 60000 }, { tool: 'press', key: 'x' }] })).isError, false);
  const s = await c.open();
  const t0 = Date.now();
  const out = (await c.call('macro_run', { name: 'long', session: s, timeout_sec: 10 }, { timeout: 120_000 })).json();
  assert.ok(Date.now() - t0 < 10_000 + 5_000, `took ${Date.now() - t0} ms`); // plus the failure report
  assert.equal(out.failure.step, 2);
  assert.match(out.failure.error, /Timeout \d+ms exceeded/); // the wait itself ended in time: no tab was replaced
  assert.equal(out.failure.url, `${A.base}/app`);
  assert.equal(out.steps[2].status, 'not_run');
  await c.call('session_close', { session: s });
});

test('one run at a time per session', async () => {
  assert.equal((await c.call('macro_save', { name: 'slow', site: [A.host], steps: [{ tool: 'navigate', url: `${A.base}/app` }, { tool: 'wait_for', text: 'never', timeoutMs: 3000, optional: true }] })).isError, false);
  const s = await c.open();
  const first = c.call('macro_run', { name: 'slow', session: s });
  await new Promise((r) => setTimeout(r, 300));
  assert.match((await c.call('macro_run', { name: 'slow', session: s })).text, /macro slow is running in session/);
  assert.equal((await first).json().ok, true);
  assert.equal((await c.call('macro_run', { name: 'slow', session: s })).json().ok, true); // free again
  await c.call('session_close', { session: s });
});

test('macro_delete removes it; macro_run of an unknown macro or session fails before anything runs', async () => {
  assert.deepEqual((await c.call('macro_delete', { name: 'sneaky' })).json(), { deleted: 'sneaky' });
  assert.match((await c.call('macro_run', { name: 'sneaky', session: 'nope' })).text, /no macro sneaky/);
  assert.match((await c.call('macro_run', { name: 'fails', session: 'nope', args: { t: 'x' } })).text, /no session nope/);
  assert.match((await c.call('macro_run', { name: 'fails', args: { t: 'x' } })).text, /give session/);
});
