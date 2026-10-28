# Decisions

Decisions made without asking (Misha: "use your judgment and decide yourself"), with the reason. Newest first.

## 0.17.1 (2026-10-28): turns, barge-in, stale answers

- **The defaults are 900 ms and 300 ms, from the brief.** Scribe ends a segment after 0.5 s of silence and its final
  arrives about 0.35 s later. Someone who goes on after a pause shows a partial within a few hundred ms of speaking
  again, so 900 ms covers a breath pause of up to about 1.4 s. A question or a finished sentence is the common turn
  end and gets 300 ms. Measured locally: 302 / 900 / 304 ms added (question / fragment / sentence).
- **A full stop alone doesn't make a sentence complete.** Scribe punctuates every final. A final ending in a
  conjunction or article (EN/UK/RU/DE/SK) or in "…" is held the full 900 ms.
- **The hold applies to events too, not only the channel.** An agent without the channel answers
  `bosun:meeting-transcript` finals just the same.
- **Barge-in only while audio plays, not while a reply is still being synthesized.** Item 3 says a publish that
  arrives after new speech is still said. Cancelling it before it starts would contradict that. If the person goes on
  talking, the barge-in stops it within a partial or two.
- **Barge-in threshold: 2 words, agreement words excluded,** or 1 word plus 0.6 s shown speaking on the page. "Mhm" or
  "yeah" while Glassy talks is no interruption; "wait, stop" is.
- **Echo: a text check first, the speaker label second.** Labels can't tell acoustic echo (the participant's tile
  lights up) from a person, so the 60 %-of-Bosun's-words check decides. Where labels work, someone other than Bosun
  must also be shown speaking. Labels count as working when one was named in the last 2 minutes, so a page whose
  labels broke falls back to the text check.
- **Echo finals are still delivered, marked `echo_suspected`.** The brief doesn't ask to drop them, and a person
  repeating Bosun's words must not vanish.
- **superseded_by_new_speech is always in the publish acknowledgement (true/false), with `last_turn_seq`.** A
  publish carries no reference to what it answers. The seq lets the agent detect the case Bosun can't: turn K+1
  already delivered when the answer to turn K arrives.
- **The interruption message is a `channels/incoming` from author `bosun`, tagged `bosun:meeting-interrupted`.** A wake
  policy can filter it, and it arrives before the interrupter's (held) turn.
- **Addendum, still thinking: the default is "drop", as asked.** A dropped publish answers `delivered: false` (no
  `messageId`). connectome-host then reports a failed publish, which is honest: nothing was said. `delivered: true`
  would make the host stream the text as said.
- **A turn counts as answered once a publish for it is said, or `meeting_speak` is called.** After that the
  speaker's next words are a new turn (barge-in handles an answer still playing). An acknowledgement is not an
  answer.
- **`turn_extend_s` = 20 s.** Glassy's thinking time before her first publish is several seconds. Beyond 20 s
  without an answer, more speech is more likely a new thought. It is tunable, and 0 turns reopening off.
- **An acknowledgement that already played for the first part is not repeated** for the merged turn within the
  cooldown. One still waiting is cancelled, and its cooldown released.
- **The extra receipt fields stay,** although connectome-host drops them today. Hosts that read receipts get them,
  and the channel messages carry the same information for Glassy.
- **No fourth Codex round for the addendum:** the brief caps Codex at 3 rounds. The addendum diff was reviewed by
  hand. That review found a turn reopened with nothing new that stayed marked reopened, and a deleted transcript's
  turn that could be reopened. Both are fixed.
