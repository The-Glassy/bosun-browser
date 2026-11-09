// Shared credential/token detection for read (including macros), screenshot and handoff cleanup.
// Mask field values by metadata and recognize secret formats anywhere in page text.
import crypto from 'crypto';

// Keep field hints and format rules here: DOM scans, read output and screenshot masks share them.
export const SENSITIVE_CSS = [
  'input[type=password]',
  'input[autocomplete~="one-time-code"]', 'input[autocomplete~="current-password"]', 'input[autocomplete~="new-password"]',
  'input[autocomplete~="cc-number"]', 'input[autocomplete~="cc-csc"]',
].join(',');
const MARK_ATTR = 'data-bosun-sensitive';

// Separators (including snake_case and camelCase metadata) are normalized before matching. In particular,
// "pin" must not match "pinned"/"spinner", and "token" must not match "Tokenized".
const HINT_WORDS = String.raw`\b(?:token|secret|api ?key|private ?key|client ?secret|feed ?token|password|passcode|otp|pin|pwd|totp|pincode|passphrase|2fa|mfa|tan|cvc|cvv|csc)\b|passw|kennw|mot de passe|contrase|senha|heslo|hasło|parol|wachtwoord|lösenord|salasana|one ?time|security code|verification code|sicherheitscode|bestätigungscode`;
const FORMAT_SOURCE = String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)|(?<![A-Za-z0-9])(?:gl(?:pat|ft|rt|ptt)-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]+|(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)`;
const hintText = (v) => `${v} ${v.replace(/([a-z])([A-Z])/g, '$1 $2')}`.replace(/[_\-.[\]]+/g, ' ');
// Only these public, fixed prefixes survive masking. Never retain a suffix or an arbitrary part of a value.
const PREFIX_SOURCE = String.raw`^(?:gl(?:pat|ft|rt|ptt)-|gh[pousr]_|github_pat_|sk-ant-|sk-|xox[abprs]-|AKIA|ASIA)`;
const maskedValue = (v) => {
  const prefix = new RegExp(PREFIX_SOURCE).exec(v)?.[0];
  return prefix ? `${prefix}…[masked]` : '[masked]';
};

// Runs in every frame. Hidden elements are deliberately scanned too: reveal widgets often keep a second copy
// there, and aria-labelledby can include text from an aria-hidden element.
function inPage(subject, options) {
  // Frame.evaluate passes the options; Locator.evaluate additionally passes its selected root.
  const { op, css, hint, attr, formats, prefixes, max, values = [] } = options || subject;
  const KEY = Symbol.for('bosun.sensitive');
  const seen = window[KEY] || (window[KEY] = new WeakSet());
  const re = new RegExp(hint, 'i');
  const formatRE = new RegExp(formats, 'g');
  const normalizeHint = (v) => `${v} ${v.replace(/([a-z])([A-Z])/g, '$1 $2')}`.replace(/[_\-.[\]]+/g, ' ');
  const text = (el) => el?.textContent || '';
  const hints = (el) => {
    const root = el.getRootNode();
    const byId = (id) => root.getElementById?.(id) || document.getElementById(id);
    const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => text(byId(id)));
    const data = [...el.attributes].filter((a) => a.name.startsWith('data-') && !a.name.startsWith('data-bosun-')).flatMap((a) => [a.name.slice(5), a.value]);
    return re.test(normalizeHint([el.getAttribute('name'), el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.getAttribute('placeholder'),
      ...[...(el.labels || [])].map(text), ...by, ...data].filter(Boolean).join(' ')));
  };
  const matches = (v, entropy) => {
    const found = [...v.matchAll(formatRE)].map((m) => m[0]);
    if (!entropy) return found;
    for (const m of v.matchAll(/(?<![A-Za-z0-9_+/-])[A-Za-z0-9_+/-]{32,}={0,2}(?![A-Za-z0-9_+/=-])/g)) {
      const s = m[0].replace(/=+$/, '');
      // A URL's path, slug or ordinary query is not a credential. A secret-named query component can be.
      const url = [...v.matchAll(/https?:\/\/[^\s<>"']+/g)].find((u) => m.index >= u.index && m.index < u.index + u[0].length);
      if (url) {
        const param = /[?&#]([^=&#]+)=$/.exec(v.slice(url.index, m.index));
        if (!param || !re.test(normalizeHint(param[1]))) continue;
      }
      const hex = /^[a-f\d]+$/i.test(s);
      // Repeated padding and ordinary long words have too little entropy to count as credentials.
      const counts = new Map();
      for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
      const bits = [...counts.values()].reduce((h, n) => h - n / s.length * Math.log2(n / s.length), 0);
      if (bits >= (hex ? 3 : 4.3)) found.push(m[0]);
    }
    return found;
  };
  const out = new Set();
  const candidates = [];
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const labels = new Set([...root.querySelectorAll('[aria-labelledby]')].flatMap((el) =>
      (el.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => root.getElementById?.(id) || document.getElementById(id))).filter(Boolean));
    const labelled = (el) => {
      for (let p = el; p; p = p.parentElement) if (labels.has(p)) return true;
      return false;
    };
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (op === 'unmark') { el.removeAttribute(attr); continue; }
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      if (field && el.type === 'password') seen.add(el);
      if (op === 'note') continue;
      const label = el.closest('label,h1,h2,h3,h4,h5,h6,legend,button,script,style,template') || labelled(el);
      const valueElement = field || (!label && (el.matches('code,pre,output,[readonly],[aria-readonly=true],[contenteditable],[value],[data-value],[role=textbox]') || !el.children.length));
      let sensitive = valueElement && (seen.has(el) || el.matches(css) || hints(el));
      // A reveal widget may name its wrapper, with the actual value in a hidden/readonly child.
      if (!sensitive && valueElement && !field) {
        for (let p = el.parentElement; p && !p.matches('body,html,form'); p = p.parentElement) {
          if (!p.matches('label,button') && hints(p)) { sensitive = true; break; }
        }
        // A text label within the widget is still a label, not its value.
        if (sensitive && /^(?:(?:your|new|personal|access|feed|client|private|api|copy|show|reveal)\s+)*(?:token|secret|key|password|passcode|otp|pin)\s*:?$/i.test(text(el).trim())) sensitive = false;
      }
      const value = field ? el.value : el.getAttribute('value') ?? el.getAttribute('data-value') ?? text(el);
      const entropy = valueElement && (field || el.matches('code,pre,[readonly],[aria-readonly=true]'));
      const content = text(el);
      const found = [...new Set([...matches(value, entropy), ...(value !== content ? matches(content, entropy) : [])])];
      // Accessibility names/values and links can contain a secret even if there is no visible text node.
      const attrFound = [...el.attributes].flatMap((a) => matches(a.value, false));
      for (const v of [...found, ...attrFound]) out.add(v);
      if (sensitive && value) out.add(value);
      if (op === 'mark') candidates.push({ el, value: `${value}\n${content}`, sensitive, attrFound });
      else if (op === 'clear' && field && (sensitive || found.length) && el.value) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
  if (op === 'mark') {
    // Resolve after collecting all fields, so a reflected value is protected even when its source field is later
    // in the DOM or hidden. Cover the smallest element containing the match (including split inline text).
    const values = [...out].filter((v) => v.length >= 3);
    for (const { el, value, sensitive, attrFound } of candidates) {
      const ownMatch = values.some((v) => value.includes(v) && ![...el.children].some((c) => text(c).includes(v)));
      if (sensitive || ownMatch || attrFound.length) el.setAttribute(attr, '');
    }
  }
  if (op === 'text') {
    const el = subject;
    const walk = (n) => {
      if (n.nodeType === Node.TEXT_NODE) return n.nodeValue;
      if (n.nodeType !== Node.ELEMENT_NODE) return '';
      if (n.matches('script,style,template,[hidden],[aria-hidden="true" i]')) return '';
      const style = getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return '';
      if (n.localName === 'br') return '\n';
      const block = /^(block|flex|grid|table|list-item)/.test(style.display);
      return `${block ? '\n' : ''}${[...n.childNodes].map(walk).join('')}${block ? '\n' : ''}`;
    };
    // A selected descendant of a hidden widget must also stay hidden.
    for (let p = el.parentElement; p; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (p.matches('[hidden],[aria-hidden="true" i]') || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return [0, ''];
    }
    let t = walk(el).replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    const total = t.length;
    const variants = [...new Set([...values, ...out].filter(Boolean).flatMap((v) => [v, v.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ')]))];
    for (const value of variants.sort((a, b) => b.length - a.length)) if (value.length >= 3) {
      const prefix = new RegExp(prefixes).exec(value)?.[0];
      t = t.split(value).join(prefix ? `${prefix}…[masked]` : '[masked]');
    }
    t = t.replace(new RegExp(formats, 'g'), (v) => {
      const prefix = new RegExp(prefixes).exec(v)?.[0];
      return prefix ? `${prefix}…[masked]` : '[masked]';
    });
    return [total, t.slice(0, max)];
  }
  return [...out];
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
const scanOptions = (op) => ({ op, css: SENSITIVE_CSS, hint: HINT_WORDS, attr: MARK_ATTR, formats: FORMAT_SOURCE, prefixes: PREFIX_SOURCE });
const scan = (page, op) => eachFrame(page, inPage, scanOptions(op));

export const sensitiveValues = (page) => scan(page, 'values');
export const clearSensitive = (page) => scan(page, 'clear');
// Read visible text, including when the selected root itself is hidden (innerText would fall back to
// textContent there). Skip aria-hidden reveal copies too. Redact before truncating in the browser so a cut
// through the middle of a token cannot expose its leading characters.
export const readText = (root, max, values) => root.evaluate(inPage, { ...scanOptions('text'), max, values }, { timeout: 15000 });

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

// When a secret landed somewhere other than the field Bosun checked: take it out of every field and every text node
// (contenteditable included) in every frame and open shadow root, so no later read or screenshot carries it.
export const scrubValue = (page, value) => eachFrame(page, (v) => {
  const out = [];
  const roots = [document];
  for (let i = 0; i < roots.length; i++) {
    const walk = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walk.currentNode; n; n = walk.nextNode()) {
      if (n.nodeType === 3) { if (n.nodeValue.includes(v)) { n.nodeValue = n.nodeValue.split(v).join(''); out.push(1); } continue; }
      if (n.shadowRoot) roots.push(n.shadowRoot);
      if ((n instanceof HTMLInputElement || n instanceof HTMLTextAreaElement) && n.value.includes(v)) { n.value = n.value.split(v).join(''); out.push(1); }
    }
  }
  return out;
}, value);

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

// A key with YAML specials in its name comes single-quoted: - 'textbox "Contact: code" [ref=e3]': value
const FIELD_HEAD_RE = /^\s*- '?(?:textbox|searchbox|spinbutton|combobox)\b.*:$/;
const sensitiveLabel = (line) => {
  const label = /^\s*- '?(?:textbox|searchbox|spinbutton|combobox) "((?:[^"\\]|\\.)*)"/.exec(line)?.[1];
  return !!label && new RegExp(HINT_WORDS, 'i').test(hintText(label));
};
const CHILD_TEXT_RE = /^(\s*- text): (.*)$/;
const FIELD_LINE_RE = /^(\s*- (?:'(?:textbox|searchbox|spinbutton|combobox)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*'|(?:textbox|searchbox|spinbutton|combobox)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]]*\])*)): (.*)$/;

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
export function maskText(text, values = []) {
  const vals = new Set(values.filter(Boolean).flatMap((v) => [v, normalized(v)]).filter(Boolean));
  let out = text;
  // A field with a placeholder has children, and its value is the "- text:" line among them.
  let block = null; // { indent, sensitive }: inside such a field
  out = out.split('\n').map((line) => {
    const indent = line.length - line.trimStart().length;
    if (block && indent <= block.indent) block = null;
    if (block) {
      const t = CHILD_TEXT_RE.exec(line);
      return t && (block.sensitive || vals.has(unquote(t[2]))) ? `${t[1]}: ${maskedValue(unquote(t[2]))}` : line;
    }
    if (FIELD_HEAD_RE.test(line)) { block = { indent, sensitive: sensitiveLabel(line) }; return line; }
    const m = FIELD_LINE_RE.exec(line);
    return m && (sensitiveLabel(line) || vals.has(unquote(m[2]))) ? `${m[1]}: ${maskedValue(unquote(m[2]))}` : line;
  }).join('\n');
  for (const v of [...vals].filter((v) => v.length >= 3).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join(maskedValue(v));
    for (const esc of new Set([JSON.stringify(v).slice(1, -1), yamlEscaped(v)])) if (esc !== v) out = out.split(esc).join(maskedValue(v));
  }
  return out.replace(new RegExp(FORMAT_SOURCE, 'g'), (v) => maskedValue(v));
}
