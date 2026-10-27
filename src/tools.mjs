// MCP tool surface. One McpServer per connection; every session lookup is scoped to that connection (owner).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import crypto from 'crypto';
import { z } from 'zod';
import { countNodes, markSensitive, markValue, maskText, maskedScreenshot, scrubValue, sensitiveValues } from './redact.mjs';
import { NOT_ALLOWED, PROFILES_REFUSED, TENANT_RE } from './auth.mjs';
import { urlKey, httpUrl, HANDOFF_ACTIVE } from './sessions.mjs';

export { httpUrl };
import { MANIFEST, mcplConnection } from './events.mjs';
import { MIN_PERIOD_MIN } from './keepalive.mjs';
import { ANNOUNCE_MODES } from './meetings/index.mjs';
import { meetRefusalPage } from './meetings/platforms/meet.mjs';
import { challengeShown } from './meetings/platforms/common.mjs';
import { BASE64_MAX_BYTES } from './uploads.mjs';
import { DRIVER_LOGS_REFUSED, SECRET_MAX_BYTES, SECRET_TTL_MS, SECRET_URL_TTL_MS, driverLogsValues } from './secrets.mjs';
import { INLINE_MAX_BYTES } from './downloads.mjs';
import { showPattern } from './allow.mjs';
import { currentCall, withDeadline } from './deadline.mjs';
import { MAX_SITES, MAX_STEPS, RUN_DEFAULT_SEC, RUN_MAX_SEC, runMacro } from './macros.mjs';

const MAX_SHOT_PX = 8000; // tallest full-page screenshot, CSS px
const POLL_SEC = 50; // default handoff wait: below the MCP SDK's 60 s request timeout

// Heuristic bot-wall detection after navigation/click.
export const MEET_REFUSED = "Google Meet refused this guest (\"You can't join this video call\"), not a captcha: use a profile signed in to Google, or a residential IP";
// opts.meetHost: tests only (a local Meet stand-in).
export async function wall(p, { meetHost } = {}) {
  try {
    const title = (await p.title()).toLowerCase();
    if (/just a moment|nur einen moment|attention required|verify you are human|robot/.test(title)) return 'bot check page';
    // Meet's refusal page embeds an invisible reCAPTCHA but is a refusal: there is nothing to solve.
    if (await meetRefusalPage(p, meetHost ? { meetHost } : {})) return MEET_REFUSED;
    // Only a challenge that is shown: "protected by reCAPTCHA" pages (Meet, Zoom) carry an invisible one.
    if (await challengeShown(p)) return 'captcha';
    const t = (await p.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 3000).toLowerCase();
    if (/(kein roboter|not a robot|are you a human|zugriff blockiert|access denied)/.test(t)) return 'bot check text';
  } catch {}
  return null;
}
// A bot check that keeps reloading itself (typically Cloudflare refusing the IP): the page looks like a bot check
// (now, or at the same URL within LOOP_WINDOW_MS) and either had more than LOOP_NAVS main-frame navigations to that
// URL within LOOP_WINDOW_MS, or LOOP_CTX_ERRORS page tools failed because it navigated away under them. A page that
// merely reloads itself (a dashboard) is not reported.
export const BOT_LOOP = 'bot check keeps reloading (likely IP reputation); try engine chromium + request_human, or another network';
const LOOP_WINDOW_MS = 30_000, LOOP_NAVS = 5, LOOP_CTX_ERRORS = 3;
const CTX_GONE = /Execution context was destroyed|interrupted by another navigation/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prune = (arr, now) => { while (arr.length && (arr[0].t ?? arr[0]) < now - LOOP_WINDOW_MS) arr.shift(); };
function reloads(s) {
  prune(s.navs, Date.now());
  const here = urlKey(s.page.url());
  return s.navs.filter((n) => n.at === here).length;
}
// Remember that the page at its current URL looked like a bot check (navigate/click see it before the loop shows).
function noteWall(s, w) { if (w) s.wallSeen = { t: Date.now(), at: urlKey(s.page.url()) }; return w; }
async function looksLikeBotCheck(s) {
  const seen = s.wallSeen;
  if (seen && seen.at === urlKey(s.page.url()) && seen.t > Date.now() - LOOP_WINDOW_MS) return true;
  for (let i = 0; i < 3; i++) { // the title may be mid-reload
    if (noteWall(s, await wall(s.page))) return true;
    await sleep(250);
  }
  return false;
}
async function botLoop(s) {
  prune(s.ctxErrors, Date.now());
  if (reloads(s) <= LOOP_NAVS && s.ctxErrors.length < LOOP_CTX_ERRORS) return false;
  return looksLikeBotCheck(s);
}

const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
async function pageInfo(p) { return { url: p.url(), title: await p.title().catch(() => '') }; }


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
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Runs in the page: drags the files of input i onto el (dragenter, dragover, drop, dragleave). true when the page
// cancelled dragover or drop, i.e. something there takes drops. mark: leave the answer on el (main-world run).
function dropFiles(el, i, mark) {
  const dt = new DataTransfer();
  for (const f of i.files) dt.items.add(f);
  const r = el.getBoundingClientRect();
  const at = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new DragEvent('dragenter', at));
  const over = !el.dispatchEvent(new DragEvent('dragover', at));
  const drop = !el.dispatchEvent(new DragEvent('drop', at));
  el.dispatchEvent(new DragEvent('dragleave', at));
  if (mark) el.setAttribute('data-bosun-res', String(over || drop));
  return over || drop;
}

// Puts files (paths on this machine) into the page through the element: an <input type=file> (also a hidden one, or
// a label of one) directly; anything else is clicked and the file chooser it opens is answered; if none opens, the
// files are dropped onto it (synthetic drag events, best effort). method forces one of them. The browser reads the
// files from disk itself: no bytes pass through this process or the protocol.
// mainWorld (camoufox): Firefox hides files that our isolated world put into a DataTransfer from the page, so the drop
// is dispatched by a script element in the page's own world (unless the page's CSP refuses inline scripts).
async function putFiles(page, l, paths, method, { mainWorld = false } = {}) {
  const input = await l.evaluate((el) => {
    const i = el.tagName === 'INPUT' ? el : el.tagName === 'LABEL' ? el.control : null;
    return i && i.type === 'file' ? { multiple: i.multiple, disabled: i.disabled } : null;
  }, null, { timeout: 15000 });
  const many = paths.length > 1;
  if (input && method !== 'drop' && method !== 'chooser') {
    if (many && !input.multiple) throw new Error(`this file input takes one file (no multiple attribute); got ${paths.length}`);
    if (input.disabled) throw new Error('this file input is disabled');
    await l.setInputFiles(paths, { timeout: 30000 });
    const names = await l.evaluate((el) => [...((el.tagName === 'LABEL' ? el.control : el).files || [])].map((f) => f.name)).catch(() => null);
    return { method: 'input', ...(names ? { input_files: names } : {}) };
  }
  if (method === 'input') throw new Error('the element is not a file input (or a label of one); try method chooser or drop');
  if (method !== 'drop') {
    // Listening from before the click (which may wait for the button to become clickable) until a grace period
    // after it: a page may open its chooser asynchronously.
    let fc = null;
    const onChooser = (c) => { fc ??= c; };
    page.on('filechooser', onChooser);
    try {
      await l.click({ timeout: 15000 });
      for (const end = Date.now() + (method === 'chooser' ? 10000 : 5000); !fc && Date.now() < end;) await sleep(100);
    } finally {
      page.off('filechooser', onChooser);
    }
    if (fc) {
      if (many && !fc.isMultiple()) throw new Error(`the file chooser this opened takes one file; got ${paths.length}`);
      await fc.setFiles(paths, { timeout: 30000 });
      return { method: 'chooser' };
    }
    if (method === 'chooser') throw new Error('clicking the element opened no file chooser within 10 s');
  }
  // Drop: the files go into a temporary input of our own, then onto the element as a DataTransfer.
  const tmp = await page.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.style.display = 'none';
    document.documentElement.append(i);
    return i;
  });
  try {
    await tmp.setInputFiles(paths, { timeout: 30000 });
    let accepted = null;
    if (mainWorld) {
      // The elements are found again by a one-off attribute; null: the page's CSP didn't run the script.
      const key = crypto.randomBytes(8).toString('hex');
      await tmp.evaluate((i, k) => i.setAttribute('data-bosun-src', k), key);
      try {
        accepted = await l.evaluate((el, [k, code]) => {
          el.setAttribute('data-bosun-dst', k);
          const sc = document.createElement('script');
          sc.textContent = `(${code})(document.querySelector('[data-bosun-dst="${k}"]'), document.querySelector('[data-bosun-src="${k}"]'), true)`;
          document.documentElement.append(sc);
          sc.remove();
          const r = el.getAttribute('data-bosun-res');
          return r === null ? null : r === 'true';
        }, [key, dropFiles.toString()], { timeout: 15000 });
      } finally {
        await l.evaluate((el) => { el.removeAttribute('data-bosun-dst'); el.removeAttribute('data-bosun-res'); }).catch(() => {});
      }
    }
    const blocked = mainWorld && accepted === null;
    if (accepted === null) accepted = await l.evaluate(dropFiles, tmp, { timeout: 15000 });
    const note = blocked ? "the page's Content-Security-Policy blocked the drop script, and this engine hides files dropped from outside the page: use another engine (chromium) for this page"
      : accepted ? 'synthetic drop (best effort): check the page took the files' : 'nothing on the page handled the drop; this element is probably not a drop zone';
    return { method: 'drop', accepted, note };
  } finally {
    await tmp.evaluate((i) => i.remove()).catch(() => {});
    await tmp.dispose().catch(() => {});
  }
}

// The tools a token with policy "ephemeral" may call: ephemeral sessions and page tools. No profiles, keepalive,
// meetings or handoff.
// Macros: list, get and run (the steps are held to the same set), but not save or delete.
export const EPHEMERAL_TOOLS = new Set(['session_open', 'session_close', 'navigate', 'read', 'click', 'type', 'select', 'press', 'back', 'wait_for', 'screenshot', 'sessions',
  'macro_list', 'macro_get', 'macro_run']);

export function buildServer({ manager, owner, tenant, cfg, policy = 'full', conn = { inflight: 0 }, uploadBase = null }) {
  const ephemeral = policy === 'ephemeral';
  // When this tenant has a host allowlist, say so in the tool description instead of letting the agent guess.
  const allowed = manager.allowList(tenant);
  const allowNote = allowed ? `This token may only reach: ${allowed.map(showPattern).join(', ')}.` : null;
  // Downloads this tenant may keep (BROWSER_TENANT_DOWNLOAD_ALLOW); null: its browsers refuse every download.
  const downloads = manager.downloads?.allowFor(tenant) ? manager.downloads : null;
  const dlHosts = downloads ? downloads.allowFor(tenant).map(showPattern).join(', ') : null;
  // What click and navigate report: a download kept or refused (also "downloads are off for this token").
  const capture = !ephemeral ? manager.downloads ?? null : null;
  const server = new McpServer({ name: 'bosun', version: '0.14.0' }, { capabilities: ephemeral ? {} : { experimental: { mcpl: MANIFEST } } });
  // MCPL push events (needs-human) for this tenant, once the host has granted them.
  if (manager.events && !ephemeral) {
    const mcpl = mcplConnection(server.server, { bus: manager.events, tenant });
    const prev = server.server.onclose;
    server.server.onclose = () => { mcpl.close(); prev?.(); };
  }
  // Page tools: serialized per session, and turned into BOT_LOOP (success or failure) when the page is stuck in a
  // reloading bot check.
  const run = (id, fn) => manager.run(owner, id, async (s) => {
    let r;
    try {
      r = await fn(s);
    } catch (e) {
      if (CTX_GONE.test(String(e?.message || e))) s.ctxErrors.push(Date.now());
      if (await botLoop(s).catch(() => false)) throw new Error(BOT_LOOP);
      throw e;
    }
    if (await botLoop(s)) throw new Error(BOT_LOOP);
    return r;
  });

  // Every tool: bounded concurrency per connection, sanitized errors, and a deadline (deadline.mjs; not for the tools
  // that keep their own limits). A tool the policy doesn't allow is registered as a stub that only refuses (its
  // handler is never wired up) and is left out of tools/list below. The handlers this token may call, with their
  // argument schemas, are also kept in handlers: a macro step runs the same code as the tool.
  const handlers = new Map();
  const tool = (name, desc, shape, fn) => {
    if (ephemeral && !EPHEMERAL_TOOLS.has(name)) return server.tool(name, NOT_ALLOWED, {}, async () => { throw new Error(`${name}: ${NOT_ALLOWED}`); });
    handlers.set(name, { fn, schema: z.object(shape) });
    const limitMs = cfg.toolTimeouts?.get(name) ?? null;
    return server.tool(name, desc, shape, async (a, extra) => {
      if (conn.inflight >= cfg.maxInflight) throw new Error(`too many concurrent requests on this connection (max ${cfg.maxInflight})`);
      conn.inflight++;
      try {
        return limitMs ? await withDeadline(name, limitMs, () => fn(a, extra)) : await fn(a, extra);
      } catch (e) { throw new Error(cleanError(e)); } finally { conn.inflight--; }
    });
  };

  tool('session_open', ephemeral ? `Open an ephemeral browser session (wiped on close). Profiles, and engines other than ${cfg.engine}, are not allowed for this token.` : 'Open a browser session. Without profile: ephemeral (wiped on close). With profile: persistent per-tenant profile (stays logged in).',
    { profile: z.string().regex(TENANT_RE).optional(), locale: str(35).optional(), timezone: str(64).optional(),
      engine: z.enum(cfg.engines).optional().describe(`browser engine (default ${cfg.engine}); enabled here: ${cfg.engines.join(', ')}`) },
    async (a) => {
      if (ephemeral && a.profile !== undefined) throw new Error(PROFILES_REFUSED);
      if (ephemeral && a.engine && a.engine !== cfg.engine) throw new Error(`engine ${a.engine} is ${NOT_ALLOWED}; use the default (${cfg.engine})`);
      const call = currentCall();
      const s = await manager.open({ owner, tenant, profile: a.profile, locale: a.locale, timezone: a.timezone, engine: a.engine, downloads: true });
      // The agent was told this open timed out: a session it never learned about is not left open.
      if (call?.expired) { await manager.dispose(s, 'open-timed-out'); throw new Error('session_open timed out'); }
      return ok({ session: s.id, profile: a.profile || 'ephemeral', engine: s.engine });
    });

  tool('session_close', 'Close a session (persistent profile stays on disk).', { session: str(40) }, async ({ session }) => {
    await manager.close(owner, session);
    return ok({ closed: session });
  });

  tool('navigate', allowNote ? `Go to a URL (http/https only). ${allowNote}` : 'Go to a URL (http/https only).', { session: str(40), url: z.string().max(4096).url(), wait: z.enum(['load', 'domcontentloaded', 'networkidle']).optional() }, async (a) => {
    const url = manager.checkAllowed(tenant, httpUrl(a.url));
    return run(a.session, async (s) => {
      const t0 = Date.now();
      const mark = capture?.mark();
      let r;
      try {
        r = await s.page.goto(url, { waitUntil: a.wait || 'domcontentloaded', timeout: 45000 });
      } catch (e) {
        // The URL was a download: the page stays where it was, and the download is the answer.
        const dl = capture && /Download is starting|net::ERR_ABORTED|NS_BINDING_ABORTED/.test(String(e?.message)) ? await capture.since(s.id, mark, { expectMs: 3000 }) : [];
        if (dl.length) return ok({ ...(await pageInfo(s.page)), downloads: dl.map((f) => capture.info(f)) });
        // A redirect hop the tenant's proxy refused over CONNECT (https, wss) fails the navigation in the browser:
        // say that it was the allowlist, naming host and port only.
        const denied = /TUNNEL|PROXY/i.test(String(e?.message)) ? await manager.deniedSince(tenant, t0) : [];
        if (denied.length) throw new Error(`navigation refused by the host allowlist of this token: ${denied[denied.length - 1]}`);
        throw e;
      }
      await s.page.waitForTimeout(1200);
      const w = noteWall(s, await wall(s.page));
      const info = await pageInfo(s.page);
      // The browser follows plain-http redirects itself; one that left the allowlist, or an allowed name that
      // resolves into a private address, got the tenant proxy's 403 instead.
      const refused = r?.status() === 403 && (!manager.isAllowed(tenant, info.url) || (await manager.deniedSince(tenant, t0)).length > 0);
      return ok({ status: r?.status(), ...info, ...(refused ? { refused: 'host allowlist' } : {}), ...(w ? { blocked: w, hint: 'call request_human to let a person solve it' } : {}) });
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

  tool('click', `Click an element (by ref from read, role+name, selector or text).${downloads ? ' A download it starts is reported in downloads (waits up to 5 s for it to finish).' : ''}`, { session: str(40), ...target }, async (a) => run(a.session, async (s) => {
    const mark = capture?.mark();
    await locate(s.page, a).click({ timeout: 15000 });
    await s.page.waitForTimeout(1000);
    const dl = capture ? await capture.since(s.id, mark) : [];
    const w = noteWall(s, await wall(s.page));
    return ok({ ...(await pageInfo(s.page)), ...(w ? { blocked: w } : {}), ...(dl.length ? { downloads: dl.map((f) => capture.info(f)) } : {}) });
  }));

  const secrets = manager.secrets ?? null;
  tool('type', `Fill a field with value. submit=true presses Enter.${secrets && !ephemeral ? ' For a password or other secret, pass secret_id (from secret_create) instead of value: Bosun types it without it passing through you, then deletes it. A secret goes only into an <input type=password>, unless allow_non_password=true (an OTP or e-mail field); that field is masked in read and screenshot from then on.' : ''}`,
    { session: str(40), ...target, value: str(10000).optional(), ...(secrets ? { secret_id: str(40).optional(), allow_non_password: z.boolean().optional() } : {}), submit: z.boolean().optional() },
    async (a) => {
      if ((a.value === undefined) === (a.secret_id === undefined)) throw new Error(secrets ? 'give value or secret_id (not both)' : 'give value');
      if (a.secret_id !== undefined && ephemeral) throw new Error(`type with secret_id: ${NOT_ALLOWED}`);
      return run(a.session, async (s) => {
        const l = locate(s.page, a);
        if (a.secret_id !== undefined) return ok(await typeSecret(s, l, a));
        await l.fill(a.value, { timeout: 15000 });
        if (a.submit) { await l.press('Enter', { timeout: 15000 }); await s.page.waitForTimeout(1500); }
        return ok(await pageInfo(s.page));
      });
    });

  // type with secret_id: the field is checked and marked sensitive first, then the secret is taken (deleted) and
  // typed. All three on one element (a handle): a page that swaps the field for another one after the check gets
  // nothing typed. Nothing returned or thrown carries the secret: the URL and title (a page may echo it there) and
  // any error are masked with the value itself.
  const NO_SECRET_TYPES = new Set(['file', 'checkbox', 'radio', 'submit', 'button', 'image', 'reset', 'hidden', 'range', 'color']);
  async function typeSecret(s, loc, a) {
    secrets.find(tenant, a.secret_id); // fails before the page is touched
    if (driverLogsValues()) throw new Error(DRIVER_LOGS_REFUSED);
    const l = await loc.elementHandle({ timeout: 15000 });
    try {
      return await typeSecretInto(s, l, a);
    } finally {
      await l.dispose().catch(() => {});
    }
  }
  async function typeSecretInto(s, l, a) {
    // The page the secret goes into, also for scrubbing and leaving it: s.page may change under a call that ran out
    // of time (the tab is replaced).
    const page = s.page;
    const kind = await l.evaluate((el) => (el.localName === 'input' ? String(el.type || 'text').toLowerCase() : el.localName === 'textarea' ? 'textarea' : `<${el.localName}>`));
    if (kind.startsWith('<') || NO_SECRET_TYPES.has(kind)) throw new Error(`a secret goes only into a text field (<input> or <textarea>); this element is ${kind.startsWith('<') ? kind : `<input type=${kind}>`}`);
    if (kind !== 'password' && !a.allow_non_password) throw new Error(`this field is ${kind === 'textarea' ? 'a <textarea>' : `<input type=${kind}>`}, not a password field; pass allow_non_password: true to type the secret into it anyway (an OTP or e-mail field). The secret was not used.`);
    await markSensitive(page, l);
    if (!(await l.evaluate((el) => el.isConnected))) throw new Error('the field left the page before anything was typed; the secret was not used');
    const buf = secrets.take(tenant, a.secret_id);
    let value = buf.toString('utf8');
    buf.fill(0);
    // As typed, and as a form that submits with GET puts it into the URL.
    const forms = [...new Set([value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)])];
    const hide = (t) => forms.reduce((out, f) => (value && out.includes(f) ? out.split(f).join('[masked]') : out), String(t));
    try {
      await l.fill(value, { timeout: 15000 });
      // fill types through the page's keyboard: a page that moves the focus meanwhile gets the text elsewhere (another
      // field, a contenteditable). Unless it is in the element that was checked, the call fails and the page is left;
      // otherwise every field that holds it is masked.
      const landed = await l.evaluate((el, v) => el.isConnected && el.value === v, value).catch(() => false);
      if (!landed) {
        // Wherever it went (another field, text split over nodes, a canvas), the page is left: nothing on it can
        // show the secret to a later read or screenshot.
        await scrubValue(page, value).catch(() => {});
        await page.goto('about:blank', { timeout: 15000 });
        throw new Error('the secret did not end up in the field that was checked (the page moved the focus or the field); Bosun left the page (about:blank) so nothing on it can show the secret, check the site before trying again');
      }
      await markValue(page, value);
      if (a.submit) { await l.press('Enter', { timeout: 15000 }); await page.waitForTimeout(1500); }
      const info = await pageInfo(page);
      console.error(`bosun: secret ${a.secret_id} of tenant ${tenant}: typed in session ${s.id}, ${Buffer.byteLength(value)} bytes`);
      return { ...info, url: hide(info.url), title: hide(info.title), secret: 'typed and deleted' };
    } catch (e) {
      throw new Error(`${hide(cleanError(e))} (the secret is deleted; call secret_create for a new one)`);
    } finally {
      value = null;
    }
  }

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

  // Secrets: sent by the agent's shell over a one-time PUT, typed with type secret_id, never in a tool call.
  if (secrets) {
    tool('secret_create', `Get a password or other secret to the browser without it passing through you. Returns secret_id and a one-time PUT URL (valid ${SECRET_URL_TTL_MS / 60000} min, this token only) with a curl line that reads the secret from stdin: pipe it in from where it is stored (e.g. sops -d --extract '["password"]' secrets.yaml | curl …), never echo it or put it in a command line. Up to ${SECRET_MAX_BYTES} bytes of UTF-8; one trailing newline is dropped. Then call type with secret_id: the secret goes into an <input type=password> (other fields only with allow_non_password=true) and is deleted. Kept in memory only, ${SECRET_TTL_MS / 60000} min after it arrived at most, never on disk or in a log.`,
      { label: str(100).optional().describe('what it is, for you (e.g. "github password"); not secret') },
      async (a) => {
        if (!cfg.ws) throw new Error('secret_create needs the WebSocket service (WS_PORT): the secret comes in over an HTTP PUT on that port');
        if (driverLogsValues()) throw new Error(DRIVER_LOGS_REFUSED);
        const x = secrets.create(tenant, { label: a.label ?? null });
        const where = `/secret/${x.id}?t=${x.token}`;
        const url = uploadBase ? `${uploadBase}${where}` : null;
        return ok({
          secret_id: x.id, ...(a.label ? { label: a.label } : {}), put_url: url ?? where,
          ...(url ? {} : { put_url_note: 'PUT to the host:port of your MCP URL, http, with this path' }),
          curl: `curl -sS --fail-with-body -T - ${shq(url ?? `http://<mcp host:port>${where}`)}`,
          valid_min: SECRET_URL_TTL_MS / 60000, max_bytes: SECRET_MAX_BYTES,
          next: 'pipe the secret into the curl line (stdin; the URL works once), then call type with secret_id',
        });
      });
  }

  // Uploads: files of this tenant only, put into a page with upload.
  const uploads = manager.uploads;
  if (uploads) {
    const maxMb = Math.round(cfg.uploadMaxBytes / 1024 / 1024);
    tool('upload_create', `Get a file onto the browser machine for upload. Returns file_id and a one-time PUT URL (valid ${Math.round(cfg.uploadUrlTtlMs / 60000)} min, this token only): send the file with the curl line given (curl -T <file> '<put_url>'), then call upload with the file_id. Up to ${maxMb} MB. For a small file (up to 1 MB) pass content_base64 instead and use the file_id at once. Files are deleted when the session that used them closes, ${Math.round(cfg.uploadTtlMs / 60000)} min after they arrived, or on a service restart.`,
      { filename: str(255).describe('name the page will see, e.g. "report.pdf"'), size_bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe('the exact size; the PUT must match it'),
        content_base64: z.string().max(Math.ceil(BASE64_MAX_BYTES / 3) * 4 + 8).optional().describe('the whole file, base64 (1 MB at most): no PUT needed') },
      async (a) => {
        if (a.content_base64 !== undefined) {
          const b64 = a.content_base64.replace(/\s+/g, '');
          const content = Buffer.from(b64, 'base64');
          // Only what decodes back to the same text: Node turns "a==" into zero bytes without a word.
          const bare = (t) => t.replace(/=+$/, '');
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || (b64.includes('=') && b64.length % 4) || bare(content.toString('base64')) !== bare(b64)) throw new Error('content_base64 is not base64');
          if (content.length > BASE64_MAX_BYTES) throw new Error(`content_base64 is for files up to 1 MB; use the PUT URL (omit content_base64) for larger files`);
          const f = await uploads.create(tenant, { filename: a.filename, content });
          return ok({ file_id: f.id, filename: f.name, size: f.size, next: `call upload with file_id ${f.id}` });
        }
        if (!cfg.ws) throw new Error('the PUT URL needs the WebSocket service (WS_PORT); pass content_base64 for a small file');
        const f = await uploads.create(tenant, { filename: a.filename, sizeBytes: a.size_bytes ?? null });
        const where = `/upload/${f.id}?t=${f.secret}`;
        const url = uploadBase ? `${uploadBase}${where}` : null;
        return ok({
          file_id: f.id, filename: f.name, put_url: url ?? where,
          ...(url ? {} : { put_url_note: 'PUT to the host:port of your MCP URL, http, with this path' }),
          curl: `curl -sS --fail-with-body -T ${shq(f.name)} ${shq(url ?? `http://<mcp host:port>${where}`)}`,
          valid_min: Math.round(cfg.uploadUrlTtlMs / 60000), max_bytes: Math.min(cfg.uploadMaxBytes, a.size_bytes ?? Infinity),
          next: 'PUT the file (one request; the URL works once), then call upload with file_id',
        });
      });
    tool('upload', 'Put uploaded files (file_id, or files: several file_ids, from upload_create) into the page through an element: an <input type=file> (hidden ones too, or its label) is filled directly; a button or link that opens a file chooser is clicked and the chooser answered; anything else gets the files dropped onto it (synthetic drag-and-drop, best effort: pages that check for real user events ignore it). method forces input, chooser or drop. Several files only where the input/chooser allows multiple. Then submit the form as usual (click).',
      { session: str(40), ...target, file_id: str(40).optional(), files: z.array(str(40)).min(1).max(20).optional(), method: z.enum(['auto', 'input', 'chooser', 'drop']).optional() },
      async (a) => {
        if (!hasTarget(a)) throw new Error('give the element: ref, role(+name), selector or text');
        if (!!a.file_id === !!a.files) throw new Error('give file_id or files (not both)');
        const ids = [...new Set(a.files ?? [a.file_id])];
        return run(a.session, async (s) => {
          const files = uploads.use(tenant, ids, s.id);
          const r = await putFiles(s.page, locate(s.page, a), files.map((f) => f.file), a.method || 'auto', { mainWorld: s.engine === 'camoufox' });
          await s.page.waitForTimeout(500);
          return ok({ ...r, files: files.map((f) => ({ file_id: f.id, filename: f.name, size: f.size })), ...(await pageInfo(s.page)) });
        });
      });
  }

  // Downloads: this tenant's only, kept until fetched, for DOWNLOAD_TTL_SEC, or until a restart.
  if (downloads) {
    const ttlMin = Math.round(cfg.downloadTtlMs / 60000);
    tool('download_wait', `Wait for a download in this session to finish (up to timeoutMs, default 30000) and report it: { download_id, state: ready, filename, size, mime, source_host, page_host } or state refused/failed with the reason. Each finished download is reported once (click already reports what finishes within 5 s of it). Kept: downloads from ${dlHosts}, or started by a page there (blob: and data: downloads count by their page); anything else is cancelled. Up to ${Math.round(cfg.downloadMaxBytes / 1024 / 1024)} MB per file; kept ${ttlMin} min or until fetched.`,
      { session: str(40), timeoutMs: z.number().int().min(0).max(120000).optional() }, async (a, extra) => {
        const s = manager.get(owner, a.session);
        if (s.handoff) throw new Error(HANDOFF_ACTIVE);
        const f = await downloads.wait(tenant, s.id, a.timeoutMs ?? 30000, extra?.signal);
        if (!f) return ok({ state: 'none', note: 'no download finished in this session in that time; start one (click) and call download_wait again' });
        return ok(downloads.info(f));
      });
    tool('downloads', 'List the downloads of this token (or of one session): running, ready to fetch, refused or failed, with download_id, filename, size and reason.', { session: str(40).optional() },
      async (a) => ok(downloads.list(tenant, a.session ?? null).map((f) => downloads.info(f))));
    tool('download_get', `Fetch a finished download: returns a one-time GET URL (valid ${Math.round(cfg.downloadUrlTtlMs / 60000)} min, this token only) and a ready curl -o line; the file is deleted once it has been fetched in full. inline=true returns the content in the result instead, for UTF-8 text up to ${INLINE_MAX_BYTES / 1024} KB (then the file is deleted too).`,
      { download_id: str(40), inline: z.boolean().optional() }, async (a) => {
        const f = downloads.get(tenant, a.download_id);
        const meta = { download_id: f.id, filename: f.name, size: f.size, mime: f.mime, source_host: f.source };
        if (a.inline) {
          const text = await downloads.inline(f);
          if (text !== null) return ok({ ...meta, inline: true, content: text });
        }
        if (!cfg.ws) return ok({ ...meta, path: f.file, note: `no MCP port (stdio): read the file at path; it is deleted ${ttlMin} min after it finished or on a restart` });
        const where = `/download/${f.id}?t=${downloads.issue(f)}`;
        const url = uploadBase ? `${uploadBase}${where}` : null;
        return ok({
          ...meta, ...(a.inline ? { inline: false, inline_note: `not inline: only UTF-8 text up to ${INLINE_MAX_BYTES / 1024} KB` } : {}),
          get_url: url ?? where, ...(url ? {} : { get_url_note: 'GET from the host:port of your MCP URL, http, with this path' }),
          curl: `curl -sS --fail-with-body -o ${shq(f.name)} ${shq(url ?? `http://<mcp host:port>${where}`)}`,
          valid_min: Math.round(cfg.downloadUrlTtlMs / 60000), next: 'GET it once (curl); the file is deleted after a complete fetch',
        });
      });
  }

  const waitResult = async (id, status, h) => {
    if (status === 'still_waiting') return ok({ status, expires_in_sec: Math.max(0, Math.round((h.expiresAt - Date.now()) / 1000)), next: 'call handoff_wait again' });
    const info = await run(id, async (s) => pageInfo(s.page)).catch(() => ({}));
    return ok({ status, ...info });
  };

  tool('request_human', `Ask a human to take over this tab (CAPTCHA, cookie wall, login, 2FA). Returns a live-view link at once (one viewer at a time, valid until the handoff ends) (wait=false, default) — send it to your human, then call handoff_wait. With wait=true it also waits up to ${POLL_SEC}s and may return still_waiting. While a handoff is active, every page tool (read, screenshot, click, type, navigate, …) is refused and no URL/title is reported.`,
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

  // Keepalive: per tenant (like profiles, shared by the tenant's connections).
  const keepalive = manager.keepalive;
  if (keepalive) {
    tool('keepalive_set', 'Keep a persistent profile logged in without a model: every every_hours or every_minutes (± jitter_min; ×4 during quiet_hours) the service opens the profile, loads url, moves the mouse and scrolls for 20–60 s (no clicks, typing or navigation), then checks logged_in_check. Logged out or a bot check -> a bosun:needs-human event; no retries before the next visit. Optional watch: read one value on the page (e.g. a "43 neue Nachrichten" counter) and send a bosun:watch-changed event when it changes (count up, or text differs); the first visit only records it. Only helps sites with sliding sessions.',
      { profile: z.string().regex(TENANT_RE), url: z.string().max(4096).url().describe('http(s) only'),
        every_hours: z.number().int().min(1).max(720).optional().describe('interval (default 12)'),
        every_minutes: z.number().int().min(MIN_PERIOD_MIN).max(43200).optional().describe(`interval in minutes, at least ${MIN_PERIOD_MIN} (instead of every_hours)`),
        jitter_min: z.number().int().min(0).max(720).optional().describe('random shift of each visit, ± minutes (default 30, at most a quarter of a shorter interval)'),
        quiet_hours: z.string().max(20).optional().describe(`local hours (time zone ${cfg.tz || 'Europe/Vienna'}) when the interval is ×4, e.g. "22-08"`),
        logged_in_check: z.object({ text: str(1000).optional(), selector: str(2000).optional(), url_not_contains: str(1000).optional() }).describe('what proves it is still logged in; every given condition must hold'),
        watch: z.object({
          selector: str(2000).optional().describe("element whose textContent is read (default: the page's visible text)"),
          text_regex: str(500).optional().describe('picks the value: first capture group, else the whole match, e.g. "(\\d+) neue Nachrichten"'),
          kind: z.enum(['count', 'text']).describe('count: a number, event when it goes up (no match = 0); text: at most 200 chars, event when it differs'),
          label: str(100).describe('name for the value in events, e.g. "willhaben messages"'),
        }).optional().describe('a value to read after the logged-in check; only the value is stored'),
        enabled: z.boolean().optional() },
      async (a) => ok(keepalive.set(tenant, {
        profile: a.profile, url: a.url, everyHours: a.every_hours, everyMinutes: a.every_minutes, jitterMin: a.jitter_min, quietHours: a.quiet_hours || null,
        check: a.logged_in_check, watch: a.watch ? { selector: a.watch.selector, textRegex: a.watch.text_regex, kind: a.watch.kind, label: a.watch.label } : null, enabled: a.enabled ?? true,
      })));
    tool('keepalive_list', 'Keepalive schedules of your profiles with the next run, the watched value and the last results (ok, logged_out, bot_check, error).', {}, async () => ok(keepalive.list(tenant)));
    tool('keepalive_remove', 'Stop keeping a profile alive.', { profile: z.string().regex(TENANT_RE) }, async (a) => ok(keepalive.remove(tenant, a.profile)));
  }

  // Meetings (PoC): per tenant, like keepalive. A meeting runs in a session of its own and outlives this connection.
  const meetings = manager.meetings;
  if (meetings) {
    const mid = { meeting_id: z.string().max(20) };
    tool('meeting_join', 'Join a Google Meet or Zoom meeting as a notetaker: a Meet as an unauthenticated guest or with profile (a Bosun profile signed in to Google: the account name is used, name is ignored); a Zoom meeting (zoom.us/j/<id>?pwd=…, in Zoom\'s web client) with profile signed in to Zoom (Zoom refuses most guests). Mic and camera off; asks to be let in and waits (up to max_wait_admit_min) for admission. Once in, it posts announce_text in the chat (default: an English/German notice that audio is recorded and how to object), THEN records the meeting audio to a file. announce: "chat" (default) posts to everyone; where the host allows chat with the host only, to the host instead; if neither works it records anyway and says so (meeting_status announce.sent_to "failed", a bosun:meeting-announce event). "host" posts to the host only. "none" posts nothing and records without any announcement: use it only when the meeting owner told you so; you are then responsible for everyone knowing they are recorded. Every chat message becomes a bosun:meeting-chat event; a clear "please don\'t record" (EN/DE/UK/RU/SK) stops and deletes the recording at once (bosun:meeting-optout) and leaves (leave_on_optout=false: stay, unrecorded). Leaves by itself when the meeting ends, the bot is removed, or everyone else has left (after alone_leave_sec, default 30; 2 min while nobody else has joined yet); then bosun:meeting-ended carries the recording. Returns once the join request is out: poll meeting_status or wait for events. Transcription is up to you, after the meeting. dry_run=true only checks the lobby (nothing is joined).',
      { url: z.string().max(2048).url().describe('https://meet.google.com/abc-defg-hij or https://zoom.us/j/<id>?pwd=… (any *.zoom.us, /w/ and /wc/ links too)'), name: str(60).optional().describe('display name for a guest (default "Glassy (notetaker)"); a signed-in profile joins under the account name'),
        announce_text: str(1000).optional(),
        announce: z.enum(ANNOUNCE_MODES).optional().describe('who is told about the recording in the chat before it starts: "chat" (default: everyone, else the host), "host" (the host only), "none" (nobody; only when the meeting owner told you so). Opt-outs in the chat are heard in every mode'),
        max_wait_admit_min: z.number().int().min(1).max(60).optional(),
        profile: z.string().regex(TENANT_RE).optional().describe('join with an existing Bosun profile signed in to Google (Meet) or Zoom (gets refused far less often than an anonymous guest)'),
        engine: z.enum(cfg.engines).optional().describe('chromium (default) or patchright; camoufox is not supported for meetings'),
        leave_on_optout: z.boolean().optional(),
        alone_leave_sec: z.number().int().min(5).max(3600).optional().describe('leave this long after everyone else left (default 30); before anyone else has joined, Bosun waits 2 min'),
        dry_run: z.boolean().optional().describe('only load the meeting page (same profile, engine and devices) and report what Bosun sees: lobby kind, the join button it would click, microphone/camera, a shown captcha; joins nothing') },
      async (a) => ok(a.dry_run ? await meetings.inspect(tenant, { url: a.url, profile: a.profile, engine: a.engine }) : await meetings.join(tenant, {
        url: a.url, name: a.name || 'Glassy (notetaker)', announceText: a.announce_text, announce: a.announce ?? 'chat', maxWaitAdmitMin: a.max_wait_admit_min ?? 10,
        profile: a.profile, engine: a.engine, leaveOnOptOut: a.leave_on_optout ?? true, aloneLeaveSec: a.alone_leave_sec ?? null,
      })));
    tool('meeting_status', 'State of a meeting (joining, waiting, admitted, recording, ended), platform (meet, zoom), joined_as (account, guest), participants if visible, recorded seconds, announce {mode, sent_to: everyone|host|none|failed, reason and failures when it fell short}; without meeting_id all your meetings.',
      { meeting_id: z.string().max(20).optional() }, async (a) => ok(meetings.status(tenant, a.meeting_id)));
    tool('meeting_chat_read', 'Chat messages of a meeting seen so far (others\' messages; since = last seq you have).', { ...mid, since: z.number().int().min(0).optional() },
      async (a) => ok(meetings.chatRead(tenant, a.meeting_id, a.since ?? 0)));
    tool('meeting_chat_send', 'Post a message in the meeting chat (to whom the announcement went: everyone, or the host).', { ...mid, text: z.string().min(1).max(1000) },
      async (a) => ok(await meetings.chatSend(tenant, a.meeting_id, a.text)));
    tool('meeting_stop_recording', 'Stop recording (delete=true, default: also delete the file). The meeting goes on unrecorded.', { ...mid, delete: z.boolean().optional() },
      async (a) => ok(await meetings.stopRecordingTool(tenant, a.meeting_id, a.delete ?? true)));
    tool('meeting_leave', 'Leave the meeting; the recording is finished and kept (bosun:meeting-ended).', mid, async (a) => ok(await meetings.leave(tenant, a.meeting_id)));
    tool('meeting_recording_delete', `Delete a meeting's recording (recordings are deleted automatically after ${cfg.recordingRetentionDays ?? 30} days).`, mid,
      async (a) => ok(await meetings.deleteRecording(tenant, a.meeting_id)));
  }

  // Macros: step sequences saved by this tenant (a read-only tenant: by the tenant BROWSER_MACRO_SOURCE names), each
  // step run by the handler of its tool above, so this token's policy, allowlists and limits apply to it as they do
  // to the tool.
  const macros = manager.macros;
  if (macros) {
    // The page side of a run (macros.mjs runMacro) in one session of this connection.
    const macroOps = (session, extra) => {
      const progressToken = extra?._meta?.progressToken;
      const page = () => {
        const s = manager.get(owner, session);
        if (s.handoff) throw new Error(HANDOFF_ACTIVE);
        return s.page;
      };
      const step = async (name, args, limitMs, signal) => {
        const h = handlers.get(name);
        const r = h.schema.safeParse({ ...args, session });
        if (!r.success) throw new Error(`invalid step: ${r.error.issues.map((i) => `${i.path.join('.') || name}: ${i.message}`).join('; ')}`);
        const go = () => h.fn(r.data, { signal });
        return limitMs ? withDeadline(name, limitMs, go) : go();
      };
      return {
        allowed: (name) => (name === 'assert' || handlers.has(name) ? null : `${name} is not available for this token`),
        limitOf: (name) => cfg.toolTimeouts?.get(name === 'assert' ? 'wait_for' : name) ?? null,
        step,
        url: () => page().url(),
        // The first main-frame navigation off the site while a step runs (a redirect that comes back is still seen).
        watch(isOff) {
          const p = page();
          let seen = null;
          const on = (f) => { if (!seen && f === p.mainFrame() && isOff(f.url())) seen = f.url(); };
          p.on('framenavigated', on);
          return { seen: () => seen, stop: () => p.off('framenavigated', on) };
        },
        assert: (c, limitMs) => withDeadline('assert', limitMs, () => run(session, async (s) => {
          const t = c.timeoutMs ?? 5000;
          const failed = (what) => (e) => { throw e?.name === 'TimeoutError' ? new Error(`assert failed: ${what} within ${t} ms`) : e; };
          if (c.url_contains !== undefined) {
            for (const end = Date.now() + t; !s.page.url().includes(c.url_contains);) {
              if (Date.now() >= end) throw new Error(`assert failed: the URL does not contain "${c.url_contains}" within ${t} ms`);
              await sleep(200);
            }
          }
          if (c.selector !== undefined) await s.page.locator(c.selector).first().waitFor({ state: 'visible', timeout: t }).catch(failed(`no visible element matches selector ${c.selector}`));
          if (c.text !== undefined) await s.page.getByText(c.text).first().waitFor({ state: 'visible', timeout: t }).catch(failed(`text "${c.text}" is not visible`));
          return true;
        })),
        // The element a click or type step targets: what it says (visible text, value, aria-label, title) and its
        // kind (an <input>'s type, else its tag).
        element: (t, limitMs) => withDeadline('element', limitMs, () => run(session, (s) => locate(s.page, t).evaluate((el) => ({
          label: [el.innerText, el.value, el.getAttribute('aria-label'), el.title].filter((x) => typeof x === 'string' && x).join(' ').slice(0, 500),
          kind: el.localName === 'input' ? String(el.type || 'text').toLowerCase() : el.localName,
        }), null, { timeout: 5000 }))),
        // Where the run stopped: URL, title and the start of the a11y snapshot (masked as read masks it), and a
        // screenshot (masked as screenshot masks it).
        async failure() {
          const out = {};
          try {
            const r = await step('read', { mode: 'a11y', maxChars: 4000 }, 20_000).catch(() => step('read', { mode: 'text', maxChars: 4000 }, 20_000));
            const text = r.content[0].text;
            const [head, body] = [text.slice(0, text.indexOf('\n\n')), text.slice(text.indexOf('\n\n') + 2)];
            for (const line of head.split('\n')) { const m = /^(url|title): (.*)$/.exec(line); if (m) out[m[1]] = m[2]; }
            out.page = body;
          } catch (e) { out.page_error = cleanError(e); }
          try { out.screenshot = (await step('screenshot', {}, 20_000)).content.find((c) => c.type === 'image')?.data; } catch {}
          return out;
        },
        progress: progressToken === undefined ? null
          : (done, total, message) => extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: done, total, message } }).catch(() => {}),
      };
    };

    const stepsHelp = `Steps (each {"tool": …, "optional"?: true, "note"?: …}): navigate {url, wait?}; click {role+name | selector | text} (no ref); type {target, value | secret_id: "{{param}}", submit?, allow_non_password?}; select {target, value}; press {key}; wait_for {text | selector, timeoutMs?}; upload {target, file_id: "{{param}}" | files, method?}; download_wait {timeoutMs?}; read {mode?, selector?, maxChars?, as?}; screenshot {target?, fullPage?}; assert {text?, selector?, url_contains?, timeoutMs? (default 5000)}. Any string may use {{param}}; a step that uses a param not given is skipped.`;
    tool('macro_save', `Save a multi-step flow on a site as a macro to rerun with macro_run (saving an existing name makes a new version; the last 20 are kept). site: the hosts it may run on (e.g. ["web.plaud.ai", "*.plaud.ai"]); a page outside them stops the run. params: {name: {type: string|number|file_id|secret_id, required?, default?, description?}}; a secret or file goes in only as a {{param}} of type secret_id / file_id, never stored. ${stepsHelp} A step whose text says pay, buy, purchase, submit/place order, checkout or delete account is refused unless confirm_risky: true.`,
      { name: str(64).describe('lowercase letters, digits, . _ -'), description: str(2000).optional(), site: z.array(str(300)).min(1).max(MAX_SITES),
        params: z.record(z.string().max(40), z.record(z.string(), z.unknown())).optional(), steps: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_STEPS),
        confirm_risky: z.boolean().optional().describe('allow steps that may pay, buy, order, check out or delete an account'), created_by: str(100).optional().describe('who saved it (default: the tenant)') },
      async (a) => {
        const v = macros.save(tenant, a, { createdBy: a.created_by || tenant });
        return ok({ saved: v.name, version: v.version, steps: v.steps.length, site: v.site, params: v.params, confirm_risky: v.confirm_risky, ...(v.risky_steps.length ? { risky_steps: v.risky_steps } : {}), next: `macro_run { name: "${v.name}", session, args }` });
      });
    tool('macro_list', 'List your macros (latest version of each): name, version, description, site, params (type, ? = optional), number of steps, confirm_risky and the risky steps.', {},
      async () => ok(macros.list(tenant)));
    tool('macro_get', 'A macro in full (steps and all), the latest version or version.', { name: str(64), version: z.number().int().min(1).optional() },
      async (a) => ok(macros.get(tenant, a.name, a.version)));
    tool('macro_delete', 'Delete a macro with all its versions.', { name: str(64) }, async (a) => ok(macros.delete(tenant, a.name)));
    tool('macro_run', `Run a macro in session, step by step; each step works like the tool of that name and has its deadline, the whole run at most timeout_sec (default ${RUN_DEFAULT_SEC}, up to ${RUN_MAX_SEC}; raise your MCP client's request timeout above that, or send a progressToken: Bosun reports progress after every step). Returns per-step status, reads (the read steps' text), downloads (download_id to fetch with download_get) and screenshots (images). On failure: the step, its error, the URL, the start of the page's a11y snapshot and a screenshot, so you can fix the macro and save a new version. A page outside the macro's site stops the run. dry_run: check args and show the steps as they would run, without touching the page.`,
      { name: str(64), session: str(40).optional().describe('required unless dry_run'), args: z.record(z.string().max(40), z.union([z.string().max(10000), z.number()])).optional(),
        version: z.number().int().min(1).optional(), dry_run: z.boolean().optional(), timeout_sec: z.number().int().min(10).max(RUN_MAX_SEC).optional() },
      async (a, extra) => {
        const m = macros.get(tenant, a.name, a.version);
        let s = null;
        if (!a.dry_run) {
          if (!a.session) throw new Error('give session (or dry_run: true)');
          s = manager.get(owner, a.session); // an unknown session fails before anything runs
          // Two runs in one tab would take turns step by step, each on the page the other left.
          if (s.macroRun) throw new Error(`macro ${s.macroRun} is running in session ${s.id}; wait for it to finish`);
          s.macroRun = m.name;
        }
        let out;
        try {
          out = await runMacro(m, { args: a.args ?? {}, dryRun: !!a.dry_run, maxMs: (a.timeout_sec ?? RUN_DEFAULT_SEC) * 1000, signal: extra?.signal, ops: macroOps(a.session, extra) });
        } finally { if (s) s.macroRun = null; }
        const { result, images } = out;
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 1) }, ...images.map((im) => ({ type: 'image', data: im.data, mimeType: 'image/jpeg' }))],
          ...(result.ok ? {} : { isError: true }),
        };
      });
  }

  tool('sessions', 'List your open sessions.', {}, async () => ok(manager.list(owner).map((s) => (
    s.handoff ? { id: s.id, profile: s.profile || 'ephemeral', engine: s.engine, handoff: 'active' } : { id: s.id, profile: s.profile || 'ephemeral', engine: s.engine, url: s.page.url() }
  ))));

  if (ephemeral) {
    // McpServer has no public filter for tools/list; wrap its handler (the SDK version is pinned, and the tests check
    // the list). Without the handler, refuse to build the server rather than list every tool.
    const handlers = server.server._requestHandlers;
    const list = handlers?.get('tools/list');
    if (!list) throw new Error('cannot restrict tools/list for policy ephemeral');
    handlers.set('tools/list', async (req, extra) => {
      const r = await list(req, extra);
      return { ...r, tools: r.tools.filter((t) => EPHEMERAL_TOOLS.has(t.name)) };
    });
  }
  return server;
}
