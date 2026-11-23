---
title: "I copied a link: offering without snooping, downloading without opening the door"
date: 2026-11-23
description: "Bringing in a track by link was the Telegram bot's job. Taking it to the PWA ran into two things that look small: the clipboard is private data, and the cluster worker does not resolve pages. The link became a suggestion that only leaves the device on a tap, and a job with two executors."
slug: "ondas-track-by-link"
draft: true
tags:
  - privacy
  - queues
  - ssrf
---

The Telegram bot already brought in tracks by link. You sent a YouTube address, the node downloaded
it with `yt-dlp`, and the track showed up in the archive. But the bot is mine: someone with an
account and uploads enabled had no way to do the same by themselves.

The request was simple — "if there is a music link in the clipboard, suggest adding it to the
archive". Each half of it has a problem.

## The clipboard is not the app's

What sits in the clipboard is whatever the person copied last: it may be a link, it may be a
password. Three rules came out of that, and all three live in `web/src/app/linkSugerido.ts`:

1. **The app never asks for the permission by itself.** When it comes back to the foreground it
   reads the clipboard **only if the permission is already granted** (`navigator.permissions.query`).
   Where that question does not exist — Safari, Firefox — the answer is not to read. On iPhone every
   read shows a "Paste" bubble, and a bubble popping up by itself when the app opens is exactly what
   nobody wants.
2. **Only the recognised URL survives the text that was read.** `acharLink` (`core/src/link.ts`)
   returns the link or `null`; the rest of the text is dropped on the spot and goes to no store, log
   or server.
3. **Nothing leaves the device before the tap.** The link becomes a notice — "YouTube link copied" —
   with `[add to archive]` and `[dismiss]`. Only the first one sends the URL.

The person grants the permission, by tapping `[+ link]` in the library: that tap is the gesture
every browser accepts for reading the clipboard, iPhone included. After it, automatic reading starts
to work wherever the browser allows it.

### Erring on the side of silence

`acharLink` matches only what is recognisably **one** track: a YouTube video, a SoundCloud track, a
URL ending in an audio extension. Playlists, channels, profiles and any other site return `null`. A
notice that shows up for a link that is no use teaches people to ignore the notice.

And the same link is not offered twice: the clipboard does not change just because the person said
"no", so answered URLs are kept in `sessionStorage`. The explicit gesture (`[+ link]`, paste, share)
ignores that list — there the person **asked**.

### Three doors, one suggestion

| Door | Where it works | How it reads |
|---|---|---|
| returning to the app | Chromium, with permission already granted | by itself, no prompt |
| `[+ link]` and paste | every browser | on the gesture |
| Share to Ondas | Android, app installed | `share_target` in the manifest, no clipboard |

All three stop at the same notice. None of them queues anything by itself — not even sharing, the
most explicit of the three: the `/share` route turns what arrived into a suggestion, goes to the
library and cleans the address.

## The cluster does not resolve pages

The ingestion worker downloads **files**. Hand it a YouTube URL and it gets HTML, which ffprobe
rejects. Teaching the worker to resolve pages was discarded when the bot was born, for two reasons
that still stand ([document 10](10-ingestao-e-ssrf.en.md)): YouTube refuses the cluster's egress IP,
and a page resolver is a program that follows redirects and fetches resources on its own — the
opposite of what the SSRF guard exists to guarantee.

The node downloads pages; `yt-dlp` and `scdl` already run there for the bot. So the job gained a
**type**, which says who serves it (migration `0013`):

```
PWA ── POST /ingest ──▶ job tipo=pagina ──▶ node (ondas-fila) downloads
                                              │  PUT into the staging area of WHOEVER ASKED
                                              ▼
                        job tipo=midia  ──▶ worker: ffprobe, covers, waveform
```

The job id **does not change** in that hand-off. The PWA follows a single thing, from "downloading
from the site" to "done", on the same `GET /ingest/{id}` as always.

### The token's new reach

The node talks to the API with the machine token, and this design lets it write into another
person's account. What keeps that narrow is not an `if`:

- the node's routes only find a **page job in progress** (`Jobs.PaginaEmCurso`) — the id of a media
  job, or of a job nobody claimed, is a 404;
- the file's key comes from the owner **of that job** (`storage.KeyUploadStage(job.UserID, …)`). The
  node names no account; it only carries the id.

In other words: the token writes into someone's account **only** if that account asked, and only
the file for that request. `TestRotasDoNodeSoAbremComOTokenDeMaquina` pins the split, the way
`TestEscopoDoTokenNoAcervo` pins the archive's.

### Failure is a code

The node knows why a download failed, and its sentence could go straight into the job. It does not:
it sends a **code** from a closed list (`pagina_indisponivel`, `pagina_longa_demais`,
`pagina_falhou`), and the stored sentence is chosen by the API. Free text from outside would become
content on the screen of whoever asked.

## The server decides again

The PWA classifies the link to decide whether to **suggest**. What it really is gets decided by the
API (`ingest.ClassificarLink`), with the same rules — and it **canonicalises**:
`youtu.be/ID?si=…`, `music.youtube.com/watch?v=ID&list=…` and `m.youtube.com/watch?v=ID` all become
the same `youtube.com/watch?v=ID`. The canonical form is what goes into the database, and that is
what makes the same video pasted two ways land on the same job instead of downloading twice.

The route had no brake on requests, and every page job is a download over a residential link. Two
came in: five requests in progress per account, and the quota — which in this version stopped
merely measuring ([document 16](16-painel-de-admin-e-cota.en.md)).

## What was discarded

| Alternative | Why not |
|---|---|
| Reading the clipboard on every focus, in every browser | On iPhone that is one "Paste" bubble per read; anywhere, it is reading private data without being asked |
| Queueing a shared link straight away | Sharing is explicit, but Android's menu sits one tap away from any link — confirming costs one tap and avoids the wrong track |
| `yt-dlp` in the cluster worker | Egress IP refused and SSRF guard loosened; the bot's decision still holds |
| The node creating a new job on delivery | Whoever asked would lose the thread: they would follow a job that never ends, and the track would come from another |
| The node naming the destination account | That would be the token choosing where to write. With the job id, whoever asked chooses |
| Accepting playlists from the PWA | The bot asks "that is 40 tracks, are you sure?"; here there is no conversation to ask in |

## Costs accepted

- **Page links depend on the node.** With `ondas-fila` stopped, the request stays queued; the PWA
  shows "downloading from the site" until its own deadline, and the track shows up when the node is
  back.
- **Recognising failure means matching text** in the skills' output. When a sentence changes, the
  failure stops being recognised as final and is retried twice more — it degrades, it does not
  break.
- **No automatic detection on iPhone**, and no sharing. There the way in is `[+ link]`.
- **Copyright.** The bot did this for one person; now it does it for every account with uploads
  enabled. The guard is the upload permission, which the admin grants account by account.

## In an interview

**"How do you read the clipboard without being invasive?"** By not asking for permission on your
own, reading only when it already exists or on a gesture, dropping everything that is not the
recognised URL, and sending nothing to the server before a confirmation. And by testing the
negative: one test counts the reads and demands zero.

**"Why not download from YouTube in the worker itself?"** Because the worker is a file downloader
with an SSRF guard, and a page resolver is the opposite of that. The page is resolved by what
already did so, and the worker keeps receiving files.

**"How do two executors share one queue?"** A type column, and each claims only its own, with the
same `SKIP LOCKED`. The hand-off from one to the other is an UPDATE that changes the type and the
source of the same job.

**"The machine token writes into another person's account — isn't that a hole?"** It would be, if
it chose the account. It sends a job id, and the query only finds a page job in progress; the
account is whoever asked for that job.
