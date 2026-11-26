// Google Meet with a signed-in profile, as it behaves for a real signed-in account (the cases behind the "locator.click
// timeout" of the first live signed-in join): no name field, the account shown, a dialog over the lobby that takes
// the click, a join button disabled while Meet is "Getting ready...", and the account already in the call on another
// device ("Switch here" / "Join here too"). Also the lobby kind detection (guest or account) on its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect, until, ENGINE } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { meet, meetPrejoin } from '../src/meetings/platforms/meet.mjs';

// The meeting profiles in production are patchright profiles: ENGINE=patchright runs them as such.
const PROFILE_ENGINE = ENGINE === 'patchright' ? 'patchright' : 'chromium';

let fake;
before(async () => { fake = await startFakeMeet(); });
after(async () => { await fake.close(); });

async function withService(fn) {
  const audio = fakeAudio();
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 } });
  try {
    const c = await connect(svc);
    const s = await c.open({ profile: 'google', engine: PROFILE_ENGINE }); // where a person signed in to Google earlier
    await c.call('session_close', { session: s });
    return await fn(svc, c, audio);
  } finally { await svc.stop(); }
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();

test('a host who lands in the Meet call mutes both devices before announcing and recording', async () => {
  await withService(async (svc, c, audio) => {
    const { code, url } = fake.newRoom();
    fake.set(code, { signedIn: true, direct: true, lang: 'de' });
    const r = await c.call('meeting_join', { url, profile: 'google' });
    assert.equal(r.isError, false, r.text);
    const { meeting_id: id, state, joined_as } = r.json();
    assert.equal(state, 'admitted');
    assert.equal(joined_as, 'account');
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    const { guest, log, media } = fake.room(code);
    assert.equal(guest, null);
    const notice = log.find(([action]) => action === 'chat');
    assert.ok(notice);
    assert.deepEqual(media.map(({ mic, cam }) => [mic, cam]), [[false, undefined], [undefined, false]]);
    assert.ok(media.every(({ at }) => at <= notice[1]));
    assert.ok(notice[1] <= audio.recorders[0].startedAt);
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('direct Meet entry with a share-link modal and a camera problem works in dry run and starts a normal join', async () => {
  await withService(async (svc, c, audio) => {
    const { code, url } = fake.newRoom();
    fake.set(code, { signedIn: true, direct: true, shareDialog: true, cameraProblem: true });
    const d = await c.call('meeting_join', { url, profile: 'google', dry_run: true });
    assert.equal(d.isError, false, d.text);
    const { state, lobby, join_button, microphone, camera, note } = d.json();
    assert.deepEqual({ state, lobby, join_button, microphone, camera },
      { state: 'admitted', lobby: null, join_button: null, microphone: 'off', camera: 'no device' });
    assert.match(note, /Meet admitted/);
    assert.equal(svc.manager.sessions.size, 0);
    assert.equal(audio.recorders.length, 0);
    const room = fake.room(code);
    assert.deepEqual(room.media.map(({ at, ...action }) => action), [{ shareClosed: true }, { mic: false }]);

    const r = await c.call('meeting_join', { url, profile: 'google' });
    assert.equal(r.isError, false, r.text);
    const id = r.json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    assert.deepEqual(room.media.slice(2).map(({ at, ...action }) => action), [{ shareClosed: true }, { mic: false }]);
    assert.equal(room.guest, null);
    assert.equal((await status(c, id)).announce.sent_to, 'everyone');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a host whose in-call microphone stays on is disconnected before chat or recording', async () => {
  await withService(async (svc, c, audio) => {
    const { code, url } = fake.newRoom();
    fake.set(code, { signedIn: true, direct: true, micStuckOn: true });
    const r = await c.call('meeting_join', { url, profile: 'google' });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /could not confirm the microphone is off after Meet admitted the profile/);
    await until(() => svc.manager.sessions.size === 0 && audio.stats.closed === 1);
    assert.equal(fake.room(code).chat.length, 0);
    assert.equal(audio.recorders.length, 0);
    await c.close();
  });
});

test('Meet dry run reports the visible Join now and Ask to join buttons; Ask to join still waits', async () => {
  await withService(async (svc, c) => {
    const host = fake.newRoom();
    fake.set(host.code, { signedIn: true, open: true });
    const guest = fake.newRoom();
    for (const [{ code, url }, label, kind] of [[host, 'Join now', 'account'], [guest, 'Ask to join', 'guest']]) {
      const r = await c.call('meeting_join', { url, profile: 'google', dry_run: true });
      assert.equal(r.isError, false, r.text);
      const { state, lobby, join_button } = r.json();
      assert.deepEqual({ state, lobby, join_button }, { state: 'lobby', lobby: kind, join_button: label });
      assert.equal(fake.room(code).guest, null);
    }
    const r = await c.call('meeting_join', { url: guest.url, profile: 'google' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().state, 'waiting');
    assert.equal(fake.room(guest.code).via, 'ask');
    await c.call('meeting_leave', { meeting_id: r.json().meeting_id });
    await c.close();
  });
});

test('the lobby kind: a name field is a guest; no name field with the account shown (or no "Sign in") is the account', async () => {
  await withService(async (svc, c) => {
    const s = await c.open();
    const page = svc.manager.sessions.get(s).page;
    const kind = async (opts) => {
      const { code, url } = fake.newRoom();
      fake.set(code, opts);
      await page.goto(url);
      await until(async () => (await page.getByRole('button', { name: /join|teilnahme|wechseln|switch/i }).first().isVisible()), 5000);
      return meetPrejoin(page);
    };
    assert.equal(await kind({}), 'guest');
    assert.equal(await kind({ lang: 'de' }), 'guest');
    assert.equal(await kind({ bareName: true }), 'guest');
    assert.equal(await kind({ signedIn: true, account: true }), 'account');
    assert.equal(await kind({ signedIn: true, account: true, lang: 'de' }), 'account');
    assert.equal(await kind({ signedIn: true }), 'account'); // neither a name field nor "Sign in"
    assert.equal(await kind({ signedIn: true, elsewhere: true, account: true }), 'account');
    await page.setContent('<p>nothing here</p>');
    assert.equal(await meetPrejoin(page), null);
    await c.close();
  });
});

test('signed in, as on real Meet: a dialog over the lobby is closed, "Join now" waited for while disabled, name not used; joined_as account', async () => {
  await withService(async (svc, c) => {
    for (const lang of ['en', 'de']) {
      const { code, url } = fake.newRoom();
      fake.set(code, { lang, signedIn: true, account: true, dialog: true, readyMs: 3000, open: true });
      const r = await c.call('meeting_join', { url, profile: 'google', name: 'Ignored Name' });
      assert.equal(r.isError, false, `${lang}: ${r.text}`);
      const j = r.json();
      assert.equal(j.joined_as, 'account', lang);
      assert.deepEqual(fake.room(code).guest, { name: null, mic: false, cam: false }, lang);
      assert.equal(fake.room(code).via, 'ask', lang);
      await until(async () => (await status(c, j.meeting_id)).state === 'recording', 15_000);
      await c.call('meeting_leave', { meeting_id: j.meeting_id });
    }
    await c.close();
  });
});

test('signed in and already in the call on another device: "Join here too" (under "Other ways to join") rather than "Switch here"', async () => {
  await withService(async (svc, c) => {
    for (const lang of ['en', 'de']) {
      const { code, url } = fake.newRoom();
      fake.set(code, { lang, signedIn: true, account: true, elsewhere: true });
      const r = await c.call('meeting_join', { url, profile: 'google' });
      assert.equal(r.isError, false, `${lang}: ${r.text}`);
      assert.equal(r.json().state, 'waiting');
      assert.equal(fake.room(code).via, 'too', lang);
      await c.call('meeting_leave', { meeting_id: r.json().meeting_id });
    }
    await c.close();
  });
});

test('a guest lobby with a dialog over it still joins as a guest with the name given', async () => {
  await withService(async (svc, c) => {
    const { code, url } = fake.newRoom();
    fake.set(code, { dialog: true });
    const r = await c.call('meeting_join', { url, name: 'Notes Bot' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json().joined_as, 'guest');
    assert.deepEqual(fake.room(code).guest, { name: 'Notes Bot', mic: false, cam: false });
    await c.call('meeting_leave', { meeting_id: r.json().meeting_id });
    await c.close();
  });
});

test('Meet state in the call comes from dialogs only: a caption or meeting title saying "ended" or "removed" changes nothing', async () => {
  await withService(async (svc, c) => {
    const { code, url } = fake.newRoom();
    fake.set(code, { signedIn: true, open: true, title: 'You’ve been removed from the meeting (retro)' });
    const id = (await c.call('meeting_join', { url, profile: 'google' })).json().meeting_id;
    await until(async () => (await status(c, id)).state === 'recording', 15_000);
    fake.caption(code, 'Alex: the call has ended, said nobody');
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal((await status(c, id)).state, 'recording');
    fake.end(code);
    await until(async () => (await status(c, id)).state === 'ended', 10_000);
    assert.equal((await status(c, id)).reason, 'meeting-ended');
    await c.close();
  });
});

test('Meet: "Join here too" offered directly (without "Other ways to join") is found', async () => {
  await withService(async (svc, c) => {
    const s = await c.open();
    const page = svc.manager.sessions.get(s).page;
    await page.setContent('<h1>You’re in this call on another device</h1><button>Join here too</button><button>Switch here</button>');
    assert.equal(await meetPrejoin(page), 'account');
    assert.equal((await meet.joinButton(page)).label, 'Join here too');
    assert.equal(await meet.state(page), 'lobby');
    await c.close();
  });
});
