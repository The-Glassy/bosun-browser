// Page-scoped CDP capture: the service's Xvfb display is shared across tenants. Never grab that display.
import fs from 'fs';
import { execFile } from 'child_process';

export function validateVideo(recordVideo, fps) {
  if (typeof recordVideo !== 'boolean') throw new Error('record_video must be a boolean');
  if (!Number.isInteger(fps) || fps < 2 || fps > 5) throw new Error('video_fps must be an integer between 2 and 5');
}

// Synchronous check + reservation by the caller, with no await in between (also counts joins in the lobby).
export function videoCapacity(dir, cfg, reserved, statfs = fs.statfsSync) {
  const limit = cfg.meetingVideoLimit ?? 1, gb = cfg.meetingVideoMinFreeGb ?? 2;
  if (reserved >= limit) throw new Error(`record_video limit ${limit} reached; stop another video recording first`);
  const st = statfs(dir);
  if (Number(st.bavail) * Number(st.bsize) < gb * 1024 ** 3) throw new Error(`record_video needs at least ${gb} GB free disk space`);
}

let support;
export function videoUnsupported() {
  return support ??= new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 10_000 }, (e, out) => {
      if (e || !/\blibvpx-vp9\b/.test(out) || !/\blibopus\b/.test(out)) return resolve('record_video needs ffmpeg with libvpx-vp9 and libopus');
      execFile('ffprobe', ['-version'], { timeout: 5000 }, (error) => resolve(error ? 'record_video needs ffprobe' : null));
    });
  });
}

// Returns a recorder immediately so deletion/shutdown can cancel even a CDP setup still in flight. makeRecorder
// opens a separate video ffmpeg (optionally with its own audio track). The Ogg recorder owns timeline zero.
export function startPageVideo({ page, fps, file, makeRecorder }) {
  let cdp, rec, latest, timer, setupTimer, err = null, closed = false, startedAt = Date.now(), sent = 0;
  let firstResolve, finishResolve, cancelResolve;
  const first = new Promise((r) => { firstResolve = r; });
  const exited = new Promise((r) => { finishResolve = r; });
  const cancelled = new Promise((r) => { cancelResolve = r; });
  const pending = new Set();
  const frame = (event) => {
    if (closed) return;
    latest = Buffer.from(event.data, 'base64'); // one latest frame, no unbounded frame queue
    pending.add(event.sessionId);
    firstResolve();
  };
  let detaching;
  const detach = () => {
    clearInterval(timer);
    clearTimeout(setupTimer);
    latest = null;
    if (!cdp) return detaching || Promise.resolve();
    const session = cdp;
    cdp = null;
    session.off('Page.screencastFrame', frame);
    // Bound each operation separately: a stalled stop must never prevent the detach attempt.
    detaching = (async () => {
      try { await bounded(() => session.send('Page.stopScreencast'), 1000); }
      finally { await bounded(() => session.detach(), 1000); }
    })();
    return detaching;
  };

  const fail = (e) => {
    if (closed) return;
    err = String(e?.message || e);
    closed = true;
    cancelResolve();
    detach().finally(async () => { await rec?.stop(); finishResolve({ error: err }); });
  };
  const pump = () => {
    if (closed || !latest || !rec) return;
    if (!Number.isFinite(rec.audioStartedAt)) {
      if (Date.now() - startedAt > 5000) fail(new Error('video recorder received no audio input timestamp'));
      return;
    }
    // image2pipe has constant-rate PTS starting at zero. Repeat static slides, and use the same audio input zero
    // as the timeline. Catch up small event-loop delays; sustained backpressure fails rather than losing sync.
    const due = Math.floor(Math.max(0, Date.now() - rec.audioStartedAt) * fps / 1000) + 1;
    if (due - sent > fps * 5) return fail(new Error('video encoder fell more than 5 seconds behind'));
    if (due > sent) {
      // ACK pacing bounds Chromium's JPEG work too, rather than merely discarding a full-rate screencast.
      const ack = [...pending]; pending.clear();
      for (const sessionId of ack) cdp?.send('Page.screencastFrameAck', { sessionId }).catch(fail);
    }
    while (sent < due && !rec.frames.writableNeedDrain && !rec.frames.destroyed) {
      rec.frames.write(latest);
      sent++;
    }
  };
  setupTimer = setTimeout(() => fail(new Error('video capture setup timed out')), 10_000);
  setupTimer.unref?.();
  const setup = (async () => {
    cdp = await page.context().newCDPSession(page);
    if (closed) return;
    cdp.on('Page.screencastFrame', frame);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    if (closed) return;
    let timeout;
    try {
      await Promise.race([first, cancelled, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('meeting page supplied no video frame')), 5000); })]);
    } finally { clearTimeout(timeout); }
    if (closed) return;
    rec = makeRecorder();
    startedAt = rec.startedAt;
    rec.exited.then((result) => { closed = true; cancelResolve(); detach().finally(() => finishResolve(result)); });
    timer = setInterval(pump, Math.min(50, 1000 / fps));
    timer.unref?.();
    pump();
  })().catch(fail).finally(async () => { clearTimeout(setupTimer); if (closed) await detach(); });
  const end = async (kill) => {
    closed = true; cancelResolve(); clearInterval(timer);
    // rec is installed synchronously, and setup checks closed after every asynchronous acquisition.
    const result = rec ? await (kill ? rec.kill() : rec.stop()) : null;
    await Promise.race([setup, new Promise((r) => { const t = setTimeout(r, 2000); t.unref?.(); })]);
    await detach();
    finishResolve(result);
    return result;
  };
  return { file, get startedAt() { return startedAt; }, get audioStartedAt() { return rec?.audioStartedAt ?? null; },
    exited, error: () => err || rec?.error() || null, stop: () => end(false), kill: () => end(true) };
}

// true: at least one video packet; false: positive evidence of empty/invalid media;
// null: validation could not complete. Operational failures must never authorize deletion.
export function validVideo(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1',
      '-show_packets', '-show_entries', 'packet=size', '-of', 'json', file], { timeout: 5000 }, (e, out, stderr) => {
      if (e) {
        const invalid = !e.killed && typeof e.code === 'number' && /Invalid data found when processing input|EBML header parsing failed/.test(stderr);
        return resolve(invalid ? false : null);
      }
      try {
        const packets = JSON.parse(out).packets;
        resolve(Array.isArray(packets) ? packets.some((p) => Number(p.size) > 0) : null);
      } catch { resolve(null); }
    });
  });
}

async function bounded(fn, ms) {
  let timer;
  try { await Promise.race([Promise.resolve().then(fn).catch(() => {}), new Promise((r) => { timer = setTimeout(r, ms); timer.unref?.(); })]); }
  finally { clearTimeout(timer); }
}
