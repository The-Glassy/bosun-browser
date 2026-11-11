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
      resolve(!e && /\blibvpx-vp9\b/.test(out) && /\blibopus\b/.test(out) ? null : 'record_video needs ffmpeg with libvpx-vp9 and libopus');
    });
  });
}

// Returns a recorder immediately so deletion/shutdown can cancel even a CDP setup still in flight. makeRecorder
// opens BOTH audio and video in a single ffmpeg. Its first PulseAudio PTS is also the speaker timeline's zero.
export function startPageVideo({ page, fps, file, makeRecorder }) {
  let cdp, rec, latest, timer, err = null, closed = false, startedAt = Date.now(), sent = 0;
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
  const detach = async () => {
    clearInterval(timer);
    latest = null;
    if (cdp) {
      const session = cdp;
      cdp = null;
      session.off('Page.screencastFrame', frame);
      await Promise.race([(async () => {
        await session.send('Page.stopScreencast').catch(() => {});
        await session.detach().catch(() => {});
      })(), new Promise((r) => { const t = setTimeout(r, 2000); t.unref?.(); })]);
    }
  };
  const fail = (e) => {
    if (closed) return;
    err = String(e?.message || e);
    closed = true;
    cancelResolve();
    detach().finally(async () => { await rec?.kill(); finishResolve({ error: err }); });
  };
  const pump = () => {
    if (closed || !latest || !rec) return;
    if (!Number.isFinite(rec.audioStartedAt)) {
      if (Date.now() - startedAt > 5000) fail(new Error('video recorder received no audio input timestamp'));
      return;
    }
    for (const sessionId of pending) cdp?.send('Page.screencastFrameAck', { sessionId }).catch(fail);
    pending.clear();
    // image2pipe has constant-rate PTS starting at zero. Repeat static slides, and use the same audio input zero
    // as the timeline. Catch up small event-loop delays; sustained backpressure fails rather than losing sync.
    const due = Math.floor(Math.max(0, Date.now() - rec.audioStartedAt) * fps / 1000) + 1;
    if (due - sent > fps * 5) return fail(new Error('video encoder fell more than 5 seconds behind'));
    while (sent < due && !rec.frames.writableNeedDrain && !rec.frames.destroyed) {
      rec.frames.write(latest);
      sent++;
    }
  };
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
  })().catch(fail).finally(async () => { if (closed) await detach(); });
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
