# AFTERGLO Brand Kit

Canonical brand reference shared by the AFTERGLO website (this repo) and the
AFTERGLO Suite desktop app (`C:/Users/18018/Desktop/AFTERGLO-Suite-Standalone/`).
If you change a value here, change it in both places.

## Wordmark

- Literal: `AFTERGLO`
- Casing: ALL CAPS
- Weight: semibold (CSS 600 on web; `wxFONTWEIGHT_SEMIBOLD` equivalent in app,
  currently rendered at bold in the app header pending font availability)
- Tracking: +0.06em on web (maps to roughly +2px at 18pt in the app)
- Family (web): `Outfit`, sans-serif
- Family (app): system default sans, semibold

The wordmark is commonly split as `AFTER` + `GLO` where the `GLO` portion
takes the primary gold colour. When the wordmark is used on a painted
accent surface (e.g. a gold button or gold pill) it is rendered solid in
surface dark.

The product name is `AFTERGLO Suite`. The company name is `AFTERGLO Lighting`.

## Tagline

- Primary tagline: `Holiday light shows, effortless.`
- One short line. No em dashes. Period at end.

## Colour

| Role           | Hex       | Notes                                           |
| -------------- | --------- | ----------------------------------------------- |
| Primary gold   | `#D4A43A` | Retuned from the old `#C8921E` tobacco brown.   |
| Bright gold    | `#F0C04A` | Only for small accent text under 14pt.          |
| Surface        | `#0F0F11` | Default page/app background.                    |
| Text primary   | `#F2F2F4` | Headings and body.                              |
| Text muted     | `#9A9AA2` | Supporting copy.                                |

The old `#C8921E` is deprecated and must be retuned to `#D4A43A` on sight.
Gradient stops that previously paired `#C8921E` with `#D4A843` can keep the
second stop and simply update the first to `#D4A43A`.

## Typography

- Display / headings: `Outfit` weights 700, 800, 900 (web)
- Body / UI: `Inter` weights 300, 400, 500, 600 (web)
- Do NOT change the font stacks without coordinating with the typography
  agent. This file records them for reference only.

## Iconography

- Website: inline SVG strokes on `--accent` (primary gold).
- App: `AGIcons` vector set keyed by `AGIcons::Icon` enum, drawn via
  `wxGraphicsContext`. The wordmark icon enumerates as `AGIcons::Icon::Wordmark`.

## Application metadata

- ProductName: `AFTERGLO Suite`
- CompanyName: `AFTERGLO Lighting`
- Copyright: `Copyright (C) 2026 AFTERGLO Lighting`
- Feedback email: `feedback@afterglolighting.org`

## Outstanding Assets

These are inconsistencies discovered during the audit that should be
resolved before the next release. None were guessed; items are flagged
rather than edited.

1. App icon mismatch. The app installer ships only `installer/agshow.ico`.
   The website hosts `afterglo-logo-flat.png`, `afterglo-logo-flat.svg`,
   `afterglo-logo-transparent.png`, and `afterglo-logo.png` as competing
   marks. Decide on a single source of truth SVG and regenerate the ICO
   plus a macOS ICNS from it.
2. No favicon is declared on any website HTML page. `index.html`,
   `platform.html`, `firmware.html`, `signin.html`, etc. all lack a
   `<link rel="icon">`. Add one pointing at a shared mark once item 1 is
   resolved.
3. `og:image` across the site points at
   `https://gamesum.github.io/afterglo-logo-flat.png` (the prior GitHub
   Pages host) rather than an `afterglolighting.org` URL. Rehost to the
   production domain.
4. The `Resources/` folder contains a legacy banner `AFTERGLOBANNER.png`
   and a misspelled `AFTERGLOLIGHITNGCOMTNS.png`. Neither is referenced
   by the live pages. Archive or delete.
5. The app has no dedicated `AGAboutDialog.cpp`; the About box is built
   inline in `AGMainFrame.cpp` via `wxAboutBox` (see `ShowAboutDialog`
   around line 1870). The tagline there should be aligned to
   `Holiday light shows, effortless.` in a follow-up if the description
   copy is ever edited.
6. `afterglo-logo-flat.svg` still embeds `fill="#c8921e"` inside the
   static SVG. Because it is a frozen export, it was not auto-retuned
   with the CSS. Regenerate from source when the logo is next revisited.
7. The app does not yet declare a `VS_VERSION_INFO` block in
   `AFTERGLO.rc`; product metadata is therefore only visible at runtime.
   Add a version resource so Windows Explorer shows the correct product
   and company strings.
