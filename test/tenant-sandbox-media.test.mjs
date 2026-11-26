// What a sandboxed worker needs from its host beyond isolation (found in production on 0.28.0, Debian 13):
// - programs resolve their shared libraries inside bwrap (ffmpeg links libblas.so.3 through /etc/alternatives), and
//   the meeting audio check names the real failure when one does not;
// - a browser behind the host relay loads sites that send an ACCEPT_CH frame (www.google.com, meet.google.com),
//   which hung until the navigation timed out while the browser itself held the relay credentials;
// - PulseAudio and ffmpeg record inside the sandbox.
// The sandbox tests need a host that lets bwrap create its namespaces (see tenant-sandbox.test.mjs); the network test
// needs the internet and is skipped without it (or with BOSUN_TEST_OFFLINE=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseHostPattern } from '../src/allow.mjs';
import { audioUnsupported } from '../src/meetings/audio.mjs';
import { startTenantProxy } from '../src/proxy.mjs';
import { startRelayProxy } from '../src/tenant-network.mjs';
import { createSandboxRuntime, sandboxCommand } from '../src/tenant-sandbox.mjs';
import { closeServer, listen } from './egress-fixture.mjs';
import { connect, startBosun, tmpDir, TOKEN } from './helpers.mjs';

const canProbe = process.platform === 'linux' && process.getuid?.() !== 0;
const probe = canProbe && spawnSync('bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/usr', '/usr',
  '--ro-bind', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--proc', '/proc', '/usr/bin/true'], { timeout: 5000 });
const skip = process.env.BOSUN_TEST_SANDBOX !== '1' && (!probe || probe.status !== 0)
  ? 'requires a Linux host that permits bwrap user, PID and network namespaces and a private procfs' : false;
const has = (program) => spawnSync(program, ['-version'], { stdio: 'ignore', timeout: 10_000 }).error?.code !== 'ENOENT';
const hostAudio = process.platform === 'linux' ? await audioUnsupported() : 'meeting audio needs Linux';

test('the meeting audio check tells a missing program from one that cannot run', async () => {
  const failing = (program, error) => async (cmd) => {
    if (cmd === program) throw Object.assign(new Error('Command failed'), error);
    return cmd === 'ffmpeg' ? ' DE pulse           Pulse audio output' : `${cmd} 17.0`;
  };
  const loader = 'ffmpeg: error while loading shared libraries: libblas.so.3: cannot open shared object file: No such file or directory';
  const check = (program, error) => audioUnsupported({ exec: failing(program, error), cached: false });
  const skipOffLinux = process.platform !== 'linux';
  if (skipOffLinux) return assert.match(await check('ffmpeg', { code: 127, stderr: loader }), /needs Linux/);
  const broken = await check('ffmpeg', { code: 127, stderr: `${loader}\n` });
  assert.match(broken, /^ffmpeg is installed but could not run: .*libblas\.so\.3: cannot open shared object file/);
  assert.doesNotMatch(broken, /not installed|apt-get/);
  assert.equal(await check('ffmpeg', { code: 'ENOENT' }), 'ffmpeg is not installed (apt-get install ffmpeg)');
  assert.equal(await check('pulseaudio', { code: 'ENOENT' }), 'pulseaudio is not installed (apt-get install pulseaudio pulseaudio-utils)');
  assert.equal(await check('pactl', { code: 1, stderr: '' }), 'pactl is installed but could not run: exited with code 1');
  assert.equal(await check('pulseaudio', { killed: true, signal: 'SIGTERM', code: null, stderr: '' }), 'pulseaudio is installed but could not run: timed out');
  assert.equal(await check('none', {}), null);
});

test('the sandbox mounts the targets of system symlinks and none of the host network configuration', { skip: !canProbe }, (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sandbox = createSandboxRuntime(dir);
  t.after(() => sandbox.close());
  const command = sandboxCommand({ runtime: sandbox.runtime, state: sandbox.state('alice'), ipc: dir, relay: dir, headless: true, tz: 'UTC' });
  const mounts = new Map();
  for (let i = 0; i < command.length; i++) if (command[i] === '--ro-bind-try') mounts.set(command[i + 2], command[i + 1]);
  for (const target of ['/etc/alternatives', '/usr/share/fontconfig', '/usr/local/share/ca-certificates', '/etc/pki/tls/certs', '/etc/pki/ca-trust/extracted']) {
    assert.equal(mounts.get(target), target);
  }
  for (const target of ['/etc', '/etc/resolv.conf', '/etc/localtime', '/etc/gai.conf', '/etc/ld.so.conf.d']) assert.equal(mounts.has(target), false, target);
  // The worker's /etc/hosts is generated: its own names, nothing of the host's.
  assert.equal(mounts.get('/etc/hosts'), path.join(sandbox.runtime, 'hosts'));
  assert.equal(fs.readFileSync(mounts.get('/etc/hosts'), 'utf8'), '127.0.0.1 localhost bosun\n::1 localhost ip6-localhost ip6-loopback\n');
});

test('a relay bridge authenticates its connections, so the browser needs no proxy credentials', { skip: process.platform === 'win32' }, async (t) => {
  const origin = http.createServer((req, res) => res.end(`origin ${req.url} ${req.headers['proxy-authorization'] || 'no credentials'}`));
  const port = await listen(origin);
  t.after(() => closeServer(origin));
  const dir = tmpDir(), socketPath = path.join(dir, 'exit-0');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const allow = [parseHostPattern(`127.0.0.1:${port}`)];
  const relay = await startTenantProxy({ tenant: 'alice', allow, pin: true, socketPath, log: () => {} });
  t.after(() => relay.close());
  const bridge = await startRelayProxy({ socketPath, username: relay.username, password: relay.password });
  t.after(() => bridge.close());
  assert.deepEqual(Object.keys(bridge).sort(), ['bypass', 'close', 'server']);

  const via = new URL(bridge.server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const get = (options) => new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, reused: req.reusedSocket }));
    });
    req.on('error', reject);
    req.end();
  });
  // Two requests on one bridge connection: the bridge adds the credentials to the first, the relay admits the rest.
  const first = await get({ host: via.hostname, port: via.port, path: `http://127.0.0.1:${port}/first`, agent });
  const second = await get({ host: via.hostname, port: via.port, path: `http://127.0.0.1:${port}/second`, agent });
  assert.deepEqual([first.status, first.body], [200, 'origin /first no credentials']);
  assert.deepEqual([second.status, second.body, second.reused], [200, 'origin /second no credentials', true]);
  const denied = await get({ host: via.hostname, port: via.port, path: 'http://127.0.0.2:1/', agent });
  assert.equal(denied.status, 403);

  const tunnel = http.request({ host: via.hostname, port: via.port, method: 'CONNECT', path: `127.0.0.1:${port}` });
  tunnel.end();
  const [response, socket] = await once(tunnel, 'connect');
  assert.equal(response.statusCode, 200);
  socket.write('GET /tunnel HTTP/1.1\r\nHost: origin\r\nConnection: close\r\n\r\n');
  let reply = '';
  for await (const chunk of socket) reply += chunk;
  assert.match(reply, /origin \/tunnel no credentials$/);

  // The relay socket itself still refuses a connection that never presented the credentials.
  assert.equal((await get({ socketPath, path: `http://127.0.0.1:${port}/direct` })).status, 407);
  // A loopback TCP proxy (shared mode) is reachable by other local processes: every request carries credentials.
  const shared = await startTenantProxy({ tenant: 'alice', allow, log: () => {} });
  t.after(() => shared.close());
  const tcp = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => tcp.destroy());
  const authorization = `Basic ${Buffer.from(`${shared.username}:${shared.password}`).toString('base64')}`;
  const target = { host: '127.0.0.1', port: shared.port, path: `http://127.0.0.1:${port}/shared`, agent: tcp };
  assert.equal((await get({ ...target, headers: { 'proxy-authorization': authorization } })).status, 200);
  const unauthenticated = await get(target);
  assert.deepEqual([unauthenticated.status, unauthenticated.reused], [407, true]);
});

// Runs an ES module inside the same bwrap sandbox a tenant worker gets and returns the JSON it prints.
function runInSandbox(t, source, { timeout = 30_000 } = {}) {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sandbox = createSandboxRuntime(dir);
  t.after(() => sandbox.close());
  const state = sandbox.state('alice');
  const ipc = fs.mkdtempSync(path.join(sandbox.runtime, 'probe-ipc-'));
  const relay = fs.mkdtempSync(path.join(sandbox.runtime, 'probe-relay-'));
  const command = sandboxCommand({ runtime: sandbox.runtime, state, ipc, relay, headless: true, tz: 'UTC',
    script: '--input-type=module', args: ['-e', source(state)] });
  const filter = fs.openSync(path.join(sandbox.runtime, 'seccomp'), 'r');
  try {
    const result = spawnSync('bwrap', command, { stdio: ['ignore', 'pipe', 'pipe', filter], encoding: 'utf8', timeout, env: { PATH: '/usr/bin:/bin' } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return { state, ...JSON.parse(result.stdout.trim().split('\n').pop()) };
  } finally { fs.closeSync(filter); }
}

test('programs a worker runs find their shared libraries inside the sandbox', { skip }, (t) => {
  const programs = ['ffmpeg', 'ffprobe', 'pulseaudio', 'pactl', 'Xvfb'].filter((program) => fs.existsSync(`/usr/bin/${program}`));
  if (!fs.existsSync('/usr/bin/ldd') || !programs.length) return t.skip('needs ldd and at least one of the media programs in /usr/bin');
  const { missing, names } = runInSandbox(t, () => `
    import { spawnSync } from 'node:child_process';
    const missing = [];
    for (const program of ${JSON.stringify(programs)}) {
      const { stdout, stderr } = spawnSync('ldd', ['/usr/bin/' + program], { encoding: 'utf8' });
      for (const line of (stdout + stderr).split('\\n')) if (/not found|cannot open/.test(line)) missing.push(program + ': ' + line.trim());
    }
    const { lookup } = await import('node:dns/promises');
    const names = await Promise.all(['localhost', 'bosun'].map((name) => lookup(name, 4).then((r) => r.address, (e) => e.code)));
    console.log(JSON.stringify({ missing, names }));
  `);
  assert.deepEqual(missing, []);
  assert.deepEqual(names, ['127.0.0.1', '127.0.0.1']);
});

test('the meeting audio check passes inside the sandbox when it passes on the host', { skip: skip || hostAudio || false }, (t) => {
  const { unsupported } = runInSandbox(t, () => `
    import { pulseAudio } from '/app/src/meetings/audio.mjs';
    console.log(JSON.stringify({ unsupported: await pulseAudio.unsupported() }));
  `);
  assert.equal(unsupported, null);
});

test('PulseAudio and ffmpeg record a tone inside the sandbox', { skip: skip || hostAudio || false, timeout: 60_000 }, (t) => {
  const { state, tone, recorder } = runInSandbox(t, (dir) => `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { pulseAudio } from '/app/src/meetings/audio.mjs';
    const audio = await pulseAudio.open();
    try {
      const recorder = audio.record(${JSON.stringify(path.join(dir, 'recording.ogg'))});
      // What the browser does in a meeting: play into bosun_out, whose monitor the recorder reads.
      const tone = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-f', 'pulse', '-server', audio.browserEnv.PULSE_SERVER, '-device', 'bosun_out', 'tone'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = '';
      tone.stderr.on('data', (chunk) => { error += chunk; });
      const [code] = await once(tone, 'exit');
      const ended = await recorder.stop();
      console.log(JSON.stringify({ tone: { code, error }, recorder: { ended: !!ended && !ended.error, started: recorder.audioStartedAt !== null, error: recorder.error() } }));
    } finally { await audio.close(); }
  `, { timeout: 45_000 });
  assert.deepEqual(tone, { code: 0, error: '' });
  assert.equal(recorder.ended, true, recorder.error);
  assert.equal(recorder.started, true, recorder.error);
  const file = path.join(state, 'recording.ogg');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), 'OggS');
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
  assert.equal(info.streams[0].codec_name, 'opus');
  assert.equal(info.streams[0].channels, 1);
  assert.ok(Number(info.format.duration) >= 2, `duration ${info.format.duration}`);
  const volume = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).stderr.toString();
  const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(volume)?.[1]);
  assert.ok(mean > -30, `the tone was not recorded: mean volume ${mean} dB`);
});

// Reaches the sites the way the test host can, outside any sandbox: the reference the sandboxed browser is held to.
async function online() {
  if (process.env.BOSUN_TEST_OFFLINE === '1') return false;
  try { return (await fetch('https://www.google.com/generate_204', { signal: AbortSignal.timeout(8000) })).status === 204; } catch { return false; }
}
const offline = skip || (await online() ? false : 'needs the internet (www.google.com is not reachable from this host)');

test('a sandboxed browser loads www.google.com and meet.google.com through the relay', { skip: offline, timeout: 120_000 }, async (t) => {
  // Headful under the worker's own Xvfb when the host has one, as a deployment with meetings runs.
  const svc = await startBosun({ BROWSER_TOKENS: '', BROWSER_TOKEN: TOKEN, BOSUN_TENANT_SANDBOX: 'on', FEATURES_ENGINES: 'chromium',
    ENGINE: 'chromium', KEEPALIVE: '0', HEADLESS: has('Xvfb') ? '0' : '1' });
  t.after(() => svc.stop());
  const client = await connect(svc);
  t.after(() => client.close());
  const session = await client.open();
  for (const [url, landed] of [['https://www.google.com/', /^https:\/\/www\.google\.com\//], ['https://meet.google.com/', /^https:\/\/(meet|workspace)\.google\.com\//]]) {
    const started = Date.now();
    const result = await client.call('navigate', { session, url });
    assert.equal(result.isError, false, `${url}: ${result.text}`);
    const page = result.json();
    assert.equal(page.status, 200, url);
    assert.match(page.url, landed);
    assert.ok(Date.now() - started < 30_000, `${url} took ${Date.now() - started} ms`);
  }
});
