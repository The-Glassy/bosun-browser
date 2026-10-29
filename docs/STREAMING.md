# Speculative channel speech (0.18.0)

The agent writes its answer as a `channel_publish` tool call. Without streaming, Bosun gets the text only when the
call has been generated in full and the host publishes it. With speculative streaming, the host forwards the
`content` argument while the model is still writing it, and Bosun speaks each sentence as soon as it is complete.

This document is the contract between Bosun and the host. The host side is the agent-framework fork
(`The-Glassy/agent-framework`, branch `speculative-voice-chunks`). Both sides implement exactly this.

It extends MCPL §14.3 (`channels/outgoing/chunk`, `channels/outgoing/complete`). Plain §14.3 chunks are moderated and
advisory, and the spec says the host "never streams speculatively". The opt-in below is the exception, for one
channel that asks for it.

## Opt-in

Bosun declares it on the meeting channel's descriptor in `channels/register`, only when the tenant's speech setting
`speculative_speech` is true (or `meeting_join` set it for that meeting):

```jsonc
{
  "id": "bosun:meeting:m0123456789ab",
  "type": "bosun.meeting",
  "direction": "bidirectional",
  "capabilities": { "streaming": { "speculative": true } },
  "metadata": { "meeting_id": "m0123456789ab", "platform": "meet", "url": "…", "streaming": { "speculative": true } }
}
```

`capabilities.streaming.speculative` is the declaration. The same object is in `metadata.streaming`, for hosts that
keep only a descriptor's metadata. A host may check either one.

The setting is read when the channel opens. Changing it during a meeting has no effect on the descriptor. While the
setting is off, Bosun ignores speculative chunks.

The connection also needs what plain streaming needs. Bosun's server capabilities declare `channels.streaming: true`
(always), and the host's grant must include `channels.streaming` (for example `channels.*`).

## Host → Bosun

While the model generates a `channel_publish` call whose channel is such a channel:

```jsonc
// notification channels/outgoing/chunk
{ "channelId": "bosun:meeting:m0123456789ab", "streamId": "toolu_01…", "seq": 0, "content": "Sure, the bud", "speculative": true }
```

- `streamId`: one id per tool call (the tool-use id is a good one).
- `seq`: 0, 1, 2, … per stream.
- `content`: the new text since the last chunk (a delta of the decoded `content` argument, not JSON).

The stream ends with exactly one `channels/outgoing/complete`:

```jsonc
// the publish succeeded
{ "channelId": "…", "streamId": "toolu_01…", "content": "<full final text>", "speculative": true }
// the call was aborted, failed, or was not executed
{ "channelId": "…", "streamId": "toolu_01…", "content": "", "cancelled": true, "speculative": true }
```

When the host can, it passes the same `streamId` on the `channels/publish` it makes for the call (as a param
`streamId`, or `metadata.streamId`).

## What Bosun does

- **Chunks.** Bosun puts chunks in `seq` order. A chunk that comes early waits for the missing one, and a repeated
  `seq` is ignored. Bosun cuts the text into sentences: a sentence ends at `. ! ? …` followed by whitespace, or at a
  line break. Each sentence is synthesized and spoken at once, in the same queue, voice and utterance as published
  text. A sentence still open after 400 characters is spoken as far as it goes.
- **`cancelled`.** What of the stream is playing or being synthesized stops at once, and the microphone is muted
  again. Sentences still waiting are dropped, and later chunks of the stream are ignored.
- **`complete` with text.** Bosun compares the sentences it spoke with the final text (case, punctuation and spacing
  aside).
  - A sentence that differs and has not been taken up for synthesis yet is dropped silently.
  - If one has been taken up (or is playing), the utterance is stopped.
  - Then the final text from the first differing sentence on is spoken.
  - Text the stream never completed (the last sentence without a terminator) is spoken here too.
- **The publish.** It counts as the same text when its `streamId` matches, or, without one, when it has the same
  normalized text as a stream completed in the last 10 s or starts with what an open stream has sent so far. A
  matched publish is never spoken twice:
  - Publish before `complete` (connectome's usual order): the publish settles the stream as `complete` would. A later
    `complete` with the same text, or a `cancelled` one, changes nothing.
  - `complete` before the publish: the publish is not spoken.
  - A publish that matches no stream is spoken as always.
- **Barge-in.** The same rules apply as for any speech. Someone speaking over Bosun stops it, and the stream's later
  chunks are ignored. Its publish is not spoken (`spoken: "interrupted"`), and the channel gets the usual
  `bosun:meeting-interrupted` message. `meeting_stop_speaking` and an opt-out stop a stream the same way.
- **A reopened turn.** When the stream's turn was reopened (`bosun:meeting-turn-extended`) and `superseded_publish` is
  `"drop"`, its sentences are not spoken. The publish is then dropped as before.
- **A draft.** When Bosun already said the drafted sentence for this turn (`meeting_draft`), a stream whose first
  sentence is that sentence skips it.

## The publish receipt

A publish matched to a stream answers `delivered: true` with the usual fields and:

| field | value |
|---|---|
| `speculative` | `true` |
| `stream_id` | the stream's id |
| `spoken` | `"settled"`: the stream was still open, and this text settled it. `"already_spoken"`: `complete` came first with this text. `"interrupted"`: a barge-in or `meeting_stop_speaking` stopped it, and the rest is not said. |
| `said_after_stream` | with `"settled"`: characters said after what the stream had spoken (its open last sentence, or a corrected part) |
| `draft_prefix_skipped` | `true` when the stream's first sentence was the drafted one, already said |

connectome-host 0.19 keeps only `delivered` and `messageId` of a receipt. The other fields are there for hosts that
read them.

## Not covered

- Only the meeting channel takes speculative chunks. Everything else is MCPL §14.3 as before.
- Chunks without `speculative: true` keep their §14.3 meaning: with `channel_prepare_chunks` their sentences are only
  synthesized ahead, and only a publish is spoken.
- A long first sentence is not cut at a comma, as a publish's first piece is. Its audio starts at its end.
