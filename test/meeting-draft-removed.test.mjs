// meeting_draft was removed in 0.19.0: the tool is gone, speech_settings_get has no draft keys, a tenant's stored
// settings that still have them load (and lose them at the next write), and an old caller that sets draft_enabled
// or draft_max_new_words (speech_settings_set, meeting_join, also a dry run) is told they were removed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startBosun, connect } from './helpers.mjs';
import { startFakeMeet, fakeAudio } from './fakemeet.mjs';
import { meet } from '../src/meetings/platforms/meet.mjs';

let fake;
before(async () => { fake = await startFakeMeet(); });
after(async () => { await fake?.close(); });

test('meeting_draft is gone; stored draft settings load and are dropped at the next write; setting them is a clear error', async () => {
  const svc = await startBosun({ KEEPALIVE: '0' }, { meetings: { audio: fakeAudio(), platformFor: (u) => (u.startsWith(fake.base) ? meet : null), pollMs: 200 } });
  try {
    // What a 0.18 Bosun stored for tenant alice.
    const f = path.join(svc.dataDir, 'speech-settings', 'alice.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ draft_enabled: true, draft_max_new_words: 3, turn_hold_ms: 500 }));
    const c = await connect(svc);
    assert.equal(c.getServerVersion().version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, 'serverInfo says the package version');
    const tools = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('meeting_join') && tools.includes('speech_settings_set'));
    assert.ok(!tools.includes('meeting_draft'));
    assert.match((await c.call('meeting_draft', { meeting_id: 'x', text: 'Hi.' })).text, /meeting_draft not found|Tool meeting_draft/i);
    const g = await c.call('speech_settings_get', {});
    assert.equal(g.isError, false, g.text);
    assert.doesNotMatch(g.text, /draft/);
    assert.deepEqual(g.json().settings, { turn_hold_ms: 500 });
    // Old callers.
    for (const a of [{ draft_enabled: true }, { draft_enabled: false, ack_on_final: true }, { draft_max_new_words: 4 }]) {
      const r = await c.call('speech_settings_set', a);
      assert.equal(r.isError, true, JSON.stringify(a));
      assert.match(r.text, /draft_(enabled|max_new_words) was removed in Bosun 0\.19\.0 with meeting_draft/);
    }
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).draft_enabled, true, 'nothing written by a refused call');
    const { url } = fake.newRoom();
    for (const a of [{ url, draft_enabled: true }, { url, draft_max_new_words: 2 }, { url, draft_enabled: false, dry_run: true }]) {
      const r = await c.call('meeting_join', a);
      assert.equal(r.isError, true, JSON.stringify(a));
      assert.match(r.text, /draft_(enabled|max_new_words) was removed in Bosun 0\.19\.0 with meeting_draft/);
    }
    assert.deepEqual((await c.call('meeting_status', {})).json(), [], 'no meeting was joined');
    // The next write drops the removed keys from the file.
    const w = await c.call('speech_settings_set', { ack_on_final: true });
    assert.equal(w.isError, false, w.text);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { turn_hold_ms: 500, ack_on_final: true });
    await c.close();
  } finally { await svc.stop(); }
});
