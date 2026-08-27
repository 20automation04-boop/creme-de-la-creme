---
name: taste
description: Opens a running web app (e.g. a chatbot UI) in a real browser, looks at it, and gives concrete design-polish feedback — spacing, typography, hierarchy, color, empty/loading/error states, motion, accessibility. Use when the user asks to "polish", "review the taste of", "make it look better", or "check the design" of a web app/chatbot, or explicitly invokes the taste skill.
---

# Taste

Give a running web app an honest design-polish pass by actually looking at it in a browser, not by reading the code alone.

## When to use this

- The user asks to "polish", "improve the taste of", "make it look nicer", or "review the design" of a web app, chatbot UI, or artifact.
- The user explicitly asks for the `taste` skill.

Skip this skill for pure logic/backend work with no visible UI.

## Workflow

1. **Find what to open.**
   - If the user gave a URL, use it.
   - Otherwise look for a running dev server (check recently used ports, `package.json` scripts like `dev`/`start`, or ask the user which port). If nothing is running, start the project's normal dev server yourself (e.g. `npm run dev`) and wait for it to be ready before opening the browser.

2. **Open it in a real browser and look.**
   - Use Playwright (Chromium is pre-installed in this environment at `/opt/pw-browsers/chromium` — do not run `playwright install`; pass `executablePath: '/opt/pw-browsers/chromium'` if the project pins a different Playwright version).
   - Load the page at a normal desktop viewport (e.g. 1280x800), and again at a mobile viewport (e.g. 390x844) if the app is meant to be responsive.
   - Take screenshots of the key states: initial load, mid-interaction (e.g. a chatbot with a message typed and one exchanged), empty state, loading state, and error state where reachable.
   - Actually read the screenshots — don't just confirm the page loaded.

3. **Judge it against a taste checklist**, not vibes alone:
   - **Hierarchy** — is the most important thing on the screen obviously the most important thing? Does the eye know where to go first?
   - **Spacing & rhythm** — consistent padding/margins, no cramped or lopsided regions, related things grouped and unrelated things separated.
   - **Typography** — a restrained type scale, consistent weights, sane line-length and line-height, no orphaned single words or ambiguous emphasis.
   - **Color** — a small deliberate palette, sufficient contrast (check against WCAG AA at minimum), color used to mean something rather than decorate.
   - **States** — loading, empty, error, and disabled states are designed, not defaulted to a spinner or blank div.
   - **Motion & feedback** — interactive elements have hover/focus/active feedback; transitions (if any) are quick and purposeful, not decorative.
   - **Consistency** — buttons look like buttons everywhere, spacing units repeat, icons share a style, corners share a radius.
   - **Accessibility basics** — visible focus states, alt text, sufficient contrast, tap targets large enough on mobile.

4. **Report specific, actionable findings** — not generic advice. For each issue: what you saw (reference the screenshot/element), why it hurts, and the concrete fix (exact spacing value, color, copy change, etc.), ranked roughly by impact.

5. **Offer to apply the fixes.** If the user wants them applied, make the edits, restart/reload the dev server, re-open the browser, and confirm visually that the fix landed before calling it done — do not claim a visual fix worked without re-screenshotting it.

## Notes

- Prefer the project's own dev server over a static file open (`file://`) when one exists — dynamic states (loading, error, interaction) usually only show up when the app is actually running.
- If the app needs auth or seed data to reach interesting states, use test/dev credentials already present in the repo/env rather than inventing new accounts.
- Keep feedback proportional: a handful of high-impact fixes beats a long list of nitpicks.
