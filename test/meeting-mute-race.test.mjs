// meeting_mute and a background retry of muting again (keepMuting), in the order the session queue runs them: a retry
// queued right behind meeting_mute { on: false } must find the microphone the agent's, and leave it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Meetings } from '../src/meetings/index.mjs';

// The session queue as SessionManager.run uses it (src/sessions.mjs): SerialQueue (each job starts on the settled tail
// of the one before), the job an async function around the page operation, run() itself async.
function queue() {
  let tail = Promise.resolve();
  const serial = (fn) => { const r = tail.then(fn); tail = r.then(() => {}, () => {}); return r; };
  return async (fn) => serial(async () => { try { const r = await fn(); return r; } finally { /* busy-- */ } });
}

test('a retry queued behind meeting_mute { on: false } leaves the microphone on', async () => {
  const P = Meetings.prototype;
  const clicks = [];
  const m = {
    id: 'm000000000001', state: 'recording', announceDone: { p: Promise.resolve() }, speech: null, speechUnmuted: true, muteError: 'could not turn the microphone off',
    platform: { setMic: async (p, on) => { clicks.push(on); return { state: on ? 'on' : 'off', changed: true }; } },
  };
  const run = queue();
  const ctx = { get: () => m, inCall: P.inCall, muteAgain: P.muteAgain, page: (mm, fn) => run(() => fn({ keyboard: { press: async () => {} }, waitForTimeout: async () => {} })) };
  let open;
  run(() => new Promise((r) => { open = r; })); // the page is busy
  const mute = P.mute.call(ctx, 'alice', m.id, false);
  await new Promise((r) => setImmediate(r));
  const retry = ctx.page(m, (p) => ctx.muteAgain(m, p));
  open();
  assert.deepEqual(await mute, { meeting_id: m.id, muted: false });
  assert.equal(await retry, null);
  assert.deepEqual(clicks, [true], 'the retry did not click');
  assert.equal(m.speechUnmuted, false);
  assert.equal(m.muteError, null);
});
