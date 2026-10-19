// Live view + human handoff.
// GET /v/<token> serves a page with a canvas streaming the tab (CDP screencast) and forwarding input (CDP Input.*).
// One viewer at a time: a WebSocket on /ws/<token> attaches while nobody else is connected (or the connected viewer
// has gone quiet for staleMs: no pong or message); the link can be reopened until Done, Give up, timeout or cancel
// revoke it for good. There is no per-tab credential: a duplicated tab or a reconnect waits like any other viewer.
import http from 'http';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAGE = (token, reason, nonce) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<title>Agent needs you</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#111;color:#eee;font:15px -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;height:100vh;height:100dvh;overflow:hidden;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
header,footer{flex:none;background:#1c1c1e;padding-left:max(10px,env(safe-area-inset-left));padding-right:max(10px,env(safe-area-inset-right))}
header{padding-top:max(6px,env(safe-area-inset-top));padding-bottom:6px;line-height:1.3}
#reason,#st{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#reason{font-weight:600} #st{font-size:12px;color:#aaa}
#wrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}
#stage{position:relative;flex:none}
canvas{display:block;width:100%;height:100%;background:#000}
#cur{display:none;position:absolute;left:0;top:0;width:20px;height:20px;pointer-events:none;will-change:transform}
body[data-mode=pad] #cur{display:block}
#cur svg{display:block;filter:drop-shadow(0 1px 1px #000)} #cur.down path{fill:#ffcc00}
footer{padding-top:6px;padding-bottom:max(8px,env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:6px}
.row{display:flex;gap:6px;align-items:center}
button{font:inherit;font-size:15px;min-height:44px;padding:0 11px;border-radius:10px;border:0;background:#3a3a3c;color:#fff;touch-action:manipulation;white-space:nowrap}
#p{flex:1;min-width:0;height:44px;font-size:16px;border-radius:10px;border:1px solid #48484a;background:#000;color:#fff;padding:0 10px;-webkit-user-select:text;user-select:text}
#eye{width:44px;padding:0} #ins{background:#1565c0}
#mode{display:flex;background:#2c2c2e;border-radius:10px;padding:2px}
#mode button{min-height:40px;background:transparent;padding:0 10px}
#give{background:#555;margin-left:auto} #done{background:#2e7d32}
#keys{gap:4px;overflow-x:auto} #keys[hidden]{display:none} #keys button{flex:1 0 auto;min-width:38px;padding:0 8px}
#mode button[aria-pressed=true],#kb[aria-pressed=true]{background:#636366}
#t{position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0}
body.ended #wrap,body.ended footer{opacity:.5;pointer-events:none}
footer .row{flex-wrap:wrap} #pf{flex-wrap:nowrap} #keys{flex-wrap:nowrap}
@media (max-width:359px){.row{gap:4px} button{font-size:14px;padding:0 6px} #mode button{padding:0 6px} #eye{padding:0}}
</style></head><body>
<header><span id="reason">🤖 ${esc(reason)}</span><span id="st">connecting…</span></header>
<main id="wrap"><div id="stage"><canvas id="c" width="1366" height="900"></canvas><div id="cur"><svg width="20" height="20" viewBox="0 0 20 20"><path d="M1 1v16l4.5-4.2 3 6.4 2.6-1.2-3-6.3H14z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg></div></div></main>
<footer>
<div class="row" id="keys" hidden><button data-k="Tab">Tab</button><button data-k="Enter">Enter</button><button data-k="Backspace" aria-label="Backspace">⌫</button><button data-k="Escape">Esc</button><button data-k="ArrowLeft" aria-label="Left">←</button><button data-k="ArrowUp" aria-label="Up">↑</button><button data-k="ArrowDown" aria-label="Down">↓</button><button data-k="ArrowRight" aria-label="Right">→</button></div>
<form class="row" id="pf" autocomplete="off"><button type="button" id="eye" aria-label="Show text" aria-pressed="false">👁</button><input id="p" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="500" enterkeyhint="send" placeholder="Paste text for the focused field"><button type="submit" id="ins">Insert</button></form>
<div class="row"><div id="mode" role="group" aria-label="Touch mode"><button type="button" data-m="tap">Tap</button><button type="button" data-m="pad">Trackpad</button></div><button type="button" id="kb" aria-pressed="false">Keys</button><button type="button" id="give">Give up</button><button type="button" id="done">Done ✓</button></div>
</footer>
<input id="t" autocomplete="off" autocapitalize="off" autocorrect="off" aria-hidden="true">
<script nonce="${nonce}">
const tok='${token}',$=(id)=>document.getElementById(id);
const c=$('c'),x=c.getContext('2d'),st=$('st'),t=$('t'),wrap=$('wrap'),stage=$('stage'),cur=$('cur'),p=$('p'),ins=$('ins'),eye=$('eye');
let vw=1366,vh=900,ws=null,ended=false,cx=683,cy=450,mode='tap',rt=0;
const status=(s)=>{st.textContent=s};
const hint=()=>{if(!ended&&ws&&ws.readyState===1)status(mode==='pad'?'live — drag to move · tap to click · 2 fingers scroll · hold to drag':'live — tap to click, drag to scroll')};
// Canvas fitted into the space between the bars; the cursor overlay is positioned in page coordinates.
function layout(){const s=Math.min(wrap.clientWidth/c.width,wrap.clientHeight/c.height);stage.style.width=Math.floor(c.width*s)+'px';stage.style.height=Math.floor(c.height*s)+'px';drawCur()}
function drawCur(){cur.style.transform='translate('+(cx/vw*stage.clientWidth)+'px,'+(cy/vh*stage.clientHeight)+'px)'}
if(window.ResizeObserver)new ResizeObserver(layout).observe(wrap);else addEventListener('resize',layout);
layout();
const retry=(ms)=>{clearTimeout(rt);rt=setTimeout(connect,ms)};
function finish(msg){ended=true;clearTimeout(rt);status(msg);document.body.classList.add('ended');try{if(ws)ws.close()}catch{}}
function connect(){
 if(ended||ws)return;
 const s=ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws/'+tok);
 s.onopen=hint;
 s.onclose=(e)=>{if(ws!==s)return;ws=null;if(ended)return;
  // One viewer at a time: wait while another device has it; otherwise ask whether the link is still valid.
  if(e.code===4409){status('open on another device — waiting for it to close…');return retry(2000)}
  status('reconnecting…');
  fetch(location.pathname,{method:'HEAD',cache:'no-store'}).then((r)=>{if(r.ok)retry(1000);else finish('This link has expired or the handoff is over.')},()=>retry(3000))};
 s.onmessage=(e)=>{const m=JSON.parse(e.data);
  if(m.cursor){cx=m.cursor.x;cy=m.cursor.y;drawCur()}
  if(m.frame){vw=m.w;vh=m.h;const i=new Image();i.onload=()=>{if(c.width!==i.width||c.height!==i.height){c.width=i.width;c.height=i.height;layout()}x.drawImage(i,0,0)};i.src='data:image/jpeg;base64,'+m.frame}
  if(m.end)finish(m.end)};
}
connect();
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!ws&&!ended)retry(0)});
addEventListener('pageshow',()=>{if(!ws&&!ended)retry(0)});
const send=(o)=>{if(ws&&ws.readyState===1){ws.send(JSON.stringify(o));return true}return false};
const r1=(n)=>Math.round(n*10)/10;
// Page coordinates of a client point (clamped), and whether it lies on the canvas.
function at(px,py){const r=c.getBoundingClientRect(),X=(px-r.left)/r.width*vw,Y=(py-r.top)/r.height*vh;return{x:r1(Math.max(0,Math.min(vw-1,X))),y:r1(Math.max(0,Math.min(vh-1,Y))),inside:X>=0&&Y>=0&&X<=vw&&Y<=vh}}
// Cursor moves are sent at most every 33 ms (latest position); the service interpolates the path.
let mvT=0,mvDirty=false;
function flushMove(){if(!mvDirty)return false;mvDirty=false;send({type:'move',x:r1(cx),y:r1(cy)});return true}
function moveTo(nx,ny){cx=Math.max(0,Math.min(vw-1,nx));cy=Math.max(0,Math.min(vh-1,ny));drawCur();mvDirty=true;if(!mvT){flushMove();mvT=setInterval(()=>{if(!flushMove()){clearInterval(mvT);mvT=0}},33)}}
let wh=null;
function wheel(wx,wy,dx,dy){if(!wh){wh={x:wx,y:wy,dx:0,dy:0};setTimeout(()=>{const w=wh;wh=null;if(Math.round(w.dx)||Math.round(w.dy))send({type:'wheel',x:w.x,y:w.y,dx:Math.round(w.dx),dy:Math.round(w.dy)})},40)}wh.dx+=dx;wh.dy+=dy}
// Mouse/pen: direct pointing, real hover moves, press and release.
const isMouse=(e)=>e.pointerType==='mouse'||e.pointerType==='pen';
let mdown=false;
c.addEventListener('pointermove',(e)=>{if(isMouse(e)){const q=at(e.clientX,e.clientY);moveTo(q.x,q.y)}});
c.addEventListener('pointerdown',(e)=>{if(!isMouse(e)||e.button!==0)return;e.preventDefault();const q=at(e.clientX,e.clientY);moveTo(q.x,q.y);flushMove();mdown=send({type:'down',x:q.x,y:q.y});try{c.setPointerCapture(e.pointerId)}catch{}});
const mup=(e)=>{if(!isMouse(e)||!mdown)return;mdown=false;const q=at(e.clientX,e.clientY);moveTo(q.x,q.y);flushMove();send({type:'up',x:q.x,y:q.y})};
c.addEventListener('pointerup',mup);c.addEventListener('pointercancel',mup);
c.addEventListener('wheel',(e)=>{e.preventDefault();const q=at(e.clientX,e.clientY);wheel(q.x,q.y,e.deltaX,e.deltaY)},{passive:false});
// Touch. Tap mode: tap = click there, drag = scroll. Trackpad mode: drag moves the cursor (relative, accelerated),
// tap = click at the cursor, two fingers = scroll, hold then drag = press, move, release.
// A finger resting on the glass still reports tiny movements. Once it has stayed within REST px for REST_MS it counts
// as resting: its centre is the mean of the first WARM reports, later reports are averaged (EMA), so noise cancels
// out and the cursor stays put with nothing sent, while a deliberate fine shift of FINE px or more from the centre
// still moves it (and what is left of it is applied on release).
const SLOP=8,HOLD=450,REST=3,REST_MS=120,FINE=1,EMA=0.25,WARM=8;let g=null;
const restAt=(G,a,now)=>{G.rx=a.x;G.ry=a.y;G.rt=now;G.rc=null};
const avg=(ts)=>{let X=0,Y=0;for(const q of ts){X+=q.clientX;Y+=q.clientY}return{x:X/ts.length,y:Y/ts.length}};
wrap.addEventListener('touchstart',(e)=>{e.preventDefault();if(ended)return;const a=avg(e.touches),now=performance.now();
 if(!g)g={t0:now,t:now,x:a.x,y:a.y,moved:0,maxN:0,drag:false,lp:0};
 g.x=g.ox=a.x;g.y=g.oy=a.y;g.t=now;restAt(g,a,now);g.maxN=Math.max(g.maxN,e.touches.length);clearTimeout(g.lp);
 if(mode==='pad'&&g.maxN===1)g.lp=setTimeout(()=>{if(g&&!g.drag&&g.moved<SLOP){g.drag=true;flushMove();send({type:'down',x:r1(cx),y:r1(cy)});cur.classList.add('down')}},HOLD);
},{passive:false});
wrap.addEventListener('touchmove',(e)=>{e.preventDefault();if(!g||ended)return;
 let a=avg(e.touches);const now=performance.now();
 if(Math.hypot(a.x-g.rx,a.y-g.ry)>=REST)restAt(g,a,now);
 else if(now-g.rt>=REST_MS){
  const c=g.rc||(g.rc={n:0,sx:0,sy:0});
  if(c.n<WARM){c.n++;c.sx+=a.x;c.sy+=a.y;if(c.n<WARM)return;
   // Centre known: settle the cursor there (the last reports before resting were noisy too).
   c.x=c.ex=c.sx/WARM;c.y=c.ey=c.sy/WARM;if(Math.hypot(c.x-g.x,c.y-g.y)<0.5)return;a={x:c.x,y:c.y}}
  else{c.ex+=(a.x-c.ex)*EMA;c.ey+=(a.y-c.ey)*EMA;
   if(Math.hypot(c.ex-c.x,c.ey-c.y)<FINE)return;
   a={x:g.x+c.ex-c.x,y:g.y+c.ey-c.y};c.x=c.ex;c.y=c.ey}}
 const dx=a.x-g.x,dy=a.y-g.y,dt=Math.max(1,now-g.t),k=vw/(stage.clientWidth||1);
 g.x=a.x;g.y=a.y;g.t=now;g.moved=Math.max(g.moved,Math.hypot(a.x-g.ox,a.y-g.oy));
 if(g.moved<SLOP)return;
 clearTimeout(g.lp);
 if(e.touches.length>1||mode!=='pad'){if(g.drag)return;const q=mode==='pad'?{x:cx,y:cy}:at(a.x,a.y);wheel(q.x,q.y,-dx*k,-dy*k);return}
 const gain=Math.min(3.2,0.9+1.1*Math.hypot(dx,dy)/dt);
 moveTo(cx+dx*gain*k,cy+dy*gain*k);
},{passive:false});
const tend=(e,cancel)=>{e.preventDefault();if(!g)return;if(e.touches.length){const a=avg(e.touches);g.x=g.ox=a.x;g.y=g.oy=a.y;restAt(g,a,performance.now());return}
 clearTimeout(g.lp);const G=g;g=null;if(ended)return;
 // A fine shift still below FINE when the finger lifts is applied before the release.
 const c=G.rc;if(c&&c.n===WARM&&!cancel&&mode==='pad'&&G.maxN===1&&G.moved>=SLOP&&Math.hypot(c.ex-c.x,c.ey-c.y)>=0.3){const k=vw/(stage.clientWidth||1);moveTo(cx+(c.ex-c.x)*0.9*k,cy+(c.ey-c.y)*0.9*k)}
 if(G.drag){flushMove();send({type:'up',x:r1(cx),y:r1(cy)});cur.classList.remove('down');return}
 if(cancel||G.maxN!==1||G.moved>=SLOP||performance.now()-G.t0>=HOLD)return;
 if(mode==='pad'){flushMove();send({type:'click',x:r1(cx),y:r1(cy)});return}
 const q=at(e.changedTouches[0].clientX,e.changedTouches[0].clientY);if(!q.inside)return;
 cx=q.x;cy=q.y;drawCur();send({type:'click',x:q.x,y:q.y})};
wrap.addEventListener('touchend',(e)=>tend(e,false),{passive:false});
wrap.addEventListener('touchcancel',(e)=>tend(e,true),{passive:false});
function setMode(m){mode=m;try{localStorage.setItem('bosun-mode',m)}catch{}document.body.dataset.mode=m;for(const b of document.querySelectorAll('#mode button'))b.setAttribute('aria-pressed',String(b.dataset.m===m));hint()}
let saved=null;try{saved=localStorage.getItem('bosun-mode')}catch{}
setMode(saved==='tap'||saved==='pad'?saved:(matchMedia('(pointer: coarse)').matches?'pad':'tap'));
for(const b of document.querySelectorAll('#mode button'))b.addEventListener('click',()=>setMode(b.dataset.m));
// Keys: a strip of special keys, and the system keyboard (typed characters go to the page one by one).
const keys={Enter:1,Backspace:1,Tab:1,Escape:1,ArrowUp:1,ArrowDown:1,ArrowLeft:1,ArrowRight:1,Delete:1};
$('kb').addEventListener('click',()=>{const k=$('keys');k.hidden=!k.hidden;$('kb').setAttribute('aria-pressed',String(!k.hidden));if(!k.hidden)t.focus();else t.blur()});
for(const b of document.querySelectorAll('#keys button')){b.addEventListener('pointerdown',(e)=>e.preventDefault());b.addEventListener('click',()=>send({type:'key',key:b.dataset.k}))}
t.addEventListener('input',()=>{if(t.value){send({type:'text',text:t.value});t.value=''}});
const kd=(e)=>{if(keys[e.key]){e.preventDefault();send({type:'key',key:e.key})}};
t.addEventListener('keydown',kd);
document.addEventListener('keydown',(e)=>{const a=document.activeElement;if(a===t||a===p||ended)return;if(keys[e.key])kd(e);else if(e.key.length===1&&!e.metaKey&&!e.ctrlKey)send({type:'text',text:e.key})});
document.addEventListener('paste',(e)=>{if(e.target===p||e.target===t)return;const s=e.clipboardData&&e.clipboardData.getData('text');if(s){e.preventDefault();send({type:'text',text:s.slice(0,500)})}});
// Paste bar: masked input (eye shows it), Insert/Enter types it into the page's focused field, then it's cleared.
const canClip=!!(window.isSecureContext&&navigator.clipboard&&navigator.clipboard.readText);
const label=()=>{ins.textContent=p.value||!canClip?'Insert':'Paste'};
const mask=(on)=>{p.type=on?'password':'text';eye.setAttribute('aria-pressed',String(!on));eye.textContent=on?'👁':'🙈'};
eye.addEventListener('click',()=>mask(p.type!=='password'));
p.addEventListener('input',label);
function put(s){if(!send({type:'text',text:s.slice(0,500)})){status('not connected — try again in a moment');return}p.value='';mask(true);label();status(s.length>500?'inserted (first 500 characters)':'inserted ✓');setTimeout(hint,1500)}
$('pf').addEventListener('submit',(e)=>{e.preventDefault();if(p.value)return put(p.value);
 if(canClip)navigator.clipboard.readText().then((s)=>{if(s)put(s)},()=>p.focus());else p.focus()});
label();
$('done').addEventListener('click',()=>send({type:'done'}));
$('give').addEventListener('click',()=>send({type:'giveup'}));
</script></body></html>`;

const KEYDEF = { Enter: [13, '\r'], Backspace: [8], Tab: [9], Escape: [27], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Delete: [46] };
const MAX_COORD = 20000, MAX_DELTA = 20000, MAX_TEXT = 500, MAX_QUEUE = 64;
const MAX_BUFFERED = 1 << 20; // drop frames above 1 MiB queued to a slow viewer
const MAX_DROPS = 200; // ... and disconnect one that stays slow
const PING_MS = 2_000; // viewer liveness probe
const DEAD_MS = 20_000; // no pong/message this long: the viewer is gone
const STALE_MS = 5_000; // ... this long: another viewer may take over
const REFRESH_MS = 2_000; // a static page gets a fresh frame at least this often
const STEP_MS = 4; // pause between interpolated mouse moves (skipped while more input is queued)
const STEP_PX = 8, MAX_STEPS = 24, JITTER_PX = 0.8;
const DRAIN_DEADLINE_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Live-view drivers: stream frames and forward input. cdp (Chromium engines): CDP screencast with per-frame acks and
// Input.* events. playwright (any engine, used for Firefox/Camoufox): Playwright's page.screencast and page.mouse /
// page.keyboard. start(onFrame(base64Jpeg, cssWidth, cssHeight, ack), guard). guard() throws once the viewer is
// revoked; drivers call it between the steps of compound actions, so nothing is dispatched after that. snapshot()
// captures the viewport once (static pages produce no screencast frames). size is the CSS viewport after start().
async function cdpDriver(page) {
  const cdp = await page.context().newCDPSession(page);
  // The CSS viewport; measured where the page has no fixed viewport (patchright: the window decides).
  const measure = async () => {
    const m = await cdp.send('Page.getLayoutMetrics').catch(() => null);
    return m?.cssLayoutViewport?.clientWidth ? { width: m.cssLayoutViewport.clientWidth, height: m.cssLayoutViewport.clientHeight } : null;
  };
  const vp = page.viewportSize() || await measure() || { width: 1366, height: 900 };
  const mouse = (type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
  return {
    size: vp,
    async start(onFrame, guard) {
      guard();
      cdp.on('Page.screencastFrame', (f) => onFrame(f.data, f.metadata.deviceWidth || vp.width, f.metadata.deviceHeight || vp.height,
        () => cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})));
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
    },
    async snapshot() {
      const size = page.viewportSize() || await measure() || vp;
      const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      return r?.data ? { data: r.data, w: size.width, h: size.height } : null;
    },
    move: (x, y, pressed) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: pressed ? 'left' : 'none', buttons: pressed ? 1 : 0 }),
    mouse: (dir, x, y) => (dir === 'down' ? mouse('mousePressed', x, y, 1) : mouse('mouseReleased', x, y, 0)),
    wheel: (x, y, dx, dy) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy }),
    text: (text) => cdp.send('Input.insertText', { text }),
    key(k, dir) {
      const [code, text] = KEYDEF[k];
      return cdp.send('Input.dispatchKeyEvent', dir === 'down'
        ? { type: 'keyDown', key: k, windowsVirtualKeyCode: code, ...(text ? { text } : {}) }
        : { type: 'keyUp', key: k, windowsVirtualKeyCode: code });
    },
    async stop() { await cdp.send('Page.stopScreencast').catch(() => {}); await cdp.detach().catch(() => {}); },
  };
}

async function playwrightDriver(page) {
  const d = {
    size: null,
    async start(onFrame, guard) {
      const size = d.size = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => ({ width: 1366, height: 900 }));
      guard(); // revoked while measuring: don't start capturing
      await page.screencast.start({
        size, quality: 60,
        onFrame: (f) => new Promise((ack) => onFrame(f.data.toString('base64'), f.viewportWidth || size.width, f.viewportHeight || size.height, ack)),
      });
    },
    async snapshot() {
      const size = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => d.size);
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 });
      return { data: buf.toString('base64'), w: size.width, h: size.height };
    },
    move: (x, y) => page.mouse.move(x, y),
    async mouse(dir, x, y, guard) {
      if (dir === 'down') { await page.mouse.move(x, y); guard(); await page.mouse.down(); } else await page.mouse.up();
    },
    async wheel(x, y, dx, dy, guard) { await page.mouse.move(x, y); guard(); await page.mouse.wheel(dx, dy); },
    text: (text) => page.keyboard.insertText(text),
    key: (k, dir) => (dir === 'down' ? page.keyboard.down(k) : page.keyboard.up(k)),
    async stop() { await page.screencast.stop().catch(() => {}); },
  };
  return d;
}

const DRIVERS = { cdp: cdpDriver, playwright: playwrightDriver };

const finite = (v, lim) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim;
const point = (m) => finite(m.x, MAX_COORD) && finite(m.y, MAX_COORD) && m.x >= 0 && m.y >= 0;
const clampDelta = (v) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, v));

// Validated input command, or null.
export function parseInput(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  switch (m.type) {
    case 'click': case 'move': case 'down': case 'up': return point(m) ? { type: m.type, x: m.x, y: m.y } : null;
    case 'wheel': return finite(m.x, MAX_COORD) && finite(m.y, MAX_COORD) && finite(m.dy, MAX_DELTA) && (m.dx === undefined || finite(m.dx, MAX_DELTA))
      ? { type: 'wheel', x: m.x, y: m.y, dx: m.dx ?? 0, dy: m.dy } : null;
    case 'text': return typeof m.text === 'string' && m.text.length > 0 ? { type: 'text', text: m.text.slice(0, MAX_TEXT) } : null;
    case 'key': return typeof m.key === 'string' && Object.hasOwn(KEYDEF, m.key) ? { type: 'key', key: m.key } : null;
    case 'done': case 'giveup': return { type: m.type };
    default: return null;
  }
}

// A human-looking pointer path from one point to another: eased steps of about STEP_PX along a slight curve with a
// little jitter, ending exactly on the target. Empty when there is nowhere to go.
export function glidePath(from, to, rnd = Math.random) {
  const dx = to.x - from.x, dy = to.y - from.y, dist = Math.hypot(dx, dy);
  if (dist < 0.5) return [];
  const n = Math.max(1, Math.min(MAX_STEPS, Math.round(dist / STEP_PX)));
  const nx = -dy / dist, ny = dx / dist; // unit normal
  const bow = (rnd() - 0.5) * Math.min(dist * 0.08, 6);
  const pts = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, e = t * t * (3 - 2 * t);
    const off = Math.sin(Math.PI * t) * bow + (rnd() - 0.5) * JITTER_PX;
    pts.push({ x: Math.max(0, Math.round((from.x + dx * e + nx * off) * 10) / 10), y: Math.max(0, Math.round((from.y + dy * e + ny * off) * 10) / 10) });
  }
  pts.push({ x: to.x, y: to.y });
  return pts;
}

function reject(sock, code, text) {
  try { sock.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
  sock.destroy();
}

export function createLiveView({ port = 0, host = '127.0.0.1', baseUrl = null, ttlMs = 15 * 60 * 1000, staleMs = STALE_MS, refreshMs = REFRESH_MS, stepMs = STEP_MS } = {}) {
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
      const [p] = String(req.url).split('?');
      const m = /^\/ws\/([a-f0-9]{32})$/.exec(p);
      const h = m && handoffs.get(m[1]);
      if (!h || h.done) return reject(sock, 404, 'Not Found');
      if (req.headers.origin && req.headers.origin !== origin) return reject(sock, 403, 'Forbidden');
      wss.handleUpgrade(req, sock, head, (ws) => {
        ws.on('error', () => {});
        if (h.done) return ws.close(4410, 'handoff ended');
        // One viewer at a time. A viewer heard from within staleMs keeps the link; one that went quiet is replaced.
        if (h.viewer && Date.now() - h.viewer.lastSeen < staleMs) return ws.close(4409, 'another viewer is connected');
        attach(h, ws).catch(() => {});
      });
    } catch {
      reject(sock, 400, 'Bad Request');
    }
  });

  const active = (h, v) => !h.done && h.viewer === v && !v.closed && v.ws.readyState === WebSocket.OPEN;

  async function attach(h, ws) {
    const v = { ws, drv: null, queue: [], pumping: false, pressed: false, closed: false, drops: 0, lastSeen: Date.now(), lastFrameAt: 0, hb: null, refresh: null, snapP: null };
    // Register before the first await so finish() or a closing socket can always find and tear this viewer down.
    if (h.viewer) teardown(h, h.viewer); // single viewer: the newcomer replaces a stale one
    h.viewer = v;
    ws.on('close', () => teardown(h, v));
    ws.on('pong', () => { v.lastSeen = Date.now(); });
    v.hb = setInterval(() => { if (Date.now() - v.lastSeen > DEAD_MS) return teardown(h, v); try { ws.ping(); } catch {} }, Math.min(PING_MS, staleMs / 2));
    v.hb.unref();
    ws.on('message', (raw) => { v.lastSeen = Date.now(); onInput(h, v, raw); });
    if (h.mouse) ws.send(JSON.stringify({ cursor: h.mouse }));
    // A (re)connecting viewer sees the page at once, before the stream has started.
    if (h.lastFrame) { ws.send(JSON.stringify(h.lastFrame)); v.lastFrameAt = Date.now(); }
    const before = [...h.teardowns]; // every earlier viewer, incl. ones that already disconnected
    // v.startP is part of this viewer's teardown barrier: a handoff can't resolve while a stream is still starting.
    v.startP = (async () => {
      await Promise.all(before); // one stream and one input source per page: earlier viewers fully stopped first
      if (!active(h, v)) return;
      const drv = await DRIVERS[h.driver](h.page);
      v.drv = drv; // from here on cleanup() stops it
      if (!active(h, v)) return;
      await drv.start((data, w, ht, ack) => onFrame(h, v, data, w, ht, ack), () => { if (!active(h, v)) throw new Error('inactive'); });
      if (!active(h, v)) return;
      if (!h.mouse && drv.size) {
        h.mouse = { x: Math.round(drv.size.width / 2), y: Math.round(drv.size.height / 2) };
        ws.send(JSON.stringify({ cursor: h.mouse }));
      }
      v.refresh = setInterval(() => refresh(h, v), Math.max(50, Math.min(500, refreshMs / 4)));
      v.refresh.unref();
      pump(h, v);
    })().catch(() => { if (!v.closed) teardown(h, v); });
  }

  function sendFrame(h, v, frame, ack) {
    h.lastFrame = frame;
    if (v.ws.bufferedAmount > MAX_BUFFERED) {
      if (++v.drops > MAX_DROPS) return teardown(h, v);
      return ack();
    }
    v.drops = 0;
    v.lastFrameAt = Date.now();
    // Ack once written, so the browser never runs far ahead of the viewer.
    v.ws.send(JSON.stringify(frame), () => ack());
  }

  function onFrame(h, v, data, w, ht, ack) {
    if (!active(h, v)) return;
    sendFrame(h, v, { frame: data, w, h: ht }, ack);
  }

  // The screencast only produces frames when something changes; a still page is captured every refreshMs instead.
  function refresh(h, v) {
    if (!active(h, v) || v.snapP || !v.drv?.snapshot || Date.now() - v.lastFrameAt < refreshMs) return;
    v.snapP = (async () => {
      const s = await v.drv.snapshot();
      if (s && active(h, v)) sendFrame(h, v, { frame: s.data, w: s.w, h: s.h }, () => {});
    })().catch(() => {}).finally(() => { v.snapP = null; });
  }

  function onInput(h, v, raw) {
    if (!active(h, v)) return;
    const m = parseInput(raw);
    if (!m) return;
    if (m.type === 'done') return finish(h, 'human-done');
    if (m.type === 'giveup') return finish(h, 'human-gave-up');
    // Coalesce: a queued move (or release) is superseded by the next one, queued scrolling at one point adds up.
    const last = v.queue.at(-1);
    // A release is never dropped: repeated ones collapse, and one slot beyond MAX_QUEUE is kept for it.
    if ((m.type === 'move' || m.type === 'up') && last?.type === m.type) v.queue[v.queue.length - 1] = m;
    else if (m.type === 'wheel' && last?.type === 'wheel' && last.x === m.x && last.y === m.y) { last.dx = clampDelta(last.dx + m.dx); last.dy = clampDelta(last.dy + m.dy); }
    else if (v.queue.length < MAX_QUEUE || (m.type === 'up' && v.queue.length === MAX_QUEUE)) v.queue.push(m);
    else return;
    pump(h, v);
  }

  // One command at a time, in order; re-checked before every driver call so nothing is dispatched after finish.
  // v.pumpP lets teardown wait for the command that is already in flight.
  function pump(h, v) {
    if (v.pumping || !v.drv) return;
    v.pumping = true;
    v.pumpP = drain(h, v);
  }
  // Pointer moves go along an interpolated path from where the pointer is (h.mouse) to the target. A newer move that
  // arrives meanwhile takes over from the current point, so the page never lags far behind the finger.
  async function glide(h, v, to, { final = false } = {}) {
    const guard = () => { if (!active(h, v)) throw new Error('inactive'); };
    for (const pt of glidePath(h.mouse || to, to)) {
      if (!final && v.queue[0]?.type === 'move') return;
      guard(); await v.drv.move(pt.x, pt.y, !!v.pressed);
      h.mouse = pt;
      if (v.pressed) v.pressed = pt; // a drag cut off by teardown is released where the pointer is
      if (stepMs && !v.queue.length) await sleep(stepMs);
    }
  }
  async function drain(h, v) {
    const d = v.drv;
    const guard = () => { if (!active(h, v)) throw new Error('inactive'); };
    try {
      while (v.queue.length && active(h, v)) {
        const m = v.queue.shift();
        try {
          if (m.type === 'click') {
            v.pressed = { x: m.x, y: m.y }; // set first: teardown must release even if it lands mid-press
            guard(); await d.mouse('down', m.x, m.y, guard);
            guard(); await d.mouse('up', m.x, m.y, guard);
            v.pressed = false;
            h.mouse = { x: m.x, y: m.y };
          } else if (m.type === 'move') {
            await glide(h, v, m);
          } else if (m.type === 'down') {
            if (v.pressed) continue;
            await glide(h, v, m, { final: true });
            v.pressed = { x: m.x, y: m.y };
            guard(); await d.mouse('down', m.x, m.y, guard);
          } else if (m.type === 'up') {
            if (!v.pressed) continue;
            await glide(h, v, m, { final: true });
            guard(); await d.mouse('up', m.x, m.y, guard);
            v.pressed = false;
          } else if (m.type === 'wheel') {
            guard(); await d.wheel(m.x, m.y, m.dx, m.dy, guard);
            h.mouse = { x: m.x, y: m.y };
          } else if (m.type === 'text') {
            guard(); await d.text(m.text);
          } else if (m.type === 'key') {
            guard(); await d.key(m.key, 'down');
            guard(); await d.key(m.key, 'up');
          }
        } catch { /* a single failed input is not fatal */ } finally {
          m.text = null; // typed or pasted text is not kept once dispatched
        }
      }
    } finally {
      v.pumping = false;
    }
  }

  // Release a held button and stop the stream. Runs once, after any in-flight input has returned.
  async function cleanup(v) {
    const d = v.drv;
    if (!d || v.cleaned) return;
    v.cleaned = true;
    if (v.pressed) await d.mouse('up', v.pressed.x, v.pressed.y, () => {}).catch(() => {});
    v.pressed = false;
    await d.stop();
  }

  // Revokes the viewer at once; the returned promise settles when its in-flight input and capture have returned and
  // CDP is detached.
  function teardown(h, v) {
    if (v.closed) return v.finished;
    v.closed = true;
    for (const m of v.queue) m.text = null;
    v.queue.length = 0;
    clearInterval(v.hb);
    clearInterval(v.refresh);
    if (h.viewer === v) h.viewer = null;
    v.finished = (async () => { await v.startP?.catch(() => {}); await v.pumpP?.catch(() => {}); await v.snapP?.catch(() => {}); await cleanup(v); })();
    h.teardowns.add(v.finished);
    try { if (v.ws.readyState === WebSocket.OPEN) v.ws.close(); else v.ws.terminate(); } catch {}
    return v.finished;
  }

  // The handoff resolves only after every viewer's input has drained, so nothing the human sent can reach the page
  // once the agent is back. If draining hangs, drainFailed tells the owner to give up on the session.
  function finish(h, status) {
    if (h.done) return;
    h.done = true;
    h.lastFrame = null;
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
      const driver = opts.driver || 'cdp';
      if (!DRIVERS[driver]) throw new Error(`unknown live-view driver ${driver}`);
      const h = { token, page, reason, driver, resolve, viewer: null, done: false, expiresAt: Date.now() + ttl, teardowns: new Set(), drainFailed: false, lastFrame: null, mouse: null };
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
