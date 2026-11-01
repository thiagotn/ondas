---
title: "A file's path never comes from the request"
date: 2026-10-19
description: "A private bucket, the owner inside the object key, uploads straight from the browser via a presigned URL — and the size check that happens three times because the signature is valid for fifteen minutes."
slug: "ondas-private-library-r2"
draft: true
tags:
  - security
  - go
  - architecture
---

Ondas' personal library is audio files in a private bucket. None of them has a public URL; the only
way to read an object is a signature issued by the API, with an expiry
(`api/internal/storage/r2.go:1-3`).

That creates a set of problems that do not exist when files are public: who can request the
signature, how long it lasts, and — the central problem of this document — **how you decide which
file the request is talking about**.

## The problem: an identifier becomes a path if you let it

The naive way to do uploads is to let the client say where to write. The slightly less naive way is
to let the client say an identifier and have the server build the path from it. Both have the same
defect: **the path ends up derived from something the request sent**.

And in a multi-user system — even with a single user — the path is the authorisation boundary. If
two clients holding the same identifier can point at the same object, authorisation is just the `if`
somebody remembered to write.

## The decision: the key is derived from the authenticated subject, twice

There are three prefixes in the bucket:

```
u/<userID>/a/<trackID>.<ext>          audio
u/<userID>/art/<trackID>-<side>.jpg   artwork
stage/<userID>/<uploadID>.bin         upload staging area
```

Two deliberate properties (`api/internal/storage/r2.go:116-125`):

**The owner goes at the front of the key.** The boundary is legible in the bucket, not only in the
database. You can list what belongs to whom without querying Postgres, and an authorisation bug
shows up as an object in the wrong place rather than a row in the wrong place.

**No email or name.** Keys appear in logs and error messages; an opaque identifier, not personal
data.

And the part that matters: the upload key is **rebuilt from the authenticated user** in two
independent places.

First in the API, when finalising an upload (`api/internal/httpapi/upload.go:110-113`):

> A key é derivada do dono AUTENTICADO — sessão ou token —, não de nada que o cliente mandou: não
> existe pedido capaz de finalizar o envio de outra pessoa. Dois clientes com o mesmo id de envio em
> mãos apontam para duas keys diferentes, uma na área de cada um.

That last sentence is the mental test I started applying: *if two clients send the same identifier,
do they reach the same object?* Here the answer is no, by construction rather than by checking.

Then in the worker, when reading the bytes (`api/internal/worker/worker.go:257-261`):

> A key do envio é RECONSTRUÍDA do `user_id` do job; o que está guardado na linha é só um id (ver
> acervo.FonteUpload). É essa reconstrução, e não o middleware da API, que protege esta fonte: uma
> fonte adulterada no banco não vira caminho que o worker obedece, porque o worker nunca lê um
> caminho — ele monta o dele a partir do dono do job.

That closes a vector the middleware does not cover. If someone could write to the queue's
`source_url` column — by injection, by a bug in another route, by database access — an arbitrary
path there would lead the worker nowhere, because it does not use what is written. The column holds
`upload:<uuid>`, and the prefix is decoded by a function that returns only the identifier
(`api/internal/acervo/jobs.go:25-32`).

It is defence in depth at almost zero cost: two lines that build a string instead of reading one.

## The upload in three steps

The protocol is documented at `api/internal/httpapi/upload.go:17-25`:

1. `POST /api/acervo/upload` — the API reserves a slot and returns a **presigned PUT URL**;
2. the browser writes **straight to the bucket**;
3. `POST /api/acervo/upload/{id}/finalizar` — the API checks it and queues the ingestion.

From step 3 onward it is the same queue as URL ingestion: same worker, same status polling.

Why the bytes do not pass through the API (`api/internal/storage/r2.go:130-144`): the tunnel has a
~100 MB per-request ceiling and the uplink is residential — going through the middle would spend the
home upload bandwidth **twice**, client to cluster and cluster to bucket.

And the warning worth repeating, from the same comment:

> A URL devolvida é **CREDENCIAL DE ESCRITA** no bucket pelo prazo da validade. Trate-a como
> segredo: ela não deve ir para log nem para a saída de um programa que outra coisa vá ler.

It is the kind of thing you forget because "it is just a URL". A presigned PUT URL with a 15-minute
validity *is*, for those 15 minutes, write permission to a bucket path. It does not appear in access
logs, is not echoed in error messages, and is not printed by any of the operations subcommands.

### Why fifteen minutes

`api/internal/httpapi/upload.go:42-44`: the window has to cover the **whole** upload, and 15 minutes
for 60 MB still works on a ~70 kB/s connection. It is sized by the worst plausible link, not the
average case.

### Three checks of the same size

This looks like redundancy and is the most instructive part of the flow.

| Where | When | Why |
|---|---|---|
| `POST /upload` | before uploading | Refuses with **413** at reservation time — letting somebody upload 500 MB only to then hear "no" would be cruel to their uplink (`api/internal/httpapi/upload.go:69-71`) |
| `POST /finalizar` | after uploading | The presigned URL **does not limit bytes**; whoever lied in step 1 is caught here (`api/internal/httpapi/upload.go:130-132`) |
| in the worker | when reading from the bucket | The signature is valid for 15 minutes: the file may have been **swapped for a larger one** after the check (`api/internal/worker/worker.go:276-279`) |

The third is an explicit TOCTOU, and the consequence of not having it is written down: the worker's
1 GiB temporary disk fills up and the pod dies. Between "check" and "use" there is a 15-minute
window in which the write credential is still valid — so whoever uses it has to check again.

It has its own test: `TestEnvioTrocadoPorArquivoMaiorEhRecusadoPeloWorker`.

## The abandoned-upload sweep

An upload that went through and was never finalised — the person closed the tab — sits in the bucket
paying for storage with no database row pointing at it (`api/internal/storage/r2.go:186-188`).

The sweep lists the `stage/` prefix and deletes anything older than 24 hours
(`api/internal/worker/worker.go:227`). How the window was sized is reasoning worth copying:

> Folgado de propósito: o pior caso de um job legítimo é 3 tentativas com recuperação de travado a
> cada 15 minutos — menos de uma hora. 24h não corre risco de apagar arquivo que ainda vai ser
> ingerido.

That is: the cleanup window was derived from the worst case of the process it could run over, with
an order of magnitude of slack. It is also why the `stage/` prefix is separate rather than
`u/<owner>/stage/` — the sweep lists only the staging area, without walking the whole library
(`api/internal/worker/worker.go:176-178`).

It runs hourly, not every worker cycle, because listing the bucket every 5 seconds would mean paying
for a list request to almost always find nothing. And it **starts on the very first cycle**, so a
restart picks up whatever was left from the previous run (`api/cmd/worker/main.go:135-138`).

## The order of deletion

`removerFaixa` (`api/internal/httpapi/acervo.go:211`) deletes the database row **first** and the
three R2 objects afterwards, best-effort. If the R2 cleanup fails, the object is orphaned but the
user's library is already correct; the error goes to the log, not to the response
(`api/internal/httpapi/acervo.go:227-229`).

The reverse order — objects first, row second — would produce the worse state: a track that appears
in the list and does not play. Between "invisible rubbish in the bucket" and "broken entry on
screen" the choice is easy, and it is the same principle that makes the worker clean up objects when
the row write fails (`api/internal/worker/worker.go:213-217`).

The read query follows the same care: `PorID` filters by user **in the SQL predicate**, not in an
`if` after the read (`api/internal/acervo/tracks.go:76-78`) — otherwise another owner's id would
leak metadata before the check.

## Two rights over the same row

Until migration `0007` the library had one owner and one question: *is it yours?* Sharing tracks
split that question in two, and **conflating them is the bug the surrounding code exists to
prevent**:

| Right | Who has it | Where it lives |
|---|---|---|
| **listen** | the owner, OR any account if the track is `todos`, OR whoever was granted it | `condicaoAudivel` |
| **touch** (delete, share, change visibility) | the owner only | `PorID`, `Remover`, `AplicarCompartilhamento` |

Two mechanisms because they are two product questions. "Publish for everyone who has an account
here" is a property **of the track** — the `tracks.visibilidade` column (`privada`|`todos`) — and
"publish only for this person" is a **relation** between the track and someone — the `track_shares`
table.

`visibilidade = 'todos'` is a **live** rule: an account created tomorrow already sees what was
marked today. The alternative — writing one grant per existing account at publish time — would
freeze the past, and whoever arrived later would start out seeing nothing.

The right to listen exists as **a single SQL fragment**, `condicaoAudivel`
(`api/internal/acervo/tracks.go`), reused by the listing and by the signed redirect. That is not
keystroke economy: a second copy of the rule would produce one of two symmetric bugs — a track that
**shows in the list and will not play**, or one that **plays and does not show**. That is exactly
what `audio` and `arte` would have done had they stayed on `PorID`, and
`TestFaixaDeTodosApareceEtocaParaAOutraConta` asserts both halves on purpose.

The right to touch needed no code at all: `Remover` always filtered by owner in SQL, so "the
recipient does not delete the sharer's track" came for free — the `DELETE` finds no row and the
answer is 404. **Because it came for free, it has a test**: nothing in the code says it out loud.

And 404 rather than 403, by the rule that already applied: to a non-owner, the track does not exist.
A 403 would confirm the id.

### The FK that `likes` could not have

`track_shares` references `tracks` with `ON DELETE CASCADE`, and the contrast with migration `0006`
explains both tables. A like almost always points at an Audius track, which exists in no `tracks`
row — an FK there would make the common case impossible, and the price was `removerFaixa` deleting
the like by hand. A grant only ever points at a library track, so the FK is free.

The PK differs too, for the opposite reason. In `likes` the key `(user_id, track_id)` doubled as the
index because the question was "mine". Here every listing asks "shared **with me**", and with
`track_id` leading, the PK does not serve it — hence the separate index on `user_id`.

A side effect became a requirement: `likes.RemoverFaixa` deletes by track and **without an owner**.
That was a detail while a track could only be liked by its own owner; with shared tracks, it is what
removes the recipient's like when the owner deletes the music.

## CORS as code, two shapes from one source

The bucket's CORS policy lives in Go (`api/internal/storage/r2.go:228-235`), and from it come the
**two** representations R2 accepts: the S3 protocol's XML and the Cloudflare dashboard's JSON.

The reason for a single source is written down: two copies of the same policy drift, and *"a
divergência aparece como 'o áudio não toca', longe daqui"* — the divergence shows up as "the audio
does not play", far from here. There is a test proving both outputs describe the same rule.

The policy is small and every field has a justification (`api/internal/storage/r2.go:237`):

| Field | Value | Why |
|---|---|---|
| Methods | `GET, HEAD, PUT` | `PUT` arrived with the upload screen, so bytes do not cross the tunnel |
| Allowed headers | `range`, conditionals, `content-type` | `range` is what enables seeking; conditionals let the browser revalidate instead of re-downloading |
| Exposed headers | `content-length`, `content-range`, `accept-ranges`, `etag` | Without exposing them, the offline download's JavaScript cannot read the size and the progress bar goes blind |

The non-obvious part is **why a GET needs CORS here at all** (`api/internal/storage/r2.go:220-226`):
the player uses `crossOrigin='anonymous'` on the audio element, which puts the redirect's final
response under CORS checking; and the offline download uses `fetch` and reads `res.body`, which
requires a non-opaque response. Without the policy the audio simply does not play — and the console
error does not point at the bucket.

### And why the policy is applied by hand

Here is a security decision that runs against the instinct to automate everything
(`api/internal/storage/r2.go:255-262`):

> Existe porque aplicar CORS é **configuração de bucket**, e isso exige token
> `Admin Read & Write`, que na Cloudflare é de CONTA INTEIRA e não dá para escopar a um bucket.
> Um token assim guardado no cluster seria pior que uma colagem no painel […]

So the `worker cors` subcommand **prints** the JSON to paste into the dashboard rather than applying
it. The token the app carries stays `Object Read & Write` scoped to the bucket — the actual minimum
it needs.

The contrast is worth stating: automating that step would mean storing a credential capable of
reconfiguring the entire account in the cluster, in order to run an operation that happens once.
Pasting it manually is the **more** secure option, and it was chosen for that reason.

There is an interesting origin detail here: the `worker diag` subcommand was born from a wrong
diagnosis. CORS is the only administrative operation in the flow and it fails **even with good
credentials**, which leads anyone to suspect the credentials. `diag` exercises the credential end to
end — writes, measures, reads with `Range` via a signed URL, and deletes a throwaway object —
precisely to separate "bad credential" from "operation this credential cannot perform".

## What was rejected

| Option | Why not |
|---|---|
| A public bucket or an `r2.dev` domain | The library is private; an object readable without a signature voids authorisation |
| Upload bytes passing through the API | ~100 MB tunnel ceiling and residential upload bandwidth spent twice |
| The object path supplied by the client | The path is the authorisation boundary; it has to be derived from the authenticated subject |
| The path stored in the database and read by the worker | A tampered row would become an obeyed path; the worker builds its own from the job's owner |
| Checking size only at `finalizar` | The signature is valid for 15 minutes; the file can be swapped for a larger one afterwards |
| `stage/` inside `u/<owner>/` | The sweep would have to walk the whole library to find the staging area |
| Deleting objects before the row | Would produce a track visible in the list that does not play |
| Applying CORS from the cluster | Would require an account-wide token stored for an operation that runs once |
| Sweeping abandoned uploads every cycle | A bucket list request every 5 s to almost always find nothing |

## What it cost

**One manual step in provisioning.** The CORS policy is pasted into the dashboard. It is documented
and there is a subcommand that prints exactly what to paste, but it is a human step — and therefore
a forgettable one. The symptom of forgetting is "the audio does not play", which does not point at
the bucket.

**Orphaned objects are possible.** R2 cleanup is best-effort, and the sweep only covers the staging
area. An audio object whose `DELETE` failed stays there, invisible, paying for storage.

**The size check in three places is repeated code** that looks redundant in review. The test
guarding the third one exists to explain why it is not.

**Authorisation lives in two places by construction** — the key derivation in the API and the
reconstruction in the worker. It is defence in depth and also one more point to keep consistent.

## In an interview

**"How do you upload large files to object storage?"** A presigned PUT URL, with the bytes going
from the browser straight to the bucket. The API only reserves the slot and, afterwards, checks and
queues. In my case the reason is concrete: the tunnel has a ~100 MB per-request ceiling and the
uplink is residential — going through the middle would spend the home upload bandwidth twice.

**"How do you ensure one user cannot write into another's area?"** The object key is derived from
the authenticated user, not from anything the request sent. The mental test is: if two clients send
the same upload identifier, do they reach the same object? Here they do not, because each resolves
to `stage/<owner>/<id>.bin` in their own area. And the derivation is redone in the worker from the
job's `user_id` — what is stored in the database is only an opaque id, so a tampered row does not
become an obeyed path.

**"You check the file size. Where?"** In three places, and the third is the one people forget. At
reservation, to refuse with 413 before the upload. At `finalizar`, because the presigned URL does
not limit bytes and whoever lied gets caught there. And in the worker, because the signature is
valid for fifteen minutes and the file may have been **swapped for a larger one** after the check —
that is TOCTOU, and without the third check the pod's temporary disk fills and the process dies.

**"Why is a presigned URL a secret?"** Because for the length of its validity, it **is** the
permission. A PUT signature valid for fifteen minutes is write permission to that path for fifteen
minutes, for whoever holds the string. It does not go to logs, is not echoed in errors, and no
operations subcommand prints it.

**"Did you automate the bucket configuration?"** Deliberately not. Applying a CORS policy is bucket
configuration and requires an administrative token which, on that provider, is **account-wide** and
cannot be scoped. Storing that in the cluster to run an operation that happens once would be worse
than pasting JSON into a dashboard. So I have a subcommand that **prints** the policy, generated
from the same code that produces the XML version, with a test proving the two do not diverge. The
app's token keeps object-level permission, scoped to the bucket.

**"In what order do you delete a track?"** Row first, objects second, best-effort. The reverse would
leave a track visible in the list that does not play. Between invisible rubbish in the bucket and a
broken entry on screen, I choose the rubbish — and it is the same principle that makes the worker
clean up objects when the row write fails.
