# Afterglo — Project Context

## What this is
Marketing + product website for Afterglo permanent holiday lighting business.
Live at: https://gamesum.github.io

## Key files
- `index.html` — main marketing site (hero, lightshow, testimonials, FAQ, contact)
- `circuit-board.html` — PCB reference page with live gerber viewer + callout labels
- `gerbers/` — manufacturing gerber files (newest export: Mar 28 2026, from GERBER/afterglo-controller-B_Cu.zip)
- `arches.html` — arch lighting demo page
- `yardsign-*.html` — printable yard sign files

## Brand / Style
- Fonts: Outfit (headings, 700–900) · Inter (body) · JetBrains Mono (code/specs)
- Colors: bg `#070707` · accent amber `#c8921e` · text `#dde4ee` · muted `#607080`
- Dark industrial aesthetic, no emojis, terse copy

## circuit-board.html specifics
- Gerber viewer: `pcb-stackup@4.2.8` from jsdelivr CDN
- Gerbers fetched from `./gerbers/` — requires HTTP server (won't work from file://)
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
