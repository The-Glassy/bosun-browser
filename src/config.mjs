// Environment -> validated configuration. Anything malformed or unsafe throws, so the service refuses to start.
import { isLoopbackHost, parseTokens } from './auth.mjs';
import { ENGINE_NAMES } from './engines.mjs';

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(String(raw).trim())) throw new Error(`${name} must be a whole number (got "${raw}")`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const cfg = {
    dataDir: env.BROWSER_DATA || './data',
    headless: env.HEADLESS === '1',
    maxSessions: int(env, 'MAX_SESSIONS', 3, 1, 1000),
    idleTimeoutMs: int(env, 'IDLE_TIMEOUT_SEC', 900, 0, 7 * 86400) * 1000, // 0 = never reap idle sessions
    handoffTtlMs: int(env, 'HANDOFF_TTL_SEC', 900, 10, 86400) * 1000,
    saveShots: env.SAVE_SHOTS === '1',
    shotsPerSession: int(env, 'SHOTS_PER_SESSION', 20, 1, 1000),
    maxInflight: int(env, 'MAX_INFLIGHT', 8, 1, 1000), // concurrent tool calls per connection
    maxPagesPerSession: int(env, 'MAX_PAGES_PER_SESSION', 5, 1, 100),
    maxDomNodes: int(env, 'MAX_DOM_NODES', 60000, 100, 10_000_000),
    engine: env.ENGINE || 'chromium',
    camoufoxOs: env.CAMOUFOX_OS || null, // null: the host's OS
    keepalive: env.KEEPALIVE !== '0', // run scheduled keepalive visits (configured with keepalive_set)
    tz: env.TZ || 'Europe/Vienna', // local time for keepalive quiet_hours
    tokens: parseTokens(env),
    ws: null,
    live: null,
  };
  if (!ENGINE_NAMES.includes(cfg.engine)) throw new Error(`ENGINE must be one of ${ENGINE_NAMES.join(', ')} (got "${cfg.engine}")`);
  try { new Intl.DateTimeFormat('en', { timeZone: cfg.tz }); } catch { throw new Error(`TZ must be an IANA time zone such as Europe/Vienna (got "${cfg.tz}")`); }
  if (cfg.camoufoxOs && !['macos', 'windows', 'linux'].includes(cfg.camoufoxOs)) throw new Error('CAMOUFOX_OS must be macos, windows or linux');
  cfg.maxSessionsPerTenant = int(env, 'MAX_SESSIONS_PER_TENANT', cfg.maxSessions, 1, cfg.maxSessions);

  if (env.WS_PORT !== undefined && env.WS_PORT !== '') {
    const host = env.WS_HOST || '127.0.0.1';
    cfg.ws = {
      host,
      port: int(env, 'WS_PORT', 0, 0, 65535),
      maxConnections: int(env, 'MAX_CONNECTIONS', 32, 1, 10000),
      allowedOrigins: list(env.WS_ALLOWED_ORIGINS),
      allowNoToken: false,
    };
    if (!cfg.tokens.length) {
      if (!isLoopbackHost(host)) throw new Error(`refusing to listen on ${host} without BROWSER_TOKEN (or BROWSER_TOKENS)`);
      if (env.ALLOW_NO_TOKEN !== '1') throw new Error('set BROWSER_TOKEN, or ALLOW_NO_TOKEN=1 for unauthenticated local development on loopback');
      cfg.ws.allowNoToken = true;
    }
  }

  if (env.LIVE_PORT !== undefined && env.LIVE_PORT !== '') {
    const host = env.LIVE_HOST || '127.0.0.1';
    const port = int(env, 'LIVE_PORT', 0, 0, 65535);
    const baseUrl = env.LIVE_BASE_URL || null; // null: derived from the bound address
    if (baseUrl) {
      let u;
      try { u = new URL(baseUrl); } catch { throw new Error('LIVE_BASE_URL is not a valid URL'); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('LIVE_BASE_URL must be http(s)');
    }
    cfg.live = { host, port, baseUrl };
  }
  return cfg;
}
