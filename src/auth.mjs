// Bearer-token authentication: token -> tenant, compared in constant time.
import crypto from 'crypto';

export const TENANT_RE = /^[a-z0-9_-]{1,40}$/;
export const MIN_TOKEN_LENGTH = 16;
// full: every tool. ephemeral: ephemeral sessions and page tools only (see EPHEMERAL_TOOLS in tools.mjs).
export const POLICIES = ['full', 'ephemeral'];
export const NOT_ALLOWED = 'not allowed for this token';
export const PROFILES_REFUSED = `profiles are not allowed for this token (policy ephemeral); open the session without profile`;

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Returns (presented) => tenant | null. Every configured token is compared, with fixed-length digests, so timing
// depends neither on where the strings differ nor on which entry matched.
export function createAuthenticator(tokens) {
  const entries = tokens.map((t) => ({ tenant: t.tenant, d: digest(t.token) }));
  return (presented) => {
    const d = digest(presented ?? '');
    let tenant = null;
    for (const e of entries) if (crypto.timingSafeEqual(d, e.d) && tenant === null) tenant = e.tenant;
    return presented ? tenant : null;
  };
}

// Authorization: Bearer <token> (preferred) or the legacy ?token= query parameter.
export function tokenFromRequest(req, query) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (m) return m[1];
  return query.get('token');
}

export function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

// BROWSER_TOKEN=<token> (tenant "default") and/or BROWSER_TOKENS=<tenant>:<token>,<tenant>:<token>
export function parseTokens(env) {
  const out = [];
  if (env.BROWSER_TOKEN) out.push({ tenant: 'default', token: env.BROWSER_TOKEN });
  for (const part of (env.BROWSER_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 1) throw new Error('BROWSER_TOKENS entries must look like <tenant>:<token>');
    out.push({ tenant: part.slice(0, i), token: part.slice(i + 1) });
  }
  const seen = new Set();
  for (const t of out) {
    if (!TENANT_RE.test(t.tenant)) throw new Error(`tenant name "${t.tenant}" must match ${TENANT_RE}`);
    if (t.token.length < MIN_TOKEN_LENGTH) throw new Error(`token for tenant "${t.tenant}" is shorter than ${MIN_TOKEN_LENGTH} characters`);
    if (seen.has(t.token)) throw new Error('two tenants share the same token');
    seen.add(t.token);
  }
  return out;
}

// BROWSER_TOKEN_POLICIES=<tenant>=<policy>,… -> Map tenant -> policy. Tenants not named get "full". A named tenant
// must have a token, so a typo can't leave the intended tenant on "full".
export function parsePolicies(env, tokens) {
  const out = new Map();
  const tenants = new Set(tokens.map((t) => t.tenant));
  for (const part of (env.BROWSER_TOKEN_POLICIES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1) throw new Error('BROWSER_TOKEN_POLICIES entries must look like <tenant>=<policy>');
    const tenant = part.slice(0, i).trim(), policy = part.slice(i + 1).trim();
    if (!tenants.has(tenant)) throw new Error(`BROWSER_TOKEN_POLICIES names tenant "${tenant}", which has no token`);
    if (!POLICIES.includes(policy)) throw new Error(`policy for tenant "${tenant}" must be one of ${POLICIES.join(', ')} (got "${policy}")`);
    if (out.has(tenant)) throw new Error(`BROWSER_TOKEN_POLICIES names tenant "${tenant}" twice`);
    out.set(tenant, policy);
  }
  return out;
}

export const policyOf = (cfg, tenant) => cfg.policies?.get(tenant) ?? 'full';
