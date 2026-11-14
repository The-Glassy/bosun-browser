// Deterministic browser regressions for the review's label and scan/extraction races.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect } from './helpers.mjs';
import { sensitiveValues, readText, maskedScreenshot } from '../src/redact.mjs';

async function fixture(t) {
  const svc = await startBosun();
  let c; t.after(async () => { await c?.close(); await svc.stop(); });
  c = await connect(svc);
  const s = await c.open();
  const page = [...svc.manager.sessions.values()].find((x) => x.id === s).page;
  return { c, s, page };
}

test('shadowed labels preserve wrapping and for label credentials, reflection and screenshot coverage', async (t) => {
  const { page } = await fixture(t);
  await page.setContent(`<label>API key <input id="a" value="opaque-wrap-value"></label><p id="ra">opaque-wrap-value</p>
    <label for="b">Password</label><input id="b" value="opaque-for-value"><p id="rb">opaque-for-value</p>
    <div id="host"></div><input id="q" name="search_query" value="ordinary-search">
    <span id="custom-label">API key</span><div id="widget">opaque-widget-value</div><p id="rw">opaque-widget-value</p>
    <label for="cf">API key</label><x-field id="cf" value="opaque-associated-value">opaque-associated-value</x-field><p id="rcf">opaque-associated-value</p><script>
    customElements.define('x-field', class extends HTMLElement {
      static formAssociated = true;
      constructor() { super(); this.internals = this.attachInternals(); }
      get labels() { return this.internals.labels; }
    });</script>`);
  await page.evaluate(() => {
    document.querySelector('#widget').labels = [document.querySelector('#custom-label')];
    document.querySelector('#host').attachShadow({ mode: 'open' }).innerHTML = '<label for="c">API key</label><input id="c" value="opaque-shadow-value"><p id="rc">opaque-shadow-value</p>';
    for (const el of [...document.querySelectorAll('input'), document.querySelector('#host').shadowRoot.querySelector('input')]) Object.defineProperty(el, 'labels', { get() { if (el.id === 'b') throw new Error('shadowed'); return { weird: true }; } });
  });
  const values = await sensitiveValues(page);
  for (const value of ['opaque-wrap-value', 'opaque-for-value', 'opaque-shadow-value', 'opaque-widget-value', 'opaque-associated-value']) assert.ok(values.includes(value), value);
  assert.ok(!values.includes('ordinary-search'));
  const [, text] = await readText(page.locator('body'), 10000, values);
  assert.ok(!text.includes('opaque-')); assert.ok(text.includes('[masked]'));
  await maskedScreenshot(page, async (mask) => {
    for (const id of ['a', 'b', 'c', 'ra', 'rb', 'rc', 'widget', 'rw', 'cf', 'rcf']) assert.equal(await page.locator(`#${id}`).getAttribute('data-bosun-sensitive'), '');
    const covered = await page.screenshot({ mask });
    const plain = await page.screenshot();
    assert.ok(!covered.equals(plain), 'screenshot pixels change when the masks are applied');
  });
  assert.equal(await page.locator('[data-bosun-sensitive]').count(), 0);
});

test('macro assert rescans rotated credentials atomically and keeps failure diagnostics masked', async (t) => {
  const { c, s, page } = await fixture(t);
  await page.setContent('<input type="password" value="old-secret"><p id="mirror">old-secret<span aria-hidden="true">hidden-copy</span></p>');
  const frame = page.mainFrame(), evaluate = frame.evaluate.bind(frame);
  let rotations = 0;
  frame.evaluate = async (fn, arg) => {
    const result = await evaluate(fn, arg);
    if (arg?.op === 'values') { rotations++; await evaluate(() => { document.querySelector('input').value = 'rotated-secret'; document.querySelector('#mirror').firstChild.nodeValue = 'rotated-secret'; }); }
    return result;
  };
  t.after(() => { frame.evaluate = evaluate; });
  const saved = await c.call('macro_save', { name: 'rotation', site: ['example.test'], steps: [
    { tool: 'assert', selector: '#mirror' }, { tool: 'assert', selector: '#missing', timeoutMs: 100 },
  ] });
  assert.equal(saved.isError, false, saved.text);
  const response = await c.call('macro_run', { name: 'rotation', session: s });
  const result = response.json();
  assert.ok(rotations > 0);
  assert.equal(result.steps[0].text, '[masked]');
  assert.equal(result.ok, false);
  assert.ok(!response.text.includes('rotated-secret')); assert.ok(!response.text.includes('old-secret'));
});

for (const removeFrame of [false, true]) test(`macro assert omits matched text when a credential source ${removeFrame ? 'frame disappears after scanning' : 'is in another frame'}`, async (t) => {
  const { c, s, page } = await fixture(t);
  await page.setContent(`<iframe srcdoc='<input type="password" value="old-frame-secret">'></iframe><p id="mirror">old-frame-secret</p>`);
  const frames = page.frames(); assert.equal(frames.length, 2);
  const originals = frames.map((f) => f.evaluate.bind(f)); let scans = 0;
  frames.forEach((frame, i) => {
    frame.evaluate = async (fn, arg) => {
      const result = await originals[i](fn, arg);
      if (arg?.op === 'values' && ++scans === frames.length) await originals[0](() => {
        document.querySelector('iframe').contentDocument.querySelector('input').value = 'rotated-frame-secret';
        document.querySelector('#mirror').textContent = 'rotated-frame-secret';
      });
      if (arg?.op === 'values' && scans === frames.length && removeFrame) await originals[0](() => document.querySelector('iframe')?.remove());
      return result;
    };
  });
  t.after(() => frames.forEach((f, i) => { f.evaluate = originals[i]; }));
  assert.equal((await c.call('macro_save', { name: 'frame-rotation', site: ['example.test'], steps: [
    { tool: 'assert', selector: '#mirror' }, ...(!removeFrame ? [{ tool: 'assert', selector: '#missing', timeoutMs: 100 }] : []),
  ] })).isError, false);
  const response = await c.call('macro_run', { name: 'frame-rotation', session: s });
  assert.ok(scans >= frames.length);
  assert.equal(response.json().steps[0].status, 'ok');
  assert.equal(response.json().steps[0].text, undefined);
  assert.ok(!response.text.includes('rotated-frame-secret')); assert.ok(!response.text.includes('old-frame-secret'));
});
