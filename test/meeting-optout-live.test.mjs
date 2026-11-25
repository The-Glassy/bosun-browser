// The opt-out that fired on Bosun's own announcement (live Meet, 2026-10-23 10:07, 0.10.1): the chat panel showed
// our message with no sender, as "10:07 AM: <text>\nHover over a message to pin it\nkeep\nkeep\nPin message", so it
// was not recognised as ours; the default text quotes "please don't record", and a custom one said
// 'To opt out, write "stop" + "recording" here.', and both were taken for objections. Recording deleted, bot gone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect, until, sleep, ENGINE } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { startFakeZoom } from './fakezoom.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { zoom, zoomWebClientUrl } from '../src/meetings/platforms/zoom.mjs';
import { cleanChatText, cleanSender } from '../src/meetings/platforms/common.mjs';
import { matchOptOut, normalize } from '../src/meetings/optout.mjs';
import { Meetings, announcement, CONFIRM_DELETED } from '../src/meetings/index.mjs';

const PROFILE_ENGINE = ENGINE === 'patchright' ? 'patchright' : 'chromium';
const BUBBLE = (text) => `10:07 AM: ${text}\nHover over a message to pin it\nkeep\nkeep\nPin message`;
const CUSTOM = 'Hi, I am Glassy, an AI notetaker; this call is recorded for notes. To opt out, write "stop" + "recording" here. / Hallo, ich bin Glassy und nehme für Notizen auf; zum Abmelden hier „stop recording“ schreiben.';

test('chat text: the UI around a live Meet bubble is gone; times and controls are no sender', () => {
  assert.equal(cleanChatText(BUBBLE("please don't record")), "please don't record");
  assert.equal(cleanChatText('10:07: Hallo zusammen'), 'Hallo zusammen');
  assert.equal(cleanChatText('Line one\nline two\nPin message'), 'Line one\nline two');
  assert.equal(cleanChatText('keep\nkeep'), '');
  assert.equal(cleanSender('10:07 AM'), null);
  assert.equal(cleanSender('keep'), null);
  assert.equal(cleanSender('Alex Example'), 'Alex Example');
  assert.equal(cleanSender('Host Person 10:07 AM'), 'Host Person');
});

test('matcher: our announcements (default EN/DE, the live custom one, the confirmation) are no opt-out; requests still are', () => {
  for (const t of [...announcement('Glassy (notetaker)', 'Mykhailo'), ...announcement('Bosun', null), CUSTOM, CONFIRM_DELETED,
    'To opt out, write "stop" + "recording" here.', 'Zum Abmelden hier schreiben.', 'If you would rather not be recorded, write "please don\'t record".']) {
    assert.equal(matchOptOut(cleanChatText(BUBBLE(t))), null, t);
  }
  assert.equal(matchOptOut('Type "stop recording. Please don\'t record." to opt out.'), null); // a sentence end inside the quote
  for (const t of ["please don't record", "'please don't record'", '"stop recording"', 'Stop recording!', 'bitte nicht aufnehmen', '„bitte nicht aufnehmen“',
    'Please, stop the recording', 'Can you stop recording please',
    // Requests that only look like instructions or quotes (review of the first fix).
    'I want to opt out, please stop recording', 'If you would please stop recording, I do not consent to being recorded', 'Please "stop recording"',
    '"please don\'t record", thanks', "Don't stop recording.I do not consent to being recorded.", 'Can you write the summary and stop recording',
    // Second review: an explanation never covers the objection next to it; a quoted veto never cancels one.
    'To opt out, write "stop recording", but I do not consent to being recorded.', 'If you can write the minutes, please stop recording',
    'You said "keep recording." I do not consent to being recorded.']) {
    assert.ok(matchOptOut(cleanChatText(BUBBLE(t))), t);
  }
});

// The meeting manager's chat loop on its own: the panel hands back our announcement as the live page did.
test('pollChat: our own announcement echoed back (no sender, UI text around it) is neither an event nor an objection', async () => {
  const sentTexts = [...announcement('Glassy (notetaker)', 'Mykhailo'), CUSTOM];
  for (const echoed of sentTexts) {
    const events = [], optouts = [];
    const queue = [{ id: '1', sender: null, text: BUBBLE(echoed) }, { id: '2', sender: '10:07 AM', text: BUBBLE('Hi all') },
      { id: '3', sender: 'Alex Example', text: BUBBLE("please don't record") }];
    const m = { name: 'Glassy (notetaker)', info: {}, chat: [], chatSeq: 0, chatTexts: new Map(), pendingOwn: [], echoes: new Map(sentTexts.map((t) => [t, { count: 1, until: 0, norm: normalize(t) }])), optedOut: null, state: 'recording',
      platform: { drainChat: async () => queue.splice(0) } };
    const fake = Object.assign(Object.create(Meetings.prototype), {
      now: Date.now, page: async (_m, fn) => fn(null), emit: (_m, kind, data) => events.push([kind, data]), optOut: async (_m, entry) => { optouts.push(entry); },
    });
    await fake.pollChat(m);
    assert.deepEqual(events.map(([, d]) => [d.sender, d.text]), [[null, 'Hi all'], ['Alex Example', "please don't record"]], echoed);
    assert.deepEqual(optouts.map((e) => e.text), ["please don't record"], echoed);
  }
  // Taken out, not dropped: a senderless message that pastes our announcement and adds a request keeps the request.
  // A short message of ours echoed back is ours; the same words from a named participant are theirs.
  const ann = announcement('Glassy (notetaker)', null)[0];
  const run = async (sent, queue) => {
    const events = [], optouts = [];
    const m = { name: 'Glassy (notetaker)', info: {}, chat: [], chatSeq: 0, chatTexts: new Map(), pendingOwn: [], echoes: new Map(sent.map((t) => [t, { count: 1, until: Date.now() + 60_000, norm: normalize(t) }])), optedOut: null, state: 'recording',
      platform: { drainChat: async () => queue.splice(0) } };
    const fake = Object.assign(Object.create(Meetings.prototype), { now: Date.now, page: async (_m, fn) => fn(null), emit: (_m, k, d) => events.push(d), optOut: async (_m, e) => { optouts.push(e); } });
    await fake.pollChat(m);
    return { events, optouts };
  };
  let r = await run([ann], [{ id: '1', sender: null, text: BUBBLE(`${ann}\nPlease stop recording.`) }]);
  assert.equal(r.optouts.length, 1);
  assert.equal(r.events.length, 1);
  r = await run(['Не записуй'], [{ id: '1', sender: null, text: BUBBLE('Не записуй') }]);
  assert.deepEqual([r.events, r.optouts], [[], []]);
  r = await run(['Не записуй'], [{ id: '1', sender: 'Oksana', text: BUBBLE('Не записуй') }]);
  assert.equal(r.optouts.length, 1);
  // A short post ("No") never takes words out of someone's message.
  r = await run(['No'], [{ id: '1', sender: null, text: BUBBLE('I do not consent to being recorded') }]);
  assert.equal(r.optouts.length, 1);
  // Within a minute of posting: whole copies of a post are ours however often they come, but a short post never
  // takes words out of someone's message, and once the minute is over the same words are someone's.
  const fresh = async (sent, queue, now = Date.now()) => {
    const events = [], optouts = [];
    const m = { name: 'Glassy (notetaker)', info: {}, chat: [], chatSeq: 0, chatTexts: new Map(), pendingOwn: [], optedOut: null, state: 'recording',
      echoes: new Map(sent.map((t) => [t, { count: 1, until: now + 60_000, norm: normalize(t) }])), platform: { drainChat: async () => queue.splice(0) } };
    const fake = Object.assign(Object.create(Meetings.prototype), { now: () => now, page: async (_m, fn) => fn(null), emit: (_m, k, d) => events.push(d), optOut: async (_m, e) => { optouts.push(e); } });
    await fake.pollChat(m);
    return { events, optouts, m, fake };
  };
  r = await fresh([ann], [{ id: 'a', sender: null, text: BUBBLE(ann) }, { id: 'b', sender: null, text: BUBBLE(ann) }]);
  assert.deepEqual([r.events, r.optouts], [[], []]); // rendered twice: both ours
  r = await fresh(['recording'], [{ id: 'a', sender: null, text: BUBBLE('recording') }, { id: 'b', sender: null, text: BUBBLE('Please stop recording') }]);
  assert.equal(r.optouts.length, 1); // "recording" is not taken out of the request
  r = await fresh(['recording'], [{ id: 'b', sender: null, text: BUBBLE('Please stop recording') }, { id: 'a', sender: null, text: BUBBLE('recording') }]);
  assert.equal(r.optouts.length, 1); // nor before its own echo arrived (a short post is ours only as a whole copy)
  r = await fresh(['Не записуй'], [{ id: 'a', sender: null, text: BUBBLE('Не записуй') }]);
  assert.equal(r.events.length, 0);
  r.fake.now = () => Date.now() + 120_000; // two minutes later
  r.m.platform.drainChat = async () => [{ id: 'b', sender: null, text: BUBBLE('Не записуй') }];
  await r.fake.pollChat(r.m);
  assert.equal(r.optouts.length, 1);
});

let fm, fz;
before(async () => { fm = await startFakeMeet(); fz = await startFakeZoom(); });
after(async () => { await fm.close(); await fz.close(); });

const zoomAt = (base) => ({ ...zoom, accountUrl: `${base}/profile`, joinUrl: (u) => zoomWebClientUrl(u).replace('https://app.zoom.us', base), origins: () => [base] });
async function withService(fn) {
  const audio = fakeAudio();
  const z = zoomAt(fz.base);
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (u.startsWith(fm.base) ? meet : zoom.matches(u) ? z : null), pollMs: 200 } });
  const ev = { chat: [], optout: [], ended: [] };
  for (const k of Object.keys(ev)) svc.events.on(`meeting-${k}`, (e) => ev[k].push(e));
  try {
    const c = await connect(svc);
    await c.call('session_close', { session: await c.open({ profile: 'zoom', engine: PROFILE_ENGINE }) });
    return await fn(svc, c, ev);
  } finally { await svc.stop(); }
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();

test('Meet with live chat bubbles: Bosun keeps recording through its own announcement (default and custom); a participant still opts out', async () => {
  await withService(async (svc, c, ev) => {
    // Also with each of our messages rendered twice (as sent, then confirmed under a new id), as live Meet did.
    for (const [announce, liveChat] of [[undefined, true], [CUSTOM, true], [undefined, 'twice']]) {
      ev.chat.length = 0; ev.optout.length = 0;
      const { code, url } = fm.newRoom();
      fm.set(code, { liveChat, open: true });
      const j = (await c.call('meeting_join', { url, ...(announce ? { announce_text: announce } : {}) })).json();
      await until(async () => (await status(c, j.meeting_id)).state === 'recording', 15_000);
      await sleep(2500); // the 2–6 s in which the live bot had left
      const s = await status(c, j.meeting_id);
      assert.equal(s.state, 'recording', JSON.stringify(s));
      assert.equal(s.opted_out, undefined);
      assert.deepEqual(ev.optout, []);
      assert.deepEqual(ev.chat, [], 'our own messages are no chat events');
      fm.say(code, 'Alex Example', "please don't record");
      await until(() => ev.optout.length === 1, 10_000);
      assert.deepEqual([ev.optout[0].sender, ev.optout[0].text], ['Alex Example', "please don't record"]);
      assert.deepEqual(ev.chat.map((e) => [e.sender, e.text]), [['Alex Example', "please don't record"]]);
      await until(async () => (await status(c, j.meeting_id)).state === 'ended', 10_000);
    }
    await c.close();
  });
});

test('Zoom with live chat bubbles (our name "to Everyone" with a time): the announcement counts as posted and is no objection', async () => {
  await withService(async (svc, c, ev) => {
    const { id, url } = fz.newRoom({ liveChat: true, open: true, signedIn: true });
    const j = (await c.call('meeting_join', { url, profile: 'zoom' })).json();
    await until(async () => (await status(c, j.meeting_id)).state === 'recording', 20_000);
    await sleep(2500);
    assert.equal((await status(c, j.meeting_id)).state, 'recording');
    assert.deepEqual(ev.optout, []);
    assert.deepEqual(ev.chat, []);
    fz.say(id, 'Host Person', 'Stop recording please');
    await until(() => ev.optout.length === 1, 10_000);
    assert.deepEqual([ev.optout[0].sender, ev.optout[0].text], ['Host Person', 'Stop recording please']);
    await c.close();
  });
});
