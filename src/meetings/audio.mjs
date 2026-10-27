// Audio for a meeting session (Linux): a private PulseAudio server per session — its own XDG_RUNTIME_DIR, socket and
// config, so meetings never hear each other — with two null sinks: bosun_out, where the browser plays the meeting,
// and bosun_mic, where Bosun plays what it says. The browser's microphone is bosun_mic_src, a plain source remapped from
// bosun_mic's monitor (silent unless Bosun speaks): Chromium lists no monitor sources as microphones. ffmpeg records bosun_out's
// monitor to Ogg/Opus, 16 kHz mono 24 kbps; a second ffmpeg can read the same monitor as raw PCM for the live
// transcript (capture), and another plays a file into bosun_mic (play). Needs the packages pulseaudio,
// pulseaudio-utils (pactl) and ffmpeg (built with PulseAudio input and output, as Debian/Ubuntu's is).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 10_000, ...opts }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stderr: String(stderr) })) : resolve(String(stdout))));
});

let support = null;
// Whether recording can work on this host; resolves to null (yes) or the reason it can't.
export function audioUnsupported() {
  support ??= (async () => {
    if (process.platform !== 'linux') return 'meeting recording needs Linux with PulseAudio (or pipewire-pulse) and ffmpeg';
    try { await run('pulseaudio', ['--version']); } catch { return 'pulseaudio is not installed (apt-get install pulseaudio pulseaudio-utils)'; }
    try { await run('pactl', ['--version']); } catch { return 'pactl is not installed (apt-get install pulseaudio-utils)'; }
    try {
      const out = await run('ffmpeg', ['-hide_banner', '-devices']);
      if (!/\bpulse\b/.test(out)) return 'ffmpeg has no PulseAudio input (use a build with libpulse, e.g. apt-get install ffmpeg)';
    } catch { return 'ffmpeg is not installed (apt-get install ffmpeg)'; }
    return null;
  })();
  return support;
}

// A per-session PulseAudio server. env: what the browser process needs to play into bosun_out and record from
// bosun_mic_src.
export async function startPulse({ tmpRoot = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'bosun-pulse-'));
  fs.chmodSync(dir, 0o700);
  const sock = path.join(dir, 'native');
  const env = { ...process.env, XDG_RUNTIME_DIR: dir, PULSE_RUNTIME_PATH: dir, HOME: dir, XDG_CONFIG_HOME: path.join(dir, 'config'), PULSE_SERVER: `unix:${sock}` };
  delete env.PULSE_SINK; delete env.PULSE_SOURCE;
  const proc = spawn('pulseaudio', [
    '--daemonize=no', '--system=no', '--use-pid-file=no', '--exit-idle-time=-1', '--disallow-exit=yes', '--disallow-module-loading=yes',
    '-n', '--log-target=stderr', '--log-level=error',
    `--load=module-native-protocol-unix socket=${sock} auth-anonymous=1`,
    '--load=module-null-sink sink_name=bosun_out sink_properties=device.description=bosun_out rate=48000',
    '--load=module-null-sink sink_name=bosun_mic sink_properties=device.description=bosun_mic rate=48000',
    '--load=module-remap-source master=bosun_mic.monitor source_name=bosun_mic_src source_properties=device.description=bosun_mic',
  ], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  proc.on('error', (e) => { exited = true; err += `\n${e.code || e.message}`; }); // spawn failure: no 'exit' follows
  let closing = null;
  const close = () => (closing ??= (async () => {
    if (!exited) {
      try { proc.kill('SIGTERM'); } catch {}
      for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      if (!exited) { try { proc.kill('SIGKILL'); } catch {} }
      for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  })());
  const pactl = (...args) => run('pactl', ['-s', `unix:${sock}`, ...args], { env });
  try {
    for (let i = 0; ; i++) {
      if (exited) throw new Error(`pulseaudio exited: ${err.trim().split('\n').pop() || 'unknown error'}`);
      if (fs.existsSync(sock) && await pactl('info').then(() => true, () => false)) break;
      if (i > 100) throw new Error('pulseaudio did not start');
      await sleep(100);
    }
    await pactl('set-default-sink', 'bosun_out');
    await pactl('set-default-source', 'bosun_mic_src');
  } catch (e) {
    await close();
    throw e;
  }
  return {
    dir,
    server: `unix:${sock}`,
    browserEnv: { ...env, PULSE_SINK: 'bosun_out', PULSE_SOURCE: 'bosun_mic_src' },
    close,
  };
}

// ffmpeg: bosun_out's monitor -> Ogg/Opus 16 kHz mono 24 kbps in `file` (created 0600 first). stop() ends it cleanly
// (the file stays valid), kill() just ends it.
export function startRecorder(pulse, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, 'w', 0o600));
  fs.chmodSync(file, 0o600);
  const proc = spawn('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'pulse', '-server', pulse.server, '-name', 'bosun', '-i', 'bosun_out.monitor',
    '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-f', 'ogg', file,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  // Settles on exit, or on a spawn failure (which emits 'error' and no 'exit').
  const exited = new Promise((r) => {
    proc.on('exit', (code, sig) => r({ code, sig }));
    proc.on('error', (e) => { err += `\n${e.code || e.message}`; r({ error: e }); });
  });
  // Every wait is bounded: a recorder that ignores even SIGKILL can't hold up the meeting's cleanup.
  const end = async (sig, waitMs) => {
    const alive = () => proc.exitCode === null && proc.signalCode === null && proc.pid !== undefined;
    if (alive()) { try { proc.kill(sig); } catch {} }
    let r = await Promise.race([exited, sleep(waitMs).then(() => null)]);
    if (!r) {
      try { proc.kill('SIGKILL'); } catch {}
      r = await Promise.race([exited, sleep(2000).then(() => null)]);
    }
    return r;
  };
  return {
    file,
    startedAt: Date.now(),
    exited,
    error: () => err.trim().split('\n').pop() || null,
    stop: () => end('SIGINT', 5000),
    kill: () => end('SIGKILL', 2000),
  };
}

// Bounded end of a child process: sig, then SIGKILL; resolves once it is gone (or after the waits).
async function endProc(proc, exited, sig, waitMs) {
  const alive = () => proc.exitCode === null && proc.signalCode === null && proc.pid !== undefined;
  if (alive()) { try { proc.kill(sig); } catch {} }
  if (await Promise.race([exited, sleep(waitMs).then(() => false)])) return;
  try { proc.kill('SIGKILL'); } catch {}
  await Promise.race([exited, sleep(2000)]);
}

// ffmpeg: bosun_out's monitor -> raw PCM s16le 16 kHz mono on stdout, in small fragments (the live transcript reads
// it as it comes). stop() ends it.
export const PCM_RATE = 16000;
export function startCapture(pulse) {
  const proc = spawn('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer',
    '-f', 'pulse', '-server', pulse.server, '-name', 'bosun-stt', '-fragment_size', '9600', '-i', 'bosun_out.monitor',
    '-ac', '1', '-ar', String(PCM_RATE), '-f', 's16le', '-flush_packets', '1', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  const exited = new Promise((r) => { proc.on('exit', () => r(true)); proc.on('error', (e) => { err += `\n${e.code || e.message}`; r(true); }); });
  return { stream: proc.stdout, exited, error: () => err.trim().split('\n').pop() || null, stop: () => endProc(proc, exited, 'SIGTERM', 2000) };
}

// ffmpeg: audio -> bosun_mic, in real time (the null sink takes it at its clock). input: {file} (any format ffmpeg
// reads), or {pcm: {rate, channels}}: raw s16le written as it comes (write(buf), end()); a pause in the writing is a
// pause in the audio. done resolves when it has played (true) or was stopped / failed (false); stop() cuts it off.
export function startPlayer(pulse, input) {
  const src = input.file ? ['-i', input.file] : ['-f', 's16le', '-ar', String(input.pcm.rate), '-ac', String(input.pcm.channels), '-i', 'pipe:0'];
  const proc = spawn('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', ...src,
    '-ac', '2', '-ar', '48000', '-f', 'pulse', '-server', pulse.server, '-device', 'bosun_mic', '-buffer_duration', '40', 'bosun-speak',
  ].filter((a) => !(input.pcm && a === '-nostdin')), { stdio: [input.pcm ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  proc.stdin?.on('error', () => {}); // a player stopped meanwhile
  let ok = false;
  const exited = new Promise((r) => { proc.on('exit', (code) => { ok = code === 0; r(true); }); proc.on('error', (e) => { err += `\n${e.code || e.message}`; r(true); }); });
  return {
    done: exited.then(() => ok),
    write: (buf) => { if (proc.stdin?.writable) proc.stdin.write(buf); },
    end: () => { proc.stdin?.end(); },
    error: () => err.trim().split('\n').pop() || null,
    stop: () => endProc(proc, exited, 'SIGKILL', 1000),
  };
}

// The default audio backend for meetings.
export const pulseAudio = {
  unsupported: audioUnsupported,
  needsHeadful: true, // headless Chromium plays no audio
  async open() {
    const pulse = await startPulse();
    return {
      browserEnv: pulse.browserEnv, record: (file) => startRecorder(pulse, file), capture: () => startCapture(pulse), play: (input) => startPlayer(pulse, input),
      close: pulse.close,
    };
  },
};
