# Bosun 0.25.0 — meeting page video

Implemented on `meeting-video` from v0.24.0. The first two commits were written to this checkout. Later Git writes failed with `Unable to create .git/index.lock: Operation not permitted`; the remaining small commits were finished in a temporary clone. `meeting-video.bundle` contains the complete `meeting-video` branch, including all four commits. The working files in this checkout also contain the final changes.

- `meeting_join`: `record_video` boolean (default false), `video_fps` integer 2–5 (default 2). Join parameters only; no speech settings or tenant defaults.
- Capture uses `Page.startScreencast` on this meeting's CDP target. The service's headful browsers inherit one Xvfb display, so grabbing that display would cross tenant boundaries. Video is proportional, padded to 1280×720, VP9 realtime/CPU-used 8/CRF 36/two threads/no lookahead. The same ffmpeg muxes the existing private PulseAudio monitor as mono Opus, 16 kHz input/24 kbps, into one `.webm`.
- Capture starts after the existing announcement step and pending-chat objection check. The default announcement mentions audio/video in English and German, including live transcript mode. Custom announcement text remains caller-controlled.
- Static frames repeat on the PulseAudio input clock; page frame ACKs are paced. Capture and encoder setup, backpressure, graceful stop and cancellation are bounded. Video failures stop the combined recording and live transcription; no automatic audio fallback.
- `meeting_status.video` reports active capture, selected fps and combined file bytes. One-time recording URLs, MIME, curl filename, restart discovery, sidecars, deletion markers, deletion during stop, opt-out, shutdown and retention support both Ogg and WebM.
- Resource admission: `MEETING_VIDEO_LIMIT=1` across tenants, with lobby/setup reservations; `MEETING_VIDEO_MIN_FREE_GB=2` GiB checked before reservation and again after admission. Slots release on stop/failure/cancellation.
- Package, lockfile and MCP serverInfo are 0.25.0. Searched every `0.24.0` occurrence, including hidden files outside `.git`/dependencies: historical changelog and these baseline references remain; two DESIGN references describe the separate `@animalabs/agent-framework` version and were intentionally preserved. User-provided BRIEF files were left untouched.

## Validation

Final focused command:

```sh
node --test test/meeting-video.test.mjs test/meeting-video-pipeline.test.mjs \
  test/meeting-video-integration.test.mjs test/speaker-timeline.test.mjs \
  test/speech-settings.test.mjs test/meeting-optout.test.mjs
```

**47 passed, 0 failed, 2 skipped.** Unit tests exercise the real lifecycle and MCP surface in memory, including parameter validation/defaults, announcement ordering, queued objections, none/failed announcement policy, disk/concurrency limits, pre-capture cancellation, deletion races, all deletion paths, URL ownership/one-time use, restart retrieval and cleanup. Existing speaker timeline, opt-out and speech-setting tests pass. Imports do not shadow globals.

The real ffmpeg test passed on macOS: checks VP9 + Opus in one WebM, 720p/2 fps, repeated static frames, 0600 permissions, shared stream start within codec delay, packet cadence, and decoded audio spanning the file. It caught and fixed VP9 lookahead starving audio at low fps.

Two integration cases were skipped with explicit reasons: Chromium's Mach bootstrap is denied by the sandbox, and Linux/PulseAudio are unavailable. Added a local data-page test that foregrounds a second colored window and checks decoded pixels still belong to the meeting page, plus a full local fake-meeting + private PulseAudio + one-time download test. README gives Docker/Xvfb commands. Docker's daemon socket is also denied here.

`npm test` was attempted and interrupted after ~87 seconds when socket-dependent suites stalled. Its partial result was 9 passes, 2 failures from `listen EPERM` on 127.0.0.1, and 51 cancellations. This is not a full-suite pass. Separate config checks showed the same socket restriction. Syntax checks of changed production modules and `git diff --check` pass.

## Measured cost

Reproducible script: `node scripts/measure-meeting-video.mjs [static|motion] [2–5 fps] 30`.
Raw results: `docs/measurements/meeting-video.json`. Apple M4, native ffmpeg 9.0.2, 1280×720, 30-second samples; hourly extrapolations:

| Source | FPS | CPU, one core | CPU seconds/hour | Combined MB/hour |
|---|---:|---:|---:|---:|
| Static test pattern | 2 | 3.70% | 133 | 24.84 |
| Moving test pattern | 2 | 6.43% | 232 | 173.50 |
| Moving test pattern | 5 | 14.17% | 510 | 395.53 |

These measure **ffmpeg plus the Node frame controller**, with JPEG fixtures generated before timing and synthetic realtime audio. Every benchmark checks decoded audio duration against the video/container duration. Browser/CDP JPEG rendering, PulseAudio and meeting-browser CPU are excluded; these are not deployment-total measurements or hour-long runs.

## Open risks

- Run the added headful Chromium/Patchright isolation and Linux PulseAudio integration cases on the deployment image before rollout; neither could run in this sandbox. The runtime preflight requires libvpx-vp9/libopus and refuses an unsupported build.
- Measure total CPU on the Linux host. Disk depends on actual screen content/motion; CRF is variable bitrate and the admission floor is not a quota. The concurrency limit is per Bosun process.
- Low fps samples can miss fast changes; the viewport includes only content visible inside the meeting page. Page speaker labels remain approximate and Opus introduces a small codec delay. Clock jumps or an encoder more than five seconds behind fail the recording rather than silently changing timing.
- Existing consent policy is unchanged: failed announcements still permit capture, and `announce: none` relies on the caller. Custom `announce_text` must disclose video.
