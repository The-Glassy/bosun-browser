// recording_get (0.18.1): the notetaker flow without ElevenLabs (join, record, leave, fetch the audio, ffprobe it) and the
// one-time GET URL for a recording: the tenant's own only, spent by its first use, expiring, refused while the recording
// is still being written and once it is deleted. Against the Meet stand-in with a fake audio backend whose recorder
// writes a real Ogg/Opus file (ffmpeg), so the fetched bytes can be probed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { startBosun, connect, until, sleep, tmpDir, TOKEN, TOKEN_B } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';
import { EPHEMERAL_TOOLS } from '../src/tools.mjs';

const TOKEN_E = 'test-token-eeeeeeeeeeeeeeee';
const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const SECONDS = 3;

let fake, ogg;
before(async () => {
  fake = await startFakeMeet();
  ogg = path.join(tmpDir(), 'tone.ogg');
  if (HAVE_FFMPEG) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', ogg]);
  else fs.writeFileSync(ogg, Buffer.concat([Buffer.from('OggS'), Buffer.alloc(4000, 7)]));
});
after(async () => { await fake.close(); });

// The stand-in's audio backend, except that the recorder's file is a real recording (written when it is stopped).
function audioWithRealFile() {
  const audio = fakeAudio();
  const open = audio.open.bind(audio);
  audio.open = async () => {
    const rig = await open();
    const record = rig.record.bind(rig);
    rig.record = (file) => {
      const rec = record(file);
      const stop = rec.stop;
      rec.stop = async () => { await stop(); fs.copyFileSync(ogg, file); fs.chmodSync(file, 0o600); };
      return rec;
    };
    return rig;
  };
  return audio;
}

// No ElevenLabs key anywhere: the notetaker mode needs none.
async function withService(fn, env = {}) {
  const audio = audioWithRealFile();
  const svc = await startBosun({
    KEEPALIVE: '0', ELEVENLABS_API_KEY: '', BROWSER_TOKENS: `alice:${TOKEN},bob:${TOKEN_B},swarm:${TOKEN_E}`, BROWSER_TOKEN_POLICIES: 'swarm=ephemeral', ...env,
  }, { meetings: { audio, platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 } });
  try { return await fn(svc); } finally { await svc.stop(); }
}

// A recording of an earlier run of the service (not in memory), last written `ageMin` minutes ago.
function earlierRun(svc, tenant, id, ageMin = 10) {
  const dir = path.join(svc.dataDir, 'recordings', tenant);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}.ogg`);
  fs.copyFileSync(ogg, f);
  const t = new Date(Date.now() - ageMin * 60_000);
  fs.utimesSync(f, t, t);
  return f;
}

const get = (url, headers = {}) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => {
    const parts = [];
    res.on('data', (d) => parts.push(d));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', reject);
});

// Joins a fresh room as alice (guest, nothing else asked for), waits until it records.
async function recording(svc, c) {
  const { code, url } = fake.newRoom();
  fake.open(code);
  const r = await c.call('meeting_join', { url });
  assert.equal(r.isError, false, r.text);
  const id = r.json().meeting_id;
  await until(async () => (await c.call('meeting_status', { meeting_id: id })).json().state === 'recording', 15_000);
  return { id, code };
}
const leave = async (c, id) => assert.equal((await c.call('meeting_leave', { meeting_id: id })).json().state, 'ended');

test('notetaker mode without an ElevenLabs key: join, record, leave, recording_get, download, ffprobe', async () => {
  await withService(async (svc) => {
    assert.ok(!svc.cfg.elevenlabs?.apiKey && !process.env.ELEVENLABS_API_KEY, 'no ElevenLabs key in this test');
    const c = await connect(svc);
    const { id } = await recording(svc, c);
    // Still being written: refused, whoever asks.
    const early = await c.call('recording_get', { meeting_id: id });
    assert.equal(early.isError, true);
    assert.match(early.text, /still recording/);
    await leave(c, id);
    const s = (await c.call('meeting_status', { meeting_id: id })).json();
    assert.equal(s.state, 'ended');
    assert.match(s.recording.next, new RegExp(`recording_get.*${id}`));
    const g = await c.call('recording_get', { meeting_id: id });
    assert.equal(g.isError, false, g.text);
    const j = g.json();
    assert.equal(j.filename, `${id}.ogg`);
    assert.equal(j.mime, 'audio/ogg');
    assert.equal(j.valid_min, 15);
    assert.equal(j.size, fs.statSync(ogg).size);
    assert.match(j.get_url, new RegExp(`^http://127\\.0\\.0\\.1:${svc.ws.port}/recording/${id}\\?t=`));
    assert.match(j.curl, new RegExp(`^curl -sS --fail-with-body -o '${id}\\.ogg' 'http://127\\.0\\.0\\.1:${svc.ws.port}/recording/${id}\\?t=`));
    const res = await get(j.get_url);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'audio/ogg');
    assert.equal(res.headers['content-disposition'], `attachment; filename="${id}.ogg"`);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.body, fs.readFileSync(ogg));
    if (HAVE_FFMPEG) {
      const out = path.join(tmpDir(), `${id}.ogg`);
      fs.writeFileSync(out, res.body);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,channels,sample_rate', '-of', 'json', out]).toString());
      assert.equal(probe.streams[0].codec_name, 'opus');
      assert.equal(probe.streams[0].channels, 1);
      assert.ok(Math.abs(Number(probe.format.duration) - SECONDS) < 0.5, `duration ${probe.format.duration}`);
    }
    // The recording itself stays (retention decides), unlike a download.
    assert.ok(fs.existsSync(s.recording.path));
    await c.close();
  });
});

test('one-time: a second GET of the same URL is refused, and recording_get gives a new URL for the kept file', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const { id } = await recording(svc, c);
    await leave(c, id);
    const url1 = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    assert.equal((await get(url1)).status, 200);
    const again = await get(url1);
    assert.equal(again.status, 404);
    assert.match(again.body.toString(), /used, expired, or never issued/);
    const url2 = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    assert.notEqual(url2, url1);
    assert.equal((await get(url2)).status, 200);
    // A new URL replaces the one before it that was not used yet.
    const a = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    const b = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    assert.equal((await get(a)).status, 404);
    assert.equal((await get(b)).status, 200);
    // Wrong secret, no secret, other path shapes.
    const url3 = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    assert.equal((await get(url3.replace(/\?t=.*/, '?t=nope'))).status, 404);
    assert.equal((await get(url3.replace(/\?t=.*/, ''))).status, 401);
    assert.equal((await get(url3.replace(/\/recording\/[^?]*/, '/recording/m000000000000'))).status, 404);
    assert.equal((await get(url3.replace(/\/recording\/[^?]*/, '/recording/..%2F..%2Fetc'))).status, 404);
    assert.equal((await get(url3)).status, 200); // none of that spent it
    await c.close();
  });
});

test('expiry: past DOWNLOAD_URL_TTL_SEC the URL is dead; the default is 15 minutes', async () => {
  await withService(async (svc) => {
    assert.equal(svc.cfg.downloadUrlTtlMs, 15 * 60_000);
    const c = await connect(svc);
    const { id } = await recording(svc, c);
    await leave(c, id);
    const url = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    const link = svc.manager.meetings.links.links.get(id);
    assert.ok(link.expiresAt > Date.now() + 14 * 60_000 && link.expiresAt <= Date.now() + 15 * 60_000);
    link.expiresAt = Date.now() - 1;
    assert.equal((await get(url)).status, 404);
    svc.manager.meetings.links.sweep();
    assert.equal(svc.manager.meetings.links.links.has(id), false);
    assert.equal((await get((await c.call('recording_get', { meeting_id: id })).json().get_url)).status, 200); // a new one works
    await c.close();
  });
});

test('tenant isolation: another tenant is refused the tool and the URL; a token for another tenant cannot use it', async () => {
  await withService(async (svc) => {
    const c = await connect(svc), b = await connect(svc, TOKEN_B);
    const { id } = await recording(svc, c);
    await leave(c, id);
    const j = (await c.call('recording_get', { meeting_id: id })).json();
    // Bob asks for alice's recording: the same answer as for one that never existed.
    const other = await b.call('recording_get', { meeting_id: id });
    const never = await b.call('recording_get', { meeting_id: 'm000000000000' });
    assert.equal(other.isError, true);
    assert.equal(other.text.replace(id, 'X'), never.text.replace('m000000000000', 'X'));
    assert.match(other.text, /no recording for meeting/);
    // Bob presenting alice's URL with his token: refused, and the URL is not spent.
    const stolen = await get(j.get_url, { authorization: `Bearer ${TOKEN_B}` });
    assert.equal(stolen.status, 403);
    assert.equal((await get(j.get_url, { authorization: 'Bearer wrong-wrong-wrong-wrong' })).status, 403);
    assert.equal((await get(j.get_url, { authorization: `Bearer ${TOKEN}` })).status, 200); // alice's own token matches
    // Bob has no URL of his own for it either.
    const bobs = await get(j.get_url.replace(/\?t=.*/, '?t=' + 'x'.repeat(32)), { authorization: `Bearer ${TOKEN_B}` });
    assert.ok(bobs.status === 404 || bobs.status === 403);
    await Promise.all([c.close(), b.close()]);
  });
});

test('refused while recording is in progress, also after meeting_stop_recording with delete=false it is allowed; deleted is refused', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const { id } = await recording(svc, c);
    assert.match((await c.call('recording_get', { meeting_id: id })).text, /still recording/);
    // Stopped but kept: the file is finished, the meeting goes on.
    assert.equal((await c.call('meeting_stop_recording', { meeting_id: id, delete: false })).isError, false);
    const kept = await c.call('recording_get', { meeting_id: id });
    assert.equal(kept.isError, false, kept.text);
    assert.equal((await get(kept.json().get_url)).status, 200);
    // Deleted: no tool answer, and a URL issued before is dead.
    const url = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    assert.equal((await c.call('meeting_recording_delete', { meeting_id: id })).isError, false);
    assert.equal((await get(url)).status, 404);
    const gone = await c.call('recording_get', { meeting_id: id });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /was deleted|no recording/);
    await leave(c, id);
    assert.match((await c.call('recording_get', { meeting_id: id })).text, /was deleted|no recording/);
    await c.close();
  });
});

test('a recording deleted (opt-out) while its URL is out: the URL is dead', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const { id, code } = await recording(svc, c);
    await c.call('meeting_stop_recording', { meeting_id: id, delete: false });
    const url = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    await c.call('meeting_stop_recording', { meeting_id: id, delete: true });
    assert.equal((await get(url)).status, 404);
    assert.match((await c.call('recording_get', { meeting_id: id })).text, /was deleted|no recording/);
    fake.say(code, 'Alex', 'hello');
    await c.call('meeting_leave', { meeting_id: id });
    await c.close();
  });
});

test('a recording of an earlier run (meeting no longer in memory) is fetched by its id; bad ids and missing files are refused', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const id = 'mfad1e5795d34';
    const dir = path.join(svc.dataDir, 'recordings', 'alice');
    earlierRun(svc, 'alice', id);
    const g = await c.call('recording_get', { meeting_id: id });
    assert.equal(g.isError, false, g.text);
    assert.equal((await get(g.json().get_url)).body.length, fs.statSync(ogg).size);
    for (const bad of ['../alice/' + id, 'mXYZ', 'm' + 'f'.repeat(40), 'm000000000000', '']) {
      const r = await c.call('recording_get', { meeting_id: bad });
      assert.equal(r.isError, true, bad);
    }
    fs.writeFileSync(path.join(dir, 'm111111111111.ogg'), '');
    assert.match((await c.call('recording_get', { meeting_id: 'm111111111111' })).text, /no recording/);
    await c.close();
  });
});

test('a file of an earlier run that changed a moment ago may still be written by an orphaned recorder: refused until it is quiet', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    earlierRun(svc, 'alice', 'm222222222222', 0);
    const r = await c.call('recording_get', { meeting_id: 'm222222222222' });
    assert.equal(r.isError, true);
    assert.match(r.text, /written to a moment ago/);
    earlierRun(svc, 'alice', 'm222222222222', 2);
    assert.equal((await c.call('recording_get', { meeting_id: 'm222222222222' })).isError, false);
    await c.close();
  });
});

test('another tenant deleting an id it does not own does not cut alice\'s URL or transfer', async () => {
  await withService(async (svc) => {
    const c = await connect(svc), b = await connect(svc, TOKEN_B);
    const id = 'm333333333333';
    earlierRun(svc, 'alice', id);
    const url = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    const r = await b.call('meeting_recording_delete', { meeting_id: id });
    assert.equal(r.isError, true);
    assert.match(r.text, /no recording for meeting/);
    assert.equal((await get(url)).status, 200); // alice's URL still works
    // The same through the links object directly: a revoke by bob names bob's tenant only.
    const url2 = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    svc.manager.meetings.links.revoke('bob', id);
    assert.equal((await get(url2)).status, 200);
    await Promise.all([c.close(), b.close()]);
  });
});

test('the retention sweep deleting a recording kills its URL (and a transfer of it)', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const id = 'm444444444444';
    const f = earlierRun(svc, 'alice', id, 31 * 24 * 60);
    const url = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    assert.deepEqual(svc.manager.meetings.sweep(), [f]);
    assert.equal(fs.existsSync(f), false);
    assert.equal((await get(url)).status, 404);
    assert.match((await c.call('recording_get', { meeting_id: id })).text, /no recording for meeting/);
    await c.close();
  });
});

test('a transfer under way is cut off when the recording is deleted', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const id = 'm555555555555';
    const f = earlierRun(svc, 'alice', id);
    fs.appendFileSync(f, Buffer.alloc(8 * 1024 * 1024, 5)); // big enough that the socket buffers do not take it all
    const t = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(f, t, t);
    const url = (await c.call('recording_get', { meeting_id: id })).json().get_url;
    const got = await new Promise((resolve) => {
      let n = 0;
      const req = http.get(url, (res) => {
        res.pause();
        setTimeout(async () => {
          await c.call('meeting_recording_delete', { meeting_id: id });
          res.on('data', (d) => { n += d.length; });
          res.on('close', () => resolve({ n, complete: res.complete }));
          res.on('error', () => {});
          res.resume();
        }, 300);
      });
      req.on('error', () => resolve({ n, complete: false }));
    });
    assert.equal(got.complete, false);
    assert.ok(got.n < 8 * 1024 * 1024);
    assert.equal(svc.manager.meetings.links.transfers.size, 0);
    await c.close();
  });
});

test('a deletion leaves a marker: a file that comes back under the id (a late recorder) is never served and the sweep removes it', async () => {
  await withService(async (svc) => {
    const c = await connect(svc);
    const id = 'm666666666666';
    const f = earlierRun(svc, 'alice', id);
    assert.equal((await c.call('meeting_recording_delete', { meeting_id: id })).isError, false);
    assert.equal(fs.existsSync(f), false);
    assert.equal(fs.existsSync(f.replace(/\.ogg$/, '.deleted')), true);
    earlierRun(svc, 'alice', id); // the recorder opens its output only now
    const r = await c.call('recording_get', { meeting_id: id });
    assert.equal(r.isError, true);
    assert.match(r.text, /was deleted/);
    assert.deepEqual(svc.manager.meetings.sweep(), [f]);
    assert.equal(fs.existsSync(f), false);
    assert.equal(fs.existsSync(f.replace(/\.ogg$/, '.deleted')), true); // kept for the retention period
    // Opt-out of a live recording leaves the marker too, and no URL for it.
    const { id: live } = await recording(svc, c);
    assert.equal((await c.call('meeting_stop_recording', { meeting_id: live, delete: true })).isError, false);
    assert.equal(fs.existsSync(path.join(svc.dataDir, 'recordings', 'alice', `${live}.deleted`)), true);
    assert.equal(fs.existsSync(path.join(svc.dataDir, 'recordings', 'alice', `${live}.ogg`)), false);
    await c.call('meeting_leave', { meeting_id: live });
    await c.close();
  });
});

test('a read-only (ephemeral) token lists recording_get and may call it; it only ever sees its own tenant', async () => {
  assert.ok(EPHEMERAL_TOOLS.has('recording_get'));
  await withService(async (svc) => {
    const c = await connect(svc), e = await connect(svc, TOKEN_E);
    const { id } = await recording(svc, c);
    await leave(c, id);
    assert.ok((await e.listTools()).tools.some((t) => t.name === 'recording_get'));
    const r = await e.call('recording_get', { meeting_id: id });
    assert.equal(r.isError, true);
    assert.match(r.text, /no recording for meeting/);
    assert.doesNotMatch(r.text, /not allowed for this token/);
    // Its own tenant's file (one that exists on disk) is served.
    earlierRun(svc, 'swarm', 'maaaaaaaaaaaa');
    const mine = await e.call('recording_get', { meeting_id: 'maaaaaaaaaaaa' });
    assert.equal(mine.isError, false, mine.text);
    assert.equal((await get(mine.json().get_url)).status, 200);
    await Promise.all([c.close(), e.close()]);
  });
});

test('FEATURES_MEETINGS=0: no recording_get and no /recording route', async () => {
  const svc = await startBosun({ KEEPALIVE: '0', FEATURES_MEETINGS: '0' });
  try {
    const c = await connect(svc);
    assert.ok(!(await c.listTools()).tools.some((t) => t.name === 'recording_get'));
    assert.equal((await get(`http://127.0.0.1:${svc.ws.port}/recording/m000000000000?t=x`)).status, 426);
    await c.close();
  } finally { await svc.stop(); }
});
