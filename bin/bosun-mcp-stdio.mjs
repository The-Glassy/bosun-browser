#!/usr/bin/env node
// Bosun as a stdio MCP server: pipes newline-delimited JSON-RPC between stdin/stdout and Bosun's WebSocket (one
// JSON-RPC message per WebSocket frame). Env: BOSUN_URL (ws:// or wss://), BOSUN_TOKEN (sent as Authorization:
// Bearer, never in the URL and never printed), BOSUN_IDLE_EXIT_SEC (default 3600, 0 = never). Exit codes: 0 stdin
// ended or closed, stdout closed, the parent process gone, or idle; 1 connection failed or lost, 2 bad
// configuration, 3 authentication refused.
import WebSocket from 'ws';

const MAX_LINE = 2 * 1024 * 1024; // bytes; Bosun's maxPayload: a longer message would get the connection closed
const HANDSHAKE_MS = 15_000;
const MAX_PENDING = 8 * 1024 * 1024; // bytes read before the socket opens, or sent and not yet flushed
const PARENT_POLL_MS = 1000;
const IDLE_EXIT_SEC = 3600;

const die = (code, msg) => { process.stderr.write(`bosun-mcp-stdio: ${msg}\n`); process.exit(code); };
const warn = (msg) => process.stderr.write(`bosun-mcp-stdio: ${msg}\n`);

function bridgeTarget(env) {
  const raw = env.BOSUN_URL, token = env.BOSUN_TOKEN;
  if (!raw) throw new Error('BOSUN_URL is not set (e.g. ws://127.0.0.1:8002)');
  if (!token) throw new Error('BOSUN_TOKEN is not set');
  let u;
  try { u = new URL(raw); } catch { throw new Error('BOSUN_URL is not a valid URL'); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error(`BOSUN_URL must be ws:// or wss:// (got ${u.protocol})`);
  if (u.username || u.password || u.searchParams.has('token')) throw new Error('BOSUN_URL must not carry credentials; put the token in BOSUN_TOKEN');
  const idle = env.BOSUN_IDLE_EXIT_SEC ?? '';
  if (idle !== '' && !/^\d+$/.test(idle)) throw new Error(`BOSUN_IDLE_EXIT_SEC must be a whole number of seconds, 0 = never (got "${idle}")`);
  return { url: u.href, token, idleMs: (idle === '' ? IDLE_EXIT_SEC : Number(idle)) * 1000 };
}

// Splits stdin on LF only (a CR before it is dropped), with the byte limit enforced while reading: an oversized
// record is discarded up to its LF instead of being buffered.
function lineReader(onLine) {
  let parts = [], size = 0, skipping = false;
  const record = (buf) => {
    if (skipping) { skipping = false; return; }
    if (size + buf.length > MAX_LINE) { parts = []; size = 0; warn('dropped a message over 2 MiB'); return; }
    let line = Buffer.concat([...parts, buf]);
    parts = []; size = 0;
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, -1);
    onLine(line.toString('utf8'));
  };
  return (chunk) => {
    let start = 0, nl;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) { record(chunk.subarray(start, nl)); start = nl + 1; }
    const rest = chunk.subarray(start);
    if (!rest.length || skipping) return;
    if (size + rest.length > MAX_LINE) { parts = []; size = 0; skipping = true; warn('dropped a message over 2 MiB'); return; }
    parts.push(Buffer.from(rest)); size += rest.length;
  };
}

function run(env = process.env) {
  let target;
  try { target = bridgeTarget(env); } catch (e) { die(2, e.message); }
  const ws = new WebSocket(target.url, { headers: { authorization: `Bearer ${target.token}` }, handshakeTimeout: HANDSHAKE_MS, maxPayload: 64 * 1024 * 1024 });
  let stdinEnded = false;
  const queue = []; // lines read before the socket opened
  let queued = 0, paused = false;

  // The client is gone: close the socket and exit 0. The client may also be gone while stdin stays open (another
  // process holds its write end, as an orphan in a parent's process group would): then the parent's death or the
  // idle limit ends the bridge.
  const finish = (why) => {
    if (stdinEnded) return;
    stdinEnded = true;
    if (why) warn(why);
    if (ws.readyState === WebSocket.OPEN) ws.close(1000); // else the open handler flushes the queue and closes
    setTimeout(() => { ws.terminate(); process.exit(0); }, 2000).unref();
  };
  // Node has no PR_SET_PDEATHSIG: the parent is polled. Its death reparents the bridge (to init or a subreaper).
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) { warn(`parent process ${parent} is gone; exiting`); process.exit(0); } }, PARENT_POLL_MS).unref();
  // Idle: no message either way for idleMs while no request waits for its answer (a long handoff_wait is not idle).
  const waiting = new Set();
  let last = Date.now();
  const touch = () => { last = Date.now(); };
  if (target.idleMs > 0) {
    setInterval(() => {
      if (!waiting.size && Date.now() - last >= target.idleMs) { warn(`idle for ${Math.round(target.idleMs / 1000)} s; exiting`); process.exit(0); }
    }, Math.min(target.idleMs, 30_000)).unref();
  }
  const idOf = (m) => (m && (typeof m.id === 'string' || typeof m.id === 'number') ? JSON.stringify(m.id) : null);

  ws.on('unexpected-response', (_req, res) => {
    const code = res.statusCode;
    res.resume();
    if (code === 401 || code === 403) die(3, `authentication refused by ${target.url} (HTTP ${code}): check BOSUN_TOKEN`);
    die(1, `${target.url} refused the connection (HTTP ${code})`);
  });
  ws.on('error', (e) => { if (!stdinEnded) die(1, `connection to ${target.url} failed: ${e.message}`); process.exit(0); });
  ws.on('close', (code) => {
    if (stdinEnded) process.exit(0);
    die(1, `connection to ${target.url} closed (${code})`);
  });

  // Server -> stdout: one line per frame. Re-serialized, so a frame can never span or split lines.
  ws.on('message', (data) => {
    touch();
    let msg;
    try { msg = JSON.parse(data); } catch { warn('dropped a frame that is not JSON'); return; }
    if (msg && !msg.method) waiting.delete(idOf(msg)); // a response
    if (!process.stdout.write(`${JSON.stringify(msg)}\n`)) { ws.pause(); process.stdout.once('drain', () => ws.resume()); }
  });

  // stdin -> server: one frame per non-empty line. Only parseable JSON is forwarded.
  // Before open: queued up to MAX_PENDING. After: stdin pauses while the socket has MAX_PENDING unflushed.
  const send = (line) => {
    if (ws.readyState !== WebSocket.OPEN) {
      queued += Buffer.byteLength(line);
      if (queued > MAX_PENDING) die(1, 'more than 8 MiB of input before the connection opened');
      queue.push(line);
      return;
    }
    ws.send(line, () => { if (paused && ws.bufferedAmount < MAX_PENDING / 2) { paused = false; process.stdin.resume(); } });
    if (!paused && ws.bufferedAmount > MAX_PENDING) { paused = true; process.stdin.pause(); }
  };
  process.stdin.on('data', lineReader((line) => {
    touch();
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { warn('dropped a line that is not JSON'); return; }
    if (msg && typeof msg.method === 'string' && idOf(msg) !== null) waiting.add(idOf(msg)); // a request
    if (msg?.method === 'notifications/cancelled') waiting.delete(idOf({ id: msg.params?.requestId })); // may get no answer
    send(line);
  }));
  process.stdin.on('end', () => finish());
  process.stdin.on('close', () => finish());
  process.stdin.on('error', () => finish());
  // Nobody reads the answers any more (EPIPE).
  process.stdout.on('error', () => { if (!stdinEnded) warn('stdout closed; exiting'); process.exit(0); });
  ws.on('open', () => {
    for (const line of queue.splice(0)) send(line);
    queued = 0;
    if (stdinEnded) ws.close(1000);
  });
}

run();
