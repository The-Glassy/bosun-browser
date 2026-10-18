#!/usr/bin/env node
// Bosun prototype M0: MCP (stdio) server over Playwright Chromium.
// One tenant, sessions = browser contexts in one headful (Xvfb) or headless browser.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const DATA = process.env.BROWSER_DATA || './data';
const HEADLESS = process.env.HEADLESS === '1';
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 3);
fs.mkdirSync(path.join(DATA, 'profiles'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'shots'), { recursive: true });

const sessions = new Map(); // id -> { ctx, page, profile, refs }
let seq = 0;
let ephemeralBrowser = null;

async function getBrowser() {
  if (!ephemeralBrowser) ephemeralBrowser = await chromium.launch({ headless: HEADLESS, args: ['--disable-blink-features=AutomationControlled'] });
  return ephemeralBrowser;
}
const ctxOpts = (o) => ({ viewport: { width: 1366, height: 900 }, locale: o.locale || 'de-AT', timezoneId: o.timezone || 'Europe/Vienna' });

function sess(id) { const s = sessions.get(id); if (!s) throw new Error(`no session ${id}`); return s; }
function sight(id) { const s = sess(id); if (s.handoff) throw new Error('a human is working in this tab (handoff active) — call handoff_wait first'); return s; }

import { createLiveView } from './liveview.mjs';
const live = process.env.LIVE_PORT ? createLiveView({ port: Number(process.env.LIVE_PORT), baseUrl: process.env.LIVE_BASE_URL || `http://127.0.0.1:${process.env.LIVE_PORT}` }) : null;

// Heuristic bot-wall detection after navigation/click.
async function wall(p) {
  try {
    const title = (await p.title()).toLowerCase();
    if (/just a moment|nur einen moment|attention required|verify you are human|robot/.test(title)) return 'bot check page';
    const f = p.frames().map((f) => f.url()).join(' ');
    if (/recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|captcha-delivery|geo\.captcha/.test(f)) return 'captcha';
    const t = (await p.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 3000).toLowerCase();
    if (/(kein roboter|not a robot|are you a human|zugriff blockiert|access denied)/.test(t)) return 'bot check text';
  } catch {}
  return null;
}
const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
async function pageInfo(p) { return { url: p.url(), title: await p.title().catch(() => '') }; }

// Locate an element: ref (from read a11y: "e12" -> aria-ref), role+name, css, or visible text.
function locate(p, t) {
  if (t.ref) return p.locator(`aria-ref=${t.ref}`);
  if (t.role) return p.getByRole(t.role, t.name ? { name: t.name } : {}).first();
  if (t.selector) return p.locator(t.selector).first();
  if (t.text) return p.getByText(t.text, { exact: false }).first();
  throw new Error('give ref, role(+name), selector or text');
}
const target = { ref: z.string().optional().describe('element ref from read (e.g. "e12")'), role: z.string().optional(), name: z.string().optional(), selector: z.string().optional(), text: z.string().optional() };

function buildServer() {
const server = new McpServer({ name: 'bosun', version: '0.0.1' });

server.tool('session_open', 'Open a browser session. Without profile: ephemeral (wiped on close). With profile: persistent per-tenant profile (stays logged in).',
  { profile: z.string().regex(/^[a-z0-9_-]{1,40}$/).optional(), locale: z.string().optional(), timezone: z.string().optional() },
  async (a) => {
    if (sessions.size >= MAX_SESSIONS) throw new Error(`session limit ${MAX_SESSIONS} reached; close one`);
    const id = `s${++seq}`;
    let ctx;
    if (a.profile) {
      ctx = await chromium.launchPersistentContext(path.join(DATA, 'profiles', a.profile), { headless: HEADLESS, args: ['--disable-blink-features=AutomationControlled'], ...ctxOpts(a) });
    } else {
      ctx = await (await getBrowser()).newContext(ctxOpts(a));
    }
    const page = ctx.pages()[0] || await ctx.newPage();
    sessions.set(id, { ctx, page, profile: a.profile || null });
    return ok({ session: id, profile: a.profile || 'ephemeral' });
  });

server.tool('session_close', 'Close a session (persistent profile stays on disk).', { session: z.string() }, async ({ session }) => {
  const s = sess(session); await s.ctx.close(); sessions.delete(session); return ok({ closed: session });
});

server.tool('navigate', 'Go to a URL.', { session: z.string(), url: z.string().url(), wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional() }, async (a) => {
  const s = sight(a.session);
  const r = await s.page.goto(a.url, { waitUntil: a.wait || 'domcontentloaded', timeout: 45000 });
  await s.page.waitForTimeout(1200);
  const w = await wall(s.page);
  return ok({ status: r?.status(), ...(await pageInfo(s.page)), ...(w ? { blocked: w, hint: 'call request_human to let a person solve it' } : {}) });
});

server.tool('read', 'Read the page. mode a11y (default): accessibility snapshot with element refs [ref=eN] usable by click/type. mode text: visible text.',
  { session: z.string(), mode: z.enum(['a11y', 'text']).optional(), selector: z.string().optional(), maxChars: z.number().int().optional() },
  async (a) => {
    const s = sight(a.session); const max = a.maxChars || 20000;
    const root = a.selector ? s.page.locator(a.selector).first() : s.page.locator('body');
    let out;
    if ((a.mode || 'a11y') === 'a11y') out = await (a.selector ? root.ariaSnapshot({ mode: "ai" }) : s.page.ariaSnapshot({ mode: "ai" }));
    else out = (await root.innerText()).replace(/\n{3,}/g, '\n\n');
    out = out.replace(/(textbox "[^"]*(passw|kennw|heslo|hasło)[^"]*"[^\n]*?): .*/gi, '$1: [masked]');
    const info = await pageInfo(s.page);
    return ok(`url: ${info.url}\ntitle: ${info.title}\nchars: ${out.length}${out.length > max ? ` (truncated to ${max})` : ''}\n\n${out.slice(0, max)}`);
  });

server.tool('click', 'Click an element (by ref from read, role+name, selector or text).', { session: z.string(), ...target }, async (a) => {
  const s = sight(a.session); await locate(s.page, a).click({ timeout: 15000 }); await s.page.waitForTimeout(1000);
  const w = await wall(s.page);
  return ok({ ...(await pageInfo(s.page)), ...(w ? { blocked: w } : {}) });
});

server.tool('type', 'Fill a field. submit=true presses Enter.', { session: z.string(), ...target, value: z.string(), submit: z.boolean().optional() }, async (a) => {
  const s = sight(a.session); const l = locate(s.page, a); await l.fill(a.value, { timeout: 15000 });
  if (a.submit) { await l.press('Enter'); await s.page.waitForTimeout(1500); }
  return ok(await pageInfo(s.page));
});

server.tool('select', 'Choose an option in a <select>.', { session: z.string(), ...target, value: z.string() }, async (a) => {
  const s = sess(a.session); await locate(s.page, a).selectOption({ label: a.value }).catch(() => locate(s.page, a).selectOption(a.value));
  return ok(await pageInfo(s.page));
});

server.tool('press', 'Press a key (Enter, Escape, PageDown, …).', { session: z.string(), key: z.string() }, async (a) => {
  const s = sess(a.session); await s.page.keyboard.press(a.key); await s.page.waitForTimeout(600); return ok(await pageInfo(s.page));
});

server.tool('back', 'History back.', { session: z.string() }, async (a) => { const s = sess(a.session); await s.page.goBack(); return ok(await pageInfo(s.page)); });

server.tool('wait_for', 'Wait for text or selector to appear.', { session: z.string(), text: z.string().optional(), selector: z.string().optional(), timeoutMs: z.number().int().optional() }, async (a) => {
  const s = sess(a.session); const t = a.timeoutMs || 15000;
  if (a.text) await s.page.getByText(a.text).first().waitFor({ timeout: t }); else if (a.selector) await s.page.locator(a.selector).first().waitFor({ timeout: t });
  return ok(await pageInfo(s.page));
});

server.tool('screenshot', 'Screenshot of the viewport (or an element). Returns an image; also saved to the shots dir.', { session: z.string(), ...target, fullPage: z.boolean().optional() }, async (a) => {
  const s = sight(a.session);
  const file = path.join(DATA, 'shots', `${a.session}-${Date.now()}.jpg`);
  const opt = { type: 'jpeg', quality: 70, path: file };
  const buf = (a.ref || a.role || a.selector || a.text) ? await locate(s.page, a).screenshot(opt) : await s.page.screenshot({ ...opt, fullPage: !!a.fullPage });
  return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: file }] };
});

server.tool('request_human', 'Ask a human to take over this tab (CAPTCHA, cookie wall, login, 2FA). Returns a one-time live-view link at once (wait=false, default) — send it to your human, then call handoff_wait. With wait=true it blocks until the human presses Done or the link expires (15 min). While a handoff is active, read/screenshot are blocked so typed secrets never reach the model.',
  { session: z.string(), reason: z.string(), wait: z.boolean().optional() }, async (a) => {
    const s = sess(a.session);
    if (!live) throw new Error('live view not configured (LIVE_PORT/LIVE_BASE_URL)');
    let h = live.activeFor(a.session);
    if (!h) { const st = live.start(s.page, a.reason, a.session); s.handoff = st; h = st; }
    const url = s.handoff.url;
    if (!a.wait) return ok({ status: 'waiting_for_human', link: url, expires_in_min: 15, next: 'send the link to your human, then call handoff_wait' });
    const status = await s.handoff.wait; s.handoff = null;
    return ok({ status, ...(await pageInfo(s.page)) });
  });

server.tool('handoff_wait', 'Wait for the human to finish an active handoff (up to timeoutSec, default 300). Call again if it returns still_waiting.',
  { session: z.string(), timeoutSec: z.number().int().optional() }, async (a) => {
    const s = sess(a.session);
    if (!s.handoff) return ok({ status: 'no_active_handoff', ...(await pageInfo(s.page)) });
    const t = Math.min(a.timeoutSec || 300, 1800) * 1000;
    const status = await Promise.race([s.handoff.wait, new Promise((r) => setTimeout(() => r('still_waiting'), t))]);
    if (status !== 'still_waiting') s.handoff = null;
    return ok({ status, ...(await pageInfo(s.page)) });
  });

server.tool('sessions', 'List open sessions.', {}, async () => ok([...sessions].map(([id, s]) => ({ id, profile: s.profile || 'ephemeral', url: s.page.url() }))));
return server;
}

const shutdown = async () => { for (const s of sessions.values()) await s.ctx.close().catch(() => {}); if (ephemeralBrowser) await ephemeralBrowser.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);

if (process.env.WS_PORT) {
  // WebSocket transport: one MCP server per connection, shared browser/sessions. Token via ?token= or Authorization.
  const { WebSocketServer } = await import('ws');
  const TOKEN = process.env.BROWSER_TOKEN || '';
  const wss = new WebSocketServer({ host: process.env.WS_HOST || '127.0.0.1', port: Number(process.env.WS_PORT) });
  wss.on('connection', async (ws, req) => {
    const u = new URL(req.url, 'http://x');
    const got = u.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer /, '');
    if (TOKEN && got !== TOKEN) return ws.close(4401, 'bad token');
    const transport = {
      start: async () => {},
      send: async (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); },
      close: async () => ws.close(),
    };
    ws.on('message', (d) => { try { transport.onmessage?.(JSON.parse(d)); } catch (e) { transport.onerror?.(e); } });
    ws.on('close', () => transport.onclose?.());
    await buildServer().connect(transport);
  });
  console.error(`browser-mcpl ws on 127.0.0.1:${process.env.WS_PORT}`);
} else {
  process.stdin.on('close', shutdown);
  await buildServer().connect(new StdioServerTransport());
}
