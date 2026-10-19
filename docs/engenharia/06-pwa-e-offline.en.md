---
title: "Three caches that never mix, and a 55 MB Blob that no longer exists"
date: 2026-10-19
description: "A custom Service Worker, streaming downloads with TransformStream, and why filling up the phone needs a different message from losing the network."
slug: "ondas-pwa-and-offline"
draft: true
tags:
  - pwa
  - offline
  - performance
---

A player that promises offline listening has a problem a website does not: it stores large files, in
a store the operating system can empty without warning, with a quota that can fill up mid-write.
None of that is theoretical — all three happen, and all three have their own handling in this code.

This document covers the PWA's cache layers, the streaming download, and the two failure modes that
looked like the same one and are not.

## Three disjoint layers, and none of them handles audio

`packages/web/src/sw.ts:9-16` declares the split:

| Layer | Holds | Who writes |
|---|---|---|
| App shell | JS, CSS, HTML, fonts, icons | Workbox, in the Service Worker |
| Downloaded tracks | the audio bytes | the offline store, **outside** the SW |
| Audio streams | nothing | nobody |

The third row matters most: **streaming audio is not cached**. It is large, it is requested in
chunks (`Range`) and it would fill the app shell cache — which exists to make the app open without a
network, not to store music.

And the second row holds the decision that saved the most pain. Downloaded tracks go to their own
cache (`ondas-offline`), written and read **only** by `CacheOfflineStore`, never by the Service
Worker. The reason is in the comment: *so the library index and the bytes on disk never diverge*.

If the SW also wrote there, there would be two sources of truth about "is this track downloaded?" —
the IndexedDB index the library displays, and the cache contents the player uses. They would diverge
at the first edge case, and the symptom would be a track marked as available offline that does not
play. A single writer eliminates the whole class of bug.

There is no `runtimeCaching` configured. The absence is the decision.

## The Service Worker is custom, and it has a denylist

The configuration uses `strategies: 'injectManifest'` (`packages/web/vite.config.ts:11-45`), not
`generateSW`. That means the Service Worker is one of the project's own TypeScript files
(`packages/web/src/sw.ts`), and the plugin only injects the precache list into it.

The part worth copying is at `packages/web/src/sw.ts:25-33`: the single-page-app navigation fallback
— the rule that makes any navigation return `packages/web/index.html` — has an exclusion list:

```ts
new NavigationRoute(createHandlerBoundToURL('index.html'), {
  denylist: [/^\/healthz$/, /^\/sw\.js$/, /^\/api\//],
})
```

The reasoning is written right above it: typing `/api/acervo` into the address bar **is** a
navigation, and without that exclusion the Service Worker would return the app shell instead of the
JSON.

That bug installs itself in any PWA with a same-origin API, and it is particularly unpleasant
because it only appears when the SW is active — that is, never in development, always in production.
It is also an argument for running end-to-end tests against the production build, which is what
Ondas does ([document 13](13-qa.en.md)).

SW registration is manual and production-only (`packages/web/src/main.tsx:10`): in development it
stays out of the way. And the iOS splash screens — ~830 KB of PNG — are excluded from the precache
(`packages/web/vite.config.ts:21-24`), because Safari fetches them at install time; precaching them
would be paying twice.

## The streaming download, and the Blob that used to be there

This is the fix with the most concrete number in the project.

The previous version of the download accumulated response chunks into an array and assembled a
`Blob` at the end. It works, it is what everyone writes first, and it carries a cost that only shows
up with large files: **a 54.9 MB file became a single 54.9 MB `Blob`**
(`packages/web/src/platform/CacheOfflineStore.ts:62-75`).

The current version pipes the response body straight into the Cache API through a `TransformStream`
that only counts bytes passing by (`packages/web/src/platform/CacheOfflineStore.ts:90-100`). The
progress bar keeps working, and backpressure comes from the pipe itself — if writing to disk is
slower than the network, the stream slows down on its own.

For a four-minute track the difference is irrelevant. For a one-hour set — ~120 MB — it is the
memory peak that decides which tab the phone kills. And that is why the fix is worth it: the case
that breaks is not the common case, it is the case the user wants most.

The regression test is a spy on the `Blob` constructor, asserting that no large `Blob` exists during
the download (`packages/web/tests/smoke.spec.ts:640`). What makes that test good is worth noting:
its first version measured the memory peak, which is noisy and garbage-collector dependent.
Measuring *"no large `Blob` was constructed"* is deterministic, and fails exactly when the fix is
undone.

## Filling up the phone is not the same as losing the network

Before, both failures showed "download failed", and the person retried — against a full phone, where
retrying solves nothing.

`QuotaExceededError` from `cache.put` has its own path now: `ehCotaExcedida(err)`
(`packages/web/src/platform/CacheOfflineStore.ts:20`) covers both names browsers use
(`QuotaExceededError` and `NS_ERROR_DOM_QUOTA_REACHED`), and the controller gives the message that
says what to do (`packages/web/src/app/controller.ts:273-280`).

Two consequences of that are more interesting than the message:

**The partial entry is deleted before the error propagates**
(`packages/web/src/platform/CacheOfflineStore.ts:107-113`). Without that, boot-time reconciliation
would find the incomplete bytes and swear the track is there — and the result would be a track
marked offline that plays halfway and stops.

**The panel shows how much still fits**, not how much has been used
(`packages/core/src/view.ts:118-126`). It is a small, correct inversion: the number you use to
decide whether to download a one-hour set is free space, not used space.

## iOS erases storage, so boot reconciles

iOS evicts storage from PWAs that sit idle. There is no way to prevent it; there is only a way to
find out.

`hydrate()` (`packages/web/src/app/hydrate.ts:11`) reads three things in parallel — the library
snapshot, the session and the background preferences — and ends with a step that is not a read
(`packages/web/src/app/hydrate.ts:21-22`): it compares the downloaded-tracks index against what
actually exists in the cache (`offlineStore.keys()`) and discards from the library whatever
vanished.

That is `reconcile(presentIds)` (`packages/core/src/stores/library.ts:79-90`), and it **rebuilds**
the index from what exists rather than trusting it. The same function is reused by the
clear-downloads button (`packages/web/src/app/controller.ts:326`): deleting the bytes and then
reconciling is safer than deleting the bytes and zeroing the index by hand, because either operation
can fail halfway.

`navigator.storage.persist()` is requested on the first write
(`packages/web/src/platform/CacheOfflineStore.ts:152`). It reduces the chance of eviction; it does
not eliminate it.

## Two details that cost time

**The cache key needs a leading slash.**`keyOf(id) = '/offline/' + id`
(`packages/web/src/platform/CacheOfflineStore.ts:10`), and the comment explains: private-library ids
carry the `acervo:` prefix, so `new URL('acervo:123')` would be read as a URL **scheme**. The
leading slash forces it to be read as a path.

**The key-value store swallows exceptions on
purpose.**`packages/web/src/platform/IdbKeyValueStore.ts:11-30` wraps all three methods in
`try/catch` without propagating: *"Modo privado / cota cheia: a sessão segue, só não persiste."* It
is the right decision for preferences — a theme that did not save is no reason to break the screen —
and would be the wrong decision for a track's bytes, which is exactly why the offline store
**propagates** the quota error.

Two stores, two opposite error policies, for the same reason: what is at stake is different.

## What was rejected

| Option | Why not |
|---|---|
| Workbox's `generateSW` | The SPA fallback needs an `/api/` denylist; and audio caching has its own rule |
| Audio in the Service Worker cache | Large, requested by `Range`, and it would create a second writer of the offline index |
| Accumulating chunks and assembling a `Blob` | A 54.9 MB file = a 54.9 MB peak; that is what decides which tab the phone kills |
| `runtimeCaching` for API responses | The library JSON cannot be cached — it is per session |
| A single message for download failures | A full quota and a dead network call for different actions from the reader |
| Trusting the downloaded-tracks index at boot | iOS evicts storage; the index has to be rebuilt from what exists |
| Precaching the iOS splash screens | ~830 KB Safari already fetches at install time |
| Propagating errors in the preferences store | A theme that did not save is no reason to break the screen |

## What it cost

**The Service Worker is my own code to maintain.**`injectManifest` brings freedom and the
responsibility of getting `NavigationRoute`, `skipWaiting` and old-cache cleanup right.

**There are two storage error policies in the same app**, and whoever touches it has to know which
is which: preferences swallow, bytes propagate.

**There is no Background Fetch.** Downloads happen in the foreground, with progress, because the API
does not exist in Safari. Closing the tab midway cancels it — which is why the partial entry has to
be cleaned up.

**iOS eviction is not solved, only detected.** The track disappears from the library on the next
boot. It is honest and it is a bad experience, and the alternative would be lying.

## In an interview

**"How do you store audio offline in a PWA?"** In three layers that never mix: the app shell is
precached by Workbox; downloaded tracks go to their own cache written only by my code, never by the
Service Worker; and streaming is not cached. The second rule is the one that matters — with the SW
writing there too, there would be two sources of truth about "is this track downloaded", and they
would diverge.

**"What was the most relevant memory optimisation you made?"** Replacing
accumulate-chunks-and-assemble-a-`Blob` with a `TransformStream` straight into the Cache API. A 54.9
MB file became a 54.9 MB `Blob`. For a four-minute track that changes nothing; for a one-hour set,
it is the peak that decides whether the browser kills the tab. The regression test is a spy on the
`Blob` constructor — deterministic, unlike measuring a memory peak.

**"Why does the SPA fallback need exclusions?"** Because typing `/api/acervo` into the address bar
is a navigation, and the Service Worker would return `packages/web/index.html` instead of the JSON.
It is a bug that only appears with the SW active — that is, never in development and always in
production — and it is one of the reasons I run end-to-end tests against the production build.

**"How do you handle an exhausted storage quota?"** As a distinct failure from a network error, with
its own message, because the user's actions differ: retrying does not fix a full phone. And the
partial entry is deleted before the error propagates — otherwise boot reconciliation would find the
incomplete bytes and mark the track available.

**"iOS evicts storage from idle PWAs. What do you do?"** There is no way to prevent it, so I detect
it: at boot, the downloaded-tracks index is reconciled against what actually exists in the cache,
and whatever vanished leaves the library. I also request `storage.persist()` on the first write,
which reduces the chance without eliminating it. A track disappearing is a bad experience; the
alternative is showing an offline track that does not play.
