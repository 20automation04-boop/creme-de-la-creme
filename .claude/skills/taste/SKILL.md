---
name: taste
description: Opens a running web app (e.g. a chatbot UI) in a real browser, looks at it, and gives concrete design-polish feedback aimed at removing the tells that make an interface read as AI-generated (generic gradients, default shadows, cookie-cutter layout) and making it read as deliberately, humanly designed. Use when the user asks to "polish", "review the taste of", "make it look human-made", "stop looking AI-generated", or "check the design" of a web app/chatbot, or explicitly invokes the taste skill.
---

# Taste

Give a running web app an honest design-polish pass by actually looking at it in a browser, not by reading the code alone. The goal isn't generic "nice UI" — it's removing the specific tells that make an interface read as template-generated or AI-scaffolded, and replacing them with the small deliberate choices a human designer would have made.

## When to use this

- The user asks to "polish", "improve the taste of", "make it look nicer", "make it look human-designed", "stop looking like a machine built it", or "review the design" of a web app, chatbot UI, or artifact.
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

3. **Hunt for the specific tells that read as "AI/template built this"** — these are usually the highest-impact fixes, so check for them first:
   - **Purple/blue gradient everything** — gradient hero backgrounds, gradient buttons, gradient text. One deliberate accent beats a gradient slapped on every surface.
   - **Default drop shadows on every card** — the generic `box-shadow: 0 4px 6px rgba(0,0,0,0.1)` on every panel. A human either commits to a real shadow system (soft, direction-consistent) or uses borders/contrast instead.
   - **Everything centered, everything rounded the same amount** — a page of perfectly symmetric, uniformly `border-radius: 12px` cards with no asymmetry or intentional alignment reads as scaffolded, not composed.
   - **An emoji or generic icon glued to every heading/button/list item** ("🚀 Get Started", "✨ Features", "💡 Tip"). Real products use icons sparingly and deliberately.
   - **Bold/heavy font weight used as the default**, not as emphasis — headings, body copy, and labels all fighting for attention because everything is 600-700 weight. Real hierarchy uses weight sparingly against a mostly-regular base.
   - **Generic filler copy** — "Welcome to our platform", "Lorem ipsum"-flavored placeholder text, feature lists of exactly 3 items each with an icon + bold title + one sentence. Real copy has a specific voice and doesn't pad to a template shape.
   - **No restraint in color count** — five-plus accent colors with no clear system, or the exact default palette of whatever UI framework generated it (unmodified shadcn/Tailwind/Bootstrap defaults).
   - **Uniform, mechanical spacing** — every gap is the same one or two values with no rhythm, or conversely everything crammed with no breathing room; a human eye adjusts spacing per-context, not from a single unexamined default.
   - **Missing the "boring but correct" details a human notices**: no favicon, no custom empty/error states (just "No data" or a stack trace), placeholder alt text, a page `<title>` still saying "React App" or similar.

4. **Then judge it against the general taste checklist**:
   - **Hierarchy** — is the most important thing on the screen obviously the most important thing? Does the eye know where to go first?
   - **Spacing & rhythm** — consistent padding/margins, no cramped or lopsided regions, related things grouped and unrelated things separated.
   - **Typography** — a restrained type scale, consistent weights, sane line-length and line-height, no orphaned single words or ambiguous emphasis.
   - **Color** — a small deliberate palette, sufficient contrast (check against WCAG AA at minimum), color used to mean something rather than decorate.
   - **States** — loading, empty, error, and disabled states are designed, not defaulted to a spinner or blank div.
   - **Motion & feedback** — interactive elements have hover/focus/active feedback; transitions (if any) are quick and purposeful, not decorative.
   - **Consistency** — buttons look like buttons everywhere, spacing units repeat, icons share a style, corners share a radius.
   - **Accessibility basics** — visible focus states, alt text, sufficient contrast, tap targets large enough on mobile.

5. **Report specific, actionable findings** — not generic advice. For each issue: what you saw (reference the screenshot/element), why it reads as machine-made or hurts usability, and the concrete fix (exact spacing value, color, copy change, etc.), ranked roughly by impact. Lead with the "AI tell" findings from step 3 before the general polish items — those are usually what makes the difference between "looks fine" and "looks like a person made this."

6. **Offer to apply the fixes.** If the user wants them applied, make the edits, restart/reload the dev server, re-open the browser, and confirm visually that the fix landed before calling it done — do not claim a visual fix worked without re-screenshotting it.

## Notes

- Prefer the project's own dev server over a static file open (`file://`) when one exists — dynamic states (loading, error, interaction) usually only show up when the app is actually running.
- If the app needs auth or seed data to reach interesting states, use test/dev credentials already present in the repo/env rather than inventing new accounts.
- Keep feedback proportional: a handful of high-impact fixes beats a long list of nitpicks.
