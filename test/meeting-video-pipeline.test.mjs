// Real ffmpeg with a synthetic page source; CDP/browser isolation is also exercised when Chromium can launch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startPageVideo, videoUnsupported } from '../src/meetings/video.mjs';
import { startRecorder } from '../src/meetings/audio.mjs';

const why = await videoUnsupported() || (spawnSync('ffprobe', ['-version']).status !== 0 ? 'ffprobe unavailable' : null);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const audioInput = ['-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
const jpeg = (color) => execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=1280x720`, '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1']);
const make = (file, fps) => startRecorder(null, file, { fps, audioInput });

function inspect(file, fps, minSeconds) {
  const info = probe(file);
  assert.equal(info.streams.length, 2);
  const video = info.streams.find((s) => s.codec_type === 'video'), audio = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video.codec_name, 'vp9'); assert.equal(audio.codec_name, 'opus'); assert.equal(audio.channels, 1);
  assert.equal(video.width, 1280); assert.equal(video.height, 720); assert.equal(video.r_frame_rate, `${fps}/1`);
  assert.ok(Number(info.format.duration) >= minSeconds);
  // Decode audio, rather than just checking container duration: video lookahead can silently starve audio capture.
  const samples = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-ar', '16000', '-f', 's16le', 'pipe:1'], { maxBuffer: 8 * 1024 ** 2 });
  const audioSeconds = samples.length / 32000;
  assert.ok(audioSeconds >= minSeconds, `audio was truncated to ${audioSeconds}s`);
  assert.ok(Math.abs(audioSeconds - Number(info.format.duration)) < 1, 'audio/video duration remains aligned');
  const packets = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_packets', '-show_entries', 'packet=pts_time', '-of', 'json', file])).packets;
  assert.ok(Math.abs(Number(video.start_time) - Number(audio.start_time)) < 0.05, 'tracks share zero (within Opus delay)');
  for (let i = 1; i < packets.length; i++) assert.ok(Math.abs(Number(packets[i].pts_time) - Number(packets[i - 1].pts_time) - 1 / fps) < 0.002);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
}

test('real VP9/Opus mux: static page frames repeat, audio spans the recording, fps and permissions', { skip: why || false }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-video-pipeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cdp = new EventEmitter(), frame = jpeg('red');
  cdp.send = async (method) => { if (method === 'Page.startScreencast') cdp.emit('Page.screencastFrame', { data: frame.toString('base64'), sessionId: 1 }); };
  cdp.detach = async () => {};
  const page = { context: () => ({ newCDPSession: async () => cdp }) };
  const file = path.join(dir, 'static.webm');
  const rec = startPageVideo({ page, fps: 2, file, makeRecorder: () => make(file, 2) });
  t.after(() => rec.kill());
  await pause(5500); await rec.stop();
  inspect(file, 2, 4);
});

test('local browser page: capture updates the meeting page while another window is foreground', { skip: why || false }, async (t) => {
  let browser;
  try {
    const engine = process.env.ENGINE === 'patchright' ? (await import('patchright')).chromium : chromium;
    browser = await engine.launch({ headless: process.env.TEST_HEADFUL !== '1', args: ['--no-sandbox'] });
  }
  catch (e) {
    if (/mach_port_rendezvous|Operation not permitted|Executable doesn't exist|Missing X server/i.test(String(e))) return t.skip(`browser unavailable: ${String(e).split('\n').find((s) => /mach_port|Operation not permitted|Executable doesn't exist|Missing X server/i.test(s))}`);
    throw e;
  }
  t.after(() => browser.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-video-browser-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('data:text/html,<style>body{background:rgb(255,0,0)}</style><h1>Meeting slide</h1>');
  const other = await ctx.newPage();
  await other.goto('data:text/html,<style>body{background:rgb(0,0,255)}</style><h1>Other tenant window</h1>');
  await page.bringToFront();
  const file = path.join(dir, 'page.webm');
  const rec = startPageVideo({ page, fps: 5, file, makeRecorder: () => make(file, 5) });
  t.after(() => rec.kill());
  await pause(1500);
  await other.bringToFront();
  await page.evaluate(() => { document.body.style.background = 'rgb(0,255,0)'; });
  await pause(4000); await rec.stop();
  inspect(file, 5, 4);
  // A late center pixel must update to green. A display grab sees blue; a frozen first frame stays red.
  const pixel = execFileSync('ffmpeg', ['-v', 'error', '-ss', '3', '-i', file, '-frames:v', '1', '-vf', 'crop=2:2:640:360,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  assert.ok(pixel[1] > 180 && pixel[0] < 80 && pixel[2] < 80, `wrong page or stale frame: ${[...pixel]}`);
});
