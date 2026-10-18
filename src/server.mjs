#!/usr/bin/env node
// Bosun: MCP browser server over Playwright Chromium (stdio, or WebSocket with WS_PORT). See README for configuration.
import { main } from './bosun.mjs';

main().catch((e) => {
  console.error(`bosun: ${e.message}`);
  process.exit(1);
});
