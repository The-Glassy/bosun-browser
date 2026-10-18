// handoff demo: open a page (URL=…), request_human, hand the link to examples/human-sim.mjs, wait.
// The live-view link is a bearer credential: it is never printed; it goes to a private file (0600, own temp dir)
// whose path is printed instead, and the file is removed at the end. Page text is printed only with VERBOSE=1.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
const t = new StdioClientTransport({ command: 'node', args: [new URL('../src/server.mjs', import.meta.url).pathname], env: { ...process.env } });
const c = new Client({ name: 'handoff-demo', version: '0' });
await c.connect(t);
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args });
  const txt = r.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  console.log(`--- ${name} ${r.isError ? 'ERROR' : 'ok'}${process.env.VERBOSE === '1' ? `\n${txt.slice(0, 600)}` : ''}`);
  return { txt, isError: !!r.isError };
};
const s = JSON.parse((await call('session_open', {})).txt).session;
await call('navigate', { session: s, url: process.env.URL || 'https://www.kaufland.at/' });
const h = JSON.parse((await call('request_human', { session: s, reason: 'Cloudflare check — please tick the box' })).txt);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-handoff-'));
const file = path.join(dir, 'link');
fs.writeFileSync(file, h.link + '\n', { mode: 0o600, flag: 'wx' });
console.log(`link written to ${file} — run: node examples/human-sim.mjs ${file}`);
try {
  const blocked = await call('read', { session: s, maxChars: 200 });
  assert.ok(blocked.isError && /handoff active/.test(blocked.txt), 'read must be refused during the handoff');
  let st, rounds = Number(process.env.ROUNDS || 15);
  do { st = JSON.parse((await call('handoff_wait', { session: s })).txt); } while (st.status === 'still_waiting' && --rounds > 0);
  console.log('handoff status:', st.status);
  await call('read', { session: s, mode: 'text', maxChars: 500 });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  await call('session_close', { session: s });
  await c.close();
}
