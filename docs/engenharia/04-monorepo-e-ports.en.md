---
title: "A domain layer that will not compile if it sees the DOM"
date: 2026-10-19
description: "How a tsconfig without the DOM library turns portability into a compile error, and the three injection mechanisms Ondas uses to cross the boundary."
slug: "ondas-monorepo-and-ports"
draft: true
tags:
  - architecture
  - typescript
  - monorepo
---

Hexagonal architecture is usually an intention. Someone writes "the domain layer must not depend on
infrastructure" on a wiki page, and six months later there is a `localStorage.getItem` in the middle
of a business rule, because it was faster and nobody objected.

In Ondas that boundary is not an intention: it is one line of compiler configuration. This document
shows how it works, what the five ports are, the three different injection mechanisms that cross the
boundary — and what the indirection charges.

## The problem: a convention cannot defend itself

The monorepo's promise is that phase 2 (a native app) reuses everything but the interface. For that,
`packages/core` has to be pure: types, permission rules, playback queue, link codec, waveform codec,
theme token generation, catalogue client. Nothing that only exists in a browser.

The practical question is: what stops someone — me, on a Friday — from writing `window.innerWidth`
there?

## The decision: the compiler charges for it

`packages/core/tsconfig.json` pins:

```json
"lib": ["ES2022"]
```

No `"DOM"`. The comment beside it says what that means: *`document`, `window` e `localStorage`
precisam continuar sendo erro de compilação aqui*.

That is all. No lint rule, no code review, no team agreement. Anyone who tries to use a browser API
in `packages/core` finds out from `tsc`, before committing — and CI runs `pnpm -r typecheck` as its
first gate.

The shared `tsconfig.base.json` also turns on four options that change daily life more than they
look:

| Option | What it charges |
|---|---|
| `strict` | the basics: `null` and `undefined` handled |
| `noUncheckedIndexedAccess` | `arr[i]` is typed `T \| undefined` — which is why the queue code is full of honest `?? null` instead of `!` |
| `noUnusedLocals` / `noUnusedParameters` | an orphan import does not survive a refactor |
| `verbatimModuleSyntax` | explicit `import type`; no type import survives into the bundle |

`noUncheckedIndexedAccess` is the most annoying and the most valuable. In a player, half the list
bugs are "the index went out of range and I read `undefined` as if it were a track". With the option
on, that case does not compile without handling.

## The five ports

They live in `packages/core/src/ports/`, total about 90 lines, and are interface only:

| Port | Essential signature | On the web | In phase 2 |
|---|---|---|---|
| `PlayerEngine` | `load`, `play`, `pause`, `seek`, `currentTime`, `duration`, `on`, `destroy` | `HTMLAudioElement` + Media Session | `react-native-track-player` |
| `OfflineStore` | `has`, `get`, `put`, `remove`, `usage`, `keys` | Cache API | `expo-file-system` |
| `KeyValueStore` | `get`, `set`, `remove` | `idb-keyval` | MMKV / AsyncStorage |
| `Connectivity` | `isOnline`, `subscribe` | `navigator.onLine` | NetInfo |
| `AuthService` | `login`, `logout`, `restore` | an HTTP implementation | probably the same one |

Four of them were **named in the design handoff**, by signature, before any code existed
(`design_handoff_ondas_terminal_player/README.md:43-46`). The fifth appeared when real accounts
arrived — and the way it appeared is the best evidence the boundary was worth it, as shown further
down.

### One type detail worth the space

`packages/core/src/ports/player-engine.ts:7-20` does not declare events as a union of strings. It
declares a **payload map**:

```ts
interface PlayerEngineEvents {
  time: number;
  buffer: number;
  ended: void;
  waiting: boolean;
  playing: boolean;
  duration: number;
  error: Error;
}
```

And `on` is generic over `keyof` that map (`packages/core/src/ports/player-engine.ts:35`). The
effect is that the callback arrives **already typed per event**: in `on('time', t => …)`, `t` is
`number`; in `on('error', e => …)`, `e` is `Error`. With a union of event names, every handler would
receive `unknown` or a union that has to be narrowed by hand.

It is little code for a gain that shows up in each of the seven listeners in `bootstrap`
(`packages/web/src/app/controller.ts:351-376`).

## Three injection mechanisms, and why not one

There is no dependency injection container. There are three different patterns, each where it makes
sense.

### 1. Edge singleton

`packages/web/src/app/services.ts:13` has the shortest and most useful comment in the package:

> Trocar de plataforma é trocar este arquivo.

*("Changing platform means changing this file.")*

That is where the implementations are instantiated: key-value store, authentication, offline store,
connectivity, the two catalogue clients, the byte uploader and the audio engine. One file, eight
objects, no magic. The rest of the app imports what it needs from there.

The alternative — passing everything through props or context — would be more "correct" and would
make the imperative controller impossible, because it does not run inside React.

### 2. Constructor

For anything with a variant: `LocalAuthService` takes the key-value store
(`packages/core/src/auth/local.ts:18`); the catalogue clients take an optional `fetchImpl`
(`packages/core/src/catalog/audius.ts:53-55`).

That `fetchImpl` carries a trap documented in the code itself: storing bare `fetch` as the default
value throws **"Illegal invocation"** in the browser, because the function loses `window` as its
`this`. The default is a wrapper, not the direct reference. It is the kind of detail you only find
at runtime, and the comment exists so nobody "simplifies" it back.

### 3. Per-call dependency object

The most interesting one. `loadCatalog` is not a method on a class with constructor dependencies —
it is a function that receives its dependencies on every call
(`packages/core/src/catalog/resolve.ts:18-38`):

```ts
interface LoadCatalogDeps {
  remote: CatalogClient;
  readCache: () => Promise<CachedCatalog | null>;
  writeCache: (c: CachedCatalog) => Promise<void>;
  forceDemo?: boolean;
  maxAgeMs?: number;
  now?: () => number;      // injetável para teste
  onError?: (e: unknown) => void;
  acervo?: (signal?: AbortSignal) => Promise<Track[]>;
}
```

That `now?: () => number` is the whole reason for the pattern. The function decides whether the
metadata cache expired by comparing against 24 hours, and testing that with a class would mean
touching the system clock or waiting. With the clock as a call dependency, the test passes a
function and that is it. The same pattern appears in `stepIndex(ctx, dir, rnd = Math.random)`
(`packages/core/src/queue.ts:37`) — shuffle's randomness is injectable, so shuffle behaviour is
deterministic under test.

### A port that is a function

`packages/core/src/acervo/upload.ts:40` defines `EnviadorDeBytes<A>` as a function type, not an
interface with methods. It exists because `fetch` **does not report upload progress**
(`packages/core/src/acervo/upload.ts:33-39`), and the web implementation is XHR
(`packages/web/src/platform/XhrEnviador.ts:5-8`) — which is also the only option because a
`ReadableStream` request body does not exist in Safari.

Not every port needs an interface. When the dependency is "a thing that does a job and reports
progress", a function type is the honest shape.

## The proof the boundary paid off

The prototype had fake authentication: a `LocalAuthService` that validated an email with a loose
regular expression and stored the user in local storage. When the real API arrived,
`HttpAuthService` appeared, talking to `/api/auth/*`, handling the cookie and dealing with 401.

Both implement `AuthService`. The swap happened **in `packages/web/src/app/services.ts`**, on one
line, and no UI component changed — because no component knew `LocalAuthService`; they all knew the
port.

It is worth noting what the new implementation documents back, in
`packages/core/src/auth/http.ts:27-30`: the session lives in an `HttpOnly` cookie this code **cannot
read**. What goes into the key-value store is only the user's name, so the screen does not flash
between boot and the `/me` response. The `AuthService` port does not promise a token — it promises
`login`, `logout` and `restore` — and that is exactly why it accepted an implementation whose
credential is invisible to JavaScript.

There is a second product detail hidden in that implementation: `restore()` only invalidates the
session on a **401**, never on a network failure. The PWA is installed and opens offline; treating
"I could not ask" as "I am not signed in" would kick the user out of the app every time they opened
it on the subway.

## What stays outside the ports

`packages/web/src/platform/` has eight files, but only five are port implementations. The other
three are adapters with no matching port: Media Session, sharing, and canvas image downscaling.

The choice is deliberate. Media Session is a platform garnish — if it does not exist, the app works
the same, it just does not show up in the OS media controls. Creating a port for it would be
inventing an abstraction for a feature phase 2 solves in an entirely different way
(`react-native-track-player` already handles it). **A port is for what the domain needs; an adapter
is for what the platform offers.**

## What was rejected

| Option | Why not |
|---|---|
| Folder convention + code review | Cannot defend itself; the `tsconfig` `lib` can |
| A custom lint rule banning browser globals | More machinery to maintain, and the compiler already does it |
| A dependency injection container | Eight objects in one file do not need a framework to be resolved |
| Dependencies via React context | The imperative controller does not run inside React and must read state without hooks |
| `PlayerEngine` with a union of event names | Handlers would get an un-narrowed type; the payload map types each callback |
| A port for Media Session and sharing | They are platform features, not domain needs |

## What it cost

**Real indirection, with a reading cost.** To know what happens when a track ends, you go from the
controller to the domain's queue module to the engine implementation. Across three files, in a
project with 8,800 lines of frontend, that cost is worth it. In an 800-line project it would not be.

**The fifth port arrived late.**`AuthService` was not in the handoff, and had to be designed with
`LocalAuthService` already in place — which biased the interface toward what the fake implementation
did. The repair was cheap because the boundary already existed, but "a port designed from an
implementation" describes its origin.

**`noUncheckedIndexedAccess` creates noise.** Every indexed access needs handling, including the
obviously safe ones. The code has `?? null` in places where a human knows the index is valid, and
that is noise the option charges in exchange for catching the cases where the human was wrong.

**Phase 2's promise is still a promise.** The "in phase 2" column of the port table is hypothesis.
The architecture only proves its worth when the second adapter exists; until then, it is a
well-structured bet.

## In an interview

**"How do you ensure the domain layer does not depend on infrastructure?"** Through the package's
`tsconfig`: it pins `lib: ["ES2022"]`, without the DOM library. `document`, `window` and
`localStorage` are compile errors there, and CI runs `typecheck` as its first gate. The difference
between that and a convention is that a convention depends on somebody noticing in review.

**"Do you use dependency injection?"** Three forms, no container. One edge file instantiates the
implementations and carries the comment "changing platform means changing this file". Constructors
where there is a variant. And a per-call dependency object where the test needs control over
something — `loadCatalog` takes the clock as a dependency, and that is what lets me test the 24-hour
cache expiry without touching the system clock.

**"How did you prove the ports architecture was worth it?"** When the prototype's fake
authentication was replaced by the real API, the change was one line in the edge file and zero UI
components. None of them knew the old implementation — they all knew the port. The new
implementation even has a property the old one did not: the credential is an `HttpOnly` cookie that
JavaScript cannot read.

**"Did every platform API become a port?"** No, and that is deliberate. A port is for what the
domain needs; an adapter is for what the platform offers. Media Session and sharing are adapters
with no port, because if they do not exist the app works the same. Abstracting them would invent an
interface phase 2 solves differently.

**"What does this structure cost?"** Indirection. Understanding what happens at the end of a track
means opening three files. That is worth it in an 8,800-line frontend with a second platform
planned; it would not be in an 800-line app. And the second platform is still a promise — the
architecture only proves itself when the second adapter exists.
