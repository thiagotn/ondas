---
title: "Ondas' system design: three processes and a 302 that saves the home uplink"
date: 2026-10-19
description: "How a static PWA, a Go API and an ffmpeg worker divide the work so audio never crosses a residential tunnel — and which parts can fail alone without taking the others down."
slug: "ondas-system-design"
draft: true
tags:
  - architecture
  - system-design
  - infrastructure
---

Ondas runs on a single-node Kubernetes cluster, inside a house, behind a tunnel. That sentence is
the premise of almost the entire system design: the uplink is residential, the tunnel has a
per-request ceiling, and neither of those is negotiable. The rest is consequence.

There is an [interactive diagram](../arquitetura.html) in the repository — open the HTML, which is
where it earns its keep: you can walk the three scenarios, click a component to see only its links,
and trace the route between two points. This document is the reasoning behind it.

## The three pieces, and why there are three

| Image | What it is | Exposed? |
|---|---|---|
| `ondas` | nginx serving the static PWA | yes, at `/` |
| `ondas-api` | Go in a `scratch` image | yes, at `/api` |
| `ondas-worker` | Go + ffmpeg | **no** — no Service, no Ingress |

The PWA **talks to no backend** in order to work. Public catalogue metadata goes straight from the
browser to the Audius API; downloaded tracks live in the device's Cache API. The API exists only for
what is private: real accounts and the personal library.

That means the split is not "frontend and backend". It is **public and private**, and the boundary
landed somewhere with a pleasant consequence: anyone who never created an account is using a system
that is just an nginx serving static files.

The worker is separate from the API for two reasons that compound. The first is operational:
downloading an arbitrary URL does not fit inside the HTTP server's 15 s `ReadTimeout`
(`api/internal/db/migrations/0002_acervo.sql:24-26`). The second is surface area: the worker needs
ffmpeg, and the API is the process that accepts connections from the internet. Splitting keeps **the
large dependency in the process nobody can reach from outside** — the API image is `scratch`, two
files and no shell.

## The API lives on the same origin, and that is not a deployment detail

`api/internal/httpapi/server.go:66-67` records:

> **Não há CORS**: a API é servida na mesma origem da PWA (um path a mais no Ingress), o que também
> evita preflight.

Same origin buys three things at once: the session cookie is same-site, there is no *preflight* on
any request, and — the part that decides the entire authentication scheme — **an `<audio>` or
`<img>` tag carries the cookie by itself**. Since neither accepts headers, a header token would
authenticate the catalogue and play no track at all. That reasoning is laid out in full in [document
08](08-auth.en.md).

At the Ingress, `/api` is routed **before** `/`, and there is no prefix stripping: the API's routes
contain `/api` themselves. A prefix stripped at the proxy is an invisible coupling between the
manifest and the code, and it does not exist here.

## Audio never passes through the house

This is the system's central decision. `api/internal/httpapi/acervo.go:159-164`:

> Os bytes não passam pelo homelab: o link é residencial e o túnel tem teto de ~100MB por
> requisição (ADR 0007). O que passa é um 302 de ~1KB. E como a assinatura é feita a cada
> pedido, ela nunca vence dentro do cache do catálogo.

`GET /api/acervo/{id}/audio` does not serve the file. It checks the session, resolves the owner's
track, signs a temporary bucket URL and answers **302** with it in `Location`. The browser follows
the redirect and then requests byte ranges straight from R2.

What that solves, in order of importance:

1. **The tunnel's ceiling stops existing** for this use case. A one-hour set is ~120 MB and never
fits in a single request; in chunks requested from the bucket, it always fits.
2. **The home upload bandwidth is not consumed.** Serving audio through the cluster would spend the
residential uplink once per listener.
3. **`Range` works for free.** Seeking mid-track is a range request R2 serves natively — something I
would otherwise have to implement by hand.

And two things the design forces you to handle:

**The signature expires, and the catalogue is cached.** The signed URL is valid for one hour, but
the catalogue stays 24 h in the browser. So the signed URL **never** goes into the catalogue: the
JSON always carries the internal address `/api/acervo/<id>/audio`, and the signature is minted on
every play (`api/internal/httpapi/acervo.go:23-24`). Storing the signature in the catalogue would
make audio stop playing after an hour with the app open.

**The 302 must not be cached by anyone.** It carries a time-limited credential; a proxy that stored
it would hand one session's URL to another. The response goes out with
`Cache-Control: private, no-store`, and there is a dedicated test for it
(`api/internal/httpapi/json.go:16-18`).

Why one hour and not five minutes? Because the window has to cover the whole listen: the browser
follows the 302 once and then requests ranges against whatever URL it landed on. Too short breaks
seeking for someone who paused and came back (`api/internal/config/config.go:47-49`).

## Three failure domains that do not contaminate each other

The system is designed to degrade in pieces, and each piece has declared behaviour.

**API down.** The PWA stays whole for the public catalogue; only the private library drops off the
list. That is not an accident: `loadCatalog` fetches both sources in parallel and handles each
failure in isolation (`packages/core/src/catalog/resolve.ts:54-66`) — whichever fails **leaves the
list** instead of becoming an error screen.

**R2 without credentials.** The API starts normally and only the library answers 503
(`api/internal/httpapi/server.go:50-61`): *"Credencial presente mas inválida é erro de configuração,
não motivo para derrubar o login de quem já tem conta."* The worker, in the same scenario, does the
**opposite** — it fails loudly and restarts, because without R2 it has nothing to do
(`api/cmd/worker/main.go:84-88`). The asymmetry is intentional: in a process serving users, partial
silent failure is better; in a batch worker, the restart loop *is* the signal.

**Database down.** Here the asymmetry is between the two probes: `/api/healthz` answers without
touching the database, and `/api/readyz` does a `Ping` with a 2 s deadline
(`api/internal/httpapi/server.go:145-146`). The point is to stop a momentary Postgres outage from
making the orchestrator **kill** the process instead of merely taking it out of the load balancer.
It is one of the most common Kubernetes misconfigurations, and the fix is choosing different probes.

**Audius down.** The public catalogue has three levels
(`packages/core/src/catalog/resolve.ts:75-91`): live API → locally cached metadata, if less than 24
h old → a 12-track demo catalogue. The 24 h window exists for a specific, non-obvious reason: Audius
artwork is served by the node holding the file, not by a CDN, and **stale metadata becomes a list of
broken images** (`packages/core/src/catalog/resolve.ts:11-15`).

## The link preview, and a `proxy_pass` that does not exist

The PWA is static, so the bot unwrapping a link in WhatsApp would receive HTML with nothing about
the track. The solution has two parts.

In nginx, a User-Agent `map` recognises eighteen known bots and **only they** are sent to the
preview route (`packages/web/nginx.conf:33-36`). Humans keep getting `packages/web/index.html` and
the SPA.

And the forwarding is a **302, not a `proxy_pass`** (`packages/web/nginx.conf:86-95`). The reason is
good enough to become a general rule: nginx resolves the upstream name **at start**, so pointing at
the API service would put the PWA pod into a crash loop whenever the API's DNS failed. Today an API
outage degrades only the private library; with `proxy_pass`, it would take the static site down too.
The redirect re-enters through the Ingress — which already routes `/api` — and the PWA image stays
unaware of any cluster service name.

For private-library tracks the preview is generic and **identical for any id**, without touching the
database (`api/internal/httpapi/og.go:93-95`): a distinguishable 404 would already tell a stranger
that a given identifier exists.

## Where state lives

| State | Where | Note |
|---|---|---|
| Accounts, library tracks, ingestion queue | Postgres | one database and role per application |
| Library audio and artwork | private R2 bucket | no public domain; signed URLs only |
| Catalogue metadata | IndexedDB `ondas` | 24 h validity |
| Query cache | IndexedDB `ondas-query` | a separate database, on purpose |
| Downloaded tracks | Cache API `ondas-offline` | outside the Service Worker |
| Theme | `localStorage` | must be synchronous, before first paint |

The two separate IndexedDB databases have a concrete technical reason: `idb-keyval`'s `createStore`
only creates the object store when the database is born, so splitting the `ondas` database for the
query cache would fail with `NotFoundError` (`packages/web/src/query/client.ts:10`).

And downloaded tracks stay **outside** the Service Worker on purpose: the SW only precaches the app
shell, and audio is written and read exclusively by the offline store so that the library index and
the bytes on disk never diverge (`packages/web/src/sw.ts:9-16`). The detail is in [document
06](06-pwa-e-offline.en.md).

## A production lesson that changed the design

The API runs its migrations at process start. That worked until the first rollout, and
`api/internal/db/pool.go:47-56` holds what happened:

> Tudo corre sob um advisory lock porque dois pods sobem juntos em qualquer rollout (maxSurge)
> — e `CREATE TABLE IF NOT EXISTS` NÃO é atômico no Postgres: as duas sessões passam pela
> checagem de existência e uma estoura com duplicate key em pg_type. Foi exatamente o que
> derrubou o primeiro boot desta API em produção.

The fix was a `pg_advisory_lock` wrapping the whole migration sequence, on a single connection held
from start to finish, with an explicit unlock under a context that does not cancel. Document 10
covers the mechanics. What matters here is the design lesson: **"idempotent" and "concurrency-safe"
are not the same property**, and a rollout is where the difference shows up.

## What was rejected

| Option | Why not |
|---|---|
| Serving audio through the API | ~100 MB per-request tunnel ceiling, residential upload bandwidth, and `Range` to implement by hand |
| Signed URL inside the catalogue | The catalogue stays 24 h in the browser and the signature lasts 1 h |
| Public bucket or an `r2.dev` domain | The library is private; an object readable without a signature voids authorisation |
| `proxy_pass` from nginx to the API | nginx resolves upstreams at start; the PWA would crash-loop whenever the API's DNS failed |
| One process serving HTTP and ingesting | Arbitrary-URL downloads do not fit the read timeout, and the API would start carrying ffmpeg |
| Server rendering for the link preview | The PWA is static; the preview is a redirect to a route only bots receive |
| Audio in the Service Worker cache | Tracks are large and requested by `Range`; they would fill the app shell cache |
| Migrations in an initContainer | A second artefact to keep in sync; embedded in the binary there is none |

## What it cost

**Audio delivery depends on a third party.** If R2 goes down there is no plan B: the cluster does
not have the bytes. That is the price of not routing bytes through the house, and a trade I would
make again — but it is an external dependency on the critical path.

**The catalogue has two sources with independent failures, and that complicates state.** The list
changes size when you sign in and out, and because the user's own tracks go to the **front**, every
index shifts. That produced three distinct bugs before the pattern became clear: always store the
id, never the position. [Document 05](05-estado-e-stores.en.md) is about that.

**The User-Agent map is a list that ages.** A new bot gets the app instead of the card, and the
nginx comment accepts that explicitly: erring on the side of the app is the right failure.

**Rate limiting lives in the application because the cluster proxy cannot see the real client IP.**
It works, and it leaves the API holding a responsibility that is normally infrastructure's.

## In an interview

**"Draw the system."** Three processes. A static PWA served by nginx, which needs no backend for the
public catalogue — metadata goes straight from the browser to a public API. A Go API on the **same
origin**, under `/api`, handling only what is private: accounts and the personal library. And a
worker with no Service and no Ingress, pulling work from a Postgres queue, holding ffmpeg. State
lives in Postgres, in a private bucket, and in three browser stores.

**"How do you serve large files from a residential server?"** By not serving them. The audio route
answers 302 with a signed bucket URL valid for one hour. What crosses the home tunnel is a ~1 KB
redirect; the bytes go from the bucket straight to the browser, with native `Range`. That solves the
per-request ceiling, the upload bandwidth and seeking, all at once.

**"Why one hour and not five minutes?"** Because the window has to cover the whole listen. The
browser follows the redirect once and then requests byte ranges against the URL it landed on — with
five minutes, anyone who pauses and comes back loses seeking. And that is exactly why the signed URL
never goes inside the catalogue, which stays 24 h on the device: it is minted per play.

**"What happens when each part fails?"** API down: the public catalogue works, the private library
drops off the list — both sources are fetched in parallel and one failure does not contaminate the
other. R2 without credentials: the API starts and only the library answers 503, because a missing
secret must not take sign-in down; the worker, in the same scenario, fails loudly on purpose.
Database down: `readyz` fails and the pod leaves the load balancer, but `healthz` does not touch the
database, so nobody kills the process over a momentary outage.

**"What architectural mistake did you only find in production?"** Running migrations at process
start. It worked on the first deploy and broke on the first rollout, because two pods came up
together and `CREATE TABLE IF NOT EXISTS` is not atomic in Postgres — both sessions pass the
existence check and one blows up with a duplicate key. The fix was an advisory lock around the whole
sequence, on a single connection. The lesson was that idempotency is not concurrency safety.
