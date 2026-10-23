// Sensitive-field handling: find credential/OTP inputs by DOM type and metadata (not just the accessible label),
// mask their values in snapshots, mask them in screenshots, and clear them after an unsuccessful handoff.
import crypto from 'crypto';

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
      if (op === 'note') continue;
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
// Remember the inputs that are type=password right now (in Bosun's evaluation world), so they stay sensitive if
// they are later switched to type=text. Polled while a human has the tab.
export const notePasswords = (page) => scan(page, 'note');

// Remembers every input that is or ever becomes type=password (incl. open and declarative shadow roots), so a
// show-password toggle doesn't make a typed password readable. Event-driven (MutationObserver), idempotent, no
// prototype patching. Must run in the same JavaScript world as Bosun's scans: installed as an init script where init
// scripts share that world (Playwright Chromium: the page's world; Camoufox: an isolated world), and by evaluate on
// every frame navigation where they don't (patchright: init scripts go to the page's world, scans to an isolated one).
export function passwordTracker() {
  const KEY = Symbol.for('bosun.sensitive');
  const seen = window[KEY] || (window[KEY] = new WeakSet());
  if (seen.tracking) return;
  seen.tracking = true;
  const observed = new WeakSet();
  const isPw = (el) => el && el.localName === 'input' && el.type === 'password';
  const onMut = (muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') { if (m.oldValue === 'password' || isPw(m.target)) seen.add(m.target); continue; }
      if (m.target.shadowRoot) watch(m.target.shadowRoot); // declarative shadow roots attach while children parse
      for (const n of m.addedNodes) if (n.nodeType === 1) { if (isPw(n)) seen.add(n); sweep(n); }
    }
  };
  const sweep = (root) => {
    if (root.shadowRoot) watch(root.shadowRoot);
    for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) { if (isPw(el)) seen.add(el); if (el.shadowRoot) watch(el.shadowRoot); }
  };
  function watch(root) {
    if (observed.has(root)) return;
    observed.add(root);
    new MutationObserver(onMut).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
    sweep(root);
  }
  watch(document);
  document.addEventListener('DOMContentLoaded', () => sweep(document), { once: true });
}

// An input Bosun types a secret into stays sensitive from then on, whatever its type or label (masked in read and
// screenshot, cleared like a credential field): it joins the set of former password fields in the scans' world. The
// element (handle or locator) may live in another world, so it is tagged with a one-off attribute and found again by
// it.
export async function markSensitive(page, l) {
  const key = crypto.randomBytes(8).toString('hex');
  await l.evaluate((el, k) => el.setAttribute('data-bosun-secret', k), key, { timeout: 15000 });
  const found = await eachFrame(page, (k) => {
    const KEY = Symbol.for('bosun.sensitive');
    const seen = window[KEY] || (window[KEY] = new WeakSet());
    const out = [];
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (el.getAttribute('data-bosun-secret') !== k) continue;
        seen.add(el);
        el.removeAttribute('data-bosun-secret');
        out.push(1);
      }
    }
    return out;
  }, key);
  if (!found.length) throw new Error('could not mark the field for masking (did the page replace it?); nothing was typed');
}

// After a secret was typed: every input and textarea (any frame, open shadow roots) that holds it becomes sensitive,
// wherever the page let the typing land (a focus handler can move it to another field). Returns how many.
export async function markValue(page, value) {
  const found = await eachFrame(page, (v) => {
    const KEY = Symbol.for('bosun.sensitive');
    const seen = window[KEY] || (window[KEY] = new WeakSet());
    const out = [];
    const roots = [document];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll('*')) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value && (el.value === v || (v.length >= 3 && el.value.includes(v)))) {
          seen.add(el);
          out.push(1);
        }
      }
    }
    return out;
  }, value);
  return found.length;
}

// For engines without same-world init scripts: install the tracker in Bosun's world in every frame.
export const installTracker = (page) => Promise.all(page.frames().map((f) => f.evaluate(passwordTracker).catch(() => {})));

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

// A quoted snapshot value is YAML: JSON's escapes plus \xNN (playwright-core yamlEscapeValueIfNeeded).
const unquote = (v) => {
  if (!v.startsWith('"')) return v;
  try { return JSON.parse(v.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (m, _c, hex) => (hex ? `\\u00${hex}` : m))); } catch { return v; }
};
// The inside of the quotes Playwright puts around a value that needs them.
const yamlEscaped = (v) => v.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]
  ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

// How Playwright's aria snapshot shows a value: without zero-width spaces and soft hyphens, trimmed, every run of
// white space one space (playwright-core normalizeWhiteSpace).
const normalized = (v) => v.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');

// Mask an aria snapshot / text dump: fields with a sensitive label, fields whose value is a sensitive value (as typed
// or as the snapshot normalizes it), and any other occurrence of either of 3+ characters.
export function maskText(text, values) {
  const vals = new Set(values.filter(Boolean).flatMap((v) => [v, normalized(v)]).filter(Boolean));
  let out = text.replace(LABEL_RE, '$1: [masked]');
  out = out.split('\n').map((line) => {
    const m = FIELD_LINE_RE.exec(line);
    return m && vals.has(unquote(m[2])) ? `${m[1]}: [masked]` : line;
  }).join('\n');
  for (const v of [...vals].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join('[masked]');
    for (const esc of new Set([JSON.stringify(v).slice(1, -1), yamlEscaped(v)])) if (esc !== v) out = out.split(esc).join('[masked]');
  }
  return out;
}
