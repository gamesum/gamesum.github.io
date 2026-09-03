# Publishing a firmware build

`firmware.html` (served at `afterglolighting.org/firmware.html`) is a
browser-based flasher built on [ESP Web Tools](https://esphome.github.io/esp-web-tools/)
v10, wired up and ready — it just doesn't have a real build to install yet.

## To publish a build

1. Compile firmware for the AFTERGLO Controller (ESP32-S3).
2. Drop these four files into `esp32s3/` next to this README:

   | File | Flash offset |
   |---|---|
   | `bootloader.bin` | `0x0` |
   | `partitions.bin` | `0x8000` (32768) |
   | `boot_app0.bin` | `0xe000` (57344) |
   | `firmware.bin` | `0x10000` (65536) |

   These offsets are already set in `manifest.json` — don't change them
   unless the partition table changes. **Do not copy an ESP32 (non-S3)
   bootloader offset here** — ESP32 classic uses `0x1000`, not `0x0`. Mixing
   these up bricks the board until a full erase.

3. Update `manifest.json`'s `"version"` field to the real firmware version.
4. In `../firmware.html`, find the line:

   ```js
   const FIRMWARE_PUBLISHED = false;
   ```

   and flip it to `true`. This removes the "not published yet" banner and
   enables the install button.
5. Deploy (`firebase deploy --only hosting` from the repo root).

## Firmware prerequisites

- **Improv Serial**, so the page can read the currently-installed version
  off the device: add `-D WLED_ENABLE_IMPROV` (or the equivalent for
  whatever firmware base this ships) to `platformio.ini`'s `build_flags`.
  `"improv": true` is already set in `manifest.json`.
- **HTTPS only** — Web Serial refuses to run on a plain HTTP page. This is
  already satisfied since the whole site is served over HTTPS.

## Recommended before a wide rollout

- **Self-host the ESP Web Tools script.** `firmware.html` currently loads
  `install-button.js` from `unpkg.com`. That's a third-party dependency
  sitting in the recovery path for a customer with a dead controller.
  Download the `esp-web-tools` package and its chunk files, drop them under
  this `firmware/` folder, and change the `<script type="module" src="...">`
  in `firmware.html` to point at the local copy.
- **Test "Erase and factory reset"** (the option inside the install
  dialog) on a deliberately bricked unit before telling customers about it.
- **Test in Chrome and Edge, Windows and macOS**, and confirm mobile
  browsers correctly show the "unsupported" message rather than a broken
  button.
- If you later need multiple firmware versions selectable in the UI (not
  just "latest"), that requires a custom flasher built on `esptool-js`
  directly — `esp-web-install-button` only installs whatever one build its
  manifest points to.
