# How firmware.html gets its firmware

`firmware.html` (served at `afterglolighting.org/firmware.html`) does **not**
host its own firmware binaries. It reads the same manifest the AFTERGLO app
uses, by way of our own backend:

```
browser → /api/firmware/{manifest,bin}   (functions/src/firmwareProxy.ts)
        → https://raw.githubusercontent.com/gamesum/firmware-update/main/afterglo2_manifest.json
        → the release asset that manifest points at
```

**Why the proxy:** GitHub release-asset downloads redirect to a host that
sends no `Access-Control-Allow-Origin` header, so a browser `fetch()` from
our page is blocked outright ("Failed to fetch"). Server-to-server requests
aren't subject to CORS, so the function fetches it and serves it
same-origin. The function also verifies the asset's sha256 against the
manifest before serving, and the page re-checks it before writing.

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
There is deliberately no Wi-Fi/manual-upload path: current controllers no
longer serve their own HTTP update page, and a browser can't push to a
plain-HTTP LAN address from an HTTPS page anyway (mixed content). USB is
the whole flow.

## Offering more fixture families

`ALLOWED_FAMILIES` in `firmwareProxy.ts` already permits roofline, arch,
and tree. The page only offers roofline — add the other `<option>`s to the
Device Model `<select>` in `firmware.html` when those builds are ready.

## Known gap: recovering a bricked controller

There is no "erase and start over" path. That would need a full image
(bootloader + partition table + app) published somewhere, plus care around
not clobbering `otadata` inconsistently. Nothing here currently publishes
that. If a customer's controller won't boot at all, that's a manual/support
case for now, not something this page can fix.
