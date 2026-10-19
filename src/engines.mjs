// Browser engines. chromium: Playwright's Chromium (shared browser, one context per session). patchright: Playwright
// fork that hides CDP/automation leaks (one persistent-context process per session, its recommended mode).
// camoufox: anti-detect Firefox via camoufox-js launch options, driven by our Playwright (one process per session).
// patchright and camoufox-js are optional dependencies, loaded on first use.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const ENGINE_NAMES = ['chromium', 'patchright', 'camoufox'];
const CHROMIUM_ARGS = ['--disable-blink-features=AutomationControlled'];

const INSTALL = {
  chromium: 'npx playwright install chromium',
  patchright: 'npm install patchright@1.64.1 && npx patchright install chromium',
  camoufox: 'npm install camoufox-js@0.13.0 && npx camoufox-js fetch',
};

export class EngineUnavailableError extends Error {}

const missingModule = (e) => e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND';
const missingBinary = (e) => e?.binary || ['CamoufoxNotInstalled', 'FileNotFoundError'].includes(e?.constructor?.name) ||
  /Executable doesn't exist|camoufox fetch/i.test(String(e?.message || e));

// Rethrow launch failures caused by a missing install as a clear, actionable error.
function explain(name, e) {
  if (missingModule(e)) return new EngineUnavailableError(`engine ${name} is not installed — run: ${INSTALL[name]}`);
  if (missingBinary(e)) return new EngineUnavailableError(`engine ${name}: browser binary missing — run: ${INSTALL[name]}`);
  return e;
}

const defaultImporter = (spec) => import(spec);

const hostOs = () => ({ darwin: 'macos', win32: 'windows' })[process.platform] || 'linux';

// Each engine: { name, family, cdp, shared, tracker, load(), check(bt, cfg), open(bt, {cfg, dir, locale, timezone,
// shared, media}) -> {ctx, browser?} }. media ({args, env}, meetings only, Chromium family): extra browser flags and the
// environment of a browser process of its own (its audio server). shared: ephemeral sessions are contexts of one shared browser (manager.getBrowser);
// every other session is a persistent context in a directory Bosun owns (a profile or a temp dir), so its browser
// processes can be found by that directory. tracker: how the password tracker gets into Bosun's evaluation world
// ('init' script, or 'navigate': evaluate after every frame navigation). check: throws if the browser binary is absent.
const exists = (exe) => { if (!exe || !fs.existsSync(exe)) throw Object.assign(new Error(`Executable doesn't exist at ${exe}`), { binary: true }); };
function definitions(importer) {
  return {
    chromium: {
      name: 'chromium', family: 'chromium', cdp: true, shared: true, tracker: 'init',
      async load() { return (await importer('playwright')).chromium; },
      // Headless runs use Playwright's separate headless shell, whose path the API doesn't expose: checked at launch.
      check: (bt, cfg) => { if (!cfg.headless) exists(bt.executablePath()); },
      launchShared: (bt, cfg) => bt.launch({ headless: cfg.headless, args: CHROMIUM_ARGS }),
      async open(bt, { cfg, dir, locale, timezone, shared, media }) {
        const o = { viewport: { width: 1366, height: 900 }, locale, timezoneId: timezone };
        if (dir) return { ctx: await bt.launchPersistentContext(dir, { headless: cfg.headless, args: [...CHROMIUM_ARGS, ...(media?.args || [])], ...(media?.env ? { env: media.env } : {}), ...o }) };
        const browser = await shared();
        return { ctx: await browser.newContext(o), browser };
      },
    },
    patchright: {
      name: 'patchright', family: 'chromium', cdp: true, shared: false, tracker: 'navigate',
      async load() { return (await importer('patchright')).chromium; },
      check: (bt) => exists(bt.executablePath()),
      // Recommended patchright setup: persistent context, no custom UA/headers, no automation-flag args, the
      // browser's own window size (viewport: null).
      async open(bt, { cfg, dir, locale, timezone, media }) {
        const ctx = await bt.launchPersistentContext(dir, {
          channel: 'chromium', headless: cfg.headless, viewport: null, args: ['--window-size=1366,900', ...(media?.args || [])], locale, timezoneId: timezone,
          ...(media?.env ? { env: media.env } : {}),
        });
        return { ctx };
      },
    },
    camoufox: {
      name: 'camoufox', family: 'firefox', cdp: false, shared: false, tracker: 'init',
      async load() {
        const [{ launchOptions }, { firefox }] = await Promise.all([importer('camoufox-js'), importer('playwright')]);
        return { launchOptions, firefox };
      },
      async check({ launchOptions }) { exists((await launchOptions({ headless: true })).executablePath); },
      // Fingerprint (window, screen, fonts, UA) comes from Camoufox (viewport: null keeps Playwright out of it); the
      // OS matches the host unless CAMOUFOX_OS says otherwise, so fonts and rendering stay consistent with the claimed
      // platform. humanize stays off: with Playwright 1.64 its cursor patch makes actionability checks hang.
      async open({ launchOptions, firefox }, { cfg, dir, locale, timezone }) {
        const opts = await launchOptions({ headless: cfg.headless, os: cfg.camoufoxOs || hostOs(), locale, humanize: false });
        return { ctx: await firefox.launchPersistentContext(dir, { ...opts, viewport: null, timezoneId: timezone }) };
      },
    },
  };
}

export function createEngines({ importer = defaultImporter, overrides = {} } = {}) {
  const defs = { ...definitions(importer), ...overrides };
  const loaded = new Map(); // name -> Promise<browserType>
  const get = (name) => {
    const def = defs[name];
    if (!def) throw new EngineUnavailableError(`unknown engine ${name} (known: ${ENGINE_NAMES.join(', ')})`);
    return def;
  };
  const load = (name) => {
    const def = get(name);
    if (!loaded.has(name)) {
      const p = def.load().catch((e) => { loaded.delete(name); throw explain(name, e); });
      loaded.set(name, p);
    }
    return loaded.get(name);
  };
  return {
    get,
    load,
    // Package and browser binary present? (startup preflight of the default engine)
    async check(name, cfg) {
      const bt = await load(name);
      try { await get(name).check?.(bt, cfg); } catch (e) { throw explain(name, e); }
    },
    // Opens a context. Ephemeral sessions of non-shared engines get a private temp profile (tmpDir, removed on close).
    async open(name, { cfg, profileDir, locale, timezone, shared, media }) {
      const def = get(name);
      if (media && def.family !== 'chromium') throw new EngineUnavailableError(`meetings need a Chromium engine (chromium or patchright), not ${name}`);
      const bt = await load(name);
      let dir = profileDir, tmpDir = null;
      if (!dir && (!def.shared || media)) { // media: a browser process of its own
        tmpDir = dir = path.join(cfg.dataDir, 'tmp', `${name}-${crypto.randomBytes(6).toString('hex')}`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      // The caller owns dir/tmpDir from here on, also on failure: a launch that timed out may have left processes.
      try {
        const r = await def.open(bt, { cfg, dir, locale, timezone, shared: () => shared(def, bt), media });
        return { ...r, dir: r.browser ? null : dir, tmpDir };
      } catch (e) {
        throw Object.assign(explain(name, e), { dir, tmpDir });
      }
    },
  };
}

const META = 'bosun-profile.json';
export function readProfileMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8')); } catch { return null; }
}

// After a successful open: remember the engine and mode (headless or not) the profile was last used with, so
// background work (keepalive) opens it the same way and its fingerprint stays consistent.
export function recordProfileUse(dir, { engine, headless }) {
  const meta = { ...(readProfileMeta(dir) || {}), engine, headless };
  const tmp = path.join(dir, `${META}.${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, META));
}

// Undo a fresh claim if nothing but the marker was written (the open failed before a browser touched the profile).
export function unclaimProfile(dir) {
  try { if (fs.readdirSync(dir).join() === 'bosun-profile.json') fs.rmSync(path.join(dir, 'bosun-profile.json')); } catch {}
}

// A persistent profile remembers which engine family created it; Chromium and Firefox profiles aren't interchangeable.
export function claimProfile(dir, def) {
  const meta = path.join(dir, 'bosun-profile.json');
  let family = 'chromium'; // profiles from before engines existed are Chromium profiles
  try { family = JSON.parse(fs.readFileSync(meta, 'utf8')).family || family; } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const fresh = fs.readdirSync(dir).length === 0;
    family = fresh ? def.family : 'chromium';
    fs.writeFileSync(meta, JSON.stringify({ family }), { mode: 0o600 });
    if (family === def.family) return fresh; // true: marker created for an empty profile (caller may roll it back)
  }
  if (family !== def.family) throw new Error(`profile was created with a ${family} engine; open it with engine ${family === 'firefox' ? 'camoufox' : 'chromium or patchright'}`);
}
