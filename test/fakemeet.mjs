// A local stand-in for Google Meet with the labels and markers platforms/meet.mjs relies on: a lobby (mic and camera
// toggles, guest name, "Ask to join"), the waiting room, admission or denial, an in-call toolbar, participant tiles, a
// chat panel, the end of the call and removal. The test plays host through the returned object (admit, deny, say,
// end, ...). With tone: true the admitted page plays a 440 Hz tone (audio pipeline test).
import http from 'http';
import fs from 'fs';
import path from 'path';

const APP = `<!doctype html><meta charset="utf-8"><title>Meet</title>
<style>[hidden]{display:none!important} .tile{display:inline-block;width:80px;height:60px;background:#333;margin:4px}</style>
<div id="lobby"><h1>Ready to join?</h1>
  <button id="mic" aria-label="Turn off microphone">mic</button><button id="cam" aria-label="Turn off camera">cam</button>
  <input aria-label="Your name" placeholder="Your name"><button id="ask"><span>Ask to join</span></button></div>
<div id="waiting" hidden><p>Asking to be let in…</p><p>You’ll join the call when someone lets you in</p></div>
<div id="denied" hidden><h1>You can’t join this call</h1><p>Someone in the call denied your request to join</p></div>
<div id="call" hidden><div id="tiles"></div>
  <div role="toolbar"><button aria-label="Chat with everyone">chat</button><button aria-label="Leave call">leave</button></div>
  <aside id="panel" hidden><div role="list" id="msgs"></div><textarea aria-label="Send a message"></textarea></aside></div>
<div id="over" hidden><h1 id="overText"></h1></div>
<script>
const code = location.pathname.slice(1), $ = (id) => document.getElementById(id);
const post = (p, b) => fetch('/api/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, ...b }) });
let mic = true, cam = true, shown = new Set(), toned = false;
$('mic').onclick = () => { mic = !mic; $('mic').setAttribute('aria-label', mic ? 'Turn off microphone' : 'Turn on microphone'); };
$('cam').onclick = () => { cam = !cam; $('cam').setAttribute('aria-label', cam ? 'Turn off camera' : 'Turn on camera'); };
$('ask').onclick = () => post('ask', { name: document.querySelector('input[aria-label="Your name"]').value, mic, cam });
document.querySelector('[aria-label="Chat with everyone"]').onclick = () => { $('panel').hidden = false; };
document.querySelector('[aria-label="Leave call"]').onclick = () => post('leave', {});
const box = document.querySelector('textarea');
box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = box.value.trim(); box.value = ''; if (t) post('chat', { text: t }); } });
const TOGGLES = '__TOGGLES__'; // 'none': no mic/camera buttons, 'stuck': the mic button does nothing
$('mic').hidden = $('cam').hidden = TOGGLES === 'none';
if (TOGGLES === 'stuck') $('mic').onclick = null;
async function poll() {
  const s = await (await fetch('/api/state?code=' + code)).json();
  for (const id of ['lobby', 'waiting', 'denied', 'call', 'over']) $(id).hidden = s.view !== id;
  if (s.view === 'over') $('overText').textContent = s.over;
  if (s.view === 'call') {
    const want = s.participants.join();
    if ($('tiles').dataset.p !== want) {
      $('tiles').dataset.p = want;
      $('tiles').replaceChildren(...s.participants.map((p) => { const t = document.createElement('div'); t.className = 'tile'; t.dataset.participantId = p; t.textContent = p; return t; }));
    }
    for (const m of s.chat) {
      if (shown.has(m.id)) { const d = document.querySelector('[data-message-id="' + m.id + '"]'); if (d.textContent !== m.text) d.textContent = m.text; continue; }
      shown.add(m.id);
      const g = document.createElement('div');
      g.dataset.senderName = m.self ? 'You' : m.sender;
      const d = document.createElement('div');
      d.dataset.messageId = m.id;
      d.textContent = m.text; // may be empty at first and filled in by a later poll (lateMs)
      g.append(d);
      $('msgs').append(g);
    }
    if (s.tone && !toned) { toned = true; const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = 440; o.connect(c.destination); o.start(); }
  }
  setTimeout(poll, 150);
}
poll();
</script>`;

export async function startFakeMeet({ tone = false } = {}) {
  const rooms = new Map();
  const room = (code) => {
    if (!rooms.has(code)) rooms.set(code, { phase: 'lobby', guest: null, chat: [], others: ['host-1', 'guest-2'], over: null, tone, log: [], seq: 0 });
    return rooms.get(code);
  };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(APP.replace('__TOGGLES__', room(u.pathname.slice(1)).toggles || 'ok'));
    }
    if (u.pathname === '/api/state') {
      const r = room(u.searchParams.get('code'));
      const view = r.over ? 'over' : r.phase === 'waiting' ? 'waiting' : r.phase === 'denied' ? 'denied' : r.phase === 'admitted' ? 'call' : 'lobby';
      const chat = r.chat.map((m) => (m.fillAt && Date.now() < m.fillAt ? { ...m, text: '' } : m));
      return json({ view, over: r.over, participants: ['self', ...r.others], chat, tone: r.tone });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      const r = room(b.code);
      if (u.pathname === '/api/ask') { r.guest = { name: b.name, mic: b.mic, cam: b.cam }; r.phase = r.open ? 'admitted' : 'waiting'; r.log.push(['ask', Date.now()]); }
      if (u.pathname === '/api/chat') { r.chat.push({ id: `c${++r.seq}`, sender: r.guest?.name, self: true, text: b.text }); r.log.push(['chat', Date.now(), b.text]); }
      if (u.pathname === '/api/leave') { r.left = true; r.over = 'You left the meeting'; r.log.push(['leave', Date.now()]); }
      return json({ ok: true });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let n = 0;
  return {
    base,
    newRoom: () => { const c = `abc-defg-h${String.fromCharCode(97 + (n++ % 26))}${String.fromCharCode(97 + Math.floor(n / 26) % 26)}`; room(c); return { code: c, url: `${base}/${c}` }; },
    room,
    admit: (c) => { room(c).phase = 'admitted'; room(c).log.push(['admit', Date.now()]); },
    open: (c) => { room(c).open = true; },
    deny: (c) => { room(c).phase = 'denied'; },
    // lateMs: the message shows up empty first and gets its text that much later (incremental rendering).
    say: (c, sender, text, { lateMs = 0 } = {}) => { const r = room(c); r.chat.push({ id: `c${++r.seq}`, sender, text, ...(lateMs ? { fillAt: Date.now() + lateMs } : {}) }); },
    toggles: (c, mode) => { room(c).toggles = mode; }, // 'none': no mic/camera buttons, 'stuck': the mic button does nothing
    setOthers: (c, others) => { room(c).others = others; },
    end: (c) => { room(c).over = 'The call has ended'; },
    remove: (c) => { room(c).over = 'You’ve been removed from the meeting'; },
    close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }),
  };
}

// Fake audio backend for hosts without PulseAudio: no audio server, the browser is muted, and the "recorder" writes a
// growing Ogg-looking file until stopped.
// openMs: the audio server takes that long to start; stopMs: a graceful stop takes that long (a kill is immediate).
export function fakeAudio({ openMs = 0, stopMs = 0 } = {}) {
  const recorders = [];
  const stats = { opened: 0, closed: 0 };
  return {
    recorders,
    stats,
    unsupported: async () => null,
    needsHeadful: false,
    async open() {
      stats.opened++;
      if (openMs) await new Promise((r) => setTimeout(r, openMs));
      let closed = false;
      return {
        browserEnv: undefined,
        args: ['--mute-audio'],
        record(file) {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, 'OggS', { mode: 0o600 });
          let done;
          const exited = new Promise((r) => { done = r; });
          const t = setInterval(() => fs.appendFileSync(file, Buffer.alloc(200, 1)), 100);
          const rec = { file, startedAt: Date.now(), exited, killed: false, error: () => null };
          let stopping = null;
          const end = async (killed) => { clearInterval(t); rec.killed = rec.killed || killed; rec.ended = Date.now(); done({}); };
          rec.stop = () => (stopping ??= (async () => { if (stopMs) await Promise.race([new Promise((r) => setTimeout(r, stopMs)), exited]); await end(false); })());
          rec.kill = () => end(true);
          recorders.push(rec);
          return rec;
        },
        close: async () => { if (!closed) { closed = true; stats.closed++; } },
      };
    },
  };
}
