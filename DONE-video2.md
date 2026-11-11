# Bosun 0.26.0 — separate video artifacts and macro control flow

Implemented both parts of the release in this checkout.

- Audio always uses the original independent Ogg/Opus recorder, 16 kHz mono input, 24 kbps, at `<id>.ogg`.
  Video uses a second ffmpeg and page-scoped CDP screencast at `<id>.webm`; speaker labels remain at
  `<id>.speakers.json`, with the original audio input timestamp as zero. No Xvfb display capture.
- A video failure stops only video and reports `meeting_status.video.error`, without replacing audio or its
  timeline. ffprobe checks for readable video packets before keeping a partial video. Audio failure stops both.
- `recording_get` preserves audio `get_url`/`url`, filename, MIME, curl and speakers, and adds video metadata with
  its independent tenant-scoped one-time URL, same TTL and curl. Ended events include `recording.video`.
  Consent ordering, resource guards, opt-out, stop/delete races, forget markers, retention and restart discovery
  cover the three artifacts.
- Macros accept action timeoutMs (click/type/select/hover, 100–60000), instant if_exists, and bounded repeat
  (required max 1–100). Three nested controls and 100 total saved steps maximum; nested schemas, parameters,
  risky-step checks, site guards and cancellation apply throughout. Hover shares click targeting and policy.
  Reads include their 1-based pre-order step index; asserts include matched text; loops report count/max_hit.
  No evaluate or arbitrary user JavaScript. README/tool descriptions document the behavior. Closes #36.
- Package, lockfile and MCP serverInfo are 0.26.0. Searched every 0.25.0 occurrence: remaining references are
  the historical CHANGELOG release, historical DONE-video.md, and user-provided BRIEF files. Those are preserved.

## Verification

- Main validation command (59 passed, 2 skipped, no failures):
  `node --test test/macros-control.test.mjs test/meeting-video.test.mjs test/meeting-video-pipeline.test.mjs test/meeting-video-integration.test.mjs test/speaker-timeline.test.mjs test/speech-settings.test.mjs test/meeting-optout.test.mjs test/meeting-mute-race.test.mjs`
- Real ffmpeg tests cover VP9/Opus encoding, valid/invalid WebM detection, identical Ogg format in both modes,
  and full audio duration after the independent video process is killed.
- All 9 pre-existing macro unit tests passed, extracted unchanged into a temporary test module without the
  browser/service before hook (temporary module removed). New macro schema/runner tests cover each feature,
  nesting/step caps, both branches, loop absence/max, nested risk checks, deadlines, cancellation and read/assert output.
- 9 configuration unit tests passed. Syntax checks and `git diff --check` passed.
- Full browser/service tests cannot run here: loopback listening returns EPERM and Chromium's macOS
  MachPortRendezvous bootstrap is denied by the sandbox. The attempted existing macro/service suites were
  blocked by that environment; two config server-start tests fail on listen EPERM. Linux PulseAudio integration
  is skipped on macOS. Browser-backed macro tests and the updated Linux three-artifact integration test are
  included for execution on an unrestricted Linux host. This is not a claim that the full npm test suite passed.

## Commits and bundle

Git writes in the original checkout were denied (`.git/index.lock: Operation not permitted`). Small commits
were created in `/tmp/bosun-video2-commits`, based on cc1550b, and exported to `video-separate.bundle`.
The bundle contains only this release's commits, with cc1550b as its prerequisite. The checkout's source files
also contain the changes. Existing BRIEF files and meeting-video.bundle were not changed.

Inspect/import without checking out over the edited working tree:

```sh
git bundle verify ./video-separate.bundle
git fetch ./video-separate.bundle video-separate:video2-review
git log --oneline cc1550b..video2-review
```

VIDEO2-DONE
