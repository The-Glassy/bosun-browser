// Google Meet, joined as an unauthenticated guest. Everything Meet-specific (texts, labels, DOM markers) lives here;
// the meeting manager only uses the platform interface:
//
//   name, matches(url)
//   lobby(page, {name})   mic and camera off, guest name filled in, "Ask to join" clicked -> 'waiting' | 'admitted'
//   state(page)           'lobby' | 'waiting' | 'admitted' | 'denied' | 'removed' | 'ended' | 'unknown'
//   openChat(page), sendChat(page, text)
//   watchChat(page, key)  install a MutationObserver that queues new chat messages; drainChat(page, key) -> [{id, sender, text}]
//   participants(page)    number of people in the call (incl. the bot), or null if the page doesn't show it
//   leave(page)
//
// Meet's markup changes without notice. The markers are kept to labels and texts a person sees (English and German
// UI) plus a few stable data attributes; a run against real Meet that fails here is fixed here.

const one = (re) => (s) => re.test(String(s || '').replace(/[‘’]/g, "'"));
const TEXT = {
  waiting: /asking to be let in|you'll join the call when someone lets you in|waiting for the host|please wait until a meeting host|teilnahme wird angefragt|sie nehmen teil, sobald|sobald (?:dich|sie) jemand (?:in den anruf )?(?:lässt|zulässt)/i,
  denied: /denied your request|can't join this (?:video )?call|cannot join this call|not allowed to join|weren't allowed to join|anfrage.*abgelehnt|(?:sie können|du kannst) (?:an )?diese[mn]? (?:video)?anruf nicht (?:beitreten|teilnehmen)/i,
  removed: /you've been removed|you have been removed|removed you from the (?:meeting|call)|aus (?:dem|der) (?:meeting|besprechung|anruf|videoanruf) entfernt/i,
  ended: /the call has ended|call ended|meeting (?:has )?ended|you left the meeting|you left the call|der anruf wurde beendet|(?:besprechung|meeting) (?:wurde )?beendet|sie haben (?:das meeting|den anruf) verlassen/i,
};
const LABEL = {
  micOff: /^(?:turn off microphone|mikrofon (?:deaktivieren|ausschalten))/i, // the button that turns it off: it is on
  micOn: /^(?:turn on microphone|mikrofon (?:aktivieren|einschalten))/i, // it is off
  camOff: /^(?:turn off camera|kamera (?:deaktivieren|ausschalten))/i,
  camOn: /^(?:turn on camera|kamera (?:aktivieren|einschalten))/i,
  join: /^(?:ask to join|teilnahme anfragen|teilnehmen anfragen|join now|jetzt teilnehmen|beitreten)$/i,
  chat: /^(?:chat with everyone|chat mit allen|open chat|chat öffnen|chat)$/i,
  chatInput: /send a message|nachricht senden|nachricht an alle/i,
  leave: /^(?:leave call|anruf verlassen|leave meeting|besprechung verlassen)$/i,
};
const NAME_INPUT = 'input[aria-label="Your name"], input[aria-label="Ihr Name"], input[aria-label="Dein Name"], input[placeholder="Your name"], input[placeholder="Ihr Name"]';

// Visible page text outside anything participants control: chat messages, participant tiles and lists (names), and
// form fields are skipped structurally, so a name or a chat line reading "The call has ended" neither ends the
// meeting nor hides the real banner.
const PARTICIPANT_CONTROLLED = '[data-message-id], [data-sender-name], [data-participant-id], [role="list"], [role="listitem"], textarea, input, [contenteditable="true"]';
function pageText(page) {
  return page.evaluate((skip) => {
    const out = [];
    const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const vis = new Map();
    for (let n = walk.nextNode(); n && out.length < 2000; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.nodeValue.trim() || el.closest(skip) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
      if (!vis.has(el)) vis.set(el, el.checkVisibility ? el.checkVisibility() : !!el.offsetParent);
      if (vis.get(el)) out.push(n.nodeValue.trim());
    }
    return out.join('\n').slice(0, 20000);
  }, PARTICIPANT_CONTROLLED);
}
const visible = (l) => l.first().isVisible().catch(() => false);
const button = (page, name) => page.getByRole('button', { name });

export const meet = {
  name: 'meet',

  matches(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname);
    } catch { return false; }
  },

  async lobby(page, { name, timeoutMs = 30_000 }) {
    const end = Date.now() + timeoutMs;
    // The lobby renders in steps; wait for the join button or the name field.
    for (;;) {
      if (await visible(button(page, LABEL.join)) || await visible(page.locator(NAME_INPUT))) break;
      const s = await this.state(page);
      if (s === 'denied' || s === 'ended') return s;
      if (Date.now() > end) throw new Error('no Meet lobby found (not a Meet page, or Meet changed)');
      await page.waitForTimeout(500);
    }
    // Microphone and camera off before joining, verified: each control must end up showing its "turn on" label.
    // If that can't be confirmed (control missing, click failed, Meet changed) the join is refused rather than risked.
    for (const [what, onLabel, offLabel] of [['microphone', LABEL.micOff, LABEL.micOn], ['camera', LABEL.camOff, LABEL.camOn]]) {
      const until = Date.now() + 10_000;
      for (;;) {
        if (await visible(button(page, offLabel))) break;
        const on = button(page, onLabel);
        if (await visible(on)) await on.first().click({ timeout: 3000 }).catch(() => {});
        if (Date.now() > until) throw new Error(`could not make sure the ${what} is off before joining (Meet changed?); not joining`);
        await page.waitForTimeout(300);
      }
    }
    const input = page.locator(NAME_INPUT);
    if (await visible(input)) await input.first().fill(name, { timeout: 5000 });
    await button(page, LABEL.join).first().click({ timeout: 10_000 });
    await page.waitForTimeout(1000);
    const s = await this.state(page);
    return s === 'admitted' ? 'admitted' : s === 'denied' || s === 'ended' ? s : 'waiting';
  },

  async state(page) {
    const t = await pageText(page).catch(() => '');
    if (one(TEXT.denied)(t)) return 'denied';
    if (one(TEXT.removed)(t)) return 'removed';
    if (one(TEXT.ended)(t)) return 'ended';
    if (one(TEXT.waiting)(t)) return 'waiting';
    // In the call: participant tiles or the in-call chat button (the lobby has neither).
    if (await page.locator('[data-participant-id]').count().catch(() => 0) || await visible(button(page, LABEL.chat))) return 'admitted';
    if (await visible(button(page, LABEL.join))) return 'lobby';
    return 'unknown';
  },

  async openChat(page) {
    if (await visible(page.getByRole('textbox', { name: LABEL.chatInput }))) return;
    await button(page, LABEL.chat).first().click({ timeout: 10_000 });
    await page.getByRole('textbox', { name: LABEL.chatInput }).first().waitFor({ state: 'visible', timeout: 10_000 });
  },

  async sendChat(page, text) {
    await this.openChat(page);
    const box = page.getByRole('textbox', { name: LABEL.chatInput }).first();
    await box.fill(text, { timeout: 5000 });
    await box.press('Enter', { timeout: 5000 });
  },

  // New chat messages are queued in the page under a random, non-enumerable key; drainChat empties the queue.
  // Messages already in the panel when the watch starts are queued too (they arrived before we could listen).
  async watchChat(page, key) {
    await page.evaluate((key) => {
      if (window[key]) return;
      const q = [];
      const seen = new Map(); // id -> text queued last; a message rendered empty first, or changed, is queued again
      const sender = (el) => {
        const named = el.closest('[data-sender-name]');
        if (named) return named.getAttribute('data-sender-name');
        // Meet groups consecutive messages under one header line with the sender's name.
        const own = new Set((el.innerText || '').split('\n').map((s) => s.trim()));
        for (let g = el.parentElement, i = 0; g && i < 3; g = g.parentElement, i++) {
          const first = (g.innerText || '').split('\n').map((s) => s.trim()).find(Boolean);
          if (first && !own.has(first) && first.length <= 80) return first;
        }
        return null;
      };
      const scan = () => {
        for (const el of document.querySelectorAll('[data-message-id]')) {
          const id = el.getAttribute('data-message-id');
          const text = (el.innerText || '').trim().slice(0, 2000);
          if (!id || !text || seen.get(id) === text) continue;
          seen.set(id, text);
          if (seen.size > 2000) seen.delete(seen.keys().next().value);
          q.push({ id, sender: sender(el), text });
          if (q.length > 500) q.shift();
        }
      };
      Object.defineProperty(window, key, { value: { q, scan }, enumerable: false });
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
      scan();
    }, key);
  },

  async drainChat(page, key) {
    return page.evaluate((key) => {
      const w = window[key];
      if (!w) return null; // the page was replaced: watch again
      w.scan();
      return w.q.splice(0);
    }, key);
  },

  async participants(page) {
    const n = await page.evaluate(() => new Set([...document.querySelectorAll('[data-participant-id]')].map((e) => e.getAttribute('data-participant-id'))).size).catch(() => 0);
    return n || null;
  },

  async leave(page) {
    const b = button(page, LABEL.leave);
    if (await visible(b)) await b.first().click({ timeout: 5000 }).catch(() => {});
  },
};
