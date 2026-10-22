// Google Meet with a signed-in profile, as it behaves for a real signed-in account (the cases behind the "locator.click
// timeout" of the first live signed-in join): no name field, the account shown, a dialog over the lobby that takes
// the click, a join button disabled while Meet is "Getting ready...", and the account already in the call on another
// device ("Switch here" / "Join here too"). Also the lobby kind detection (guest or account) on its own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect, until } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { meet, meetPrejoin } from '../src/meetings/platforms/meet.mjs';

let fake;
before(async () => { fake = await startFakeMeet(); });
after(async () => { await fake.close(); });

async function withService(fn) {
  const audio = fakeAudio();
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 } });
  try {
    const c = await connect(svc);
    const s = await c.open({ profile: 'google', engine: 'chromium' }); // where a person signed in to Google earlier
    await c.call('session_close', { session: s });
    return await fn(svc, c);
  } finally { await svc.stop(); }
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();

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
