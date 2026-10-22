// Fork: features that are off by default. Meetings (FEATURES_MEETINGS=0): the tools are not listed and their
// handlers are never wired, and no meeting machinery starts. Engines (FEATURES_ENGINES=chromium): a session can only
// pick chromium, unless the deployment enables more or sets ENGINE to another one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../src/config.mjs';
import { startBosun, startPageServer, connect } from './helpers.mjs';

const MEETING_TOOLS = ['meeting_join', 'meeting_status', 'meeting_chat_read', 'meeting_chat_send', 'meeting_stop_recording', 'meeting_leave', 'meeting_recording_delete'];

test('FEATURES_MEETINGS defaults to off and is a 0/1 switch', () => {
  assert.equal(loadConfig({}).features.meetings, false);
  assert.equal(loadConfig({ FEATURES_MEETINGS: '0' }).features.meetings, false);
  assert.equal(loadConfig({ FEATURES_MEETINGS: '' }).features.meetings, false);
  assert.equal(loadConfig({ FEATURES_MEETINGS: '1' }).features.meetings, true);
  assert.throws(() => loadConfig({ FEATURES_MEETINGS: 'yes' }), /FEATURES_MEETINGS must be 0 or 1/);
});

test('FEATURES_ENGINES defaults to chromium only and always includes ENGINE', () => {
  assert.deepEqual(loadConfig({}).engines, ['chromium']);
  assert.deepEqual(loadConfig({ FEATURES_ENGINES: 'chromium' }).engines, ['chromium']);
  assert.deepEqual(loadConfig({ FEATURES_ENGINES: 'camoufox,patchright' }).engines, ['chromium', 'patchright', 'camoufox']);
  assert.deepEqual(loadConfig({ FEATURES_ENGINES: '' }).engines, ['chromium']);
  // An explicitly configured default engine is enabled by that choice.
  assert.deepEqual(loadConfig({ ENGINE: 'patchright' }).engines, ['chromium', 'patchright']);
  assert.throws(() => loadConfig({ FEATURES_ENGINES: 'webkit' }), /FEATURES_ENGINES must be a comma list of chromium, patchright, camoufox/);
});

test('with the fork defaults, meeting tools are absent and only chromium can be opened', async () => {
  const pages = await startPageServer();
  const svc = await startBosun({ FEATURES_MEETINGS: '0', FEATURES_ENGINES: 'chromium', ENGINE: 'chromium' });
  try {
    assert.equal(svc.meetings, null);
    assert.equal(svc.manager.meetings, undefined);
    assert.equal(fs.existsSync(path.join(svc.dataDir, 'recordings')), false); // no recordings directory is created
    const c = await connect(svc);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const t of MEETING_TOOLS) assert.ok(!names.includes(t), t);
    assert.ok(names.includes('navigate') && names.includes('request_human') && names.includes('keepalive_set'));
    for (const t of MEETING_TOOLS) assert.equal((await c.call(t, {})).isError, true, t); // no handler at all
    // Engines: chromium works, the anti-detect engines are refused by the schema and by the session manager.
    const s = await c.open();
    assert.equal((await c.call('navigate', { session: s, url: `${pages.base}/` })).json().title, 'Home');
    assert.equal((await c.call('session_open', { engine: 'patchright' })).isError, true);
    assert.equal((await c.call('session_open', { engine: 'camoufox' })).isError, true);
    for (const engine of ['patchright', 'camoufox']) {
      await assert.rejects(svc.manager.open({ owner: 'direct', tenant: 'alice', engine }), /is not enabled on this service \(FEATURES_ENGINES\)/);
    }
    const open = (await c.listTools()).tools.find((t) => t.name === 'session_open');
    assert.match(JSON.stringify(open.inputSchema), /"enum":\["chromium"\]/);
    await c.close();
  } finally {
    await svc.stop();
    await pages.close();
  }
});

test('FEATURES_MEETINGS=1 wires the meeting tools again', async () => {
  const svc = await startBosun({ FEATURES_MEETINGS: '1' });
  try {
    assert.ok(svc.meetings);
    const c = await connect(svc);
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const t of MEETING_TOOLS) assert.ok(names.includes(t), t);
    await c.close();
  } finally { await svc.stop(); }
});
