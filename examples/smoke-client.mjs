// smoke client: spawns server.mjs over stdio and drives it (URL=…, QUERY=…).
// Prints tool status only; page content with VERBOSE=1.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({ command: 'node', args: [new URL('../src/server.mjs', import.meta.url).pathname], env: { ...process.env } });
const c = new Client({ name: 'smoke', version: '0' });
await c.connect(t);
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); const txt = r.content.filter(x => x.type === 'text').map(x => x.text).join('\n'); console.log(`--- ${name} ${r.isError ? 'ERROR' : 'ok'} (${txt.length} chars)${process.env.VERBOSE === '1' ? `\n${txt.slice(0, 900)}` : ''}`); return txt; };
console.log((await c.listTools()).tools.map(t => t.name).join(', '));
const s = JSON.parse(await call('session_open', {})).session;
await call('navigate', { session: s, url: process.env.URL || 'https://geizhals.at/?fs=mac+mini' });
const a11y = await call('read', { session: s, maxChars: 3000 });
const m = a11y.match(/searchbox[^\n]*\[ref=(e\d+)\]/) || a11y.match(/textbox[^\n]*\[ref=(e\d+)\]/);
if (m) { await call('type', { session: s, ref: m[1], value: process.env.QUERY || 'mac mini m4 32gb', submit: true }); await call('read', { session: s, mode: 'text', maxChars: 1200 }); }
await call('screenshot', { session: s });
await call('session_close', { session: s });
await c.close();
