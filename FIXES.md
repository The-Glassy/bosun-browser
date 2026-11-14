# Bosun 0.26.2 review fixes

Branch: `fix-review-0261`, from main/v0.26.1 (`027d307306147833f43e2dad582cdf351586c827`).

## Fix commits

| Commit | Change |
| --- | --- |
| `8241fab` | Fix all seven reported paths; add failing regressions; bump package, lockfile and MCP version to 0.26.2; date CHANGELOG 2026-11-14. |
| `bb260b1` | Omit assertion matched text for frame-bearing pages; distinguish Chromium cookie ancestor bits. |
| `4aa4969` | Preserve scan-time frame presence and track frame attach/detach through assertion extraction, including disappearing source frames. |
| `a34715c` | Preserve custom-widget label hints and resolve native label associations for form-associated custom elements across evaluation worlds. |

All commits use Glassy <342939150+The-Glassy@users.noreply.github.com>, with no trailers. Nothing was pushed, tagged or released.

## Findings resolved

| Original finding | Resolution and regression coverage |
| --- | --- |
| P1. Shadowed labels | Native labels getters bypass shadowed properties. Native label-to-control lookup also covers custom controls, while custom widget label collections remain supported. Wrapping/for/shadow-root labels, text reflections, real screenshot masks, ordinary search inputs, and real form-associated custom elements are covered. |
| P1. Macro assertion refresh | Shared read evaluation rescans and masks before truncating, excludes hidden text, and caps matched text at 10,000 characters. Text is omitted if frames exist or attach/detach during extraction. Tests rotate credentials between scan/extraction, including attached and removed source frames, and check failure diagnostics. |
| P1. Destructive video validation | Preflight requires ffmpeg and ffprobe. A bounded initial-packet probe distinguishes valid/invalid/unknown; missing, timed-out, malformed or operationally failed probes retain media with a status error. Stop/probe failures retain media; explicit deletion still removes it. Real VP9/Opus and corrupt/audio-only checks pass. |
| P2. Cookie partition loss | Identity includes partitionKey and Chromium's ancestor bit, with an omitted bit normalized to true. Tests cover independent existing-cookie precedence, both ancestor values, deduplication and a second save/open cycle. |
| P2. Nested macro accumulation | All nested calls share limits of 1,000 executed steps, 4 MiB retained text/metadata, 20 images and 8 MiB image data. Excess output is rejected before retention, including optional steps and failure diagnostics. Execution, UTF-8 read/assert bytes, image bytes/count and diagnostics are covered. |
| P2. Stalled CDP stop | Stop-screencast and detach have separate bounds and shared cleanup ownership. Hanging stop/detach and late acquisition after cancellation are covered. |
| P2. Early video reservation release | Video cleanup owns reservation release; overlapping stops share cleanup and deletion can escalate shutdown. A blocked encoder rejects another tenant's video join until cleanup completes. |

## Validation

Environment: macOS 26.5 arm64; Node v25.2.1; ffmpeg/ffprobe 9.0.2. Dependencies installed using npm ci, with scripts disabled; optional engines were installed for the final matrix.

- All 21 new regression tests were demonstrated to fail before their fixes. Eighteen fail on unmodified v0.26.1 source in a separate baseline worktree in `../baseline-regressions.log`; two further cases fail in `../original-followup-regressions.log`; the disappearing-frame case fails in `../original-removed-frame-regression.log`. The extended custom-widget case also fails before the final correction (`../round3-regression-before.log`, `../custom-control-isolated-before.log`).
- The final four browser masking tests pass on Chromium, Patchright and Camoufox: `../final-dom-labels-{chromium,patchright,camoufox}.log`.
- Real encoder pipeline: 4 passed, 0 failed, including page capture, VP9/Opus mux, audio continuity and invalid-media checks (`../pipeline-after.log`).
- Full serial suite: **670 tests; 660 passed, 0 failed, 0 cancelled, 10 skipped; exit code 0** (51 min 41 sec). Command: `node --test --test-concurrency=1 test/*.test.mjs`; log: `../full-suite.log`.
- Environment-only failures: **none**. The 10 skips comprise six Linux/PulseAudio meeting-recording cases, one Linux-only sandbox preflight, two engine-specific checks not applicable to the Chromium full run, and one real ElevenLabs test without ELEVENLABS_API_KEY. The separate three-engine masking matrix has no skips.

## Independent review and verdict

Three fresh independent `codex exec -m gpt-6.1-sol -s read-only` reviewers were run, with no repository writes by the reviewers:

1. `027d307..8241fab`: P1 cross-frame assertion refresh and P2 cookie ancestor identity; corrected in `bb260b1`.
2. `027d307..bb260b1`: P1 disappearing source frame; corrected in `4aa4969`.
3. `027d307..4aa4969`: P1 custom-control label compatibility; corrected in `a34715c`, then validated with real browsers on all three engines. The reviewer confirmed all other original findings and assertion follow-ups were addressed; 52 selected browser-free tests passed.

Raw independent verdicts remain unchanged in `../review-round1.md`, `../review-round2.md` and `../review-round3.md`. The third review reported a P1 on its reviewed commit; its correction was made afterward. No fourth independent review was run, respecting the three-round limit.

Final implementation verdict: all original P1/P2 findings and every independent review finding are fixed; no known P0/P1 remains. The final label correction has browser regression validation rather than a subsequent independent-review verdict.

FIXBOSUN-DONE
