# How firmware.html gets its firmware

`firmware.html` (served at `afterglolighting.org/firmware.html`) does **not**
host its own firmware binaries. It live-fetches the same manifest the
AFTERGLO app uses:

```
https://raw.githubusercontent.com/gamesum/firmware-update/main/afterglo2_manifest.json
```

That's a static file (not the GitHub API, to avoid rate limits), listing one
build per fixture family (`tree` / `roofline` / `arch`) with a download URL
and sha256 hash. Binaries live on GitHub Releases in that same repo.
**Publishing a new release to `gamesum/firmware-update` is the only thing
that updates this page** — there is nothing to sync here.

## SHARED CONTRACT — read before changing the manifest shape

This page, `app/lib/data/firmware_update_service.dart` in
`gamesum/Afterglo-Fable`, and `gamesum/firmware-update`'s manifest itself are
one contract across three repos. Both consumers expect:

```json
{
  "version": "1.0.15",
  "images": {
    "<family>": {
      "asset": "afterglo2_<family>.bin",
      "url": "https://github.com/.../releases/download/.../afterglo2_<family>.bin",
      "sha256": "...",
      "size": 763136
    }
  }
}
```

If you rename a field, add/remove a family key, or change the hash
algorithm, both consumers break silently until someone notices. Update the
comments at the top of `firmware.html` and in `firmware_update_service.dart`
together with any schema change.

## What this page does with it

- **Flash from your browser (USB)** — connects over Web Serial (via
  `esptool-js`), downloads the selected family's binary, verifies its
  sha256, and writes it to **both** OTA slots (`0x10000` and `0x190000`,
  per `firmware/partitions_custom.csv` in Afterglo-Fable). Writing both
  slots means it works regardless of which one is currently active,
  without needing to read or write the `otadata` partition — see the code
  comment above `OTA_SLOT_OFFSETS` in `firmware.html` for why. It never
  touches the bootloader, partition table, NVS, or otadata.
- **Update over Wi-Fi** — same fetch-and-verify, but since browsers block
  an HTTPS page from talking to a plain-HTTP address on your LAN (mixed
  content), it hands the visitor a verified file to upload themselves at
  their controller's own `/update` page, rather than pushing it directly.

## Known gap: recovering a bricked controller

There is no "erase and start over" path. That would need a full image
(bootloader + partition table + app) published somewhere, plus care around
not clobbering `otadata` inconsistently. Nothing here currently publishes
that. If a customer's controller won't boot at all, that's a manual/support
case for now, not something this page can fix.
