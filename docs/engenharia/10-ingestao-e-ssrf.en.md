---
title: "\"Send me a URL\": closing off a proxy to the internal network"
date: 2026-10-19
description: "The SSRF guard runs after DNS, with the chosen IP in hand, and applies to every redirect hop. Plus the SKIP LOCKED queue, a byte ceiling that distrusts Content-Length, and a CREATE TABLE that is not atomic."
slug: "ondas-ingestion-and-ssrf"
draft: true
tags:
  - security
  - go
  - postgres
---

The feature is simple to describe: send a URL, the system downloads the music and stores it in your
library. And it is one of the most dangerous things you can build, because it is literally *"make an
HTTP request wherever I say"* — executed by a process running **inside** the cluster.

`api/internal/ingest/baixar.go:16-19` names the threat model:

> Ele roda DENTRO do cluster: sem esta lista, "ingira esta URL" seria um proxy para os ClusterIPs
> (10.43/16), para o Postgres, para a malha Headscale (100.64/10) e para o servidor de metadados da
> nuvem. É SSRF clássico, e quem manda a URL é o bot.

This document is about that guard, about the queue carrying the work, and about three things you
only learn in production.

## The SSRF guard: validating the name does not work

The implementation almost everyone writes first is: resolve the name, check whether the IP is
private, then make the request. It has a hole with its own name — **DNS rebinding**. A host that
answers with a public IP on the first lookup and a private IP on the second passes any validation
done before the connection.

Ondas' guard runs somewhere else (`api/internal/ingest/baixar.go:71-76`):

> `controlar` roda DEPOIS do DNS e ANTES do connect, com o IP já escolhido. É aqui que a checagem
> tem de ficar, não só na validação do nome: um host que responde IP público na primeira consulta e
> privado na segunda (**DNS rebinding**) passaria por qualquer validação feita antes. Vale para todo
> salto de redirect, porque cada salto abre sua própria conexão.

It is installed as the `net.Dialer`'s `Control` (`api/internal/ingest/baixar.go:130`) — a hook Go
calls with the address already resolved, immediately before `connect`. There is no window between
the check and the use, because what is checked is the IP the connection will open against.

There are three layers, and each catches what the others do not:

| Layer | Where | Catches |
|---|---|---|
| URL validation | `api/internal/ingest/baixar.go:89` | non-HTTP(S) schemes, embedded credentials (`user:pass@`), a missing host, a private IP literal |
| The dialer's `Control` | `api/internal/ingest/baixar.go:77` | the real IP, on every connection opened — including each redirect's |
| `CheckRedirect` | `api/internal/ingest/baixar.go:135-142` | each `Location` target, with a 5-hop ceiling |

Two implementation details hold the design up:

**`DisableKeepAlives: true`** (`api/internal/ingest/baixar.go:133`). Without it, a reused connection
would not pass through `Control` again. Disabling reuse costs a handshake per request and guarantees
every connection is verified.

**The policy lives in a single field** (`api/internal/ingest/baixar.go:110-112`), because *"duas
cópias da regra divergem com o tempo"* — two copies of the rule drift over time. The public
constructor always uses the production policy; there is an unexported internal constructor the tests
use to allow the test server's loopback **without turning the guard off**
(`api/internal/ingest/baixar.go:119-122`) — the dialer still checks every connection, including each
redirect's.

That last part is a testing pattern worth stealing: the common alternative — a "disable validation
in tests" flag — would test different code from the one that runs in production.

### The eighteen ranges, and the three that surprise

The list is at `api/internal/ingest/baixar.go:20-39`, each entry commented with what it protects.
The obvious ones are loopback, the three private ranges, link-local (which includes
`169.254.169.254`, the cloud metadata service), multicast and reserved. There is also `100.64/10` —
CGNAT, where the homelab's private mesh lives.

The three that rarely appear in home-grown lists:

| Range | What it is |
|---|---|
| `64:ff9b::/96` | NAT64 — a path to private IPv4 by an indirect route |
| `2002::/16` | 6to4 |
| `2001::/32` | Teredo |

They are IPv6→IPv4 transition mechanisms. A list that blocks only private v4 and v6 loopback leaves
those three open, and through them `10.0.0.0/8` is reachable again. It is the kind of gap no
functional test catches.

The list is parsed at package load and **panics** on an invalid CIDR
(`api/internal/ingest/baixar.go:41-51`): a typo in the list does not reach production silently.

### The byte ceiling distrusts `Content-Length`

```go
io.Copy(destino, io.LimitReader(resp.Body, b.maxBytes+1))
```

One byte beyond the limit: if it arrives, the file is too large
(`api/internal/ingest/baixar.go:171-179`). Trusting `Content-Length` does not work — it can lie or
be missing.

The `+1` is the detail that separates "truncated without saying so" from "refused".

### ffprobe decides what the file is

The origin's `Content-Type` is a hint and nothing more (`api/internal/ingest/baixar.go:147-149`).
The decision belongs to `ffprobe` (`api/internal/ingest/midia.go:76`), and the acceptance bar is not
"what ffmpeg can read": it is the eight codecs **an `<audio>` tag plays in a current browser**
(`api/internal/ingest/midia.go:20-22`).

Accepting a `.wma` would mean storing a file the PWA could never play. It is a product validation
disguised as a technical one — which is why the list is short and enumerated by hand.

## The queue: a partial index and a `SKIP LOCKED`

Downloading an arbitrary URL does not fit inside the HTTP server's 15 s `ReadTimeout`
(`api/internal/db/migrations/0002_acervo.sql:24-26`), so ingestion is asynchronous. The queue is a
Postgres table, with no broker.

### Deduplication by partial index

```sql
CREATE UNIQUE INDEX ingest_jobs_ativo_idx ON ingest_jobs (user_id, source_url)
    WHERE status IN ('pending','processing')
```

The comment states the real problem (`api/internal/db/migrations/0002_acervo.sql:48-50`): *"Mesma
URL pedida duas vezes enquanto a primeira não terminou é a MESMA ingestão, não duas: o bot reenvia
quando o usuário toca no botão de novo ou quando o Telegram repete a entrega."*

The elegant detail is that the index is **partial**. Uniqueness only applies while the job is active
— which means the same URL can be re-ingested after it finishes, without deleting anything.
Unconditional uniqueness would forbid re-ingesting forever.

Queueing exploits that (`api/internal/acervo/jobs.go:114-115`):

```sql
INSERT INTO ingest_jobs (...)
VALUES (...)
ON CONFLICT (user_id, source_url) WHERE status IN ('pending','processing')
DO NOTHING
RETURNING ...
```

`DO NOTHING` with `RETURNING` **returns no row** when there is a conflict. The code reads the absent
row as "it already existed", fetches the active job and returns `novo=false` — and the handler uses
that to choose **202** (I accepted something new) or **200** (nothing new; the previous request
stands) (`api/internal/httpapi/acervo.go:274-279`).

There is an accepted fragility here: the `ON CONFLICT` predicate is written by hand and has to match
the index's **literally**. Drifting does not produce a compile error; it produces silent
duplication.

### Claiming without two workers taking the same job

```sql
UPDATE ingest_jobs SET status='processing', attempts=attempts+1, updated_at=now()
WHERE id = (
    SELECT id FROM ingest_jobs
    WHERE (status='pending' AND attempts < $1)
       OR (status='processing' AND updated_at < now() - $2::interval AND attempts < $1)
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING ...
```

`FOR UPDATE SKIP LOCKED` (`api/internal/acervo/jobs.go:144-149`) is the Postgres queue pattern: two
workers never take the same job, and neither one **waits** for the other. Without `SKIP LOCKED`, the
second worker would block on the locked row; with it, it simply takes the next one.

The `WHERE` 's second clause is the part I would have forgotten: it rescues a job stuck in
`processing` for more than 15 minutes — a worker that died mid-job. Without it, an OOM kill at the
wrong moment leaves a job in `processing` forever, invisible to the queue and never completed.

Retries live entirely in SQL. `Falhar` (`api/internal/acervo/jobs.go:178-180`) returns the job to
`pending` while attempts remain and ends it as `error` on the last — otherwise the worker would
retry a dead URL forever. There are three attempts, and the number has empirical justification
(`api/internal/acervo/jobs.go:18-20`): the failures that repeat here are almost always permanent
(dead URL, unplayable format); the temporary ones usually pass on the second try.

Polling every 5 seconds, not `LISTEN/NOTIFY`. For a queue receiving a few items a day, the cost of a
query every 5 s is lower than keeping a notification connection alive and reconnecting it.

## Three things you only learn in production

### 1. `CREATE TABLE IF NOT EXISTS` is not atomic

`api/internal/db/pool.go:47-56`:

> Tudo corre sob um advisory lock porque dois pods sobem juntos em qualquer rollout (maxSurge)
> — e `CREATE TABLE IF NOT EXISTS` NÃO é atômico no Postgres: as duas sessões passam pela
> checagem de existência e uma estoura com duplicate key em pg_type. Foi exatamente o que
> derrubou o primeiro boot desta API em produção.

The fix has three parts worth attention (`api/internal/db/pool.go:57`):

- **A single connection, from start to finish.**`pool.Acquire` rather than using the pool
(`api/internal/db/pool.go:61-67`): the advisory lock is session-scoped, so it has to be the same
connection that takes it, uses it and returns it.
- **Unlock under `context.WithoutCancel`** (`api/internal/db/pool.go:72-80`): *"Sem unlock
explícito o lock viaja com a conexão de volta para o pool e tranca o próximo boot. WithoutCancel
porque o unlock precisa sair mesmo quando é o próprio prazo acima que venceu."*
- **One transaction per migration**, containing the SQL and the record in `schema_migrations`.

The lesson that stuck: **idempotent and concurrency-safe are not the same property.** Every
migration was idempotent, and that was not enough.

### 2. `WithoutCancel` again, for a different reason

`api/internal/worker/worker.go:95-99`:

> **WithoutCancel de propósito**: o SIGTERM do rollout não deve abortar uma ingestão em curso — ela
> gastaria uma tentativa por um deploy. O laço acima é que para de pegar job novo […] O prazo por
> job continua, para que uma origem lenta não prenda o worker para sempre.

The pattern is: the outer loop respects cancellation and stops taking work; the in-flight job has
its own deadline and finishes. A naively propagated context would make every deploy consume one
attempt from each running job.

The honest consequence is worth noting: if the job's deadline expires, marking the failure can also
fail, and the job stays in `processing`. What rescues it is the queue's 15-minute timeout. The two
decisions lean on each other.

### 3. A `map[string]string` that broke the whole decode

At `api/internal/audius/audius.go:58-63`:

> Campos nomeados, e não um mapa de strings: `artwork` também traz `mirrors`, que é um ARRAY. Com
> `map[string]string` o decode INTEIRO falha nele e a faixa vira cartão genérico — foi o que
> aconteceu no primeiro deploy disto. **O TypeScript ignorava calado porque não valida em tempo de
> execução.**

This is the project's most transferable finding. The same JSON had been consumed for weeks by the
frontend without a problem, because a TypeScript `interface` is erased at build time and nothing
validates anything. When the consumption was ported to Go, the unexpected field became a decoding
error — and the symptom was "link previews stopped working", far from the cause.

Go is not being fussier out of pedantry: it is surfacing a problem that already existed and was
invisible.

## Artwork and peaks are best-effort, on purpose

Two ingestion steps can fail without failing the job. Peaks
(`api/internal/worker/worker.go:187-193`):

```go
picos, err := ingest.Picos(ctx, bruto, midia.DuracaoS)
if err != nil {
    log.Warn("forma de onda não medida", "erro", err)
    picos = ""
}
```

The reasoning: a track with no waveform draws a flat bar, and that is no reason to fail an ingestion
that already uploaded the audio. Same for artwork — each step (extract, measure, upload) fails with
a log warning and leaves the key empty (`api/internal/worker/worker.go:301`).

The difference between best-effort and failure is a product question: *without this, does the user
still have what they asked for?* For artwork and waveform, yes — they have the music. For the audio
file, no.

And there is a debt that created: tracks ingested before measuring existed ended up with no peaks.
The fix was a backfill subcommand, `worker repicos`, rather than re-ingesting — re-ingesting would
mint a new UUID, killing already-shared links and re-uploading a file that is already in the bucket.
The backfill changes **one 200-byte column**, and the `UPDATE` repeats the listing's condition
(`api/cmd/worker/repicos.go:64-71`) so it never overwrites a measurement newer than its own.

## Error messages have a policy

`api/internal/worker/worker.go:121-125`:

> Erro de destino vetado aparece inteiro de propósito: é a resposta para "por que minha URL interna
> não funciona". Já erro de rede cru pode carregar endereço e porta, então vira texto genérico.

| Error | What the owner reads |
|---|---|
| blocked destination | "endereço de destino não é público — só URLs da internet" |
| file too large | the message, including the limit |
| unplayable format | the message, including the codec |
| origin too slow | "a origem demorou demais" |
| **anything else** | "não foi possível ingerir esta mídia" |

The default is the generic one, and that is the right choice: the list enumerates what **may** be
said, instead of trying to enumerate what may not. Two tests guard both ends:
`TestErroDeDestinoVetadoChegaLegivelAoDono` and `TestErroCruNaoVazaDetalheNaMensagem`.

## What was rejected

| Option | Why not |
|---|---|
| Validating only the hostname | DNS rebinding: the name resolves differently on the second lookup |
| Checking the IP before connecting, in the caller | There is a window between checking and using; the dialer hook has none |
| Blocking only private v4 and v6 loopback | NAT64, 6to4 and Teredo reach the private network indirectly |
| Reusing connections (keep-alive) | A reused connection would not pass through `Control` again |
| A "disable validation in tests" flag | Would test different code from production; the test loosens only the policy and keeps the guard |
| Trusting `Content-Length` | It can lie or be missing; the ceiling is measured on arriving bytes |
| Deciding format by `Content-Type` | What the file actually is has to be decided by `ffprobe` |
| A queue broker | A table with a partial index and `SKIP LOCKED` does the job, with no extra service |
| Unconditional uniqueness on `(user_id, source_url)` | Would forbid re-ingesting the same URL after it finished |
| Migrations in an initContainer | A second artefact to maintain; embedded in the binary there is none |
| Propagating SIGTERM cancellation into the job | Every deploy would spend one attempt from each running job |
| Re-ingesting to fix the waveform | A new UUID kills already-shared links and re-uploads a file that is already there |

## What it cost

**The blocked-range list ages.** A new transition mechanism, a new reserved range, and the list
needs maintenance. It is explicit and commented precisely so review is possible.

**`DisableKeepAlives` costs a handshake per request.** For one ingestion at a time it is irrelevant;
in a high-volume system it would be a conversation.

**The `ON CONFLICT` predicate duplicates the index's.** Drifting does not break the build — it
produces silent duplication.

**Polling every 5 seconds is guaranteed latency.** An ingestion waits 2.5 s on average to start. For
this use case, trading that for `LISTEN/NOTIFY` would be complexity with no perceptible gain.

**Best-effort creates data debt.** The missing waveform on older tracks needed a backfill
subcommand. The decision not to fail the ingestion was right; the cost was one more command to
operate.

## In an interview

**"You have an endpoint that downloads a user-supplied URL. How do you close the SSRF?"** The check
goes into the dialer's `Control`, which Go calls **after DNS and before connect**, with the chosen
IP in hand. Validating the name does not work: a host can answer with a public IP on the first
lookup and a private one on the second, which is DNS rebinding. And because every redirect hop opens
its own connection, the guard applies to all of them — with keep-alive disabled, so no reused
connection escapes the hook.

**"Which ranges do you block?"** The obvious ones — loopback, the three private ranges, link-local
including the metadata service at `169.254.169.254`, multicast, reserved — plus the CGNAT range
where the private mesh lives. And three that are usually missing: NAT64, 6to4 and Teredo. Those are
IPv6-to-IPv4 transition paths; a list that only blocks private v4 leaves the internal network
reachable through them.

**"How do you cap the download size?"** With a `LimitReader` of `max+1` and a check for whether the
extra byte arrived. I do not trust `Content-Length` — it can lie or simply be absent. The `+1` is
what separates "silently truncated" from "refused".

**"What does your queue look like?"** A Postgres table, no broker. Deduplication via a **partial**
unique index on `(user_id, source_url)` restricted to active statuses — so a repeated request
returns 200 instead of creating a second job, and the URL can be re-ingested after it finishes.
Claiming is an `UPDATE` with a subquery using `FOR UPDATE SKIP LOCKED`, which also rescues jobs
stuck in `processing` for over fifteen minutes: a worker that died mid-job.

**"What was your worst production bug?"** Migrations at process start. It worked on the first deploy
and broke on the first rollout: two pods came up together and `CREATE TABLE IF NOT EXISTS` is not
atomic in Postgres — both sessions pass the existence check and one blows up with a duplicate key in
`pg_type`. The fix was an advisory lock around the whole sequence, on a single connection taken from
the pool, with the unlock under a non-cancellable context. The lesson is that idempotency is not
concurrency safety.

**"Tell me about a typing bug that surprised you."** Porting the consumption of a public API from
TypeScript to Go, I modelled an object as `map[string]string`. The object had an extra field that
was an array, and that makes the **entire** decode fail in Go. The same JSON had been consumed by
the frontend for weeks without a problem, because a TypeScript `interface` is erased at build time
and validates nothing at runtime. Go was not being awkward — it was surfacing a problem that already
existed and was invisible.

**"How do you decide what is a fatal error and what is best-effort?"** By asking whether, without
it, the user still has what they asked for. Artwork and waveform are best-effort: they have the
music. The audio file is not. And I log the failure, because silent best-effort becomes data debt —
which is what happened, and I needed a backfill command to fix older tracks without re-ingesting,
which would mint a new id and kill already-shared links.
