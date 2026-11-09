#!/usr/bin/env node
// Bosun: MCP browser server over Playwright Chromium (stdio, or WebSocket with WS_PORT). See README for configuration.
import { redactUrlCredentials } from './redact.mjs';
import { main } from './bosun.mjs';

main().catch((e) => {
  console.error(`bosun: ${redactUrlCredentials(e.message)}`);
  process.exit(1);
});
