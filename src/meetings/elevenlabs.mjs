// Only this client attaches the installation credential, for both HTTP and WebSocket requests.
import { TENANT_RE } from '../auth.mjs';
import { nodeDebugOn } from '../secrets.mjs';

export const ELEVENLABS_UNAVAILABLE = 'not available for this tenant';
export const ELEVENLABS_DENIED = `ElevenLabs is ${ELEVENLABS_UNAVAILABLE}`;
export const ELEVENLABS_FALLBACK = `${ELEVENLABS_DENIED}: using supertonic`;
export const NODE_DEBUG_REFUSED = 'NODE_DEBUG is set (Node would log the request headers with the ElevenLabs key); the operator has to switch it off';

// An operator's explicit tenant setting wins over the installation fallback.
export function elevenLabsAllowed(cfg, tenant) {
  return typeof tenant === 'string' && TENANT_RE.test(tenant)
    && (cfg.elevenlabsTenantOverrides?.get(tenant) ?? (cfg.elevenlabsTenants?.has(tenant) ?? true));
}

export function elevenLabsHeaders(cfg, tenant) {
  if (!elevenLabsAllowed(cfg, tenant)) throw new Error(ELEVENLABS_DENIED);
  const key = cfg.elevenlabs?.apiKey;
  if (!key) throw new Error('no ElevenLabs key configured (ELEVENLABS_API_KEY)');
  if (nodeDebugOn()) throw new Error(NODE_DEBUG_REFUSED);
  return { 'xi-api-key': key };
}
