import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pages, PAT, FEED, GITHUB, JWT, AWS, ENTROPY, HEX, LONG_WORD, URL as URL_PAGE } from './fixtures/secret-pages.mjs';
import { maskedScreenshot, sensitiveValues } from '../src/redact.mjs';
import { startBosun, connect } from './helpers.mjs';

let server, base, svc;
before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pages[req.url] || 'missing fixture');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  svc = await startBosun();
});
after(async () => {
  await svc?.stop();
  if (server?.listening) await new Promise((r) => { server.closeAllConnections(); server.close(r); });
});
async function onPage(path, fn) {
  const client = await connect(svc);
  try {
    const session = await client.open();
    const nav = await client.call('navigate', { session, url: `${base}${path}` });
    assert.equal(nav.isError, false, nav.text);
    await fn(client, session, svc.manager.sessions.get(session).page);
  } finally { await client.close(); }
}
async function reads(c, session, secrets) {
  for (const mode of ['a11y', 'text']) {
    const result = await c.call('read', { session, mode });
    assert.equal(result.isError, false, result.text);
    for (const secret of secrets) assert.ok(!result.text.includes(secret), `${mode}: leaked ${secret}\n${result.text}`);
  }
}
for (const [path, secrets] of [
  ['/gitlab', [PAT, FEED, 'aria-copy-secret-opaque-739124', 'display-copy-token-opaque-739123']],
  ['/github', [GITHUB]], ['/generic', [PAT]],
  ['/formats', [JWT, AWS, PAT, GITHUB, 'ghp_SplitInlineFixture0123456789', 'Zml4dHVyZS1wcml2YXRlLWtleS1ib2R5']],
  ['/entropy', [ENTROPY, HEX]],
]) test(`${path}: a11y and text hide credentials`, () => onPage(path, (c, session) => reads(c, session, secrets)));

test('field hints cover every metadata source, case and separator, without masking labels', () => onPage('/ordinary', async (c, session, page) => {
  await page.setContent(`<h1>token pinned spinner Tokenized</h1>
    <input name="api_key" value="opaque-a1"><input id="private-key" value="opaque-a2">
    <input aria-label="CLIENT SECRET" value="opaque-a3"><input autocomplete="feed-token" value="opaque-a4">
    <input placeholder="Secret" value="opaque-a5"><input data-kind="ToKeN" value="opaque-a6">
    <input data-api-key="true" value="opaque-a7"><label>Access token<input value="opaque-a8"></label>
    <span id="feed_token_label">Feed token</span><textarea aria-labelledby="feed_token_label">opaque-a9</textarea>
    <output aria-label="API key">opaque-b1</output><div readonly id="private_key">opaque-b2</div>`);
  const values = await sensitiveValues(page);
  assert.ok(!values.includes('Feed token'));
  for (const suffix of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'b1', 'b2']) assert.ok(values.includes(`opaque-${suffix}`), suffix);
  await reads(c, session, values);
  const a11y = (await c.call('read', { session })).text;
  assert.match(a11y, /heading "token pinned spinner Tokenized"/);
  assert.match(a11y, /Feed token/);
}));

test('ordinary long words, URLs and pinned/spinner/Tokenized fields remain readable', () => onPage('/ordinary', async (c, session, page) => {
  assert.deepEqual(await sensitiveValues(page), []);
  for (const mode of ['a11y', 'text']) {
    const r = await c.call('read', { session, mode });
    assert.equal(r.isError, false, r.text);
    for (const word of ['token', 'Tokenized headings', 'pinned spinner', LONG_WORD, URL_PAGE]) assert.ok(r.text.includes(word), r.text);
    assert.ok(!r.text.includes('[masked]'), r.text);
    if (mode === 'a11y') for (const v of ['keep-pinned', 'keep-spinner', 'keep-tokenized']) assert.ok(r.text.includes(v), r.text);
  }
}));

test('hidden reveal copies stay hidden even when selected as the read root', () => onPage('/gitlab', async (c, session) => {
  for (const selector of ['#hidden-copy', '#aria-copy', '#display-copy']) {
    for (const mode of ['a11y', 'text']) {
      const r = await c.call('read', { session, selector, mode });
      assert.equal(r.isError, false, r.text);
      for (const v of [FEED, 'aria-copy-secret-opaque-739124', 'display-copy-token-opaque-739123']) assert.ok(!r.text.includes(v), r.text);
    }
  }
}));

test('redaction precedes maxChars truncation and covers title, URL and accessible names', () => onPage('/generic', async (c, session, page) => {
  await page.setContent(`<title>${PAT}</title><p>${PAT}</p><button aria-label="${GITHUB}">Copy</button>`);
  await page.evaluate((s) => history.replaceState(null, '', `?key=${s}`), AWS);
  for (const mode of ['text', 'a11y']) for (const maxChars of [1, 9, 16, 20000]) {
    const r = await c.call('read', { session, mode, maxChars });
    assert.equal(r.isError, false, r.text);
    for (const tail of [PAT.slice(6, 10), GITHUB.slice(4, 10), AWS.slice(4)]) assert.ok(!r.text.includes(tail), r.text);
  }
}));

// Decode in the browser to inspect actual pixels, without an extra image dependency.
async function assertBoxes(page, data, selectors) {
  const points = [];
  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, selector);
    points.push([Math.floor(box.x + box.width / 2), Math.floor(box.y + box.height / 2)]);
  }
  const colors = await page.evaluate(async ({ data, points }) => {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${data}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return points.map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]);
  }, { data, points });
  for (const [r, g, b, a] of colors) assert.ok(r >= 240 && g <= 20 && b >= 240 && a === 255, `expected opaque magenta mask, got ${[r, g, b, a]}`);
}
test('screenshot draws opaque boxes over token inputs, JWT, AWS and PEM; markers are removed', () => onPage('/formats', async (c, session, page) => {
  await page.locator('body').evaluate((el, token) => el.insertAdjacentHTML('beforeend', `<input id="generic" readonly value="${token}">`), PAT);
  const shot = await c.call('screenshot', { session });
  assert.equal(shot.isError, false, shot.text);
  await assertBoxes(page, shot.result.content.find((x) => x.type === 'image').data, ['#jwt', '#aws', '#pem', '#generic', '#split']);
  assert.equal(await page.locator('[data-bosun-sensitive]').count(), 0);
  await assert.rejects(maskedScreenshot(page, async (mask) => {
    assert.equal(await mask[0].evaluateAll((els) => els.some((e) => /^(BODY|HTML|H1)$/.test(e.tagName))), false);
    throw new Error('capture failed');
  }), /capture failed/);
  assert.equal(await page.locator('[data-bosun-sensitive]').count(), 0);
}));

test('macro read and screenshot steps use the same redaction', () => onPage('/formats', async (c, session, page) => {
  const save = await c.call('macro_save', { name: 'masked-read', site: [new URL(base).host], steps: [
    { tool: 'read', mode: 'a11y', as: 'a11y' }, { tool: 'read', mode: 'text', as: 'text' }, { tool: 'screenshot' },
  ] });
  assert.equal(save.isError, false, save.text);
  const result = await c.call('macro_run', { name: 'masked-read', session });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.json().ok, true, result.text);
  for (const v of [JWT, AWS, PAT, GITHUB, 'Zml4dHVyZS1wcml2YXRlLWtleS1ib2R5']) assert.ok(!result.text.includes(v), result.text);
  assert.equal(result.json().reads.length, 2);
  await assertBoxes(page, result.result.content.find((x) => x.type === 'image').data, ['#jwt', '#aws', '#pem']);
}));
