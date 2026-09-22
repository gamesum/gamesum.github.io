# Afterglo — Project Context

> ## READ THIS BEFORE ANSWERING ANYTHING ABOUT "THE WEBSITE"
>
> **The site is https://afterglolighting.org.** This repo is it.
>
> - The repo is named `gamesum/gamesum.github.io` for historical reasons only.
>   **That is not the site.** Never call the site "gamesum.github.io", never link
>   to a `github.io` URL, and never assume GitHub Pages.
> - It is **Firebase Hosting**, project `afterglo-website-fbb89`. Public dir is
>   **`docs/`** (see `firebase.json`). `docs/CNAME` is a leftover, not the mechanism.
> - Deploy with `firebase deploy` (hosting / functions / firestore as needed) —
>   **not** by pushing to `main`.
> - The site's pages live in **`docs/`**, not the repo root. There is no
>   `index.html` at the root.
> - The website is **not** in `Desktop/VSCODE/afterglo` (that's the Flutter app +
>   firmware) and **not** in `wled-ridgeline` (legacy ESP32 firmware).
>
> This has been gotten wrong repeatedly. `git pull` before reading — a stale
> working copy is the usual cause.
>
> There is a second copy of this warning in **`docs/CLAUDE.md`**, because the
> usual failure is a session that opens `docs/` without ever reading this file,
> sees the leftover `docs/CNAME` sitting next to the pages, and concludes
> "GitHub Pages". Deleting either copy re-opens that hole.

## What this is
Marketing + product website for Afterglo permanent holiday lighting business.
Live at: https://afterglolighting.org
Firebase Hosting + Cloud Functions (Stripe checkout, firmware manifest, sequence
API) + Firestore + Storage, all under project `afterglo-website-fbb89`.

## Key files
- `firebase.json` / `.firebaserc` — hosting config, API rewrites, CSP headers.
- `docs/` — **everything served**. `docs/index.html` is the main marketing site;
  also `about.html`, `contact.html`, `gallery.html`, `pricing`-style landing
  pages, `account.html` / `admin.html` / `creator-dashboard.html`, `platform.html`,
  `firmware.html`, legal pages (`privacy.html`, `dmca.html`, …).
- `docs/circuit-board.html` — PCB reference page with live gerber viewer + callout labels
- `docs/gerbers/` — manufacturing gerber files (newest export: Mar 28 2026, from GERBER/afterglo-controller-B_Cu.zip)
- `docs/arches.html` — arch lighting demo page
- `functions/` — Cloud Functions source (TypeScript, built on predeploy).
- `firestore.rules`, `firestore.indexes.json`, `storage.rules`
- `yardsign-*.html`, `logo-*.html`, `cover-photo.html` — printable/asset pages

## Brand / Style
- Fonts: Outfit (headings, 700–900) · Inter (body) · JetBrains Mono (code/specs)
- Colors: bg `#0F0F11` · accent gold `#D4A43A` (bright-gold sub-14pt `#F0C04A`) · text `#F2F2F4` · muted `#9A9AA2`
- Canonical brand kit lives in `BRAND.md` at repo root. Keep parity with `AFTERGLO-Suite-Standalone`.
- Dark industrial aesthetic, no emojis, terse copy

## docs/circuit-board.html specifics
- Gerber viewer: `pcb-stackup@4.2.8` from jsdelivr CDN
- Gerbers fetched from `./gerbers/` (i.e. `docs/gerbers/`) — requires HTTP server (won't work from file://)
- 11 floating callout labels with dashed amber lines drawn in SVG overlay
- Callout positions are % of pcb-view dimensions, set in `data-tx` / `data-ty` attributes
- Board: AFTERGLO Controller v1, 180×120mm, 2-layer, ESP32-S3, 4-ch LED, 24V in, 30A max
- Ethernet via LAN8720A (RMII — IO17/19/21/22/25/26/27 hardwired, cannot reassign)
- RS485 (U8) on IO16/32/33 — supports DMX512, up to 32 receivers, 1200m runs
- 4x IRF4905 P-MOSFET high-side switches (Q2–Q5), 7.5A per channel
- USB-C (J4) + CP2102N (U7) for programming

## Controller board source files
`C:\Users\18018\Desktop\RIDGELINE\Controller\Circuit\controller_circuit\`
- KiCad 9 project, 4-sheet hierarchical schematic
- Newest gerbers: `GERBER/afterglo-controller-B_Cu.zip` (Mar 28 2026)
