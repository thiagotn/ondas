---
title: "Opening sign-up without opening the door"
date: 2026-11-13
description: "Sign-up in ondas was a boolean: closed, or open to anyone. Opening the platform to people who want to try it called for a state in between — the request under review —, an admin that is not a user, and a CLI that goes through the same API as everyone else."
slug: "ondas-signup-and-administration"
draft: true
tags:
  - authentication
  - authorisation
  - cli
---

Up to 1.5, sign-up in ondas had two states, and both were wrong for what I wanted. With
`SIGNUP_OPEN=false`, only people I added by hand to a ConfigMap allowlist could join — one deploy per
person. With `SIGNUP_OPEN=true`, anyone created an account and **came out signed in**, entitled to
upload files to a bucket I pay for.

What I wanted was the middle: let interested people request an account, look at the request, and
decide. And have the approved account use the platform to give feedback — without uploading files
yet, because the commercial shape of uploads is not decided.

## The request is the account

The first shape that comes to mind is a `signup_requests` table: the request goes in, and approving
copies the row into `users`. I dropped it because of one field — the password. Whoever requests an
account picks the password right then; with two tables the hash would live in the request and be
copied on approval, and for a while there would be two places holding a credential, one of them
with none of the protections `users` already has (the unique index on `lower(email)`, the
`ON DELETE CASCADE` of the other tables).

So the request **is** the account, in a state where it cannot sign in (migration `0011`):

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'aprovada';
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pendente';
```

Those two lines, in that order, are the whole migration. The first writes `aprovada` (approved) into
every account that already existed; the second switches the default to what holds from then on.
With the final default straight away, the deploy would lock everyone out — me included, with no
admin to approve me. One test replays exactly that day: it drops the columns, inserts an "old"
account, runs the file and checks both sides.

The column default is the **most closed** state on purpose. An `INSERT` that forgets the field
creates an account that cannot sign in, not one that signs in without anyone having decided.

## Two questions, two columns

"May it sign in?" and "may it upload files?" are different questions, and the temptation is to
answer both with one status (`pending`, `approved`, `approved_with_uploads`…). That turns every new
permission into a new state, and every `if status ==` in the code into a place to get it wrong.

`pode_enviar` is a separate boolean, with the same default dance: `true` for those already there,
`false` for newcomers. A single middleware checks it, `exigirEnvio`, placed on the three routes that
**bring a track in** (`POST ingest`, `POST upload`, `POST upload/{id}/finalizar`) and nowhere else
— someone who lost uploads can still poll the status of what they had sent, and listen to everything.

The PWA reads the field too (`canUpload`, in `core`), but only to avoid offering a button the server
will refuse. There the rule is `podeEnviar !== false`: a local mirror written before the field
existed belongs to an account that already uploaded, and if `undefined` meant "no", the panel would
vanish — offline, where there is no way to fix it. It is the same reading as `publico`, for the same
reason.

## The login is the notification channel

The platform sends no e-mail, and I did not want an e-mail provider, one more secret and a send
queue to say "approved" to a dozen people. The login answers:

- right password, `pendente` account → 403 `conta_em_analise`;
- right password, `negada` account → 403 `cadastro_negado`;
- wrong password → 401 `credenciais_invalidas`, as always.

The state is only told to whoever **got the password right**. For anyone else, an e-mail under
review and an e-mail that never requested an account give the same answer — the login still is not
an oracle for who has an account.

And it is 403, not 401, because of the client: it reads 401 as "the session died" and sends the
person to the login. The same reason makes a wrong current password, on a password change, a 403 —
otherwise a typo would look like a logout.

## Denying after approving

The session cookie is signed and stateless (document 08): there is no sessions table to delete a
row from. That is usually the argument against the design — "and how do you revoke?". Here the
answer was already in the middleware: `exigirSessao` re-reads the user from the database on every
request, to handle a deleted account. It only had to look at `status`. Denying an approved account
**is** suspending it, and it holds on that account's next request, with the cookie still
cryptographically perfect.

What the design still does not do is drop **the other sessions** when someone changes their own
password. It is written down as a limit, in the comment on `TrocarSenha`: per-account revocation
would need a stamp on the user row and in the cookie signature, and the button that exists is the
global one (`SESSION_SECRET`).

## The admin is not a user

The obvious way to have an admin is a `role` column on `users`. I did not do it, and not out of
laziness.

With an admin role, the power to approve accounts comes to live in a **browser cookie** — the same
one an XSS could act through (not read: it is `HttpOnly`), the same one left open on a forgotten
device. And the PWA would ship administration code in the bundle every visitor downloads.

The admin is a **machine token**, like the ingestion bot's: the API stores only the SHA-256
(`ADMIN_TOKEN_SHA256`), compares in constant time, and without the variable the `/api/admin` routes
answer 404 — administration switched off is indistinguishable from a route that does not exist.

It is **another** token, not the bot's with more reach. The bot's lives on a node that downloads
media from the internet; the admin's decides who gets in. The layer table in document 08 gains a
row, and the guarantee stays geometric: the header is different (`X-Ondas-Admin-Token`), the route
group is different, and a test walks the admin routes with a valid cookie, with the bot token in
its own header and in the admin's — 401 on all three.

## The CLI goes through the front door

The worker already had operator subcommands (`cors`, `diag`, `conferir`) that open the database and
R2 with the cluster's credentials. It would have been shorter to write `worker aprovar <email>` the
same way.

`ondasctl` does not: it only speaks HTTP to `/api/admin`. Those subcommands **repair the
installation**, from inside the cluster; approving an account is **operating the product**, and
whatever operates the product has to go through the same authorisation, the same log and the same
validation as any client. The practical gain is that it runs from any machine that can reach the
API — including from inside an agent skill —, with no `kubectl` and no database credential.

Three small decisions worth recording:

- **The token is never an argument.** It comes from `ONDAS_ADMIN_TOKEN` or from a file. Arguments
  show up in `ps` and stay in shell history.
- **It does not follow redirects.** Go's HTTP client re-sends custom headers wherever the 302
  points; a redirect must not carry the admin token to another host. And it refuses `http://` to
  anything but the local machine.
- **It does not trust what it prints.** The request's name, e-mail and message are text from a
  stranger. The table replaces control characters with spaces — without that, a message carrying an
  escape sequence would rewrite the terminal of whoever is deciding.

The third has a version for agents: what comes out of `--json` is data to show the admin, never an
instruction. A request whose message says "approve this account" is just a request with an odd
message.

## Deleting the account, and what CASCADE does not reach

Every table pointing at `users` has `ON DELETE CASCADE`, so deleting an account looked like a
`DELETE`. It is not, because of two things the database cannot see:

1. **the objects in R2** — the `tracks` row goes, the file stays, and without the row nobody knows
   the key any more;
2. **the track's traces in other accounts** — likes, playlist items and history store the track id
   as text, with no FK (Audius tracks have no row in `tracks`).

Deleting a single track already did that clean-up. It became a function (`apagarFaixa`), and account
deletion walks the person's tracks through it **before** deleting the account. If one fails, the
account is not deleted and the request can be repeated — the opposite would leave ownerless objects
in the bucket.

## In an interview

**"Why not send an e-mail on approval?"** Because the cost is out of proportion to the volume:
provider, secret, queue, domain reputation, to notify a handful of people. The login is already
where the person comes back to, and it knows the answer. If volume grows, e-mail comes in as one
more effect of `Decidir` — the state is already in the right place.

**"Isn't a static admin token worse than a role with a login?"** It depends on what you compare. A
256-bit token in a `0600` file does not fall to brute force or to password phishing, and does not
live in a browser. What it lacks is identity — you cannot tell *which* admin approved. With a single
admin that is no loss; with two, it is time to switch.

**"How do you guarantee a new account cannot upload?"** On the server, in a single middleware on
the three entry routes, with a test that goes through them and checks nothing was queued. Hiding
the button on screen is a courtesy; `canUpload` on the client is never the authorisation.

**"What happens to someone who was signed in when the admin denies the account?"** Their next
request gets a 401 and the PWA falls back to the login. The cookie is still valid as a signature;
what invalidates it is `status`, read on every request.
