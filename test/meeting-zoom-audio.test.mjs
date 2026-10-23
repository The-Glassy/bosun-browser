// The Zoom call as it was live on 2026-10-23 15:00, after production (0.11.1) had failed at 14:45 with "could not join
// computer audio in Zoom (nothing would be heard or recorded); Zoom changed?": let in without a microphone (a server
// without devices), Zoom connects computer audio by itself. There is no "Join Audio" and no "Mute"/"Unmute": the
// toolbar shows "Audio" (a microphone with a warning sign) and "More audio controls", whose menu offers "Switch to phone
// audio" and "Leave computer audio". Bosun waited for "Join Audio" or a mute control. Now that menu is read (and
// closed): leaving computer audio on offer means it is connected. Zoom's notices over the call are closed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect, until, ENGINE } from './helpers.mjs';
import { fakeAudio } from './fakemeet.mjs';
import { startFakeZoom } from './fakezoom.mjs';
import { zoom, zoomWebClientUrl } from '../src/meetings/platforms/zoom.mjs';
import { announcement } from '../src/meetings/index.mjs';

const PROFILE_ENGINE = ENGINE === 'patchright' ? 'patchright' : 'chromium';
let fz;
before(async () => { fz = await startFakeZoom(); });
after(async () => { await fz.close(); });

const zoomAt = (base) => ({ ...zoom, accountUrl: `${base}/profile`, joinUrl: (u) => zoomWebClientUrl(u).replace('https://app.zoom.us', base), origins: () => [base] });

async function withService(fn) {
  const audio = fakeAudio();
  const z = zoomAt(fz.base);
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (zoom.matches(u) ? z : null), pollMs: 200 } });
  const ended = [];
  svc.events.on('meeting-ended', (e) => ended.push(e));
  try {
    const c = await connect(svc);
    await c.call('session_close', { session: await c.open({ profile: 'zoom', engine: PROFILE_ENGINE }) });
    fz.account(false);
    return await fn(c, { audio, ended });
  } finally { fz.account(null); await svc.stop(); }
}
const status = async (c, id) => (await c.call('meeting_status', { meeting_id: id })).json();
const LIVE = { hearYou: 'both', audioJoined: true, noDeviceList: true, open: true, passcode: 'p1', title: "Mykhailo Buialo's Zoom Meeting" };

test('Zoom 15:00: computer audio Zoom connected by itself ("Audio", its menu offering "Leave computer audio") counts as joined; notices closed; announced, then recording', async () => {
  await withService(async (c, { audio }) => {
    const { id, url } = fz.newRoom(LIVE);
    const r = await c.call('meeting_join', { url, profile: 'zoom', name: 'Glassy Notetaker' });
    assert.equal(r.isError, false, r.text);
    const mid = r.json().meeting_id;
    await until(async () => ['recording', 'ended'].includes((await status(c, mid)).state), 40_000);
    const st = await status(c, mid);
    assert.equal(st.state, 'recording', st.error);
    const room = fz.room(id);
    assert.deepEqual(room.guest, { name: 'Glassy Notetaker', mic: false, cam: false });
    assert.deepEqual(room.media.filter((m) => m.devices === 'used'), [], '"Use microphone…" is never clicked');
    // Not "Audio" (it would ask for the microphone), not "Video", not Chrome's <permission> element, nothing in the menu.
    assert.deepEqual(room.media.filter((m) => m.clicked), []);
    assert.deepEqual(room.media.filter((m) => m.toast).map((m) => m.toast).sort(), ['t1', 't2', 't4']);
    assert.deepEqual(room.chat.map((m) => m.text), announcement('Glassy Notetaker', null));
    const announcedAt = room.log.filter((l) => l[0] === 'chat').at(-1)[1];
    assert.ok(audio.recorders[0].startedAt >= announcedAt, 'recording started only after the announcement');
    await c.call('meeting_leave', { meeting_id: mid });
    await c.close();
  });
});

test('Zoom: "Audio" whose menu offers neither leaving computer audio nor phone audio is not taken as joined', async () => {
  await withService(async (c, { audio, ended }) => {
    const { id, url } = fz.newRoom({ ...LIVE, audioJoined: 'notConnected' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    await until(() => ended.length === 1, 40_000);
    assert.equal(ended[0].reason, 'error');
    assert.match(ended[0].error, /could not join computer audio in Zoom \(nothing would be heard or recorded\); Zoom changed\? \(audio controls: audio, More audio controls\)/);
    assert.equal(audio.recorders.length, 0);
    assert.deepEqual(fz.room(id).media.filter((m) => m.clicked), []);
    await c.close();
  });
});

// Codex: a participant named "Leave computer audio" in a menu already shown is not the audio menu's entry.
test('Zoom: "Leave computer audio" in another menu (a participant\'s name) does not count as computer audio joined', async () => {
  await withService(async (c, { audio, ended }) => {
    const { url } = fz.newRoom({ ...LIVE, audioJoined: 'notConnected', decoyMenu: true });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    await until(() => ended.length === 1, 40_000);
    assert.match(ended[0].error || '', /could not join computer audio in Zoom/);
    assert.equal(audio.recorders.length, 0);
    await c.close();
  });
});

// Codex: a caption reading like Zoom's notice is participants' speech: the captions panel's close button stays.
test('Zoom: a caption saying "Please enable access to your microphone and camera…" closes nothing', async () => {
  await withService(async (c) => {
    const { id, url } = fz.newRoom({ ...LIVE, captionClose: true, caption: 'Please enable access to your microphone and camera for the best experience.' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    const mid = r.json().meeting_id;
    await until(async () => ['recording', 'ended'].includes((await status(c, mid)).state), 40_000);
    assert.equal((await status(c, mid)).state, 'recording');
    assert.deepEqual(fz.room(id).media.filter((m) => m.clicked), []);
    assert.deepEqual(fz.room(id).media.filter((m) => m.toast).map((m) => m.toast).sort(), ['t1', 't2', 't4']);
    await c.call('meeting_leave', { meeting_id: mid });
    await c.close();
  });
});

// Codex pass 2: a participant renamed "Leave computer audio" in a menu that was already open, while the audio menu is.
test('Zoom: a row of a menu already open that reads "Leave computer audio" only while the audio menu is open does not count', async () => {
  await withService(async (c, { audio, ended }) => {
    const { url } = fz.newRoom({ ...LIVE, audioJoined: 'notConnected', decoyMenu: 'renames' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    await until(() => ended.length === 1, 40_000);
    assert.match(ended[0].error || '', /could not join computer audio in Zoom/);
    assert.equal(audio.recorders.length, 0);
    await c.close();
  });
});

// Codex pass 2: Zoom may keep the closed menu in the page, hidden by visibility or opacity.
for (const menuHide of ['visibility', 'opacity']) test(`Zoom: an audio menu closed by ${menuHide} (kept in the page) is still read`, async () => {
  await withService(async (c) => {
    const { id, url } = fz.newRoom({ ...LIVE, menuHide });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    const mid = r.json().meeting_id;
    await until(async () => ['recording', 'ended'].includes((await status(c, mid)).state), 40_000);
    const st = await status(c, mid);
    assert.equal(st.state, 'recording', st.error);
    assert.deepEqual(fz.room(id).media.filter((m) => m.clicked), []);
    await c.call('meeting_leave', { meeting_id: mid });
    await c.close();
  });
});
