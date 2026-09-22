# docs/ — THIS IS THE LIVE SITE. IT IS FIREBASE HOSTING, NOT GITHUB PAGES.

> ## STOP. Read these five lines before you touch anything here.
>
> 1. The site is **https://afterglolighting.org**. A new page at `docs/foo.html`
>    is **https://afterglolighting.org/foo.html**. Never say, link, or imply a
>    `github.io` URL.
> 2. Hosting is **Firebase Hosting**, project `afterglo-website-fbb89`,
>    `"public": "docs"` in `/firebase.json`. **It is NOT GitHub Pages.** The repo
>    is only *named* `gamesum/gamesum.github.io`, for historical reasons.
> 3. **`docs/CNAME` IS A LEFTOVER. IT IS NOT THE HOSTING MECHANISM.** It is the
>    single most common reason this gets gotten wrong: a fresh session sees a
>    CNAME next to a pile of `.html`, concludes "GitHub Pages", and is wrong.
>    If you are inferring hosting from `CNAME`, you have already made the mistake.
> 4. **A git push does NOT deploy anything.** Merging to `main` changes nothing
>    on the live site. Deploying is an explicit `firebase deploy` (below).
> 5. There is a matching note at the top of `/CLAUDE.md`. Both exist because this
>    has been gotten wrong repeatedly. Do not "fix" either by deleting it.

## Deploying

Run from the repo root, logged into the Google account that owns
`afterglo-website-fbb89`:

```bash
firebase deploy --only hosting                  # pages in docs/
firebase deploy --only firestore:rules          # firestore.rules
firebase deploy --only functions                # functions/src/*.ts
```

Deploy **every** part your change touched. A page whose form writes a new field
or a new `source` value will fail with `403 PERMISSION_DENIED` in the browser if
`firestore.rules` was not deployed alongside it — the page looks fine and every
submission silently fails.

## Where things live

- Pages are flat files in this directory. There is no build step for them.
- `js/` holds the shared helpers (`firebase-auth.js`, `collections.js`, …).
- `Resources/` holds photography. Check a file exists before referencing it;
  several names differ only by suffix.
- Lead forms (`contact.html`, `landing.html`, `model-home.html`) write to the
  Firestore collection `contact_submissions`, which `functions/src/contactNotify.ts`
  relays to Zapier. Adding a field or a `source` value means editing
  `firestore.rules`, that function, and deploying both.
- `admin.html` is gated by Firebase Auth plus an `admin: true` custom claim.
  Collections it reads are admin-read-only in `firestore.rules`; a collection
  with no tab in `admin.html` is effectively invisible outside the Firebase
  console.
