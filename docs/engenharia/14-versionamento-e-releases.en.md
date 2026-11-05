---
title: "The release note as a source, not a by-product"
date: 2026-11-05
description: "The app sat on 1.0.0 through five deliveries because nothing forced the bump. The fix was to pick one file as the source of the note and have it produce the package versions, the repository CHANGELOG and a page inside the PWA — with three tests locking the divergence out."
slug: "ondas-versioning-releases"
draft: true
tags:
  - versioning
  - semver
  - process
---

On 2026-11-05, `ondas --about` still read `version 1.0.0`. In the days before that the app had
gained a flag per language in the picker, stopped reloading the page on its own when the version
changed, stopped silencing the music when the browser claims there is no network, and stopped
showing black with no explanation. Five deliveries of visible behaviour, and the number on screen
never moved.

That is not a one-off slip: it is what happens when the version bump has no owner. `package.json` is
born at `1.0.0` and stays there until somebody edits it by hand, and editing it by hand is exactly
the kind of step that does not survive a Friday.

## What I did not want

**A generator reading the `git log`.** `standard-version`, `changesets`, `semantic-release` — they
all derive the bump from commit messages in a conventional format. Commits in this project are
Portuguese sentences describing the effect on the person using the app ("the browser claiming there
is no network can no longer silence the music"), and I like them that way. Adopting `feat:`/`fix:`
prefixes to feed a tool would trade the best part of the history for the convenience of not writing
a note — and a note generated from commits is, in practice, the diff told again. A note worth
reading says what changed *for the person using it*, and nobody extracts that from a log.

**A hand-written `CHANGELOG.md`.** It serves the repository and not the app: nobody using the PWA
opens GitHub to find out what changed. And two hand-written lists diverge — the only question is
which one is forgotten first.

**The note inside the `i18n` catalogues.** Tempting, because the app already keeps three disciplined
languages there. But a catalogue is a table of stable keys, and a release note is a list that grows
with every delivery: I would end up with `changelog.v110.item3` across three files, and a script
outside the bundler could not read any of them.

## The choice: one file, three destinations

The source is `packages/core/src/release/notas.json`. One entry per release, newest at the top, each
item written in all three languages:

```json
{
  "versao": "1.1.0",
  "data": "2026-11-05",
  "itens": [
    { "pt-BR": "a bandeira de cada idioma…", "en": "each language's flag…", "es": "la bandera…" }
  ]
}
```

Three things come out of it, and none of them is written by hand:

1. **The version in all three `package.json` files** (root, `core`, `web`). That is where Vite builds
   the `__APP_VERSION__` shown by `ondas --about` and by the login screen.
2. **The root `CHANGELOG.md`**, for whoever reads the repository.
3. **The PWA's `/changelog` page**, which imports `RELEASES` from `core` and draws the note in the
   reader's language.

The third destination is what justifies the format. The page is part of the app: it enters the
Service Worker precache, works offline, and the version actually running is flagged `[running]` —
the comparison is against the bundle's `__APP_VERSION__`, not the top of the list, because in a PWA
left open across a deploy it is the old bundle on screen, and flagging the new version as running
would be a lie.

### Why JSON, in a project that is TypeScript throughout

Because the file has two readers in different worlds: the bundle, which imports it with types
(`resolveJsonModule` was already on), and `scripts/release.mjs`, which is plain Node. A `.ts` would
force that script to load a compiler — or to rely on `--experimental-strip-types` in one specific
Node version — to do something that has to work precisely on the day the install is broken. The
script has no dependencies at all, and that is deliberate: a release script that needs
`pnpm install` to run is a script that does not run when you need it most.

The price of JSON is having no comments. The format is documented in `release/index.ts` next to it,
which is also what types it.

## What locks the divergence out

A ritual that depends on memory is not a ritual, it is an intention. Three tests in
`release.test.ts` close the gap:

- all three `package.json` files are on the version at the top of the note;
- `CHANGELOG.md` has that version's entry;
- no Portuguese item is missing from it.

They run in the domain suite, the fastest one and the one nobody skips. On top of that,
`pnpm release --check` writes nothing and exits 1 when any destination is out of sync — it is the
step CI runs next to `typecheck`, so a bump without a note (or a note without a bump) fails the
build before it becomes an image.

The other half of the discipline is end-to-end: the smoke test opens `ondas --about`, clicks
`[notas da versão]` and compares what the screen writes with what is in `notas.json`. The expected
version comes from the package's `package.json`, not from a `'1.1.0'` pinned in the test — pinning
it would break the test on the next delivery, which is exactly when it needs to keep holding.

## What SemVer means here

An app has no public API, so the three numbers need a reading of their own. The one I adopted:

- **patch** — a behaviour fix nobody asked to change;
- **minor** — a new feature, or a visible behaviour change that was asked for;
- **major** — breaking what crosses versions: the shape of what is stored in IndexedDB, the contract
  with the API, the address of something already shared.

The third is the one that matters in an app that persists data on someone's device. A catalogue
cached yesterday in a format today's code no longer understands has already taken this PWA down once
(the story is in document 05), and that is why "breaking" here is measured in disk and in links, not
in function signatures.

## In an interview

**"Why not `semantic-release`?"** Because it buys the automatic bump at the price of turning the
commit message into machine input. In this project the message is prose about the effect on the
person using the app, and the release note is written for that same person — in three languages.
What I automated is the *propagation* (version in the packages, CHANGELOG, page), which is where
human error happens, not the *writing*, which is where it does not.

**"What is the risk of shipping the note inside the bundle?"** Weight: the list grows forever, and an
app embedding five years of notes carries text almost nobody reads. Today there are two entries and
the cost is irrelevant; once it passes a few dozen, the page fetches the older ones from the API and
the bundle keeps only the recent ones. That is a trade to make when the number justifies it, not
before.

**"Why does the version live in three `package.json` files?"** Because the monorepo has three
packages and Vite reads the `web` one to build `__APP_VERSION__`. Keeping them equal is simpler than
explaining why they differ: nothing here is published to a registry, so independent versions per
package would be ceremony with no gain. The script writes all three and the test checks all three.
