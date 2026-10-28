// A local stand-in for Zoom's web client with the labels and markers platforms/zoom.mjs relies on: an app-launch
// page (/j/<id>: "Launch Meeting", then "Join from your browser"), the preview (/wc/<id>/join: name, passcode, "Mute",
// "Stop Video", "Join"), the waiting room, admission, the in-call toolbar ("Join Audio by Computer", "mute my
// microphone", "stop my video", participants with a counter, chat, "Leave" + "Leave Meeting"), a chat panel that
// groups consecutive messages of one sender under one name, the end of the meeting and removal. The test plays host
// through the returned object. With tone: true the admitted page plays a 440 Hz tone once computer audio is joined.
import http from 'http';

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The launch page an invitation link opens (zoom.us/j/<id>): the app is offered first, the browser on request.
function launch(id, search) {
  return `<!doctype html><meta charset="utf-8"><title>Launch Meeting - Zoom</title>
<h1>Click Open Zoom Workplace on the dialog shown by your browser</h1>
<button id="launch">Launch Meeting</button>
<p id="alt" hidden>Having issues with Zoom Workplace? <a href="/wc/${id}/join${esc(search)}">Join from your browser</a></p>
<script>document.getElementById('launch').onclick = () => { document.getElementById('alt').hidden = false; };</script>`;
}

// opts: signedIn (the name field holds the account's name), cookies (a cookie banner over the Join button),
// passcode (the meeting has one; the preview asks for it unless the link carried it), noDevices (no mic/camera
// controls in the preview, "Cannot detect your camera"/"microphone"), recordedNotice (a "This meeting is being
// recorded" dialog once in), bigChallenge (a visible reCAPTCHA in the preview), title (the meeting's topic shown in
// the call), recipient (the chat starts addressed to this person; "Everyone" is in its menu unless hostOnly, "Host
// and co-hosts" unless noHost; "Meeting Group Chat" is continuous meeting chat's public recipient, like "Everyone"),
// enterNewline (Enter adds a line break; the Send button sends), hideRecipient (no recipient control shown: messages
// go to `recipient` anyway, marked "(Privately)"), dropSends (the chat box clears but nothing is posted; a recipient's
// label: only messages to that recipient are dropped), askPasscode (the preview asks for the passcode even
// though the link carried one). web2026: the preview as live Zoom showed it on 2026-10-23: first the question "Do you
// want people to see you in the meeting?" ("Use microphone and camera" / "Continue without microphone and camera")
// over everything, an empty "Your Name" field even for a signed-in account, "Remember my name for future meetings",
// "Join" disabled until a name is typed, "This site is protected by reCAPTCHA …" with reCAPTCHA's invisible badge and
// parked challenge frame, a microphone but "Cannot detect your camera". expired: Zoom's "This meeting link is invalid
// (3,001)" page instead. hearYou: the preview as live Zoom showed it on 2026-10-23 13:23 (no devices granted): the
// "see you" question, then a second question as a dialog, "Do you want people to hear you in the meeting?" ('both':
// "Continue without microphone and camera"; 'mic': "Use microphone" / "Continue without microphone"), then "Mute" with
// a crossed microphone (no permission: muted in effect), "Stop Video", "Cannot detect your camera…", an empty "Your
// Name" and "Join" disabled until a name is typed. Clicking "Mute" does not toggle it: it asks "hear you" again
// ("Use microphone" / "Continue without microphone"); "Stop Video" asks "see you" ("Use camera" / "Continue without
// camera"; assumed, not seen live). hearDelayMs: when the second question comes up after the first (500 ms). micClick 'stuck': a live microphone whose "Mute" takes clicks and does nothing;
// 'toggles': a live microphone that mutes; 'asksCamera' / 'asksCameraBoth': a live microphone whose "Mute" does nothing
// but bring up the camera's question ("see you"; "Continue without camera" / "… without microphone and camera"). Every "Use …" click is logged as media {devices: 'used'}.
// audioJoined: the call as live Zoom showed it on 2026-10-23 15:00, let in without a microphone: computer audio is
// connected by itself (no "Join Audio" anywhere), the toolbar has "Audio" (a microphone with a warning sign) and "More
// audio controls", whose menu reads "Microphone modes", "Background noise suppression", "Test Speaker & Microphone",
// "Switch to phone audio", "Leave computer audio", "Audio Settings"; then "Video", "More video controls", "open the
// participants list pane,[n] particpants", chat, "Chat Settings", "React", "Share", "More meeting control", "Leave";
// and notices outside any dialog: "Introducing My Notes…" (Got it), "…enable hardware acceleration" (×), "<host> is
// the host now." and "⚠ Please enable access to your microphone and camera…" (×; how the two × buttons are labelled
// was not seen: one carries aria-label "close", the other only a close class). The "hear you" dialog also holds
// Chrome's <permission> element. A click on "Audio", "Video", a menu entry or the <permission> element is logged as
// media {clicked}. audioJoined 'notConnected': the same toolbar, but the menu offers neither leaving computer audio nor
// switching to phone audio. (A host without devices, as production is, is the test's platform: zoom.devices.)
// decoyMenu: a menu shown in the call with a participant named "Leave computer audio"; 'renames': that participant is
// named "Leave computer audio" while the audio menu is open, and gone from that menu once it closes. menuHide 'visibility' / 'opacity': the audio menu
// stays in the page when closed, hidden by visibility or opacity instead of display. captionClose: the captions
// panel has a close button of its own (clicks logged as media {clicked: 'captions close'}). autoHideMs: the toolbar fades
// out after this long without the mouse moving (opacity 0, clicks go through to what is behind it) and comes back on
// the next mouse move, as Zoom's web client does: its buttons still count as visible.
function webClient(id, r) {
  if (r.expired) {
    return `<!doctype html><meta charset="utf-8"><title>Error - Zoom</title><nav><a href="/join">Join</a> <a href="/signin">Sign In</a></nav>
<div>This meeting link is invalid (3,001)</div><div role="alertdialog" aria-label="Privacy"><p>Zoom uses cookies.</p><button>Decline Cookies</button><button>Accept Cookies</button></div>
<button aria-label="Open chat dialog">:)</button>`;
  }
  if (r.web2026 || r.hearYou) r = { ...r, noDevices: false, signedInName: false };
  const aj = r.audioJoined;
  const icon = (c) => `<svg class="zm-icon ${c}" aria-hidden="true" width="16" height="16"><path d="M2 2h12v12H2z"/></svg>`;
  // Raise Hand / Lower Hand inside the Reactions popup (it closes after a click).
  const handPop = '<div id="reactPop" role="menu" hidden><button id="clap" aria-label="Clap">👏</button><button id="hand" aria-label="Raise Hand">Raise Hand</button></div>';
  const footer = aj ? `<button id="mic" aria-label="audio">${icon('zm-icon-mic')}${icon('zm-icon-warning')}Audio</button>
    <button id="audioMore" aria-label="More audio controls">${icon('zm-icon-chevron')}</button>
    <ul id="audioPop" class="audio-option-menu__pop-menu" role="menu" hidden>
      <li class="dropdown-header" role="presentation">Microphone modes</li>
      <li role="menuitemcheckbox" aria-checked="true">✓ Background noise suppression</li>
      <li role="menuitem">Test Speaker &amp; Microphone</li>
      ${aj === 'notConnected' ? '' : '<li role="menuitem">Switch to phone audio</li><li role="menuitem">Leave computer audio</li>'}
      <li role="menuitem">Audio Settings</li>
    </ul>
    <button id="cam" aria-label="Video">Video</button><button aria-label="More video controls">${icon('zm-icon-chevron')}</button>
    <button id="parts" aria-label="open the participants list pane,[0] particpants"><span class="footer-button__number-counter" id="count">0</span>Participants</button>
    <button id="chatBtn" aria-label="open the chat panel">Chat</button><button aria-label="Chat Settings">${icon('zm-icon-chevron')}</button>
    <button id="react" aria-label="React">React</button><button aria-label="Share">Share</button><button aria-label="More meeting control">More</button>${handPop}`
    : `<button id="mic" aria-label="join audio">Join Audio</button>
    <button id="cam" aria-label="start my video">Start Video</button>
    <button id="parts" aria-label="open the manage participants list pane,[0] particpants"><span class="footer-button__number-counter" id="count">0</span>Participants</button>
    <button id="chatBtn" aria-label="open the chat panel">Chat</button>
    <button id="react" aria-label="Reactions">Reactions</button>${handPop}`;
  const toasts = aj ? `<div id="toasts" style="position:fixed;top:40px;right:10px;width:320px">
    <div class="zm-toast" id="t1"><span>Introducing My Notes: take private notes during the meeting.</span><button>Got it</button></div>
    <div class="zm-toast" id="t2"><span>For a better meeting experience, enable browser hardware acceleration in your settings.</span><button aria-label="close">${icon('zm-icon-close')}</button></div>
    <div class="zm-toast" id="t3">Host Person is the host now.</div>
    <div class="zm-toast" id="t4"><span>⚠ Please enable access to your microphone and camera for the best experience.</span><button class="zm-toast__close-btn">${icon('zm-icon-close')}</button></div>
  </div>` : '';
  const hy = r.hearYou ? (r.hearYou === 'mic' ? ['Use microphone', 'Continue without microphone'] : [null, 'Continue without microphone and camera']) : null;
  const crossed = '<svg class="zm-icon zm-icon-mic-disabled" aria-hidden="true" width="16" height="16"><path d="M2 2l12 12" stroke="red"/></svg>';
  return `<!doctype html><meta charset="utf-8"><title>Zoom Meeting</title>
<style>[hidden]{display:none!important} .tile{display:inline-block;width:80px;height:60px;background:#333;margin:4px}</style>
<div id="preview">
  <h1>Enter Meeting Info</h1>
  <input id="input-for-name" type="text" aria-label="Your Name" placeholder="Your Name" value="${esc(r.remembered ?? (r.signedIn && !r.web2026 ? 'Glassy Smartie' : ''))}">
  ${r.web2026 || r.hearYou ? '<label><input type="checkbox" id="remember"> Remember my name for future meetings</label>' : ''}
  ${(r.passcode && !r.pwdGiven) || r.askPasscode ? '<input id="input-for-pwd" type="password" aria-label="Meeting Passcode" placeholder="Meeting Passcode">' : ''}
  ${r.hearYou ? `<button id="pmic" aria-label="Mute">${r.micClick ? '' : crossed}Mute</button><button id="pcam" aria-label="Stop Video">Stop Video</button><p>Cannot detect your camera, please check the device and connection and try again.</p>`
    : r.web2026 ? '<button id="pmic" aria-label="Mute">Mute</button><p>Cannot detect your camera, please check the device and connection and try again.</p>'
    : r.noDevices ? '<p>Cannot detect your camera</p><p>Cannot detect your microphone</p>' : '<button id="pmic" aria-label="Mute">Mute</button><button id="pcam" aria-label="Stop Video">Stop Video</button>'}
  <button id="join" class="preview-join-button"${r.web2026 || r.hearYou ? ' disabled' : ''}>Join</button>
  <p>By clicking "Join", you agree to our Terms of Service and Privacy Statement</p>
  ${r.web2026 ? `<p>This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.</p><div class="grecaptcha-badge" style="position:fixed;bottom:14px;right:0;width:256px;height:60px"><iframe src="/recaptcha/api2/anchor?ar=1&amp;k=x&amp;size=invisible" title="reCAPTCHA" width="256" height="60"></iframe></div>
<div style="visibility:hidden;position:absolute;top:-10000px"><iframe src="/recaptcha/api2/bframe?k=x" title="recaptcha challenge expires in two minutes" width="400" height="580"></iframe></div>` : ''}
  ${r.bigChallenge ? '<iframe src="/recaptcha/api2/anchor?k=x" title="reCAPTCHA" width="300" height="300"></iframe>' : ''}
</div>
${r.web2026 || r.hearYou ? `<div id="devq" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:20"><div style="background:#fff;margin:80px auto;width:380px;padding:16px">
  <h2>Do you want people to see you in the meeting?</h2><p>You can still turn off your microphone and camera anytime in the meeting.</p>
  <button id="devUse">Use microphone and camera</button><button id="devNo">Continue without microphone and camera</button></div></div>` : ''}
${hy ? `<div id="hearq" role="dialog" aria-modal="true" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:20"><div style="background:#fff;margin:80px auto;width:380px;padding:16px">
  <h2 id="hearTitle">Do you want people to hear you in the meeting?</h2><p>You can still turn off your microphone anytime in the meeting.</p>
  ${aj ? '<permission id="pepc" type="microphone" style="display:inline-block;width:24px;height:24px;cursor:pointer"></permission>' : ''}
  <button id="hearUse"${hy[0] ? '' : ' hidden'}>${hy[0] || 'Use microphone'}</button><button id="hearNo">${hy[1]}</button></div></div>` : ''}
${r.cookies ? `<div id="onetrust-banner-sdk" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10"><p>We use cookies.</p>
  <button id="onetrust-accept-btn-handler">Accept Cookies</button></div>` : ''}
<div id="waiting" hidden><h2>Please wait, the meeting host will let you in soon.</h2><button>Leave</button></div>
<div id="notice" role="dialog" hidden><p id="noticeText"></p><button>OK</button></div>
<div id="call" hidden>
  ${r.title ? `<div class="meeting-info-container__topic">${esc(r.title)}</div>` : ''}
  <div id="tiles"></div>
  ${r.captionClose ? '<div class="live-transcription-subtitle__container"><div id="captions" class="live-transcription-subtitle__box"></div><button id="capClose" aria-label="close">×</button></div>'
    : '<div id="captions" class="live-transcription-subtitle__box"></div>'}
  ${r.decoyMenu ? `<div class="pin-dropdown-menu" role="menu"><div role="menuitem" id="decoy">${r.decoyMenu === 'renames' ? 'Guest Two' : 'Leave computer audio'}</div><div role="menuitem">Host Person</div></div>` : ''}
  ${toasts}
  <div role="dialog" id="micAsk" hidden><h2>Do you want people to hear you in the meeting?</h2><button id="micUse">Use microphone</button><button id="micNo">Continue without microphone</button></div>
  <div role="dialog" id="audioDlg" hidden><h2>Join Audio</h2><button id="byComputer">Join Audio by Computer</button></div>
  <div role="dialog" id="recDlg" hidden><p>This meeting is being recorded</p><button id="recOk">Got it</button><button>Leave Meeting</button></div>
  <footer>
    ${footer}
    <button id="leave" aria-label="Leave">Leave</button>
    <div id="leaveMenu" hidden><button id="leaveConfirm">Leave Meeting</button></div>
  </footer>
  <aside id="panel" class="chat-container" hidden>
    <div id="msgs" class="chat-container__chat-list"></div>
    <div class="chat-receiver-list"${r.hideRecipient ? ' hidden' : ''}><button id="to" class="chat-receiver-list__receiver">${esc(r.recipient || 'Everyone')}</button>
      <div role="menu" id="toMenu" hidden>${r.hostOnly ? '' : '<div role="menuitem" tabindex="0" id="toAll">Everyone</div>'}${r.noHost ? '' : '<div role="menuitem" tabindex="0">Host and co-hosts</div>'}</div></div>
    <div id="box" class="tiptap ProseMirror" contenteditable="true" aria-label="Type message here ..."></div>
    <button id="send" aria-label="send">Send</button>
  </aside>
</div>
<script>
const R = ${JSON.stringify({ decoyMenu: r.decoyMenu || null, menuHide: r.menuHide || null, tone: r.tone, recordedNotice: !!r.recordedNotice, enterNewline: !!r.enterNewline, dropSends: r.dropSends || false, liveChat: !!r.liveChat, hearYou: r.hearYou || null, micInCall: r.micInCall || null, micClick: r.micClick || null, hearDelayMs: r.hearDelayMs ?? null, autoHideMs: r.autoHideMs || 0, audioJoined: r.audioJoined || null })};
const id = ${JSON.stringify(id)}, $ = (x) => document.getElementById(x);
const params = new URL(location.href).searchParams;
const post = (p, b) => fetch('/api/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...b }) });
let pmic = true, pcam = ${r.noDevices ? 'false' : 'true'}, audio = false, mic = true, cam = false, shown = new Set(), toned = false, inCall = false;
if ($('pmic')) { $('pmic').onclick = () => { pmic = !pmic; $('pmic').textContent = pmic ? 'Mute' : 'Unmute'; $('pmic').setAttribute('aria-label', $('pmic').textContent); };
  if ($('pcam')) $('pcam').onclick = () => { pcam = !pcam; $('pcam').textContent = pcam ? 'Stop Video' : 'Start Video'; $('pcam').setAttribute('aria-label', $('pcam').textContent); }; }
if (${r.noDevices ? 'true' : 'false'}) pmic = false;
$('onetrust-accept-btn-handler') && ($('onetrust-accept-btn-handler').onclick = () => $('onetrust-banner-sdk').remove());
if ($('devq')) { $('devNo').onclick = () => { $('devq').remove(); post('media', { devices: 'declined' }); }; $('devUse').onclick = () => { $('devq').remove(); post('media', { devices: 'used' }); }; }
if ($('remember')) $('input-for-name').addEventListener('input', () => { $('join').disabled = !$('input-for-name').value.trim(); });
if (${r.web2026 || r.hearYou ? 'true' : 'false'}) pcam = false;
if (R.hearYou) {
  pmic = !!R.micClick; // without permission the microphone sends nothing
  // A question in the dialog: [title, use label, decline label]; the decline only closes it, "Use …" is logged.
  const ask = (title, use, no) => { $('hearTitle').textContent = title; $('hearUse').textContent = use; $('hearUse').hidden = false; $('hearNo').textContent = no; $('hearq').hidden = false; };
  $('hearNo').onclick = () => { $('hearq').hidden = true; post('media', { devices: 'declined', question: $('hearTitle').textContent }); };
  $('hearUse').onclick = () => { $('hearq').hidden = true; post('media', { devices: 'used', question: $('hearTitle').textContent }); };
  $('devNo').onclick = () => { $('devq').remove(); post('media', { devices: 'declined' }); setTimeout(() => { $('hearq').hidden = false; }, R.hearDelayMs ?? 500); };
  $('pmic').onclick = () => {
    if (R.micClick === 'stuck') return;
    if (R.micClick === 'asksCamera') return ask('Do you want people to see you in the meeting?', 'Use camera', 'Continue without camera');
    if (R.micClick === 'asksCameraBoth') return ask('Do you want people to see you in the meeting?', 'Use microphone and camera', 'Continue without microphone and camera');
    if (R.micClick === 'toggles') { pmic = !pmic; $('pmic').textContent = pmic ? 'Mute' : 'Unmute'; $('pmic').setAttribute('aria-label', $('pmic').textContent); return; }
    ask('Do you want people to hear you in the meeting?', 'Use microphone', 'Continue without microphone');
  };
  $('pcam').onclick = () => ask('Do you want people to see you in the meeting?', 'Use camera', 'Continue without camera');
}
$('join').onclick = () => {
  const pwd = $('input-for-pwd') ? $('input-for-pwd').value : params.get('pwd');
  mic = pmic; cam = pcam;
  post('join', { name: $('input-for-name').value, pwd, mic: pmic, cam: pcam });
};
const micLabel = () => { if (R.audioJoined) return; $('mic').setAttribute('aria-label', !audio ? 'join audio' : mic ? 'mute my microphone' : 'unmute my microphone'); $('mic').textContent = !audio ? 'Join Audio' : mic ? 'Mute' : 'Unmute'; };
if (R.audioJoined) {
  audio = R.audioJoined !== 'notConnected'; // connected by Zoom itself, without a microphone
  const clicked = (what) => post('media', { clicked: what });
  $('mic').addEventListener('click', (e) => { e.stopImmediatePropagation(); clicked('Audio'); }, true);
  $('cam').addEventListener('click', (e) => { e.stopImmediatePropagation(); clicked('Video'); }, true);
  $('pepc').onclick = () => clicked('permission');
  // The menu shown or not: by display (hidden), or kept in the page and hidden by visibility or opacity.
  const pop = $('audioPop'), hide = { visibility: ['visibility', 'hidden', 'visible'], opacity: ['opacity', '0', '1'] }[R.menuHide];
  const popOpen = () => (hide ? pop.style[hide[0]] === hide[2] : !pop.hidden);
  const popShow = (on) => { if (hide) { pop.hidden = false; pop.style[hide[0]] = on ? hide[2] : hide[1]; } else pop.hidden = !on; if (R.decoyMenu === 'renames' && decoyArmed) { $('decoy').textContent = on ? 'Leave computer audio' : 'Guest Two'; $('decoy').hidden = !on; } };
  let decoyArmed = false;
  popShow(false);
  decoyArmed = true;
  $('audioMore').onclick = () => popShow(!popOpen());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') popShow(false); });
  for (const it of document.querySelectorAll('#audioPop [role^=menuitem]')) it.onclick = () => { clicked(it.textContent); if (/leave computer audio/i.test(it.textContent)) audio = false; popShow(false); };
  if ($('capClose')) $('capClose').onclick = () => clicked('captions close');
  for (const t of document.querySelectorAll('.zm-toast button')) t.onclick = () => { t.parentElement.hidden = true; post('media', { toast: t.parentElement.id }); };
}
// micInCall 'ask': Zoom never got the microphone; the first unmute asks for it.
let micGiven = R.micInCall !== 'ask';
$('micUse').onclick = () => { micGiven = true; $('micAsk').hidden = true; mic = true; micLabel(); post('media', { mic, cam, asked: 'used' }); };
$('micNo').onclick = () => { $('micAsk').hidden = true; post('media', { asked: 'declined' }); };
$('mic').onclick = () => { if (!audio) { $('audioDlg').hidden = false; return; } if (!mic && !micGiven) { $('micAsk').hidden = false; return; } mic = !mic; micLabel(); post('media', { mic, cam }); };
// Zoom may connect computer audio with the microphone live, whatever the preview said: Bosun has to mute it.
$('byComputer').onclick = () => { audio = true; mic = true; $('audioDlg').hidden = true; micLabel(); post('media', { audio, mic, cam }); };
$('cam').onclick = () => { cam = !cam; $('cam').setAttribute('aria-label', cam ? 'stop my video' : 'start my video'); post('media', { mic, cam }); };
$('recOk').onclick = () => { $('recDlg').hidden = true; };
let hand = false;
$('react').addEventListener('click', () => { $('reactPop').hidden = !$('reactPop').hidden; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('reactPop').hidden = true; });
$('hand').onclick = () => { hand = !hand; const l = hand ? 'Lower Hand' : 'Raise Hand'; $('hand').textContent = l; $('hand').setAttribute('aria-label', l); $('reactPop').hidden = true; post('media', { hand }); };
$('chatBtn').onclick = () => { $('panel').hidden = !$('panel').hidden; $('chatBtn').setAttribute('aria-label', $('panel').hidden ? 'open the chat panel' : 'close the chat panel'); };
$('leave').onclick = () => { $('leaveMenu').hidden = false; };
$('leaveConfirm').onclick = () => post('leave', {});
const sendBox = () => { const t = $('box').innerText.trim(); $('box').textContent = ''; if (t && R.dropSends !== true && R.dropSends !== $('to').textContent) post('chat', { text: t, to: $('to').textContent }); };
$('box').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !R.enterNewline) { e.preventDefault(); sendBox(); } });
$('send').onclick = sendBox;
$('to').onclick = () => { $('toMenu').hidden = !$('toMenu').hidden; };
for (const it of document.querySelectorAll('#toMenu [role=menuitem]')) it.onclick = () => { $('to').textContent = it.textContent; $('toMenu').hidden = true; };
function autoHide() {
  const f = document.querySelector('footer');
  let t = null;
  const show = () => { f.style.opacity = '1'; f.style.pointerEvents = ''; clearTimeout(t); t = setTimeout(() => { f.style.opacity = '0'; f.style.pointerEvents = 'none'; }, R.autoHideMs); };
  document.addEventListener('mousemove', show);
  show();
}
async function poll() {
  const s = await (await fetch('/api/state?id=' + id)).json();
  if (s.navigate) { location.href = s.navigate; return; }
  $('preview').hidden = s.view !== 'preview';
  $('waiting').hidden = s.view !== 'waiting';
  $('call').hidden = s.view !== 'call';
  $('notice').hidden = s.view !== 'notice';
  if (s.view === 'notice') $('noticeText').textContent = s.notice;
  if (s.view === 'call') {
    if (!inCall) { inCall = true; $('audioDlg').hidden = !!R.audioJoined; if (R.recordedNotice) $('recDlg').hidden = false; micLabel(); if (R.autoHideMs) autoHide(); }
    const want = s.participants.join();
    if ($('tiles').dataset.p !== want) {
      $('tiles').dataset.p = want;
      $('tiles').replaceChildren(...s.participants.map((p) => { const t = document.createElement('div'); t.className = 'tile video-avatar__avatar-name'; t.textContent = p; return t; }));
      $('count').textContent = s.participants.length;
      $('parts').setAttribute('aria-label', 'open the ' + (R.audioJoined ? '' : 'manage ') + 'participants list pane,[' + s.participants.length + '] particpants');
    }
    $('captions').textContent = s.caption || '';
    let prev = null;
    for (const m of s.chat) {
      if (shown.has(m.id)) { prev = m.sender; continue; }
      shown.add(m.id);
      const item = document.createElement('div');
      item.className = 'chat-item-container';
      // liveChat: our own messages under our name with the recipient and a time ("Glassy (notetaker) to Everyone
      // 10:07 AM", "… to Host and co-hosts …"), and each bubble with a time and its menu control inside.
      const sender = m.self ? (R.liveChat ? m.sender + ' to ' + (m.to || 'Everyone') + ' 10:07 AM' : 'Me') : (R.liveChat ? m.sender + ' 10:07 AM' : m.sender);
      if (sender !== prev) { const h = document.createElement('div'); h.className = 'chat-item__sender'; h.textContent = sender; item.append(h); }
      prev = sender;
      const d = document.createElement('div');
      d.className = 'new-chat-message__container';
      d.id = 'chat-message-content-' + m.id;
      d.textContent = m.text;
      if (R.liveChat) { const t = document.createElement('div'); t.textContent = '10:07 AM'; const b = document.createElement('button'); b.setAttribute('aria-label', 'more'); b.textContent = 'more_vert'; d.append(t, b); }
      item.append(d);
      if (m.to && m.to !== 'Everyone' && m.to !== 'Meeting Group Chat') { const p = document.createElement('span'); p.textContent = '(Privately)'; item.append(p); }
      $('msgs').append(item);
    }
    if (R.tone && audio && !toned) { toned = true; const c = new AudioContext(); const o = c.createOscillator(); o.frequency.value = 440; o.connect(c.destination); o.start(); }
  }
  setTimeout(poll, 150);
}
poll();
</script>`;
}

const NOTICES = {
  ended: 'This meeting has been ended by host',
  removed: 'You have been removed from this meeting by the host',
  invalid: 'Passcode wrong. Please try again.',
  signIn: 'This meeting is for authorized attendees only. Sign in to join.',
};

export async function startFakeZoom({ tone = false } = {}) {
  const rooms = new Map();
  const state = { account: null };
  const room = (id) => {
    if (!rooms.has(id)) rooms.set(id, { phase: 'preview', guest: null, chat: [], others: ['Host Person', 'Guest Two'], over: null, tone, log: [], seq: 0, media: [], loads: [] });
    return rooms.get(id);
  };
  const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => r(b ? JSON.parse(b) : {})); });
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const html = (h) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(h); };
    let m = u.pathname.match(/^\/j\/(\d{9,12})$/);
    if (m) { room(m[1]).loads.push(u.pathname); return html(launch(m[1], u.search)); }
    // The account page: 200 when the browser is signed in to the stand-in (account(true)), off to sign-in with
    // account(false); 404 (Bosun can't tell) until a test says.
    if (u.pathname === '/profile') {
      if (state.account === null) { res.writeHead(404); return res.end(); }
      if (state.account) return html('<title>Profile - Zoom</title><h1>Profile</h1>');
      res.writeHead(302, { location: '/signin#/login' });
      return res.end();
    }
    m = u.pathname.match(/^\/wc\/(\d{9,12})\/join$/);
    if (m) {
      const r = room(m[1]);
      r.loads.push(u.pathname);
      r.pwdGiven = !!u.searchParams.get('pwd');
      r.cookieLang = (req.headers.cookie || '').match(/_zm_lang=([^;]+)/)?.[1] || null;
      return html(webClient(m[1], r));
    }
    if (u.pathname === '/api/state') {
      const r = room(u.searchParams.get('id'));
      const view = r.over ? 'notice' : r.phase === 'admitted' ? 'call' : r.phase === 'waiting' ? 'waiting' : r.phase === 'rejected' ? 'notice' : 'preview';
      const notice = r.over ? NOTICES[r.over] : r.phase === 'rejected' ? NOTICES[r.rejected] : null;
      return json({ view, notice, participants: [r.guest?.name || 'self', ...r.others], chat: r.chat, caption: r.caption || null });
    }
    if (req.method === 'POST') {
      const b = await body(req);
      const r = room(b.id);
      if (u.pathname === '/api/join') {
        r.guest = { name: b.name, mic: b.mic, cam: b.cam };
        r.log.push(['join', Date.now()]);
        if (r.passcode && b.pwd !== r.passcode) { r.phase = 'rejected'; r.rejected = 'invalid'; } else if (r.requireSignIn && !r.signedIn) { r.phase = 'rejected'; r.rejected = 'signIn'; } else r.phase = r.open ? 'admitted' : 'waiting';
      }
      if (u.pathname === '/api/media') { r.media.push({ ...b, at: Date.now() }); delete r.media.at(-1).id; }
      if (u.pathname === '/api/chat') { r.chat.push({ id: `${++r.seq}`, sender: r.guest?.name, self: true, text: b.text, to: b.to }); r.log.push(['chat', Date.now(), b.text]); }
      if (u.pathname === '/api/leave') { r.left = true; r.over = 'ended'; r.log.push(['leave', Date.now()]); }
      return json({ ok: true });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let n = 0;
  return {
    base,
    // A meeting: its invitation link (as Zoom sends it; the test platform maps it to this server's web client).
    newRoom: (opts = {}) => {
      const id = String(81234567890 + n++);
      Object.assign(room(id), opts);
      return { id, url: `https://us02web.zoom.us/j/${id}${opts.passcode ? `?pwd=${opts.passcode}` : ''}` };
    },
    room,
    admit: (id) => { room(id).phase = 'admitted'; room(id).log.push(['admit', Date.now()]); },
    say: (id, sender, text) => { const r = room(id); r.chat.push({ id: `${++r.seq}`, sender, text }); },
    setOthers: (id, others) => { room(id).others = others; },
    end: (id) => { room(id).over = 'ended'; },
    caption: (id, text) => { room(id).caption = text; },
    remove: (id) => { room(id).over = 'removed'; },
    set: (id, opts) => { Object.assign(room(id), opts); },
    // Whether /profile says the browser is signed in.
    account: (v) => { state.account = v; },
    close: () => new Promise((r) => { srv.close(r); srv.closeAllConnections(); }),
  };
}
