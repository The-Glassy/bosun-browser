// Service assembly: config -> live view, session manager, transports; idempotent bounded shutdown.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.mjs';
import { createLiveView } from './liveview.mjs';
import { SessionManager } from './sessions.mjs';
import { startWsServer } from './wsserver.mjs';
import { buildServer, wall } from './tools.mjs';
import { Keepalive } from './keepalive.mjs';
import { EventBus } from './events.mjs';
import { Meetings } from './meetings/index.mjs';

export async function startService(cfg, { engines, keepalive: kaOpts = {}, meetings: mOpts = {} } = {}) {
  let live = null;
  if (cfg.live) {
    live = createLiveView({ port: cfg.live.port, host: cfg.live.host, baseUrl: cfg.live.baseUrl, ttlMs: cfg.handoffTtlMs });
    await live.listen();
  }
  const manager = new SessionManager(cfg, { live, engines });
  // The default engine (package and browser binary) must be installed; others are checked when a session asks.
  try { await manager.engines.check(cfg.engine, cfg); } catch (e) { await live?.close(); throw e; }
  const events = manager.events = new EventBus();
  let keepalive;
  try {
    keepalive = manager.keepalive = new Keepalive({ cfg, manager, wall, emit: (e) => events.needsHuman(e), onWatch: (e) => events.watchChanged(e), ...kaOpts });
    manager.meetings = new Meetings({ cfg, manager, bus: events, ...mOpts });
  } catch (e) { await live?.close(); throw e; }
  if (cfg.keepalive) keepalive.start();
  const ws = cfg.ws ? await startWsServer({ cfg, manager }) : null;

  let closing = null;
  const shutdown = () => (closing ??= (async () => {
    // Stop admission first, then tear down handoffs and sessions (each close is deadline-bounded).
    manager.closing = true;
    await Promise.allSettled([keepalive.stop(), manager.meetings.stop()]);
    await Promise.allSettled([ws?.close(), live?.close()]);
    await manager.closeAll();
  })());
  return { cfg, live, manager, ws, keepalive, events, meetings: manager.meetings, shutdown };
}

export async function main(env = process.env) {
  const cfg = loadConfig(env);
  const svc = await startService(cfg);
  const exit = (code) => {
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    svc.shutdown().then(() => process.exit(code), () => process.exit(1));
  };
  process.on('SIGINT', () => exit(0));
  process.on('SIGTERM', () => exit(0));

  if (svc.ws) {
    console.error(`bosun: MCP over WebSocket on ${cfg.ws.host}:${svc.ws.port}${cfg.ws.allowNoToken ? ' (NO AUTH — local development)' : ''}`);
  } else {
    process.stdin.on('close', () => exit(0));
    await buildServer({ manager: svc.manager, owner: 'stdio', tenant: 'default', cfg }).connect(new StdioServerTransport());
  }
  if (svc.live) console.error(`bosun: live view on ${cfg.live.host}:${svc.live.port}`);
  return svc;
}
