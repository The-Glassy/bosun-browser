// The Zoom lobby as it was live on 2026-10-23 13:23, when meeting_join failed in production (0.11.0) with "could not
// make sure the microphone is off before joining (Zoom changed?); not joining": after the "see you" question Zoom
// asked a second one ("Do you want people to hear you in the meeting?"), then showed "Mute" with a crossed microphone
// (no permission: nothing goes out), and clicking "Mute" did not toggle it but asked "hear you" again. Bosun waited for
// "Unmute", which never came. Now that question after its click means Zoom does not have the microphone; a
// microphone that takes clicks and neither mutes nor asks is still live, and Bosun still does not join.
//
// Run with and without fake capture devices: with them the browser lists a microphone and camera on every host, so the
// clicked-and-asked path is the one tested; without them it depends on the host (a server without devices: "no device").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBosun, connect, ENGINE } from './helpers.mjs';
import { fakeAudio } from './fakemeet.mjs';
import { startFakeZoom } from './fakezoom.mjs';
import { zoom, zoomWebClientUrl } from '../src/meetings/platforms/zoom.mjs';

const PROFILE_ENGINE = ENGINE === 'patchright' ? 'patchright' : 'chromium';
let fz;
before(async () => { fz = await startFakeZoom(); });
after(async () => { await fz.close(); });

const zoomAt = (base) => ({ ...zoom, accountUrl: `${base}/profile`, joinUrl: (u) => zoomWebClientUrl(u).replace('https://app.zoom.us', base), origins: () => [base] });

// fakeDevices: the browser gets Chromium's fake microphone and camera.
async function withService(fn, { fakeDevices = true } = {}) {
  const audio = fakeAudio();
  if (fakeDevices) {
    const open = audio.open.bind(audio);
    audio.open = async () => { const rig = await open(); rig.args = [...rig.args, '--use-fake-device-for-media-stream']; return rig; };
  }
  const z = zoomAt(fz.base);
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio, platformFor: (u) => (zoom.matches(u) ? z : null), pollMs: 200 } });
  try {
    const c = await connect(svc);
    await c.call('session_close', { session: await c.open({ profile: 'zoom', engine: PROFILE_ENGINE }) });
    fz.account(false);
    return await fn(c);
  } finally { fz.account(null); await svc.stop(); }
}
const used = (room) => room.media.filter((m) => m.devices === 'used');
const hearYou = (room) => room.media.filter((m) => m.devices === 'declined' && /hear you/.test(m.question || ''));

for (const fakeDevices of [true, false]) {
  for (const variant of ['both', 'mic']) {
    test(`Zoom 13:23 lobby (second question "${variant}", ${fakeDevices ? 'fake devices' : 'host devices'}): both questions declined, the crossed "Mute" counts as off, name typed, joined`, async () => {
      await withService(async (c) => {
        const { id, url } = fz.newRoom({ hearYou: variant, passcode: 'p1' });
        const r = await c.call('meeting_join', { url, profile: 'zoom', name: 'Glassy Notetaker' });
        assert.equal(r.isError, false, r.text);
        assert.equal(r.json().state, 'waiting');
        const room = fz.room(id);
        assert.deepEqual(room.guest, { name: 'Glassy Notetaker', mic: false, cam: false });
        assert.deepEqual(used(room), [], '"Use microphone…" is never clicked');
        assert.equal(room.media[0].devices, 'declined'); // "see you"
        assert.ok(hearYou(room).length >= 1, JSON.stringify(room.media));
        // With a microphone listed, "Mute" was clicked once and its question answered without the microphone.
        if (fakeDevices) assert.equal(hearYou(room).length, 2, JSON.stringify(room.media));
        await c.call('meeting_leave', { meeting_id: r.json().meeting_id });
        await c.close();
      }, { fakeDevices });
    });
  }
}

test('Zoom: a live microphone whose "Mute" takes clicks and stays on is not joined with', async () => {
  await withService(async (c) => {
    const { id, url } = fz.newRoom({ hearYou: 'both', micClick: 'stuck', passcode: 'p1' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /could not make sure the microphone is off before joining \(Zoom changed\?\); not joining/);
    assert.equal(fz.room(id).guest, null, 'Join was not clicked');
    assert.deepEqual(used(fz.room(id)), []);
    await c.close();
  });
});

test('Zoom: a camera question coming up after a click on a live microphone\'s "Mute" does not make the microphone off', async () => {
  await withService(async (c) => {
    const { id, url } = fz.newRoom({ hearYou: 'both', micClick: 'asksCamera', passcode: 'p1' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /could not make sure the microphone is off before joining/);
    assert.equal(fz.room(id).guest, null, 'Join was not clicked');
    assert.ok(fz.room(id).media.some((m) => m.devices === 'declined' && /see you/.test(m.question || '')), 'the camera question was answered');
    assert.deepEqual(used(fz.room(id)), []);
    await c.close();
  });
});

test('Zoom: a live microphone that mutes on "Mute" is muted, then joined', async () => {
  await withService(async (c) => {
    const { id, url } = fz.newRoom({ hearYou: 'mic', micClick: 'toggles', passcode: 'p1' });
    const r = await c.call('meeting_join', { url, profile: 'zoom' });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(fz.room(id).guest, { name: 'Glassy (notetaker)', mic: false, cam: false });
    assert.deepEqual(used(fz.room(id)), []);
    await c.call('meeting_leave', { meeting_id: r.json().meeting_id });
    await c.close();
  });
});

test('Zoom dry_run on the 13:23 lobby: questions declined, the microphone and camera as seen, nothing clicked or typed', async () => {
  await withService(async (c) => {
    const { id, url } = fz.newRoom({ hearYou: 'both', passcode: 'p1' });
    const d = (await c.call('meeting_join', { url, profile: 'zoom', dry_run: true })).json();
    assert.equal(d.state, 'lobby');
    assert.equal(d.join_enabled, false);
    assert.deepEqual(d.name_field, { prefilled: null });
    assert.equal(d.microphone.control, 'Mute');
    assert.equal(d.camera.control, 'Stop Video');
    assert.ok(d.microphone.devices >= 1 && d.camera.devices >= 1, JSON.stringify(d));
    assert.deepEqual(used(fz.room(id)), []);
    assert.equal(fz.room(id).guest, null);
    await c.close();
  });
});
