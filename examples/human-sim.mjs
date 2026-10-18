// simulates the human: node examples/human-sim.mjs <link-file>. Opens the link page, attaches to the live view over
// WebSocket, saves the first frame, scrolls, presses Done. Never prints the link.
import WebSocket from 'ws';
import fs from 'fs';
const file = process.argv[2];
if (!file) { console.error('usage: node examples/human-sim.mjs <link-file written by handoff-client.mjs>'); process.exit(2); }
const link = fs.readFileSync(file, 'utf8').trim();
const page = await (await fetch(link)).text();
console.log('page bytes', page.length, page.includes('<canvas') ? 'has canvas' : 'NO canvas');
const ws = new WebSocket(link.replace('http', 'ws').replace('/v/', '/ws/'));
let frames = 0;
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.viewer) console.log('attached (other viewers are refused while this one is connected)');
  if (m.frame) {
    frames++;
    if (frames === 1) { fs.writeFileSync('./liveview-frame.jpg', Buffer.from(m.frame, 'base64'), { mode: 0o600 }); console.log('frame', m.w, m.h); ws.send(JSON.stringify({ type: 'wheel', x: 600, y: 400, dy: 200 })); setTimeout(() => ws.send(JSON.stringify({ type: 'done' })), 1500); }
  }
  if (m.end) { console.log('end:', m.end, 'frames', frames); process.exit(0); }
});
ws.on('error', (e) => { console.error('live view:', e.message); process.exit(1); });
setTimeout(() => { console.log('timeout, frames', frames); process.exit(1); }, 30000);
