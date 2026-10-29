---
title: "Store the id, never the position: the lesson this project learned three times"
date: 2026-10-19
description: "Eight stores, two persistence strategies, and a bug that came back three times under different names — because the track list changes size when someone signs in."
slug: "ondas-state-and-stores"
draft: true
tags:
  - architecture
  - react
  - state
---

There is a bug in this project that appeared three times, under three different names, always from
the same cause. It is the best thing I have to say about state management, because it is not about
which library to use — it is about what a reference means when the collection it refers to can
change size underneath it.

This document is about Ondas' eight stores, the boundary between them and the query cache, and that
bug.

## The problem: the list changes size when someone signs in

Ondas' catalogue has two sources. For a guest, only the public catalogue. For a signed-in user, the
private library's tracks go to the **front** of the list
(`packages/core/src/catalog/resolve.ts:71`).

That means signing in inserts N items at the start of an array, and signing out removes them. Every
position shifts. And a player has several things pointing at "that track there":

- what is playing now;
- the list cursor, moved by `j`/`k`;
- the next track, for prefetching;
- the number shown in each row's gutter.

If any of those is stored as an **index**, it starts pointing at a different track the moment
someone signs in. The symptom is not an error: it is the player showing one track and playing
another.

## The decision: ids in memory, indices only at the edge

The rule the project converged on, after getting it wrong three times:

> **State stores ids. An index exists only at the moment of use, derived from the id.**

It shows up in three places, and all three are worth looking at because they are the same mistake at
different scales.

### First time: what is playing

`packages/core/src/stores/player.ts:39` stores **both**: `cur` (index) and `curId` (id). The comment
at `packages/core/src/stores/player.ts:6` says why the id exists: *"sobrevive a reordenações da
lista"* — it survives list reordering.

The index still exists because the audio engine and queue navigation work with positions. What fixes
it is **re-anchoring when the list changes** — `setTracks`, in the controller, does not accept the
new list silently (`packages/web/src/app/controller.ts:39`): it recomputes `cur` via
`indexOfTrack(next, curId)`. Without that line, the player would show one track and play another.

### Second time: track identity inside the domain

`indexOfTrack(tracks, id)` (`packages/core/src/queue.ts:80`) has ten lines of comment explaining the
re-anchoring, and exists so that the id → index conversion has **exactly one place** in the code.
That is the part the first fix did not solve: I had fixed the symptom at one point, and the
conversion was still scattered.

### Third time: the list cursor

When `j`/`k` arrived, the cursor was born as an id — `cursorId: string | null`
(`packages/core/src/stores/ui.ts:39-45`) — with the justification written in the store itself:
signing in puts the private library at the front and would shift every index.

And this is where the lesson gets interesting, because there is a **deliberate counterexample**. The
number shown in each row's gutter is the position in the **whole** catalogue, not in the visible
slice (`packages/web/src/hooks/useTrackRows.ts:58`). So `:08` means the same track on any tab. In
exchange, on filtered tabs the numbers are sparse — `03`, `17`, `42` — and track 08 may not be on
screen. The answer was to make the `:08` command **navigate** to the tab where numbers are
contiguous, rather than invent a per-tab numbering.

In other words: an index *is* the right thing when it is the identity the user sees. The mistake is
using it as an **internal** identity.

## Eight stores, and why four are "vanilla"

| Store | Where | Holds |
|---|---|---|
| `player` | `packages/core/src/stores/player.ts` | what is playing, time, buffer, shuffle, repeat |
| `library` | `packages/core/src/stores/library.ts` | likes, downloads, sizes, progress |
| `session` | `packages/core/src/stores/session.ts` | the user, and whether the session was read yet |
| `ui` | `packages/core/src/stores/ui.ts` | theme, cursor, toast, gate, picker, background |
| `avulsas` | `packages/web/src/app/extras.ts` | tracks opened by direct link |
| `guest` | `packages/web/src/app/guest.ts` | guest mode (not persisted) |
| `uploads` | `packages/web/src/app/uploads.ts` | the file upload queue |
| `splash` | `packages/web/src/app/splash.ts` | the splash screen |

The four in `core` use `createStore` from `zustand/vanilla`, not React's `create`. The difference
matters for a concrete reason: **the imperative controller does not run inside React**. It is a
module of functions (`packages/web/src/app/controller.ts`), called by keyboard shortcuts, by audio
element listeners and by Media Session actions — contexts where hooks do not exist.

With vanilla stores, it calls `playerStore.getState()` and that is it. The typed hooks sit in a thin
layer on the web side (`packages/web/src/app/stores.ts:48-51`), one line each, via `useStore`.
Components use the hooks; the controller uses `getState`. Neither knows the other exists.

The four web stores use React's `create` because they are interface state only the interface reads.

## What persists, and what must not

`library` is the cleanest example of a boundary that is usually left implicit. The store separates
two types by construction (`packages/core/src/stores/library.ts:4-9`):

- **`LibrarySnapshot`** — what goes to disk: likes, downloaded tracks, sizes, the prefetch
preference;
- **`LibraryState`** — the snapshot plus `dl: Record<string, number>`, download progress, which does
**not** persist.

The mechanism is a closure called `commit` (`packages/core/src/stores/library.ts:44-47`): it applies
the change and calls `persist?.(snapshotOf(get()))`. And `setDl`
(`packages/core/src/stores/library.ts:71`) is the only action that does **not** use `commit` — it
uses raw `set`.

That single line of difference is what stops a download's progress from generating an IndexedDB
write every 150 ms. The boundary is not a comment saying "do not persist progress": it is the
absence of a `commit`.

The UI store makes the same separation another way. Not every `ui` field persists — only the
background preferences — and the choice is implemented as a subscription with manual comparison of
four fields before writing (`packages/web/src/app/stores.ts:27-38`). The theme, meanwhile, lives in
`localStorage` rather than IndexedDB, because it has to be read **before first paint**,
synchronously (the subject of [document 07](07-tema-e-design-system.en.md)).

And a detail that looks small: the custom background is a data URL of up to ~1 MB, which would blow
past `localStorage`'s 5 MB quota (`packages/web/src/app/stores.ts:22-26`). It is the same app using
both stores for opposite reasons — one because it is synchronous, the other because it is large.

## The third owner: the URL

The interface store used to hold more than it should. The tab, the library segment, the genre chip
and the search term were all fields of `ui` — and none of them survived a reload, none was
linkable, and the tab even had **two** owners (the `tab` field and the pathname), which diverged
until the field became dead code nobody read.

The rule now is: **whatever describes the content in focus lives in the address.** The segment is a
path (`/library/offline`), the chip and the term are query (`/?genre=jazz`, `/search?q=mar`), and
the full player is the track's own route (`/t/<slug>-<id>`) instead of a `?player=1` that could say
there was music on screen but not which. What is left in `ui` is what is not content: theme,
cursor, toast, gate, picker and the background preferences.

This cost exactly nothing in `core`, and the reason is worth recording: `visibleTracks`,
`promptLine` and `emptyText` (`packages/core/src/view.ts`) always took the filter **as an
argument**, never reading a store. Changing where the filter comes from touched no line of `core`
and no test of `core` — the old design paying a dividend.

What crosses the boundary the other way is small too: `parseLibrarySegment`
(`packages/core/src/view.ts`) is the sieve for whatever arrives through the URL. Without it,
`/library/garbage` would make the prompt write `ondas ls --garbage` and the list show the wrong
segment — the URL ruling the app.

The sieve needs a default, and it is not a constant: `defaultLibrarySegment` returns `acervo` when
there is an account and `liked` when there is not. It is where both `/library` without a segment and
the garbage land, and it depends on the session because without an account the private library does
not exist — opening on it would press a chip the screen does not even draw.

## The boundary with the query cache

Two state libraries in one app need a rule, and Ondas' is:

| | TanStack Query | Zustand | URL |
|---|---|---|---|
| Nature | data from outside, which can go stale | session data, with no server version | the content in focus |
| Example | the catalogue | what is playing, likes, theme, cursor | the open track, the segment, the filter |
| Has revalidation? | yes | makes no sense | the browser keeps it |

The rule holds well, and it pays a concrete debt. The catalogue key is **scoped by session**
(`packages/web/src/query/catalog.ts:12`): `['catalog','trending','com-acervo']` when signed in,
`[...,'visitante']` when not. The comment at `packages/web/src/query/catalog.ts:27-29` explains the
gain: signing in or out switches catalogues instead of reusing the previous one, *"e o cache
persistido do visitante nunca guarda faixa do acervo"* — the guest's persisted cache never holds a
private-library track.

Signing out then explicitly removes the signed-in queries
(`packages/web/src/app/controller.ts:303`), because signing out without erasing would leave the
user's own track metadata on the device waiting for the next guest. If the catalogue lived in a
hand-persisted store, that cleanup would be a line somebody had to remember to write.

### The exception, and why it is the best part

Tracks opened by a direct link stay **outside** the query cache, in their own store. The comment at
`packages/web/src/app/extras.ts:10-19` describes the bug the decision avoids, and it is specific
enough to be useful:

> A alternativa curta seria `queryClient.setQueryData(catalogKey(...), …)`, mas o próximo refetch
> do trending sobrescreveria `tracks`: no meio da escuta a faixa sumiria da lista, `setTracks`
> reancoraria para `cur: -1` e a barra de baixo desapareceria com o áudio ainda tocando.

The chain is worth taking apart, because it shows how these systems fail:

1. someone opens a link to a track not among the 24 in trending;
2. the track is resolved by id and injected into the list;
3. five minutes later, trending revalidates and returns the original list — without it;
4. `setTracks` re-anchors by id, does not find it, and sets `cur: -1`;
5. the bottom player bar, which depends on `cur >= 0`, disappears;
6. **the audio keeps playing**, because the audio element has nothing to do with any of this.

A player with no controls and sound coming out is one of the worst possible states, and it would
have been born from the apparently harmless decision to use the query cache as a place to store a
track. The fix is to compose **after** the query: `comFaixasAvulsas(query.data, avulsas)` in a
`useMemo` (`packages/web/src/query/catalog.ts:54`), returned as `{...query, data}`. No consumer
knows — they all read `data.tracks`.

## Two implementation details worth reading

**The toast keeps its timer outside the state.**`flash(msg)`
(`packages/core/src/stores/ui.ts:106-110`) holds the timer handle in a closure and clears the
previous one before creating a new one. A new message **replaces** the old instead of queueing, and
the timer does not pollute the state components subscribe to. Keeping the timer in the store would
make every toast trigger a re-render for anyone watching the whole store.

**One action with a product rule inside.**`setWallImage` (`packages/core/src/stores/ui.ts:127-133`)
is the only action that does more than assign: if the background is opaque, it lowers opacity to
0.8. The reason is written down: uploading a background image with an opaque background would show
nothing. It is a product rule in the right place — in the domain, testable without a DOM, and not in
a component's `onChange`.

Opacity and blur limits are also clamped **inside** the actions
(`packages/core/src/stores/ui.ts:124-125`), not in the interface. An out-of-range value is not an
input field's problem; it is the state's problem.

## What was rejected

| Option | Why not |
|---|---|
| Storing only `cur` (index) | Signing in inserts tracks at the front; the player would show one track and play another |
| Storing only `curId` (id) | The engine and the queue work with positions; the conversion would happen everywhere |
| Numbering rows by the visible slice | The same number would mean different tracks per tab, and `:08` would stop being an address |
| React-flavoured Zustand for the domain stores | The imperative controller does not run inside React |
| Redux | More ceremony for the same result; and nothing here needs time travel |
| Context API for player state | Re-renders the tree and does not work outside React |
| Direct-link tracks in the query cache | The next trending refetch would drop them mid-listen, leaving a player with no controls and sound |
| Download progress in the persisted snapshot | An IndexedDB write every 150 ms |

## What it cost

**Two fields for the same thing.**`cur` and `curId` coexist, and anyone touching the player has to
know the id is the source of truth. It is documented in the store, but it is a trap that took three
bugs to become explicit.

**Eight stores is a lot of surface.** The split is justifiable one by one — four in the domain
because they must run without React, four on the web because they are interface — but it is more
state to hold in your head than a single store.

**The boundary between the two libraries has an exception.** Direct-link tracks are outside the
query cache for a good reason, and "it is outside because X" is one more fact somebody has to learn.

**Sparse numbers in a filtered list.** In `~/biblioteca --curtidas`, rows show `03`, `17`, `42`. It
is odd the first time and correct the second: that number is a catalogue address, not a count of the
screen.

## In an interview

**"How do you handle a list that changes size while something points into it?"** By storing ids in
state and deriving the index at the moment of use. Here the problem is concrete: signing in inserts
the private library's tracks at the **front** of the catalogue, so every position shifts. I store
`cur` and `curId`, and on a list change I re-anchor `cur` by id. Without that, the player shows one
track and plays another. That same mistake came back three times in this project under different
names.

**"Why vanilla Zustand and not the hooks version?"** Because half the player's actions do not come
from React — they come from keyboard shortcuts, audio element listeners and Media Session. With
vanilla stores, the imperative controller reads state with `getState()`. The typed hooks are a
four-line layer on the web side, for components only.

**"You have TanStack Query and Zustand. Where is the boundary?"** Query handles data that comes from
outside and goes stale; Zustand handles session data, which has no server version to reconcile. The
boundary pays a real debt: the catalogue key is scoped by session, so signing out discards the
signed-in catalogue instead of leaving private-track metadata on the device waiting for the next
guest.

**"Have you ever made a caching decision that was going to go wrong?"** Yes, and I caught it before
shipping. A track opened by direct link, injected into the query cache, would be dropped by the next
trending refetch. The chain is: the track leaves the list, the re-anchor does not find the id, `cur`
becomes `-1`, the player bar disappears — and the audio keeps playing. A player with no controls and
sound. The fix was composing the extra track **after** the query, in a `useMemo`.

**"Where do you put validation of state values?"** Inside the store action, not the component.
Opacity and blur are clamped in `set`, and the product rule that lowers opacity when someone uploads
a background image lives there too — because it is a domain rule, testable without a DOM, not a
detail of a control's `onChange`.
