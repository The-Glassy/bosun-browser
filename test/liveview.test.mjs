// Live-view races and input handling, deterministic with a fake page/CDP session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createLiveView, parseInput, glidePath } from '../src/liveview.mjs';
import { viewer, until, sleep, rawRequest } from './helpers.mjs';

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// screencastFrames: how many startScreencast calls produce a frame (a static page produces one, at the start).
function fakePage({ attachGate, inputGate, screencastFrames = Infinity } = {}) {
  const cdp = new EventEmitter();
  cdp.sent = [];
  cdp.params = [];
  cdp.detached = false;
  cdp.send = async (method, params) => {
    cdp.sent.push(method);
    cdp.params.push([method, params]);
    if (inputGate && method.startsWith('Input.')) await inputGate.promise;
    if (method === 'Page.startScreencast' && screencastFrames-- > 0) setTimeout(() => cdp.emit('Page.screencastFrame', { data: 'AAAA', sessionId: 1, metadata: {} }), 5);
    if (method === 'Page.captureScreenshot') return { data: 'SNAP' };
  };
  cdp.detach = async () => { cdp.detached = true; };
  const page = {
    viewportSize: () => ({ width: 100, height: 100 }),
    context: () => ({ newCDPSession: async () => { if (attachGate) await attachGate.promise; return cdp; } }),
  };
  return { page, cdp };
}

async function withLive(fn, opts = {}) {
  const live = createLiveView({ port: 0, ...opts });
  await live.listen();
  try { await fn(live); } finally { await live.close(); }
}

test('a handoff that ends while a viewer is attaching never streams or accepts input', async () => {
  await withLive(async (live) => {
    const attachGate = deferred();
    const { page, cdp } = fakePage({ attachGate });
    const h = live.start(page, 'r', { ttlMs: 60_000 });
    const v = await viewer(h.url);
    v.ws.send(JSON.stringify({ type: 'text', text: 'late input' }));
    await sleep(50);
    h.cancel(); // expiry/finish while newCDPSession is still pending
    let resolved = false;
    h.wait.then(() => { resolved = true; });
    await sleep(50);
    assert.equal(resolved, false); // the handoff waits for the attach to wind down
    attachGate.resolve();
    assert.equal(await h.wait, 'cancelled');
    assert.equal(h.drainFailed, false);
    await until(() => cdp.detached);
    await until(() => v.closed);
    assert.deepEqual(cdp.sent.filter((m) => m !== 'Page.stopScreencast'), []); // never started, no input
    assert.equal(v.frames, 0);
  });
});

test('expiry by TTL during attachment behaves the same', async () => {
  await withLive(async (live) => {
    const attachGate = deferred();
    const { page, cdp } = fakePage({ attachGate });
    const h = live.start(page, 'r', { ttlMs: 100 });
    const v = await viewer(h.url);
    await sleep(200); // expired meanwhile
    attachGate.resolve();
    assert.equal(await h.wait, 'handoff-timeout');
    assert.equal(h.drainFailed, false);
    await until(() => cdp.detached && v.closed);
    assert.ok(!cdp.sent.includes('Page.startScreencast'));
  });
});

test('input queued behind a slow CDP call is dropped once the human presses Done', async () => {
  await withLive(async (live) => {
    const inputGate = deferred();
    const { page, cdp } = fakePage({ inputGate });
    const h = live.start(page, 'r');
    const v = await viewer(h.url);
    await until(() => v.frames > 0);
    v.ws.send(JSON.stringify({ type: 'click', x: 10, y: 10 }));
    v.ws.send(JSON.stringify({ type: 'text', text: 'after done' }));
    await until(() => cdp.sent.includes('Input.dispatchMouseEvent'));
    v.ws.send(JSON.stringify({ type: 'done' }));
    let settled = false;
    h.wait.then(() => { settled = true; });
    await sleep(100);
    assert.equal(settled, false); // not before the in-flight input has returned
    inputGate.resolve();
    assert.equal(await h.wait, 'human-done');
    assert.ok(cdp.detached); // and CDP is detached by then
    await sleep(50);
    assert.ok(!cdp.sent.includes('Input.insertText'), cdp.sent.join());
    // The press that was in flight is released during teardown (mousePressed, then the cleanup mouseReleased).
    assert.deepEqual(cdp.sent.filter((m) => m === 'Input.dispatchMouseEvent').length, 2);
    assert.deepEqual(v.ends, ['Done — the agent continues.']);
  });
});

test('inputs run strictly in order, one at a time', async () => {
  await withLive(async (live) => {
    const { page, cdp } = fakePage();
    let inFlight = 0, maxInFlight = 0;
    const orig = cdp.send;
    cdp.send = async (m, p) => {
      if (!m.startsWith('Input.')) return orig(m, p); // frame acks may overlap input; input must not overlap input
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(5); await orig(m, p); inFlight--;
    };
    const h = live.start(page, 'r');
    const v = await viewer(h.url);
    await until(() => v.frames > 0);
    for (const k of ['Enter', 'Tab', 'Escape']) v.ws.send(JSON.stringify({ type: 'key', key: k }));
    await until(() => cdp.sent.filter((m) => m === 'Input.dispatchKeyEvent').length === 6);
    assert.equal(maxInFlight, 1);
    h.cancel();
  });
});

test('simultaneous claims: exactly one socket gets the link', async () => {
  await withLive(async (live) => {
    const { page } = fakePage();
    const h = live.start(page, 'r');
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => viewer(h.url)));
    await sleep(200);
    const open = res.filter((r) => r.status === 'fulfilled' && !r.value.closed).map((r) => r.value);
    assert.equal(open.length, 1);
    assert.ok(open[0].key);
    h.cancel();
  });
});

test('invalid input is ignored', () => {
  for (const raw of ['nope', 'null', '[]', '{"type":"click","x":null,"y":1}', '{"type":"click","x":1e9,"y":1}', '{"type":"click","x":-5,"y":1}',
    '{"type":"wheel","x":1,"y":1,"dy":"9"}', '{"type":"key","key":"__proto__"}', '{"type":"key","key":"constructor"}', '{"type":"text","text":42}',
    '{"type":"text","text":""}', '{"type":"eval","code":"1"}']) {
    assert.equal(parseInput(raw), null, raw);
  }
  for (const raw of ['{"type":"move","x":-1,"y":1}', '{"type":"down","x":1}', '{"type":"up","x":"1","y":1}', '{"type":"wheel","x":1,"y":1,"dy":1,"dx":"2"}', '{"type":"move","x":1,"y":1e9}']) {
    assert.equal(parseInput(raw), null, raw);
  }
  assert.equal(parseInput(JSON.stringify({ type: 'text', text: 'x'.repeat(2000) })).text.length, 500);
  assert.deepEqual(parseInput('{"type":"key","key":"Enter"}'), { type: 'key', key: 'Enter' });
  assert.deepEqual(parseInput('{"type":"move","x":1.5,"y":2}'), { type: 'move', x: 1.5, y: 2 });
  assert.deepEqual(parseInput('{"type":"wheel","x":1,"y":2,"dy":3}'), { type: 'wheel', x: 1, y: 2, dx: 0, dy: 3 });
  assert.deepEqual(parseInput('{"type":"down","x":1,"y":2,"extra":1}'), { type: 'down', x: 1, y: 2 });
});

test('oversized live-view messages close only that socket', async () => {
  await withLive(async (live) => {
    const { page } = fakePage();
    const h = live.start(page, 'r');
    const v = await viewer(h.url);
    v.ws.send('x'.repeat(64 * 1024));
    await until(() => v.closed);
    assert.equal(live.size, 1); // handoff still alive; the key holder may reconnect
    const v2 = await viewer(h.url, { key: v.key });
    assert.equal(v2.closed, false);
    h.cancel();
  });
});

test('malformed requests are answered, not fatal', async () => {
  await withLive(async (live) => {
    for (const target of ['//[', '/v/%zz', '/ws/' + 'a'.repeat(32) + '?v=%']) {
      const res = await rawRequest(live.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      assert.match(res, /^HTTP\/1\.1 404/, target);
      const res2 = await rawRequest(live.port, `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
      assert.match(res2, /^HTTP\/1\.1 404/, target);
    }
  });
});

test('close() ends every handoff and disconnects viewers', async () => {
  const live = createLiveView({ port: 0 });
  await live.listen();
  const { page } = fakePage();
  const h = live.start(page, 'r');
  const v = await viewer(h.url);
  await live.close();
  assert.equal(await h.wait, 'cancelled');
  await until(() => v.closed);
  assert.equal(live.size, 0);
});

// Firefox/Camoufox path: frames from page.screencast, input through page.mouse / page.keyboard.
function fakePlaywrightPage({ gates = {} } = {}) {
  const calls = [];
  const gated = async (name, ...a) => { calls.push([name, ...a]); if (gates[name]) await gates[name].promise; };
  let onFrame = null, timer = null;
  const page = {
    calls,
    viewportSize: () => null,
    evaluate: async () => { if (gates.evaluate) await gates.evaluate.promise; return { width: 800, height: 600 }; },
    screencast: {
      async start(o) {
        calls.push(['start', o.size]);
        onFrame = o.onFrame;
        let busy = false;
        timer = setInterval(async () => {
          if (busy || !onFrame) return;
          busy = true;
          await onFrame({ data: Buffer.from('jpeg'), viewportWidth: 800, viewportHeight: 600 }); // awaits the ack
          busy = false;
        }, 5);
      },
      async stop() { calls.push(['stop']); clearInterval(timer); onFrame = null; },
    },
    mouse: { move: (x, y) => gated('move', x, y), down: () => gated('down'), up: () => gated('up'), wheel: (dx, dy) => gated('wheel', dy) },
    keyboard: { insertText: async (t) => calls.push(['text', t]), down: async (k) => calls.push(['keydown', k]), up: async (k) => calls.push(['keyup', k]) },
  };
  return page;
}

test('playwright driver: screencast frames, mouse/keyboard input, stopped on finish', async () => {
  await withLive(async (live) => {
    const page = fakePlaywrightPage();
    const h = live.start(page, 'r', { driver: 'playwright' });
    const v = await viewer(h.url);
    await until(() => v.frames > 2);
    assert.deepEqual(page.calls[0], ['start', { width: 800, height: 600 }]);
    v.ws.send(JSON.stringify({ type: 'click', x: 10, y: 20 }));
    v.ws.send(JSON.stringify({ type: 'wheel', x: 1, y: 2, dy: 50 }));
    v.ws.send(JSON.stringify({ type: 'text', text: 'hi' }));
    v.ws.send(JSON.stringify({ type: 'key', key: 'Enter' }));
    await until(() => page.calls.some((c) => c[0] === 'keyup'));
    const input = page.calls.filter((c) => c[0] !== 'start');
    assert.deepEqual(input, [['move', 10, 20], ['down'], ['up'], ['move', 1, 2], ['wheel', 50], ['text', 'hi'], ['keydown', 'Enter'], ['keyup', 'Enter']]);
    v.ws.send(JSON.stringify({ type: 'done' }));
    assert.equal(await h.wait, 'human-done');
    assert.deepEqual(page.calls.at(-1), ['stop']);
    const n = page.calls.length;
    await sleep(50);
    assert.equal(page.calls.length, n); // nothing after finish
  });
});

test('unknown live-view driver is refused', async () => {
  await withLive(async (live) => {
    assert.throws(() => live.start(fakePlaywrightPage(), 'r', { driver: 'vnc' }), /unknown live-view driver/);
  });
});

test('playwright driver: a handoff ending while the stream is starting never starts capture after resolving', async () => {
  await withLive(async (live) => {
    const evaluate = deferred();
    const page = fakePlaywrightPage({ gates: { evaluate } });
    const h = live.start(page, 'r', { driver: 'playwright' });
    await viewer(h.url);
    await sleep(50); // attach is now measuring the viewport
    h.cancel();
    let resolved = false;
    h.wait.then(() => { resolved = true; });
    await sleep(50);
    assert.equal(resolved, false); // waits for the start path
    evaluate.resolve();
    assert.equal(await h.wait, 'cancelled');
    assert.ok(!page.calls.some((c) => c[0] === 'start'), JSON.stringify(page.calls));
  });
});

test('playwright driver: Done during a slow mouse move dispatches nothing more', async () => {
  await withLive(async (live) => {
    const move = deferred();
    const page = fakePlaywrightPage({ gates: { move } });
    const h = live.start(page, 'r', { driver: 'playwright' });
    const v = await viewer(h.url);
    await until(() => v.frames > 0);
    v.ws.send(JSON.stringify({ type: 'click', x: 5, y: 5 }));
    await until(() => page.calls.some((c) => c[0] === 'move'));
    v.ws.send(JSON.stringify({ type: 'done' }));
    await sleep(30);
    move.resolve();
    assert.equal(await h.wait, 'human-done');
    const after = page.calls.slice(page.calls.findIndex((c) => c[0] === 'move') + 1).map((c) => c[0]);
    assert.ok(!after.includes('down'), after.join());
  });
});

test('a reconnecting viewer waits until the previous viewer has drained and stopped', async () => {
  await withLive(async (live) => {
    const down = deferred();
    const page = fakePlaywrightPage({ gates: { down } });
    const h = live.start(page, 'r', { driver: 'playwright' });
    const v1 = await viewer(h.url);
    await until(() => v1.frames > 0);
    v1.ws.send(JSON.stringify({ type: 'click', x: 1, y: 1 }));
    await until(() => page.calls.some((c) => c[0] === 'down'));
    v1.ws.close(); // phone drops; its press is still in flight
    await until(() => v1.closed);
    const v2 = await viewer(h.url, { key: v1.key });
    v2.ws.send(JSON.stringify({ type: 'text', text: 'second' }));
    await sleep(100);
    assert.ok(!page.calls.some((c) => c[0] === 'text'), 'second viewer ran before the first drained');
    const starts = page.calls.filter((c) => c[0] === 'start').length;
    assert.equal(starts, 1); // and no second stream yet
    down.resolve();
    await until(() => page.calls.filter((c) => c[0] === 'start').length === 2);
    const names = page.calls.map((c) => c[0]);
    assert.ok(names.lastIndexOf('stop') < names.lastIndexOf('start'), names.join()); // old stream stopped first
    h.cancel();
    await h.wait;
  });
});

// --- re-openable link, first frame, trackpad input ---

test('a viewer that stops answering pings can be replaced after staleMs; before that the newcomer is refused', async () => {
  await withLive(async (live) => {
    const { page } = fakePage();
    const h = live.start(page, 'r');
    const v1 = await viewer(h.url, { autoPong: false }); // the phone froze (app switched away, network gone)
    await until(() => v1.frames > 0);
    const early = await viewer(h.url);
    await until(() => early.closed);
    assert.equal(early.closeCode, 4409);
    await sleep(450);
    const v2 = await viewer(h.url);
    await until(() => v2.frames > 0);
    await until(() => v1.closed);
    assert.equal(v2.closed, false);
    h.cancel();
  }, { staleMs: 300 });
});

test('a viewer that answers pings keeps the link', async () => {
  await withLive(async (live) => {
    const { page } = fakePage();
    const h = live.start(page, 'r');
    const v1 = await viewer(h.url);
    await sleep(500);
    const v2 = await viewer(h.url);
    await until(() => v2.closed);
    assert.equal(v2.closeCode, 4409);
    assert.equal(v1.closed, false);
    h.cancel();
  }, { staleMs: 300 });
});

test('a reconnecting viewer gets the latest frame at once, even if the page never repaints', async () => {
  await withLive(async (live) => {
    const { page } = fakePage({ screencastFrames: 1 });
    const h = live.start(page, 'r');
    const v1 = await viewer(h.url);
    await until(() => v1.frames > 0);
    v1.ws.close();
    await until(() => v1.closed);
    const v2 = await viewer(h.url);
    await until(() => v2.frames > 0, 300); // from the cache: this screencast produces no frame and no refresh is due
    assert.deepEqual(v2.messages.find((m) => m.frame), { frame: 'AAAA', w: 100, h: 100 });
    h.cancel();
  }, { refreshMs: 60_000 });
});

test('a static page is re-captured every refreshMs', async () => {
  await withLive(async (live) => {
    const { page, cdp } = fakePage({ screencastFrames: 1 });
    const h = live.start(page, 'r');
    const v = await viewer(h.url);
    await until(() => v.messages.filter((m) => m.frame === 'SNAP').length >= 3, 3000);
    assert.equal(v.messages.filter((m) => m.frame === 'AAAA').length, 1);
    h.cancel();
    await h.wait;
    const n = cdp.sent.filter((m) => m === 'Page.captureScreenshot').length;
    await sleep(300);
    assert.equal(cdp.sent.filter((m) => m === 'Page.captureScreenshot').length, n); // none after the handoff
  }, { refreshMs: 150 });
});

test('the cursor starts in the middle of the viewport and is shared with the next viewer', async () => {
  await withLive(async (live) => {
    const { page } = fakePage();
    const h = live.start(page, 'r');
    const v1 = await viewer(h.url);
    await until(() => v1.cursor);
    assert.deepEqual(v1.cursor, { x: 50, y: 50 });
    v1.ws.send(JSON.stringify({ type: 'move', x: 70, y: 20 }));
    await sleep(200);
    v1.ws.close();
    await until(() => v1.closed);
    const v2 = await viewer(h.url);
    await until(() => v2.cursor);
    assert.deepEqual(v2.cursor, { x: 70, y: 20 });
    h.cancel();
  });
});

const moved = (cdp) => cdp.params.filter(([m, p]) => m === 'Input.dispatchMouseEvent' && p.type === 'mouseMoved').map(([, p]) => p);

test('trackpad moves reach the page as many small mouse moves between the two points, not a jump', async () => {
  await withLive(async (live) => {
    const { page, cdp } = fakePage();
    page.viewportSize = () => ({ width: 1000, height: 800 });
    const h = live.start(page, 'r');
    const v = await viewer(h.url);
    await until(() => v.frames > 0);
    v.ws.send(JSON.stringify({ type: 'move', x: 10, y: 10 }));
    await until(() => moved(cdp).at(-1)?.x === 10);
    const from = moved(cdp).length;
    v.ws.send(JSON.stringify({ type: 'move', x: 210, y: 160 }));
    await until(() => moved(cdp).at(-1)?.x === 210);
    const path = moved(cdp).slice(from);
    assert.ok(path.length >= 10, `only ${path.length} moves`);
    assert.deepEqual(path.at(-1), { type: 'mouseMoved', x: 210, y: 160, button: 'none', buttons: 0 });
    let prev = { x: 10, y: 10 };
    for (const p of path) {
      assert.ok(p.x > 5 && p.x < 215 && p.y > 5 && p.y < 165, JSON.stringify(p)); // between the two points
      assert.ok(Math.hypot(p.x - prev.x, p.y - prev.y) < 40, 'jumped'); // 250 px in steps
      prev = p;
    }
    const xs = path.map((p) => p.x);
    assert.ok(new Set(xs).size === xs.length, 'repeated points'); // every step goes somewhere
    h.cancel();
  });
});

test('long-press drag: press, moves with the button held, release; a drag cut off by Done is released', async () => {
  await withLive(async (live) => {
    const { page, cdp } = fakePage();
    const h = live.start(page, 'r');
    const v = await viewer(h.url);
    await until(() => v.frames > 0);
    v.ws.send(JSON.stringify({ type: 'move', x: 10, y: 50 }));
    v.ws.send(JSON.stringify({ type: 'down', x: 10, y: 50 }));
    v.ws.send(JSON.stringify({ type: 'move', x: 90, y: 50 }));
    v.ws.send(JSON.stringify({ type: 'up', x: 90, y: 50 }));
    await until(() => cdp.params.some(([, p]) => p?.type === 'mouseReleased'));
    const ev = cdp.params.filter(([m]) => m === 'Input.dispatchMouseEvent').map(([, p]) => p);
    const iDown = ev.findIndex((p) => p.type === 'mousePressed'), iUp = ev.findIndex((p) => p.type === 'mouseReleased');
    assert.deepEqual([ev[iDown].x, ev[iDown].y, ev[iDown].buttons], [10, 50, 1]);
    const held = ev.slice(iDown + 1, iUp);
    assert.ok(held.length >= 5 && held.every((p) => p.type === 'mouseMoved' && p.buttons === 1 && p.button === 'left'), JSON.stringify(held));
    assert.deepEqual([ev[iUp].x, ev[iUp].y, ev[iUp].buttons], [90, 50, 0]);
    // A press still held when the human presses Done is released during teardown.
    v.ws.send(JSON.stringify({ type: 'down', x: 90, y: 50 }));
    await until(() => cdp.params.filter(([, p]) => p?.type === 'mousePressed').length === 2);
    v.ws.send(JSON.stringify({ type: 'done' }));
    assert.equal(await h.wait, 'human-done');
    assert.equal(cdp.params.filter(([, p]) => p?.type === 'mouseReleased').length, 2);
  });
});

test('queued moves collapse into the latest one, queued scrolling adds up', async () => {
  await withLive(async (live) => {
    const inputGate = deferred();
    const { page, cdp } = fakePage({ inputGate });
    const h = live.start(page, 'r');
    const v = await viewer(h.url);
    await until(() => v.frames > 0);
    v.ws.send(JSON.stringify({ type: 'key', key: 'Tab' })); // blocks the pump
    await until(() => cdp.sent.includes('Input.dispatchKeyEvent'));
    for (let i = 1; i <= 200; i++) v.ws.send(JSON.stringify({ type: 'move', x: i, y: 50 })); // more than MAX_QUEUE
    for (let i = 0; i < 5; i++) v.ws.send(JSON.stringify({ type: 'wheel', x: 1, y: 1, dy: 10 }));
    await sleep(100);
    inputGate.resolve();
    await until(() => cdp.params.some(([, p]) => p?.type === 'mouseWheel'));
    assert.equal(moved(cdp).at(-1).x, 200); // the last move wasn't dropped
    assert.deepEqual(cdp.params.filter(([, p]) => p?.type === 'mouseWheel').map(([, p]) => p.deltaY), [50]);
    h.cancel();
  });
});

test('glidePath: eased, slightly curved, bounded steps ending on the target', () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  assert.deepEqual(glidePath({ x: 5, y: 5 }, { x: 5, y: 5 }), []);
  assert.deepEqual(glidePath({ x: 5, y: 5 }, { x: 8, y: 5 }, rnd), [{ x: 8, y: 5 }]);
  const p = glidePath({ x: 0, y: 0 }, { x: 400, y: 0 }, rnd);
  assert.equal(p.length, 24); // capped
  assert.deepEqual(p.at(-1), { x: 400, y: 0 });
  assert.ok(p.every((q) => Math.abs(q.y) <= 7 && q.x >= 0 && q.x <= 400));
  for (let i = 1; i < p.length; i++) assert.ok(p[i].x > p[i - 1].x);
  assert.ok(p[1].x - p[0].x < p[12].x - p[11].x); // accelerates out of the start
});

test('playwright driver: moves, drag and snapshot refresh', async () => {
  await withLive(async (live) => {
    const page = fakePlaywrightPage();
    page.screenshot = async () => { page.calls.push(['screenshot']); return Buffer.from('shot'); };
    page.screencast.start = async (o) => { page.calls.push(['start', o.size]); }; // a static page: no frames
    const h = live.start(page, 'r', { driver: 'playwright' });
    const v = await viewer(h.url);
    await until(() => v.frames >= 2, 3000);
    assert.equal(v.messages.find((m) => m.frame).frame, Buffer.from('shot').toString('base64'));
    assert.deepEqual(v.cursor, { x: 400, y: 300 });
    v.ws.send(JSON.stringify({ type: 'down', x: 400, y: 300 }));
    v.ws.send(JSON.stringify({ type: 'move', x: 500, y: 300 }));
    v.ws.send(JSON.stringify({ type: 'up', x: 500, y: 300 }));
    await until(() => page.calls.some((c) => c[0] === 'up'));
    const seq = page.calls.filter((c) => ['move', 'down', 'up'].includes(c[0]));
    assert.equal(seq[0][0], 'move'); // to the press point first
    const iDown = seq.findIndex((c) => c[0] === 'down');
    assert.ok(seq.slice(iDown + 1, -1).length >= 5 && seq.slice(iDown + 1, -1).every((c) => c[0] === 'move'));
    assert.deepEqual(seq.at(-1), ['up']);
    h.cancel();
  }, { refreshMs: 100 });
});
