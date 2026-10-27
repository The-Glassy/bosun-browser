// Finding elements by role, selector or text: the first VISIBLE match, nth / after / before for icon buttons
// without a name, and errors that say why nothing was clicked. Against a local page shaped like Plaud's recording
// toolbar (October 2026): Share, a closed share popover with real <button>s in it, an export icon that is a
// <div role=button>, a find icon, a "…" menu and Ask Plaud; a hidden copy of the toolbar for small screens; and a
// button under a transparent tooltip layer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { startBosun, connect, TOKEN } from './helpers.mjs';

const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
const ICON = (id) => `<svg width="16" height="16"><use href="#icon-${id}"></use></svg>`;
const say = (what) => `document.getElementById('log').textContent += '${what};'`;

function server() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/file') {
      return html(res, `<title>Plaud Web</title><style>.bar{display:flex;gap:8px;align-items:center} .ico{width:24px;height:24px;cursor:pointer}
        .mobile{display:none} .tip{position:absolute;left:0;top:0;width:100%;height:100%;background:transparent}
        #dlg{display:none} #dlg.open{display:block}</style>
        <nav><div class="side-ask">Ask Plaud</div></nav>
        <div class="mobile bar"><button class="dl" onclick="${say('mobile-download')}">Download</button><button>Export transcript</button></div>
        <div class="bar">
          <div class="grp">
            <div class="share" onclick="${say('share')}">Share</div>
            <div class="pop" style="display:none"><p>Share link</p><button onclick="${say('invite')}">Invite</button><button>Create link</button></div>
            <div><div class="ico" role="button" onclick="document.getElementById('menu').hidden = false; ${say('export')}">${ICON('export')}</div></div>
            <ul id="menu" role="menu" hidden><li role="menuitem" onclick="document.getElementById('dlg').classList.add('open'); ${say('menu')}">Export transcript</li></ul>
            <div id="dlg"><b>Export transcript</b><span>TXT</span><button onclick="location.href = '/export'">Export</button></div>
          </div>
          <div class="ico" onclick="${say('find')}">${ICON('find')}</div>
          <div class="ico" role="button" onclick="${say('more')}">${ICON('more')}</div>
          <div class="ask">Ask Plaud</div>
        </div>
        <div style="position:relative;width:200px;height:40px"><button id="under" onclick="${say('under')}">Under</button><div class="tip" id="tip"></div></div>
        <button id="off" disabled>Off</button>
        <div class="bar"><button class="dl" onclick="${say('download')}">Download</button></div>
        <pre id="log"></pre>`);
    }
    if (u.pathname === '/more') { // shadow roots on both sides of a text; buttons that keep arriving ahead of it; a
      // button shown late that stays disabled; a hidden button that takes what is typed into a password field as its id
      return html(res, `<title>More</title><pre id="log"></pre>
        <x-a id="xa"></x-a><span>Anchor</span><x-b id="xb"></x-b>
        <div><x-c id="xc"></x-c><button onclick="${say('light')}">Ord light</button></div>
        <div id="churn"></div><span>Go</span><button onclick="${say('target')}">Target</button>
        <button id="late" disabled style="display:none">Late</button>
        <input id="pw" type="password" oninput="document.querySelector('.hb').id = 'otp-' + 'x'.repeat(32) + this.value"><button class="hb" hidden>x</button>
        <script>
          document.getElementById('xa').attachShadow({ mode: 'open' }).innerHTML = '<button onclick="document.getElementById(\\'log\\').textContent += \\'A;\\'">A</button>';
          document.getElementById('xc').attachShadow({ mode: 'open' }).innerHTML = '<button onclick="document.getElementById(\\'log\\').textContent += \\'shadow;\\'">Ord shadow</button>';
          document.getElementById('xb').attachShadow({ mode: 'open' }).innerHTML = '<button onclick="document.getElementById(\\'log\\').textContent += \\'B;\\'">B</button>';
          let n = 0; const t = setInterval(() => { document.getElementById('churn').insertAdjacentHTML('afterbegin', '<button>Churn</button>'); if (++n > 400) clearInterval(t); }, 20);
          setTimeout(() => { document.getElementById('late').style.display = ''; }, 8000);
        </script>`);
    }
    if (u.pathname === '/export') {
      const body = Buffer.from('Speaker 1: hello\n');
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="rec.txt"', 'content-length': String(body.length) });
      return res.end(body);
    }
    res.writeHead(404);
    res.end();
  });
}

let srv, base, host, svc, c;
before(async () => {
  srv = server();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  host = `127.0.0.1:${srv.address().port}`;
  base = `http://${host}`;
  svc = await startBosun({ MAX_SESSIONS: '8', BROWSER_TOKENS: `alice:${TOKEN}`, BROWSER_TENANT_DOWNLOAD_ALLOW: `alice=${host}` });
  c = await connect(svc);
});
after(async () => {
  await c?.close();
  await svc?.stop();
  if (srv) await new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
});

const opened = async () => {
  const s = await c.open();
  assert.equal((await c.call('navigate', { session: s, url: `${base}/file` })).isError, false);
  return s;
};
const log = async (s) => (await c.call('read', { session: s, mode: 'text', selector: '#log' })).text.split('\n\n')[1] ?? '';

test('a selector, text or role whose first match is hidden clicks the first visible one', async () => {
  const s = await opened();
  // The small-screen toolbar comes first in the page and is display: none.
  for (const t of [{ selector: 'button.dl' }, { text: 'Download' }, { selector: 'xpath=//button[@class="dl"]' }]) {
    const r = await c.call('click', { session: s, ...t });
    assert.equal(r.isError, false, r.text);
  }
  assert.equal(await log(s), 'download;download;download;');
  // read and wait_for look at the visible match too.
  assert.match((await c.call('read', { session: s, selector: 'button.dl' })).text, /- button "Download"/);
  assert.equal((await c.call('wait_for', { session: s, selector: 'button.dl', timeoutMs: 2000 })).isError, false);
  assert.equal((await c.call('wait_for', { session: s, text: 'Download', timeoutMs: 2000 })).isError, false);
  await c.call('session_close', { session: s });
});

test('nth, after and before find icon buttons without a name', async () => {
  const s = await opened();
  assert.equal((await c.call('click', { session: s, role: 'button', after: 'Share' })).isError, false);
  assert.equal((await c.call('click', { session: s, role: 'button', after: 'Share', nth: 1 })).isError, false);
  assert.equal((await c.call('click', { session: s, selector: '.ico[role=button]', nth: -1 })).isError, false);
  assert.equal(await log(s), 'export;more;more;');
  // Counted back from an anchor: the nearest first.
  assert.equal((await c.call('click', { session: s, role: 'button', before: 'Under' })).isError, false);
  assert.equal((await c.call('click', { session: s, role: 'button', before: 'Under', nth: 1 })).isError, false);
  assert.equal(await log(s), 'export;more;more;more;export;');
  assert.match((await c.call('click', { session: s, ref: 'e1', nth: 1 })).text, /nth, after and before go with role, selector or text, not with ref/);
  await c.call('session_close', { session: s });
});

test('nothing clickable: the error says what matched, what is hidden and what covers it', async () => {
  const sessions = await Promise.all(Array.from({ length: 7 }, opened));
  const t0 = Date.now();
  const [brief, following, none, anchor, covered, disabled, behind] = await Promise.all([
    // The selectors from the Plaud report: they match only the closed popover's <button>s.
    c.call('click', { session: sessions[0], selector: "xpath=//*[normalize-space(text())='Share']/parent::*//button" }),
    c.call('click', { session: sessions[1], selector: 'text=Share >> xpath=following::button[1]' }),
    c.call('click', { session: sessions[2], selector: '#nothing-here' }),
    c.call('click', { session: sessions[3], role: 'button', after: 'Download all' }),
    c.call('click', { session: sessions[4], selector: '#under' }),
    c.call('click', { session: sessions[5], selector: '#off' }),
    // The anchor is the first visible element with the text: the sidebar's Ask Plaud, with no button before it.
    c.call('click', { session: sessions[6], role: 'button', before: 'Ask Plaud' }),
  ]);
  assert.ok(Date.now() - t0 < 45_000);
  assert.match(brief.text, /selector xpath=.*matched 3 elements, none visible within 15 s \(the first is <button>, inside a display: none <div>\)/);
  assert.match(following.text, /matched 1 element, none visible within 15 s \(the first is <button>, inside a display: none <div>\)/);
  assert.match(none.text, /nothing matches selector #nothing-here within 15 s/);
  assert.match(anchor.text, /no visible element shows the text "Download all" \(after\) within 15 s/);
  assert.match(covered.text, /did not become clickable within 15 s: it is covered by <div id="tip" class="tip">, which would get the click/);
  assert.match(disabled.text, /did not become clickable within 15 s: it is disabled/);
  assert.match(behind.text, /role button: 0 visible matches before "Ask Plaud", so nth 0 is not there \(5 more hidden\)/);
  for (const r of [brief, following, none, anchor, covered, disabled, behind]) assert.doesNotMatch(r.text, /Call log/);
  assert.equal(await log(sessions[0]), '');
  await Promise.all(sessions.map((s) => c.call('session_close', { session: s })));
});

test('a macro clicks the unnamed export icon: after Share, Export transcript, the Export button, the download', async () => {
  const bad = await c.call('macro_save', { name: 'x', site: [host], steps: [{ tool: 'click', nth: 1 }] });
  assert.match(bad.text, /step 1 \(click\): nth, after and before go with role, selector or text/);
  const saved = await c.call('macro_save', {
    name: 'export-file', site: [host],
    steps: [
      { tool: 'navigate', url: `${base}/file` },
      // A hidden copy first: the macro path (element handle, looked at before the click) takes the visible one too.
      { tool: 'click', selector: 'button.dl' },
      { tool: 'click', role: 'button', after: 'Share' },
      { tool: 'click', text: 'Export transcript' },
      { tool: 'click', role: 'button', name: 'Export', after: 'Export transcript' },
      { tool: 'download_wait', timeoutMs: 20000 },
    ],
  });
  assert.equal(saved.isError, false, saved.text);
  const s = await c.open();
  const r = await c.call('macro_run', { name: 'export-file', session: s }, { timeout: 120_000 });
  assert.equal(r.isError, false, r.text);
  const out = r.json();
  assert.deepEqual(out.steps.map((x) => x.status), Array(6).fill('ok'));
  assert.equal(out.downloads[0].filename, 'rec.txt');
  await c.call('session_close', { session: s });
});

test('after and before across shadow roots; a picked element stays picked while the page adds more', async () => {
  const s = await c.open();
  await c.call('navigate', { session: s, url: `${base}/more` });
  assert.equal((await c.call('click', { session: s, role: 'button', after: 'Anchor' })).isError, false);
  assert.equal((await c.call('click', { session: s, role: 'button', before: 'Anchor' })).isError, false);
  // Buttons are put in ahead of Go every 20 ms: what was counted after Go is what gets clicked.
  for (let i = 0; i < 4; i++) assert.equal((await c.call('click', { session: s, role: 'button', after: 'Go' })).isError, false);
  // nth alone counts in page order too: the shadow root's button comes first.
  assert.equal((await c.call('click', { session: s, role: 'button', name: 'Ord', nth: 0 })).isError, false);
  assert.equal((await c.call('click', { session: s, role: 'button', name: 'Ord', nth: -1 })).isError, false);
  assert.equal(await log(s), 'B;A;target;target;target;target;shadow;light;');
  await c.call('session_close', { session: s });
});

test('finding and clicking share one 15 s; an id that holds a typed password is masked in the error', async () => {
  const [s1, s2] = [await c.open(), await c.open()];
  await Promise.all([s1, s2].map((s) => c.call('navigate', { session: s, url: `${base}/more` })));
  assert.equal((await c.call('type', { session: s2, selector: '#pw', value: 'hunter42' })).isError, false);
  const t0 = Date.now();
  const [late, masked] = await Promise.all([
    // Shown after 8 s, still disabled: the click gives up 15 s after it started, not 15 s after the button showed.
    c.call('click', { session: s1, selector: '#late' }).then((r) => ({ ...r, ms: Date.now() - t0 })),
    c.call('click', { session: s2, selector: '.hb' }),
  ]);
  assert.match(late.text, /did not become clickable within 15 s: it is disabled/);
  assert.ok(late.ms < 20_000, `${late.ms} ms`);
  // Masked before the id is cut short to 40 characters, so no part of it shows.
  assert.match(masked.text, /the first is <button id="otp-x{32}\[mas" class="hb">, display: none/);
  assert.doesNotMatch(masked.text, /hunt/);
  await Promise.all([s1, s2].map((s) => c.call('session_close', { session: s })));
});
