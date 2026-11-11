// Schema and runner coverage without a browser or service dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMacro, runMacro, resolveStep } from '../src/macros.mjs';

const macro = (steps, rest = {}) => ({ ...checkMacro({ name: 'controls', site: ['a.example'], steps, ...rest }), version: 1 });
const opsFor = (over = {}) => ({
  allowed: () => null, limitOf: () => 60000, url: () => 'https://a.example/',
  watch: () => ({ seen: () => null, stop() {} }), failure: async () => ({}),
  step: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  exists: async () => true, assert: async () => null, ...over,
});
const run = async (m, ops = opsFor(), rest = {}) => (await runMacro(m, { args: {}, ops, ...rest })).result;
const click = { tool: 'click', text: 'Continue' };
const condition = (then = [click]) => ({ tool: 'if_exists', target: { role: 'button', name: 'Continue' }, then });

test('click/type/select/hover timeout validation and forwarding; defaults stay absent', async () => {
  for (const st of [click, { tool: 'type', selector: '#q', value: 'hello' }, { tool: 'select', selector: '#s', value: 'a' }, { tool: 'hover', text: 'Menu', nth: -1, after: 'Start', before: 'End' }]) {
    for (const timeoutMs of [99, 60001, 1.5, '1000']) assert.throws(() => macro([{ ...st, timeoutMs }]));
    for (const timeoutMs of [100, 60000, undefined]) {
      let args;
      const result = await run(macro([{ ...st, ...(timeoutMs === undefined ? {} : { timeoutMs }) }]), opsFor({ step: async (_tool, a) => { args = a; return { content: [] }; } }));
      assert.equal(result.ok, true);
      assert.equal(args.timeoutMs, timeoutMs === 60000 ? 51500 : timeoutMs);
      assert.equal(args.selector ?? args.text, st.selector ?? st.text);
      if (st.tool === 'hover') assert.equal(args.nth, -1);
    }
  }
});

test('nested steps use the same schema, target rules, depth and total step limits', () => {
  macro([condition([condition([condition()])])]);
  assert.throws(() => macro([condition([condition([condition([condition()])])])]), /nesting depth/);
  assert.throws(() => macro([condition([{ tool: 'evaluate', script: '1' }])]), /tool must be one of/);
  assert.throws(() => macro([condition([{ ...click, timeoutMs: 1 }])]), /timeoutMs/);
  assert.throws(() => macro([{ ...condition(), target: { name: 'x' } }]), /name goes with role/);
  assert.throws(() => macro([{ ...condition(), target: { selector: '#a', script: '1' } }]), /unknown field/);
  assert.throws(() => macro([condition(Array.from({ length: 100 }, () => click))]), /100 steps/);
  macro([condition(Array.from({ length: 99 }, () => click))]);
  for (const max of [undefined, 0, 101, 1.1, '2']) assert.throws(() => macro([{ tool: 'repeat', while: { text: 'More' }, max, steps: [click] }]));
  assert.throws(() => macro([{ tool: 'repeat', while: {}, max: 1, steps: [click] }]), /give the element/);
});

test('risky checks and parameters cover both branches and loop bodies at save and run time', async () => {
  const dangerous = condition([{ tool: 'repeat', while: { text: 'More' }, max: 2, steps: [{ tool: 'click', text: 'Delete account' }] }]);
  assert.throws(() => macro([dangerous]), /confirm_risky/);
  assert.equal(macro([dangerous], { confirm_risky: true }).risky_steps[0].step, 3);
  assert.throws(() => macro([{ ...condition(), else: [{ tool: 'click', text: 'Buy now' }] }]), /confirm_risky/);
  assert.throws(() => macro([{ ...condition(), target: { text: '{{unknown}}' } }]), /not a declared param/);
  const m = macro([condition([{ tool: 'click', text: '{{label}}' }])], { params: { label: { type: 'string' } } });
  await assert.rejects(run(m, opsFor(), { args: { label: 'Buy now' } }), /refused/);
  await assert.rejects(run(m, opsFor({ allowed: (t) => t === 'click' ? 'not available' : null }), { args: { label: 'Continue' } }), /not available/);
  const resolved = resolveStep({ ...condition(), target: { text: '{{label}}' } }, { label: 'Ready' });
  assert.deepEqual(resolved.step.target, { text: 'Ready' });
  // An optional child param skips that child, not its enclosing condition or siblings.
  const optional = macro([condition([{ tool: 'type', selector: '#q', value: '{{label}}' }, click])], { params: { label: { type: 'string', required: false } } });
  const result = await run(optional);
  assert.equal(result.steps.find((s) => s.step === 2).status, 'skipped');
  assert.equal(result.steps.find((s) => s.step === 3).status, 'ok');
});

test('if_exists checks once and runs only the matching branch, including no else', async () => {
  for (const present of [true, false]) {
    const calls = []; let checks = 0;
    const m = macro([{ ...condition(), else: [{ tool: 'press', key: 'Escape' }] }]);
    const result = await run(m, opsFor({ exists: async (target, _limit, hooks) => {
      checks++; hooks.guard(); assert.deepEqual(target, m.steps[0].target); return present;
    }, step: async (tool) => { calls.push(tool); return { content: [] }; } }));
    assert.equal(result.ok, true); assert.equal(checks, 1);
    assert.deepEqual(calls, [present ? 'click' : 'press']);
    assert.equal(result.steps[0].branch, present ? 'then' : 'else');
  }
  const result = await run(macro([condition()]), opsFor({ exists: async () => false }));
  assert.equal(result.ok, true); assert.equal(result.steps[1].status, 'skipped');
});

test('repeat checks each iteration, stops on absence and reports whether its maximum was hit', async () => {
  for (const remaining of [0, 2, 3, 10]) {
    let count = 0, checks = 0;
    const result = await run(macro([{ tool: 'repeat', while: { selector: '#more' }, max: 3, steps: [click] }]), opsFor({
      exists: async () => { checks++; return count < remaining; },
      step: async () => { count++; return { content: [] }; },
    }));
    assert.equal(count, Math.min(remaining, 3)); assert.equal(checks, count === 3 ? count : count + 1);
    assert.equal(result.steps[0].count, count); assert.equal(result.steps[0].max_hit, remaining >= 3);
    assert.deepEqual(result.steps.filter((s) => s.tool === 'click' && s.status === 'ok').map((s) => s.iterations), Array.from({ length: count }, (_, i) => [i + 1]));
  }
});

test('nested failures, off-site pages and cancellation stop the loop', async () => {
  const m = macro([{ tool: 'repeat', while: { text: 'More' }, max: 100, steps: [click] }, { tool: 'press', key: 'Escape' }]);
  const failed = await run(m, opsFor({ step: async () => { throw new Error('failed child'); } }));
  assert.equal(failed.ok, false); assert.equal(failed.failure.step, 2);
  assert.equal(failed.steps.find((s) => s.step === 3).status, 'not_run');
  let url = 'https://a.example/';
  const away = await run(m, opsFor({ url: () => url, step: async () => { url = 'https://other.example/'; return { content: [] }; } }));
  assert.equal(away.ok, false); assert.match(away.failure.error, /outside this macro/);
  const ac = new AbortController(); let calls = 0;
  const cancelled = await run(m, opsFor({ step: async () => { calls++; ac.abort(); return { content: [] }; } }), { signal: ac.signal });
  assert.equal(calls, 1); assert.equal(cancelled.ok, false); assert.match(cancelled.failure.error, /cancelled/);
});

test('read text and assert matched text are returned with stable pre-order step indices', async () => {
  const m = macro([condition([{ tool: 'read', as: 'answer' }, { tool: 'assert', text: 'Ready' }])]);
  const result = await run(m, opsFor({
    step: async () => ({ content: [{ type: 'text', text: 'url: https://a.example/\ntitle: A\nchars: 5\n\nHello' }] }),
    assert: async () => 'Ready to continue',
  }));
  assert.deepEqual(result.reads, [{ step: 2, as: 'answer', text: 'Hello' }]);
  assert.equal(result.steps.find((s) => s.step === 3).text, 'Ready to continue');
  const dry = await run(m, opsFor({ exists: () => { throw new Error('must not check'); } }), { dryRun: true });
  assert.equal(dry.dry_run, true); assert.equal(dry.steps.length, 3);
});
