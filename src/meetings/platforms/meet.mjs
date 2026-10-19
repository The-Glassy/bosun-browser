// Google Meet, joined as an unauthenticated guest, or with a Bosun profile that is signed in to a Google account
// (then Meet takes the name from the account and shows no name field). Everything Meet-specific (texts, labels, DOM
// markers) lives here; the meeting manager only uses the platform interface:
//
//   name, matches(url), locale
//   joinUrl(url)          the URL to load: forces Meet's English UI (hl=en)
//   lobby(page, {name})   mic and camera off, guest name filled in (if asked), join clicked
//                         -> 'waiting' | 'admitted' | 'denied' | 'refused' | 'ended'
//   state(page)           'lobby' | 'waiting' | 'admitted' | 'denied' | 'refused' | 'removed' | 'ended' | 'unknown'
//   openChat(page), sendChat(page, text)
//   watchChat(page, key)  install a MutationObserver that queues new chat messages; drainChat(page, key) -> [{id, sender, text}]
//   participants(page)    number of people in the call (incl. the bot), or null if the page doesn't show it
//   leave(page)
//
// Meet's markup changes without notice and its language follows the account, the browser and the hl parameter. The
// session asks for English (joinUrl, locale), and every text and label is still matched in English, German, Slovak,
// Ukrainian and Russian, so a UI that comes up in another of those languages works too. Markers are labels, roles
// and texts a person sees; a run against real Meet that fails here is fixed here.

const norm = (s) => String(s || '').replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ');
const any = (...parts) => new RegExp(parts.join('|'), 'i');
const TEXT = {
  waiting: any("asking to be let in", "you'll join the call when someone lets you in", 'waiting for the host', 'please wait until a meeting host',
    'teilnahme wird (?:angefragt|erbeten)', 'sie nehmen teil, sobald', 'sobald (?:dich|sie) jemand', 'warten, bis sie jemand',
    'žiadate o (?:pripojenie|vpustenie)', 'pripojíte sa, keď vás niekto',
    'просимо дозволу', 'ви приєднаєтеся до дзвінка, коли вас',
    'запрашиваем разрешение', 'вы присоединитесь к звонку, когда вас'),
  // A participant (the host) said no.
  denied: any('denied your request', 'request to join was denied', "weren't allowed to join", 'not allowed to join',
    'hat ihre anfrage (?:auf teilnahme )?abgelehnt', 'anfrage.*abgelehnt', 'zamietol (?:vašu )?žiadosť', 'відхилив (?:ваш )?запит', 'отклонил (?:ваш )?запрос'),
  // "You can't join this (video) call": Google turning the guest away, usually before anyone could be asked.
  cantJoin: any("(?:can't|cannot|can not) join this (?:video )?call", 'sie können nicht an diesem (?:video)?anruf teilnehmen',
    'sie können diesem (?:video)?anruf nicht beitreten', 'du kannst nicht an diesem (?:video)?anruf teilnehmen',
    'k tomuto (?:video)?hovoru sa nemôžete pripojiť', 'nemôžete sa pripojiť k tomuto (?:video)?hovoru',
    'ви не можете приєднатися до цього (?:відео)?дзвінка', 'вы не можете присоединиться к этому (?:видео)?(?:звонку|вызову)'),
  removed: any("you've been removed", 'you have been removed', 'removed you from the (?:meeting|call)', 'aus (?:dem|der) (?:meeting|besprechung|anruf|videoanruf) entfernt',
    'vás odstránil', 'вас видалено', 'вас удалили'),
  ended: any('the call has ended', 'call ended', 'meeting (?:has )?ended', 'you left the meeting', 'you left the call', 'der anruf wurde beendet',
    '(?:besprechung|meeting) (?:wurde )?beendet', 'sie haben (?:das meeting|den anruf|die besprechung) verlassen',
    'hovor sa skončil', 'opustili ste (?:hovor|stretnutie)', 'дзвінок завершено', 'ви вийшли', 'звонок завершен', 'вы покинули'),
  // Shown in the lobby when the browser has no such device: the control is off by construction.
  noCamera: any('camera not found', 'no camera found', 'kamera nicht gefunden', 'keine kamera gefunden', 'kamera sa nenašla', 'камеру не знайдено', 'камера не найдена'),
  noMic: any('microphone not found', 'no microphone found', 'mikrofon nicht gefunden', 'kein mikrofon gefunden', 'mikrofón sa nenašiel', 'мікрофон не знайдено', 'микрофон не найден'),
};
const LABEL = {
  micOff: any('^turn off microphone', '^mikrofon (?:deaktivieren|ausschalten)', '^vypnúť mikrofón', '^вимкнути мікрофон', '^выключить микрофон'), // it is on
  micOn: any('^turn on microphone', '^mikrofon (?:aktivieren|einschalten)', '^zapnúť mikrofón', '^увімкнути мікрофон', '^включить микрофон'), // it is off
  camOff: any('^turn off camera', '^kamera (?:deaktivieren|ausschalten)', '^vypnúť kameru', '^вимкнути камеру', '^выключить камеру'),
  camOn: any('^turn on camera', '^kamera (?:aktivieren|einschalten)', '^zapnúť kameru', '^увімкнути камеру', '^включить камеру'),
  join: any('^ask to join$', '^join now$', '^join$', '^teilnahme erbitten$', '^teilnahme anfragen$', '^teilnehmen anfragen$', '^jetzt teilnehmen$', '^teilnehmen$', '^beitreten$',
    '^požiadať o pripojenie$', '^pripojiť sa$', '^pripojiť sa teraz$', '^попросити приєднатися$', '^приєднатися$', '^приєднатися зараз$',
    '^попросить разрешения присоединиться$', '^присоединиться$', '^присоединиться сейчас$'),
  chat: any('^chat with everyone$', '^chat mit allen$', '^open chat$', '^chat öffnen$', '^chat$', '^chatovať so všetkými$', '^чат з усіма$', '^чат со всеми$', '^чат$'),
  chatInput: any('send a message', 'nachricht senden', 'nachricht an alle', 'odoslať správu', 'надіслати повідомлення', 'отправить сообщение'),
  leave: any('^leave call$', '^anruf verlassen$', '^leave meeting$', '^besprechung verlassen$', '^opustiť hovor$', '^вийти з дзвінка$', '^покинуть звонок$'),
};
const NAME_LABELS = ['Your name', 'Ihr Name', 'Dein Name', 'Vaše meno', 'Ваше ім’я', "Ваше ім'я", 'Ваше имя'];
// The guest-name field: by its label or placeholder in any of the languages, else the only text box on the page.
async function nameInput(page) {
  for (const n of NAME_LABELS) {
    const l = page.locator(`input[aria-label="${n}"], input[placeholder="${n}"]`);
    if (await visible(l)) return l.first();
  }
  const boxes = page.getByRole('textbox');
  const shown = [];
  for (let i = 0, c = Math.min(await boxes.count().catch(() => 0), 5); i < c; i++) if (await boxes.nth(i).isVisible().catch(() => false)) shown.push(boxes.nth(i));
  return shown.length === 1 ? shown[0] : null;
}

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
  }, PARTICIPANT_CONTROLLED).then(norm);
}
const visible = (l) => l.first().isVisible().catch(() => false);
const button = (page, name) => page.getByRole('button', { name });
const disabled = (l) => l.first().evaluate((b) => b.disabled || b.getAttribute('aria-disabled') === 'true').catch(() => false);

// Whether a page text is Google's "You can't join this video call" page (also used by the bot-wall check).
export const meetCantJoin = (text) => TEXT.cantJoin.test(norm(text));

export const meet = {
  name: 'meet',
  locale: 'en-US', // the meeting browser's language (Accept-Language, navigator.language)

  matches(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && u.hostname === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname);
    } catch { return false; }
  },

  joinUrl(url) {
    const u = new URL(url);
    u.searchParams.set('hl', 'en');
    return u.href;
  },

  // Microphone or camera verified off: its control shows "turn on", or the device doesn't exist (Meet says it wasn't
  // found, or its control is disabled). If it is on, it is switched off and checked again. Throws if neither can be
  // established: joining with a live microphone or camera is not risked.
  async ensureOff(page, what, { onLabel, offLabel, missing }, timeoutMs = 10_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await visible(button(page, offLabel))) return 'off';
      if (TEXT[missing].test(await pageText(page).catch(() => ''))) return 'no device';
      const on = button(page, onLabel);
      if (await visible(on)) {
        if (await disabled(on)) return 'no device';
        await on.first().click({ timeout: 3000 }).catch(() => {});
      }
      if (Date.now() > until) throw new Error(`could not make sure the ${what} is off before joining (Meet changed?); not joining`);
      await page.waitForTimeout(300);
    }
  },

  async lobby(page, { name, timeoutMs = 30_000 }) {
    const end = Date.now() + timeoutMs;
    // The lobby renders in steps; wait for the join button (a guest also gets a name field first on some pages).
    let input = null;
    for (;;) {
      if (await visible(button(page, LABEL.join))) break;
      const s = await this.state(page);
      if (s === 'denied' || s === 'refused' || s === 'ended') return s;
      if (Date.now() > end) throw new Error(`no "Ask to join" button found on the Meet page (not a Meet lobby, or Meet changed); page ${s}`);
      await page.waitForTimeout(500);
    }
    await this.ensureOff(page, 'microphone', { onLabel: LABEL.micOff, offLabel: LABEL.micOn, missing: 'noMic' });
    await this.ensureOff(page, 'camera', { onLabel: LABEL.camOff, offLabel: LABEL.camOn, missing: 'noCamera' });
    // Signed in to Google: no name field, Meet uses the account's name.
    input = await nameInput(page);
    if (input) await input.fill(name, { timeout: 5000 });
    const join = button(page, LABEL.join).first();
    // Guests may have to type a name before the button is enabled.
    for (let i = 0; i < 20 && await disabled(join); i++) await page.waitForTimeout(250);
    await join.click({ timeout: 10_000 });
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500);
      const s = await this.state(page);
      if (s === 'admitted' || s === 'denied' || s === 'refused' || s === 'ended') return s;
      if (s === 'waiting') return 'waiting';
    }
    return 'waiting';
  },

  async state(page) {
    const t = await pageText(page).catch(() => '');
    if (TEXT.denied.test(t)) return 'denied';
    if (TEXT.cantJoin.test(t)) return 'refused';
    if (TEXT.removed.test(t)) return 'removed';
    if (TEXT.ended.test(t)) return 'ended';
    if (TEXT.waiting.test(t)) return 'waiting';
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
