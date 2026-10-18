# Engines

Bosun can drive three browsers. Pick one per deployment (`ENGINE`) or per session (`session_open { engine }`).

| engine | what it is | process model | live view |
|---|---|---|---|
| `chromium` | Playwright's Chromium, `--disable-blink-features=AutomationControlled` | one shared browser, a context per session | CDP screencast + `Input.*` |
| `patchright` | [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) 1.64.1: Playwright fork that avoids `Runtime.enable` and the other CDP/automation leaks | a browser per session; persistent context (temp profile for ephemeral sessions), `channel: chromium`, no custom UA, `viewport: null` | CDP screencast + `Input.*` |
| `camoufox` | [Camoufox](https://github.com/daijro/camoufox) 152.0.4-beta.30 (anti-detect Firefox) via [camoufox-js](https://github.com/apify/camoufox-js) 0.13.0 | a browser per session; persistent context (temp profile for ephemeral sessions); fingerprint (UA, screen, window, fonts, WebGL) generated per launch for the host OS | Playwright `page.screencast` + `page.mouse`/`keyboard` |

## Results

Measured 2026-10-18 on a Mac (Apple M4, macOS, residential IP in Austria), **headful** on the real display,
one fresh ephemeral session per engine, Bosun's default `de-AT` / `Europe/Vienna`. Two full runs; the table shows the
final run (on the code in this branch), ranges where the runs differed.
Reproduce with `npm run measure:engines` (needs internet). Raw data: [engines/results-darwin.json](engines/results-darwin.json).

| test | chromium | patchright | camoufox |
|---|---|---|---|
| [bot.sannysoft.com](https://bot.sannysoft.com/) | 31/31 checks passed ([shot](engines/chromium-sannysoft.jpg)) | 31/31 passed ([shot](engines/patchright-sannysoft.jpg)) | 30/31 passed; the one failure is "Chrome (New): missing", expected for Firefox ([shot](engines/camoufox-sannysoft.jpg)) |
| [CreepJS](https://abrahamjuliot.github.io/creepjs/) ¹ | 44% like headless, 0% headless, 0% stealth ([shot](engines/chromium-creepjs.jpg)) | 31% like headless, 0% headless, 0% stealth ([shot](engines/patchright-creepjs.jpg)) | **6% like headless**, 0% headless, 0% stealth ([shot](engines/camoufox-creepjs.jpg)) |
| [BrowserScan bot detection](https://www.browserscan.net/bot-detection) | Normal ([shot](engines/chromium-browserscan.jpg)) | Normal ([shot](engines/patchright-browserscan.jpg)) | Normal ([shot](engines/camoufox-browserscan.jpg)) |
| kaufland.at (Cloudflare) ² | 403 "Just a moment…", passed by itself after ~2 s, no click ([shot](engines/chromium-kaufland.jpg)) | same, ~2 s, no click ([shot](engines/patchright-kaufland.jpg)) | 403 interstitial, passed by itself after ~2–6 s, no click ([shot](engines/camoufox-kaufland.jpg)) |
| `session_open` time (warm – cold) | 0.6 – 3.6 s (cold incl. the shared browser's launch) | 0.6 – 2.3 s | 1.6 – 6.1 s (fingerprint generation + launch) |
| **RAM footprint, 3 heavy pages open** ³ | **1210 MB** (14 processes) | **1517 MB** (16 processes) | **1810 MB** (11 processes) |
| **RAM footprint, idle after closing the tabs** ³ | **584 MB** | **990 MB** | **1331 MB** |
| RAM RSS sum, 3 pages / idle ³ | 1111–2359 MB / 692–1489 MB | 1643–2850 MB / 1435–2213 MB | 1377–2997 MB / 1127–2145 MB |

¹ CreepJS no longer publishes a "trust score"; its Headless panel reports *like headless* (share of headless-like
traits), *headless* and *stealth* (detected anti-fingerprinting patches). Lower is better.

² The Turnstile click test (one human-like click on the checkbox) never ran: on this machine no engine was shown a
checkbox. All three got Cloudflare's 403 interstitial, and it cleared without interaction.

³ One session, three tabs open together: geizhals.at search (`?fs=mac+mini`), a hornbach.at product page (first
result for "akkuschrauber"), willhaben.at marketplace search (`fahrrad`); measured 10 s after load. Idle = the same
session with the two extra tabs closed and the first on `about:blank`, 10 s later. Footprint was stable between the
two runs (±200 MB); summed RSS more than doubled from one run to the next for the same pages, which is the shared-page
over-count at work — use footprint (or PSS on Linux) for sizing.
**RSS** is the sum over the browser's whole process tree and over-counts memory shared between processes (frameworks,
shared GPU/IPC buffers are counted once per process). **footprint** is macOS's `phys_footprint` (`footprint` tool),
the closest local stand-in for Linux PSS: private dirty + compressed memory per process, so shared pages aren't
double-counted (it can exceed RSS because it includes compressed and GPU-attributed memory). **PSS** is Linux-only;
`measure:engines` records it there (`pssMB`). For capacity planning: a further `chromium` session adds renderer
processes to the shared browser, while every `patchright` or `camoufox` session is a whole new browser (its idle
cost above is paid per session).

### Reading the results

- On a residential IP with a real display, **all three engines pass every test**. Plain Chromium's remaining
  tells (CreepJS 44% like headless) aren't enough for Cloudflare's managed challenge on kaufland.at here.
- Camoufox has the cleanest fingerprint (6% like headless; no WebRTC/device leakage) but is the slowest to start and
  the heaviest idle. patchright sits between the two and keeps the CDP live view.
- **The Turnstile loop seen in production ("Verifiziere…", then the checkbox again) did not reproduce here.** That
  loop is Turnstile rejecting the environment after the click, and the environment is what differs (next section).
  Suggested order: try `ENGINE=patchright`, then `ENGINE=camoufox` on the production host, and run
  `npm run measure:engines` there to fill in the Linux column.

## Linux / Xvfb on a datacenter host: what differs (expected, not measured)

Not measured: no such host was available for this run. Expected differences, roughly in order of impact:

1. **IP reputation.** Cloudflare scores the client ASN. Datacenter/VPS ranges get interactive challenges much more
   often and Turnstile commonly loops for them even with a real browser and a real person clicking. No engine fixes
   this; a residential egress (the home server, or a residential proxy) does.
2. **No GPU under Xvfb.** WebGL reports SwiftShader/llvmpipe, which CreepJS and Turnstile treat as a strong headless
   signal (expect "like headless" to rise for both Chromium engines). Camoufox spoofs the WebGL vendor/renderer
   strings, but rendering hashes still come from the software renderer.
3. **Fonts and OS consistency.** A minimal Linux font set is unusual. Keep `CAMOUFOX_OS` at its default (the host OS):
   a macOS/Windows fingerprint on Linux fonts is a mismatch. Install a normal desktop font set (e.g. `fonts-noto`,
   `fonts-liberation`, `fonts-dejavu`).
4. **Screen geometry.** `xvfb-run -s "-screen 0 1366x900x24"` is an uncommon size; prefer `1920x1080x24`.
5. **Locale/timezone vs IP geolocation.** Bosun defaults to `de-AT`/`Europe/Vienna`; on a host abroad that conflicts
   with the IP's location. Set `locale`/`timezone` on `session_open` to match the egress IP.
6. **Headless.** Never run production headless: headless patchright still reports `HeadlessChrome` in its UA.
7. **Memory.** Expect lower absolute numbers than macOS (no Metal/GPU process; smaller font caches), and PSS gives the
   honest per-session cost. The ratio between engines should hold.

## Implementation notes

- Engines are `optionalDependencies`; `npm ci --omit=optional` leaves only `chromium`. Browsers are separate
  downloads: `npx patchright install chromium`, `npx camoufox-js fetch` (camoufox-js needs Node 22+).
- A missing package or browser binary is an error naming the install command. The default `ENGINE` (package and
  binary; for headless `chromium` the headless shell is only found at launch) is checked at startup, and the service
  refuses to start without it; other engines on first use. Bosun never falls back to another engine.
- Every `patchright`/`camoufox` session, and every session with a persistent profile, is a persistent context in a
  directory Bosun owns. If closing it hangs (10 s), Bosun kills the processes running on that directory and only
  then deletes the temp profile and frees the slot; a browser that survives `SIGKILL` keeps its slot (logged).
  Temp profiles left by a killed Bosun are removed at startup.
- camoufox-js declares `playwright-core <1.63`; npm installs a nested 1.62 for it. Bosun only calls its
  `launchOptions()` and launches Camoufox with its own Playwright 1.64.1 (`firefox.launch`, Juggler protocol). This
  combination is what the test suite runs (`ENGINE=camoufox npm test`: all suites pass). The alternative, camoufox's
  own Playwright server over WebSocket, would have needed a version-matched second Playwright client in Bosun, for
  no gain. camoufox-js (Apify, ~480k downloads/month, stable releases) was chosen over the official `camoufox` npm
  launcher, which is on 0.5.9 betas.
- Camoufox `humanize` (curved cursor paths) is **off**: with Playwright 1.64 it makes clicks hang in Playwright's
  actionability checks when the viewport matches the fingerprint window. Revisit when camoufox-js supports 1.64.
- Live view on Firefox uses Playwright's cross-browser `page.screencast` (JPEG frames, acked after each WebSocket
  write) and `page.mouse` / `page.keyboard` for input, with the same link rules (one viewer at a time, dead after the handoff), input drain and
  teardown guarantees as the CDP path.
- Password masking: Bosun's sensitive-field scans run in an isolated world on patchright and camoufox (pages can't see
  them) and in the page's world on plain Chromium. The "was once a password field" tracker (a MutationObserver that
  follows open and declarative shadow roots, no prototype patching) must run in that same world: it is an init
  script on `chromium` (page world) and `camoufox` (isolated world), so it runs from document start; on `patchright`
  init scripts land in the page's world, so Bosun installs it in the isolated world on every frame navigation (a page
  that reveals a password while its own document is still parsing can beat it there). On top, Bosun notes password
  fields when a handoff starts and every 500 ms during it.
- A persistent profile records its engine family (`bosun-profile.json`): Chromium profiles open with `chromium` or
  `patchright`, Firefox profiles only with `camoufox`.
