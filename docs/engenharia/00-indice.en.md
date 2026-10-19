---
title: "Ondas, decision by decision: series index"
date: 2026-10-19
description: "A music PWA with its own API, taken apart across thirteen documents: why each tool was chosen, what was rejected, and what every decision cost."
slug: "ondas-engineering-series"
draft: true
tags:
  - architecture
  - engineering
---

**Ondas** is a music player with a terminal aesthetic: a PWA that plays a public catalogue (the
Audius API) and, for anyone who signs in, a personal library kept in a private bucket. It runs at
`music.thiagotn.com`, on a single-node Kubernetes cluster at home, and deploying is a `git push`.

This is the index of a series explaining **why** it is built this way. It is not a tutorial and not
usage documentation — the [README](../../README.md) covers what the system does and how to run it.
This series answers the other question, the one that comes up in an architecture review or a
technical interview: *why this choice and not the other one, and what did it cost?*

Each document stands on its own. You can read one, out of order, without the code open.

## What can be measured

Figures taken on 2026-10-19, at commit `0b330a2`:

| | |
|---|---|
| Commits | 31, between 2026-10-16 and 2026-10-19 |
| `packages/core` (pure TS, no DOM) | 2,441 lines of production code, 2,214 of tests |
| `packages/web` (React PWA) | 4,406 lines of TS/TSX + 2,035 of CSS |
| `api/` (Go) | 7,640 lines, of which 3,322 are tests |
| Unit tests (Vitest, in `core`) | **216** across 16 files, plain Node environment |
| Backend tests (Go) | **123**, against a real Postgres |
| End-to-end tests (Playwright) | **30**, in 2 viewports = 60 runs |
| Container images | 3 (PWA, API, worker) |
| Themes | 9, each generating 41 CSS tokens |
| Runtime dependencies in `core` | 1 |

The test-to-production ratio in `core` is 0.91:1. In the two riskiest Go packages it inverts:
`internal/worker` has 676 lines of tests against 364 of production code.

## The series

| # | Document | The question it answers |
|---|---|---|
| 01 | [Product and scope](01-produto-e-escopo.en.md) | What was deliberately left out, and how a design handoff became an executable specification |
| 02 | [Stack decisions](02-decisoes-de-stack.en.md) | Why React and not Svelte, why Go for the API, why a single runtime dependency in the domain layer |
| 03 | [System design](03-system-design.en.md) | How the three images talk to each other, why audio never crosses the home tunnel, and which parts can fail alone |
| 04 | [Monorepo and ports](04-monorepo-e-ports.en.md) | How the compiler stops the domain layer from seeing the DOM, and what that buys for the native phase |
| 05 | [State and stores](05-estado-e-stores.en.md) | Why the cursor holds an id and never an index — the lesson this project learned three times |
| 06 | [PWA and offline](06-pwa-e-offline.en.md) | Three caches that never mix, and why a 55 MB file must not become a `Blob` |
| 07 | [Theme and design system](07-tema-e-design-system.en.md) | Nine themes, 41 tokens, and a single `@media` in the whole project |
| 08 | [Authentication](08-auth.en.md) | Why the session cookie is not a JWT, and how argon2id dictates the pod's memory limit |
| 09 | [Private library and R2](09-acervo-e-r2.en.md) | Why a file's path never comes from the request, and why a presigned PUT URL is a secret |
| 10 | [Ingestion and SSRF](10-ingestao-e-ssrf.en.md) | How to close off a proxy to the internal network when the product *is* "send me a URL" |
| 11 | [Waveform](11-forma-de-onda.en.md) | How to draw real audio in 200 bytes, and why a flat bar is the honest answer |
| 12 | [DevOps and GitOps](12-devops-gitops.en.md) | What CI can and cannot touch, and why it never talks to the cluster |
| 13 | [QA](13-qa.en.md) | The discipline of removing the fix to see whether the test complains — and the four times it did not |

## Three ways to read this

- **Preparing for an interview.** Every document ends with an **In an interview** block holding the
likely questions and short answers. Read in sequence, the blocks from 03, 08, 09 and 10 cover almost
all of backend system design; those from 04, 05, 06 and 07 cover the frontend.
- **By discipline.** Frontend is 04 through 07; backend is 08 through 11; infrastructure is 03 and
12; product is 01; quality is 13. Document 02 cuts across everything.
- **For the war stories.** The three documents with the best production findings are 10 (two
Postgres sessions tripping over each other during a rollout), 11 (a PSNR measurement deciding an
ffmpeg parameter) and 13 (a test that passed even without the fix it was meant to guard).

## Two caveats

**A quote is a quote; emphasis is mine.** An indented passage **without bold**, right after a
`file:line` reference, is the code comment reproduced word for word — with `[…]` where I cut. An
indented passage **in bold** is a sentence of mine, pulled out for emphasis. All 54 code quotes in
the series were checked against the file they cite.

**Line numbers age.** References in `file:line` form point at commit `0b330a2`. The path stays
correct after changes; the number may not. Where they disagree, trust the function name quoted
alongside.

**The infrastructure layer is missing here.** The Kubernetes manifests, the cluster's architecture
decision records and the network topology live in a private repository, and none of that is quoted
in this series — not in excerpt, not in paraphrase. Document 12 describes the pipeline up to the
boundary of what this public repository already exposes: the images, CI and the deploy contract.
Where a decision came out of a private record, the reasoning appears (it is also in the code
comments, which are public), but the source is cited by number only.
