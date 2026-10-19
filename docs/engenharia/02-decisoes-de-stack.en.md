---
title: "Ondas' stack: React because phase 2 is native, and Go because the image is empty"
date: 2026-10-19
description: "Why a music player chose React over Svelte, Go for the API, a single runtime dependency in the domain layer and no CSS framework — with the cost of each choice."
slug: "ondas-stack-decisions"
draft: true
tags:
  - architecture
  - react
  - go
  - typescript
---

Ondas' stack was not chosen at the keyboard. It was written in a design handoff document before a
single line of code existed, and the justification for each item came with it. That is unusual
enough to be worth recording: when the first technical decision is made with the whole problem in
view, rather than in the middle of the third component, the following choices stop being preference
and become consequence.

This document walks through the five choices that matter and what each one charged.

## The choice that dragged all the others

`design_handoff_ondas_terminal_player/README.md:16` picks React 18 + TypeScript + Vite with a
sentence that is not about React:

> Chosen over Svelte so the domain logic and hooks can be reused later in React Native/Expo.

v1 is a PWA. Phase 2 is a native app. Svelte compiles smaller, faster components, and for a PWA with
a 460 KB app shell that would be a real win — but there is no path from Svelte to React Native.
Choosing Svelte would mean writing the queue, permission, theme and cache logic twice, once in each
component language.

The decision, then, is not "React is better". It is: **reusability across two platforms is worth
more than bundle size on one of them**. It is a dated bet, with a concrete date — if phase 2 never
ships, Ondas paid extra bundle size for nothing.

And the bet only pays off if the logic really is reusable, which led to the monorepo with a domain
package that cannot touch the DOM. That is the subject of [document 04](04-monorepo-e-ports.en.md);
what matters here is that it is a **consequence** of this choice, not an independent preference for
hexagonal architecture.

## A domain layer with one dependency

`packages/core/package.json` lists exactly one runtime dependency:

```json
"dependencies": {
  "zustand": "^5.0.2"
}
```

That covers 2,441 lines of business rules — playback queue, permissions, formatting, a shareable
link codec, a waveform codec, theme token generation, a catalogue client with three fallback levels
— and nothing else gets in. No `lodash`, no `date-fns`, no validation library.
`packages/core/src/format.ts:4` implements an FNV-1a hash in seven lines;
`packages/core/src/theme/oklab.ts` carries the colour-space conversion matrices by hand, in 69
lines.

This is not asceticism. It is that `core` is the package phase 2 will import inside a different
bundler, on a different runtime, and every dependency there is a bet that it works in React Native
too. Zustand gets in because it is platform-agnostic by construction — and, as [document
05](05-estado-e-stores.en.md) details, Ondas uses the `zustand/vanilla` variant, which does not even
know React exists.

The PWA package, which has no such constraint, has eleven dependencies.

## The division of labour between two state libraries

Having TanStack Query **and** Zustand in the same app is usually a sign that nobody decided
anything. Here the boundary is explicit and always falls in the same place:

| Belongs to | Who owns it | Where it lives |
|---|---|---|
| Data that comes from outside and can go stale | TanStack Query | `packages/web/src/query/` |
| Data that belongs to the session and nobody else | Zustand | `packages/core/src/stores/` |

The catalogue is Query's: it has `staleTime`, `gcTime`, revalidation, IndexedDB persistence and a
cache key. What is playing, what is liked, which theme is active and where the list cursor sits is
Zustand's: none of that has a "server version" to reconcile.

The boundary pays a concrete debt. Because the catalogue key is scoped by session
(`packages/web/src/query/catalog.ts:12`), signing out removes the signed-in catalogue from the
persisted cache instead of leaving private-library metadata on the device waiting for the next
guest. If the catalogue lived in a hand-persisted Zustand store, that cleanup would be a line
somebody had to remember to write.

There is exactly one exception, and it is deliberate: tracks opened by a direct link stay
**outside** Query, in their own store (`packages/web/src/app/extras.ts:10-19`). The reason is a good
one and it is in document 05.

## Go for the API, and why there are two images

The library API is Go: `chi` for routing, `pgx` for Postgres, `envconfig` for configuration, `slog`
for structured logging. What that combination buys is visible in `api/Dockerfile:15-19`:

```dockerfile
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/api /api
```

The production image holds **two files**. There is no shell, no package manager, no interpreter —
nothing an attacker with code execution could invoke, because nothing is installed. The migrations
are embedded in the binary via `go:embed` (`api/internal/db/pool.go:15-16`), so there is no second
artefact to keep in sync and no initContainer to orchestrate.

The ingestion worker is the sibling image, and `api/Dockerfile.worker:1-3` explains why it exists:

```
# Imagem do worker de ingestão. Separada da API porque aqui o ffmpeg é
# obrigatório — a imagem da API é scratch, sem nada do sistema.
```

That is the interesting part of the decision. A single binary with both modes would be simpler to
publish, but it would force the API to carry ffmpeg and all of Alpine underneath it — and the API is
the process exposed to the internet. Splitting trades one image for two so that **the large attack
surface sits in the process that accepts no outside connection**: the worker has no Service and no
Ingress, it only pulls work from a queue in Postgres.

## `minio-go` instead of the AWS SDK

The bucket is Cloudflare R2, which speaks the S3 protocol. The client is `minio/minio-go/v7`
(`api/go.mod:10`), not `aws-sdk-go-v2`.

The reason recorded in the repository is the simplest one there is: **precedent**. The comment at
`api/Dockerfile.worker:3` notes that this is the same pattern as an earlier project on the same
cluster, and `api/internal/storage/r2.go:1-3` says "minio-go, como a API do rachão". Repeating a
choice that already ran in production is not laziness — it is the only form of evidence available
when both options work.

And both work. `minio-go` covers everything Ondas uses — `PutObject`, `GetObject`, presigned GET and
PUT URLs, bucket CORS policy — with explicit static credentials and `Region: "auto"`, which is what
R2 expects (`api/internal/storage/r2.go:46-51`). There is no AWS SDK feature that would be missed
here.

One observation that was **not** the reason for the choice, but reinforces it in hindsight: the AWS
SDK's credential chain tries, among other sources, the instance metadata service at
`169.254.169.254` — precisely one of the addresses this project's SSRF guard exists to block
(`api/internal/ingest/baixar.go:20-39`). In a binary whose job is fetching third-party URLs, less
code that knows how to talk to internal addresses is better. But that is an argument found
afterwards; the decision was made on precedent.

## No CSS framework

There are 2,035 lines of CSS across ten CSS Modules and one global file. No Tailwind, no
`styled-components`, no component library.

The reason is that Ondas has its own colour system and it is small: each theme defines four values
(`bg`, `fg`, `accent` and eight ANSI colours) and **everything else is derived** at runtime by
`color-mix(in oklab, …)`, generating 41 CSS variables (`packages/core/src/theme/tokens.ts:34`). The
modules only consume `var(--…)`: 243 references across 28 distinct names, and no module declares a
colour of its own.

A utility framework would not help generate those ramps and would get in the way of runtime theme
switching, which here is a `setProperty` on the root and nothing more. The full detail is in
[document 07](07-tema-e-design-system.en.md), including why there is exactly **one** layout `@media`
in the entire project.

## What was rejected

| Option | Why not |
|---|---|
| Svelte / SvelteKit | No path to React Native; the domain logic would have to be rewritten in phase 2 |
| Next.js | The PWA is static and served by nginx; server rendering has nothing to do in a player whose data comes from a public API and a private bucket |
| A Node backend sharing types with `core` | Would lose the `scratch` image and the single binary; and the only thing worth sharing — the waveform codec's alphabet — is guarded by a test that reads the TypeScript file from inside Go |
| `aws-sdk-go-v2` | No feature that would be missed; `minio-go` already had production precedent on the same cluster |
| Redux / Context API for everything | Context re-renders the tree and does not work outside React — the imperative controller needs to read state without hooks |
| Tailwind | Does not generate the derived ramps; and the theme switches at runtime, not at build time |
| A single Go binary with two modes | Would force the exposed API to carry ffmpeg and Alpine |

## What it cost

**The bundle is larger than it needs to be.** React + React DOM + Router + three TanStack packages
in an app whose interface is monospaced text is disproportionate, and every new visitor pays for it.
It is only justified by phase 2.

**Two state libraries is a boundary to explain.** It is documented and consistent, but anyone new to
the code has to learn it before knowing where to put a field.

**The absence of dependencies in `core` means more of my own code to maintain.** The hash, the oklab
conversion and the peaks codec are seventy lines a library would have solved — and are now the
project's responsibility, covered by 216 tests.

**The waveform codec is written twice**, in TypeScript and in Go, because the API image is built
with the `api/` context only and cannot import anything from the monorepo. The silent divergence
this would allow is guarded by a test that reads the file from the other language and compares the
alphabet character by character (`api/internal/ingest/picos.go:21-25`).

## In an interview

**"Why React and not Svelte, in an app that is basically text?"** Because phase 2 is React Native,
and the domain logic — queue, permissions, theme, cache — has to be the same. Svelte would win on
v1's bundle size and lose on v2's duplication. The bet is recorded and dated: if the native app
never ships, I paid extra bundle size for nothing.

**"Why two state libraries?"** Because they solve different problems. TanStack Query handles data
that comes from outside and goes stale: it has revalidation, a cache key and persistence. Zustand
handles session data, which has no server version to reconcile. The boundary is "can this go stale?"
and I have never had to argue it case by case.

**"Why Go and not Node, if the frontend is already TypeScript?"** Because of the production image:
the API's is `FROM scratch` with two files, no shell and no interpreter. The migrations are embedded
in the binary, so there is no second artefact to version. What I would lose — sharing types with the
frontend — was exactly one thing, the peaks codec alphabet, and that is guarded by a test comparing
both sides.

**"Aren't you over-engineering a music player?"** For v1 in isolation, yes. The architecture is only
justified by phase 2 and by the private library, which is what requires real accounts, a private
bucket and ingestion. If the scope were only playing the public catalogue, a single package with
React and `fetch` would do — and I would have written that.

**"How do you make sure `core` does not leak platform access?"** Through the compiler. `core`'s
`tsconfig` pins `lib: ["ES2022"]` without the DOM library, so `document`, `window` and
`localStorage` are compile errors there. It is not a convention and not a code review item: the
build breaks.
