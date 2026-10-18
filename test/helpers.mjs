// Test helpers: a local page server (no internet), an in-process Bosun service, MCP clients over WebSocket.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { loadConfig } from '../src/config.mjs';
import { startService } from '../src/bosun.mjs';

export const TOKEN = 'test-token-0123456789abcdef';
export const ENGINE = process.env.ENGINE || 'chromium'; // run the suites per engine: ENGINE=camoufox npm test
export const TOKEN_B = 'test-token-bbbbbbbbbbbbbbbb';

const PAGES = {
  '/': '<title>Home</title><h1>Hello Bosun</h1><a href="/second">next</a>',
  '/second': '<title>Second</title><p>second page</p>',
  '/login': `<title>Login</title><form>
    <label>Email <input id="email" name="email" value=""></label>
    <label>Password <input id="pw" type="password"></label>
    <input id="unnamed" type="password">
    <label>PIN <input id="pin" name="pin"></label>
    <input id="mdp" aria-label="Mot de passe">
    <input id="otp" autocomplete="one-time-code">
    <input id="note" name="note">
  </form>`,
  '/late': `<title>Late</title><p>waiting</p><script>setTimeout(() => { const d = document.createElement('div'); d.id = 'late'; d.textContent = 'arrived'; document.body.append(d); }, 800)</script>`,
  '/toggle': `<title>Toggle</title><input id="t" type="password" value="pre-scan-toggled"><script>document.getElementById('t').type = 'text'</script>`,
  '/shadow': `<title>Shadow</title><div id="host"></div><script>const r = document.getElementById('host').attachShadow({ mode: 'open' }); r.innerHTML = '<span id="l">PIN</span><input id="s" aria-labelledby="l">';</script>`,
  '/bigshadow': `<title>Big</title><div id="host"></div><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<i></i>'.repeat(500);</script>`,
  '/probe': `<title>Probe</title><button id="check" onclick="document.getElementById('out').textContent = 'syms=' + JSON.stringify(Object.getOwnPropertySymbols(window).map(String)) + ' shadow=' + (/native code/.test(Element.prototype.attachShadow.toString()) ? 'native' : 'patched')">check</button><p id="out"></p>`,
  '/toggle-later': `<title>Toggle later</title><input id="t" type="password" value="pre-scan-toggled"><script>setTimeout(() => { document.getElementById('t').type = 'text'; }, 400)</script>`,
  '/dshadow': `<title>Declarative shadow</title><div id="host"><template shadowrootmode="open"><input id="dp" type="password" value="decl-shadow-secret"></template></div><script>setTimeout(() => { document.getElementById('host').shadowRoot.getElementById('dp').type = 'text'; }, 400)</script>`,
  '/popups': `<title>Popups</title><script>for (let i = 0; i < 10; i++) window.open('/second?' + i)</script>`,
};

export async function startPageServer() {
  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/secret-title') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<title>Code 424242</title><p>otp page</p>`);
    }
    const body = PAGES[p];
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body || 'not found');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }) };
}

export function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-test-')); }

export async function startBosun(env = {}, opts = {}) {
  const dataDir = tmpDir();
  const cfg = loadConfig({
    HEADLESS: '1', BROWSER_DATA: dataDir, WS_PORT: '0', LIVE_PORT: '0', BROWSER_TOKENS: `alice:${TOKEN},bob:${TOKEN_B}`,
    MAX_SESSIONS: '4', ...(process.env.ENGINE ? { ENGINE: process.env.ENGINE } : {}), ...env,
  });
  const svc = await startService(cfg, opts);
  return {
    ...svc,
    dataDir,
    wsUrl: `ws://127.0.0.1:${svc.ws.port}`,
    async stop() { await svc.shutdown(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

// MCP client transport over ws (supports headers, which the SDK's browser-style WebSocket transport does not).
class ClientWsTransport {
  constructor(url, headers) { this.url = url; this.headers = headers; }
  start() {
    return new Promise((resolve, reject) => {
      const ws = this.ws = new WebSocket(this.url, { headers: this.headers });
      ws.on('open', resolve);
      ws.on('error', (e) => { reject(e); this.onerror?.(e); });
      ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.on('message', (d) => this.onmessage?.(JSON.parse(d)));
      ws.on('close', () => this.onclose?.());
    });
  }
  async send(msg) { this.ws.send(JSON.stringify(msg)); }
  async close() { this.ws.close(); }
}

export async function connect(svc, token = TOKEN) {
  const t = new ClientWsTransport(svc.wsUrl, token ? { authorization: `Bearer ${token}` } : {});
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(t);
  c.transportWs = t;
  // call: returns { text, isError, result }
  c.call = async (name, args = {}, opts) => {
    let r;
    try { r = await c.callTool({ name, arguments: args }, undefined, opts); } catch (e) { return { isError: true, text: e.message }; }
    const text = (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    return { isError: !!r.isError, text, result: r, json: () => JSON.parse(text) };
  };
  c.open = async (args = {}) => {
    const r = await c.call('session_open', args);
    if (r.isError) throw new Error(r.text);
    return r.json().session;
  };
  return c;
}

// Raw HTTP/1.1 exchange (for malformed request targets the http client refuses to send).
export function rawRequest(port, text) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(text));
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('close', () => resolve(buf));
    sock.on('error', () => resolve(buf));
    setTimeout(() => sock.destroy(), 3000);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(step);
  }
}

// Live-view viewer: claim a link over WebSocket. Resolves once open, with the issued viewer key when given.
export function viewer(link, { key, origin } = {}) {
  const u = link.replace(/^http/, 'ws').replace('/v/', '/ws/') + (key ? `?v=${key}` : '');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u, origin ? { origin } : {});
    const v = { ws, frames: 0, ends: [], key: null, closed: false };
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.viewer) v.key = m.viewer;
      if (m.frame) v.frames++;
      if (m.end) v.ends.push(m.end);
    });
    ws.on('close', () => { v.closed = true; });
    ws.on('open', () => resolve(v));
    ws.on('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
  });
}
