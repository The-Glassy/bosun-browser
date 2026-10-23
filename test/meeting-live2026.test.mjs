// The Meet and Zoom lobbies as they were live on 2026-10-23, when both joins failed in production (0.10.0):
// - Meet redirected meet.google.com/<code> to /meet/<code>; its join button's accessible name was "Ask to join without
//   microphone & camera" (text "Ask to join"), or plain "Ask to join" until microphone and camera were switched off;
//   a "Microphone not found" popover, device pickers, a Gemini footer and reCAPTCHA's invisible badge were on the page
//   (and navigate reported a captcha).
// - Zoom's web client first asked "Do you want people to see you in the meeting?", showed an empty name field and a
//   disabled Join, "This site is protected by reCAPTCHA" (reported as a captcha), and the profile was signed out.
// Plus the dry_run that classifies a lobby without joining, and expired links.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect, until, ENGINE } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { startFakeZoom } from './fakezoom.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { zoom, zoomWebClientUrl, parseZoomUrl } from '../src/meetings/platforms/zoom.mjs';
import { wall } from '../src/tools.mjs';

const PROFILE_ENGINE = ENGINE === 'patchright' ? 'patchright' : 'chromium';
const LIVE_MEET = { signedIn: true, account: true, live: true, joinName: 'without', meetPath: true };

let fm, fz;
before(async () => { fm = await startFakeMeet(); fz = await startFakeZoom(); });
after(async () => { await fm.close(); await fz.close(); });

// The real platforms, served by the stand-ins.
const zoomAt = (base) => ({ ...zoom, accountUrl: `${base}/profile`, joinUrl: (u) => zoomWebClientUrl(u).replace('https://app.zoom.us', base), origins: () => [base] });

async function withService(fn) {
  const audio = fakeAudio();
  const z = zoomAt(fz.base);
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (u.startsWith(fm.base) ? meet : zoom.matches(u) ? z : null), pollMs: 200 } });
  try {
    const c = await connect(svc);
    for (const profile of ['google', 'zoom']) await c.call('session_close', { session: await c.open({ profile, engine: PROFILE_ENGINE }) });
    return await fn(svc, c, audio);
  } finally { await svc.stop(); }
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();

test('Meet links: /meet/<code> (where Meet redirects now) is a Meet link too', () => {
  assert.equal(meet.matches('https://meet.google.com/meet/yhd-yhrt-dtv'), true);
  assert.equal(meet.matches('https://meet.google.com/yhd-yhrt-dtv'), true);
  assert.equal(meet.matches('https://meet.google.com/meet/'), false);
  assert.equal(meet.matches('https://meet.google.com/meet/yhd-yhrt-dtv/x'), false);
});

test('Meet, live 2026 lobby: "Ask to join without microphone & camera" is found and clicked, devices off, no captcha', async () => {
  await withService(async (svc, c) => {
    // joinName 'without': the name as live Meet gives it; 'devices': plain until mic and camera are off (the second
    // failure, "the Meet lobby has no join button any more").
    for (const joinName of ['without', 'devices']) {
      const { code, url } = fm.newRoom();
      fm.set(code, { ...LIVE_MEET, joinName });
      const r = await c.call('meeting_join', { url, profile: 'google' });
      assert.equal(r.isError, false, `${joinName}: ${r.text}`);
      const j = r.json();
      assert.equal(j.state, 'waiting', joinName);
      assert.equal(j.joined_as, 'account', joinName);
      assert.equal(fm.room(code).via, 'ask', joinName);
      assert.deepEqual(fm.room(code).guest, { name: null, mic: false, cam: false }, joinName);
      await c.call('meeting_leave', { meeting_id: j.meeting_id });
    }
    // navigate to the same lobby: no captcha (the reCAPTCHA there is the invisible kind).
    const s = await c.open({ profile: 'google', engine: PROFILE_ENGINE });
    const { code, url } = fm.newRoom();
    fm.set(code, LIVE_MEET);
    const nav = (await c.call('navigate', { session: s, url })).json();
    assert.match(nav.url, /\/meet\/abc-/);
    assert.equal(nav.blocked, undefined, JSON.stringify(nav));
    assert.equal(await wall(svc.manager.sessions.get(s).page), null);
    await c.call('session_close', { session: s });
    await c.close();
  });
});

test('Meet dry_run: classifies the lobby and names the button, joins nothing, leaves no session', async () => {
  await withService(async (svc, c) => {
    const { code, url } = fm.newRoom();
    fm.set(code, LIVE_MEET);
    const r = await c.call('meeting_join', { url, profile: 'google', dry_run: true });
    assert.equal(r.isError, false, r.text);
    const d = r.json();
    assert.equal(d.dry_run, true);
    assert.equal(d.platform, 'meet');
    assert.equal(d.state, 'lobby');
    assert.equal(d.lobby, 'account');
    assert.equal(d.join_button, 'Ask to join without microphone & camera');
    assert.equal(d.microphone, 'on (no device found)');
    assert.equal(d.challenge, false);
    assert.match(d.page, new RegExp(`/meet/${code}$`));
    assert.equal(d.title, `Meet - ${code}`);
    assert.deepEqual(fm.room(code).log, []); // nothing asked to join
    await until(() => svc.manager.sessions.size === 0 && svc.manager.used === 0);
    assert.deepEqual((await c.call('meeting_status', {})).json(), []);
    await c.close();
  });
});

test('Meet texts other bots know: "No one responded…" is a denial, "Check your meeting code" an invalid link', async () => {
  await withService(async (svc, c) => {
    const page = svc.manager.sessions.get(await c.open()).page;
    await page.setContent('<h1>No one responded to your request to join the call</h1><button>Ask to join again</button>');
    assert.equal(await meet.state(page), 'denied');
    await page.setContent('<h1>Check your meeting code</h1><p>Make sure that you entered the correct meeting code in the URL</p>');
    assert.equal(await meet.state(page), 'invalid');
    await c.close();
  });
});

test('Zoom, live 2026 preview with a signed-out profile: device question answered, name typed, Join enabled and clicked; a warning says signed out', async () => {
  await withService(async (svc, c) => {
    fz.account(false);
    const { id, url } = fz.newRoom({ web2026: true, passcode: 'p1' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    const j = r.json();
    assert.equal(j.state, 'waiting');
    assert.equal(j.joined_as, 'guest');
    assert.match(j.warning, /^profile zoom is not signed in to Zoom any more: joined as a guest named "Glassy \(notetaker\)"/);
    const room = fz.room(id);
    assert.deepEqual(room.guest, { name: 'Glassy (notetaker)', mic: false, cam: false });
    assert.equal(room.media[0].devices, 'declined');
    assert.equal((await status(c, j.meeting_id)).warning, j.warning);
    await c.call('meeting_leave', { meeting_id: j.meeting_id });
    fz.account(null);
    await c.close();
  });
});

test('Zoom, live 2026 preview with a signed-in profile but an empty name field: joined as the account with the name given', async () => {
  await withService(async (svc, c) => {
    fz.account(true);
    try {
      const { id, url } = fz.newRoom({ web2026: true, signedIn: true });
      const r = await c.call('meeting_join', { url, profile: 'zoom', name: 'Glassy Notetaker' });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.json().joined_as, 'account');
      assert.equal(r.json().warning, undefined);
      assert.equal(fz.room(id).guest.name, 'Glassy Notetaker');
      await c.call('meeting_leave', { meeting_id: r.json().meeting_id });
    } finally { fz.account(null); }
    await c.close();
  });
});

test('Zoom dry_run classifies the preview without typing or joining; an expired link is an invalid meeting', async () => {
  await withService(async (svc, c) => {
    fz.account(false);
    const { id, url } = fz.newRoom({ web2026: true });
    const d = (await c.call('meeting_join', { url, profile: 'zoom', dry_run: true })).json();
    assert.equal(d.dry_run, true);
    assert.equal(d.platform, 'zoom');
    assert.equal(d.state, 'lobby');
    assert.equal(d.join_button, 'Join');
    assert.equal(d.join_enabled, false); // no name typed
    assert.deepEqual(d.name_field, { prefilled: null });
    assert.equal(d.challenge, false);
    assert.equal(d.profile_signed_in, false);
    assert.equal(d.page, `${fz.base}/wc/${id}/join`);
    assert.equal(fz.room(id).guest, null);
    await until(() => svc.manager.sessions.size === 0);
    const exp = fz.newRoom({ expired: true });
    const dx = (await c.call('meeting_join', { url: exp.url, profile: 'zoom', dry_run: true })).json();
    assert.equal(dx.state, 'invalid');
    const r = await c.call('meeting_join', { url: exp.url, profile: 'zoom' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Zoom says the meeting ID or passcode is not valid/);
    assert.equal(parseZoomUrl(exp.url).id, exp.id);
    await c.close();
  });
});

test('captcha rule: a challenge inside a hidden outer frame is none; a shown one, or a challenge page itself, is', async () => {
  await withService(async (svc, c) => {
    const page = svc.manager.sessions.get(await c.open()).page;
    const inner = `<iframe src="${fm.base}/recaptcha/api2/anchor?k=x" width="300" height="300"></iframe>`;
    const outer = (style) => `<iframe style="${style}" width="400" height="400" srcdoc='${inner}'></iframe>`;
    await page.goto(`${fm.base}/nothing`).catch(() => {});
    for (const [style, want] of [['position:absolute;top:-5000px', null], ['opacity:0', null], ['visibility:hidden', null], ['', 'captcha']]) {
      await page.setContent(`<title>t</title>${outer(style)}`);
      await until(() => page.frames().some((f) => /recaptcha/.test(f.url())), 5000);
      assert.equal(await wall(page), want, style || 'shown');
    }
    // A challenge served as the page itself (no frame): its URL says so.
    await page.goto(`${fm.base}/captcha-delivery/check`).catch(() => {});
    assert.equal(await wall(page), 'captcha');
    await c.close();
  });
});

test('dry runs reserve capacity before anything starts: concurrent ones past MAX_SESSIONS are refused, no audio server leaks', async () => {
  const audio = fakeAudio({ openMs: 300 });
  const svc = await startBosun({ KEEPALIVE: '0', MAX_SESSIONS: '1' }, { meetings: { audio, platformFor: (u) => (u.startsWith(fm.base) ? meet : null), pollMs: 200 } });
  try {
    const c = await connect(svc);
    const { code, url } = fm.newRoom();
    fm.set(code, LIVE_MEET);
    const rs = await Promise.all([1, 2, 3].map(() => c.call('meeting_join', { url, dry_run: true })));
    assert.equal(rs.filter((r) => !r.isError).length, 1, rs.map((r) => r.text).join('\n'));
    for (const r of rs.filter((x) => x.isError)) assert.match(r.text, /session limit 1 reached/);
    assert.equal(audio.stats.opened, 1);
    await until(() => audio.stats.closed === 1 && svc.manager.used === 0);
    await c.close();
  } finally { await svc.stop(); }
});
