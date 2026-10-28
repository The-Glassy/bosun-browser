// Configuration and authentication guarantees: no unauthenticated network listener, validated limits,
// constant-time token comparison.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { loadConfig } from '../src/config.mjs';
import { createAuthenticator, isLoopbackHost, tokenFromRequest } from '../src/auth.mjs';
import { tmpDir } from './helpers.mjs';

const SERVER = new URL('../src/server.mjs', import.meta.url).pathname;
const GOOD = 'x'.repeat(24);

test('WebSocket on a non-loopback host without a token is refused', () => {
  assert.throws(() => loadConfig({ WS_PORT: '7360', WS_HOST: '0.0.0.0' }), /refusing to listen on 0\.0\.0\.0 without BROWSER_TOKEN/);
  assert.throws(() => loadConfig({ WS_PORT: '7360', WS_HOST: '10.0.0.5', ALLOW_NO_TOKEN: '1' }), /refusing to listen/);
  assert.throws(() => loadConfig({ WS_PORT: '7360', WS_HOST: '0.0.0.0', BROWSER_TOKEN: '' }), /refusing to listen/);
  assert.equal(loadConfig({ WS_PORT: '7360', WS_HOST: '0.0.0.0', BROWSER_TOKEN: GOOD }).ws.host, '0.0.0.0');
});

test('loopback without a token needs an explicit ALLOW_NO_TOKEN=1', () => {
  assert.throws(() => loadConfig({ WS_PORT: '7360' }), /ALLOW_NO_TOKEN=1/);
  assert.equal(loadConfig({ WS_PORT: '7360', ALLOW_NO_TOKEN: '1' }).ws.allowNoToken, true);
  assert.equal(loadConfig({ WS_PORT: '7360', WS_HOST: 'localhost', ALLOW_NO_TOKEN: '1' }).ws.allowNoToken, true);
});

test('tokens: minimum length, tenant names, no duplicates', () => {
  assert.throws(() => loadConfig({ BROWSER_TOKEN: 'short' }), /shorter than 16/);
  assert.throws(() => loadConfig({ BROWSER_TOKENS: `Bad Tenant:${GOOD}` }), /tenant name/);
  assert.throws(() => loadConfig({ BROWSER_TOKENS: `a:${GOOD},b:${GOOD}` }), /share the same token/);
  assert.throws(() => loadConfig({ BROWSER_TOKENS: GOOD }), /<tenant>:<token>/);
  assert.deepEqual(loadConfig({ BROWSER_TOKENS: `a:${GOOD}1,b:${GOOD}2` }).tokens.map((t) => t.tenant), ['a', 'b']);
});

test('numeric settings are validated (no NaN disabling the session cap)', () => {
  assert.throws(() => loadConfig({ MAX_SESSIONS: 'lots' }), /MAX_SESSIONS must be a whole number/);
  assert.throws(() => loadConfig({ MAX_SESSIONS: '0' }), /between 1/);
  assert.throws(() => loadConfig({ MAX_SESSIONS: '2.5' }), /whole number/);
  assert.throws(() => loadConfig({ WS_PORT: '99999', BROWSER_TOKEN: GOOD }), /WS_PORT/);
  assert.throws(() => loadConfig({ LIVE_PORT: '7350', LIVE_BASE_URL: 'javascript:alert(1)' }), /http\(s\)/);
  assert.equal(loadConfig({}).maxSessions, 3);
});

test('ElevenLabs TTS model and the default meeting_speak backend: defaults, validation, fallback without a key', () => {
  const KEY = { ELEVENLABS_API_KEY: 'el-key-0123456789' };
  const d = loadConfig({});
  assert.equal(d.ttsDefaultBackend, 'supertonic');
  assert.equal(d.ttsWarning, null);
  assert.equal(loadConfig(KEY).elevenlabs.ttsModel, 'eleven_v4_turbo');
  assert.equal(loadConfig({ ...KEY, ELEVENLABS_TTS_MODEL: 'eleven_flash_v2_5' }).elevenlabs.ttsModel, 'eleven_flash_v2_5');
  for (const bad of ['ab', 'Eleven_V4', 'eleven-v4', 'x'.repeat(61), 'a b c']) {
    assert.throws(() => loadConfig({ ...KEY, ELEVENLABS_TTS_MODEL: bad }), /ELEVENLABS_TTS_MODEL must be/, bad);
  }
  assert.throws(() => loadConfig({ ELEVENLABS_TTS_MODEL: 'Bad!' }), /ELEVENLABS_TTS_MODEL must be/, 'checked also without a key');
  assert.equal(loadConfig({ ...KEY, ELEVENLABS_VOICE: 'SAz9YHcvj6GT2YYXdXww' }).elevenlabs.voice, 'SAz9YHcvj6GT2YYXdXww');
  assert.equal(loadConfig({ TTS_DEFAULT_BACKEND: 'supertonic' }).ttsDefaultBackend, 'supertonic');
  const el = loadConfig({ ...KEY, TTS_DEFAULT_BACKEND: 'elevenlabs' });
  assert.equal(el.ttsDefaultBackend, 'elevenlabs');
  assert.equal(el.ttsWarning, null);
  // elevenlabs without a key: supertonic, and a warning.
  const fb = loadConfig({ TTS_DEFAULT_BACKEND: 'elevenlabs' });
  assert.equal(fb.ttsDefaultBackend, 'supertonic');
  assert.match(fb.ttsWarning, /TTS_DEFAULT_BACKEND=elevenlabs but ELEVENLABS_API_KEY is not set: meeting_speak uses supertonic/);
  for (const bad of ['openai', 'ElevenLabs', ' supertonic']) assert.throws(() => loadConfig({ TTS_DEFAULT_BACKEND: bad }), /TTS_DEFAULT_BACKEND must be supertonic or elevenlabs/, bad);
});

test('isLoopbackHost', () => {
  for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) assert.ok(isLoopbackHost(h), h);
  for (const h of ['0.0.0.0', '::', '10.0.0.1', '192.168.1.2', 'example.com', '']) assert.ok(!isLoopbackHost(h), h);
});

test('token comparison uses crypto.timingSafeEqual over every entry', () => {
  const spy = mock.method(crypto, 'timingSafeEqual');
  try {
    const auth = createAuthenticator([{ tenant: 'a', token: `${GOOD}a` }, { tenant: 'b', token: `${GOOD}b` }]);
    assert.equal(auth(`${GOOD}a`), 'a');
    assert.equal(auth(`${GOOD}b`), 'b');
    assert.equal(auth(`${GOOD}c`), null);
    assert.equal(auth('x'), null); // different length: still compared as fixed-length digests
    assert.equal(auth(''), null);
    assert.equal(auth(null), null);
    assert.equal(spy.mock.callCount(), 12); // 6 calls x 2 entries, no short-circuit
    for (const c of spy.mock.calls) assert.equal(c.arguments[0].length, 32);
  } finally {
    spy.mock.restore();
  }
});

test('token from Authorization header is preferred over ?token=', () => {
  const q = new URLSearchParams('token=fromquery');
  assert.equal(tokenFromRequest({ headers: { authorization: 'Bearer fromheader' } }, q), 'fromheader');
  assert.equal(tokenFromRequest({ headers: {} }, q), 'fromquery');
  assert.equal(tokenFromRequest({ headers: {} }, new URLSearchParams()), null);
});

function run(env, waitFor) {
  return new Promise((resolve) => {
    // CHROMIUM_SANDBOX=0 because these are configuration tests: startup otherwise launches the browser once to
    // prove its sandbox works, which a container or CI box usually cannot (that path is covered in
    // features.test.mjs). LD_LIBRARY_PATH comes along for hosts where the browser's libraries are not in the
    // default search path.
    const p = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '', BROWSER_DATA: tmpDir(), HEADLESS: '1', CHROMIUM_SANDBOX: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    const done = (code) => { clearTimeout(t); resolve({ code, err }); };
    p.stderr.on('data', (d) => { err += d; if (waitFor && waitFor.test(err)) { p.kill('SIGTERM'); } });
    p.on('exit', (code) => done(code));
    const t = setTimeout(() => p.kill('SIGKILL'), 15000);
  });
}

test('the server process refuses to start on 0.0.0.0 without BROWSER_TOKEN', async () => {
  const r = await run({ WS_PORT: '0', WS_HOST: '0.0.0.0' });
  assert.equal(r.code, 1);
  assert.match(r.err, /refusing to listen on 0\.0\.0\.0 without BROWSER_TOKEN/);
});

test('the server process starts with a token and never logs it', async () => {
  const r = await run({ WS_PORT: '0', WS_HOST: '127.0.0.1', BROWSER_TOKEN: GOOD }, /MCP over WebSocket/);
  assert.match(r.err, /MCP over WebSocket on 127\.0\.0\.1:\d+/);
  assert.ok(!r.err.includes(GOOD));
  assert.equal(r.code, 0); // SIGTERM -> clean shutdown
});

test('the server process warns at start when TTS_DEFAULT_BACKEND=elevenlabs has no ElevenLabs key', async () => {
  const r = await run({ WS_PORT: '0', WS_HOST: '127.0.0.1', BROWSER_TOKEN: GOOD, TTS_DEFAULT_BACKEND: 'elevenlabs' }, /MCP over WebSocket/);
  assert.match(r.err, /bosun: WARNING — TTS_DEFAULT_BACKEND=elevenlabs but ELEVENLABS_API_KEY is not set: meeting_speak uses supertonic/);
  assert.equal(r.code, 0);
});
