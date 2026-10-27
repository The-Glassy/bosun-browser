// Per-call deadline: every tool call ends within its limit (TOOL_TIMEOUT_SEC, per tool TOOL_TIMEOUTS), whatever the
// browser does. A page call that runs out of time is cut off inside its session's queue (sessions.mjs run), so the
// calls behind it are not held up; then the page is checked and, if it no longer responds, replaced.
import { AsyncLocalStorage } from 'async_hooks';

export const DEFAULT_TIMEOUT_SEC = 60;
export const MAX_TIMEOUT_SEC = 120;
// Tools with a deadline. The meeting tools, download_wait, request_human and handoff_wait wait by design and keep
// the limits they have (their own timeoutMs / timeoutSec, the meeting's own deadlines).
export const TIMED_TOOLS = ['session_open', 'session_close', 'navigate', 'read', 'click', 'type', 'select', 'press', 'back', 'wait_for',
  'screenshot', 'sessions', 'secret_create', 'upload_create', 'upload', 'downloads', 'download_get', 'keepalive_set', 'keepalive_list',
  'keepalive_remove', 'macro_save', 'macro_list', 'macro_get', 'macro_delete'];
// macro_run has a cap of its own for the whole run (timeout_sec); each of its steps gets the deadline of its tool.
export const OWN_LIMIT_TOOLS = ['download_wait', 'request_human', 'handoff_wait', 'meeting_join', 'meeting_status', 'meeting_chat_read',
  'meeting_chat_send', 'meeting_stop_recording', 'meeting_leave', 'meeting_recording_delete', 'macro_run'];
// wait_for waits up to 60 s by itself: unless TOOL_TIMEOUTS names it, its deadline is at least this.
export const WAIT_FOR_MIN_SEC = 75;
// A page operation is cut off this long before the deadline (a third of a shorter one), to check the page and
// answer in time.
export const reserveMs = (limitMs) => Math.min(8_000, Math.floor(limitMs / 3));

// TOOL_TIMEOUT_SEC (every timed tool) and TOOL_TIMEOUTS ("read=90,upload=120"): tool -> ms.
export function parseToolTimeouts(env) {
  const sec = (name, raw) => {
    if (!/^\d+$/.test(String(raw).trim())) throw new Error(`${name} must be a whole number of seconds (got "${raw}")`);
    const n = Number(raw);
    if (n < 1 || n > MAX_TIMEOUT_SEC) throw new Error(`${name} must be between 1 and ${MAX_TIMEOUT_SEC} seconds (got ${n})`);
    return n * 1000;
  };
  const raw = env.TOOL_TIMEOUT_SEC;
  const all = raw === undefined || raw === '' ? DEFAULT_TIMEOUT_SEC * 1000 : sec('TOOL_TIMEOUT_SEC', raw);
  const out = new Map(TIMED_TOOLS.map((t) => [t, all]));
  out.set('wait_for', Math.min(MAX_TIMEOUT_SEC * 1000, Math.max(all, WAIT_FOR_MIN_SEC * 1000)));
  for (const item of String(env.TOOL_TIMEOUTS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^([a-z_]+)\s*=\s*(.*)$/.exec(item);
    if (!m) throw new Error(`TOOL_TIMEOUTS must be a comma list of tool=seconds, e.g. read=90 (got "${item}")`);
    if (OWN_LIMIT_TOOLS.includes(m[1])) throw new Error(`TOOL_TIMEOUTS: ${m[1]} keeps its own limit and takes no deadline`);
    if (!out.has(m[1])) throw new Error(`TOOL_TIMEOUTS: no tool ${m[1]} (tools with a deadline: ${TIMED_TOOLS.join(', ')})`);
    out.set(m[1], sec(`TOOL_TIMEOUTS ${m[1]}`, m[2]));
  }
  return out;
}

// The tool call being served, in its async context: { name, limitMs, at (deadline, ms since epoch), reserveMs, done,
// expired, queued, inPage, state (what the check of the page found so far), guard, vet (macro steps) }.
const scope = new AsyncLocalStorage();
export const runCall = (call, fn) => scope.run(call, fn);
// Only while the call is still running: work it started that outlives it (a timer, a background visit) is not bound.
export const currentCall = () => { const c = scope.getStore(); return c && !c.done ? c : null; };

// Runs fn as one call named name that is answered within limitMs, whatever the browser does. A page operation in it
// is cut off earlier by its session (sessions.mjs run), which checks the page and usually answers first; if that
// check is still going on, the answer says how far it got. hooks: what a macro step adds (macros.mjs): guard(),
// run in the session's queue right before each page operation of the call and again right before an element is
// acted on; vet(handle), run by click, type and upload on the element they are about to act on (tools.mjs
// onTarget).
export async function withDeadline(name, limitMs, fn, hooks = {}) {
  const call = { name, limitMs, at: Date.now() + limitMs, reserveMs: reserveMs(limitMs), done: false, expired: false, inPage: false, queued: false, state: null, guard: hooks.guard ?? null, vet: hooks.vet ?? null };
  let timer;
  try {
    const work = runCall(call, fn);
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => {
        call.expired = true;
        reject(new Error(timeoutMessage(call, call.state ?? (call.queued && !call.inPage ? 'queued' : call.inPage ? 'checking' : null))));
      }, limitMs);
    });
    work.catch(() => {});
    return await Promise.race([work, late]);
  } finally { clearTimeout(timer); call.done = true; }
}

const secs = (ms) => `${Math.round(ms / 1000)} s`;
export const limitNote = (call) => `Bosun's limit for one ${call.name} call (TOOL_TIMEOUT_SEC / TOOL_TIMEOUTS)`;

// What the agent is told when a call ran out of time, by what the check of the page found (state).
export function timeoutMessage(call, state) {
  const head = `${call.name} timed out after ${secs(call.limitMs)} (${limitNote(call)})`;
  if (state === 'queued') return `${head} while waiting behind other calls on this session; it was not run, the session is usable`;
  if (state === 'responsive') return `${head}; the page still responds and the session is usable (if what the call started is still running, the next call on this session waits for it to stop, at most ${secs(20_000)}, then the tab is replaced to stop it)`;
  if (state === 'checking') return `${head}; Bosun is checking the page (one that does not respond is replaced by a new tab in the same session, cookies kept, at about:blank) and the next call on this session waits for that`;
  if (state === 'replaced') return `${head} and the page stopped responding, so Bosun replaced it with a new tab in the same session (cookies kept, now at about:blank): navigate again`;
  if (state === 'closed') return `${head} and the page stopped responding; it could not be replaced, so the session was closed (page-wedged): open a new one`;
  return head;
}
