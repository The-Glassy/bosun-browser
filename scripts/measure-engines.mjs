#!/usr/bin/env node
// Bot-detection and RAM measurements per engine (needs internet; not part of npm test).
//   node scripts/measure-engines.mjs [chromium patchright camoufox]      headful unless HEADLESS=1
// Each engine runs in its own child process, so the browser process tree belongs to it alone. Screenshots go to
// docs/engines/<engine>-<test>.jpg, raw results to docs/engines/results-<platform>.json.
// The Turnstile test clicks the checkbox at most once, like a person would; nothing solves CAPTCHAs.
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'engines');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RAM_PAGES = [
  ['geizhals', 'https://geizhals.at/?fs=mac+mini'],
  ['hornbach', 'https://www.hornbach.at/s/akkuschrauber', /\/p\//], // first product of the search
  ['willhaben', 'https://www.willhaben.at/iad/kaufen-und-verkaufen/marktplatz?keyword=fahrrad'],
];

if (process.argv[2] === '--child') await child(process.argv[3]);
else await parent(process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'patchright', 'camoufox']);

async function parent(engines) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `results-${process.platform}.json`);
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const engine of engines) {
    console.error(`== ${engine}`);
    const res = await new Promise((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child', engine], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.on('exit', (code) => { try { resolve(JSON.parse(out)); } catch { resolve({ error: `exit ${code}`, raw: out.slice(-2000) }); } });
    });
    all[engine] = { ...res, measuredAt: new Date().toISOString(), host: `${os.platform()} ${os.release()} ${os.arch()}`, headless: process.env.HEADLESS === '1' };
    fs.writeFileSync(file, JSON.stringify(all, null, 1));
  }
  console.error(`wrote ${file}`);
}

// Process tree of this process (the browser and its helpers), RSS and the de-duplicated metric of the platform.
function memory() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=']).toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map();
  for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) || []), pid]);
  const tree = [];
  const walk = (p) => { for (const c of kids.get(p) || []) { tree.push(c); walk(c); } };
  walk(process.pid);
  const rssKB = rows.filter(([pid]) => tree.includes(pid)).reduce((a, [, , rss]) => a + rss, 0);
  const m = { processes: tree.length, rssMB: Math.round(rssKB / 1024) };
  if (process.platform === 'darwin' && tree.length) {
    try {
      const out = execFileSync('footprint', ['--noCategories', '-f', 'bytes', ...tree.flatMap((p) => ['-p', String(p)])], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      const t = /Summary Footprint: (\d+) B/.exec(out) || /Footprint: (\d+) B/.exec(out);
      if (t) m.footprintMB = Math.round(Number(t[1]) / 1048576);
    } catch {}
  }
  if (process.platform === 'linux') {
    let pss = 0;
    for (const p of tree) { try { pss += Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, 'utf8'))[1]); } catch {} }
    m.pssMB = Math.round(pss / 1024);
  }
  return m;
}

async function child(engine) {
  const { loadConfig } = await import('../src/config.mjs');
  const { SessionManager } = await import('../src/sessions.mjs');
  const env = { ENGINE: engine, BROWSER_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-measure-')), MAX_PAGES_PER_SESSION: '10', IDLE_TIMEOUT_SEC: '0' };
  if (process.env.HEADLESS === '1') env.HEADLESS = '1';
  const cfg = loadConfig(env);
  const manager = new SessionManager(cfg);
  const result = { engine, tests: {}, ram: {} };
  // Test pages show the public IP (WebRTC, headers): blank out IPv4 addresses before any screenshot or text capture.
  const redactIps = (page) => Promise.all(page.frames().map((f) => f.evaluate(() => {
    const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) if (/\d{1,3}(\.\d{1,3}){3}/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/(?<![/\w.])\d{1,3}(\.\d{1,3}){3}(?![\w.])/g, 'x.x.x.x');
  }).catch(() => {})));
  const shot = async (page, name, fullPage = false) => {
    await redactIps(page);
    const f = path.join(OUT, `${engine}-${name}.jpg`);
    await page.screenshot({ path: f, type: 'jpeg', quality: 60, fullPage, timeout: 30000 }).catch((e) => console.error(`${name} screenshot: ${e.message.split('\n')[0]}`));
    return path.relative(ROOT, f);
  };
  const text = (page, n = 6000) => page.evaluate((n) => document.body?.innerText.slice(0, n) || '', n).then((t) => t.replace(/(?<![/\w.])\d{1,3}(\.\d{1,3}){3}(?![\w.])/g, 'x.x.x.x')).catch(() => '');
  const step = async (name, fn) => {
    console.error(`  ${name}`);
    try { result.tests[name] = await fn(); } catch (e) { result.tests[name] = { error: String(e.message).split('\n')[0] }; }
  };

  const t0 = Date.now();
  const s = await manager.open({ owner: 'measure', tenant: 'default' });
  result.openMs = Date.now() - t0;
  const page = s.page;
  result.userAgent = await page.evaluate(() => navigator.userAgent);

  await step('sannysoft', async () => {
    await page.goto('https://bot.sannysoft.com/', { waitUntil: 'load', timeout: 45000 });
    await sleep(6000);
    const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      return tds.length >= 2 ? { name: tds[0].innerText.trim(), value: tds[1].innerText.trim().slice(0, 80), cls: tds[1].className } : null;
    }).filter(Boolean));
    const failed = rows.filter((r) => /failed/.test(r.cls)).map((r) => `${r.name}: ${r.value}`);
    const warn = rows.filter((r) => /warn/.test(r.cls)).map((r) => `${r.name}: ${r.value}`);
    return { rows: rows.length, passed: rows.filter((r) => /passed/.test(r.cls)).length, failed, warn, shot: await shot(page, 'sannysoft', true) };
  });

  await step('creepjs', async () => {
    await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'load', timeout: 45000 });
    let t = '';
    for (let i = 0; i < 20 && !/stealth/i.test(t); i++) { await sleep(2000); t = await text(page, 60000); }
    await sleep(4000);
    t = await text(page, 60000);
    const pct = (label) => ((new RegExp(`(\\d+)%\\s*${label}`, 'i')).exec(t) || [])[1];
    const r = {
      likeHeadless: pct('like headless'), headless: pct('headless(?!\\w)'), stealth: pct('stealth'),
      lies: (/lies\s*\(?(\d+)\)?/i.exec(t) || [])[1] || null, trustScore: (/trust score:?\s*([\d.]+%?)/i.exec(t) || [])[1] || null,
    };
    // the headless line has the form "44% like headless: … 0% headless: … 0% stealth: …"
    const m = /(\d+)% like headless[^\n]*\n\s*(\d+)% headless[^\n]*\n\s*(\d+)% stealth/i.exec(t);
    if (m) Object.assign(r, { likeHeadless: m[1], headless: m[2], stealth: m[3] });
    r.shot = await shot(page, 'creepjs');
    return r;
  });

  await step('browserscan', async () => {
    await page.goto('https://www.browserscan.net/bot-detection', { waitUntil: 'load', timeout: 45000 });
    await sleep(12000);
    const t = await text(page, 8000);
    return { verdict: (/Test Results:?\s*\n*\s*([^\n]+)/i.exec(t) || [])[1] || null, shot: await shot(page, 'browserscan', true) };
  });

  await step('kaufland', async () => {
    const r = { timeline: [] };
    const resp = await page.goto('https://www.kaufland.at/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => { r.gotoError = e.message.split('\n')[0]; return null; });
    r.status = resp?.status();
    const state = async () => {
      const title = await page.title().catch(() => '');
      const turnstile = page.frames().some((f) => /challenges\.cloudflare\.com/.test(f.url()));
      const shop = /kaufland/i.test(title) && !/moment|attention/i.test(title);
      return { title: title.slice(0, 60), turnstile, shop };
    };
    const watch = async (secs, tag) => {
      for (let i = 0; i < secs; i++) {
        await sleep(1000);
        const st = await state();
        const last = r.timeline.at(-1);
        if (!last || last.title !== st.title || last.turnstile !== st.turnstile) r.timeline.push({ t: `${tag}+${i + 1}s`, ...st });
        if (st.shop) return st;
      }
      return state();
    };
    let st = await watch(30, 'load');
    r.challenged = r.status === 403 || r.timeline.some((x) => x.turnstile || /moment|attention/i.test(x.title));
    if (st.shop) {
      r.outcome = r.challenged ? 'passed without a click (challenge cleared itself)' : 'passed silently';
      r.shot = await shot(page, 'kaufland');
      return r;
    }
    r.shotBefore = await shot(page, 'kaufland-challenge');
    const frame = page.frames().find((f) => /challenges\.cloudflare\.com/.test(f.url()));
    const box = frame && await (await frame.frameElement()).boundingBox().catch(() => null);
    if (!box) { r.outcome = st.title ? `blocked, no checkbox (title "${st.title}")` : 'stuck on a blank page, no checkbox'; return r; }
    // One click on the checkbox, as a person would: it sits ~30 px from the left edge, vertically centred.
    await page.mouse.move(box.x + 10, box.y + 5, { steps: 8 });
    await sleep(400);
    await page.mouse.click(box.x + 30, box.y + box.height / 2, { delay: 90 });
    r.clicked = true;
    st = await watch(25, 'click');
    r.outcome = st.shop ? 'passed after one click' : st.turnstile ? 'loop: checkbox shown again after the click' : 'still blocked after one click';
    r.shot = await shot(page, 'kaufland');
    return r;
  });

  // RAM: three heavy pages open at once in the one session, then idle with only a blank tab left.
  await step('ram', async () => {
    const tabs = [];
    const log = {};
    for (const [name, url, productRe] of RAM_PAGES) {
      const p = tabs.length === 0 ? page : await s.ctx.newPage();
      tabs.push(p);
      try {
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (productRe) {
          await sleep(4000);
          const href = await p.evaluate((src) => { const re = new RegExp(src); return [...document.querySelectorAll('a[href]')].map((a) => a.href).find((h) => re.test(new URL(h).pathname)) || null; }, productRe.source);
          if (href) await p.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        }
        await p.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
        log[name] = { url: p.url(), title: (await p.title()).slice(0, 80) };
      } catch (e) { log[name] = { error: String(e.message).split('\n')[0] }; }
    }
    await sleep(10000);
    const loaded = memory();
    for (const p of tabs.slice(1)) await p.close();
    await page.goto('about:blank');
    await sleep(10000);
    const idle = memory();
    result.ram = { loaded, idle };
    return log;
  });

  await manager.closeAll();
  fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
