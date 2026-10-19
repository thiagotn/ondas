---
title: "The CI that never talks to the cluster"
date: 2026-10-19
description: "Three images, a tag write-back instead of kubectl, and a YAML selector that fails loudly rather than writing the wrong tag. Plus the nginx that redirects because a proxy_pass would take the site down."
slug: "ondas-devops-gitops"
draft: true
tags:
  - devops
  - gitops
  - docker
---

Ondas' pipeline has one property worth more than any build optimisation: **CI holds no credential
that can talk to the cluster**. It publishes images and writes a tag into a configuration file. What
applies things to the cluster is an agent running inside it, watching the repository.

This document covers what lives in this public repository: the workflow, the three images, the nginx
configuration and the deploy contract. The manifests and the cluster topology live in a private
repository and do not appear here.

## The problem: the credential CI holds is the credential that leaks

The direct way to deploy is for CI to run `kubectl set image` or `helm upgrade`. For that it needs a
`kubeconfig` with write access to the cluster, stored in the app repository's secrets.

That credential is, in practice, access to the entire cluster for anyone who can execute code in CI
— which includes whoever opens a pull request touching the workflow, or any of the hundreds of
third-party actions a typical workflow invokes.

## The decision: CI writes to a file; the cluster reads the file

`.github/workflows/build-image.yml:133-135` records the rule:

> o cluster **NÃO** recebe nada deste CI (read-only)

The flow is:

1. `git push` to `main`;
2. CI runs the tests and publishes the three images to the registry;
3. CI writes the new tag into a YAML file **in the infrastructure repository**;
4. Argo CD, running inside the cluster, detects the commit and performs the rollout.

The write credential CI carries reaches **a git repository**, not a cluster. The worst case of a CI
compromise is an unwanted commit to a versioned file — visible, revertible, with history.

And there is a side effect I had not anticipated: because the desired state is a file in git,
**rollback is a commit**. There is no "what was the previous tag?" — it is in the history. In
exchange, a manual `kubectl set image` does not survive, because the agent reconciles back to what
is versioned. The durable path is always the file.

## The quality gate comes before publishing

The workflow has three jobs in strict sequence: `verify` → `build-push` → `bump-homelab-tag`
(`.github/workflows/build-image.yml:17`). No image is published without the whole suite green.

`verify` runs, in order:

```
pnpm -r typecheck
pnpm test                    # 216 domain tests
playwright install chromium
pnpm test:e2e                # 30 tests × 2 viewports
go test ./...                # 123 tests, against a real Postgres
```

Three details of that setup are worth the space:

**There is a real Postgres in CI**, as a service container
(`.github/workflows/build-image.yml:19-21`), and the comment says why: the migration race between
two pods coming up together only appears against a real database — *"sem este serviço aquele teste
viveria pulado"*, without this service that test would live skipped. That is the distinction that
matters: the test **exists** either way, but without the database it skips silently and the gate
stands open with nobody knowing.

**ffmpeg is guaranteed before the Go tests** (`.github/workflows/build-image.yml:64-65`), for the
same reason: the media tests skip without it.

**The Playwright report is uploaded as an artifact only on failure**
(`.github/workflows/build-image.yml:73-79`), with seven days of retention. An end-to-end test that
fails in CI and leaves no trace is an hour of trying to reproduce it locally.

## The three images, and why they differ

| Image | Runtime base | User | Tests at build? |
|---|---|---|---|
| `ondas` (PWA) | `nginx:stable-alpine` | `nginx` (101) | no (`verify` already ran) |
| `ondas-api` | **`scratch`** | 65532 | **yes**, `go test ./...` |
| `ondas-worker` | `alpine` + ffmpeg | 65532 | no |

**The PWA's** (`/Dockerfile`) copies the manifests before the code (`Dockerfile:9-12`), so the
dependency layer only rebuilds when a `package.json` changes. The icons are versioned, so `sharp`
never enters the image (`Dockerfile:15-16`). The runtime does the preparation a non-root nginx
requires — adjusting ownership of `/var/cache/nginx` and `/var/run`, creating the pid file — and
exposes `:8080` with a `HEALTHCHECK` on `/healthz`.

**The API's** is `FROM scratch` with two files: the root certificates and the binary
(`api/Dockerfile:15-19`). No shell, no package manager, nothing to invoke. `api/Dockerfile:19` notes
the consequence: without a shell or a user in `scratch`, it runs under a high fixed uid that the
deployment confirms. The build context is the `api/` folder precisely so it does not drag in the
whole monorepo (`api/Dockerfile:1-2`).

**The worker's** is not `scratch` because ffmpeg is mandatory (`api/Dockerfile.worker:1-3`). And it
**does not run the tests** (`api/Dockerfile.worker:11-12`): *"os testes rodam no build da API (mesmo
módulo, mesma suíte); aqui só compila, para não pagar a suíte duas vezes."*

The asymmetry is deliberate and has a design detail: running `go test` inside the API's build means
**the image does not exist if the tests fail**, regardless of what CI did. It is redundant with the
`verify` job and it is the right redundancy — a local build that forgot to run the tests also
produces no image.

The build cache is scoped per image (`cache-from: type=gha,scope=${{ matrix.name }}`,
`.github/workflows/build-image.yml:130-131`). Without the scope, the three matrix builds would
overwrite each other and the cache would be useless.

## The write-back, and the guard that makes it trustworthy

This is the part of the workflow I would most recommend copying.

The tag is written into the YAML with `yq`, and the selector is **by name, not by position**
(`.github/workflows/build-image.yml:152-156`):

```bash
SELETOR=".images[] | select(.name == \"ghcr.io/thiagotn/${IMG}\")"
```

The comment explains what the alternative would cost: `.images[0]` *"viraria uma roleta e um dia
escreveria a tag da PWA na API"* — would become a roulette and one day write the PWA's tag into the
API's. Indexing by position into a list anyone can reorder is a delayed-action bomb — and the
symptom would be the API running the frontend's build.

And the guard (`.github/workflows/build-image.yml:157-164`):

```bash
if [ -z "$ATUAL" ] || [ "$ATUAL" = "null" ]; then
  echo "::error::imagem ${IMG} não encontrada"; exit 1
fi
```

The reason is a silent `yq` behaviour: updating a field that matches nothing **writes nothing and
raises no error**. Without the guard, renaming an image would make the pipeline go green while the
cluster stayed on the old tag forever. Nobody investigates a green pipeline.

That is the general pattern: *every write that may not happen needs a check that it happened.*
`yq -i`, `sed -i`, an `UPDATE` without a verified `WHERE` — all share that property.

The commit is signed as a bot, with `[skip ci]` in the subject and `git diff --cached --quiet` as a
no-op guard, so a rebuild with no tag change produces no empty commit.

## The nginx, and the `proxy_pass` that does not exist

`packages/web/nginx.conf` has 111 lines and four decisions worth recording.

**The link-preview forwarding is a 302, not a `proxy_pass`** (`packages/web/nginx.conf:86-95`).
nginx resolves the upstream name **at start**, so a `proxy_pass` to the API service would put the
PWA pod into a crash loop whenever the API's DNS failed. Today an API outage degrades only the
private library; with `proxy_pass`, it would take the static site down too. The redirect re-enters
through the Ingress — which already routes `/api` — and the PWA image stays unaware of any cluster
service name.

**The `add_header` inheritance rule.** The security headers are at the `server` level
(`packages/web/nginx.conf:50-53`), and the comment at `packages/web/nginx.conf:48-49` records the
consequence: nginx only inherits headers into a `location` that has **no** `add_header` of its own.
That is why the cache blocks use `expires`, never `add_header` — an `add_header Cache-Control` in a
`location` would silently wipe all four security headers for that path.

It is one of nginx's most expensive gotchas, because the symptom is invisible: the site works, and
the headers are simply not there.

**`absolute_redirect off` and `port_in_redirect off`** (`packages/web/nginx.conf:21-22`). Without
them, any redirect would leak the internal `:8080` port in `Location` — nginx listens on 8080 behind
a proxy that terminates TLS.

**Cache tiers by resource type:**

| Path | Validity | Why |
|---|---|---|
| `/sw.js` | `no-cache, must-revalidate` | A cached Service Worker is a version stuck forever |
| `packages/web/index.html` | `expires -1` | It is the document pointing at everything else |
| `/assets/` | **1 year** | The filename contains a content hash |
| `/icons/` | 7 days | |
| `/manifest.webmanifest` | 1 hour | |
| `/t/` | `expires -1` | Otherwise the edge caches the bot's 302 and serves the preview page to humans |

That last row is a failure that only appears with a CDN in the path, and the comment names it.

And `server_name _` with zero hostnames in the file (`packages/web/nginx.conf:2-3`): changing domain
does not touch the image. Since the PWA manifest uses relative `start_url` and `scope` and there is
no absolute URL of its own in the code, migrating domains is an infrastructure change in three
places — none of them in this repository, none of them requiring a rebuild.

## What was rejected

| Option | Why not |
|---|---|
| `kubectl`/`helm` straight from CI | Would require a cluster write credential stored in the app repository's secrets |
| `.images[0]` in `yq` | Indexing by position into a reorderable list; one day it writes the wrong tag |
| `yq -i` without checking the result | A field matching nothing writes nothing **and raises no error**: green pipeline, stale tag |
| `proxy_pass` to the API | nginx resolves upstreams at start; the PWA would crash-loop whenever the API's DNS failed |
| `add_header` in the cache blocks | Would wipe the security headers inherited from `server` |
| A single cache policy for all static files | A cached `/sw.js` pins the version; `/assets/` with a hashed name survives a year |
| Running the tests in the worker's build | Same module, same suite; paying twice |
| `scratch` for the worker | ffmpeg is mandatory |
| A hostname baked into the image | Changing domain would stop being just infrastructure |
| A shared build cache across the three images | The builds overwrite each other and the cache is useless |

## What it cost

**There is latency between push and rollout.** The reconciliation agent has a cycle; the deploy is
not immediate. In exchange, the desired state is auditable.

**Manual cluster changes do not survive.** With automatic reconciliation on, a hand-made adjustment
is reverted. It is the desired property and it is an unpleasant surprise for anyone who does not
know.

**The write-back creates commits in the infrastructure repository.** The history is interleaved with
the bot's deploy commits. `[skip ci]` avoids the loop; the noise remains.

**Three images is three builds.** The scoped cache helps, and `verify` still runs once for all three
— which is what keeps the total time reasonable.

**The `yq` guard was written because I thought of it**, not because the failure happened. It is the
kind of protection nobody knows is worth it until the day it is.

## In an interview

**"What does your deploy pipeline look like?"** GitOps with a tag write-back. The push runs the
quality gate, publishes the three images and writes the new tag into a YAML file in the
infrastructure repository. An agent inside the cluster detects the commit and reconciles. The
property I value most is that **CI holds no credential that can talk to the cluster** — the one it
has reaches a git repository.

**"Why not `kubectl` straight from CI?"** Because the credential CI holds is the credential that
leaks. A `kubeconfig` with write access in the repository's secrets is cluster access for anyone who
can execute code in the pipeline — which includes the third-party actions the workflow invokes. With
a write-back, the worst case is an unwanted commit to a versioned file: visible and revertible.

**"What is the easiest thing to get wrong in that write-back?"** Two things. Selecting the image by
position instead of by name — `.images[0]` works until somebody reorders the list, and then the
pipeline writes the frontend's tag into the API's. And not checking that the write happened: `yq -i`
on a field matching nothing **writes nothing and raises no error**. Without the check, renaming an
image leaves the pipeline green and the cluster on the old tag forever.

**"Why does the API image run its tests inside `docker build`?"** Because then the image does not
exist if the tests fail, regardless of CI. It is redundant with the verify job and it is the right
redundancy: a local build that forgot to run the tests also produces no image. The worker does not
repeat the suite — same module, and paying twice buys nothing.

**"Tell me about an nginx gotcha that caught you."**`add_header` inheritance. The security headers
are at the `server` level, and nginx only inherits them into a `location` with no `add_header` of
its own. So any cache block using `add_header Cache-Control` would silently wipe all four headers
for that path. The blocks use `expires`. The symptom of getting it wrong is invisible: the site
works and the headers are not there.

**"And the link preview — why a redirect and not a proxy?"** Because nginx resolves the upstream
name at process start. A `proxy_pass` to the API service would put the PWA pod into a crash loop
whenever the API's DNS failed — trading "the library is down" for "the site is down". With a 302,
the request re-enters through the Ingress, which already routes `/api`, and the PWA image does not
need to know any cluster service name.

**"How would you change the application's domain?"** Without touching the image. nginx listens on
`server_name _`, the PWA manifest uses relative `start_url` and `scope`, and there is no absolute
URL of its own in the code. Changing domain is a change in three infrastructure files and a DNS
record — no rebuild, and both domains can serve the same pod in parallel during the migration.
