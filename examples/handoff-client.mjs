// handoff test: open Kaufland (bot wall), request_human, print link, wait.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
const t = new StdioClientTransport({ command: 'node', args: [new URL('../src/server.mjs', import.meta.url).pathname], env: { ...process.env } });
const c = new Client({ name: 'handoff-test', version: '0' });
await c.connect(t);
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); const txt = r.content.filter(x => x.type === 'text').map(x => x.text).join('\n'); console.log(`--- ${name} ${r.isError ? 'ERROR' : ''}\n${txt.slice(0, 600)}`); return txt; };
const s = JSON.parse(await call('session_open', {})).session;
await call('navigate', { session: s, url: process.env.URL || 'https://www.kaufland.at/' });
const h = JSON.parse(await call('request_human', { session: s, reason: 'Cloudflare check on Kaufland — please tick the box' }));
fs.writeFileSync('/tmp/handoff-link.txt', h.link + '\n');
await call('read', { session: s, maxChars: 200 }); // must be blocked
let st;
do { st = JSON.parse(await call('handoff_wait', { session: s, timeoutSec: 60 })); } while (st.status === 'still_waiting' && Number(process.env.ROUNDS || 15) > 0 && (process.env.ROUNDS = String(Number(process.env.ROUNDS || 15) - 1)));
await call('read', { session: s, mode: 'text', maxChars: 500 });
await call('session_close', { session: s });
await c.close();
