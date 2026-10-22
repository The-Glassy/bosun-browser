// Zoom, joined in the browser (Zoom's web client) with a Bosun profile signed in to a Zoom account; Zoom turns most
// anonymous guests away. Same platform interface as meet.mjs (see there). Invitation links (zoom.us/j/<id>?pwd=…,
// any *.zoom.us subdomain, webinar /w/ links, /wc/ web client links) are rewritten to the web client
// (https://app.zoom.us/wc/<id>/join?pwd=…), so no app-launch page comes up; if Zoom shows one anyway, "Join from your
// browser" is followed.
//
// Zoom's web client has no hl parameter: the session asks for English (locale, and Zoom's language cookie), and texts
// and labels are also matched in German and Ukrainian (some Russian). These markers were written from Zoom's web
// client as documented and seen in screenshots, and tested against a local stand-in (test/fakezoom.mjs), not yet
// against live Zoom: a run against real Zoom that fails here is fixed here.
import { norm, any, pageText as textOutside, visible, button, firstVisible, dismissOverlays, clickThrough, ensureOff } from './common.mjs';

const TEXT = {
  // The waiting room, or a meeting the host has not started yet (Zoom lets you in when it starts).
  waiting: any('please wait,? the meeting host will let you in soon', "we've let them know you're here", 'host has joined', 'waiting for the host to start',
    'the meeting will begin when the host joins', 'meeting has not started', 'waiting room',
    'bitte warten sie,? der (?:meeting-)?host', 'lässt sie (?:in kürze|gleich) (?:ein|teilnehmen)', 'warten auf (?:den )?host', 'das meeting beginnt,? (?:wenn|sobald) der host', 'warteraum',
    'зачекайте,? організатор', 'організатор (?:незабаром|скоро) (?:впустить|додасть)', 'очікування організатора', 'зал очікування',
    'подождите,? организатор', 'ожидание организатора', 'зал ожидания'),
  removed: any('you have been removed from (?:this|the) meeting', 'the host (?:has )?removed you', 'host removed you from',
    'sie wurden (?:vom host )?aus (?:diesem|dem) meeting entfernt', 'der host hat sie (?:aus dem meeting )?entfernt',
    'вас видалено з (?:цієї |цієї )?(?:конференції|зустрічі)', 'організатор видалив вас', 'вас удалили из конференции', 'организатор удалил вас'),
  ended: any('this meeting has been ended by (?:the )?host', 'the meeting has been ended', 'this meeting has ended', 'the meeting has ended', 'meeting has been ended',
    'you have left the meeting', 'you left the meeting',
    'dieses meeting wurde (?:vom host )?beendet', 'das meeting wurde beendet', 'sie haben das meeting verlassen',
    'цю конференцію (?:було )?завершено', 'конференцію завершено', 'організатор завершив (?:конференцію|зустріч)', 'конференция завершена', 'организатор завершил'),
  invalid: any('invalid meeting id', 'this meeting id is not valid', 'meeting id is not valid', 'meeting does not exist', 'incorrect (?:meeting )?passcode', 'passcode (?:is )?(?:wrong|incorrect)',
    'wrong passcode', 'invalid passcode', 'ungültige meeting-id', 'meeting-id ist ungültig', 'falscher kenncode', 'kenncode ist (?:falsch|ungültig)', 'ungültiger kenncode',
    'недійсний ідентифікатор конференції', 'неправильний (?:код доступу|пароль)', 'неверный идентификатор конференции', 'неверный код доступа'),
  signIn: any('sign in to join', 'authorized attendees only', 'only authenticated users can join', 'only signed-in users', 'requires authentication', 'you need to sign in',
    'melden sie sich an,? um (?:an diesem meeting )?teilzunehmen', 'nur (?:für )?autorisierte teilnehmer', 'nur authentifizierte (?:benutzer|teilnehmer)',
    'увійдіть,? щоб приєднатися', 'лише для авторизованих учасників', 'войдите,? чтобы присоединиться', 'только для авторизованных участников'),
  noMic: any('no microphone', 'microphone not found', 'cannot detect (?:your |a )?microphone', 'kein mikrofon', 'mikrofon nicht gefunden', 'мікрофон не знайдено', 'немає мікрофона', 'микрофон не найден'),
  noCamera: any('no camera', 'camera not found', 'cannot detect (?:your |a )?camera', 'video cannot (?:be )?start', 'keine kamera', 'kamera nicht gefunden', 'камеру не знайдено', 'немає камери', 'камера не найдена'),
};
const LABEL = {
  // Preview ("Mute" / "Stop Video") and toolbar ("mute my microphone" / "stop my video") controls.
  micOff: any('^mute$', '^mute (?:my )?microphone$', '^stummschalten$', '^mikrofon stummschalten$', '^вимкнути (?:звук|мікрофон)$', '^выключить (?:звук|микрофон)$'), // it is on
  micOn: any('^unmute$', '^unmute (?:my )?microphone$', '^stummschaltung aufheben$', '^увімкнути (?:звук|мікрофон)$', '^включить (?:звук|микрофон)$'), // it is off
  camOff: any('^stop (?:my )?video$', '^(?:mein )?video (?:beenden|stoppen)$', '^зупинити відео$', '^вимкнути відео$', '^остановить видео$'),
  camOn: any('^start (?:my )?video$', '^(?:mein )?video starten$', '^почати відео$', '^увімкнути відео$', '^включить видео$', '^начать видео$'),
  join: any('^join$', '^join meeting$', '^join webinar$', '^beitreten$', '^meeting beitreten$', '^приєднатися$', '^присоединиться$'),
  // Computer audio is what makes the meeting audible (and recordable).
  joinAudio: any('^join audio by computer$', '^join with computer audio$', '^computer audio$', '^per computer (?:dem )?audio beitreten$', '^mit computeraudio beitreten$', '^computer-?audio beitreten$',
    "^приєднатися до аудіо (?:з|через) комп'ютер(?:а)?$", "^аудіо комп'ютера$", '^войти с использованием звука компьютера$', '^звук компьютера$'),
  audioMenu: any('^join audio$', '^audio beitreten$', '^приєднатися до аудіо$', '^войти в аудиоконференцию$'),
  chat: any('^open the chat pane(?:l)?$', '^chat$', '^open chat$', '^chat öffnen$', '^chatbereich öffnen$', '^відкрити (?:панель )?чат(?:у)?$', '^чат$', '^открыть (?:панель )?чат(?:а)?$'),
  chatInput: any('type message', 'chat message', 'message to', 'nachricht', 'повідомлення', 'сообщение'),
  participants: any('participants?\\b', 'particpants', 'teilnehmer', 'учасник', 'участник'),
  leave: any('^leave$', '^leave meeting$', '^verlassen$', '^meeting verlassen$', '^вийти$', '^вийти з конференції$', '^покинути конференцію$', '^выйти$', '^выйти из конференции$'),
  leaveConfirm: any('^leave meeting$', '^meeting verlassen$', '^вийти з конференції$', '^покинути конференцію$', '^выйти из конференции$'),
  launch: any('^launch meeting$', '^meeting (?:starten|eröffnen)$', '^запустити конференцію$', '^запустить конференцию$'),
  fromBrowser: any('join from (?:your|the) browser', '(?:über|vom|mit) (?:ihrem |dem )?browser (?:aus )?(?:beitreten|teilnehmen)', 'приєднатися (?:з|через) браузер', 'войти из браузера', 'присоединиться из браузера'),
  // Closes what Zoom lays over the page: tips, the cookie banner, "this meeting is being recorded", app prompts.
  dismiss: any('^got it$', '^ok$', '^close$', '^dismiss$', '^not now$', '^no thanks$', '^maybe later$', '^continue$', '^accept(?: all)? cookies$', '^i agree$', '^agree$',
    '^verstanden$', '^schließen$', '^nicht jetzt$', '^nein danke$', '^später$', '^fortfahren$', '^weiter$', '^(?:alle )?cookies akzeptieren$', '^ich stimme zu$', '^zustimmen$',
    '^зрозуміло$', '^закрити$', '^не зараз$', '^ні, дякую$', '^продовжити$', '^прийняти (?:усі )?файли cookie$', '^погоджуюся$', '^понятно$', '^закрыть$', '^не сейчас$', '^продолжить$'),
};
const NAME_FIELD = 'input#input-for-name, input[aria-label="Your Name" i], input[placeholder="Your Name" i], input[aria-label="Ihr Name" i], input[placeholder="Ihr Name" i], input[aria-label^="Ваше ім" i], input[placeholder^="Ваше ім" i]';
const PASSCODE_FIELD = 'input#input-for-pwd, input[aria-label*="passcode" i], input[placeholder*="passcode" i], input[aria-label*="kenncode" i], input[placeholder*="kenncode" i]';
const CHAT_INPUT = '.chat-box__chat-textarea, textarea[class*="chat"], [contenteditable="true"][class*="chat"], .tiptap[contenteditable="true"], [contenteditable="true"][data-placeholder*="message" i], textarea[placeholder*="message" i]';
// One chat message's text (innermost match wins), and the item it belongs to with the sender's name.
const CHAT_MESSAGE = '[id^="chat-message-content"], .new-chat-message__container, .chat-message__container, [class*="chat-message__text"]';
const CHAT_SENDER = '.chat-item__sender, [class*="chat-item__sender"], [class*="chat-message__sender"]';
const CHAT_ITEM = '.chat-item-container, [class*="chat-item__container"], [class*="chat-item-container"], [role="listitem"]';

// What participants control: the chat and its input, names on video tiles and in the participants list.
const PARTICIPANT_CONTROLLED = '[class*="chat"], [class*="participants-item"], [class*="participants-li"], [class*="video-avatar__avatar-name"], [class*="name-tag"], [class*="avatar-name"], [role="list"], [role="listitem"], textarea, input, [contenteditable="true"]';
const pageText = (page) => textOutside(page, PARTICIPANT_CONTROLLED);
const overlays = (page) => dismissOverlays(page, LABEL.dismiss, ['#onetrust-banner-sdk', '[class*="zm-modal"]', '[class*="modal-dialog"]']);
const TERMINAL = ['denied', 'ended', 'removed', 'invalid', 'sign-in', 'captcha'];

// A Zoom meeting link -> {id, pwd, tk} or null. Hosts: zoom.us and its subdomains (us02web.zoom.us, acme.zoom.us,
// app.zoom.us); paths: /j/<id>, /w/<id> (webinar), /wc/join/<id>, /wc/<id>/join, /wc/<id>.
export function parseZoomUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (u.hostname !== 'zoom.us' && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.zoom\.us$/.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/(?:j|w)\/(\d{9,12})\/?$/) || u.pathname.match(/^\/wc\/join\/(\d{9,12})\/?$/) || u.pathname.match(/^\/wc\/(\d{9,12})(?:\/join)?\/?$/);
  if (!m) return null;
  const pwd = u.searchParams.get('pwd');
  const tk = u.searchParams.get('tk');
  return { id: m[1], ...(pwd ? { pwd } : {}), ...(tk ? { tk } : {}) };
}

// The web client's join page for a meeting link.
export function zoomWebClientUrl(url) {
  const z = parseZoomUrl(url);
  if (!z) throw new Error('not a Zoom meeting link');
  const u = new URL(`https://app.zoom.us/wc/${z.id}/join`);
  if (z.pwd) u.searchParams.set('pwd', z.pwd);
  if (z.tk) u.searchParams.set('tk', z.tk);
  return u.href;
}

// A challenge Zoom shows before joining: a visible reCAPTCHA/hCaptcha frame (an invisible one is not a challenge).
async function captchaShown(page) {
  return page.locator('iframe').evaluateAll((fs) => fs.some((f) => {
    if (!/recaptcha|hcaptcha|challenges\.cloudflare|turnstile/.test(f.src)) return false;
    const r = f.getBoundingClientRect();
    return r.width >= 60 && r.height >= 60 && f.checkVisibility?.() !== false;
  })).catch(() => false);
}

async function chatBox(page) {
  return await firstVisible(page.getByRole('textbox', { name: LABEL.chatInput })) || firstVisible(page.locator(CHAT_INPUT));
}

export const zoom = {
  name: 'zoom',
  locale: 'en-US',
  messages: {
    invalid: 'Zoom says the meeting ID or passcode is not valid. Check the link: it needs ?pwd=… unless the meeting has no passcode.',
    signIn: 'Zoom lets only signed-in users into this meeting. Join with a Bosun profile signed in to Zoom: meeting_join with profile '
      + '(set it up with session_open({profile}), navigate to https://zoom.us/signin, request_human, session_close).',
    captcha: 'Zoom asked for a captcha before joining. A profile signed in to Zoom is asked far less often; or open that profile in a session '
      + '(session_open + request_human), join the meeting page once by hand, close it, and join again.',
  },

  matches: (url) => parseZoomUrl(url) !== null,
  joinUrl: zoomWebClientUrl,
  origins: (url) => ['https://app.zoom.us', new URL(url).origin],

  // Zoom's language cookie, so the web client comes up in English where the account doesn't say otherwise.
  async prepare(ctx) {
    await ctx.addCookies([{ name: '_zm_lang', value: 'en-US', domain: '.zoom.us', path: '/', secure: true, sameSite: 'Lax' }]).catch(() => {});
  },

  async lobby(page, { name, info = {}, profile = null, url = null, timeoutMs = 45_000 }) {
    const end = Date.now() + timeoutMs;
    const STOP = [...TERMINAL, 'waiting', 'admitted'];
    // An app-launch page instead of the web client: "Launch Meeting", then "Join from your browser". Cookie banners
    // and tips are closed on the way.
    for (;;) {
      const s = await this.state(page);
      if (STOP.includes(s)) return s; // e.g. a signed-in profile Zoom lets straight in, or a refusal
      if (s === 'lobby') break;
      if (s === 'launch') {
        const link = await firstVisible(page.getByRole('link', { name: LABEL.fromBrowser })) || await firstVisible(button(page, LABEL.fromBrowser));
        if (link) await link.click({ timeout: 5000 }).catch(() => {});
        else { const l = await firstVisible(button(page, LABEL.launch)); if (l) await l.click({ timeout: 3000 }).catch(() => {}); }
      }
      if (Date.now() > end) throw new Error(`no "Join" button found on the Zoom page (not Zoom's web client, or Zoom changed); page ${s}`);
      await overlays(page);
      await page.waitForTimeout(500);
    }
    await overlays(page);
    // Signed in: Zoom fills in the account's name, which is kept; otherwise (or with an empty field) `name`.
    const field = await firstVisible(page.locator(NAME_FIELD));
    const prefilled = field ? (await field.inputValue().catch(() => '')).trim() : '';
    if (field && !(profile && prefilled)) await field.fill(name, { timeout: 5000 });
    info.joinedAs = profile && (!field || prefilled) ? 'account' : 'guest';
    info.selfName = field ? (await field.inputValue().catch(() => name)).trim() : null;
    // The passcode comes with the link (pwd); a page that still asks for it gets it, or the join stops here.
    const pass = await firstVisible(page.locator(PASSCODE_FIELD));
    if (pass && !(await pass.inputValue().catch(() => ''))) {
      const pwd = url && parseZoomUrl(url)?.pwd;
      if (!pwd) { info.error = 'Zoom asks for the meeting passcode: use the invitation link with ?pwd=…, as Zoom sends it.'; return 'invalid'; }
      await pass.fill(pwd, { timeout: 5000 });
    }
    // In the preview, "Join Audio" (no audio connected yet) also means nothing goes out.
    const micOffOrNoAudio = new RegExp(`${LABEL.micOn.source}|${LABEL.audioMenu.source}`, 'i');
    for (const [what, onLabel, offLabel, missing] of [['microphone', LABEL.micOff, micOffOrNoAudio, TEXT.noMic], ['camera', LABEL.camOff, LABEL.camOn, TEXT.noCamera]]) {
      const r = await ensureOff(page, { what, onLabel, offLabel, missing, text: pageText, state: (p) => this.state(p), stop: TERMINAL, site: 'Zoom' });
      if (TERMINAL.includes(r)) return r;
    }
    const join = await firstVisible(button(page, LABEL.join));
    if (!join) throw new Error('the Zoom page has no "Join" button any more (Zoom changed?)');
    await clickThrough(page, join, { what: '"Join" on the Zoom page', overlays });
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(500);
      const s = await this.state(page);
      if (s === 'admitted' || s === 'waiting' || TERMINAL.includes(s)) return s;
    }
    return 'asked';
  },

  // Once in: computer audio joined (without it nothing is heard or recorded), microphone and camera verifiably off.
  async afterAdmit(page) {
    const until = Date.now() + 20_000;
    for (;;) {
      await overlays(page);
      if (await visible(button(page, LABEL.micOff)) || await visible(button(page, LABEL.micOn))) break; // audio connected
      const comp = await firstVisible(button(page, LABEL.joinAudio));
      if (comp) await comp.click({ timeout: 3000 }).catch(() => {});
      else { const menu = await firstVisible(button(page, LABEL.audioMenu)); if (menu) await menu.click({ timeout: 3000 }).catch(() => {}); }
      if (Date.now() > until) throw new Error('could not join computer audio in Zoom (nothing would be heard or recorded); Zoom changed?');
      await page.waitForTimeout(500);
    }
    for (const [what, onLabel, offLabel, missing] of [['microphone', LABEL.micOff, LABEL.micOn, TEXT.noMic], ['camera', LABEL.camOff, LABEL.camOn, TEXT.noCamera]]) {
      const r = await ensureOff(page, { what, onLabel, offLabel, missing, text: pageText, state: (p) => this.state(p), stop: TERMINAL, site: 'Zoom' });
      if (TERMINAL.includes(r)) throw new Error(`the meeting ended while switching the ${what} off (${r})`);
    }
  },

  // 'launch' (an app-launch page), 'lobby' (the web client's preview), 'waiting', 'admitted', 'removed', 'ended',
  // 'invalid', 'sign-in', 'captcha' or 'unknown'.
  async state(page) {
    try { if (/\/(?:postattendee|wc\/leave)\b/.test(new URL(page.url()).pathname)) return 'ended'; } catch {}
    const t = await pageText(page).catch(() => '');
    if (TEXT.removed.test(t)) return 'removed';
    if (TEXT.ended.test(t)) return 'ended';
    if (TEXT.invalid.test(t)) return 'invalid';
    if (TEXT.signIn.test(t)) return 'sign-in';
    if (await captchaShown(page)) return 'captcha';
    if (TEXT.waiting.test(t)) return 'waiting';
    // In the call: the toolbar's Leave or participants button (the preview has neither).
    if (await firstVisible(button(page, LABEL.leave)) || await firstVisible(button(page, LABEL.participants))) return 'admitted';
    if (await firstVisible(button(page, LABEL.join))) return 'lobby';
    if (await firstVisible(page.getByRole('link', { name: LABEL.fromBrowser })) || await firstVisible(button(page, LABEL.fromBrowser)) || await firstVisible(button(page, LABEL.launch))) return 'launch';
    return 'unknown';
  },

  async openChat(page) {
    if (await chatBox(page)) return;
    await overlays(page);
    const b = await firstVisible(button(page, LABEL.chat));
    if (!b) throw new Error('no chat button in the Zoom toolbar (chat disabled by the host, or Zoom changed)');
    await b.click({ timeout: 10_000 });
    for (let i = 0; i < 40 && !(await chatBox(page)); i++) await page.waitForTimeout(250);
    if (!(await chatBox(page))) throw new Error('the Zoom chat panel did not open');
  },

  async sendChat(page, text) {
    await this.openChat(page);
    const box = await chatBox(page);
    await box.fill(text, { timeout: 5000 });
    await box.press('Enter', { timeout: 5000 });
  },

  // As meet.mjs: new chat messages are queued in the page under a random, non-enumerable key. Zoom groups consecutive
  // messages of one sender under one name, so a message without a name of its own takes the last one seen above it.
  async watchChat(page, key) {
    await page.evaluate(({ key, MSG, SENDER, ITEM }) => {
      if (window[key]) return;
      const q = [];
      const seen = new Map(); // id -> text queued last
      const scan = () => {
        const all = [...document.querySelectorAll(MSG)];
        const items = all.filter((el) => !all.some((o) => o !== el && el.contains(o))); // innermost
        let last = null;
        const counts = new Map();
        for (const el of items) {
          const item = el.closest(ITEM);
          const named = item?.querySelector(SENDER) || null;
          let sender = named ? (named.innerText || named.textContent || '').trim() : null;
          if (!sender && item?.getAttribute('aria-label')) sender = item.getAttribute('aria-label').split(/ to | an | для /)[0].trim() || null;
          sender = (sender || last || '').replace(/\s+to\s+(?:everyone|alle|всіх|всех).*$/i, '').trim().slice(0, 80) || null;
          last = sender;
          const text = (el.innerText || el.textContent || '').trim().slice(0, 2000);
          // Zoom's message ids where it has them; else sender, text and position among equal messages.
          let id = el.id || el.closest('[id^="chat-message-content"], [data-msg-id], [data-id]')?.id || el.closest('[data-msg-id]')?.getAttribute('data-msg-id') || null;
          if (!id) {
            const k = `${sender}\u0000${text}`;
            counts.set(k, (counts.get(k) || 0) + 1);
            id = `t:${k}\u0000${counts.get(k)}`;
          }
          if (!text || seen.get(id) === text) continue;
          seen.set(id, text);
          if (seen.size > 2000) seen.delete(seen.keys().next().value);
          q.push({ id, sender, text });
          if (q.length > 500) q.shift();
        }
      };
      Object.defineProperty(window, key, { value: { q, scan }, enumerable: false });
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true });
      scan();
    }, { key, MSG: CHAT_MESSAGE, SENDER: CHAT_SENDER, ITEM: CHAT_ITEM });
  },

  async drainChat(page, key) {
    return page.evaluate((key) => {
      const w = window[key];
      if (!w) return null;
      w.scan();
      return w.q.splice(0);
    }, key);
  },

  // The number on the toolbar's participants button ("[3] participants" in its label, or its counter).
  async participants(page) {
    const b = await firstVisible(button(page, LABEL.participants));
    if (!b) return null;
    const label = `${await b.getAttribute('aria-label').catch(() => '') || ''} ${await b.innerText().catch(() => '')}`;
    const n = label.match(/\d+/);
    return n ? Number(n[0]) : null;
  },

  async leave(page) {
    const b = await firstVisible(button(page, LABEL.leave));
    if (!b) return;
    await b.click({ timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 10; i++) {
      const c = await firstVisible(button(page, LABEL.leaveConfirm));
      if (c) { await c.click({ timeout: 3000 }).catch(() => {}); return; }
      await page.waitForTimeout(200);
    }
  },
};

export const _test = { TEXT, LABEL, norm };
