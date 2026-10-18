// simulates the human: open link page, connect ws, get a frame, click, press Done.
import WebSocket from 'ws';
import fs from 'fs';
const link = fs.readFileSync('/tmp/handoff-link.txt', 'utf8').trim();
const page = await (await fetch(link)).text();
console.log('page bytes', page.length, page.includes('<canvas') ? 'has canvas' : 'NO canvas');
const ws = new WebSocket(link.replace('http', 'ws').replace('/v/', '/ws/'));
let frames = 0;
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.frame) {
    frames++;
    if (frames === 1) { fs.writeFileSync('./liveview-frame.jpg', Buffer.from(m.frame, 'base64')); console.log('frame', m.w, m.h); ws.send(JSON.stringify({ type: 'wheel', x: 600, y: 400, dy: 200 })); setTimeout(() => ws.send(JSON.stringify({ type: 'done' })), 1500); }
  }
  if (m.end) { console.log('end:', m.end, 'frames', frames); process.exit(0); }
});
setTimeout(() => { console.log('timeout, frames', frames); process.exit(1); }, 30000);
