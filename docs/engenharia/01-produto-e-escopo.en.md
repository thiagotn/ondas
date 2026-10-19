---
title: "A design handoff as an executable specification"
date: 2026-10-19
description: "Three design packages decided the stack, named the platform interfaces and said what not to touch. What that changes about execution — and what Ondas deliberately left out."
slug: "ondas-product-and-scope"
draft: true
tags:
  - product
  - architecture
  - design
---

Most of what I call a "product decision" in a personal project is really a decision made halfway
through implementation, when going back is already expensive. Ondas was different: three design
handoff packages existed in the repository **before** the first commit of code, and they did not
just describe appearance. They decided the stack, named the platform interfaces and, in the two
follow-up increments, said explicitly what **not** to touch.

This document is about the effect of that on execution, and about the scope lines the project drew
on purpose — including the ones that hurt.

## The problem a good handoff solves

`design_handoff_ondas_terminal_player/README.md:11` opens with a distinction worth more than the
rest of the package:

> They are **not production code**. The task is to **recreate this design in the target codebase's
> environment** […] using its established patterns and libraries.

The reference files are interactive HTML prototypes, with the entire logic in a `class Component`
holding its own state. Porting them would have been tempting. The handoff closes that door on the
first page: the reference shows **what** to build, and the target codebase's patterns decide
**how**.

That avoided the most common failure mode of a prototype that became a product, which is the
prototype beating the architecture. Two signs it worked: the prototype's `class Component` became a
module of functions (`packages/web/src/app/controller.ts:29-33` records the swap), and the
prototype's premium-track heuristic — `index % 3`, a position in a list deciding what is paid —
survived only as a *fallback*, with the real API field winning over it
(`packages/core/src/access.ts:11`).

That heuristic did charge its price later. When the private library arrived, the user's own tracks
needed an explicit `premium: false`, because with `undefined` the heuristic would mark the owner's
own music as `[pro]` (`packages/core/src/catalog/acervo.ts:63-66`). A made-up rule left in the code
ends up being consulted by someone who did not know it was made up.

## The handoff named the ports before the code existed

The most unexpected part: `design_handoff_ondas_terminal_player/README.md:43-46` lists four platform
interfaces by name and signature.

```
PlayerEngine { load(track, src), play(), pause(), seek(s), on(event) }
OfflineStore { has(id), get(id), put(id, stream, onProgress), remove(id), usage() }
KeyValueStore { get, set }
Connectivity { isOnline(), subscribe(cb) }
```

That is literally what exists today in `packages/core/src/ports/`, plus a fifth port (`AuthService`)
that appeared with real accounts. A design document specifying the system's portability boundary is
rare — and the reason is stated: *"Native apps will come later, so structure the code to make that
easy."*

Document 04 covers what that boundary costs and buys. The product point is different: **portability
was a requirement, not a refinement**. It never had to be negotiated against a deadline later,
because it was in the specification from the start.

## Two access modes, and what each one can do

`design_handoff_ondas_terminal_player/README.md:5` defines the guest in one line: listens only to
free tracks, cannot download and cannot play `[pro]`.

| | Guest | Signed in |
|---|---|---|
| Public catalogue | yes | yes |
| `[pro]` tracks | no (opens a notice) | yes |
| Download for offline listening | no | yes |
| Private library | does not exist | goes to the front of the list, tagged `[meu]` |
| Session | **ephemeral** — reloading returns to login | 30 days |
| Theme, likes, downloads | persist | persist |

The ephemeral session line is the most interesting, because it is the only one that **contradicts**
product intuition. The normal thing would be to remember the guest. The choice came from the
prototype and was kept: only sign-in persists. In exchange, device preferences survive — theme,
likes and downloads do not depend on who is logged in.

That separation later became a screen decision. Account and library used to live in the same panel,
inside `~/biblioteca`, and that **implied a synchronisation that does not exist**: the account lives
on the server and follows the person to any device; likes, downloads and buffer live in *that
browser's* IndexedDB and follow nobody. Today the library is only the library, and the account opens
under its own name (`ondas whoami`) from the prompt or the status line.

The corollary of that honesty is behaviour that disappoints on purpose: **`[sair]` does not erase
what belongs to the device** — and the panel says so in plain words. Anyone who wants to erase uses
`[limpar downloads]`, which asks first. Without that, signing out would leave private library audio
in the browser with no screen left to show it.

## The increments said what not to touch

The two follow-up handoffs start with the same sentence.
`design_handoff_ondas_brand_assets/README.md:3`: *"the Ondas PWA […] **is already implemented**.
This package adds **only** the brand […] Don't change anything else."* And
`design_handoff_ondas_layout_transparency/README.md:3`: *"This package adds **only two changes**.
Don't touch anything else."*

It reads like bureaucracy. It is not: it is the mechanism that stops a branding request from
becoming a refactor. The second package asks for exactly two things — centred desktop layout and
background transparency with blur — and names the three traps in each, including not using
`backdrop-filter` on the root, because that creates a containing block and breaks every
`position: fixed` overlay. A handoff that already knows where the implementer will get hurt saves a
whole review cycle.

The third package also arrived with a table of **five application sites** for a single new component
(the splash, the login screen, the tab bar, the player row and the missing-artwork placeholder),
with size and parameters for each. Nobody had to ask "where do I use this?".

## Delivery in phases, visible in the history

The private library did not land all at once. The git history marks the slicing in the commit
subject itself:

```
68424aa  acervo no R2 privado: ingestão por URL com worker (fase 2)
d94b436  a PWA enxerga o acervo: login de verdade e duas fontes (fase 3)
9f1c64e  tela de envio: arquivo local vai do navegador direto para o R2 (fase 4)
```

There are eight phases in all, and the product point is the **order**: the API and the worker
shipped before the PWA knew the library existed. That means that, for two phases, there was backend
in production with no screen at all — ingestion working, tracks in the bucket, and the interface
still showing only the public catalogue. For a one-owner project, that inversion is comfortable: you
can check the backend with `curl` without the screen lying about it. On a team, it would be a hard
conversation about delivered value.

## What was deliberately left out

Product is also the list of what you do not build. The recorded refusals:

| Left out | Why |
|---|---|
| Guaranteed background audio on iOS | It works in the installed PWA, but iOS may suspend it. Accepted, not worked around |
| Background Fetch | Does not exist in Safari; downloads happen in the foreground, with progress |
| Audio in the Service Worker cache | Tracks are large and partial (`Range`); they would fill the app shell cache. They go to their own cache |
| Waveform for Audius tracks | The public catalogue does not publish the waveform, and the app will **not** download the whole file to measure it. A flat bar is the honest answer |
| `g`/`G` and `h`/`l` keys | `l` is already "like", and a second navigation vocabulary only after `j`/`k` is established |
| A `[?]` button on mobile | There is no keyboard there, and the window is about keys |
| Editing track metadata | The API has no `UPDATE` on `tracks`; fixing a title means re-ingesting |
| Open sign-up | `SIGNUP_OPEN` defaults to `false` and the allowlist starts empty |

The waveform line is the one that looks most like a bug and is most a product decision. The previous
version drew, for every track, a wave derived from the hash of its id: pretty, convincing and **with
no relationship to the sound**. Replacing that with a flat bar where the audio is unknown made the
interface visibly poorer — and made relief mean exactly one thing: *Ondas knows this audio*. It
trades visual density for truthfulness, and I would do it again.

## What it cost

**The handoff fixed the stack early, and early is a bet.** React was chosen because of a phase 2
that has not started ([document 02](02-decisoes-de-stack.en.md)). If it never ships, v1 paid extra
bundle size for a gain that never arrived.

**"Pixel-perfect" in a high-fidelity handoff is an expensive contract.** The package declares
colours, typography, spacing and copy final. That removes taste arguments and also removes the
chance to discover, mid-implementation, that a choice does not work — which did happen: the full
player did not fit on a phone screen, and the fix needed a `@media` query, the only one in the
project.

**The phase inversion left backend without a screen for two commits.** It worked because the user
and the developer are the same person.

**The prototype's heuristic survived in the code** and charged an explicit `premium: false` from a
data source that had nothing to do with it.

## In an interview

**"How do you work from a design handoff?"** In this project the handoff did more than appearance:
it decided the stack and named the four platform interfaces by signature. The first thing I read was
the sentence saying the prototypes are **not production code** and that the task is to recreate the
design using the target codebase's patterns. That is what stops a prototype from beating the
architecture — and here the risk was real, because the prototype shipped with all its logic in a
stateful class.

**"How do you decide what stays out of v1?"** By whether the limit is the platform's or mine.
Background audio on iOS and the absence of Background Fetch are Safari limits: I accept and document
them instead of inventing a fragile workaround. Extra navigation keys or metadata editing are my own
scope, and they stay out because there is no demand yet. The list is written in the README — an
undocumented refusal comes back as a question.

**"Give me an example of a product decision that made the app worse."** The waveform. Every track
used to have a drawing derived from the hash of its id: pretty, and with no relationship to the
sound. Today a track whose audio the system does not know shows a flat bar. The screen got poorer,
and in exchange relief means exactly one thing. I prefer less information to invented information.

**"How do you communicate that a feature is device-only?"** By writing it on the screen. Account and
library were the same panel, which implied synchronisation between things that do not sync: the
account is on the server, the likes and downloads are in that browser. I split the screens and added
the explicit sentence that signing out does not erase what belongs to the device, with a separate
button for anyone who wants to.
