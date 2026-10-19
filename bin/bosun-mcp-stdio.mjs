#!/usr/bin/env node
// Bosun as a stdio MCP server: pipes newline-delimited JSON-RPC between stdin/stdout and Bosun's WebSocket (one
// JSON-RPC message per WebSocket frame). Env: BOSUN_URL (ws:// or wss://), BOSUN_TOKEN (sent as Authorization:
// Bearer, never in the URL and never printed). Exit codes: 0 stdin ended, 1 connection failed or lost, 2 bad
// configuration, 3 authentication refused.
import readline from 'readline';
import WebSocket from 'ws';

const MAX_LINE = 1024 * 1024; // Bosun's maxPayload: a longer message would get the connection closed

const die = (code, msg) => { process.stderr.write(`bosun-mcp-stdio: ${msg}\n`); process.exit(code); };

function bridgeTarget(env) {
  const raw = env.BOSUN_URL, token = env.BOSUN_TOKEN;
  if (!raw) throw new Error('BOSUN_URL is not set (e.g. ws://127.0.0.1:8002)');
  if (!token) throw new Error('BOSUN_TOKEN is not set');
  let u;
  try { u = new URL(raw); } catch { throw new Error('BOSUN_URL is not a valid URL'); }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error(`BOSUN_URL must be ws:// or wss:// (got ${u.protocol})`);
  if (u.username || u.password || u.searchParams.has('token')) throw new Error('BOSUN_URL must not carry credentials; put the token in BOSUN_TOKEN');
  return { url: u.href, token };
}

function run(env = process.env) {
  let target;
  try { target = bridgeTarget(env); } catch (e) { die(2, e.message); }
  const ws = new WebSocket(target.url, { headers: { authorization: `Bearer ${target.token}` }, maxPayload: 64 * 1024 * 1024 });
  let stdinEnded = false;

  ws.on('unexpected-response', (_req, res) => {
    const code = res.statusCode;
    res.resume();
    if (code === 401 || code === 403) die(3, `authentication refused by ${target.url} (HTTP ${code}): check BOSUN_TOKEN`);
    die(1, `${target.url} refused the connection (HTTP ${code})`);
  });
  ws.on('error', (e) => die(1, `connection to ${target.url} failed: ${e.message}`));
  ws.on('close', (code) => {
    if (stdinEnded) process.exit(0);
    die(1, `connection to ${target.url} closed (${code})`);
  });

  ws.on('open', () => {
    // Server -> stdout: one line per frame. Re-serialized, so a frame can never span or split lines.
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { process.stderr.write('bosun-mcp-stdio: dropped a frame that is not JSON\n'); return; }
      if (!process.stdout.write(`${JSON.stringify(msg)}\n`)) { ws.pause(); process.stdout.once('drain', () => ws.resume()); }
    });
    // stdin -> server: one frame per non-empty line. Only parseable JSON is forwarded.
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      if (line.length > MAX_LINE) { process.stderr.write('bosun-mcp-stdio: dropped a message over 1 MiB\n'); return; }
      try { JSON.parse(line); } catch { process.stderr.write('bosun-mcp-stdio: dropped a line that is not JSON\n'); return; }
      ws.send(line);
    });
    rl.on('close', () => {
      stdinEnded = true;
      ws.close(1000);
      setTimeout(() => process.exit(0), 2000).unref();
    });
  });
}

run();
