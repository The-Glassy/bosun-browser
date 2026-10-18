// MCP over WebSocket: authenticate in the HTTP upgrade (before any WebSocket or MCP server exists), one MCP server
// per connection, the connection is the owner of the sessions it opens (closed again when it disconnects).
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createAuthenticator, tokenFromRequest } from './auth.mjs';
import { buildServer } from './tools.mjs';

const MAX_PAYLOAD = 1024 * 1024;
const HEARTBEAT_MS = 30_000;

// MCP Transport over a ws socket. send() settles from the socket's write callback and rejects on a closed socket.
export class WsTransport {
  constructor(ws) {
    this.ws = ws;
    this.closed = false;
    ws.on('message', (d) => {
      let msg;
      try { msg = JSON.parse(d); } catch (e) { this.onerror?.(e); return; }
      this.onmessage?.(msg);
    });
    ws.on('error', (e) => this.onerror?.(e));
    ws.on('close', () => this.fireClose());
  }
  async start() {}
  send(msg) {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) return reject(new Error('websocket is not open'));
      this.ws.send(JSON.stringify(msg), (e) => (e ? reject(e) : resolve()));
    });
  }
  async close() { try { this.ws.close(); } catch {} this.fireClose(); }
  fireClose() { if (this.closed) return; this.closed = true; this.onclose?.(); }
}

function reject(sock, code, text) {
  try { sock.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  sock.destroy();
}

export async function startWsServer({ cfg, manager }) {
  const { host, port, maxConnections, allowedOrigins, allowNoToken } = cfg.ws;
  const auth = createAuthenticator(cfg.tokens);
  const conns = new Set();
  let seq = 0;

  const srv = http.createServer((_req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('WebSocket only'); });
  srv.on('clientError', (_e, sock) => sock.destroy());
  srv.on('error', (e) => console.error(`bosun ws: ${e.message}`));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  wss.on('error', () => {});

  srv.on('upgrade', (req, sock, head) => {
    sock.on('error', () => {});
    try {
      const [, q = ''] = String(req.url).split('?');
      const query = new URLSearchParams(q);
      // Browsers always send Origin; other clients don't. A browser page may only connect from an allowed origin.
      if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) return reject(sock, 403, 'Forbidden');
      const tenant = allowNoToken ? 'default' : auth(tokenFromRequest(req, query));
      if (!tenant) return reject(sock, 401, 'Unauthorized');
      if (conns.size >= maxConnections) return reject(sock, 503, 'Service Unavailable');
      wss.handleUpgrade(req, sock, head, (ws) => onConnection(ws, tenant));
    } catch {
      reject(sock, 400, 'Bad Request');
    }
  });

  function onConnection(ws, tenant) {
    ws.on('error', () => {});
    conns.add(ws);
    const owner = `c${++seq}-${crypto.randomBytes(4).toString('hex')}`;
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const hb = setInterval(() => { if (!alive) return ws.terminate(); alive = false; try { ws.ping(); } catch {} }, HEARTBEAT_MS);
    hb.unref();
    const server = buildServer({ manager, owner, tenant, cfg, conn: { inflight: 0 } });
    ws.on('close', () => {
      clearInterval(hb);
      conns.delete(ws);
      manager.disposeOwner(owner).catch(() => {}); // lease ends with the connection
      server.close().catch(() => {});
    });
    server.connect(new WsTransport(ws)).catch(() => ws.terminate());
  }

  await new Promise((resolve, rej) => { srv.once('error', rej); srv.listen(port, host, () => { srv.off('error', rej); resolve(); }); });

  return {
    port: srv.address().port,
    connections: conns,
    async close() {
      for (const ws of conns) ws.terminate();
      await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); });
    },
  };
}
