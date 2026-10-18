#!/usr/bin/env node
// Runs the whole test suite once per installed engine (ENGINE=chromium|patchright|camoufox).
import { spawnSync } from 'child_process';
import fs from 'fs';

const pkg = { chromium: 'playwright', patchright: 'patchright', camoufox: 'camoufox-js' };
const files = fs.readdirSync(new URL('../test/', import.meta.url)).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`);
let failed = false;
for (const [engine, mod] of Object.entries(pkg)) {
  if (!(await import(mod).then(() => true, () => false))) { console.log(`# ${engine}: not installed, skipped`); continue; }
  console.log(`# engine ${engine}`);
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...files], { stdio: 'inherit', env: { ...process.env, ENGINE: engine } });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
