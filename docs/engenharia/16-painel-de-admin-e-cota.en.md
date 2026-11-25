---
title: "Taking product decisions out of the ConfigMap"
date: 2026-11-23
description: "Letting one person into ondas took a commit to the infrastructure repository, a sync and a restart. That became an administration panel separate from the PWA, with the three product decisions in the database and a per-account storage quota that, for now, only measures."
slug: "ondas-admin-panel-and-quota"
draft: true
tags:
  - administration
  - authorization
  - modelling
---

To let one person into ondas I edited a list of e-mails in the ConfigMap, in the infrastructure
repository, waited for Argo and restarted two pods. Two lists, in fact: `SIGNUP_ALLOWLIST` so they
could skip review and `INGEST_DESTINOS` so the bot could publish to them. One afternoon I did it
twice in a row, and it became clear that the question "who may" was in the wrong place.

## Configuration is what the operator decides; data is what the admin decides

`INGEST_MAX_MB` is configuration: it changes with the node's capacity, it is the same for everyone,
and it belongs next to the volume's `sizeLimit`. "This person may sign up" is none of that — it is a
fact about a person, it changes day to day, and I want to change it from my phone.

Migration `0012` moves the three product decisions into the database:

| Was (env) | Became | Where |
|---|---|---|
| `SIGNUP_OPEN` | key `cadastro_aberto` | table `config` |
| `SIGNUP_ALLOWLIST` | one **invite** per e-mail | table `convites` |
| `INGEST_DESTINOS` | `recebe_do_bot` on the account | column in `users` |

The invite gained something the allowlist never had: it says **what the account is born with**
(`pode_enviar`, `recebe_do_bot`). Before, really letting someone in was three steps in two places —
allowlist, wait for the sign-up, `ondasctl contas envio on`. Now it is one invite. And it is
consumed at sign-up: no approval is left lying around in the list.

### The import that happens once

The deploy could not change anything for anyone. `admin.ImportarEnv` runs when the API boots, in a
transaction locked by a marker (`env_importado`): it copies what the env said and never looks at it
again — including when the env says the opposite of what the admin already decided on screen, which
is exactly when re-importing would do damage.

One case needed a decision: an e-mail in `INGEST_DESTINOS` **with no account and no invite**.
Creating an invite for it would pre-approve a sign-up the env never approved — being on the
destinations list never let anyone skip review. Those are dropped and logged.

## The panel is a different application

[Document 15](15-cadastro-e-administracao.en.md) rejected an admin role in `users` for two reasons:
the power to approve accounts would live in the session cookie, and the PWA would ship
administration code in the bundle every visitor downloads. Both still hold, and the panel undoes
neither:

- **It is another package, another image, another host** (`packages/admin`,
  `ondas-admin.thiagotn.com`). The admin HTTP client lives there, not in `@ondas/core`.
- **The admin is still not a user.** The credential is the same admin token `ondasctl` uses.

What changed is where the token sits while the screen is in use. Keeping it in `localStorage` would
put it within reach of any script on the page. So `POST /api/admin/sessao` trades it for a cookie:

| Attribute | Value | Why |
|---|---|---|
| `HttpOnly` | yes | scripts cannot read it |
| `SameSite` | `Strict` | no legitimate flow reaches the panel from another site; this is the CSRF defence |
| `Path` | `/api/admin` | the rest of the API never receives it |
| lifetime | 12 h | a forgotten device stops being admin by itself |

The key that signs this cookie combines `SESSION_SECRET` with the admin token's hash. Rotating the
token drops the panel's sessions; and a user cookie does not verify here even when renamed — a test
tries both directions (`TestCookieDoPainelEDeUsuarioNaoSeMisturam`).

The Ingress for the panel's host routes only `/api/admin`. The user session and the admin session
live on origins that cannot see each other.

### The brake that does not lock the owner out

The admin attempt limiter counted every request and reset on success — fine for a CLI, which makes
one request at a time. A panel opens a screen with three requests in parallel, and asks "am I in?"
with no credential at all every time it is opened signed out. It now counts only the **wrong
credential**: a rejected token or a forged cookie. A valid request and a request with no credential
cost nothing.

### Filter, sort, theme and language: all in the browser

Lists filter by text and sort by column **on the client**, over the rows the API already sent
(`packages/admin/src/lista.tsx`). That is the right call for the size the panel has — dozens of
accounts, up to 200 tracks per request — and it avoids a second query language on the server. The
limit is stated on screen: on a list the server truncates, filtering and sorting do not reach what
was left out. Filters that **change what the API sends** (account status, ingestion status,
"largest"/"newest" for tracks) are still new requests, and are kept apart from the search on
purpose. The view lives in the address (`?q=…&ord=-usado`): reloading and going back preserve it.

Theme and language are the PWA's — themes come from `THEMES`/`themeCssVars` and the phrase engine is
the core's — but the **phrase catalogue belongs to the panel package**: the core ships in every
visitor's bundle, and administration phrases should not get there. Both preferences live in this
host's `localStorage` (`prefs.ts`). There is nobody to inherit from: the admin token has no
identity, and the PWA's `localStorage` belongs to another origin. Switching language reloads the
page, for the same reason as in the PWA (module-level language, fixed at boot).

What is **not** translated: whatever the server wrote as data — the error phrase of an ingestion,
the detail of a history event, a plan's name. An API request error is translated by its code when
the app catalogue knows it; otherwise the server's Portuguese phrase is shown.

## Quota: the model before the billing

Uploads cost storage, and the "commercial format" of that is still undecided. What can be decided
now is the shape of the data, so that billing, when it arrives, only has to **write** to it:

```
account quota = planos.cota_bytes + users.cota_extra_bytes
```

The plan is what renews (a subscription changes `users.plano_id`); the extra is what is bought once
and stays (a one-off purchase adds to `cota_extra_bytes`). The `planos` table does not know what a
price or an expiry date is — it answers only "what is the quota".

The quota is **computed**, not copied: changing a plan's quota takes effect at once for every
account on it.

### Measure before refusing

In 1.11 nothing was refused: the number showed up in the panel and in each account's
`ondas whoami`, and that was all. Blocking before seeing the real numbers would be picking a limit
in the dark.

Refusal arrived in 1.12, together with the reason for it to exist — every account became able to
bring in tracks by itself, by link ([document 17](17-faixa-por-link.en.md)). It is an admin switch
(`cota_bloqueia`, on the plans screen), not a fixed rule: if the number turns out wrong, it is
turned off without a deploy. A failure to READ the quota refuses nobody — it is a ceiling on
growth, and a flickering database must not become "no space" for someone who has some.

For the number to match what the bucket charges for, cover art now counts (`tracks.art_bytes`). The
worker always measured the cover when uploading it and threw the result away; older tracks are
filled in by `worker medir-capas`, which asks R2 for the size (HEAD) without downloading anything.

The refusal sits on every way in: the upload slot request and the upload finalisation
(`httpapi/upload.go`), the ingestion request (an account already at its limit is not even queued),
the slot for the file the node downloaded (`httpapi/paginas.go`) and the worker after downloading a
URL — the only moment the size of a URL ingestion is known, and there the failure is final:
repeating the download creates no space. In all of them, the account that counts is the one that
will **own** the track, not the one that asked.

With refusal in force, the way out was missing: until 1.13 only the admin could delete a track, so
a full account depended on them. In 1.14 people delete from their own archive in the PWA (the
`DELETE /api/acervo/{id}` route already existed, session-only and owner-only), and the same track no
longer enters twice — which was quota spent for nothing ([document 10](10-ingestao-e-ssrf.en.md),
"Duplicate tracks").

## What was discarded

| Alternative | Why not |
|---|---|
| An `/admin` area inside the PWA | The two reasons from document 15: power in the session cookie, admin code in the public bundle |
| A mesh-only panel (Tailscale) | It was my recommendation; the choice was being able to open it from anywhere. The cost is an exposed sign-in screen, protected by the token |
| Token in `localStorage` | Within reach of scripts. The `HttpOnly` cookie costs one route |
| `users.limite_bytes` directly, no plan | It would work today and force a migration the day a second plan exists |
| Copying the plan's quota onto the account | Changing a plan would become a mass UPDATE, and the two copies would drift |
| Blocking uploads in the same version that measured | Without having measured, the limit would be a guess — blocking came one version later |

## Costs accepted

- **The admin screen is public.** A 256-bit token, a per-IP brake, a restricted cookie — but it is a
  surface that did not exist before.
- **No admin identity.** The history (`admin_eventos`) records what, when and from which IP; it does
  not record who. With a single admin, that is all there is.
- **`/api/admin` is still reachable through the PWA's host**, which is how `ondasctl` talks to it.

## In an interview

**"What goes in the ConfigMap and what goes in the database?"** What changes with the
infrastructure and is the same for everyone goes in the ConfigMap. What is a fact about a person, or
changes day to day, goes in the database. The symptom of getting it wrong is deploying to serve one
user.

**"How did you move configuration into the database without changing behaviour?"** A one-off import
at boot, transactional, with a marker that is also the lock against two replicas. After it the env
is ignored, and only then does it leave the cluster.

**"Why a cookie if the admin already had a token?"** Because a token in a browser tab has to live
somewhere, and everywhere JavaScript can read is reachable by an XSS. An `HttpOnly`, `Strict` cookie
restricted to `/api/admin` and signed with a key that includes the token's hash gives the same
credential without leaving it readable.

**"How do you model a quota without knowing how you will charge?"** By separating what renews from
what accumulates. A plan with a quota plus a per-account extra covers subscription and one-off
purchase without the table knowing what money is.
