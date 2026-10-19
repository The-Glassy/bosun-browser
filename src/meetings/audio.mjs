// Audio for a meeting session (Linux): a private PulseAudio server per session — its own XDG_RUNTIME_DIR, socket and
// config, so meetings never hear each other — with two null sinks: bosun_out, where the browser plays the meeting,
// and bosun_mic, whose (silent) monitor is the browser's microphone. ffmpeg records bosun_out's monitor to Ogg/Opus,
// 16 kHz mono 24 kbps. Needs the packages pulseaudio, pulseaudio-utils (pactl) and ffmpeg (built with PulseAudio
// input, as Debian/Ubuntu's is).
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

// A per-session PulseAudio server. env: what the browser process needs to play into bosun_out and record from the
// silent bosun_mic.
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
  ], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const close = async () => {
    if (!exited) {
      proc.kill('SIGTERM');
      for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      if (!exited) proc.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const pactl = (...args) => run('pactl', ['-s', `unix:${sock}`, ...args], { env });
  try {
    for (let i = 0; ; i++) {
      if (exited) throw new Error(`pulseaudio exited: ${err.trim().split('\n').pop() || 'unknown error'}`);
      if (fs.existsSync(sock) && await pactl('info').then(() => true, () => false)) break;
      if (i > 100) throw new Error('pulseaudio did not start');
      await sleep(100);
    }
    await pactl('set-default-sink', 'bosun_out');
    await pactl('set-default-source', 'bosun_mic.monitor');
  } catch (e) {
    await close();
    throw e;
  }
  return {
    dir,
    server: `unix:${sock}`,
    browserEnv: { ...env, PULSE_SINK: 'bosun_out', PULSE_SOURCE: 'bosun_mic.monitor' },
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
  const exited = new Promise((r) => proc.on('exit', (code, sig) => r({ code, sig })));
  proc.on('error', () => {});
  const end = async (sig, waitMs) => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill(sig);
    const r = await Promise.race([exited, sleep(waitMs).then(() => null)]);
    if (!r) { proc.kill('SIGKILL'); await exited; }
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

// The default audio backend for meetings.
export const pulseAudio = {
  unsupported: audioUnsupported,
  needsHeadful: true, // headless Chromium plays no audio
  async open() {
    const pulse = await startPulse();
    return { browserEnv: pulse.browserEnv, record: (file) => startRecorder(pulse, file), close: pulse.close };
  },
};
