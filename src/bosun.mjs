// Service assembly: config -> live view, session manager, transports; idempotent bounded shutdown.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.mjs';
import { createLiveView } from './liveview.mjs';
import { SessionManager } from './sessions.mjs';
import { startWsServer } from './wsserver.mjs';
import { buildServer } from './tools.mjs';

export async function startService(cfg, { engines } = {}) {
  let live = null;
  if (cfg.live) {
    live = createLiveView({ port: cfg.live.port, host: cfg.live.host, baseUrl: cfg.live.baseUrl, ttlMs: cfg.handoffTtlMs });
    await live.listen();
  }
  const manager = new SessionManager(cfg, { live, engines });
  // The default engine (package and browser binary) must be installed; others are checked when a session asks.
  try { await manager.engines.check(cfg.engine, cfg); } catch (e) { await live?.close(); throw e; }
  const ws = cfg.ws ? await startWsServer({ cfg, manager }) : null;

  let closing = null;
  const shutdown = () => (closing ??= (async () => {
    // Stop admission first, then tear down handoffs and sessions (each close is deadline-bounded).
    manager.closing = true;
    await Promise.allSettled([ws?.close(), live?.close()]);
    await manager.closeAll();
  })());
  return { cfg, live, manager, ws, shutdown };
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
