// Environment -> validated configuration. Anything malformed or unsafe throws, so the service refuses to start.
import { isLoopbackHost, parsePolicies, parseTokens } from './auth.mjs';
import { parseTenantAllow } from './allow.mjs';
import { ENGINE_NAMES } from './engines.mjs';
import { parseToolTimeouts } from './deadline.mjs';
import { parseMacroSource } from './macros.mjs';

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(String(raw).trim())) throw new Error(`${name} must be a whole number (got "${raw}")`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max} (got ${n})`);
  return n;
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// A 0/1 switch. Anything else stops the service rather than silently turning a feature on or off.
function flag(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (raw !== '0' && raw !== '1') throw new Error(`${name} must be 0 or 1 (got "${raw}")`);
  return raw === '1';
}

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
    // Per-call deadline of each tool, ms (src/deadline.mjs): TOOL_TIMEOUT_SEC for all, TOOL_TIMEOUTS per tool.
    toolTimeouts: parseToolTimeouts(env),
    engine: env.ENGINE || 'chromium',
    camoufoxOs: env.CAMOUFOX_OS || null, // null: the host's OS
    keepalive: env.KEEPALIVE !== '0', // run scheduled keepalive visits (configured with keepalive_set)
    tz: env.TZ || 'Europe/Vienna', // local time for keepalive quiet_hours
    recordingRetentionDays: int(env, 'RECORDING_RETENTION_DAYS', 30, 1, 3650), // meeting recordings are deleted after this
    meetingOwner: (env.MEETING_OWNER || '').trim().slice(0, 60) || null, // named in the meeting announcement ("X's AI notetaker")
    // Live transcript of meetings (meeting_join live_transcript): ElevenLabs Scribe realtime, at most this many minutes a
    // day per tenant (local day, TZ). elevenlabs: null without ELEVENLABS_API_KEY (the key is also what elevenlabs TTS
    // uses). ELEVENLABS_BASE_URL: an ElevenLabs API host (https://*.elevenlabs.io, e.g. the EU residency one) or a local
    // test server; nothing else gets the key.
    liveTranscriptDailyMin: int(env, 'LIVE_TRANSCRIPT_DAILY_MIN', 180, 1, 24 * 60),
    elevenlabs: null,
    // Speaking in meetings (meeting_speak with text): the local OpenAI-style TTS service (Supertonic) and its default
    // voice. The env fallbacks of the speech settings (src/meetings/settings.mjs; null: not set): the backend
    // meeting_speak uses when none is passed (TTS_DEFAULT_BACKEND; elevenlabs without a key falls back to supertonic,
    // and ttsWarning says so at start), the ElevenLabs model, the pause that ends a live transcript segment.
    ttsUrl: null,
    ttsVoice: env.TTS_VOICE || null,
    ttsDefaultBackendEnv: null,
    elevenlabsTtsModelEnv: null,
    vadSilenceEnv: null,
    ttsWarning: null,
    tokens: parseTokens(env),
    // Features a deployment can switch off. FEATURES_MEETINGS=0: no meeting tools, handlers or recordings directory.
    // FEATURES_UPLOADS=0: no upload tools and no PUT endpoint.
    features: { meetings: flag(env, 'FEATURES_MEETINGS', true), uploads: flag(env, 'FEATURES_UPLOADS', true) },
    // Chromium's own sandbox. On by default: a renderer that runs untrusted web content must not sit directly on the
    // service user. 0 is an explicit, logged choice (see README > Chromium sandbox).
    chromiumSandbox: flag(env, 'CHROMIUM_SANDBOX', true),
    engines: null, // engines a session may choose
    tenantAllow: null, // tenant -> host patterns (per-tenant host allowlist, BROWSER_TENANT_ALLOW)
    // Downloads a page starts: off for every tenant not named in BROWSER_TENANT_DOWNLOAD_ALLOW (tenant -> host
    // patterns); a tenant that is named keeps the downloads its pages start from those hosts (src/downloads.mjs).
    downloadAllow: null,
    policies: null,
    ws: null,
    live: null,
  };
  if (!ENGINE_NAMES.includes(cfg.engine)) throw new Error(`ENGINE must be one of ${ENGINE_NAMES.join(', ')} (got "${cfg.engine}")`);
  try { new Intl.DateTimeFormat('en', { timeZone: cfg.tz }); } catch { throw new Error(`TZ must be an IANA time zone such as Europe/Vienna (got "${cfg.tz}")`); }
  if (cfg.camoufoxOs && !['macos', 'windows', 'linux'].includes(cfg.camoufoxOs)) throw new Error('CAMOUFOX_OS must be macos, windows or linux');
  // Engines a session may ask for: FEATURES_ENGINES (default: all of them), plus the configured default engine.
  const wanted = env.FEATURES_ENGINES ? list(env.FEATURES_ENGINES) : ENGINE_NAMES;
  for (const e of wanted) if (!ENGINE_NAMES.includes(e)) throw new Error(`FEATURES_ENGINES must be a comma list of ${ENGINE_NAMES.join(', ')} (got "${e}")`);
  cfg.engines = ENGINE_NAMES.filter((e) => e === cfg.engine || wanted.includes(e));
  cfg.tenantAllow = parseTenantAllow(env, cfg.tokens);
  // Before 0.11, DOWNLOADS=1 let every tenant download from anywhere, bounded by DOWNLOADS_MAX_MB per session and
  // DOWNLOADS_TOTAL_MAX_MB in all. DOWNLOADS=0 still means what it always meant; the rest stops the service rather
  // than being ignored.
  if (flag(env, 'DOWNLOADS', false)) throw new Error('DOWNLOADS=1 was replaced in 0.11 by BROWSER_TENANT_DOWNLOAD_ALLOW=<tenant>=<host>,<host> (a tenant with "*" may download from any host)');
  for (const old of ['DOWNLOADS_MAX_MB', 'DOWNLOADS_TOTAL_MAX_MB']) {
    if (env[old] !== undefined && env[old] !== '') throw new Error(`${old} was replaced in 0.11 by DOWNLOAD_MAX_BYTES (per file) and DOWNLOAD_TENANT_QUOTA_BYTES (per tenant)`);
  }
  cfg.downloadAllow = parseTenantAllow(env, cfg.tokens, { name: 'BROWSER_TENANT_DOWNLOAD_ALLOW', empty: 'keep downloads off for it' });
  // Downloads: the largest file, what one tenant may hold at a time, how long a file is kept and how long a GET URL
  // for it stays valid.
  cfg.downloadMaxBytes = int(env, 'DOWNLOAD_MAX_BYTES', 300 * 1024 * 1024, 1, 1024 ** 4);
  cfg.downloadQuotaBytes = int(env, 'DOWNLOAD_TENANT_QUOTA_BYTES', Math.max(1024 ** 3, cfg.downloadMaxBytes), cfg.downloadMaxBytes, 1024 ** 5);
  cfg.downloadTtlMs = int(env, 'DOWNLOAD_TTL_SEC', 3600, 10, 7 * 86400) * 1000;
  cfg.downloadUrlTtlMs = int(env, 'DOWNLOAD_URL_TTL_SEC', 900, 10, 86400) * 1000;
  // File uploads into pages: the largest file, what one tenant may hold at a time, how long a file is kept and how
  // long an upload URL stays valid. UPLOAD_BASE_URL: where tenants reach the MCP port, when the Host header they
  // connect with is not it (TLS in front, another name).
  cfg.uploadMaxBytes = int(env, 'UPLOAD_MAX_BYTES', 300 * 1024 * 1024, 1, 1024 ** 4);
  cfg.uploadQuotaBytes = int(env, 'UPLOAD_TENANT_QUOTA_BYTES', Math.max(1024 ** 3, cfg.uploadMaxBytes), cfg.uploadMaxBytes, 1024 ** 5);
  cfg.uploadTtlMs = int(env, 'UPLOAD_TTL_SEC', 3600, 10, 7 * 86400) * 1000;
  cfg.uploadUrlTtlMs = int(env, 'UPLOAD_URL_TTL_SEC', 900, 10, 86400) * 1000;
  cfg.uploadBaseUrl = null;
  if (env.UPLOAD_BASE_URL) {
    let u;
    try { u = new URL(env.UPLOAD_BASE_URL); } catch { throw new Error('UPLOAD_BASE_URL is not a valid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('UPLOAD_BASE_URL must be http(s)');
    cfg.uploadBaseUrl = u.href.replace(/\/+$/, '');
  }
  cfg.maxSessionsPerTenant = int(env, 'MAX_SESSIONS_PER_TENANT', cfg.maxSessions, 1, cfg.maxSessions);
  cfg.policies = parsePolicies(env, cfg.tokens);
  // A read-only token never writes a file: naming one for downloads is a mistake, not something to ignore.
  for (const t of cfg.downloadAllow.keys()) {
    if (cfg.policies.get(t) === 'ephemeral') throw new Error(`BROWSER_TENANT_DOWNLOAD_ALLOW names tenant "${t}", whose policy is ephemeral (read-only tokens cannot download)`);
  }
  // A read-only tenant that runs the macros of another tenant (BROWSER_MACRO_SOURCE=swarm=me).
  cfg.macroSource = parseMacroSource(env, cfg.tokens, cfg.policies);
  // Session cap of each tenant with policy "ephemeral".
  cfg.ephemeralMaxSessions = int(env, 'BROWSER_EPHEMERAL_MAX_SESSIONS', Math.min(2, cfg.maxSessionsPerTenant), 1, cfg.maxSessionsPerTenant);

  // Speech fallbacks (checked also without a key, so that a typo shows at start).
  if (env.ELEVENLABS_TTS_MODEL) {
    if (!/^[a-z0-9_]{3,60}$/.test(env.ELEVENLABS_TTS_MODEL)) throw new Error('ELEVENLABS_TTS_MODEL must be an ElevenLabs model id such as eleven_v4_turbo');
    cfg.elevenlabsTtsModelEnv = env.ELEVENLABS_TTS_MODEL;
  }
  if (env.LIVE_TRANSCRIPT_VAD_SILENCE_S) {
    const s = Number(env.LIVE_TRANSCRIPT_VAD_SILENCE_S);
    if (!/^\d+(?:\.\d+)?$/.test(env.LIVE_TRANSCRIPT_VAD_SILENCE_S) || s < 0.2 || s > 3) throw new Error('LIVE_TRANSCRIPT_VAD_SILENCE_S must be seconds from 0.2 to 3');
    cfg.vadSilenceEnv = s;
  }
  if (env.ELEVENLABS_API_KEY) {
    const key = String(env.ELEVENLABS_API_KEY).trim();
    if (!/^[\x21-\x7e]{10,200}$/.test(key)) throw new Error('ELEVENLABS_API_KEY is not a valid API key');
    let base;
    try { base = new URL(env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io'); } catch { throw new Error('ELEVENLABS_BASE_URL is not a valid URL'); }
    const local = base.protocol === 'http:' && isLoopbackHost(base.hostname.replace(/^\[|\]$/g, ''));
    if (!local && !(base.protocol === 'https:' && /(?:^|\.)elevenlabs\.io$/.test(base.hostname))) throw new Error('ELEVENLABS_BASE_URL must be an https://*.elevenlabs.io host (or http on loopback, for tests)');
    if (base.pathname !== '/' || base.search || base.username || base.password) throw new Error('ELEVENLABS_BASE_URL is a host only (no path, query or credentials)');
    const voice = env.ELEVENLABS_VOICE || null;
    if (voice && !/^[A-Za-z0-9]{10,40}$/.test(voice)) throw new Error('ELEVENLABS_VOICE must be an ElevenLabs voice id');
    cfg.elevenlabs = { apiKey: key, baseUrl: base.origin, voice };
  }
  if (env.TTS_DEFAULT_BACKEND) {
    const backend = env.TTS_DEFAULT_BACKEND;
    if (!['supertonic', 'elevenlabs'].includes(backend)) throw new Error(`TTS_DEFAULT_BACKEND must be supertonic or elevenlabs (got "${backend}")`);
    cfg.ttsDefaultBackendEnv = backend;
    if (backend === 'elevenlabs' && !cfg.elevenlabs) cfg.ttsWarning = 'TTS_DEFAULT_BACKEND=elevenlabs but ELEVENLABS_API_KEY is not set: meeting_speak uses supertonic';
  }
  if (env.TTS_URL) {
    let u;
    try { u = new URL(env.TTS_URL); } catch { throw new Error('TTS_URL is not a valid URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('TTS_URL must be http(s)');
    if (u.search || u.username || u.password) throw new Error('TTS_URL is a base URL (no query or credentials)');
    cfg.ttsUrl = u.href.replace(/\/+$/, '');
  }

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
