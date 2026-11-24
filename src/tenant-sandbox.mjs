// Gateway-side setup. The gateway owns all public listeners, token authentication, and host network access.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';
import { once } from 'node:events';
import { allowFor } from './allow.mjs';
import { policyOf } from './auth.mjs';
import { createExitHealth, exitsFor, selectEgress, serviceHealth } from './egress.mjs';
import { startTenantProxy } from './proxy.mjs';
import { forwardTcp } from './tenant-network.mjs';
import { connectWorker, forwardHttp, forwardUpgrade, workerHealth } from './tenant-http.mjs';
import { startWsServer } from './wsserver.mjs';
import { driverLogsValues, nodeDebugOn } from './secrets.mjs';

const APP = fileURLToPath(new URL('../', import.meta.url));
const RUN = '/run/bosun';
const WORKER_HOME = `${RUN}/home`;
const SOCKETS = { mcp: `${RUN}/ipc/mcp`, live: `${RUN}/ipc/live`, relay: `${RUN}/relay` };
const SYSTEM_MOUNTS = [
  '/bin', '/sbin', '/lib', '/lib64', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib64', '/usr/libexec',
  '/usr/share/fonts', '/usr/local/share/fonts', '/usr/share/mime', '/usr/share/X11', '/usr/share/pulseaudio',
  '/usr/share/glib-2.0', '/usr/share/ca-certificates', '/usr/share/zoneinfo', '/var/cache/fontconfig',
  '/etc/fonts', '/etc/pulse', '/etc/ssl/certs', '/etc/ca-certificates', '/etc/ld.so.cache', '/etc/nsswitch.conf',
];
const START_MS = 30_000;
const STOP_MS = 8000;

function overlap(a, b) {
  return a === b || a === '/' || b === '/' || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function caches() {
  const base = path.resolve(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
  const playwright = process.env.PLAYWRIGHT_BROWSERS_PATH;
  return [
    ...(playwright === '0' ? [] : [[path.resolve(playwright || path.join(base, 'ms-playwright')), `${RUN}/browsers`]]),
    [path.resolve(process.env.CAMOUFOX_INSTALL_DIR || path.join(base, 'camoufox')), `${RUN}/camoufox`],
  ];
}

// This filter closes socket families outside the network namespace (such as AF_VSOCK), the
// io_uring route around syscall filters, and Linux keyring access under the shared host UID.
function syscallFilter() {
  const arch = {
    x64: { audit: 0xc000003e, socket: 41, socketpair: 53, deny: [248, 249, 250, 425] },
    arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199, deny: [217, 218, 219, 425] },
  }[process.arch];
  if (!arch) throw new Error('tenant sandbox requires Linux on x64 or arm64');
  const load = 0x20, equal = 0x15, greaterOrEqual = 0x35, ret = 0x06;
  const kill = 0x80000000, deny = 0x00050001, allow = 0x7fff0000;
  const instructions = [
    [load, 0, 0, 4], [equal, 1, 0, arch.audit], [ret, 0, 0, kill],
    [load, 0, 0, 0],
    // Reject the x32 syscall ABI on x86-64 before comparing the native syscall numbers.
    [greaterOrEqual, 0, 1, 0x40000000], [ret, 0, 0, deny],
    ...arch.deny.flatMap((nr) => [[equal, 0, 1, nr], [ret, 0, 0, deny]]),
    [equal, 2, 0, arch.socket], [equal, 1, 0, arch.socketpair], [ret, 0, 0, allow],
    [load, 0, 0, 16],
    // AF_UNIX, AF_INET, AF_INET6, AF_NETLINK.
    ...[1, 2, 10, 16].flatMap((family) => [[equal, 0, 1, family], [ret, 0, 0, allow]]),
    [ret, 0, 0, deny],
  ];
  const filter = Buffer.alloc(instructions.length * 8);
  for (const [i, [code, yes, no, k]] of instructions.entries()) {
    filter.writeUInt16LE(code, i * 8);
    filter[i * 8 + 2] = yes;
    filter[i * 8 + 3] = no;
    filter.writeUInt32LE(k, i * 8 + 4);
  }
  return filter;
}

function directory(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(dir).isDirectory()) throw new Error(`sandbox state path must be a directory: ${dir}`);
}

export function sandboxCommand({ state, ipc, relay, runtime, headless, tz, script = '/app/src/tenant-worker.mjs', args = [] }) {
  const assets = caches();
  const ro = [
    ...SYSTEM_MOUNTS.map((p) => [p, p]), ...assets,
    [path.join(APP, 'src'), '/app/src'], [path.join(APP, 'node_modules'), '/app/node_modules'],
    [path.join(APP, 'package.json'), '/app/package.json'], [fs.realpathSync(process.execPath), `${RUN}/node`],
    [path.join(runtime, 'passwd'), '/etc/passwd'], [path.join(runtime, 'group'), '/etc/group'],
  ];
  return [
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--uid', '1000', '--gid', '1000', '--cap-drop', 'ALL', '--new-session', '--die-with-parent', '--hostname', 'bosun',
    '--clearenv', '--seccomp', '3',
    '--setenv', 'PATH', '/usr/bin:/bin:/usr/sbin', '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'HOME', WORKER_HOME, '--setenv', 'USER', 'bosun', '--setenv', 'LOGNAME', 'bosun',
    '--setenv', 'XDG_RUNTIME_DIR', `${WORKER_HOME}/run`, '--setenv', 'TZ', tz,
    '--setenv', 'PLAYWRIGHT_BROWSERS_PATH', process.env.PLAYWRIGHT_BROWSERS_PATH === '0' ? '0' : `${RUN}/browsers`,
    '--setenv', 'CAMOUFOX_INSTALL_DIR', `${RUN}/camoufox`,
    ...(headless ? [] : ['--setenv', 'DISPLAY', ':99']),
    '--proc', '/proc', '--dev', '/dev', '--perms', '1777', '--tmpfs', '/dev/shm',
    '--perms', '1777', '--tmpfs', '/tmp', '--dir', WORKER_HOME, '--perms', '0700', '--dir', `${WORKER_HOME}/run`,
    ...ro.flatMap(([source, dest]) => ['--ro-bind-try', source, dest]),
    '--bind', state, state, '--bind', ipc, `${RUN}/ipc`, '--ro-bind', relay, SOCKETS.relay,
    '--chdir', WORKER_HOME, '--', `${RUN}/node`, script, ...args,
  ];
}

async function hostRelays(cfg, tenant, dir, cleanup) {
  const routes = new Map();
  const providerSockets = {};
  for (const name of exitsFor(cfg, tenant)) {
    const leaf = `exit-${routes.size}`;
    const egress = selectEgress(cfg, name, tenant);
    const proxy = await startTenantProxy({ tenant, allow: allowFor(cfg, tenant), egress, pin: true, socketPath: path.join(dir, leaf) });
    cleanup.push(proxy.close);
    routes.set(name, { socketPath: `${SOCKETS.relay}/${leaf}`, username: proxy.username, password: proxy.password,
      egress: egress ? { server: egress.server } : null });
  }
  for (const [service, url] of [['tts', cfg.ttsUrl], ['elevenlabs', cfg.elevenlabs?.baseUrl]]) {
    if (!cfg.features.meetings || !url) continue;
    const target = new URL(url);
    const destination = { host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)) };
    const forwarder = await forwardTcp({ path: path.join(dir, service) }, destination);
    cleanup.push(forwarder.close);
    providerSockets[service] = `${SOCKETS.relay}/${service}`;
  }
  return { routes, providerSockets };
}

const tenantOnly = (map, tenant) => new Map(map?.has(tenant) ? [[tenant, map.get(tenant)]] : []);
const routePrefix = (tenant) => `/tenant/${tenant}`;

function workerConfig(cfg, tenant, state, token, live, routes, providerSockets) {
  return {
    ...cfg, dataDir: state, tenantSandbox: false, unsafeShared: false, metricsToken: null,
    tokens: [{ tenant, token }], policies: new Map([[tenant, policyOf(cfg, tenant)]]),
    ws: cfg.ws ? { maxConnections: cfg.ws.maxConnections, allowNoToken: false, allowedOrigins: [] } : null,
    live: live ? { baseUrl: `${live.baseUrl}${routePrefix(tenant)}` } : null, uploadBaseUrl: null,
    artifactPrefix: routePrefix(tenant), tenantAllow: tenantOnly(cfg.tenantAllow, tenant), downloadAllow: tenantOnly(cfg.downloadAllow, tenant),
    macroSource: new Map(), egressProxy: null, egressProxies: new Map(), tenantExits: new Map(), sandboxRoutes: routes, providerSockets,
  };
}

async function waitFor(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

async function startWorker(cfg, tenant, state, runtime, live, generation) {
  const root = fs.mkdtempSync(path.join(runtime, 'w-'));
  const ipc = path.join(root, 'ipc'), relay = path.join(root, 'relay');
  fs.mkdirSync(ipc, { mode: 0o700 });
  fs.mkdirSync(relay, { mode: 0o700 });
  const cleanups = [];
  let child;
  const cleanup = () => generation.cleanup ??= (async () => {
    await Promise.allSettled(cleanups.map((close) => close()));
    fs.rmSync(root, { recursive: true, force: true });
  })();
  try {
    const { routes, providerSockets } = await hostRelays(cfg, tenant, relay, cleanups);
    const token = crypto.randomBytes(32).toString('base64url');
    const options = { state, ipc, relay, runtime, headless: cfg.headless, tz: cfg.tz };
    const filter = fs.openSync(path.join(runtime, 'seccomp'), 'r');
    try {
      child = spawn('bwrap', sandboxCommand(options), { stdio: ['pipe', 'pipe', 'inherit', filter], env: { PATH: '/usr/bin:/bin' } });
    } finally { fs.closeSync(filter); }
    child.stdin.on('error', () => {});
    const next = generation.done = new Promise((resolve) => {
      child.once('close', (code) => {
        generation.worker = null;
        cleanup().finally(() => resolve(code)).catch(() => {});
      });
    });
    const spawnError = new Promise((_, reject) => child.once('error', reject));
    const config = workerConfig(cfg, tenant, state, token, live, routes, providerSockets);
    const diagnostics = { driver: driverLogsValues(), node: nodeDebugOn() };
    child.stdin.write(`${serialize({ cfg: config, sockets: SOCKETS, diagnostics }).toString('base64')}\n`);
    const ready = once(child.stdout, 'data').then(([data]) => String(data).trim() === 'ready');
    if (!await waitFor(Promise.race([ready, spawnError, next.then(() => false)]), START_MS, 'worker startup timed out')) {
      throw new Error('worker exited during preflight');
    }
    child.stdout.resume();
    const worker = {
      token, mcp: path.join(ipc, 'mcp'), live: path.join(ipc, 'live'),
      async stop() {
        child.stdin.end();
        await waitFor(next, STOP_MS, 'worker shutdown timed out').catch(async () => { child.kill('SIGKILL'); await next; });
      },
    };
    generation.worker = worker;
    return worker;
  } catch (error) {
    child?.kill('SIGKILL');
    if (generation.done) await generation.done;
    else await cleanup();
    throw new Error(`tenant ${tenant}: bwrap startup failed (${error.message})`);
  }
}

export function createSandboxRuntime(dataDir) {
  if (process.platform !== 'linux' || process.getuid() === 0) throw new Error('tenant sandbox requires an unprivileged Linux service user');
  const filter = syscallFilter();
  const immutable = [...SYSTEM_MOUNTS, ...caches().map(([source]) => source),
    path.join(APP, 'src'), path.join(APP, 'node_modules'), path.join(APP, 'package.json'), fs.realpathSync(process.execPath)];
  const protectedPaths = ['/proc', '/sys', '/dev', '/etc', '/app', RUN, ...immutable];
  const checkDataRoot = (dir) => {
    if (protectedPaths.some((p) => overlap(dir, p) || (fs.existsSync(p) && overlap(dir, fs.realpathSync(p))))) {
      throw new Error('BROWSER_DATA overlaps a tenant sandbox runtime path');
    }
  };
  checkDataRoot(path.resolve(dataDir));
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(dataDir);
  checkDataRoot(root);
  const tenants = path.join(root, 'tenants');
  directory(tenants);
  // Keep AF_UNIX paths short and leave the writable worker sockets out of every other worker's mount list.
  const runtime = fs.mkdtempSync('/tmp/bosun-s-');
  try {
    fs.writeFileSync(path.join(runtime, 'seccomp'), filter, { mode: 0o600 });
    fs.writeFileSync(path.join(runtime, 'passwd'), `root:x:0:0:root:/root:/bin/false\nbosun:x:1000:1000:Bosun:${WORKER_HOME}:/bin/false\n`, { mode: 0o644 });
    fs.writeFileSync(path.join(runtime, 'group'), 'root:x:0:\nbosun:x:1000:\n', { mode: 0o644 });
    return {
      runtime,
      state(tenant) {
        const state = path.join(tenants, tenant);
        directory(state);
        return state;
      },
      close() { fs.rmSync(runtime, { recursive: true, force: true }); },
    };
  } catch (error) {
    fs.rmSync(runtime, { recursive: true, force: true });
    throw error;
  }
}

async function startLiveGateway(cfg, getExisting) {
  const extract = (url, kind) => new RegExp(`^/tenant/([a-z0-9_-]{1,40})(/${kind}/[a-f0-9]{32})(?:\\?.*)?$`).exec(url);
  const server = http.createServer((req, res) => {
    const match = extract(req.url, 'v');
    const worker = match && getExisting(match[1]);
    if (!worker) return res.writeHead(404).end();
    try { forwardHttp(req, res, worker.live, match[2]); } catch { res.writeHead(503).end(); }
  });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    const match = extract(req.url, 'ws');
    const worker = match && getExisting(match[1]);
    if (!worker) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    try { forwardUpgrade(req, socket, head, worker.live, match[2]); } catch { socket.destroy(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => { server.off('error', reject); resolve(); });
  });
  const { address, family, port } = server.address();
  const bind = { '0.0.0.0': '127.0.0.1', '::': '::1' }[address] || address;
  const baseUrl = cfg.baseUrl?.replace(/\/$/, '') || `http://${family === 'IPv6' ? `[${bind}]` : bind}:${port}`;
  return {
    baseUrl, port,
    async close() {
      const done = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}

export async function startTenantService(cfg) {
  const tenants = new Set(cfg.tokens.map(({ tenant }) => tenant));
  if (!tenants.size) tenants.add('default');
  if (!cfg.ws && tenants.size > 1) throw new Error('sandboxed stdio requires one tenant; set WS_PORT for multiple tenants');
  const sandbox = createSandboxRuntime(cfg.dataDir);
  const generations = new Map();
  let live, ws, closing = false;
  const getExisting = (tenant) => generations.get(tenant)?.worker;
  const getWorker = async (tenant) => {
    if (closing || !tenants.has(tenant)) throw new Error('tenant worker unavailable');
    const current = generations.get(tenant);
    if (current) return current.start;
    const generation = {};
    generations.set(tenant, generation);
    generation.start = Promise.resolve().then(() => startWorker(cfg, tenant, sandbox.state(tenant), sandbox.runtime, live, generation));
    const forget = () => { if (generations.get(tenant) === generation) generations.delete(tenant); };
    generation.start.then(() => generation.done.then(forget), forget);
    return generation.start;
  };
  const exitHealth = createExitHealth(cfg);
  const engineHealth = async (tenant) => {
    try {
      const worker = await getWorker(tenant);
      const report = await workerHealth(worker.mcp, worker.token);
      return cfg.engines.map((name) => report.some((entry) => entry.name === name && entry.ok === true)
        ? { name, ok: true } : { name, ok: false, error: 'browser launch check failed' });
    } catch { return cfg.engines.map((name) => ({ name, ok: false, error: 'tenant worker unavailable' })); }
  };
  const manager = { exitHealth, health: (tenant) => serviceHealth(cfg, exitHealth, () => engineHealth(tenant), () => closing) };

  const routeHttp = (req, res, authenticated) => {
    const route = /^(?:\/tenant\/([a-z0-9_-]{1,40}))?(\/(?:upload|download|recording|secret)\/[^?]+(?:\?.*)?)$/.exec(req.url);
    if (!route) return false;
    const [, prefixTenant, url] = route;
    const tenant = prefixTenant || authenticated;
    if (!tenant) { res.writeHead(401).end(); req.resume(); return true; }
    if (authenticated !== null && authenticated !== tenant) {
      res.writeHead(403).end();
      req.resume();
      return true;
    }
    const worker = getExisting(tenant);
    if (!worker) { res.writeHead(404).end(); req.resume(); return true; }
    try { forwardHttp(req, res, worker.mcp, url, authenticated ? worker.token : null); }
    catch { res.writeHead(503).end(); req.resume(); }
    return true;
  };

  let shutdownPromise;
  const shutdown = () => shutdownPromise ??= (async () => {
    closing = true;
    await Promise.allSettled([ws?.close(), live?.close()]);
    await Promise.allSettled([...generations.values()].map(async ({ start }) => (await start).stop()));
    sandbox.close();
  })();
  const connect = (transport, tenant, base) => connectWorker(transport, () => getWorker(tenant), base);
  try {
    if (cfg.live) live = await startLiveGateway(cfg.live, getExisting);
    await Promise.all([...tenants].map(getWorker));
    if (cfg.ws) ws = await startWsServer({ cfg, manager, connect, routeHttp });
    const connectStdio = (transport, disconnected) =>
      connectWorker(transport, () => getWorker(tenants.values().next().value), null, disconnected);
    return { cfg, manager, ws, live, shutdown, connectStdio };
  } catch (error) {
    await shutdown();
    throw error;
  }
}
