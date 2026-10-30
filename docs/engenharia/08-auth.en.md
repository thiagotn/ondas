---
title: "Why Ondas' session cookie is not a JWT"
date: 2026-10-19
description: "An <audio> tag sends no headers. Out of that constraint come the HMAC-signed cookie, the argon2id parameters that dictate the pod's memory limit, and three authorisation layers in the router."
slug: "ondas-session-cookie-not-jwt"
draft: true
tags:
  - security
  - go
  - architecture
---

Almost every API I had written before authenticated with `Authorization: Bearer <token>`. This one
does not — and the reason is not preference, it is a browser constraint that eliminates the option
before any debate about JWT versus sessions.

This document follows that constraint through to everything else: the cookie's format, the order in
which it is verified, the argon2id parameters and why they decide how much memory the pod needs, the
two oracles the login endpoint closes, and the router's three authorisation layers.

## The problem: audio is loaded by a tag, not by `fetch`

The library is private. Each track is an object in a bucket with no public domain, and the PWA plays
it like this:

```html
<audio src="/api/acervo/<id>/audio">
```

This is where header-token schemes die. `<audio>` accepts no headers: the element makes the request
itself, and nothing in JavaScript can attach an `Authorization` to it. The same goes for `<img>` on
artwork. If the session lived in a header, the catalogue would authenticate fine and **no track
would play** — and you would only discover that when somebody pressed play.

A cookie, by contrast, travels automatically on any same-origin subresource, including whatever a
tag fetches. That settles two things at once:

1. **The session is a cookie.**
2. **The API has to be served from the same origin as the PWA** — which it is, as one extra path on
the Ingress (`/api`), which also removes CORS and preflight
(`api/internal/httpapi/server.go:66-67`).

From there, "JWT or session?" becomes a different question: what is better **inside** a cookie?

## The decision: an opaque cookie signed with HMAC-SHA256

`api/internal/auth/session.go:14-18` is the whole decision, in four lines of comment:

> Cookie opaco assinado com HMAC-SHA256 em vez de JWT: quem valida o token é a mesma API que o
> emitiu, então não há motivo para carregar uma biblioteca e a superfície de erro de JWT (alg=none,
> confusão de chave, kid).

The argument is about scope. JWT solves a problem Ondas does not have: **third-party verification**.
It exists so one service can validate a token another service issued, and that is why it carries
algorithm negotiation, key identification and a header the attacker controls — hence the family of
failures around `alg: none`, HMAC/RSA confusion, and `kid` pointing somewhere it should not. Here
the issuer and the verifier are the same process, reading the same environment variable. There is
nothing to negotiate, so there is nothing that can be negotiated downward.

The format is this:

```
v1.<base64url(userID + "." + expiryUnix)>.<base64url(HMAC-SHA256(secret, "v1." + body))>
```

Three implementation details worth more than the format:

**The version is inside the MAC.**`mac()` signs `"v1." + body`, not the bare body
(`api/internal/auth/session.go:73-77`). If a `v2` with different contents ever exists, no `v1` MAC
can be reused in it. Signing only the body is the classic context-confusion mistake.

**The verification order is deliberate**, and the comment at `api/internal/auth/session.go:42-43`
says why: *"confere a assinatura antes de olhar a expiração, para não vazar nada sobre um cookie
forjado"* — check the signature before looking at expiry, so a forged cookie leaks nothing. A cookie
invented by an attacker gets `ErrSessaoInvalida` without the API ever having interpreted what was
written inside it. A legitimate but expired cookie gets `ErrSessaoExpirada`. Only the signature
decides which of the two paths is taken.

```go
if !hmac.Equal([]byte(partes[2]), []byte(s.mac(partes[1]))) {
    return "", ErrSessaoInvalida
}
```

`hmac.Equal` and not `==`: constant-time comparison, for the same reason it appears in three other
places in this codebase.

**The body is split with `LastIndex`, not `Split`** (`api/internal/auth/session.go:56`). The body is
`<userID>.<expiry>`, and if an id ever contained a dot, `Split` would silently break the parse.
`LastIndex` with the `corte < 1` guard always reads the last separator.

The clock is injectable (`api/internal/auth/session.go:29`), which allows testing expiry without
sleeping in the test.

### The cookie flags

In `api/internal/httpapi/server.go:224-237`:

| Flag | Value | Why |
|---|---|---|
| `HttpOnly` | `true` | Puts the token out of reach of any script, including an XSS |
| `Secure` | `true`, except in dev | On `http://localhost` the browser would discard the cookie |
| `SameSite` | `Lax` | Enough, because the PWA and the API share an origin |
| `MaxAge` | 30 days | The PWA is installed and should not ask for sign-in weekly |
| `Path` | `/` | The cookie must accompany both `/api/...` and navigation |

`HttpOnly` has a consequence the client documents back, in `packages/core/src/auth/http.ts:27-30`:
the frontend code **cannot read** the session. What goes into local storage is only the user's name,
so the screen does not flash between boot and the `/me` response. The source of truth is a cookie no
script can reach.

## The password: argon2id, and the memory limit it dictates

`api/internal/auth/password.go:15-24`:

```go
const (
	argonTime    = 1          // 1 pass
	argonMemory  = 64 * 1024  // 64 MiB
	argonThreads = 4
	argonKeyLen  = 32
	saltLen      = 16
)
```

This is RFC 9106's background profile, and it costs ~50 ms per verification. That is the point: 50
ms is irrelevant to someone who knows the password and ruinous to someone guessing.

But the number that matters operationally is the **64 MiB**. Argon2 is memory-hard on purpose: every
verification allocates 64 MiB. That means the process needs enough memory headroom for one sign-in —
and it is the password hashing function, not traffic volume, that sizes the container's memory
limit. Squeezing that limit does not make the pod slow: it makes the pod **die on the first
sign-in**, which is a far harder failure mode to diagnose than it sounds.

The hash is stored in PHC format, with the parameters embedded:

```
$argon2id$v=19$m=65536,t=1,p=4$<salt>$<hash>
```

`api/internal/auth/password.go:28-30` explains the choice: this way the cost can be hardened later
**without invalidating old hashes**, because `VerifyPassword` reads the parameters from the hash
itself rather than from the constants. A password stored today at 64 MiB keeps verifying tomorrow,
even if the new default is 128.

### The guard that exists because of a panic

The easiest thing to miss is at `api/internal/auth/password.go:69-76`:

```go
// `argon2.IDKey` entra em panic com parâmetro zerado (keyLen 0, p=0, m
// abaixo de 8*p). Hash truncado ou adulterado chega exatamente assim, e um
// panic no handler de login seria um jeito trivial de derrubar a API.
if len(salt) == 0 || len(esperado) == 0 || tempo == 0 || threads == 0 || mem < 8*uint32(threads) {
    return false
}
```

A corrupted hash in the database — truncated by a too-short column, cut by a bad migration, or
simply written wrong — produces zeroed parameters at parse time. `argon2.IDKey` panics on them.
Without that guard, one bad row in `users` turns every sign-in attempt for that account into a panic
in the handler. chi's `Recoverer` would return 500 rather than kill the process, but the practical
effect would be a permanently broken sign-in with no useful message.

A malformed hash is treated as a wrong password, never as a distinct error
(`api/internal/auth/password.go:45-47`) — for the same reason as the next section.

## Two closed oracles

A login endpoint tells you things without meaning to. Ondas closes two channels.

**The same response for a nonexistent email and a wrong password.** Both return `ErrSenhaInvalida`.
Without that, anyone can enumerate which emails have accounts.

**The same response time for both.** This is the part that is almost always left out. If the email
does not exist, there is no hash to verify, the response comes back in microseconds, and the latency
difference reopens the oracle the single message just closed. `api/internal/auth/users.go:78-84`:

```go
if errors.Is(err, pgx.ErrNoRows) {
    // Gasta o mesmo tempo de um hash real, senão a diferença de latência
    // entrega quais e-mails existem.
    _ = VerifyPassword("$argon2id$v=19$m=65536,t=1,p=4$"+
        "c2FsdHNhbHRzYWx0c2E$Y2FmZWNhZmVjYWZlY2FmZWNhZmVjYWZlY2FmZWNhZmU", senha)
    return nil, ErrSenhaInvalida
}
```

A fake hash, with realistic parameters, verified against whatever password the attacker sent. The
result is discarded; what matters is the 50 ms spent.

The account also never exposes the email: `type User` serialises only `name`, with `ID` and `Email`
marked `json:"-"` (`api/internal/auth/users.go:27-32`).

## The login brake lives in the application, not the proxy

The limit: 8 attempts per 5 minutes, then 429. The interesting part is **where** it lives, and
`api/internal/auth/ratelimit.go:8-17` records why:

> Mora aqui e não no Traefik porque o Traefik do cluster não enxerga o IP real (o hostPort mascara a
> origem), então o rate-limit dele vale para o host inteiro.

It is a case where the network architecture decides the application's design. The cluster proxy
receives every connection through a `hostPort`, and the `RemoteAddr` it sees is always internal — a
rate limit there would cap everyone's sum, not each client. Since the only way in is a Cloudflare
tunnel, the `CF-Connecting-IP` header is trustworthy enough for the count, and
`api/internal/httpapi/middleware.go:30` reads it in a cascade: `CF-Connecting-IP`, then the first
element of `X-Forwarded-For`, then `RemoteAddr`.

The algorithm is a sliding window over timestamps, not a token bucket
(`api/internal/auth/ratelimit.go:32`):

```go
recentes := l.recentes(chave, agora)
if len(recentes) >= l.max {
    l.tentou[chave] = recentes
    return false
}
l.tentou[chave] = append(recentes, agora)
return true
```

Two details: the **blocked attempt is not recorded**, so hammering the endpoint does not extend your
own block indefinitely; and `recentes` filters by reusing the array (`l.tentou[chave][:0]`), with no
allocation on the hot path. Map cleanup is amortised — it only sweeps once a full window has passed
since the last time (`api/internal/auth/ratelimit.go:66-76`) — because without it the map would grow
forever with IPs that never return.

The limitation is assumed in writing in the same comment: the counter is in memory, so a pod restart
resets the blocks. For a handful of accounts that is acceptable; the right place, if it becomes a
problem, is Postgres. Having that written down is worth more than having one more Redis to operate.

## Sign-up closed by default

`api/internal/config/config.go:86-96`. `SIGNUP_OPEN` defaults to `false` and the allowlist starts
**empty** — the starting configuration permits no sign-up at all. The handler returns 403 before
touching the database (`api/internal/httpapi/server.go:165-168`), and the comparison is lowercased
on both sides, with empty entries discarded (which protects against an `"a@b.c,"` that would open
everything).

Email uniqueness is a functional index, not a direct constraint:
`CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email))`
(`api/internal/db/migrations/0001_init.sql`). Nobody registers `Thiago@` and `thiago@` as different
accounts. The cost of that choice is an ugly coupling: duplicate detection compares the index's name
inside the Postgres error string (`api/internal/auth/users.go:60`).

## Three authorisation layers in the router

The API has a second authenticable subject besides the user: a **machine token**, used by a bot that
queues ingestions. That creates a question which does not exist when there is only a session: *what
can the token do?*

The answer is in the router's shape, not in a permission field.
`api/internal/httpapi/server.go:90-94`:

> O corte entre os dois grupos abaixo é **entrar com faixa nova** vs. **mexer no acervo que já
> existe**. Não é um detalhe de arrumação: é onde mora o teto do token de máquina.

| Layer | Reach | Routes |
|---|---|---|
| Public | no credential | `healthz`, `readyz`, `og/t/{seg}`, `signup`, `login`, `logout` |
| Session **or** token | bringing in a new track | `POST ingest`, `GET ingest/{id}`, `POST upload`, `POST upload/{id}/finalizar` |
| Session only | touching what already exists | `GET /acervo/`, `GET {id}/audio`, `GET {id}/art`, `DELETE {id}` |
| Session only | touching one's own account | `GET /auth/me`, `PATCH /auth/prefs` |

The last row is the same ruler applied to a new case. `PATCH /auth/prefs` turns the account's public
catalogue on and off (`users.publico`), and the machine token does **not** reach it: the token exists
to bring in a new track, and changing what somebody sees is not that. The guarantee is geometric
like the others — `exigirSessao` never reads the token header — and
`TestPrefsExigeSessaoENaoAceitaToken` pins it, for the same reason
`TestEscopoDoTokenNoAcervo` exists.

The body is `{"publico": bool}` read into a **pointer**: with a `bool`, a body missing the key would
decode to `false` and turn off the catalogue of someone who merely sent bad JSON. Absent is a 400.
And the field ships in **every** auth response — `signup`, `login` and `me` — because the PWA decides
the catalogue's source at boot, before any other call.

And `api/internal/httpapi/server.go:122-127` names the threat model:

> É aqui que um token vazado viraria exfiltração (listar, baixar) ou destruição (apagar), e não em
> criar um objeto na própria área de espera. `TestEscopoDoTokenNoAcervo` trava esta divisão: mover
> uma rota de grupo sem querer compila, e só o teste denuncia.

That last detail is what makes the decision durable. The division is geometric — two `r.Group` calls
in one file — and moving a route from one to the other is an indentation change that compiles,
passes review and shows up in no diff as "a security change". The test is the only thing that
complains.

The token itself is stored as the SHA-256 of the real value, never in the clear
(`api/internal/config/config.go:52-54`): the API only needs to **verify**, so the original secret
does not have to exist in the cluster. The comparison is `subtle.ConstantTimeCompare`
(`api/internal/httpapi/acervo.go:138`), with the right comment beside it: with `==`, the response
time hands over the correct prefix byte by byte.

## What was rejected

| Option | Why not |
|---|---|
| JWT inside the cookie | Solves third-party verification, which does not exist here; brings `alg=none`, key confusion and `kid` for free |
| A token in `Authorization: Bearer` | `<audio>` and `<img>` send no headers; the catalogue would authenticate and no track would play |
| Sessions in a Postgres table | One query per request to solve what the HMAC solves without I/O; the cost only pays off when you must revoke a specific session, and here the panic button is rotating the secret |
| bcrypt | Not memory-hard; argon2id is the current recommendation and the memory cost fits the envelope |
| Rate limiting at the proxy | The proxy cannot see the real client IP; the limit would apply to the whole host |
| Redis for rate limiting | One more service to operate; the in-memory limitation is assumed in writing |
| A permission field for the machine token | Grouping by route is harder to loosen by accident, and has a test guarding it |

## What it cost

**There is no per-session revocation.** The cookie is self-contained, so the only way to invalidate
a specific session would be a blocklist — that is, exactly the server-side state the decision
avoided. What exists is the panic button: rotating `SESSION_SECRET` invalidates **all** sessions at
once (`api/internal/config/config.go:18-20`). For a single-owner system that is the right trade; for
a multi-user product it would be unacceptable.

**The rate limit resets on deploy.** A rollout restarts the counter. With a 5-minute window and an
app that rolls out rarely, it is a narrow gap — but it is a gap.

**argon2id ties down the memory configuration.** Anyone who changes the container's envelope without
knowing this finds out from the pod dying on sign-in, not from slowness.

**Coupling to an index name** (`users_email_lower_idx` inside a string comparison) is fragile.
Renaming the index in a future migration breaks duplicate-email detection, and the symptom would be
a 500 on sign-up instead of a message.

## In an interview

**"Why not JWT?"** Because JWT solves third-party verification, and here the issuer and the verifier
are the same process reading the same environment variable. There is nothing to negotiate, so it is
not worth carrying the error surface of negotiation — `alg=none`, key confusion, `kid`. The cookie
is opaque, signed with HMAC-SHA256, and the format version is inside the MAC so no `v1` signature is
reusable in a `v2`.

**"Why a cookie and not a header token?"** That was not a choice, it was a constraint. The track is
loaded by `<audio src="/api/.../audio">`, and a tag accepts no headers. With the session in a
header, the catalogue would authenticate normally and no track would play. A cookie travels
automatically on any same-origin subresource — which is also why the API **has** to live on the same
origin as the PWA.

**"How do you protect against user enumeration?"** On two fronts. The message is identical for a
nonexistent email and a wrong password; and when the email does not exist, the code verifies a fake
hash with realistic parameters just to burn the same 50 ms. Without the second part, the latency
difference would reopen the oracle the first part closed.

**"Why is rate limiting in the application and not at the ingress?"** Because the cluster proxy
cannot see the client's real IP — every connection arrives through a `hostPort` and the source
address is always internal. A limit there would apply to everyone's sum. Since the only way in is a
Cloudflare tunnel, I count by `CF-Connecting-IP` inside the API.

**"You have a machine token. How do you keep it from doing what it should not?"** Through the
router's shape, not a permission field. There are two groups: "bringing in a new track" accepts
session or token; "touching the library that already exists" — listing, downloading, deleting —
accepts session only. A leaked token can create an object in its own staging area and cannot
exfiltrate or destroy anything. And since moving a route between groups is an indentation change
that compiles, there is a dedicated test guarding the division.

**"What is the biggest risk you accepted here?"** Not having per-session revocation. The cookie is
self-contained; to invalidate one session I would need a blocklist, which is exactly the server-side
state I avoided. What I have is rotating the secret, which drops every session at once. For a
single-owner system that is the right trade — for a product with real users, it would not be.
