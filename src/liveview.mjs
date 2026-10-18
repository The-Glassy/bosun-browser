// Live view + human handoff for browser-mcpl.
// One-time link /v/<token> → page with a canvas streaming the tab (CDP screencast) and forwarding input (CDP Input.*).
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';

const PAGE = (token, reason) => `<!doctype html><html><head><meta charset="utf-8">
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
<header><span class="r">🤖 <b>${reason.replace(/[<>&]/g, '')}</b><br><span id="st">connecting…</span></span>
<button id="kb">⌨︎</button><button id="give">Give up</button><button id="done">Done ✓</button></header>
<div id="wrap"><canvas id="c"></canvas></div><input id="t" autocomplete="off" autocapitalize="off">
<script>
const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws/${token}');
const c=document.getElementById('c'),x=c.getContext('2d'),st=document.getElementById('st'),t=document.getElementById('t');
let vw=1366,vh=900;
ws.onopen=()=>st.textContent='live — tap to click, ⌨︎ to type';
ws.onclose=()=>st.textContent='closed';
ws.onmessage=e=>{const m=JSON.parse(e.data);
 if(m.frame){const i=new Image();i.onload=()=>{if(c.width!==i.width){c.width=i.width;c.height=i.height}x.drawImage(i,0,0)};i.src='data:image/jpeg;base64,'+m.frame;vw=m.w;vh=m.h}
 if(m.end){st.textContent=m.end;document.body.style.opacity=.5}};
const pos=e=>{const r=c.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width*vw,y:(e.clientY-r.top)/r.height*vh}};
c.addEventListener('click',e=>{ws.send(JSON.stringify({type:'click',...pos(e)}))});
c.addEventListener('wheel',e=>{e.preventDefault();ws.send(JSON.stringify({type:'wheel',...pos(e),dy:e.deltaY}))},{passive:false});
let ty=null;c.addEventListener('touchstart',e=>{ty=e.touches[0].clientY},{passive:true});
c.addEventListener('touchmove',e=>{if(ty===null)return;const d=ty-e.touches[0].clientY;if(Math.abs(d)>15){const r=c.getBoundingClientRect();ws.send(JSON.stringify({type:'wheel',x:vw/2,y:vh/2,dy:d*vw/r.width}));ty=e.touches[0].clientY}},{passive:true});
document.getElementById('kb').onclick=()=>t.focus();
t.addEventListener('input',()=>{if(t.value){ws.send(JSON.stringify({type:'text',text:t.value}));t.value=''}});
const keys={Enter:1,Backspace:1,Tab:1,Escape:1,ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Delete:1};
const kd=e=>{if(keys[e.key]){e.preventDefault();ws.send(JSON.stringify({type:'key',key:e.key}))}};
t.addEventListener('keydown',kd);document.addEventListener('keydown',e=>{if(document.activeElement!==t){if(keys[e.key])kd(e);else if(e.key.length===1){ws.send(JSON.stringify({type:'text',text:e.key}))}}});
document.getElementById('done').onclick=()=>ws.send(JSON.stringify({type:'done'}));
document.getElementById('give').onclick=()=>ws.send(JSON.stringify({type:'giveup'}));
</script></body></html>`;

const KEYDEF = { Enter: [13, '\r'], Backspace: [8], Tab: [9], Escape: [27], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Delete: [46] };

export function createLiveView({ port, host = '0.0.0.0', baseUrl, ttlMs = 15 * 60 * 1000 }) {
  const handoffs = new Map(); // token -> {page, reason, resolve, timer, done}
  const srv = http.createServer((req, res) => {
    const m = req.url.match(/^\/v\/([a-f0-9]{32})$/);
    const h = m && handoffs.get(m[1]);
    if (!h || h.done) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('expired or unknown link'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(PAGE(m[1], h.reason));
  });
  const wss = new WebSocketServer({ noServer: true });
  srv.on('upgrade', (req, sock, head) => {
    const m = req.url.match(/^\/ws\/([a-f0-9]{32})$/);
    const h = m && handoffs.get(m[1]);
    if (!h || h.done) return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => attach(h, ws));
  });
  srv.listen(port, host);

  async function attach(h, ws) {
    const cdp = await h.page.context().newCDPSession(h.page);
    const vp = h.page.viewportSize() || { width: 1366, height: 900 };
    cdp.on('Page.screencastFrame', async (f) => {
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (ws.readyState === 1) ws.send(JSON.stringify({ frame: f.data, w: f.metadata.deviceWidth || vp.width, h: f.metadata.deviceHeight || vp.height }));
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
    h.sockets.add(ws);
    ws.on('message', async (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      try {
        if (m.type === 'click') {
          for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: m.x, y: m.y, button: 'left', clickCount: 1 });
        } else if (m.type === 'wheel') {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: m.x, y: m.y, deltaX: 0, deltaY: m.dy });
        } else if (m.type === 'text') {
          await cdp.send('Input.insertText', { text: String(m.text).slice(0, 500) });
        } else if (m.type === 'key' && KEYDEF[m.key]) {
          const [code, text] = KEYDEF[m.key];
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: m.key, windowsVirtualKeyCode: code, ...(text ? { text } : {}) });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: m.key, windowsVirtualKeyCode: code });
        } else if (m.type === 'done') finish(h, 'human-done');
        else if (m.type === 'giveup') finish(h, 'human-gave-up');
      } catch (e) { /* ignore single input errors */ }
    });
    ws.on('close', () => { h.sockets.delete(ws); cdp.send('Page.stopScreencast').catch(() => {}); cdp.detach().catch(() => {}); });
  }

  function finish(h, status) {
    if (h.done) return;
    h.done = true; clearTimeout(h.timer);
    for (const ws of h.sockets) { try { ws.send(JSON.stringify({ end: status === 'human-done' ? 'Done — the agent continues.' : status })); ws.close(); } catch {} }
    handoffs.delete(h.token);
    h.resolve(status);
  }

  return {
    // Starts a handoff; returns {token, url, wait: Promise<status>}
    start(page, reason, sessionId) {
      const token = crypto.randomBytes(16).toString('hex');
      let resolve; const wait = new Promise((r) => (resolve = r));
      const h = { token, page, reason, sessionId, resolve, sockets: new Set(), done: false };
      h.timer = setTimeout(() => finish(h, 'handoff-timeout'), ttlMs);
      handoffs.set(token, h);
      return { token, url: `${baseUrl.replace(/\/$/, '')}/v/${token}`, wait, cancel: () => finish(h, 'cancelled') };
    },
    activeFor(sessionId) { for (const h of handoffs.values()) if (h.sessionId === sessionId && !h.done) return h; return null; },
    close() { srv.close(); },
  };
}
