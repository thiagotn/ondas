---
title: "Real audio in 200 bytes — and the flat bar as the honest answer"
date: 2026-10-19
description: "RMS over 200 buckets measured as a stream by ffmpeg, a 6-bit alphabet shared between Go and TypeScript by a test that reads the other language's file, and six SVG paths instead of two hundred nodes."
slug: "ondas-waveform"
draft: true
tags:
  - audio
  - performance
  - frontend
---

The previous version of the progress bar drew, for every track, a wave derived from the hash of the
song's id. It was pretty, it was convincing, and it had **no relationship to the sound**. Two
different tracks had different drawings, which made it look like information; the same track always
had the same drawing, which made it look like a measurement.

Today the bar draws the real audio — and, when the audio is unknown, it draws a straight line. This
document is about both halves: how to measure cheaply and how to display honestly.

## The problem: measuring on the client is expensive, and on the server is too late

To draw a track's envelope, someone has to read the whole file. There are three possible places, and
two do not work:

- **In the browser, at play time.** It would require downloading the complete file before drawing —
exactly what streaming avoids.
- **In a separate request, per track.** The first screen has twelve rows; that would be twelve
network round trips just to draw bars.
- **At ingestion, once.** The file is already on disk, the process already runs ffmpeg, and the
result is small enough to travel with the rest of the metadata.

The third is the chosen one, and "small enough" is the whole decision.

## The decision: 200 buckets, 6 bits each, one text column

`api/internal/ingest/picos.go:19`: **200 peaks per track**, because *"A tela nunca desenha mais que
isto (a barra mais larga do app cabe ~180 barras de 2px), e a PWA reduz para o que couber. Guardar
mais seria detalhe que ninguém vê."*

The number is not round for aesthetics: it is derived from the largest size the bar can have on
screen.

Each peak is one character from a 64-symbol alphabet — 6 bits (`api/internal/ingest/picos.go:26`).
Result: **200 characters, 200 bytes**, in a `text` column on the track itself.

And it is that size which justifies where the data lives. The migration
`api/internal/db/migrations/0004_picos.sql` records:

> Fica aqui, e não num objeto no R2, porque são 200 bytes e a listagem do acervo já é uma consulta
> só — buscar a forma de onda à parte seria uma viagem de rede por faixa para desenhar a primeira
> tela.

Two hundred extra bytes per row in a query that already happens, against one request per track. It
is not a hard choice once the size is measured.

## Measuring: as a stream, never in memory

`api/internal/ingest/picos.go:49-58`:

```
ffmpeg -v error -nostdin -i <file> -vn -ac 1 -ar 4000 -f s16le -
```

Each flag solves one thing:

| Flag | Why |
|---|---|
| `-vn` | embedded artwork is a video stream; without this it would enter the calculation |
| `-ac 1` | mono: an envelope does not need two channels |
| `-ar 4000` | 4 kHz — each peak summarises hundreds of milliseconds, so what matters is the envelope, not the bandwidth |
| `-f s16le -` | raw PCM to **standard output**, consumed as a stream |

The 4 kHz rate is chosen for **memory**, not quality (`api/internal/ingest/picos.go:31`). And the
comment at `api/internal/ingest/picos.go:41-43` has the number: at 4 kHz, an hour of music is 28 MB
of PCM, and the worker shares 1 GiB of temporary disk with the original file. Reading through a
`StdoutPipe`, what stays in memory is a 64 KiB buffer.

### Why RMS and not absolute peak

`api/internal/ingest/picos.go:36-39`:

> o pico cru de um trecho de música comprimida está quase sempre no teto, e a forma de onda vira um
> retângulo. O RMS é o que o olho lê como "mais alto aqui".

Modern music is compressed: the maximum value of practically any one-second window sits near 0 dBFS.
Drawing maxima produces a block. RMS — the root of the mean of the squares — measures energy, which
is what corresponds to perceived loudness.

### Why normalise against the track itself

`api/internal/ingest/picos.go:83-85`:

> uma gravação inteira baixa desenharia um fio reto se a escala fosse absoluta, e o que a barra
> precisa mostrar é o relevo DELA, não quanto ela é alta comparada com outra.

The bar answers "where is this song's chorus", not "is this song louder than that one". An absolute
scale would serve the second question, which nobody asks while looking at a progress bar.

### Two loop details an `io.ReadFull` would get wrong

**The sample split across reads.** Each sample is 2 bytes, and a 64 KiB read can end in the middle
of one. `api/internal/ingest/picos.go:97-110` holds the stray byte and prepends it on the next
iteration. Without that, every sample after the first odd-length read would be shifted by one byte —
and the result would be plausible noise, not an error.

**The last bucket absorbs the overflow** (`api/internal/ingest/picos.go:113-119`): *"a duração do
ffprobe erra por frações de segundo, e o fim da faixa é justamente onde o fade precisa aparecer
inteiro."* The samples-per-bucket count comes from an estimate; the clamp ensures the remainder of
the track is neither discarded nor overflowing the array.

## The alphabet exists in two languages, and a test guards both

The codec exists twice: in Go (`api/internal/ingest/picos.go`) and in TypeScript
(`packages/core/src/waveform.ts`). Not by carelessness — the API image is built with the `api/`
context only, so nothing there can import a file from the monorepo.

The risk of that is specific and silent (`api/internal/ingest/picos.go:21-25`):

> Tem de ser IGUAL ao de `packages/core/src/waveform.ts`. Se os dois saírem de acordo, a forma de
> onda aparece embaralhada e nada falha em voz alta — é por isso que `TestPicosAlfabetoBateComOCore`
> lê o arquivo do core e compara.

A Go test that opens a TypeScript file and compares the alphabet character by character. It is ugly
and it is the only thing that kills that mutant: **no functional test on either side would fail** if
the alphabets diverged — the codec would keep encoding and decoding consistently within each
language, and the defect would show up as a strange drawing nobody would recognise as a bug.

Worth saying that the alphabet is exactly the base64url set, but the codec **is not** base64: it is
one character per value, with no bit packing. Real base64 would cost straddled bits on both sides
for no meaningful size gain (`packages/core/src/waveform.ts:13-21`).

## The drawing: six `path`s, not two hundred nodes

`packages/core/src/waveform.ts:139-147`: *"duzentas barras custam seis nós no DOM"* — two hundred
bars cost six DOM nodes.

`wavePaths()` (`packages/core/src/waveform.ts:148`) generates **six `path` strings** — three colour
bands (played, buffered, remaining) × two versions (the drawing and the full player's reflection).
Each bar is a vertical stroke inside one of those paths.

The alternative — one element per bar — is 200 nodes React has to reconcile on every time update,
that is, several times a second. Six nodes with a swapped `d` attribute is a problem of a different
order of magnitude.

Two geometry decisions:

**Resampling uses the maximum of the window, not the mean** (`packages/core/src/waveform.ts:51-58`).
When reducing 200 peaks to the ~60 bars that fit on a phone, the mean smooths transients and
flattens the drawing; the maximum preserves relief. It is the inverse of the choice made at
measurement time — and for a coherent reason: there the goal was measuring energy, here it is
preserving visual contrast.

**How many bars fit is measured on the box, not inferred from the viewport.** A `ResizeObserver`,
one bar every 3 px, clamped between 12 and 200 (`packages/core/src/waveform.ts:96`). Inferring it
from window width would be wrong in any layout that does not fill the screen — and the bar appears
at two different sizes in this app.

## The interaction: drag, and seek only on release

The bar captures the pointer and the drawing follows the finger, but **the track only moves on
release**.

The reason is network-shaped: seeking on every movement would make the audio stutter, because each
jump in a track arriving over the network is a new byte-range request. Dragging across the whole
track would generate dozens of `Range` requests, of which only the last matters.

On touch, CSS solves half the problem: `touch-action: pan-y` lets the vertical gesture scroll the
page and reserves the horizontal one for the bar. Without it, dragging on the bar either blocks
scrolling or the reverse — and which one depends on the browser.

And the bar is a `<button>`, not a `<span>`: you can position the track with the arrow keys, `Home`
and `End`. It used to be a `<span tabindex="-1">` only a mouse could reach.

## The honest half: a flat bar

A track with no measured peaks draws a straight line at 34% height (`picosLisos`,
`packages/core/src/waveform.ts:73`). It is still clickable and draggable — it just shows no relief.

That applies to **the entire public catalogue**, because Audius does not publish waveforms and the
app never downloads the whole file to measure. In practice, most tracks anyone sees have a flat bar.

It is a visible loss of visual density, and that is the point:

> **This way relief comes to mean exactly one thing — Ondas knows this audio.**

The hash-derived version was prettier on every screen and lied on every one of them. Trading
invented information for the absence of information made the interface poorer and made it possible
for someone to **trust** what it shows.

The client still defends the limit: the catalogue validator refuses more than 800 characters of
peaks (`packages/core/src/catalog/acervo.ts:48-69`), four times the real 200 — so an older PWA does
not stop drawing if the server ever increases the resolution.

## The debt that best-effort created

Measuring peaks is best-effort at ingestion: if ffmpeg fails, the worker logs a warning, stores an
empty string and moves on (`api/internal/worker/worker.go:187-193`). A track with no wave draws a
flat bar, and that is no reason to fail an ingestion that already uploaded the audio.

The consequence is that measuring arrived **after** part of the library: tracks ingested before the
migration ended up with a null column. Two options:

| Option | Cost |
|---|---|
| Re-ingest | A new UUID → kills already-shared `/t/...` links, and re-uploads a file that is already in the bucket |
| Re-measure and update the column | Downloads the audio from the bucket, runs the same measurer, changes **200 bytes** |

The second became `worker repicos` (`api/cmd/worker/repicos.go:84-90`), with three safeguards worth
recording:

- **Dry run is the default.** Without `--gravar`, it lists what would change and writes nothing. The
default of a command that touches production has to be the harmless one.
- **The `UPDATE` repeats the listing's condition** (`api/cmd/worker/repicos.go:64-71`): between
listing and writing, a new ingestion for the same track may have landed, and a recovery command must
never overwrite a measurement newer than its own.
- **Null and empty are the two states of "no wave"**: null is what was ingested before the column
existed, empty is what ffmpeg could not measure. The query covers both.

## What was rejected

| Option | Why not |
|---|---|
| A wave derived from the id's hash | Pretty, convincing and with no relationship to the sound |
| Measuring in the browser at play time | Would require downloading the whole file, which is what streaming avoids |
| Fetching the wave in a request per track | Twelve network round trips to draw the first screen |
| Storing peaks as a bucket object | 200 bytes fit in the query that already exists |
| Absolute peak instead of RMS | Compressed music sits at the ceiling; the drawing becomes a rectangle |
| An absolute scale across tracks | A quiet recording would draw a flat line; the bar shows its own relief |
| Real base64 | Straddled bits on both sides for no meaningful size gain |
| Sharing the codec between Go and TypeScript | The API image is built with the `api/` context only |
| One SVG element per bar | 200 nodes reconciled several times a second |
| The mean when resampling | Smooths transients and flattens the drawing |
| Inferring bar count from the viewport | The bar appears at two sizes in the same app |
| Seeking on every drag movement | One `Range` request per movement; the audio stutters |
| Re-ingesting to backfill older tracks | A new UUID kills already-shared links |

## What it cost

**The codec is written twice.** The guard is a test that reads the other language's file — ugly, and
the only thing that catches divergence.

**Most tracks show a flat bar.** The interface is visibly poorer than the version that lied. It was
the intended trade, and it is noticeable.

**Best-effort measuring created data debt** and an operations subcommand to resolve it.

**200 peaks is a fixed choice.** Increasing the resolution later would mean re-measuring everything
— which is exactly why the client accepts up to 800, so it does not break on an older PWA.

## In an interview

**"How do you draw an audio waveform without downloading the file on the client?"** By measuring
once, at ingestion, where the file is already on disk. It is 200 RMS buckets, decoded at 4 kHz mono
as a stream by ffmpeg to standard output, never in memory — at 4 kHz, an hour of music is 28 MB of
PCM, and the worker shares 1 GiB of temporary disk. The result is 200 characters of 6 bits, in a
text column that travels on a query that was already happening.

**"Why RMS and not peak value?"** Because compressed music has almost every window's peak at the
ceiling, and the drawing becomes a rectangle. RMS measures energy, which is what the eye reads as
"louder here". And I normalise against the track itself, not an absolute scale: the bar answers
"where is this song's chorus", not "is this song louder than that one".

**"You have the same codec in two languages. How do you prevent divergence?"** With a Go test that
opens the TypeScript file and compares the alphabet character by character. It is ugly and
necessary, because **no functional test on either side would fail** if they diverged: each language
would stay consistent with itself and the defect would show up as a strange drawing nobody would
recognise as a bug.

**"Isn't two hundred bars in the DOM expensive?"** It would be. It is six SVG `path` s — three
colour bands times the drawing and the reflection — with each bar being a stroke inside the path.
One element per bar would be 200 nodes for React to reconcile several times a second.

**"Why does the seek only happen on finger release?"** Because each jump in a track arriving over
the network is a new byte-range request. Seeking on every movement would generate dozens of requests
of which only the last matters, and the audio would stutter. The drawing follows the finger in real
time; the track moves once.

**"Have you made a product decision that made the interface worse?"** This one. Every track used to
have a wave derived from the hash of its id — pretty and unrelated to the sound. Today a track whose
audio the system does not know shows a straight line, and that is most tracks, because the public
catalogue publishes no waveform. The screen got poorer and relief came to mean exactly one thing. I
prefer the absence of information to invented information.
