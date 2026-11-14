import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const moduleUrl = new URL('../src/meetings/video.mjs', import.meta.url).href;
async function tools(t, probe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'ffmpeg'), '#!/bin/sh\necho "libvpx-vp9 libopus"\n', { mode: 0o700 });
  if (probe) fs.writeFileSync(path.join(dir, 'ffprobe'), `#!/bin/sh\n${probe}\n`, { mode: 0o700 });
  return async (expression) => JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', `import {videoUnsupported, validVideo} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await (${expression})));`], { env: { ...process.env, PATH: dir } })).stdout);
}
test('video preflight requires ffprobe as well as ffmpeg', async (t) => {
  const run = await tools(t); assert.match(await run('videoUnsupported()'), /ffprobe/);
});
for (const [name, script] of [
  ['missing', null], ['timeout', 'exec /bin/sleep 10'],
  ['temporary failure', 'echo "temporarily unavailable" >&2; exit 1'], ['malformed output', 'echo "not json"'],
]) test(`video validity distinguishes ${name} from positively empty media`, async (t) => {
  const run = await tools(t, script); assert.equal(await run('validVideo("recording.webm")'), null);
});
test('video validity reads a bounded packet interval instead of counting the whole recording', async (t) => {
  const run = await tools(t, `case "$*" in *-read_intervals*%+#1*) echo '{"packets":[{"size":"120"}]}' ;; *) echo '{"streams":[]}' ;; esac`);
  assert.equal(await run('validVideo("recording.webm")'), true);
});
