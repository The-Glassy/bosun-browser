// A rejection from inside the browser driver that no caller can catch must not take the service down. Playwright's
// Firefox driver (camoufox) asserts on the events of a WebSocket opened in a worker; without the guard, Node ends the
// process on that unhandled rejection, and every tenant's sessions and handoffs with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import { spawn } from 'child_process';
import { WebSocketServer } from 'ws';
import { isDriverRejection } from '../src/bosun.mjs';
import { connect, until, tmpDir, TOKEN } from './helpers.mjs';

const BOSUN = new URL('../src/bosun.mjs', import.meta.url).href;
const SERVER = new URL('../src/server.mjs', import.meta.url).pathname;

test('only rejections from inside the driver count as driver rejections', () => {
  const driver = Object.assign(new Error('Assertion error'), { stack: 'Error: Assertion error\n    at assert (/x/node_modules/playwright-core/lib/coreBundle.js:885:11)' });
  const patch = Object.assign(new Error('x'), { stack: 'Error: x\n    at f (C:\\x\\node_modules\\patchright-core\\lib\\a.js:1:1)' });
  assert.equal(isDriverRejection(driver), true);
  assert.equal(isDriverRejection(patch), true);
  assert.equal(isDriverRejection(new Error('ours')), false);
  assert.equal(isDriverRejection('a string'), false);
  assert.equal(isDriverRejection(null), false);
});

// Runs a tiny process with the guard installed and one unhandled rejection; returns its exit code and stderr.
function guarded(stackLine) {
  const code = `import { guardDriverRejections } from ${JSON.stringify(BOSUN)};
    guardDriverRejections();
    const e = new Error('boom'); e.stack = 'Error: boom\\n' + ${JSON.stringify(stackLine)};
    Promise.reject(e);
    setTimeout(() => { console.error('still running'); process.exit(0); }, 300);`;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (status) => resolve({ status, err }));
  });
}

test('the guard logs a driver rejection and keeps the process; anything else still ends it', async () => {
  const kept = await guarded('    at assert (/x/node_modules/playwright-core/lib/coreBundle.js:885:11)');
  assert.equal(kept.status, 0, kept.err);
  assert.match(kept.err, /bosun: browser driver error, ignored: boom/);
  assert.match(kept.err, /still running/);
  const ended = await guarded('    at ours (/x/src/sessions.mjs:1:1)');
  assert.notEqual(ended.status, 0);
  assert.doesNotMatch(ended.err, /still running/);
});

test('the service survives a worker WebSocket on camoufox', { skip: process.env.ENGINE !== 'camoufox' && 'the driver assertion is Firefox-only (ENGINE=camoufox)' }, async () => {
  const srv = http.createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'text/html' });
    r.end(`<title>WS</title><p id="out">pending</p><script>
      const to = 'ws://' + location.host + '/s';
      const blob = new Blob(['const w = new WebSocket(' + JSON.stringify(to) + '); w.onmessage = (e) => postMessage("worker " + e.data);'], { type: 'application/javascript' });
      new Worker(URL.createObjectURL(blob)).onmessage = (e) => { document.getElementById('out').textContent = e.data; };
    </script>`);
  });
  new WebSocketServer({ server: srv }).on('connection', (ws) => ws.send('hi'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const p = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '', BROWSER_DATA: tmpDir(), HEADLESS: '1', CHROMIUM_SANDBOX: '0', ENGINE: 'camoufox', WS_PORT: '0', BROWSER_TOKENS: `alice:${TOKEN}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '', exited = null;
  p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (status) => { exited = status; });
  try {
    const port = Number((await until(() => /MCP over WebSocket on [^\s]+:(\d+)/.exec(err), 60000))[1]);
    const c = await connect({ wsUrl: `ws://127.0.0.1:${port}` }, TOKEN);
    const s = await c.open();
    await c.call('navigate', { session: s, url: `http://127.0.0.1:${srv.address().port}/` });
    assert.equal((await c.call('wait_for', { session: s, text: 'worker hi', timeoutMs: 15000 })).isError, false);
    await until(() => err.includes('browser driver error, ignored'), 10000);
    // Still serving: the same session answers, and a new one opens.
    assert.equal((await c.call('read', { session: s, mode: 'text' })).isError, false);
    await c.open();
    assert.equal(exited, null, err);
    await c.close();
  } finally {
    p.kill('SIGTERM');
    await new Promise((r) => (exited !== null ? r() : p.once('exit', r)));
    await new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
  }
});
