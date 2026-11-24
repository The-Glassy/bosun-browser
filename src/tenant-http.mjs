import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';

// O_PATH pins the socket inode before connect. With O_NOFOLLOW a worker cannot point a
// gateway request at a different Unix socket by swapping its listening path for a link.
function connectSocket(path) {
  const fd = fs.openSync(path, 0x200000 | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isSocket()) throw new Error('invalid worker socket');
    const socket = net.connect({ path: `/proc/self/fd/${fd}` });
    const close = () => {
      socket.off('connect', close);
      socket.off('close', close);
      fs.closeSync(fd);
    };
    socket.once('connect', close);
    socket.once('close', close);
    return socket;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

const HOP_HEADERS = ['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function endToEnd(headers) {
  const out = { ...headers };
  for (const key of [...HOP_HEADERS, ...String(headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim())]) delete out[key];
  return out;
}

export function forwardHttp(req, res, path, url, bearer) {
  const headers = endToEnd(req.headers);
  delete headers.authorization;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const out = http.request({ method: req.method, path: url, headers, createConnection: () => connectSocket(path) }, (upstream) => {
    res.writeHead(upstream.statusCode, endToEnd(upstream.headers));
    upstream.on('error', () => res.destroy());
    upstream.pipe(res);
  });
  const send = () => req.pipe(out);
  out.on('error', () => {
    if (res.writableFinished) return;
    if (res.headersSent) return res.destroy();
    res.writeHead(503).end();
    req.resume();
  });
  res.once('close', () => { if (!res.writableFinished) out.destroy(); });
  req.once('error', () => out.destroy());
  if (headers.expect?.toLowerCase() === '100-continue') {
    out.once('continue', () => { res.writeContinue(); send(); });
    out.once('response', () => { if (!out.writableEnded) out.end(); req.resume(); });
    out.flushHeaders();
  } else send();
}

export function forwardUpgrade(req, socket, head, path, url) {
  socket.on('error', () => {});
  const headers = { ...endToEnd(req.headers), connection: 'Upgrade', upgrade: req.headers.upgrade };
  delete headers.authorization;
  delete headers.cookie;
  const out = http.request({ method: 'GET', path: url, headers, createConnection: () => connectSocket(path) });
  out.on('upgrade', (up, backend, held) => {
    backend.on('error', () => socket.destroy());
    backend.on('close', () => socket.destroy());
    socket.on('error', () => backend.destroy());
    socket.on('close', () => backend.destroy());
    const reply = [`HTTP/1.1 ${up.statusCode} ${up.statusMessage}`];
    for (let i = 0; i < up.rawHeaders.length; i += 2) reply.push(`${up.rawHeaders[i]}: ${up.rawHeaders[i + 1]}`);
    socket.write(`${reply.join('\r\n')}\r\n\r\n`);
    if (held.length) socket.write(held);
    if (head.length) backend.write(head);
    socket.pipe(backend).pipe(socket);
  });
  out.on('response', (up) => { up.resume(); socket.end(`HTTP/1.1 ${up.statusCode} ${http.STATUS_CODES[up.statusCode]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); });
  out.on('error', () => socket.destroy());
  socket.once('close', () => out.destroy());
  out.end();
}

export function workerHealth(path, token) {
  return new Promise((resolve, reject) => {
    const out = http.get({ path: '/health', headers: { authorization: `Bearer ${token}` }, createConnection: () => connectSocket(path),
      signal: AbortSignal.timeout(35_000) }, async (res) => {
      try {
        let body = '';
        for await (const chunk of res) {
          body += chunk;
          if (body.length > 8192) throw new Error('invalid worker health report');
        }
        resolve(JSON.parse(body).engines);
      } catch (error) { reject(error); }
    });
    out.on('error', reject);
  });
}

// One authenticated public connection owns one private connection for its lifetime. Unsolicited MCPL requests
// and cancellation notifications travel on the same channel. A dead worker closes every lease in that generation.
const MAX_BUFFER = 8 * 1024 * 1024;
export async function connectWorker(transport, getWorker, base, disconnected) {
  let ws, closed = false, bytes = 0;
  const pending = [];
  const close = () => {
    if (closed) return;
    closed = true;
    ws?.terminate();
    Promise.resolve(transport.close()).catch(() => {});
    disconnected?.();
  };
  const send = (json) => {
    if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount + Buffer.byteLength(json) <= MAX_BUFFER) ws.send(json, (error) => { if (error) close(); });
    else close();
  };
  transport.onclose = () => { closed = true; ws?.terminate(); };
  transport.onmessage = (msg) => {
    if (closed) return;
    const json = JSON.stringify(msg);
    if (ws?.readyState === WebSocket.OPEN) return send(json);
    bytes += Buffer.byteLength(json);
    if (bytes > MAX_BUFFER) return close();
    pending.push(json);
  };
  await transport.start();
  const worker = await getWorker();
  if (closed) return;
  ws = new WebSocket('ws://bosun-worker/', {
    headers: { authorization: `Bearer ${worker.token}`, ...(base ? { 'x-bosun-client-base': base } : {}) },
    createConnection: () => connectSocket(worker.mcp), maxPayload: MAX_BUFFER, handshakeTimeout: 5000,
  });
  ws.on('open', () => { for (const json of pending.splice(0)) send(json); });
  ws.on('message', (data) => {
    try { Promise.resolve(transport.send(JSON.parse(data))).catch(close); } catch { close(); }
  });
  ws.on('close', close);
  ws.on('error', close);
}
