---
name: lighthouse
description: Runs a real Google Lighthouse audit against a running web app or site and turns the raw report into a prioritized, client-readable punch list — performance, accessibility, best practices, and SEO. Use when the user asks to "audit", "run lighthouse", "check performance/SEO/accessibility scores", or "score" a site or web app, or explicitly invokes the lighthouse skill.
---

# Lighthouse

Run an honest Lighthouse audit against a real, running page — not a guess from reading the code — and turn the JSON report into a short list of fixes a client would actually act on, ranked by impact on their score and their users.

## When to use this

- The user asks to "audit", "run lighthouse", "check the score", "check performance/SEO/accessibility", or "grade" a site, landing page, or web app.
- The user explicitly asks for the `lighthouse` skill.
- Before a client pitch or handoff, to confirm a demo page doesn't embarrass itself on a phone with a slow connection.

Skip this skill for pure backend/API work with no page to load, and skip it for pixel-level design opinions — that's what the `taste` skill is for. The two pair well back to back: `lighthouse` for what's measurable, `taste` for what isn't.

## Workflow

1. **Find the target.**
   - If the user gave a URL, use it directly.
   - Otherwise find a running dev server (check recently used ports, `package.json` scripts like `dev`/`start`/`preview`, or ask which port). If nothing is running, start the project's normal dev/build+preview server yourself and wait for it to be ready — Lighthouse needs a real HTTP URL, not `file://`.
   - Prefer a production build (`npm run build && npm run preview`/equivalent) over a dev server when one is available — dev-mode bundles (unminified, no compression, HMR overhead) tank performance scores in ways that mislead the client about what will actually ship.

2. **Run the audit.**
   - `npx lighthouse <url> --output=json --output=html --output-path=<scratchpad>/lighthouse-report --chrome-flags="--headless --no-sandbox" --preset=<desktop|perf>` — omit `--preset` for the default mobile-simulated run unless the user asks specifically about desktop.
   - Point `--chrome-path` (or `CHROME_PATH`) at the pre-installed Chromium (`/opt/pw-browsers/chromium`) rather than letting Lighthouse fetch its own.
   - Run it twice if the first performance score looks suspicious (cold caches, a noisy container) and take the more representative run rather than averaging blind.
   - For a page that requires login or app state, drive it into that state first with Playwright, then hand Lighthouse the resulting URL, or use Lighthouse's user-flow / Puppeteer API instead of the plain CLI if the interesting state isn't reachable by URL alone.

3. **Read the JSON, don't just quote the four scores.** Scores alone ("Performance: 62") are not actionable. For each category below 90, open `audits` and find which specific checks failed or scored partially, e.g.:
   - **Performance** — LCP/CLS/TBT element culprits (`largest-contentful-paint-element`, `layout-shift-elements`), unoptimized images (`uses-optimized-images`, `uses-responsive-images`, `modern-image-formats`), render-blocking resources, unused JS/CSS, missing text compression, oversized DOM.
   - **Accessibility** — specific failing audits (`color-contrast`, `image-alt`, `label`, `link-name`, `aria-*`), each with the actual failing elements Lighthouse names, not a generic "improve accessibility."
   - **Best Practices** — console errors, missing HTTPS/HSTS, deprecated APIs, missing charset, vulnerable/outdated libraries.
   - **SEO** — missing/duplicate meta description, missing viewport tag, non-descriptive link text, `robots.txt` issues, missing structured data where relevant.

4. **Rank by real impact, not by which category it's filed under.** A failing LCP image and a missing `alt` on the hero are both worth fixing before a client sees the report; five near-identical "unused CSS rule" warnings across vendor bundles usually aren't worth a client's time. Call out anything that's a trivial one-line fix (add `width`/`height` to an `<img>`, add a `viewport` meta tag) separately from anything structural (switch image pipeline, code-split a bundle) since they have very different costs.

5. **Report scores plus the punch list**, in this shape:
   - The four category scores, with the run's device/throttling profile stated (e.g. "mobile, simulated 4G — Lighthouse's default").
   - Top fixes ranked by impact, each naming the specific audit, the concrete element/resource, and the concrete fix (not "optimize images" — "compress `hero.jpg` (2.4MB) to WebP, expected LCP saving ~1.1s").
   - Note anything Lighthouse can't see and a human should still check (whether the audited state was logged-in/empty/error, whether third-party scripts were blocked).

6. **Offer to apply the fixes.** If the user wants them applied, make the edits, rebuild if needed, re-run the audit, and report the before/after scores and specific audits that flipped — don't claim a score improved without re-running.

## Notes

- A single run's performance score is noisy, especially in a shared/containerized environment — say so rather than presenting one run as gospel, and prefer the median of a few runs when the number itself matters (e.g. reporting a score to a client).
- Keep the punch list proportional: a handful of fixes that move the needle beats a full reprint of every audit in the JSON.
- If Lighthouse can't reach the URL (server not up, wrong port, auth wall), fix that first rather than reporting a failed run as a score of zero.
