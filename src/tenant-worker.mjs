// Runs only inside bwrap. The bootstrap channel carries configuration once and closes on gateway shutdown.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { deserialize } from 'node:v8';
import { setTimeout as wait } from 'node:timers/promises';
import { guardDriverRejections, startService } from './bosun.mjs';
import { redactUrlCredentials } from './redact.mjs';
import { setGatewayDiagnostics } from './secrets.mjs';

guardDriverRejections();
const input = createInterface({ input: process.stdin, terminal: false });
let service, display, stopping = false;
const stop = async (code) => {
  if (stopping) return;
  stopping = true;
  try { await service?.shutdown(); } finally { display?.kill(); process.exit(code); }
};
input.once('close', () => stop(0));
process.once('SIGTERM', () => stop(0));
input.once('line', async (line) => {
  try {
    const { cfg, sockets, diagnostics } = deserialize(Buffer.from(line, 'base64'));
    setGatewayDiagnostics(diagnostics);
    if (!cfg.headless) {
      display = spawn('Xvfb', [':99', '-screen', '0', '1366x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'inherit'] });
      display.on('error', () => stop(1));
      display.once('exit', () => stop(1));
      for (let i = 0; i < 100 && !fs.existsSync('/tmp/.X11-unix/X99'); i++) await wait(50);
      if (!fs.existsSync('/tmp/.X11-unix/X99')) throw new Error('private Xvfb display did not start');
    }
    service = await startService(cfg, { wsSocket: sockets.mcp, liveSocket: sockets.live });
    process.stdout.write('ready\n');
  } catch (error) {
    console.error(`bosun tenant worker: ${redactUrlCredentials(error.message)}`);
    await stop(1);
  }
});
