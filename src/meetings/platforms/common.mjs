// Helpers shared by the meeting platforms: text matching, the visible page text outside what participants control,
// buttons, overlays, and the "microphone/camera verifiably off" check.

export const norm = (s) => String(s || '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ');
export const any = (...parts) => new RegExp(parts.join('|'), 'i');

// Visible page text outside `skip` (chat messages, participant names, form fields: what participants control), so a
// name or a chat line reading "The call has ended" neither ends the meeting nor hides the real banner. roots: only
// text inside elements matching it (e.g. dialogs).
export function pageText(page, skip, roots = null) {
  return page.evaluate(({ skip, roots }) => {
    const out = [];
    const vis = new Map();
    for (const root of roots ? document.querySelectorAll(roots) : [document.body || document.documentElement]) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n && out.length < 2000; n = walk.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.nodeValue.trim() || el.closest(skip) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
        if (!vis.has(el)) vis.set(el, el.checkVisibility ? el.checkVisibility() : !!el.offsetParent);
        if (vis.get(el)) out.push(n.nodeValue.trim());
      }
    }
    return out.join('\n').slice(0, 20000);
  }, { skip, roots }).then(norm);
}

// Where a site puts its own status messages over a running call (meeting ended, removed): dialogs only. Captions,
// the meeting title and toasts are outside, so what participants say or name a meeting can't end it.
export const DIALOGS = '[role="dialog"], [role="alertdialog"]';
// With the call's toolbar hidden (it fades out) the end page may have replaced the call: headings count too.
export const HEADINGS = 'h1, h2, h3, [role="heading"]';

export const visible = (l) => l.first().isVisible().catch(() => false);
export const button = (page, name) => page.getByRole('button', { name });
// Disabled by attribute, ARIA, or (Zoom's web client) only by a "disabled" class.
export const disabled = (l) => l.first().evaluate((b) => b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled')).catch(() => false);

// The first visible match of a locator, or null.
export async function firstVisible(l, max = 5) {
  for (let i = 0, c = Math.min(await l.count().catch(() => 0), max); i < c; i++) {
    if (await l.nth(i).isVisible().catch(() => false)) return l.nth(i);
  }
  return null;
}

// A challenge the page actually shows: a reCAPTCHA / hCaptcha / Turnstile frame (in any frame of the page) that is
// rendered, not hidden by visibility or opacity, on screen and at least 60x60 px, and is not reCAPTCHA's invisible
// mode (size=invisible). Sites that are merely "protected by reCAPTCHA" (Meet, Zoom's web client) carry an invisible
// widget, its hidden challenge frame parked off screen, and that notice: none of it is a challenge.
export const CHALLENGE_SRC = /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|captcha-delivery|geo\.captcha/;
// A challenge page served as the page itself counts too, by its endpoint only: a DataDome captcha
// (*.captcha-delivery.com), Cloudflare's challenge host or its /cdn-cgi/challenge-platform/ pages.
const challengePage = (raw) => {
  try {
    const u = new URL(raw);
    return /(?:^|\.)captcha-delivery\.com$/.test(u.hostname) || u.hostname === 'challenges.cloudflare.com' || u.pathname.startsWith('/cdn-cgi/challenge-platform/');
  } catch { return false; }
};
// A frame counts if it is shown where a person would see it: its rectangle (at least 60x60), carried up through every
// frame above it and cut to each one's viewport, still has 60x60 px left in the page's own viewport, and every frame
// element on the way is rendered (not hidden by visibility or opacity).
export async function challengeShown(page) {
  const main = page.mainFrame();
  if (challengePage(main.url())) return true;
  for (const f of page.frames()) {
    if (f === main) continue;
    const src = f.url();
    if (!CHALLENGE_SRC.test(src) || /[?&]size=invisible\b/.test(src)) continue;
    let rect = null; // the challenge, in the coordinates of the frame being looked at
    let shown = true;
    for (let cur = f; shown && cur !== main; cur = cur.parentFrame()) {
      const el = cur && await cur.frameElement().catch(() => null);
      if (!el) { shown = false; break; }
      const g = await el.evaluate((e) => {
        const r = e.getBoundingClientRect();
        const visible = e.checkVisibility ? e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : !!e.offsetParent;
        return { visible, x: r.left + e.clientLeft, y: r.top + e.clientTop, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
      }).catch(() => null);
      await el.dispose().catch(() => {});
      if (!g?.visible) { shown = false; break; }
      // Into the parent's coordinates: the frame element's own box, or the challenge inside it, moved by the frame's
      // position; then cut to the parent's viewport.
      const r = rect ? { x: rect.x + g.x, y: rect.y + g.y, w: rect.w, h: rect.h } : { x: g.x, y: g.y, w: g.w, h: g.h };
      if (rect) { // also cut to the frame element itself (what lies outside its box is not shown)
        const x0 = Math.max(r.x, g.x), y0 = Math.max(r.y, g.y), x1 = Math.min(r.x + r.w, g.x + g.w), y1 = Math.min(r.y + r.h, g.y + g.h);
        Object.assign(r, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
      const x0 = Math.max(r.x, 0), y0 = Math.max(r.y, 0), x1 = Math.min(r.x + r.w, g.vw), y1 = Math.min(r.y + r.h, g.vh);
      rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (rect.w < 60 || rect.h < 60) shown = false;
    }
    if (shown) return true;
  }
  return false;
}

// Closes what the site lays over its page (feature tips, "continue without devices", cookie banners): only buttons
// with one of `labels` inside a dialog (or matched by `extra` selectors) are clicked. Returns how many were clicked.
export async function dismissOverlays(page, labels, extra = []) {
  let n = 0;
  for (const scope of ['[role="dialog"]', '[role="alertdialog"]', ...extra]) {
    const b = await firstVisible(page.locator(scope).getByRole('button', { name: labels }));
    if (b && !(await disabled(b))) { await b.click({ timeout: 2000 }).then(() => { n++; }, () => {}); }
  }
  return n;
}

// Clicks a button, closing overlays that keep it from getting the click (a tip, a dialog) and waiting while it is
// disabled (the page still getting ready). Throws with what was in the way if it never takes the click.
export async function clickThrough(page, l, { what, overlays, timeoutMs = 25_000 }) {
  const until = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    if (!(await disabled(l))) {
      try { await l.click({ timeout: 3000 }); return; } catch (e) { last = e; }
      if (!(overlays && await overlays(page))) await page.keyboard.press('Escape').catch(() => {});
    } else await page.waitForTimeout(400);
    if (Date.now() > until) {
      const why = last ? String(last.message || last).split('\n').find((s) => /intercepts|not enabled|not stable|not visible/.test(s)) : 'it stayed disabled';
      throw new Error(`could not click ${what}${why ? ` (${why.trim().slice(0, 160)})` : ''}`);
    }
  }
}

// Microphone or camera verified off: its control shows "turn on" (enabled or not), or the page says the device
// wasn't found while no control shows it on. A control showing it on is clicked (if enabled) and checked again; a
// disabled one is waited out, never taken as "off". Throws if "off" can't be established: joining with a live
// microphone or camera is not risked. state(page) may end the wait (denied, refused, ended...): returned as is.
export async function ensureOff(page, { what, onLabel, offLabel, missing, text, state, stop = [], site = 'the site', timeoutMs = 10_000 }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await visible(button(page, offLabel))) return 'off';
    const st = state ? await state(page) : null;
    if (stop.includes(st)) return st;
    const on = button(page, onLabel);
    const live = await visible(on);
    if (!live && missing && missing.test(await text(page).catch(() => ''))) return 'no device';
    if (live && !(await disabled(on))) await on.first().click({ timeout: 3000 }).catch(() => {});
    if (Date.now() > until) throw new Error(`could not make sure the ${what} is off before joining (${site} changed?); not joining`);
    await page.waitForTimeout(300);
  }
}
