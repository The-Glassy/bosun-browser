// Find targets in the streamed pixels, then drive the real handoff client. The viewer and the
// handed-off page share a browser process so the engine matrix needs only one browser at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createEngines } from '../src/engines.mjs';
import { startBosun, connect, until } from './helpers.mjs';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1130, height: 760 };
const FIXTURE = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; width: 100%; height: 2200px; }
  #target, #name, #drag { position: absolute; top: 400px; width: 40px; height: 36px; border: 0; }
  #target { left: 48vw; background: #f51020; }
  #name { left: 28vw; background: #11e729; }
  #drag { left: 65vw; background: #1510f5; touch-action: none; }
</style>
<button id="target"></button><input id="name"><div id="drag"></div><script id="events" type="application/json"></script>
<script>
  const events = [];
  document.addEventListener('read-live-events', () => { document.getElementById('events').textContent = JSON.stringify(events); });
  document.addEventListener('reset-live-events', () => { events.length = 0; });
  for (const type of [
    'pointerover', 'pointerenter', 'pointermove', 'pointerdown', 'pointerup', 'pointercancel',
    'pointerout', 'pointerleave', 'gotpointercapture', 'lostpointercapture', 'mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup',
    'mouseout', 'mouseleave', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'scroll',
    'keydown', 'keypress', 'keyup', 'beforeinput', 'input', 'focusin', 'focusout',
  ]) {
    addEventListener(type, e => events.push({
      type, id: e.target.id, x: e.clientX, y: e.clientY, pageX: e.pageX, pageY: e.pageY,
      detail: e.detail, buttons: e.buttons, key: e.key, trusted: e.isTrusted, focused: document.hasFocus(),
    }), true);
  }
</script>`;

const result = (r) => { assert.equal(r.isError, false, r.text); return r.json(); };
const readEvents = (page, type) => page.evaluate((type) => {
  document.dispatchEvent(new Event('read-live-events'));
  return JSON.parse(document.getElementById('events').textContent).filter((e) => e.type === type);
}, type);

async function findPaintedPoint(viewer, color) {
  return until(() => viewer.evaluate((dominant) => {
    const canvas = document.querySelector('#c');
    const box = canvas.getBoundingClientRect();
    const { width, height } = canvas;
    const pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const i = 4 * (y * width + x);
        if (pixels[i + dominant] < 175 || pixels[i + (dominant + 1) % 3] > 95 || pixels[i + (dominant + 2) % 3] > 95) continue;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    if (maxX < 0) return null;
    return [Math.round(box.x + (minX + maxX + 1) / 2 / width * box.width),
      Math.round(box.y + (minY + maxY + 1) / 2 / height * box.height)];
  }, color), 10000);
}

async function assertHit(page, id, index = 0) {
  const clicked = await until(async () => (await readEvents(page, 'click'))[index]);
  const bounds = await page.locator('#' + id).boundingBox();
  assert.equal(clicked.id, id, JSON.stringify(clicked));
  assert.ok(Math.abs(clicked.x - (bounds.x + bounds.width / 2)) < 6, JSON.stringify({ clicked, bounds }));
  assert.ok(Math.abs(clicked.y - (bounds.y + bounds.height / 2)) < 6, JSON.stringify({ clicked, bounds }));
  assert.equal(clicked.trusted, true);
}

// The second Camoufox launch uses the same binary with ordinary Firefox sizing. Camoufox's
// default fingerprint pins window dimensions, which would block Playwright's viewport emulation.
function configurableCamoufox() {
  return createEngines({ async importer(name) {
    const mod = await import(name);
    if (name !== 'camoufox-js') return mod;
    return { async launchOptions(options) {
      const launch = await mod.launchOptions(options);
      const env = Object.fromEntries(Object.entries(launch.env).filter(([key]) => !key.startsWith('CAMOU_CONFIG_')));
      return { ...launch, env, hasTouch: true,
        firefoxUserPrefs: { ...launch.firefoxUserPrefs, 'layout.css.devPixelsPerPx': '2.0' } };
    } };
  } });
}

async function resizeTarget(page, engine, width, height, dpr) {
  await page.setViewportSize({ width, height });
  if (engine !== 'camoufox') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false });
  }
}

async function openViewer(page, engine, link, phone) {
  const viewport = phone ? PHONE : DESKTOP;
  const context = page.context();
  if (engine === 'chromium') {
    const viewerContext = await context.browser().newContext({ viewport,
      ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}) });
    const viewer = await viewerContext.newPage();
    await viewer.goto(link);
    return { viewer, tap: (x, y) => viewer.touchscreen.tap(x, y), close: () => viewerContext.close() };
  }
  let viewer;
  let cdp;
  if (engine === 'camoufox' && phone) {
    // A separate window keeps the target at its own viewport size.
    const popup = page.waitForEvent('popup');
    await page.evaluate(() => window.open('about:blank', 'viewer', 'popup,width=390,height=844'));
    viewer = await popup;
    await viewer.setViewportSize(viewport);
  } else {
    viewer = await context.newPage();
    if (engine === 'patchright') {
      await viewer.setViewportSize(viewport);
      if (phone) {
        cdp = await context.newCDPSession(viewer);
        await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 3, mobile: true });
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      }
    }
  }
  await viewer.goto(link);
  const tap = async (x, y) => {
    if (!cdp) return viewer.touchscreen.tap(x, y);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  return { viewer, tap, close: () => viewer.close() };
}

async function desktopInput(page, viewer, engine) {
  const point = await findPaintedPoint(viewer, 0);
  await viewer.mouse.dblclick(...point);
  await assertHit(page, 'target');
  await assertHit(page, 'target', 1);
  const double = await until(async () => (await readEvents(page, 'dblclick'))[0]);
  assert.deepEqual([double.id, double.detail, double.trusted], ['target', 2, true]);

  await page.evaluate(() => document.dispatchEvent(new Event('reset-live-events')));
  const [x, y] = await findPaintedPoint(viewer, 2);
  if (engine === 'camoufox') {
    // Two simultaneous native mouse presses in one Firefox process fight for pointer
    // capture. Drive the viewer's DOM handlers; its WebSocket still triggers native
    // Juggler mouse events on the target, just like an external viewer would.
    await viewer.locator('#c').evaluate((canvas, [x, y]) => {
      const event = (type, clientX, clientY, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
        clientX, clientY, buttons, pointerType: 'mouse', pointerId: 1, bubbles: true,
      }));
      event('pointerdown', x, y, 1);
      canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, buttons: 1, detail: 1, bubbles: true }));
      for (let i = 1; i <= 10; i++) event('pointermove', x + 6 * i, y + 2.4 * i, 1);
      event('pointerup', x + 60, y + 24, 0);
    }, [x, y]);
  } else {
    await viewer.mouse.move(x, y);
    await viewer.mouse.down();
    await until(async () => (await readEvents(page, 'pointerdown')).some((e) => e.id === 'drag'));
    await viewer.mouse.move(x + 60, y + 24, { steps: 10 });
    await viewer.mouse.up();
  }
  const press = await until(async () => (await readEvents(page, 'pointerdown')).find((e) => e.id === 'drag'));
  const release = await until(async () => (await readEvents(page, 'pointerup'))[0]);
  assert.ok(release.x > press.x + 30 && release.y > press.y + 10, JSON.stringify({ press, release }));
  assert.deepEqual([press.trusted, release.trusted, release.buttons], [true, true, 0]);
  assert.ok((await readEvents(page, 'pointermove')).some((e) => e.buttons === 1 && e.x > press.x));

  await page.evaluate(() => document.dispatchEvent(new Event('reset-live-events')));
  await viewer.mouse.click(...await findPaintedPoint(viewer, 1));
  await assertHit(page, 'name');
  await viewer.bringToFront();
  await viewer.keyboard.type('Bosun');
  await viewer.keyboard.press('Backspace');
  await until(async () => (await page.locator('#name').inputValue()) === 'Bosu');
  await until(async () => (await readEvents(page, 'keyup')).some((e) => e.key === 'Backspace'));

  const before = await page.evaluate(() => scrollY);
  await viewer.mouse.move(...point);
  await viewer.mouse.wheel(0, 200);
  await until(async () => (await page.evaluate(() => scrollY)) > before + 50);
  const wheel = (await readEvents(page, 'wheel')).at(-1);
  assert.ok(wheel?.trusted && wheel.y > 0, JSON.stringify(wheel));
}

async function phoneInput(page, viewer, tap) {
  assert.deepEqual(await viewer.evaluate(() => [innerWidth, innerHeight]), [PHONE.width, PHONE.height]);
  await viewer.locator('#mode [data-m=tap]').click();
  await tap(...await findPaintedPoint(viewer, 0));
  await assertHit(page, 'target');
}

const patchright = await import('patchright').catch(() => null);
const skips = {
  patchright: (!patchright || !fs.existsSync(patchright.chromium.executablePath())) &&
    'Patchright binary unavailable (install with npx patchright install chromium)',
  camoufox: process.env.TEST_CAMOUFOX !== '1' &&
    'set TEST_CAMOUFOX=1 and CAMOUFOX_INSTALL_DIR to the local Camoufox installation to run',
};

for (const engine of ['chromium', 'patchright', 'camoufox']) {
  if (process.env.ENGINE && process.env.ENGINE !== engine) continue;
  test(`live-view input on ${engine}`, { skip: skips[engine], timeout: 90000 }, async (t) => {
    const site = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(FIXTURE));
    await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => { site.close(resolve); site.closeAllConnections(); }));
    if (engine === 'camoufox') process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
    for (const phone of [false, true]) {
      await t.test(phone ? 'phone tap at DPR 2 and a different viewport and scroll offset' : 'desktop click, double-click, drag, typing and scroll', async () => {
        const engines = engine === 'camoufox' && phone ? configurableCamoufox() : undefined;
        const svc = await startBosun({ ENGINE: engine }, { engines });
        let client, viewing;
        try {
          client = await connect(svc);
          const session = await client.open({ engine });
          result(await client.call('navigate', { session, url: `http://127.0.0.1:${site.address().port}/` }));
          const { page } = svc.manager.sessions.get(session);
          if (phone) await resizeTarget(page, engine, 780, 610, 2);
          else if (engine === 'chromium') await resizeTarget(page, engine, 1040, 720, 1);
          await page.evaluate((phone) => {
            document.body.style.zoom = phone ? '1.25' : '1.1';
            scrollTo(0, phone ? 340 : 245);
          }, phone);
          const geometry = await page.evaluate(() => ({ dpr: devicePixelRatio, scroll: scrollY, width: visualViewport.width }));
          assert.equal(geometry.scroll, phone ? 340 : 245);
          if (phone) assert.equal(geometry.dpr, 2);
          t.diagnostic(JSON.stringify({ phone, ...geometry }));
          const { link } = result(await client.call('request_human', { session, reason: 'exercise live input' }));
          viewing = await openViewer(page, engine, link, phone);
          if (phone) await phoneInput(page, viewing.viewer, viewing.tap);
          else await desktopInput(page, viewing.viewer, engine);
          await viewing.viewer.locator('#done').click();
          assert.equal(result(await client.call('handoff_wait', { session, timeoutSec: 5 })).status, 'human-done');
        } finally {
          await viewing?.close();
          await client?.close();
          await svc.stop();
        }
      });
    }
  });
}
