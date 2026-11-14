// Opt-in snapshots belong to the locked tenant profile, alongside Chromium/Firefox's own cookie store.
// Never expose cookies or raw driver/filesystem errors: addCookies errors can contain cookie values.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { driverLogsValues } from './secrets.mjs';

export const SESSION_COOKIES_FILE = 'session-cookies.json';
export const DEFAULT_MAX_AGE_MS = 30 * 86400_000;
const fileFor = (dir) => path.join(dir, SESSION_COOKIES_FILE);
const key = (c) => JSON.stringify([c.domain, c.name, c.path, c.partitionKey ?? null]);

// These diagnostics bypass Bosun's logger and can print cookie API payloads. Match the typed-secret guard.
export function checkSessionCookieLogs() {
  if (driverLogsValues()) throw new Error('session cookie persistence is refused while DEBUG enables sensitive Playwright logs or NODE_DEBUG is set; disable those diagnostics');
}

export function deleteSessionCookies(dir) {
  try { fs.rmSync(fileFor(dir), { force: true }); }
  catch { throw new Error('could not delete saved session cookies'); }
}

export async function restoreSessionCookies(ctx, dir, maxAgeMs = DEFAULT_MAX_AGE_MS) {
  checkSessionCookieLogs();
  try {
    const file = fileFor(dir);
    let stat;
    try { stat = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (Date.now() - stat.mtimeMs > maxAgeMs) { deleteSessionCookies(dir); return; }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(saved)) throw new Error();
    const existing = new Set((await ctx.cookies()).map(key));
    const missing = saved.filter((c) => {
      if (!c || c.expires !== -1 || typeof c.domain !== 'string' || typeof c.name !== 'string' || typeof c.path !== 'string' || typeof c.value !== 'string') throw new Error();
      const id = key(c);
      if (existing.has(id)) return false;
      existing.add(id);
      return true;
    });
    if (missing.length) await ctx.addCookies(missing);
  } catch { throw new Error('could not restore saved session cookies'); }
}

// The caller's close grace can expire while cookies() is pending. Check again before touching disk so a late
// response cannot overwrite a newer open's snapshot, resurrect a disabled file, or recreate a deleted profile.
export async function saveSessionCookies(ctx, dir, canSave = () => true) {
  let tmp;
  try {
    checkSessionCookieLogs();
    const cookies = (await ctx.cookies()).filter((c) => c.expires === -1);
    if (!canSave()) return;
    tmp = path.join(dir, `${SESSION_COOKIES_FILE}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(cookies), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, fileFor(dir));
  } catch { throw new Error('could not save session cookies'); }
  finally { if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} } }
}
