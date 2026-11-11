// Recording sidecar and offline transcript helper. Times in the builder are host wall-clock milliseconds;
// conversion to audio seconds happens only after the recorder has supplied its input timestamp.
export const MAX_SPEAKER_INTERVALS = 50_000;
const MIN_MS = 300;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80);
const key = (s) => clean(s).toLowerCase();
const bare = (s) => key(s).replace(/\s*\(.*\)\s*$/, '').trim();

export class SpeakerTimeline {
  constructor({ startedAt, self = [], maxIntervals = MAX_SPEAKER_INTERVALS }) {
    this.startedAt = startedAt;
    this.self = new Set(self.flatMap((s) => [key(s), bare(s)]).filter(Boolean));
    this.maxIntervals = maxIntervals;
    this.intervals = [];
    this.active = new Map();
    this.last = startedAt;
    this.until = null;
    this.sealed = false;
    this.truncated = false;
    this.clockError = false;
    this.incomplete = false;
  }

  sample({ t, names, name, truncated = false }) {
    if (truncated) this.truncated = true;
    if (this.sealed || !Number.isFinite(t) || (this.until !== null && t > this.until)) return;
    // An initial page sample can precede the recording; carry that state into audio zero.
    t = Math.max(t, this.startedAt);
    if (t < this.last) { this.clockError = true; return; }
    this.last = t;
    const next = new Set((names ?? (name ? [name] : [])).slice(0, 128).map(clean)
      .filter((n) => n && !this.self.has(key(n)) && !this.self.has(bare(n))));
    if ((names?.length || 0) > 128) this.truncated = true;
    for (const [n, start] of this.active) if (!next.has(n)) {
      this.append(start, t, n);
      this.active.delete(n);
    }
    for (const n of next) if (!this.active.has(n)) this.active.set(n, t);
  }

  append(start, end, name) {
    if (end - start < MIN_MS) return;
    if (this.intervals.length >= this.maxIntervals) { this.truncated = true; return; }
    this.intervals.push({ start, end, name });
  }

  finish(at) {
    if (this.sealed) return;
    this.until = at;
    for (const [name, start] of this.active) this.append(start, at, name);
    this.active.clear();
    this.sealed = true;
  }

  count(now) {
    let count = this.intervals.length;
    for (const start of this.active.values()) if ((this.until ?? now) - start >= MIN_MS) count++;
    return Math.min(this.maxIntervals, count);
  }

  snapshot({ meeting_id, platform, audioStartedAt = this.startedAt, recording_seconds, now = this.until ?? this.last, alignment = 'estimated-recorder-start', duration_source = 'wall-clock-estimate' }) {
    const end = this.until ?? now;
    const runs = [...this.intervals];
    for (const [name, start] of this.active) if (end - start >= MIN_MS) runs.push({ start, end, name });
    const intervals = runs.slice(0, this.maxIntervals).map(({ start, end, name }) => ({
      start_s: Math.max(0, (start - audioStartedAt) / 1000),
      end_s: Math.min(recording_seconds, (end - audioStartedAt) / 1000), name,
    })).filter((r) => r.end_s - r.start_s >= 0.3 - 1e-9)
      .sort((a, b) => a.start_s - b.start_s || a.end_s - b.end_s || a.name.localeCompare(b.name));
    return {
      meeting_id, platform, recording_seconds,
      speaker_labels: intervals.length ? 'seen' : 'none-seen', source: 'page-active-speaker', alignment, duration_source,
      note: 'Page activity is approximate (200 ms sampling), may lag audio, miss speakers or show duplicate display names; this is not audio diarization. ' +
        (alignment === 'pulse-input-timestamp' ? 'Zero is the FFmpeg PulseAudio input start timestamp. ' : 'Zero is estimated from recorder launch; startup latency may offset labels. ') +
        (duration_source === 'wall-clock-estimate' ? 'Audio duration could not be probed; the stop clock estimates its length. ' : '') +
        'Only recorded time is included; a recording restart replaces the file and resets the timeline. ' +
        (this.incomplete ? 'Some page samples could not be read; labels may be missing or stale. ' : '') +
        (this.clockError ? 'Out-of-order clock samples were dropped; clock alignment may be unreliable. ' : '') +
        (this.truncated || runs.length > this.maxIntervals ? `Timeline/page queue capacity (${this.maxIntervals} intervals, 128 simultaneous names) reached; some labels were omitted.` : ''),
      incomplete: this.incomplete, truncated: this.truncated || runs.length > this.maxIntervals, intervals, speakers: [...new Set(intervals.map((r) => r.name))],
    };
  }
}

// Each segment gets the name with the longest total overlap (ties: first name in the timeline).
// Merge a name's ranges before scoring, so duplicate/overlapping intervals cannot double-count it.
export function labelTranscript(timeline, segments) {
  const byName = new Map();
  for (const r of timeline.intervals ?? []) {
    if (!r.name || !Number.isFinite(r.start_s) || !Number.isFinite(r.end_s) || r.end_s <= r.start_s) continue;
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push([r.start_s, r.end_s]);
  }
  for (const [name, ranges] of byName) {
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) {
      const prev = merged.at(-1);
      if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
      else merged.push([...r]);
    }
    byName.set(name, merged);
  }
  return segments.map((seg) => {
    let speaker = null, best = 0;
    for (const [name, ranges] of byName) {
      const overlap = ranges.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, seg.end_s) - Math.max(a, seg.start_s)), 0);
      if (overlap > best) { speaker = name; best = overlap; }
    }
    return { ...seg, speaker };
  });
}

export const speakerFile = (file) => file.replace(/\.(?:ogg|webm)$/, '.speakers.json');
