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
        const by = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => text(document.getElementById(id)));
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

async function eachFrame(page, op) {
  const arg = { op, css: SENSITIVE_CSS, hint: HINT_WORDS, attr: MARK_ATTR };
  const res = await Promise.all(page.frames().map((f) => f.evaluate(inPage, arg).catch(() => [])));
  return res.flat();
}

export const sensitiveValues = (page) => eachFrame(page, 'values');
export const clearSensitive = (page) => eachFrame(page, 'clear');

// Screenshot with sensitive inputs masked in every frame; the marker attribute is removed afterwards.
export async function maskedScreenshot(page, take) {
  await eachFrame(page, 'mark');
  try {
    return await take(page.frames().map((f) => f.locator(`${SENSITIVE_CSS},[${MARK_ATTR}]`)));
  } finally {
    await eachFrame(page, 'unmark');
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
