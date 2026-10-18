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
const missingBinary = (e) => ['CamoufoxNotInstalled', 'FileNotFoundError'].includes(e?.constructor?.name) ||
  /Executable doesn't exist|camoufox fetch/i.test(String(e?.message || e));

// Rethrow launch failures caused by a missing install as a clear, actionable error.
function explain(name, e) {
  if (missingModule(e)) return new EngineUnavailableError(`engine ${name} is not installed — run: ${INSTALL[name]}`);
  if (missingBinary(e)) return new EngineUnavailableError(`engine ${name}: browser binary missing — run: ${INSTALL[name]}`);
  return e;
}

const defaultImporter = (spec) => import(spec);

const hostOs = () => ({ darwin: 'macos', win32: 'windows' })[process.platform] || 'linux';

// Each engine: { name, family, cdp, shared, isolatedInitScripts, load(), open(bt, {cfg, dir, locale, timezone, shared})
// -> {ctx, browser?, own?} }. shared: ephemeral sessions are contexts of one shared browser (manager.getBrowser).
// own: a per-session browser to close. isolatedInitScripts: init scripts run in the same isolated world as
// evaluate, invisible to the page.
function definitions(importer) {
  return {
    chromium: {
      name: 'chromium', family: 'chromium', cdp: true, shared: true,
      async load() { return (await importer('playwright')).chromium; },
      launchShared: (bt, cfg) => bt.launch({ headless: cfg.headless, args: CHROMIUM_ARGS }),
      async open(bt, { cfg, dir, locale, timezone, shared }) {
        const o = { viewport: { width: 1366, height: 900 }, locale, timezoneId: timezone };
        if (dir) return { ctx: await bt.launchPersistentContext(dir, { headless: cfg.headless, args: CHROMIUM_ARGS, ...o }) };
        const browser = await shared();
        return { ctx: await browser.newContext(o), browser };
      },
    },
    patchright: {
      name: 'patchright', family: 'chromium', cdp: true, shared: false,
      async load() { return (await importer('patchright')).chromium; },
      // Recommended patchright setup: persistent context, no custom UA/headers, no automation-flag args, the
      // browser's own window size (viewport: null).
      async open(bt, { cfg, dir, locale, timezone }) {
        const ctx = await bt.launchPersistentContext(dir, {
          channel: 'chromium', headless: cfg.headless, viewport: null, args: ['--window-size=1366,900'], locale, timezoneId: timezone,
        });
        return { ctx };
      },
    },
    camoufox: {
      name: 'camoufox', family: 'firefox', cdp: false, shared: false, isolatedInitScripts: true,
      async load() {
        const [{ launchOptions }, { firefox }] = await Promise.all([importer('camoufox-js'), importer('playwright')]);
        return { launchOptions, firefox };
      },
      // Fingerprint (window, screen, fonts, UA) comes from Camoufox (viewport: null keeps Playwright out of it); the
      // OS matches the host unless CAMOUFOX_OS says otherwise, so fonts and rendering stay consistent with the claimed
      // platform. humanize stays off: with Playwright 1.64 its cursor patch makes actionability checks hang.
      async open({ launchOptions, firefox }, { cfg, dir, locale, timezone }) {
        const opts = await launchOptions({ headless: cfg.headless, os: cfg.camoufoxOs || hostOs(), locale, humanize: false });
        const c = { viewport: null, timezoneId: timezone };
        if (dir) return { ctx: await firefox.launchPersistentContext(dir, { ...opts, ...c }) };
        const browser = await firefox.launch(opts);
        try {
          return { ctx: await browser.newContext(c), own: browser };
        } catch (e) {
          await browser.close().catch(() => {});
          throw e;
        }
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
    // Opens a context. Ephemeral sessions of non-shared engines get a private temp profile (tmpDir, removed on close).
    async open(name, { cfg, profileDir, locale, timezone, shared }) {
      const def = get(name);
      const bt = await load(name);
      let dir = profileDir, tmpDir = null;
      if (!dir && !def.shared) {
        tmpDir = dir = path.join(cfg.dataDir, 'tmp', `${name}-${crypto.randomBytes(6).toString('hex')}`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      try {
        const r = await def.open(bt, { cfg, dir, locale, timezone, shared: () => shared(def, bt) });
        return { ...r, tmpDir };
      } catch (e) {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        throw explain(name, e);
      }
    },
  };
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
  }
  if (family !== def.family) throw new Error(`profile was created with a ${family} engine; open it with engine ${family === 'firefox' ? 'camoufox' : 'chromium or patchright'}`);
}
