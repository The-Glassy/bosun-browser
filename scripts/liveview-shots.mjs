#!/usr/bin/env node
// Screenshots of the live view on an iPhone-sized viewport (390x844), trackpad and tap mode, into docs/liveview/.
// Runs a local demo page and an in-process Bosun service (headless); no internet needed.
import http from 'http';
import fs from 'fs';
import { chromium } from 'playwright';
import { startBosun, connect, until, sleep } from '../test/helpers.mjs';

const DEMO = `<!doctype html><title>Sign in</title><style>
body{margin:0;font:16px system-ui,sans-serif;background:#f4f5f7;color:#222}
header{background:#24324a;color:#fff;padding:18px 40px;font-size:22px;font-weight:600}
main{max-width:420px;margin:60px auto;background:#fff;border-radius:12px;padding:32px 36px;box-shadow:0 2px 12px #0002}
label{display:block;margin:16px 0 6px;font-size:14px;color:#555} input{width:100%;box-sizing:border-box;padding:10px;font-size:16px;border:1px solid #bbb;border-radius:6px}
.check{display:flex;gap:10px;align-items:center;margin-top:22px;padding:14px;border:1px solid #ddd;border-radius:6px;background:#fafafa}
.check span{width:24px;height:24px;border:2px solid #888;border-radius:4px;background:#fff}
button{margin-top:22px;width:100%;padding:12px;font-size:16px;border:0;border-radius:6px;background:#2f6fde;color:#fff}
</style><header>Example Store</header><main><h2>Sign in</h2>
<label>Email</label><input id="email" value="agent@example.com"><label>Password</label><input id="pw" type="password" value="hunter22">
<div class="check"><span></span>I'm not a robot</div><button>Sign in</button></main>`;

const out = new URL('../docs/liveview/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
const site = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(DEMO); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const svc = await startBosun({ ENGINE: 'chromium' });
const browser = await chromium.launch({ headless: true });
try {
  const c = await connect(svc);
  const s = await c.open();
  await c.call('navigate', { session: s, url: `http://127.0.0.1:${site.address().port}/` });
  const link = (await c.call('request_human', { session: s, reason: 'Please solve the CAPTCHA and sign in' })).json().link;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const vp = await ctx.newPage();
  await vp.goto(link);
  await until(async () => /^live/.test(await vp.textContent('#st')), 10000);
  await sleep(800);
  // Trackpad mode (the default on a phone): the cursor dragged to the left, something in the paste bar (masked).
  const cdp = await ctx.newCDPSession(vp);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', 200, 420);
  for (let i = 1; i <= 10; i++) { await touch('touchMove', 200 - 3 * i, 420 + 0.4 * i); await sleep(30); }
  await touch('touchEnd');
  await sleep(800);
  await vp.fill('#p', 'correct horse battery');
  await vp.screenshot({ path: new URL('iphone-trackpad.png', out).pathname });
  // Tap mode with the key strip open.
  await vp.fill('#p', '');
  await vp.click('#mode [data-m=tap]');
  await vp.click('#kb');
  await vp.evaluate(() => document.activeElement.blur());
  await sleep(300);
  await vp.screenshot({ path: new URL('iphone-tap.png', out).pathname });
  await ctx.close();
  await c.close();
  console.log(`written to ${out.pathname}`);
} finally {
  await browser.close();
  await svc.stop();
  site.close();
}
