// Live view + human handoff.
// GET /v/<token> serves a page with a canvas streaming the tab (CDP screencast) and forwarding input (CDP Input.*).
// The first WebSocket on /ws/<token> claims the link and gets a viewer key; after that only that key may (re)connect,
// and only one viewer is attached at a time. Finish (Done, Give up, timeout, cancel) revokes everything.
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAGE = (token, reason, nonce) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>Agent needs you</title>
<style>
body{margin:0;background:#111;color:#eee;font:15px -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;height:100vh}
header{padding:8px 10px;background:#222;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
header .r{flex:1;min-width:150px} button{font-size:15px;padding:8px 14px;border-radius:8px;border:0}
#done{background:#2e7d32;color:#fff} #give{background:#555;color:#fff} #kb{background:#1565c0;color:#fff}
#wrap{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;display:flex;justify-content:center;align-items:flex-start}
canvas{max-width:100%;touch-action:manipulation;background:#000}
#t{position:absolute;left:-1000px;top:0;opacity:0}
#st{font-size:12px;color:#aaa}
</style></head><body>
<header><span class="r">🤖 <b id="reason">${esc(reason)}</b><br><span id="st">connecting…</span></span>
<button id="kb">⌨︎</button><button id="give">Give up</button><button id="done">Done ✓</button></header>
<div id="wrap"><canvas id="c"></canvas></div><input id="t" autocomplete="off" autocapitalize="off">
<script nonce="${nonce}">
const tok='${token}',kk='bosun-viewer-'+tok;
const c=document.getElementById('c'),x=c.getContext('2d'),st=document.getElementById('st'),t=document.getElementById('t');
let vw=1366,vh=900,ws,ended=false;
const key=()=>{try{return sessionStorage.getItem(kk)}catch{return null}};
function connect(){
 const k=key();
 ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws/'+tok+(k?'?v='+encodeURIComponent(k):''));
 ws.onopen=()=>st.textContent='live — tap to click, ⌨︎ to type';
 ws.onclose=()=>{if(ended)return;if(key()){st.textContent='reconnecting…';setTimeout(connect,2000)}else st.textContent='closed'};
 ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.viewer){try{sessionStorage.setItem(kk,m.viewer)}catch{}}
  if(m.frame){const i=new Image();i.onload=()=>{if(c.width!==i.width){c.width=i.width;c.height=i.height}x.drawImage(i,0,0)};i.src='data:image/jpeg;base64,'+m.frame;vw=m.w;vh=m.h}
  if(m.end){ended=true;st.textContent=m.end;document.body.style.opacity=.5}};
}
connect();
const send=o=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))};
const pos=e=>{const r=c.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*vw,y:(e.clientY-r.top)/r.height*vh}};
c.addEventListener('click',e=>send({type:'click',...pos(e)}));
c.addEventListener('wheel',e=>{e.preventDefault();send({type:'wheel',...pos(e),dy:e.deltaY})},{passive:false});
let ty=null;c.addEventListener('touchstart',e=>{ty=e.touches[0].clientY},{passive:true});
c.addEventListener('touchmove',e=>{if(ty===null)return;const d=ty-e.touches[0].clientY;if(Math.abs(d)>15){const r=c.getBoundingClientRect();send({type:'wheel',x:vw/2,y:vh/2,dy:d*vw/r.width});ty=e.touches[0].clientY}},{passive:true});
document.getElementById('kb').onclick=()=>t.focus();
t.addEventListener('input',()=>{if(t.value){send({type:'text',text:t.value});t.value=''}});
const keys={Enter:1,Backspace:1,Tab:1,Escape:1,ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Delete:1};
const kd=e=>{if(keys[e.key]){e.preventDefault();send({type:'key',key:e.key})}};
t.addEventListener('keydown',kd);document.addEventListener('keydown',e=>{if(document.activeElement!==t){if(keys[e.key])kd(e);else if(e.key.length===1){send({type:'text',text:e.key})}}});
document.getElementById('done').onclick=()=>send({type:'done'});
document.getElementById('give').onclick=()=>send({type:'giveup'});
</script></body></html>`;

const KEYDEF = { Enter: [13, '\r'], Backspace: [8], Tab: [9], Escape: [27], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Delete: [46] };
const MAX_COORD = 20000, MAX_DELTA = 20000, MAX_TEXT = 500, MAX_QUEUE = 64;
const MAX_BUFFERED = 1 << 20; // drop frames above 1 MiB queued to a slow viewer
const MAX_DROPS = 200; // ... and disconnect one that stays slow
const HEARTBEAT_MS = 20_000;
const DRAIN_DEADLINE_MS = 10_000;

const finite = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;

// Validated input command, or null.
export function parseInput(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  switch (m.type) {
    case 'click': return finite(m.x, MAX_COORD) && finite(m.y, MAX_COORD) && m.x >= 0 && m.y >= 0 ? { type: 'click', x: m.x, y: m.y } : null;
    case 'wheel': return finite(m.x, MAX_COORD) && finite(m.y, MAX_COORD) && finite(m.dy, MAX_DELTA) ? { type: 'wheel', x: m.x, y: m.y, dy: m.dy } : null;
    case 'text': return typeof m.text === 'string' && m.text.length > 0 ? { type: 'text', text: m.text.slice(0, MAX_TEXT) } : null;
    case 'key': return typeof m.key === 'string' && Object.hasOwn(KEYDEF, m.key) ? { type: 'key', key: m.key } : null;
    case 'done': case 'giveup': return { type: m.type };
    default: return null;
  }
}

const safeEqual = (a, b) => {
  const d = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(d(a), d(b));
};

function reject(sock, code, text) {
  try { sock.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  sock.destroy();
}

export function createLiveView({ port = 0, host = '127.0.0.1', baseUrl = null, ttlMs = 15 * 60 * 1000 } = {}) {
  const handoffs = new Map(); // token -> handoff
  let base = baseUrl ? baseUrl.replace(/\/$/, '') : null;
  let origin = base ? new URL(base).origin : null;

  const srv = http.createServer((req, res) => {
    const [p] = String(req.url).split('?');
    const m = /^\/v\/([a-f0-9]{32})$/.exec(p);
    const h = m && handoffs.get(m[1]);
    if (!h || h.done || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('expired or unknown link');
    }
    const nonce = crypto.randomBytes(16).toString('base64');
    const wsOrigin = origin.replace(/^http/, 'ws');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' ${wsOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    });
    res.end(req.method === 'HEAD' ? undefined : PAGE(h.token, h.reason, nonce));
  });
  srv.on('clientError', (_e, sock) => sock.destroy());
  srv.on('error', (e) => console.error(`bosun live view: ${e.message}`));

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  wss.on('error', () => {});
  srv.on('upgrade', (req, sock, head) => {
    sock.on('error', () => {});
    try {
      const [p, q = ''] = String(req.url).split('?');
      const m = /^\/ws\/([a-f0-9]{32})$/.exec(p);
      const h = m && handoffs.get(m[1]);
      if (!h || h.done) return reject(sock, 404, 'Not Found');
      if (req.headers.origin && req.headers.origin !== origin) return reject(sock, 403, 'Forbidden');
      const key = new URLSearchParams(q).get('v');
      // Without a key: only an unclaimed link. With a key: only the claimed link's key.
      const allowed = () => (h.viewerKey ? !!key && safeEqual(key, h.viewerKey) : !key);
      if (!allowed()) return reject(sock, 403, 'Forbidden');
      wss.handleUpgrade(req, sock, head, (ws) => {
        // Claim only once the handshake succeeded, re-checking in case another socket claimed it meanwhile.
        if (h.done || !allowed()) { ws.on('error', () => {}); return ws.close(4403, 'link already used'); }
        let issued = null;
        if (!h.viewerKey) issued = h.viewerKey = crypto.randomBytes(16).toString('hex'); // the link alone no longer connects
        attach(h, ws, issued).catch(() => {});
      });
    } catch {
      reject(sock, 400, 'Bad Request');
    }
  });

  const active = (h, v) => !h.done && h.viewer === v && !v.closed && v.ws.readyState === WebSocket.OPEN;

  async function attach(h, ws, issued) {
    ws.on('error', () => {});
    const v = { ws, cdp: null, queue: [], pumping: false, pressed: false, closed: false, drops: 0, alive: true, hb: null };
    // Register before the first await so finish() or a closing socket can always find and tear this viewer down.
    if (h.done) return ws.close(4410, 'handoff ended');
    if (h.viewer) teardown(h, h.viewer); // single viewer: the key holder reconnecting replaces the old socket
    h.viewer = v;
    ws.on('close', () => teardown(h, v));
    ws.on('pong', () => { v.alive = true; });
    v.hb = setInterval(() => { if (!v.alive) return teardown(h, v); v.alive = false; try { ws.ping(); } catch {} }, HEARTBEAT_MS);
    v.hb.unref();
    ws.on('message', (raw) => onInput(h, v, raw));
    if (issued) ws.send(JSON.stringify({ viewer: issued }));
    try {
      const cdp = await h.page.context().newCDPSession(h.page);
      if (!active(h, v)) { await cdp.detach().catch(() => {}); return; }
      v.cdp = cdp;
      const vp = h.page.viewportSize() || { width: 1366, height: 900 };
      v.vp = vp;
      cdp.on('Page.screencastFrame', (f) => onFrame(h, v, f));
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
      if (!active(h, v)) return teardown(h, v);
      pump(h, v);
    } catch {
      teardown(h, v);
    }
  }

  function onFrame(h, v, f) {
    const ack = () => v.cdp?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    if (!active(h, v)) return;
    if (v.ws.bufferedAmount > MAX_BUFFERED) {
      if (++v.drops > MAX_DROPS) return teardown(h, v);
      return ack();
    }
    v.drops = 0;
    const w = f.metadata.deviceWidth || v.vp.width, ht = f.metadata.deviceHeight || v.vp.height;
    // Ack once written, so the browser never runs far ahead of the viewer.
    v.ws.send(JSON.stringify({ frame: f.data, w, h: ht }), () => ack());
  }

  function onInput(h, v, raw) {
    if (!active(h, v)) return;
    const m = parseInput(raw);
    if (!m) return;
    if (m.type === 'done') return finish(h, 'human-done');
    if (m.type === 'giveup') return finish(h, 'human-gave-up');
    if (v.queue.length >= MAX_QUEUE) return;
    v.queue.push(m);
    pump(h, v);
  }

  // One command at a time, in order; re-checked before every CDP call so nothing is dispatched after finish.
  // v.pumpP lets teardown wait for the command that is already in flight.
  function pump(h, v) {
    if (v.pumping || !v.cdp) return;
    v.pumping = true;
    v.pumpP = drain(h, v);
  }
  async function drain(h, v) {
    try {
      while (v.queue.length && active(h, v)) {
        const m = v.queue.shift();
        const send = async (method, params) => { if (!active(h, v)) throw new Error('inactive'); await v.cdp.send(method, params); };
        try {
          if (m.type === 'click') {
            v.pressed = { x: m.x, y: m.y }; // set first: teardown must release even if it lands mid-press
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: m.x, y: m.y, button: 'left', clickCount: 1 });
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: m.x, y: m.y, button: 'left', clickCount: 1 });
            v.pressed = false;
          } else if (m.type === 'wheel') {
            await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: 0, deltaY: m.dy });
          } else if (m.type === 'text') {
            await send('Input.insertText', { text: m.text });
          } else if (m.type === 'key') {
            const [code, text] = KEYDEF[m.key];
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: m.key, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.key, windowsVirtualKeyCode: code });
          }
        } catch { /* a single failed input is not fatal */ }
      }
    } finally {
      v.pumping = false;
    }
  }

  // Release a held button, stop the stream and detach. Runs once, after any in-flight input has returned.
  async function cleanup(v) {
    const cdp = v.cdp;
    if (!cdp || v.cleaned) return;
    v.cleaned = true;
    if (v.pressed) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...v.pressed, button: 'left', clickCount: 1 }).catch(() => {});
    v.pressed = false;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }

  // Revokes the viewer at once; the returned promise settles when its in-flight input has returned and CDP is detached.
  function teardown(h, v) {
    if (v.closed) return v.finished;
    v.closed = true;
    v.queue.length = 0;
    clearInterval(v.hb);
    if (h.viewer === v) h.viewer = null;
    v.finished = (async () => { await v.pumpP?.catch(() => {}); await cleanup(v); })();
    h.teardowns.add(v.finished);
    try { if (v.ws.readyState === WebSocket.OPEN) v.ws.close(); else v.ws.terminate(); } catch {}
    return v.finished;
  }

  // The handoff resolves only after every viewer's input has drained, so nothing the human sent can reach the page
  // once the agent is back. If draining hangs, drainFailed tells the owner to give up on the session.
  function finish(h, status) {
    if (h.done) return;
    h.done = true;
    clearTimeout(h.timer);
    handoffs.delete(h.token);
    const v = h.viewer;
    if (v) {
      try { v.ws.send(JSON.stringify({ end: status === 'human-done' ? 'Done — the agent continues.' : status })); } catch {}
      teardown(h, v);
    }
    let timer;
    Promise.race([
      Promise.all([...h.teardowns]).then(() => true),
      new Promise((r) => { timer = setTimeout(() => r(false), DRAIN_DEADLINE_MS); }),
    ]).then((drained) => {
      clearTimeout(timer);
      if (!drained) h.drainFailed = true;
      h.resolve(status);
    });
  }

  return {
    async listen() {
      await new Promise((resolve, rej) => { srv.once('error', rej); srv.listen(port, host, () => { srv.off('error', rej); resolve(); }); });
      const a = srv.address();
      if (!base) {
        const hh = a.family === 'IPv6' ? `[${a.address}]` : a.address;
        base = `http://${hh === '0.0.0.0' || hh === '[::]' ? '127.0.0.1' : hh}:${a.port}`;
        origin = new URL(base).origin;
      }
      return { port: a.port, baseUrl: base };
    },
    // Starts a handoff; returns {token, url, expiresAt, wait: Promise<status>, cancel, drainFailed}
    start(page, reason, opts = {}) {
      const token = crypto.randomBytes(16).toString('hex');
      let resolve;
      const wait = new Promise((r) => (resolve = r));
      const ttl = opts.ttlMs || ttlMs;
      const h = { token, page, reason, resolve, viewer: null, viewerKey: null, done: false, expiresAt: Date.now() + ttl, teardowns: new Set(), drainFailed: false };
      h.timer = setTimeout(() => finish(h, 'handoff-timeout'), ttl);
      h.timer.unref?.();
      handoffs.set(token, h);
      return { token, url: `${base}/v/${token}`, expiresAt: h.expiresAt, wait, cancel: () => finish(h, 'cancelled'), get drainFailed() { return h.drainFailed; } };
    },
    get size() { return handoffs.size; },
    get port() { return srv.address()?.port; },
    async close() {
      for (const h of [...handoffs.values()]) finish(h, 'cancelled');
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => { srv.close(() => r()); srv.closeAllConnections?.(); });
    },
  };
}
