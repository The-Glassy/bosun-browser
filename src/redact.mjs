// Sensitive-field handling: find credential/OTP inputs by DOM type and metadata (not just the accessible label),
// mask their values in snapshots, mask them in screenshots, and clear them after an unsuccessful handoff.

// Fields that are sensitive by markup alone. Also used as the screenshot mask together with MARK_ATTR.
export const SENSITIVE_CSS = [
  'input[type=password]',
  'input[autocomplete~="one-time-code"]', 'input[autocomplete~="current-password"]', 'input[autocomplete~="new-password"]',
  'input[autocomplete~="cc-number"]', 'input[autocomplete~="cc-csc"]',
  ...['passw', 'pwd', 'passcode', 'kennw', 'otp', 'totp', 'cvc', 'cvv', 'pincode'].flatMap((k) => [`input[name*="${k}" i]`, `input[id*="${k}" i]`]),
].join(',');
const MARK_ATTR = 'data-bosun-sensitive';

// Label/name/placeholder words that make an input sensitive (checked in the page, on normalized hints).
const HINT_WORDS = String.raw`passw|kennw|passcode|passphrase|mot de passe|contrase|senha|heslo|hasło|parol|wachtwoord|lösenord|salasana|\bpin\b|\botp\b|\btotp\b|one ?time|\b2fa\b|\bmfa\b|\btan\b|\bcvc\b|\bcvv\b|\bcsc\b|security code|verification code|sicherheitscode|bestätigungscode|secret`;

// Runs in every frame. op: 'values' -> sensitive values; 'mark'/'unmark' -> toggle MARK_ATTR; 'clear' -> empty them.
function inPage({ op, css, hint, attr }) {
  const KEY = Symbol.for('bosun.sensitive');
  const seen = window[KEY] || (window[KEY] = new WeakSet()); // inputs that were ever type=password (show/hide toggles)
  const re = new RegExp(hint, 'i');
  const text = (el) => (el ? el.textContent || '' : '');
  const out = [];
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    for (const el of roots[i].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (op === 'unmark') { if (el.hasAttribute(attr)) el.removeAttribute(attr); continue; }
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) continue;
      if (el.type === 'password') seen.add(el);
      let sensitive = seen.has(el) || el.matches(css);
      if (!sensitive) {
        const labels = [...(el.labels || [])].map(text);
        const root = el.getRootNode(); // aria-labelledby resolves within the input's own (shadow) tree
        const byId = (id) => (root.getElementById ? root.getElementById(id) : null) || document.getElementById(id);
        const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => text(byId(id)));
        const hints = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.placeholder, ...labels, ...by]
          .join(' ').replace(/[_\-.[\]]+/g, ' ');
        sensitive = re.test(hints);
      }
      if (!sensitive) continue;
      if (op === 'values' && el.value) out.push(el.value);
      else if (op === 'mark') el.setAttribute(attr, '');
      else if (op === 'clear' && el.value) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
  return out;
}

// Runs fn in every frame. A frame that detached meanwhile is skipped; any other failure throws, so callers fail
// closed instead of returning unmasked output.
export async function eachFrame(page, fn, arg) {
  const res = await Promise.all(page.frames().map((f) => f.evaluate(fn, arg).catch((e) => {
    if (f.isDetached()) return [];
    throw new Error(`could not inspect a frame of the page for sensitive fields (${String(e?.message || e).split('\n')[0]})`);
  })));
  return res.flat();
}
const scan = (page, op) => eachFrame(page, inPage, { op, css: SENSITIVE_CSS, hint: HINT_WORDS, attr: MARK_ATTR });

export const sensitiveValues = (page) => scan(page, 'values');
export const clearSensitive = (page) => scan(page, 'clear');

// Installed as a context init script, so it runs in every document and frame before page scripts: remembers every
// input that is or ever becomes type=password (incl. inside open shadow roots), so a show-password toggle that
// happened before Bosun's first scan still counts as sensitive.
export function passwordTracker() {
  const KEY = Symbol.for('bosun.sensitive');
  const seen = window[KEY] || (window[KEY] = new WeakSet());
  const note = (n) => {
    if (!n || n.nodeType !== 1) return;
    if (n.localName === 'input' && n.type === 'password') seen.add(n);
    if (n.querySelectorAll) for (const el of n.querySelectorAll('input[type=password]')) seen.add(el);
  };
  const onMut = (muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') { if (m.oldValue === 'password' || m.target.type === 'password') seen.add(m.target); }
      else for (const n of m.addedNodes) note(n);
    }
  };
  const watch = (root) => new MutationObserver(onMut).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (...a) { const r = orig.apply(this, a); try { watch(r); } catch {} return r; };
  watch(document);
  document.addEventListener('DOMContentLoaded', () => note(document.documentElement));
}

// Element count across all frames and open shadow roots (what the a11y snapshot walks), stopping at limit+1.
export async function countNodes(page, limit) {
  const counts = await eachFrame(page, (lim) => {
    let n = 0;
    const roots = [document];
    for (let i = 0; i < roots.length && n <= lim; i++) {
      for (const el of roots[i].querySelectorAll('*')) { n++; if (el.shadowRoot) roots.push(el.shadowRoot); if (n > lim) break; }
    }
    return [n];
  }, limit);
  return counts.reduce((a, b) => a + b, 0);
}

// Screenshot with sensitive inputs masked in every frame; the marker attribute is removed afterwards.
export async function maskedScreenshot(page, take) {
  try {
    await scan(page, 'mark');
    return await take(page.frames().map((f) => f.locator(`${SENSITIVE_CSS},[${MARK_ATTR}]`)));
  } finally {
    await scan(page, 'unmark').catch(() => {});
  }
}

const LABEL_RE = new RegExp(String.raw`^(\s*- (?:textbox|searchbox|spinbutton|combobox) "[^"\n]*(?:${HINT_WORDS})[^"\n]*"[^\n]*?): .*$`, 'gim');
const FIELD_LINE_RE = /^(\s*- (?:textbox|searchbox|spinbutton|combobox)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*): (.*)$/;

const unquote = (v) => { if (!v.startsWith('"')) return v; try { return JSON.parse(v); } catch { return v; } };

// Mask an aria snapshot / text dump: fields with a sensitive label, fields whose value is a sensitive value, and any
// other occurrence of a sensitive value of 3+ characters.
export function maskText(text, values) {
  const vals = new Set(values.filter(Boolean));
  let out = text.replace(LABEL_RE, '$1: [masked]');
  out = out.split('\n').map((line) => {
    const m = FIELD_LINE_RE.exec(line);
    return m && vals.has(unquote(m[2])) ? `${m[1]}: [masked]` : line;
  }).join('\n');
  for (const v of [...vals].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join('[masked]');
    const esc = JSON.stringify(v).slice(1, -1);
    if (esc !== v) out = out.split(esc).join('[masked]');
  }
  return out;
}
