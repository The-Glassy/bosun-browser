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
import { norm, any, pageText as textOutside, visible, button, disabled, firstVisible, dismissOverlays, clickThrough, challengeShown, chatError, setControl, revealToolbar, watchSpeakers, drainSpeakers, DIALOGS, HEADINGS } from './common.mjs';

const SHORTCUT = '(?:[\\s,]*\\(?(?:alt|option|⌥)\\s*\\+\\s*a\\)?)?';
const TEXT = {
  // The waiting room, or a meeting the host has not started yet (Zoom lets you in when it starts).
  waiting: any('please wait,? the meeting host will let you in soon', "we've let them know you're here", 'host has joined', 'wait(?:ing)? for the host to start',
    'waiting for (?:the )?host', '(?:meeting )?host will (?:let you in|admit you)', 'you(?:\'re| are) in the waiting room', 'warten,? bis der host', 'der host lässt sie',
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
  // "This meeting link is invalid (3,001)": an expired or ended meeting's link (Zoom's error 3001).
  invalid: any('invalid meeting id', 'this meeting id is not valid', 'meeting link is invalid', 'invalid meeting link', '\\(3,?001\\)', 'meeting-link ist ungültig', 'meeting id is not valid', 'meeting does not exist', 'incorrect (?:meeting )?passcode', 'passcode (?:is )?(?:wrong|incorrect)',
    'wrong passcode', 'invalid passcode', 'ungültige meeting-id', 'meeting-id ist ungültig', 'falscher kenncode', 'kenncode ist (?:falsch|ungültig)', 'ungültiger kenncode',
    'недійсний ідентифікатор конференції', 'неправильний (?:код доступу|пароль)', 'неверный идентификатор конференции', 'неверный код доступа'),
  signIn: any('sign in to join', 'authorized attendees only', 'only authenticated users can join', 'only signed-in users', 'requires authentication', 'you need to sign in',
    'melden sie sich an,? um (?:an diesem meeting )?teilzunehmen', 'nur (?:für )?autorisierte teilnehmer', 'nur authentifizierte (?:benutzer|teilnehmer)',
    'увійдіть,? щоб приєднатися', 'лише для авторизованих учасників', 'войдите,? чтобы присоединиться', 'только для авторизованных участников'),
  noMic: any('no microphone', 'microphone not found', 'cannot detect (?:your |a )?microphone', 'kein mikrofon', 'mikrofon nicht gefunden', 'мікрофон не знайдено', 'немає мікрофона', 'микрофон не найден'),
  noCamera: any('no camera', 'camera not found', 'cannot detect (?:your |a )?camera', 'video cannot (?:be )?start', 'keine kamera', 'kamera nicht gefunden', 'камеру не знайдено', 'немає камери', 'камера не найдена'),
};
const LABEL = {
  // Preview ("Mute" / "Stop Video") and toolbar ("mute my microphone" / "stop my video") controls; a keyboard shortcut
  // may follow the label ("Mute (Alt+A)", "mute my microphone, Alt+A").
  micOff: any(`^mute(?: my)?(?: microphone| audio)?${SHORTCUT}$`, `^(?:mikrofon )?stummschalten${SHORTCUT}$`, `^вимкнути (?:звук|мікрофон)${SHORTCUT}$`, `^выключить (?:звук|микрофон)${SHORTCUT}$`), // it is on
  micOn: any(`^unmute(?: my)?(?: microphone| audio)?${SHORTCUT}$`, `^stummschaltung aufheben${SHORTCUT}$`, `^увімкнути (?:звук|мікрофон)${SHORTCUT}$`, `^включить (?:звук|микрофон)${SHORTCUT}$`), // it is off
  camOff: any('^stop (?:my )?video$', '^(?:mein )?video (?:beenden|stoppen)$', '^зупинити відео$', '^вимкнути відео$', '^остановить видео$'),
  camOn: any('^start (?:my )?video$', '^(?:mein )?video starten$', '^почати відео$', '^увімкнути відео$', '^включить видео$', '^начать видео$'),
  join: any('^join$', '^join meeting$', '^join webinar$', '^beitreten$', '^meeting beitreten$', '^приєднатися$', '^присоединиться$'),
  // Computer audio is what makes the meeting audible (and recordable).
  joinAudio: any('^join audio by computer$', '^join with computer audio$', '^computer audio$', '^per computer (?:dem )?audio beitreten$', '^mit computeraudio beitreten$', '^computer-?audio beitreten$',
    "^приєднатися до аудіо (?:з|через) комп'ютер(?:а)?$", "^аудіо комп'ютера$", '^войти с использованием звука компьютера$', '^звук компьютера$'),
  audioMenu: any('^join audio$', '^audio beitreten$', '^приєднатися до аудіо$', '^войти в аудиоконференцию$'),
  // Computer audio already connected without a microphone (live Zoom, 2026-10-23 15:00): the toolbar shows "Audio"
  // (no Mute/Unmute, no Join Audio) next to "More audio controls", whose menu offers leaving computer audio or
  // switching to phone audio. That menu is read, never clicked in.
  audioMore: any('^more audio controls$', '^weitere audio-?steuerelemente$', '^weitere audiooptionen$', '^більше (?:елементів керування|параметрів) аудіо$', '^другие (?:элементы управления|параметры) звук(?:ом|а)$'),
  audioConnected: any('^leave computer audio\\b', '^switch to phone audio\\b', '^computer-?audio verlassen\\b', '^zu telefon-?audio wechseln\\b',
    "^вийти з аудіо комп'ютера", '^перейти на (?:аудіо|звук) телефону', '^выйти из звука компьютера', '^переключиться на звук телефона'),
  chat: any('^open the chat pane(?:l)?$', '^chat$', '^open chat$', '^chat öffnen$', '^chatbereich öffnen$', '^відкрити (?:панель )?чат(?:у)?$', '^чат$', '^открыть (?:панель )?чат(?:а)?$'),
  chatInput: any('type message', 'chat message', 'message to', 'nachricht', 'повідомлення', 'сообщение'),
  participants: any('participants?\\b', 'particpants', 'teilnehmer', 'учасник', 'участник'),
  leave: any('^leave$', '^leave meeting$', '^verlassen$', '^meeting verlassen$', '^вийти$', '^вийти з конференції$', '^покинути конференцію$', '^выйти$', '^выйти из конференции$'),
  leaveConfirm: any('^leave meeting$', '^meeting verlassen$', '^вийти з конференції$', '^покинути конференцію$', '^выйти из конференции$'),
  // Zoom asking for the microphone ("Do you want people to hear you…?"), answered yes only when the agent unmutes to speak.
  useMic: any('^use microphone$', '^mikrofon verwenden$', '^mikrofon benutzen$', '^використовувати мікрофон$', '^использовать микрофон$'),
  // The raised hand sits in the toolbar's "Reactions" menu (or under "More" in a narrow window).
  handDown: any('^raise hand$', '^hand heben$', '^підняти руку$', '^поднять руку$'), // the hand is down
  handUp: any('^lower hand$', '^hand senken$', '^опустити руку$', '^опустить руку$'), // the hand is up
  reactions: any('^reactions?$', '^react$', '^reaktionen$', '^реакції$', '^реакции$', '^more$', '^mehr$', '^більше$', '^ещё$', '^еще$'),
  launch: any('^launch meeting$', '^meeting (?:starten|eröffnen)$', '^запустити конференцію$', '^запустить конференцию$'),
  fromBrowser: any('join from (?:your|the) browser', '(?:über|vom|mit) (?:ihrem |dem )?browser (?:aus )?(?:beitreten|teilnehmen)', 'приєднатися (?:з|через) браузер', 'войти из браузера', 'присоединиться из браузера'),
  // The web client's device questions, "Do you want people to see you in the meeting?" and "Do you want people to hear
  // you in the meeting?": answered without devices ("Use microphone…" is never clicked).
  noDevices: any('^continue without (?:microphone and camera|microphone or camera|audio (?:and|or) video|microphone|camera)$',
    '^ohne (?:mikrofon und kamera|mikrofon|kamera) (?:fortfahren|weiter)$', '^weiter ohne (?:mikrofon und kamera|mikrofon|kamera)$',
    '^продовжити без (?:мікрофона(?: (?:й|і|та) камери)?|камери)$', '^продолжить без (?:микрофона(?: и камеры)?|камеры)$'),
  // Closes what Zoom lays over the page: tips, the cookie banner, "this meeting is being recorded", app prompts.
  dismiss: any('^got it$', '^ok$', '^close$', '^dismiss$', '^not now$', '^no thanks$', '^maybe later$', '^continue$', '^accept(?: all)? cookies$', '^i agree$', '^agree$',
    '^verstanden$', '^schließen$', '^nicht jetzt$', '^nein danke$', '^später$', '^fortfahren$', '^weiter$', '^(?:alle )?cookies akzeptieren$', '^ich stimme zu$', '^zustimmen$',
    '^зрозуміло$', '^закрити$', '^не зараз$', '^ні, дякую$', '^продовжити$', '^прийняти (?:усі )?файли cookie$', '^погоджуюся$', '^понятно$', '^закрыть$', '^не сейчас$', '^продолжить$'),
};
// #inputname: Zoom's classic web client (/wc/join/<id>), which some guests are still sent to.
const NAME_FIELD = 'input#input-for-name, input#inputname, input[aria-label="Your Name" i], input[placeholder="Your Name" i], input[aria-label="Ihr Name" i], input[placeholder="Ihr Name" i], input[aria-label^="Ваше ім" i], input[placeholder^="Ваше ім" i]';
const PASSCODE_FIELD = 'input#input-for-pwd, input[aria-label*="passcode" i], input[placeholder*="passcode" i], input[aria-label*="kenncode" i], input[placeholder*="kenncode" i]';
// The chat's recipient ("To: Everyone" / a person / "Host and co-hosts") and its Send button.
const CHAT_RECIPIENT = '[class*="receiver-list__receiver"], [class*="chat-receiver"] button, [class*="chat-to"] button, button[aria-label^="send to" i], button[aria-label^="chat with" i]';
// Zoom's own label for the public recipient, exactly (a participant named "Everyone Else" is not it). "Meeting Group
// Chat": a meeting with continuous meeting chat (live Zoom, 2026-10-26) posts to everyone through the meeting's group chat.
const EVERYONE = /^(?:to:?\s*)?(?:everyone|everyone in (?:the )?meeting|meeting group chat|alle|alle im meeting|jeder|meeting-gruppenchat|всі|усі|всім|усім|всі учасники|все|всем|все участники)$/i;
// Zoom's label for the host (and co-hosts) as one recipient, exactly: where the host allows chat with the host only.
const HOSTS = /^(?:to:?\s*)?(?:(?:the )?hosts? (?:and|&) co-?hosts?|host|hosts? und co-?hosts?|організатор(?:и)? (?:і|й|та) співорганізатор(?:и|ам)?|организатор(?:ы)? и соорганизатор(?:ы|ам)?)$/i;
// The recipient in a message's sender line ("Glassy Smartie to Host and co-hosts 10:07 AM"): everyone or the host group.
const TO_GROUP = '\\s+(?:to|an|для)\\s+(?:everyone|meeting group chat|alle|meeting-gruppenchat|всіх|всех|(?:the )?hosts? (?:and|&) co-?hosts?|host|hosts? und co-?hosts?|організатор\\S* (?:і|й|та) співорганізатор\\S*|организатор\\S* и соорганизатор\\S*)(?![\\p{L}\\p{N}]).*$';
// How Zoom marks a message that went to one person only.
const PRIVATELY = any('\\(privately\\)', 'direct message', '\\(privat\\)', 'direktnachricht', 'приватно', 'особисто', 'лично');
const SEND = any('^send$', '^send message$', '^senden$', '^nachricht senden$', '^надіслати$', '^отправить$');
const CHAT_INPUT = '.chat-box__chat-textarea, textarea[class*="chat"], [contenteditable="true"][class*="chat"], .tiptap[contenteditable="true"], [contenteditable="true"][data-placeholder*="message" i], textarea[placeholder*="message" i]';
// One chat message's text (innermost match wins), and the item it belongs to with the sender's name.
const CHAT_MESSAGE = '[id^="chat-message-content"], .new-chat-message__container, .chat-message__container, [class*="chat-message__text"]';
const CHAT_SENDER = '.chat-item__sender, [class*="chat-item__sender"], [class*="chat-message__sender"]';
const CHAT_ITEM = '.chat-item-container, [class*="chat-item__container"], [class*="chat-item-container"], [role="listitem"]';

// What participants control: the chat and its input, names on video tiles and in the participants list.
const PARTICIPANT_CONTROLLED = '[class*="chat"], [class*="participants-item"], [class*="participants-li"], [class*="video-avatar__avatar-name"], [class*="name-tag"], [class*="avatar-name"], [role="list"], [role="listitem"], textarea, input, [contenteditable="true"]';
const pageText = (page, roots) => textOutside(page, PARTICIPANT_CONTROLLED, roots);
const MODALS = `${DIALOGS}, [class*="zm-modal"], [class*="modal-dialog"]`;
// The device question is answered wherever it shows up (Zoom does not always mark it as a dialog); everything else
// only inside a dialog or banner.
const overlays = async (page) => {
  const nd = await firstVisible(button(page, LABEL.noDevices));
  const n = nd ? await nd.click({ timeout: 2000 }).then(() => 1, () => 0) : 0;
  return n + await dismissOverlays(page, LABEL.dismiss, ['#onetrust-banner-sdk', '[class*="zm-modal"]', '[class*="modal-dialog"]']) + await closeToasts(page);
};

// Notices the call shows outside any dialog (live Zoom, 2026-10-23): "Introducing My Notes…" (Got it), "For a better
// meeting experience, enable … hardware acceleration" (×), "Please enable access to your microphone and camera for
// the best experience." (×). Each is closed by a close or "Got it" button of its own, found from the notice's text
// (the nearest box around it, up to a short notice's size). Nothing participants control or say counts: not as the
// notice's text, and no box holding any of it (chat, names, captions) is searched for the button.
const TOAST = any('^introducing my notes', 'enable (?:browser |the )?hardware acceleration', 'enable access to your microphone and camera',
  'hardwarebeschleunigung', 'zugriff auf (?:ihr|dein) mikrofon und (?:ihre|deine) kamera', 'апаратне прискорення', 'аппаратное ускорение');
const TOAST_CLOSE = any('^got it$', '^close$', '^dismiss$', '^x$', '^×$', '^✕$', '^verstanden$', '^schließen$', '^зрозуміло$', '^закрити$', '^понятно$', '^закрыть$');
const SPOKEN = `${PARTICIPANT_CONTROLLED}, [class*="subtitle"], [class*="caption"], [class*="transcript"]`;
async function closeToasts(page) {
  const found = await page.evaluateHandle(({ toast, close, skip }) => {
    const T = new RegExp(toast, 'i'), C = new RegExp(close, 'i');
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const shown = (e) => (e.checkVisibility ? e.checkVisibility() : !!e.offsetParent);
    const out = new Set();
    const walk = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(), i = 0; t && i < 5000; t = walk.nextNode(), i++) {
      const el = t.parentElement;
      if (!el || !T.test(n(el.innerText || t.nodeValue)) || el.closest(skip) || !shown(el)) continue;
      for (let box = el, up = 0; box && box !== document.body && up < 6 && n(box.innerText).length < 400 && !box.querySelector(skip); box = box.parentElement, up++) {
        const b = [...box.querySelectorAll('button, [role="button"]')].find((b) => shown(b) && !b.closest(skip)
          && (C.test(n(b.getAttribute('aria-label') || b.innerText || b.title)) || (!n(b.getAttribute('aria-label') || b.innerText) && /close/i.test(b.className))));
        if (b) { out.add(b); break; }
      }
    }
    return [...out];
  }, { toast: TOAST.source, close: TOAST_CLOSE.source, skip: SPOKEN }).catch(() => null);
  if (!found) return 0;
  let n = 0;
  for (const h of (await found.getProperties().catch(() => new Map())).values()) {
    const el = h.asElement();
    if (el && await el.click({ timeout: 2000 }).then(() => true, () => false)) n++;
  }
  await found.dispose().catch(() => {});
  return n;
}

// Whether "More audio controls" offers leaving computer audio (or switching to phone audio): then computer audio is
// connected. The menu is opened, read and closed again (Escape, or its button once more); nothing in it is clicked.
// Only an entry of that menu counts: one outside what participants control, in a menu (or the element the button
// names in aria-controls) that itself was not shown before the click, that came up with the click and went away when
// the menu closed. A participant named "Leave computer audio" in another menu or list, already open or renamed
// meanwhile, is none of that. Shown means rendered, visible and not transparent (a closed menu may stay in the page,
// hidden by visibility or opacity).
const AUDIO_MENU = '[role="menu"], [role="listbox"], [class*="menu" i], [class*="popover" i], [class*="dropdown" i]';
// mode 'menus': the menus shown now; else the audio entries shown now whose menu is not among `prev`.
function menuEntries([prev, { re, menu, skip, owner, mode }]) {
  const R = new RegExp(re, 'i');
  const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const shown = (e) => (e.checkVisibility ? e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : !!e.offsetParent);
  if (mode === 'menus') return [...document.querySelectorAll(menu)].filter(shown);
  const scope = owner && document.getElementById(owner);
  return [...(scope || document).querySelectorAll('*')].filter((e) => {
    const box = e.parentElement?.closest(menu); // the menu the entry sits in (not the entry itself)
    return box && !(prev || []).includes(box) && !e.closest(skip) && shown(e)
      && (R.test(n(e.getAttribute('aria-label'))) || ([...e.children].every((c) => !R.test(n(c.innerText))) && R.test(n(e.innerText))));
  });
}
async function audioConnected(page) {
  const more = await firstVisible(button(page, LABEL.audioMore));
  if (!more) return false;
  const a = { re: LABEL.audioConnected.source, menu: AUDIO_MENU, skip: SPOKEN, owner: (await more.getAttribute('aria-controls').catch(() => null)) || (await more.getAttribute('aria-owns').catch(() => null)) };
  const before = await page.evaluateHandle(menuEntries, [null, { ...a, mode: 'menus' }]).catch(() => null);
  if (!before || !(await more.click({ timeout: 3000 }).then(() => true, () => false))) { await before?.dispose().catch(() => {}); return false; }
  let came = null;
  for (let i = 0; i < 10; i++) {
    came = await page.evaluateHandle(menuEntries, [before, a]).catch(() => null);
    if (came && await came.evaluate((l) => l.length).catch(() => 0)) break;
    await came?.dispose().catch(() => {});
    came = null;
    await page.waitForTimeout(150);
  }
  const shownNow = () => (came ? came.evaluate((l) => l.some((e) => (e.checkVisibility ? e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : !!e.offsetParent))).catch(() => true) : false);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(200);
  if (await shownNow()) { await more.click({ timeout: 3000 }).catch(() => {}); await page.waitForTimeout(200); }
  const yes = !!came && !(await shownNow());
  await came?.dispose().catch(() => {});
  await before.dispose().catch(() => {});
  return yes;
}
// The toolbar's audio controls as labelled, for the error when computer audio can't be joined.
async function audioControls(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, [role="button"]')]
    .filter((b) => (b.checkVisibility ? b.checkVisibility() : !!b.offsetParent))
    .map((b) => (b.getAttribute('aria-label') || b.innerText || '').replace(/\s+/g, ' ').trim())
    .filter((l) => /audio|mute|micro|mikro|мікро|микро|звук/i.test(l)).slice(0, 8)).catch(() => []);
}
const TERMINAL = ['denied', 'ended', 'removed', 'invalid', 'sign-in', 'captcha'];
// Words in the page that are not Zoom's status: the meeting's title, captions and transcript, names on video tiles.
const NOT_STATUS = '[class*="topic"], [class*="meeting-info"], [class*="subtitle"], [class*="caption"], [class*="transcript"], [class*="avatar-footer"], [class*="video-avatar"]';
// The call's audio controls; the preview has look-alikes ("Mute"), so they count only where no Join button or name
// field is shown.
const IN_CALL_AUDIO = new RegExp([LABEL.micOff, LABEL.micOn, LABEL.joinAudio, LABEL.audioMenu].map((r) => r.source).join('|'), 'i');

// The call's microphone control read from the page itself, also where Playwright doesn't count it as a visible button:
// a toolbar faded out (or hidden by visibility), a control that is a <div> with an aria-label (live Zoom has had both
// kinds), or Zoom's audio button by its class. Only in the toolbar: never a control in the participants list or the
// chat. Returns {state: 'on'|'off'|null, label, kind, clicked} (the first labelled match); with want ('on'|'off'):
// clicks it in the page (element.click(), which reaches a control under a faded toolbar where a mouse click would not)
// only if it shows the other state at that very moment (read and click in one go: a microphone muted meanwhile by the
// host is never clicked back on).
const MIC_SCOPE = 'footer, [class*="footer"], [class*="toolbar"], [class*="join-audio-container"], [id*="audio" i]';
const MIC_EL = 'button, [role="button"], [aria-label], .join-audio-container__btn';
function readMic([{ on, off, scope, el, skip }, want, how = 'click']) {
  const ON = new RegExp(on, 'i'), OFF = new RegExp(off, 'i');
  const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  for (const e of document.querySelectorAll(el)) {
    if (e.closest(skip) || !(e.closest(scope) || e.matches('.join-audio-container__btn'))) continue;
    const label = n(e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText);
    const state = ON.test(label) ? 'on' : OFF.test(label) ? 'off' : null;
    if (!state) continue;
    const click = !!want && state !== want;
    if (click && how === 'key') { // Zoom's shortcut, sent to the page with nothing focused (not to the chat box)
      document.activeElement?.blur?.();
      for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { key: 'a', code: 'KeyA', altKey: true, bubbles: true, cancelable: true }));
    } else if (click) (e.closest('button, [role="button"]') || e).click();
    return { state, label: label.slice(0, 60), kind: e.tagName.toLowerCase(), clicked: click };
  }
  return { state: null, label: null, kind: null, clicked: false };
}
const MIC_ARGS = { on: LABEL.micOff.source, off: LABEL.micOn.source, scope: MIC_SCOPE, el: MIC_EL, skip: '[class*="participants-item"], [class*="participants-li"], [class*="chat"], [role="list"], [role="listitem"]' };
const micInPage = (page, want = null, how = 'click') => page.evaluate(readMic, [MIC_ARGS, want, how]).catch(() => ({ state: null, label: null, kind: null, clicked: false }));
async function micSettles(page, want, ms) {
  for (const until = Date.now() + ms; Date.now() < until; await page.waitForTimeout(150)) if ((await micInPage(page)).state === want) return true;
  return false;
}

// When the toolbar's control can't be worked with Playwright's own clicks: the control as the page has it, clicked in
// the page; then Zoom's shortcut Alt+A (with nothing focused, so it reaches Zoom and not the chat box): first sent in
// the page in the same step that reads the state, then pressed for real (Zoom may ignore a scripted key) right after
// reading it again. Each only while the page shows the microphone in the other state, and checked after. {state,
// changed, via} once it is as wanted; else {state (what the page shows, or null), clicked}. Nothing is pressed blind: a
// shortcut toggles. The real key press is the one step that can't be tied to the read (a host muting Bosun in the
// milliseconds between them would be undone; the next check sees it and tries again).
async function micFallback(page, on) {
  const want = on ? 'on' : 'off';
  let seen = await micInPage(page);
  if (seen.state === want) return { state: want, changed: false, via: 'page' };
  let clicked = false;
  if (seen.state) {
    await revealToolbar(page);
    seen = await micInPage(page, want); // clicks only if it still shows the other state
    if (seen.state === want) return { state: want, changed: clicked, via: 'page' };
    clicked ||= seen.clicked;
    if (await micSettles(page, want, 1000)) return { state: want, changed: true, via: 'page' };
    seen = await micInPage(page);
  }
  if (seen.state && seen.state !== want) {
    seen = await micInPage(page, want, 'key');
    clicked ||= seen.clicked;
    if (seen.state === want) return { state: want, changed: clicked, via: 'page' };
    if (await micSettles(page, want, 700)) return { state: want, changed: true, via: 'alt+a' };
    seen = await micInPage(page);
  }
  if (seen.state && seen.state !== want) {
    await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
    if ((await micInPage(page)).state === (want === 'on' ? 'off' : 'on')) {
      await page.keyboard.press('Alt+A').catch(() => {});
      clicked = true;
      if (await micSettles(page, want, 1000)) return { state: want, changed: true, via: 'alt+a' };
    }
    seen = await micInPage(page);
  }
  return { state: seen.state, label: seen.label, clicked };
}

// A device question shown: answered "Continue without …". null if none is shown, else the question's text (its dialog,
// or the nearest box around the answer with more text than it) and whether the answer took (clicked, and gone).
async function declineDevices(page) {
  const b = await firstVisible(button(page, LABEL.noDevices));
  if (!b) return null;
  const text = norm(await b.evaluate((el) => {
    const own = (el.innerText || '').length;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.matches('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') || (n.innerText || '').length > own + 30) return n.innerText || '';
    }
    return '';
  }).catch(() => ''));
  const ok = await b.click({ timeout: 2000 }).then(() => true, () => false) && !(await b.isVisible().catch(() => false));
  return { text, ok };
}
// Which device a question asks for, by the question, not by its answers ("Do you want people to see you…?" offers
// "Continue without microphone and camera" too): hearing is the microphone, seeing the camera.
const ASKS = {
  audioinput: any('\\bhear you\\b', 'sie hören', 'dich hören', 'вас (?:чули|чути)', 'вас слышали', 'вас слышать'),
  videoinput: any('\\bsee you\\b', 'sie sehen', 'dich sehen', 'вас (?:бачили|бачити)', 'вас видели', 'вас видеть'),
};

// What the browser could capture (meetings run in Chromium only): how many microphones or cameras it lists (Chromium
// lists one, unnamed, per kind before permission is given, none when there is none) and the permission state; null
// where it can't tell.
async function devices(page, kind) {
  return page.evaluate(async (kind) => {
    const out = { count: null, permission: null };
    try { out.count = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind).length; } catch {}
    try { out.permission = (await navigator.permissions.query({ name: kind === 'audioinput' ? 'microphone' : 'camera' })).state; } catch {}
    return out;
  }, kind).catch(() => ({ count: null, permission: null }));
}

// dry_run: a device as Bosun sees it, nothing clicked: its control's label (a microphone Zoom never got also shows
// "Mute"), how many the browser lists and the permission.
async function seen(page, kind, onLabel, offLabel, list = devices) {
  const c = await firstVisible(button(page, onLabel)) || await firstVisible(button(page, offLabel));
  const control = c ? ((await c.getAttribute('aria-label').catch(() => null)) || (await c.innerText().catch(() => '')).trim()) : null;
  const d = await list(page, kind);
  return { control, devices: d.count, permission: d.permission };
}

// Microphone or camera verifiably off in Zoom (preview or call). Off: its control shows "turn on"; the browser has no
// such device or its permission is denied; or clicking the control made Zoom ask for the device (a microphone Zoom
// never got shows "Mute" with a crossed icon, and clicking it asks "Do you want people to hear you…?" instead of
// muting): the question is answered without it. Only a question asking for this device, coming up within 3 s of a click
// that took (none was shown when it was clicked), and answered, counts, and it has to happen twice in a row: Zoom's own
// first questions can come late and just after a click. A control that shows the device on, takes clicks and neither turns
// off nor asks is a live device: not joining (throws). Without a control, the page saying the device is missing will
// do. The permission state "prompt" is not taken as off: Bosun's browsers grant capture on request.
async function deviceOff(page, { what, kind, onLabel, offLabel, missing, state, list = devices, when = 'before joining', then = 'not joining', timeoutMs = 15_000 }) {
  const until = Date.now() + timeoutMs;
  let clicked = 0; // when the control last took a click
  let asked = 0; // clicks in a row that made Zoom ask for the device
  for (;;) {
    if (Date.now() > until) throw new Error(`could not make sure the ${what} is off ${when} (Zoom changed?); ${then}`);
    const q = await declineDevices(page);
    if (q) {
      if (q.ok && clicked && Date.now() - clicked < 3000 && ASKS[kind].test(q.text)) {
        if (++asked >= 2) return 'not in use';
        clicked = 0; // asked once: click again
      }
      await page.waitForTimeout(300);
      continue;
    }
    if (await visible(button(page, offLabel))) return 'off';
    const st = await state(page);
    if (TERMINAL.includes(st)) return st;
    const d = await list(page, kind);
    if (d.count === 0) return 'no device';
    if (d.permission === 'denied') return 'no permission';
    const on = await firstVisible(button(page, onLabel));
    if (!on && missing.test(await pageText(page).catch(() => ''))) return 'no device';
    // One click, then time for Zoom to toggle it or ask (a second click could turn a just-muted microphone back on).
    if (on && Date.now() - clicked > 2000 && !(await disabled(on))) {
      if (clicked) asked = 0; // the last click brought no question
      clicked = await on.click({ timeout: 3000 }).then(() => Date.now(), () => clicked);
    }
    await page.waitForTimeout(300);
  }
}

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

// A challenge Zoom shows before joining: a visible reCAPTCHA/hCaptcha frame. The web client is "protected by
// reCAPTCHA" (an invisible widget and a notice under the Join button): that is not a challenge (common.mjs).
const captchaShown = challengeShown;

// An app-launch page: "Join from your browser" if it is there, else "Launch Meeting" (which reveals it).
async function followLaunch(page) {
  const link = await firstVisible(page.getByRole('link', { name: LABEL.fromBrowser })) || await firstVisible(button(page, LABEL.fromBrowser));
  if (link) return link.click({ timeout: 5000 }).catch(() => {});
  const l = await firstVisible(button(page, LABEL.launch));
  if (l) await l.click({ timeout: 3000 }).catch(() => {});
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

  // Where a signed-in session is visible: 200 when signed in, a redirect to the sign-in page when not.
  accountUrl: 'https://zoom.us/profile',

  matches: (url) => parseZoomUrl(url) !== null,

  // Whether the browser's Zoom session is signed in: true, false, or null (could not tell). Asked with the context's
  // own cookies, outside the page.
  async signedIn(page) {
    try {
      const r = await page.context().request.get(this.accountUrl, { maxRedirects: 0, timeout: 15_000, failOnStatusCode: false });
      if (r.status() === 200) return !/\/signin\b/.test(r.url());
      if (r.status() >= 300 && r.status() < 400) return !/signin|login/i.test(r.headers().location || '');
      return null;
    } catch { return null; }
  },
  joinUrl: zoomWebClientUrl,
  origins: (url) => ['https://app.zoom.us', new URL(url).origin],
  // The microphones or cameras the browser lists, and the permission (see devices()). A method so a test can stand
  // in for a host without devices on any engine (patchright reads the page from a world of its own).
  devices: (page, kind) => devices(page, kind),

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
      if (s === 'launch') await followLaunch(page);
      if (Date.now() > end) throw new Error(`no "Join" button found on the Zoom page (not Zoom's web client, or Zoom changed); page ${s}`);
      await overlays(page);
      await page.waitForTimeout(500);
    }
    // Zoom asks "see you" first and "hear you" next: both answered, and the microphone and camera made sure off,
    // before the name is typed (a question coming up takes the keyboard).
    for (let quiet = 0, t = Date.now() + 5000; quiet < 3 && Date.now() < t; await page.waitForTimeout(300)) quiet = (await overlays(page)) ? 0 : quiet + 1;
    // In the preview, "Join Audio" (no audio connected yet) also means nothing goes out.
    const micOffOrNoAudio = new RegExp(`${LABEL.micOn.source}|${LABEL.audioMenu.source}`, 'i');
    for (const [what, kind, onLabel, offLabel, missing] of [['microphone', 'audioinput', LABEL.micOff, micOffOrNoAudio, TEXT.noMic], ['camera', 'videoinput', LABEL.camOff, LABEL.camOn, TEXT.noCamera]]) {
      const r = await deviceOff(page, { what, kind, onLabel, offLabel, missing, state: (p) => this.state(p), list: (p, k) => this.devices(p, k) });
      if (TERMINAL.includes(r)) return r;
    }
    // A profile that is no longer signed in to Zoom joins as a guest (and is said to be signed out).
    if (profile) info.signedIn = await this.signedIn(page);
    // Signed in: Zoom fills in the account's name, which is kept; otherwise (or with an empty field, which the web
    // client also shows signed-in accounts) `name`.
    const field = await firstVisible(page.locator(NAME_FIELD));
    const prefilled = field ? (await field.inputValue().catch(() => '')).trim() : '';
    // A remembered name in a signed-out profile is a guest name from earlier: replaced too.
    if (field && !(profile && prefilled && info.signedIn !== false)) {
      await field.fill(name, { timeout: 5000 });
      // The web client enables Join only on typed input; a fill it did not take is typed key by key.
      const j = await firstVisible(button(page, LABEL.join));
      await page.waitForTimeout(300);
      if (j && await disabled(j)) { await field.fill('', { timeout: 3000 }).catch(() => {}); await field.pressSequentially(name, { delay: 25, timeout: 10_000 }).catch(() => {}); }
    }
    // Signed in by Zoom's own account page; without that answer, by the prefilled name.
    info.joinedAs = profile && (info.signedIn === true || (info.signedIn === null && (!field || prefilled))) ? 'account' : 'guest';
    info.selfName = field ? (await field.inputValue().catch(() => name)).trim() : null;
    if (info.signedIn === false) info.warning = `profile ${profile} is not signed in to Zoom any more: joined as a guest named "${info.selfName || name}" (Zoom may turn a guest away). Sign it in again: session_open({profile: "${profile}"}), navigate https://zoom.us/signin, request_human, session_close.`;
    // The passcode comes with the link (pwd, an encrypted token, not the passcode people type). A page that still
    // asks for it stops the join: the token typed into the field would only be refused.
    const pass = await firstVisible(page.locator(PASSCODE_FIELD));
    if (pass && !(await pass.inputValue().catch(() => ''))) {
      info.error = url && parseZoomUrl(url)?.pwd
        ? 'Zoom asks for the meeting passcode although the link carries one (pwd); the link may be outdated: ask for a fresh invitation link.'
        : 'Zoom asks for the meeting passcode: use the invitation link with ?pwd=…, as Zoom sends it.';
      return 'invalid';
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

  // dry_run: the preview as Bosun sees it, without joining: what it would click and what stands in the way. Only the
  // cookie banner, tips and the device question are answered; nothing is typed and Join is not clicked.
  async inspect(page, { profile = null, timeoutMs = 30_000 } = {}) {
    const end = Date.now() + timeoutMs;
    let s;
    for (;;) {
      await overlays(page);
      s = await this.state(page);
      if ((s !== 'unknown' && s !== 'launch') || Date.now() > end) break;
      if (s === 'launch') await followLaunch(page);
      await page.waitForTimeout(500);
    }
    const field = await firstVisible(page.locator(NAME_FIELD));
    const join = await firstVisible(button(page, LABEL.join));
    return {
      state: s,
      join_button: join ? ((await join.getAttribute('aria-label').catch(() => null)) || (await join.innerText().catch(() => '')).trim()) : null,
      join_enabled: join ? !(await disabled(join)) : null,
      name_field: field ? { prefilled: (await field.inputValue().catch(() => '')).trim() || null } : null,
      passcode_asked: !!(await firstVisible(page.locator(PASSCODE_FIELD))),
      microphone: await seen(page, 'audioinput', LABEL.micOff, LABEL.micOn, (p, k) => this.devices(p, k)),
      camera: await seen(page, 'videoinput', LABEL.camOff, LABEL.camOn, (p, k) => this.devices(p, k)),
      challenge: await challengeShown(page),
      ...(profile ? { profile_signed_in: await this.signedIn(page) } : {}),
    };
  },

  // Once in: computer audio joined (without it nothing is heard or recorded), microphone and camera verifiably off.
  // Zoom may connect audio with the microphone live; it is muted the moment the control shows up (the browser's
  // microphone is a silent source anyway, so nothing but silence can go out meanwhile). Let in without a microphone,
  // Zoom connects computer audio by itself and shows "Audio" instead: its menu says so ("Leave computer audio").
  async afterAdmit(page) {
    const until = Date.now() + 20_000;
    for (let menuAt = 0; ; ) {
      await overlays(page);
      const live = await firstVisible(button(page, LABEL.micOff));
      if (live) { await live.click({ timeout: 3000 }).catch(() => {}); break; }
      if (await visible(button(page, LABEL.micOn))) break; // audio connected, muted
      const comp = await firstVisible(button(page, LABEL.joinAudio));
      const menu = comp ? null : await firstVisible(button(page, LABEL.audioMenu));
      if (comp || menu) await (comp || menu).click({ timeout: 3000 }).catch(() => {});
      else if (Date.now() - menuAt > 2000) { // the menu is read every 2 s at most
        if (await audioConnected(page)) break;
        menuAt = Date.now();
      }
      if (Date.now() > until) {
        const seen = await audioControls(page);
        throw new Error(`could not join computer audio in Zoom (nothing would be heard or recorded); Zoom changed? (audio controls: ${seen.length ? seen.join(', ') : 'none'})`);
      }
      await page.waitForTimeout(500);
    }
    for (const [what, kind, onLabel, offLabel, missing] of [['microphone', 'audioinput', LABEL.micOff, LABEL.micOn, TEXT.noMic], ['camera', 'videoinput', LABEL.camOff, LABEL.camOn, TEXT.noCamera]]) {
      const r = await deviceOff(page, { what, kind, onLabel, offLabel, missing, state: (p) => this.state(p), list: (p, k) => this.devices(p, k), when: 'in the meeting', then: 'leaving' });
      if (TERMINAL.includes(r)) throw new Error(`the meeting ended while switching the ${what} off (${r})`);
    }
  },

  // 'launch' (an app-launch page), 'lobby' (the web client's preview), 'waiting', 'admitted', 'removed', 'ended',
  // 'invalid', 'sign-in', 'captcha' or 'unknown'.
  // admitted: the manager knows Bosun got in. From then on only Zoom's dialogs (and, with the toolbar faded out,
  // headings) can say the meeting ended or Bosun was removed: captions and the meeting title ("Waiting room
  // redesign") are participants' words. Before that, the whole page counts.
  async state(page, { admitted = false } = {}) {
    try { if (/\/(?:postattendee|wc\/leave)\b/.test(new URL(page.url()).pathname)) return 'ended'; } catch {}
    // Before admission, the waiting room's own words (outside what participants control, the meeting's title and
    // captions) keep it waiting whatever else is shown: live Zoom (2026-10-28) let a guest sit 44 min in the waiting
    // room while Bosun took it for admitted (its chat with the host). Seen in: the call's toolbar with a control only
    // the call has: the participants button or the microphone/audio control. A chat button or "Leave" alone is not
    // (the waiting room can have both).
    if (!admitted && TEXT.waiting.test(await textOutside(page, `${PARTICIPANT_CONTROLLED}, ${NOT_STATUS}`).catch(() => ''))) return 'waiting';
    const preview = async () => await firstVisible(button(page, LABEL.join)) || firstVisible(page.locator(NAME_FIELD));
    const inCall = await firstVisible(button(page, LABEL.participants)) || (await firstVisible(button(page, IN_CALL_AUDIO)) && !(await preview()))
      || (admitted && await firstVisible(button(page, LABEL.chat)));
    const t = await pageText(page, inCall ? MODALS : admitted ? `${MODALS}, ${HEADINGS}` : null).catch(() => '');
    if (TEXT.removed.test(t)) return 'removed';
    if (TEXT.ended.test(t)) return 'ended';
    if (inCall || admitted) return 'admitted';
    if (TEXT.invalid.test(t)) return 'invalid';
    if (TEXT.signIn.test(t)) return 'sign-in';
    if (await captchaShown(page)) return 'captcha';
    if (TEXT.waiting.test(t)) return 'waiting';
    if (await firstVisible(button(page, LABEL.join))) return 'lobby';
    if (await firstVisible(page.getByRole('link', { name: LABEL.fromBrowser })) || await firstVisible(button(page, LABEL.fromBrowser)) || await firstVisible(button(page, LABEL.launch))) return 'launch';
    return 'unknown';
  },

  async openChat(page) {
    if (await chatBox(page)) return;
    await overlays(page);
    const b = await firstVisible(button(page, LABEL.chat));
    if (!b) throw chatError('chat-unavailable', 'no chat button in the Zoom toolbar (chat disabled by the host, or Zoom changed)');
    await b.click({ timeout: 10_000 });
    for (let i = 0; i < 40 && !(await chatBox(page)); i++) await page.waitForTimeout(250);
    if (!(await chatBox(page))) throw chatError('chat-unavailable', 'the Zoom chat panel did not open');
  },

  // The chat goes to `to`: 'everyone', or 'host' (Zoom's "Host and co-hosts"). A recipient control showing someone
  // else is switched (its menu opened, unless it is open already), or the message is not sent. Without a recipient
  // control the chat goes to everyone only: fine for everyone, and no way to write to the host alone.
  async recipient(page, to = 'everyone') {
    const want = to === 'host' ? HOSTS : EVERYONE;
    const r = await firstVisible(page.locator(CHAT_RECIPIENT));
    if (!r) {
      if (to === 'host') throw chatError('host-unreachable', 'the Zoom chat has no recipient control: no way to write to the host alone');
      return;
    }
    const label = async () => norm(await r.innerText().catch(() => '')).trim();
    if (want.test(await label())) return;
    const option = async () => await firstVisible(page.getByRole('menuitem', { name: want })) || await firstVisible(page.getByRole('option', { name: want }))
      || firstVisible(page.getByRole('menuitemradio', { name: want }));
    let opt = await option();
    if (!opt) {
      await r.click({ timeout: 3000 }).catch(() => {});
      for (let i = 0; i < 5 && !(opt = await option()); i++) await page.waitForTimeout(200);
    }
    if (opt) await opt.click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(200);
    const now = await label();
    if (want.test(now)) return;
    await page.keyboard.press('Escape').catch(() => {}); // the menu, if it is still open
    const shown = now.slice(0, 60) || 'unknown';
    if (to === 'host') throw chatError('host-unreachable', `the Zoom chat can't be sent to the host (recipient: ${shown}; no "Host and co-hosts" to choose)`);
    throw chatError('chat-restricted', `the Zoom chat can't be sent to everyone (recipient: ${shown}); the host may allow chat with the host only`);
  },

  // Enter sends unless the account set Enter to a new line: a message still in the box is sent with the Send button.
  // Sent means a new message from Bosun ("Me", or its name) with this text shows up in the chat, and (to everyone) not
  // marked private; otherwise this throws with a code (chatError) saying why.
  async sendChat(page, text, { selfName = null, to = 'everyone' } = {}) {
    await this.openChat(page);
    await this.recipient(page, to);
    const box = await chatBox(page);
    const before = await this.posted(page, text, selfName);
    await box.fill(text, { timeout: 5000 });
    await box.press('Enter', { timeout: 5000 });
    const left = async () => norm(await box.evaluate((e) => ('value' in e ? e.value : e.innerText))).trim(); // a read error throws
    for (let i = 0; i < 8 && await left(); i++) await page.waitForTimeout(150);
    if (await left()) {
      await box.fill(text, { timeout: 5000 }); // Enter may have added a line break
      const send = await firstVisible(button(page, SEND));
      if (send) await send.click({ timeout: 3000 }).catch(() => {});
      for (let i = 0; i < 8 && await left(); i++) await page.waitForTimeout(150);
      if (await left()) throw chatError('not-sent', 'the Zoom chat message was not sent (still in the chat box)');
    }
    for (let i = 0; i < 40; i++) {
      const now = await this.posted(page, text, selfName);
      if (now.count > before.count) {
        if (now.private && to !== 'host') throw chatError('sent-privately', 'the Zoom chat message went to one person only, not to everyone');
        return;
      }
      await page.waitForTimeout(250);
    }
    throw chatError('not-confirmed', 'the Zoom chat message did not show up in the chat as sent by Bosun');
  },

  // Bosun's own chat messages reading exactly `text` (sender "Me"/"You" or selfName; texts compared as norm() does),
  // and whether the last of them is marked as private.
  async posted(page, text, selfName) {
    const r = await page.evaluate(({ MSG, SENDER, ITEM, text, selfName }) => {
      const n = (s) => String(s || '').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim();
      const all = [...document.querySelectorAll(MSG)];
      let last = null, hit = null, count = 0;
      for (const el of all.filter((e) => !all.some((o) => o !== e && e.contains(o)))) {
        const item = el.closest(ITEM);
        const named = item?.querySelector(SENDER);
        // The sender line may carry the recipient and a time ("Glassy Notetaker to Everyone 10:07 AM"); the bubble
        // may carry a time and controls around the text: ours if it contains exactly what was sent.
        const sender = n(named ? named.innerText || named.textContent : '').replace(/\s+\d{1,2}:\d{2}(?:\s?[ap]\.?\s?m\.?)?$/i, '').replace(/\s+(?:to|an|для)\s+.*$/i, '') || last;
        last = sender;
        const own = /^(?:me|you|ich|du|я|ви)$/i.test(sender || '') || (selfName && sender === n(selfName));
        if (own && n(el.innerText || el.textContent).includes(text)) { count++; hit = el; }
      }
      return { count, label: hit ? ((hit.closest(ITEM) || hit.parentElement)?.innerText || '').replace(hit.innerText || '', ' ').slice(0, 300) : '' };
    }, { MSG: CHAT_MESSAGE, SENDER: CHAT_SENDER, ITEM: CHAT_ITEM, text: norm(text).trim(), selfName });
    return { count: r.count, private: PRIVATELY.test(norm(r.label)) };
  },

  // As meet.mjs: new chat messages are queued in the page under a random, non-enumerable key. Zoom groups consecutive
  // messages of one sender under one name, so a message without a name of its own takes the last one seen above it.
  async watchChat(page, key) {
    await page.evaluate(({ key, MSG, SENDER, ITEM, TO }) => {
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
          sender = (sender || last || '').replace(new RegExp(TO, 'iu'), '').trim().slice(0, 80) || null;
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
    }, { key, MSG: CHAT_MESSAGE, SENDER: CHAT_SENDER, ITEM: CHAT_ITEM, TO: TO_GROUP });
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

  // The toolbar's "Mute" / "Unmute". Bosun joined without giving Zoom the microphone, so the first unmute makes Zoom ask
  // "Do you want people to hear you…?": the agent asked to be heard, so "Use microphone" (and nothing with the camera).
  // A question that can't be answered that way is answered without it again, and the unmute fails.
  // When the toolbar's buttons don't do it (real Zoom, 2026-10-28: "no microphone control found" muting again after
  // speaking), the control is read and clicked in the page, then Alt+A is tried (micFallback); the state is always
  // read back. Muting gives each way a short time, so three tries fit the 20 s an utterance's end waits for it.
  async setMic(page, on) {
    const answer = on ? async (p) => { const b = await firstVisible(button(p, LABEL.useMic)); if (b) await b.click({ timeout: 2000 }).catch(() => {}); } : null;
    try {
      return await setControl(page, { onLabel: LABEL.micOff, offLabel: LABEL.micOn, on, what: 'microphone', site: 'Zoom', answer, open: revealToolbar, reveal: revealToolbar, timeoutMs: on ? 10_000 : 2000 });
    } catch (e) {
      if (on && await declineDevices(page)) throw new Error('Zoom did not take the microphone when unmuting (it asked for one and offered no "Use microphone"); nothing can be said');
      const r = await micFallback(page, on);
      if (r.via) return { state: r.state, changed: r.changed || !!e.clicked, via: r.via }; // a click of setControl's may have done it
      const shown = r.state ? `the page shows it ${r.state === 'on' ? 'on' : 'off'} ("${r.label}")` : 'no microphone control in the page either';
      throw Object.assign(new Error(`${e.message}; ${shown}${r.clicked ? ', and neither clicking it in the page nor Alt+A changed it' : ''}`), { clicked: e.clicked || r.clicked });
    }
  },

  // Who Zoom shows as speaking: the speaker view's active tile (vexa's selectors, seen live 2026), or a gallery tile
  // marked active, the name in its footer. Not shown in gallery views without an active mark, or while a screen is
  // shared full size; then segments carry no speaker.
  watchSpeakers: (page, key, opts) => watchSpeakers(page, key, ZOOM_SPEAKERS, opts),
  drainSpeakers,
  // Opens the menu holding the hand (every 2 s at most, so an open menu isn't closed again), and closes it after.
  async setHand(page, on) {
    let openedAt = 0;
    const open = async (p) => {
      if (Date.now() - openedAt < 2000) return;
      if (!(await firstVisible(button(p, LABEL.reactions)))) await revealToolbar(p);
      const b = await firstVisible(button(p, LABEL.reactions));
      if (b) openedAt = await b.click({ timeout: 3000 }).then(() => Date.now(), () => 0);
    };
    try {
      return await setControl(page, { onLabel: LABEL.handUp, offLabel: LABEL.handDown, on, what: 'raised hand', site: 'Zoom', open });
    } finally {
      if (openedAt) await page.keyboard.press('Escape').catch(() => {});
    }
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

const ZOOM_SPEAKERS = {
  active: ['.speaker-active-container__video-frame', '.speaker-bar-container__video-frame--active', '[class*="single-"][class*="-container__video-frame"]',
    '[class*="gallery-video-container__video-frame--active"]', '[class*="video-frame--active"]'],
  activeName: '.video-avatar__avatar-footer, [class*="avatar-footer"], [class*="avatar-name"]',
};

export const _test = { TEXT, LABEL, norm, EVERYONE, HOSTS, TO_GROUP };
