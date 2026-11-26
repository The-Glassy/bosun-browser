#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { migrateData } from '../src/migrate-data.mjs';

const usage = 'Usage: bosun migrate-data [--dry-run] [--data <dir>] [--reverse] [--force]';
const [command, ...args] = process.argv.slice(2);
try {
  if (command === '--help') console.log(usage);
  else {
    if (command !== 'migrate-data') throw new Error(usage);
    const { values } = parseArgs({ args, options: {
      data: { type: 'string' }, 'dry-run': { type: 'boolean' }, reverse: { type: 'boolean' },
      force: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) console.log(usage);
    else migrateData({ dataDir: values.data, dryRun: values['dry-run'], reverse: values.reverse, force: values.force });
  }
} catch (error) {
  console.error(`bosun: ${error.message}`);
  process.exitCode = 1;
}
