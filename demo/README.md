# Dispatch Desk — live demo

A self-contained chatbot demo you can edit in front of a client. One file,
no build step, no API key, no network calls. Open `chatbot.html` in a
browser and it runs.

## The two surfaces

| Surface | Who touches it | Where |
|---|---|---|
| **Live setup panel** | You, mid-pitch | right side of the page |
| **The chat** | The client, on your phone | left side |

Every edit in the panel applies to the conversation immediately and drops a
`SETUP UPDATED` divider into the transcript, so the client *sees* the moment
the bot learned their business.

## What to edit on the spot, in order

Work down the panel. It's numbered in the order that lands best.

1. **Company + agent name** — retype it as their company. The header, the
   avatar initials, and several answers change at once. Ten seconds, and the
   demo is now about them.
2. **The fleet** — this is the strongest beat. Ask "what are your unit
   numbers?", type two of their real ones with their real drivers, then hand
   over the phone and let them ask *"who's on unit 12?"* themselves.
3. **Hours, phone, service area** — quick credibility filler while they think.
4. **Answers you write** — ask "what's the question you're sickest of
   answering?" Type their trigger word and their answer. It works on the next
   message. This is the one that closes.

Then open **What this looks like to us** and say the true thing: on a real
account that file is generated from their dispatch system, not typed by hand.

## Editing the file instead of the panel

Everything the panel edits also lives in a `PITCH_CONFIG` block at the top of
the `<script>` in `chatbot.html`. Change it, save, reload — good for setting
up a client's data *before* a meeting so the demo opens already looking like
theirs. The panel is for changes during the meeting.

`Reset demo` restores `PITCH_CONFIG` and clears the transcript. Hit it between
meetings.

## What the bot answers

- A unit number — `"where is unit 12"`, `"12?"`
- A driver's name — accent- and case-insensitive
- `"show me the board"` — the whole fleet
- Hours, rates, booking, service area, "talk to a human"
- Anything you added under **Answers you write**
- Everything else gets a fallback that lists what it does know

## Why nothing here is risky

- No network calls, no API keys, no backend. It works with the wifi off.
- Answers are keyword matching over your config — it cannot say anything you
  did not write.
- Edits persist per-browser in `localStorage` only. Nothing leaves the device.
- The fleet data is fictional. Replace it with the client's own in the panel.
