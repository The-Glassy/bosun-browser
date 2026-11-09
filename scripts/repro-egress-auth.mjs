// Compare the original fixture's bare 407 with a valid Basic challenge, using the same exit as the tests.
// Run: node scripts/repro-egress-auth.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { fixture } from '../test/egress-fixture.mjs';
import { parseEgress } from '../src/egress.mjs';
import { CHROMIUM_ARGS, PROXY_ARGS } from '../src/engines.mjs';

for (const challenge of [false, true]) {
  const cleanup = [];
  try {
    const f = await fixture({ after: (fn) => cleanup.push(fn) }, { challenge });
    const attempts = [];
    f.exit.prependListener('request', (req) => {
      attempts.push({ url: req.url, authenticated: !!req.headers['proxy-authorization'] });
    });
    const browser = await chromium.launch({ headless: true, proxy: parseEgress(f.url), args: [...CHROMIUM_ARGS, ...PROXY_ARGS] });
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    const response = await page.goto('http://exit-only.invalid/page', { waitUntil: 'domcontentloaded' });
    const result = { challenge, status: response.status(), title: await page.title(), attempts, forwarded: f.requests.length, directConnections: f.directConnections() };
    console.log(JSON.stringify(result));
    assert.equal(result.status, challenge ? 200 : 407);
    assert.equal(result.title, challenge ? 'Exit' : '');
    assert.equal(f.requests.some((r) => r.url === 'http://exit-only.invalid/page'), challenge);
    assert.equal(f.directConnections(), 0);
  } finally {
    for (const fn of cleanup.reverse()) await fn();
  }
}
