// Native encoder/source-controller benchmark, independent of PulseAudio/display. For deployment totals also run the
// Linux integration harness: CDP JPEG rendering and the live meeting browser are deliberately excluded here.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startPageVideo, videoUnsupported } from '../src/meetings/video.mjs';
import { startRecorder } from '../src/meetings/audio.mjs';

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
if (args[0] === '--worker') {
  const [, dir, rawFps, rawSeconds] = args, fps = Number(rawFps), seconds = Number(rawSeconds);
  const frames = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => fs.readFileSync(path.join(dir, f)).toString('base64'));
  const cdp = new EventEmitter(); let frame = 0, closing = false;
  const emit = () => { if (!closing) cdp.emit('Page.screencastFrame', { data: frames[frame++ % frames.length], sessionId: frame }); };
  cdp.send = async (method) => {
    if (method === 'Page.startScreencast') emit();
    if (method === 'Page.screencastFrameAck' && frames.length > 1) setTimeout(emit, 0);
    if (method === 'Page.stopScreencast') closing = true;
  };
  cdp.detach = async () => {};
  const file = path.join(dir, 'recording.webm');
  const rec = startPageVideo({ page: { context: () => ({ newCDPSession: async () => cdp }) }, fps, file,
    makeRecorder: () => startRecorder(null, file, { fps, audioInput: ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] }) });
  await pause(seconds * 1000); await rec.stop();
  const result = await rec.exited;
  if (result?.error || result?.sig === 'SIGKILL') throw new Error(rec.error());
} else {
  const [scenario = 'static', rawFps = '2', rawSeconds = '30'] = args;
  const fps = Number(rawFps), seconds = Number(rawSeconds);
  if (!['static', 'motion'].includes(scenario) || !Number.isInteger(fps) || fps < 2 || fps > 5 || !Number.isFinite(seconds) || seconds < 6 || seconds > 3600) throw new Error('usage: node scripts/measure-meeting-video.mjs [static|motion] [2–5 fps] [6–3600 seconds]');
  const why = await videoUnsupported(); if (why) throw new Error(why);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-video-cost-'));
  try {
    // Pre-render an identical local JPEG source; generation and probing are outside the timed worker.
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=${fps}`, '-frames:v', String(scenario === 'static' ? 1 : fps * seconds), '-q:v', '3', path.join(dir, '%04d.jpg')]);
    const usageFile = path.join(dir, 'time.txt');
    const child = spawn('/usr/bin/time', ['-p', '-o', usageFile, process.execPath, fileURLToPath(import.meta.url), '--worker', dir, String(fps), String(seconds)], { stdio: 'inherit' });
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`benchmark exited ${code}`))); });
    const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', path.join(dir, 'recording.webm')]));
    const usage = Object.fromEntries(fs.readFileSync(usageFile, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([k, v]) => [k, Number(v)]));
    const cpu = usage.user + usage.sys, bytes = Number(info.format.size), duration = Number(info.format.duration);
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(dir, 'recording.webm'), '-map', '0:a', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 128 * 1024 ** 2 });
    const audioSeconds = decoded.length / 32000;
    if (Math.abs(duration - audioSeconds) > 1 || audioSeconds < seconds - 1) throw new Error(`audio/video duration mismatch: ${audioSeconds}/${duration}`);
    console.log(JSON.stringify({ date: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model },
      ffmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0], scope: 'native ffmpeg + Node source controller; synthetic JPEGs/audio; excludes browser/CDP rendering and PulseAudio',
      scenario, fps, width: 1280, height: 720, seconds, media_seconds: duration, audio_seconds: audioSeconds, bytes, cpu_seconds: Number(cpu.toFixed(3)), elapsed_seconds: usage.real,
      cpu_percent_one_core: Number((cpu / seconds * 100).toFixed(2)), cpu_seconds_per_hour: Math.round(cpu / seconds * 3600), mb_per_hour: Number((bytes / duration * 3600 / 1e6).toFixed(2)),
    }, null, 2));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
