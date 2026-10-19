// The live-view page itself, driven in a headless Chromium as the human's phone (390x844, touch) or desktop:
// paste bar, trackpad and tap modes, reopening a link, mobile layout. The tab being handed off runs on ENGINE.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startBosun, startPageServer, connect, until, sleep } from './helpers.mjs';

let pages, svc, browser;
before(async () => { pages = await startPageServer(); svc = await startBosun(); browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); await svc.stop(); await pages.close(); });

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

async function handoff(c, path, focus) {
  const s = await c.open();
  assert.equal((await c.call('navigate', { session: s, url: `${pages.base}${path}` })).isError, false);
  if (focus) await c.call('click', { session: s, selector: focus });
  const r = await c.call('request_human', { session: s, reason: 'please log in' });
  assert.equal(r.isError, false, r.text);
  return { s, link: r.json().link, page: svc.manager.sessions.get(s).page };
}

async function openViewer(link, opts = PHONE) {
  const ctx = await browser.newContext(opts);
  const vp = await ctx.newPage();
  await vp.goto(link);
  await until(async () => /^live/.test(await vp.textContent('#st')), 10000);
  return { ctx, vp };
}

// Touch gestures through CDP (Playwright's touchscreen only taps).
async function touch(vp) {
  const cdp = await vp.context().newCDPSession(vp);
  const ev = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  return {
    async drag(from, to, { steps = 12, hold = 0, fingers = 1 } = {}) {
      const at = (x, y) => Array.from({ length: fingers }, (_, i) => [x + i * 40, y]);
      await ev('touchStart', at(...from));
      if (hold) await sleep(hold);
      for (let i = 1; i <= steps; i++) {
        await ev('touchMove', at(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps));
        await sleep(16);
      }
      await ev('touchEnd', []);
    },
    async tap([x, y]) { await ev('touchStart', [[x, y]]); await sleep(40); await ev('touchEnd', []); },
  };
}

// The /pointer test page's event log, and clearing it.
const log = async (page) => JSON.parse(await page.textContent('#log'));
const resetLog = (page) => page.evaluate(() => document.dispatchEvent(new Event('reset-log')));

// Wait until the remote pointer has stopped moving.
async function settled(page) {
  let n = -1;
  await until(async () => { const m = (await log(page)).moves.length; const same = m === n; n = m; return same; }, 5000, 250);
}

const centerSum = (vp) => vp.evaluate(() => {
  const c = document.getElementById('c');
  const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
  return d[0] + d[1] + d[2];
});

test('paste bar: masked, eye toggle, Enter types into the focused field and clears; the text never reaches tools or logs', async () => {
  const SECRET = 'Pasted-Secret-7Q2x';
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug, out: process.stdout.write, err: process.stderr.write };
  for (const k of ['log', 'error', 'warn', 'info', 'debug']) console[k] = (...a) => { logged.push(a.map(String).join(' ')); orig[k](...a); };
  process.stdout.write = function (chunk, ...a) { logged.push(String(chunk)); return orig.out.call(this, chunk, ...a); };
  process.stderr.write = function (chunk, ...a) { logged.push(String(chunk)); return orig.err.call(this, chunk, ...a); };
  const c = await connect(svc);
  const mcp = []; // every message the agent side receives
  c.transportWs.ws.on('message', (d) => mcp.push(String(d)));
  let ctx;
  try {
    const { s, link, page } = await handoff(c, '/login', '#pw');
    let vp;
    ({ ctx, vp } = await openViewer(link));
    assert.equal(await vp.getAttribute('#p', 'type'), 'password');
    assert.equal(await vp.getAttribute('#p', 'maxlength'), '500');
    await vp.fill('#p', SECRET);
    await vp.click('#eye');
    assert.equal(await vp.getAttribute('#p', 'type'), 'text');
    assert.equal(await vp.textContent('#ins'), 'Insert');
    await vp.press('#p', 'Enter');
    await until(async () => (await page.$eval('#pw', (e) => e.value)) === SECRET);
    assert.equal(await vp.inputValue('#p'), '');
    assert.equal(await vp.getAttribute('#p', 'type'), 'password'); // masked again
    // The Insert button does the same (here into the next field).
    await page.focus('#note');
    await vp.fill('#p', 'via-button');
    await vp.click('#ins');
    await until(async () => (await page.$eval('#note', (e) => e.value)) === 'via-button');
    // While the human works, and after Done, nothing the agent can see carries it.
    assert.equal((await c.call('sessions')).isError, false);
    assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 1 })).json().status, 'still_waiting');
    assert.equal((await c.call('read', { session: s })).isError, true);
    await vp.click('#done');
    assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'human-done');
    for (const mode of ['a11y', 'text']) assert.equal((await c.call('read', { session: s, mode })).isError, false);
    assert.equal((await c.call('screenshot', { session: s })).isError, false);
    await c.call('sessions');
    await until(async () => /Done/.test(await vp.textContent('#st')));
    assert.ok(mcp.length > 5);
    for (const m of mcp) assert.ok(!m.includes(SECRET), `MCP message carries the pasted text: ${m.slice(0, 200)}`);
    for (const l of logged) assert.ok(!l.includes(SECRET), `log carries the pasted text: ${l.slice(0, 200)}`);
  } finally {
    Object.assign(console, { log: orig.log, error: orig.error, warn: orig.warn, info: orig.info, debug: orig.debug });
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
    await ctx?.close();
    await c.close();
  }
});

test('trackpad (default on touch): drag = many mouse moves between two points, tap = click at the cursor, two fingers scroll, hold+drag presses', async () => {
  const c = await connect(svc);
  const { page, link } = await handoff(c, '/pointer');
  const { ctx, vp } = await openViewer(link);
  try {
    assert.equal(await vp.evaluate(() => document.body.dataset.mode), 'pad');
    assert.equal(await vp.isVisible('#cur'), true);
    const t = await touch(vp);
    await resetLog(page);
    await t.drag([100, 300], [220, 360]); // 120 x 60 CSS px of finger travel on the phone
    await until(async () => (await log(page)).moves.length >= 8);
    await settled(page);
    const moves = (await log(page)).moves;
    const [x0, y0] = moves[0], [x1, y1] = moves.at(-1);
    assert.ok(x1 - x0 > 100 && y1 - y0 > 40, JSON.stringify([moves[0], moves.at(-1)])); // right and down, accelerated
    for (let i = 1; i < moves.length; i++) {
      assert.ok(Math.hypot(moves[i][0] - moves[i - 1][0], moves[i][1] - moves[i - 1][1]) < 60, `jump at ${i}: ${JSON.stringify(moves.slice(i - 1, i + 1))}`);
    }
    assert.ok(moves.every(([, , b]) => b === 0));
    // Tap: a click where the cursor is (not where the finger is).
    await t.tap([40, 500]);
    await until(async () => (await log(page)).clicks.length === 1);
    const [[cx, cy]] = (await log(page)).clicks;
    assert.ok(Math.abs(cx - x1) <= 2 && Math.abs(cy - y1) <= 2, JSON.stringify([cx, cy, x1, y1]));
    // Two fingers: scroll, cursor stays.
    await t.drag([150, 500], [150, 350], { fingers: 2 });
    await until(async () => (await log(page)).wheels > 0);
    // Hold, then drag: moves with the button down, then released.
    await resetLog(page);
    await t.drag([100, 300], [160, 300], { hold: 600 });
    await until(async () => (await log(page)).moves.filter((m) => m[2] === 1).length >= 3);
    await until(async () => (await log(page)).buttons.join() === 'down,up');
  } finally {
    await ctx.close();
    await c.close();
  }
});

test('an idle trackpad cursor sends nothing: no input for 5 s, and a finger resting on the glass (sensor noise) for 5 s', async () => {
  const c = await connect(svc);
  const { page, link } = await handoff(c, '/pointer');
  const { ctx, vp } = await openViewer(link);
  try {
    assert.equal(await vp.evaluate(() => document.body.dataset.mode), 'pad');
    const cdp = await vp.context().newCDPSession(vp);
    const ev = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const cursor = () => vp.evaluate(() => { const r = document.getElementById('cur').getBoundingClientRect(); return [r.left, r.top]; });
    await resetLog(page);
    await sleep(5000);
    assert.equal((await log(page)).moves.length, 0);
    // Drag, then keep the finger down and still: it reports ±1 px of noise every 16 ms.
    await ev('touchStart', [[100, 300]]);
    for (let i = 1; i <= 12; i++) { await ev('touchMove', [[100 + 8 * i, 300 + 4 * i]]); await sleep(16); }
    await settled(page);
    const before = await cursor();
    await resetLog(page);
    const t0 = Date.now();
    for (let i = 0; Date.now() - t0 < 5000; i++) { await ev('touchMove', [[196 + [1, -1, 0.5, -0.5][i % 4], 348 + [0.7, -0.7, -0.3, 0.3][i % 4]]]); await sleep(16); }
    assert.deepEqual((await log(page)).moves, []);
    assert.deepEqual(await cursor(), before); // the overlay did not shake either
    // Then a real move is still followed right away.
    for (let i = 1; i <= 6; i++) { await ev('touchMove', [[196 + 6 * i, 348]]); await sleep(16); }
    await ev('touchEnd', []);
    await until(async () => (await log(page)).moves.length > 0);
    assert.deepEqual((await log(page)).buttons, []);
  } finally {
    await ctx.close();
    await c.close();
  }
});

test('a deliberate fine correction after resting still moves the cursor (also while dragging, before the release)', async () => {
  const c = await connect(svc);
  const { page, link } = await handoff(c, '/pointer');
  const { ctx, vp } = await openViewer(link);
  try {
    const cdp = await vp.context().newCDPSession(vp);
    const ev = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
    const N = [[1, 0.7], [-1, -0.7], [0.5, -0.3], [-0.5, 0.3]];
    const rest = async (x, y, ms) => { const t0 = Date.now(); for (let i = 0; Date.now() - t0 < ms; i++) { await ev('touchMove', [[x + N[i % 4][0], y + N[i % 4][1]]]); await sleep(16); } };
    // 2 px (with the noise it leaves the 3 px rest radius) and 1.5 px (it stays inside: the averaged path).
    for (const [drag, shift] of [[false, 2], [true, 2], [false, 1.5], [true, 1.5]]) {
      await resetLog(page);
      await ev('touchStart', [[100, 300]]);
      if (drag) await sleep(600); // hold: press
      for (let i = 1; i <= 10; i++) { await ev('touchMove', [[100 + 8 * i, 300]]); await sleep(16); }
      await rest(180, 300, 400);
      await settled(page);
      const before = (await log(page)).moves.at(-1);
      await rest(180 + shift, 300, 250); // a little to the right, held briefly, then lifted
      await ev('touchEnd', []);
      // The correction may reach a slow engine (camoufox) well after the release: wait for it, don't sample once.
      await until(async () => (await log(page)).moves.at(-1)[0] - before[0] >= shift * 2, 8000).catch(() => {});
      await settled(page);
      const L = await log(page);
      const after = L.moves.at(-1);
      assert.ok(after[0] - before[0] >= shift * 2, `drag=${drag} shift=${shift}: ${JSON.stringify([before, after])}`); // ~shift x 0.9 x 3.3
      assert.ok(Math.abs(after[1] - before[1]) <= 2);
      if (drag) {
        assert.deepEqual(L.buttons, ['down', 'up']);
        assert.equal(after[2], 1); // the correction happened with the button still down
      }
    }
  } finally {
    await ctx.close();
    await c.close();
  }
});

test('tap mode clicks where tapped; a desktop mouse hovers (real mouse moves) and clicks', async () => {
  const c = await connect(svc);
  const { page, link } = await handoff(c, '/pointer');
  let { ctx, vp } = await openViewer(link);
  try {
    await vp.click('#mode [data-m=tap]');
    assert.equal(await vp.evaluate(() => document.body.dataset.mode), 'tap');
    assert.equal(await vp.isVisible('#cur'), false);
    const box = await vp.locator('#c').boundingBox();
    const vw = await page.evaluate(() => innerWidth);
    await (await touch(vp)).tap([box.x + box.width / 2, box.y + box.height / 2]);
    await until(async () => (await log(page)).clicks.length === 1);
    const [[x]] = (await log(page)).clicks;
    assert.ok(Math.abs(x - vw / 2) < vw / 50, `${x} vs ${vw / 2}`);
    await ctx.close();

    ({ ctx, vp } = await openViewer(link, { viewport: { width: 1400, height: 1000 } }));
    assert.equal(await vp.evaluate(() => document.body.dataset.mode), 'tap'); // fine pointer
    const b = await vp.locator('#c').boundingBox();
    await resetLog(page);
    await vp.mouse.move(b.x + 20, b.y + 20);
    await vp.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
    await until(async () => (await log(page)).moves.length >= 5); // hover alone moves the remote mouse
    await vp.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await until(async () => (await log(page)).clicks.length === 1);
  } finally {
    await ctx.close();
    await c.close();
  }
});

test('closing and reopening the viewer page: the link works again with a frame at once; a second open page waits its turn', async () => {
  const c = await connect(svc);
  const { s, link } = await handoff(c, '/second');
  let { ctx, vp } = await openViewer(link);
  try {
    await until(async () => (await centerSum(vp)) > 600); // the white page is on the canvas
    // Another device opens the link meanwhile: it waits.
    const other = await browser.newContext(PHONE);
    const op = await other.newPage();
    await op.goto(link);
    await until(async () => /another device/.test(await op.textContent('#st')), 5000);
    await other.close();
    // Telegram's in-app browser is closed (tab and sessionStorage gone), then the link is tapped again.
    await ctx.close();
    ({ ctx, vp } = await openViewer(link));
    await until(async () => (await centerSum(vp)) > 600, 1500);
    await vp.click('#give');
    assert.equal((await c.call('handoff_wait', { session: s, timeoutSec: 5 })).json().status, 'human-gave-up');
    await until(async () => /human-gave-up/.test(await vp.textContent('#st')));
    // After the handoff the page is gone and a reload says so.
    await vp.reload();
    assert.match(await vp.textContent('body'), /expired or unknown link/);
  } finally {
    await ctx.close();
    await c.close();
  }
});

for (const [W, H] of [[390, 844], [320, 568]]) {
test(`phone layout ${W}x${H}: bars do not cover the page, every control sits in the bottom thumb zone, portrait fits`, async () => {
  const c = await connect(svc);
  const { link } = await handoff(c, '/second');
  const { ctx, vp } = await openViewer(link, { ...PHONE, viewport: { width: W, height: H } });
  try {
    const box = async (sel) => vp.locator(sel).boundingBox();
    const [header, wrap, stage, footer] = [await box('header'), await box('#wrap'), await box('#stage'), await box('footer')];
    assert.ok(header.y + header.height <= wrap.y + 0.5, 'header overlaps the page');
    assert.ok(wrap.y + wrap.height <= footer.y + 0.5, 'footer overlaps the page');
    assert.ok(stage.y >= wrap.y - 0.5 && stage.y + stage.height <= wrap.y + wrap.height + 0.5 && stage.width <= W + 0.5);
    assert.ok(footer.y + footer.height <= H + 0.5, 'footer below the screen');
    for (const sel of ['#done', '#give', '#kb', '#ins', '#p', '#eye', '#mode [data-m=tap]', '#mode [data-m=pad]']) {
      const b = await box(sel);
      assert.ok(b && b.y > H * 0.7 && b.y + b.height <= H + 0.5 && b.x >= 0 && b.x + b.width <= W + 0.5, `${sel} ${JSON.stringify(b)}`);
      assert.ok(b.height >= 40, `${sel} too small to hit`);
    }
    assert.equal(await vp.evaluate(() => document.documentElement.scrollWidth), W); // no sideways scrolling
    assert.match(await vp.getAttribute('meta[name=viewport]', 'content'), /viewport-fit=cover/);
    // Keys opens a key strip, still above the bottom edge.
    await vp.click('#kb');
    const k = await box('#keys');
    assert.ok(k && k.y + k.height <= H + 0.5);
  } finally {
    await ctx.close();
    await c.close();
  }
});
}
