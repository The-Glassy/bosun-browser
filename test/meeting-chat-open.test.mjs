// The Meet chat as the 0.20.0 fix handles it (live Meet 2026-11-02: in a five-person call the announcement failed with
// "the Meet chat panel did not open"): the chat button as a toggle, a click Meet ignores while the call settles, a
// toolbar that only shows on a mouse move, no button (Ctrl+Alt+C), the chat in a frame, a chat this participant may
// not post in, Enter that does not send, a message that never shows up, and what the error says when nothing works.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect, until, sleep } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { announcement } from '../src/meetings/index.mjs';

let fake;
before(async () => { fake = await startFakeMeet(); });
after(async () => { await fake.close(); });

async function withService(fn) {
  const audio = fakeAudio();
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 } });
  const ev = { announce: [] };
  svc.events.on('meeting-announce', (e) => ev.announce.push(e));
  const c = await connect(svc);
  try { return await fn(svc, c, ev); } finally { await c.close(); await svc.stop(); }
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();
const [EN, DE] = announcement('Glassy (notetaker)', null);

// Joins a room with the given options and waits for the announcement to be settled (sent or failed).
async function join(c, opts) {
  const { code, url } = fake.newRoom();
  fake.set(code, { open: true, ...opts });
  const j = (await c.call('meeting_join', { url })).json();
  await until(async () => (await status(c, j.meeting_id)).announce.sent_to !== null, 60_000);
  return { code, id: j.meeting_id, s: await status(c, j.meeting_id) };
}

for (const [what, opts] of [
  ['a chat button Meet ignores for the first 2.5 s of the call', { chatReadyMs: 2500 }],
  ['a toolbar that is invisible until the mouse moves', { chatUi: 'hiddenToolbar' }],
  ['no chat button at all (Ctrl+Alt+C opens the panel)', { chatUi: 'noButton' }],
  ['the chat box and messages inside a frame', { chatUi: 'frame' }],
  ['Enter that adds a line break (the send button sends)', { chatUi: 'enterNewline' }],
]) {
  test(`Meet chat: the announcement is posted with ${what}`, async () => {
    await withService(async (svc, c) => {
      const { code, id, s } = await join(c, opts);
      assert.deepEqual([s.announce.sent_to, s.announce.reason], ['everyone', undefined], JSON.stringify(s.announce));
      assert.deepEqual(fake.room(code).chat.map((m) => m.text), [EN, DE]);
      // A later post goes out too, without the toggle closing the panel that is already open.
      const r = await c.call('meeting_chat_send', { meeting_id: id, text: 'A short clarification.' });
      assert.equal(r.isError, false, r.text);
      assert.equal(fake.room(code).chat.at(-1).text, 'A short clarification.');
      assert.equal(s.chat_error, undefined);
    });
  });
}

test('Meet chat: a chat this participant may not post in is chat-restricted, with what the panel said', async () => {
  await withService(async (svc, c, ev) => {
    const { code, s } = await join(c, { chatUi: 'blocked' });
    assert.deepEqual([s.announce.sent_to, s.announce.reason], ['failed', 'chat-restricted']);
    assert.match(s.announce.failures[0].error, /Let participants send messages" is off|only hosts can send messages/);
    assert.deepEqual(fake.room(code).chat, []);
    assert.equal(ev.announce.length, 1);
  });
});

test('Meet chat: a message that leaves the box but never shows up is not-confirmed (not reported as posted)', async () => {
  await withService(async (svc, c) => {
    const { s } = await join(c, { chatUi: 'lost' });
    assert.deepEqual([s.announce.sent_to, s.announce.reason], ['failed', 'not-confirmed']);
    assert.match(s.announce.failures[0].error, /did not show up in the chat/);
  });
});

test('Meet chat: a panel that never opens is chat-unavailable, the error says what the page showed, and the second try is short', async () => {
  await withService(async (svc, c) => {
    const t0 = Date.now();
    const { s } = await join(c, { chatReadyMs: 10 * 60_000 });
    const took = Date.now() - t0;
    assert.deepEqual([s.announce.sent_to, s.announce.reason], ['failed', 'chat-unavailable']);
    assert.match(s.announce.failures[0].error, /the Meet chat panel did not open \(chat button "Chat with everyone" pressed=false; side panel .*; .*\)/);
    // 20 s at the join, 5 s more for the announcement itself (plus joining), not 2 x 20 s.
    assert.ok(took < 38_000, `announcement settled after ${took} ms`);
    assert.equal(s.state, 'recording', 'records anyway, as before');
  });
});
