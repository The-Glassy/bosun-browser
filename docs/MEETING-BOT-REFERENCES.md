# Meeting bots: what other open-source bots do

Written for 0.10.1. On 2026-10-23 both meeting platforms failed in production on lobbies that had changed. Before
fixing them we read how three mature open-source bots join the same web UIs. Each was shallow-cloned and read at the
commit named below.

| Project | Commit | License | What we took |
|---|---|---|---|
| [Vexa](https://github.com/Vexa-ai/vexa) | `f1a62fb` | Apache-2.0 | ideas and UI facts (label texts, selectors) |
| [ScreenApp meeting-bot](https://github.com/screenappai/meeting-bot) | `1447ed3` | MIT | ideas and UI facts |
| [Attendee](https://github.com/attendee-labs/attendee) | `94976b9` | Elastic License 2.0 | UI facts only: label texts a person sees |

No code was copied from any of them, so `NOTICE` is unchanged. Attendee's license is source-available, not open
source: from it we only noted which texts Meet shows.

## What failed

- **Meet.**
  - The lobby's join button is now called **"Ask to join without microphone & camera"** for screen readers, while it
    still reads "Ask to join". Bosun matched the name exactly (`^ask to join$`) and found no button.
  - The name changes with the devices. It is plain "Ask to join" while the microphone or camera is on, and gains the
    suffix once Bosun has switched both off. So the second attempt found a button, switched the devices off, and then
    lost the button.
  - `meet.google.com/<code>` now redirects to `meet.google.com/meet/<code>`.
  - Meet loads reCAPTCHA in its invisible mode. Its badge frame made `navigate` report a captcha.
- **Zoom web client.**
  - "This site is protected by reCAPTCHA" comes with the same invisible widget, and it was taken for a challenge.
  - The preview first asks "Do you want people to see you in the meeting?".
  - The name field is empty even for a signed-in account, and Join stays disabled until a name is typed.
  - The production profile was in fact signed out.

## What the three bots do

- **Meet join button.** All three match the button's *visible text* ("Ask to join", "Join now", "Join anyway", "Ask
  to join anyway", "Join the call now", "Join here too"), never its accessible name. None of them handles the
  `/meet/` path.
- **Captcha.**
  - Vexa counts a reCAPTCHA frame only if it is visible and large enough. Its notes say Meet loads an invisible
    reCAPTCHA on every normal join.
  - Vexa never fails a Zoom join on a captcha alone. It waits for Join to become enabled, and fails only on bot-wall
    texts ("We detected you may be a bot", "Automated bots aren't allowed").
  - None of the three tells reCAPTCHA's invisible badge apart by its `size=invisible` source, which is what Bosun
    does now.
- **Zoom preview.**
  - Vexa answers the device question with "Allow" ("Use microphone and camera"). It notes that without device
    permission Zoom may not create the participants' audio elements, so a recorder could hear nothing.
  - Vexa types the name key by key: `fill()` did not satisfy Zoom's validation, and Join stayed disabled.
  - Join is sometimes disabled only by a `disabled` CSS class.
  - Guests are sometimes sent to the classic client (`/wc/join/<id>`), with `#inputname` and `#joinBtn`.
  - An expired link shows "This meeting link is invalid (3,001)". Vexa reads that as "not started yet" and reloads
    for a while.
- **Meet outcomes.**
  - "No one responded to your request to join the call", with "Ask to join again", is a denial by timeout.
  - "Check your meeting code", "Invalid video call name" and "Your meeting code has expired" mean a bad link.
  - Once admitted, Meet may show a modal: "This video call is being recorded / transcribed", or "Gemini is taking
    notes".

## What 0.10.1 adopted

1. **Meet join button.** It is found by its accessible name, and the "… without microphone & camera" suffix is
   allowed in all five languages. If the name does not match, the visible text alone finds it. "Join anyway", "Ask to
   join anyway" and "Join the call now" are new labels.
2. **`/meet/<code>`** links are Meet links.
3. **One captcha rule for `navigate`, Meet and Zoom.** A challenge frame counts only when all of these hold:
   - it is rendered and not hidden by visibility or opacity;
   - it is on screen and at least 60×60 px;
   - it is not reCAPTCHA's `size=invisible` badge. A "protected by reCAPTCHA" page is not a challenge.
4. **Zoom device question.** It is answered with "Continue without microphone and camera" wherever it appears, as
   was asked for this fix. Vexa's warning about missing audio elements was not reproduced here. If computer audio
   cannot be joined afterwards, the meeting fails loudly ("could not join computer audio"); it does not record
   silence. A live Zoom meeting has to confirm it.
5. **Zoom name and Join.**
   - An empty name field is filled.
   - If Join stays disabled after that, the name is typed key by key.
   - A `disabled` class counts as disabled.
   - `#inputname` (the classic client) is a name field too.
6. **Zoom signed-in check.**
   - Bosun asks `zoom.us/profile` with the browser's own cookies. A redirect to sign-in means signed out.
   - A signed-out profile joins as a guest, and the meeting carries a `warning` that says how to sign it in again.
   - A signed-in profile counts as the account even when the name field is empty.
7. **Zoom "This meeting link is invalid (3,001)"** is an invalid meeting. It is not retried: an expired link does
   not come back.
8. **Meet texts.**
   - "No one responded to your request" and "Ask to join again" count as denied.
   - The bad-link texts count as an invalid meeting.
9. **`meeting_join { dry_run: true }`.** It loads the lobby exactly as a join would, then reports:
   - what Bosun sees: the lobby kind, the button it would click, microphone and camera, and whether a challenge is
     shown;
   - for Zoom also whether the profile is signed in.

   Nothing is joined. This is how the fix was checked on production.

## What was not adopted, and why

- **Real OS-level input.** Vexa and Attendee can drive X11 mouse and keyboard because Meet detects synthetic input.
  Not needed for these failures.
- **Answering the post-admission modals.** "Being recorded", "Gemini is taking notes": their OK button is labelled
  "Join now" in places, and clicking it in the call needs a policy decision (consent). Left for later.
- **Renaming "notetaker" display names.** meeting-bot avoids names with "bot" or "notetaker", likely because Meet
  refuses them. Bosun keeps an honest name; the consent announcement depends on it.
- **Reloading Zoom's 3,001 page.** That page means the link is gone, not that the meeting has not started yet.
