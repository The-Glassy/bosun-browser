// MCP tool surface. One McpServer per connection; every session lookup is scoped to that connection (owner).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { countNodes, maskText, maskedScreenshot, sensitiveValues } from './redact.mjs';
import { TENANT_RE } from './auth.mjs';

const MAX_SHOT_PX = 8000; // tallest full-page screenshot, CSS px
const POLL_SEC = 50; // default handoff wait: below the MCP SDK's 60 s request timeout

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

// Agent navigation is limited to the web. file:, javascript:, data:, chrome:, about:, view-source: … are refused.
export function httpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`only http:// and https:// URLs are allowed (got ${u.protocol})`);
  return u.href;
}

// Playwright errors carry a call log that can quote page markup; keep only the headline.
const cleanError = (e) => String(e?.message || e).split('\nCall log:')[0].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 500);

// Locate an element: ref (from read a11y: "e12" -> aria-ref), role+name, css, or visible text.
function locate(p, t) {
  if (t.ref) return p.locator(`aria-ref=${t.ref}`);
  if (t.role) return p.getByRole(t.role, t.name ? { name: t.name } : {}).first();
  if (t.selector) return p.locator(t.selector).first();
  if (t.text) return p.getByText(t.text, { exact: false }).first();
  throw new Error('give ref, role(+name), selector or text');
}
const str = (n) => z.string().max(n);
const target = { ref: str(20).optional().describe('element ref from read (e.g. "e12")'), role: str(40).optional(), name: str(1000).optional(), selector: str(2000).optional(), text: str(1000).optional() };
const hasTarget = (a) => !!(a.ref || a.role || a.selector || a.text);

export function buildServer({ manager, owner, tenant, cfg, conn = { inflight: 0 } }) {
  const server = new McpServer({ name: 'bosun', version: '0.0.2' });
  const run = (id, fn) => manager.run(owner, id, fn);

  // Every tool: bounded concurrency per connection, sanitized errors.
  const tool = (name, desc, shape, fn) => server.tool(name, desc, shape, async (a, extra) => {
    if (conn.inflight >= cfg.maxInflight) throw new Error(`too many concurrent requests on this connection (max ${cfg.maxInflight})`);
    conn.inflight++;
    try { return await fn(a, extra); } catch (e) { throw new Error(cleanError(e)); } finally { conn.inflight--; }
  });

  tool('session_open', 'Open a browser session. Without profile: ephemeral (wiped on close). With profile: persistent per-tenant profile (stays logged in).',
    { profile: z.string().regex(TENANT_RE).optional(), locale: str(35).optional(), timezone: str(64).optional() },
    async (a) => {
      const s = await manager.open({ owner, tenant, profile: a.profile, locale: a.locale, timezone: a.timezone });
      return ok({ session: s.id, profile: a.profile || 'ephemeral' });
    });

  tool('session_close', 'Close a session (persistent profile stays on disk).', { session: str(40) }, async ({ session }) => {
    await manager.close(owner, session);
    return ok({ closed: session });
  });

  tool('navigate', 'Go to a URL (http/https only).', { session: str(40), url: z.string().max(4096).url(), wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional() }, async (a) => {
    const url = httpUrl(a.url);
    return run(a.session, async (s) => {
      const r = await s.page.goto(url, { waitUntil: a.wait || 'domcontentloaded', timeout: 45000 });
      await s.page.waitForTimeout(1200);
      const w = await wall(s.page);
      return ok({ status: r?.status(), ...(await pageInfo(s.page)), ...(w ? { blocked: w, hint: 'call request_human to let a person solve it' } : {}) });
    });
  });

  tool('read', 'Read the page. mode a11y (default): accessibility snapshot with element refs [ref=eN] usable by click/type. mode text: visible text. Values of password/PIN/OTP fields are masked.',
    { session: str(40), mode: z.enum(['a11y', 'text']).optional(), selector: str(2000).optional(), maxChars: z.number().int().min(1).max(200000).optional() },
    async (a) => run(a.session, async (s) => {
      const max = a.maxChars ?? 20000;
      const root = a.selector ? s.page.locator(a.selector).first() : s.page.locator('body');
      let out, total;
      if ((a.mode || 'a11y') === 'a11y') {
        if (!a.selector) {
          const nodes = await countNodes(s.page, cfg.maxDomNodes);
          if (nodes > cfg.maxDomNodes) throw new Error(`page has more than ${cfg.maxDomNodes} elements (frames and shadow roots included); read a part of it with selector, or use mode text`);
        }
        out = await (a.selector ? root.ariaSnapshot({ mode: 'ai', timeout: 15000 }) : s.page.ariaSnapshot({ mode: 'ai', timeout: 15000 }));
        total = out.length;
      } else {
        // Truncate in the page so a huge document never crosses the wire whole.
        [total, out] = await root.evaluate((el, n) => { const t = el.innerText.replace(/\n{3,}/g, '\n\n'); return [t.length, t.slice(0, n)]; }, max, { timeout: 15000 });
      }
      out = maskText(out, await sensitiveValues(s.page));
      const info = await pageInfo(s.page);
      return ok(`url: ${info.url}\ntitle: ${info.title}\nchars: ${total}${total > max ? ` (truncated to ${max})` : ''}\n\n${out.slice(0, max)}`);
    }));

  tool('click', 'Click an element (by ref from read, role+name, selector or text).', { session: str(40), ...target }, async (a) => run(a.session, async (s) => {
    await locate(s.page, a).click({ timeout: 15000 });
    await s.page.waitForTimeout(1000);
    const w = await wall(s.page);
    return ok({ ...(await pageInfo(s.page)), ...(w ? { blocked: w } : {}) });
  }));

  tool('type', 'Fill a field. submit=true presses Enter.', { session: str(40), ...target, value: str(10000), submit: z.boolean().optional() }, async (a) => run(a.session, async (s) => {
    const l = locate(s.page, a);
    await l.fill(a.value, { timeout: 15000 });
    if (a.submit) { await l.press('Enter', { timeout: 15000 }); await s.page.waitForTimeout(1500); }
    return ok(await pageInfo(s.page));
  }));

  tool('select', 'Choose an option in a <select>.', { session: str(40), ...target, value: str(1000) }, async (a) => run(a.session, async (s) => {
    await locate(s.page, a).selectOption({ label: a.value }, { timeout: 15000 }).catch(() => locate(s.page, a).selectOption(a.value, { timeout: 15000 }));
    return ok(await pageInfo(s.page));
  }));

  tool('press', 'Press a key (Enter, Escape, PageDown, …).', { session: str(40), key: str(50) }, async (a) => run(a.session, async (s) => {
    await s.page.keyboard.press(a.key);
    await s.page.waitForTimeout(600);
    return ok(await pageInfo(s.page));
  }));

  tool('back', 'History back.', { session: str(40) }, async (a) => run(a.session, async (s) => {
    await s.page.goBack({ timeout: 30000 });
    return ok(await pageInfo(s.page));
  }));

  tool('wait_for', 'Wait for text or selector to appear (timeoutMs up to 60000).', { session: str(40), text: str(1000).optional(), selector: str(2000).optional(), timeoutMs: z.number().int().min(1).max(60000).optional() }, async (a) => run(a.session, async (s) => {
    const t = a.timeoutMs ?? 15000;
    if (a.text) await s.page.getByText(a.text).first().waitFor({ timeout: t });
    else if (a.selector) await s.page.locator(a.selector).first().waitFor({ timeout: t });
    return ok(await pageInfo(s.page));
  }));

  tool('screenshot', `Screenshot of the viewport (or an element; fullPage is cut at ${MAX_SHOT_PX}px). Returns an image with password/OTP fields masked. Saved to disk only with SAVE_SHOTS=1.`,
    { session: str(40), ...target, fullPage: z.boolean().optional() }, async (a) => run(a.session, async (s) => {
      const opt = { type: 'jpeg', quality: 70, timeout: 30000 };
      const buf = await maskedScreenshot(s.page, async (mask) => {
        if (hasTarget(a)) {
          const l = locate(s.page, a);
          const box = await l.boundingBox({ timeout: 15000 });
          if (box && box.width * box.height > MAX_SHOT_PX * 2000) throw new Error('element too large to screenshot');
          return l.screenshot({ ...opt, mask });
        }
        if (!a.fullPage) return s.page.screenshot({ ...opt, mask });
        const [w, h] = await s.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
        return s.page.screenshot({ ...opt, mask, fullPage: true, clip: { x: 0, y: 0, width: Math.min(w, 4000), height: Math.min(h, MAX_SHOT_PX) } });
      });
      const file = await manager.saveShot(s, buf);
      return { content: [{ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }, { type: 'text', text: file || 'not saved to disk (SAVE_SHOTS=1 enables it)' }] };
    }));

  const waitResult = async (id, status, h) => {
    if (status === 'still_waiting') return ok({ status, expires_in_sec: Math.max(0, Math.round((h.expiresAt - Date.now()) / 1000)), next: 'call handoff_wait again' });
    const info = await run(id, async (s) => pageInfo(s.page)).catch(() => ({}));
    return ok({ status, ...info });
  };

  tool('request_human', `Ask a human to take over this tab (CAPTCHA, cookie wall, login, 2FA). Returns a one-time live-view link at once (wait=false, default) — send it to your human, then call handoff_wait. With wait=true it also waits up to ${POLL_SEC}s and may return still_waiting. While a handoff is active, every page tool (read, screenshot, click, type, navigate, …) is refused and no URL/title is reported.`,
    { session: str(40), reason: z.string().min(1).max(300), wait: z.boolean().optional() }, async (a, extra) => {
      const h = await manager.requestHuman(owner, a.session, a.reason);
      const pending = { status: 'waiting_for_human', link: h.url, expires_in_min: Math.max(0, Math.round((h.expiresAt - Date.now()) / 60000)), next: 'send the link to your human, then call handoff_wait' };
      if (!a.wait) return ok(pending);
      const status = await manager.waitHandoff(owner, a.session, POLL_SEC * 1000, extra?.signal);
      if (status === 'still_waiting') return ok({ ...pending, status });
      return waitResult(a.session, status ?? 'no_active_handoff', h);
    });

  tool('handoff_wait', `Wait for the human to finish an active handoff (up to timeoutSec, default ${POLL_SEC}; above ~55 raise your MCP client's request timeout). Call again if it returns still_waiting.`,
    { session: str(40), timeoutSec: z.number().int().min(1).max(1800).optional() }, async (a, extra) => {
      const h = manager.get(owner, a.session).handoff;
      const status = await manager.waitHandoff(owner, a.session, (a.timeoutSec ?? POLL_SEC) * 1000, extra?.signal);
      return waitResult(a.session, status ?? 'no_active_handoff', h);
    });

  tool('sessions', 'List your open sessions.', {}, async () => ok(manager.list(owner).map((s) => (
    s.handoff ? { id: s.id, profile: s.profile || 'ephemeral', handoff: 'active' } : { id: s.id, profile: s.profile || 'ephemeral', url: s.page.url() }
  ))));

  return server;
}
