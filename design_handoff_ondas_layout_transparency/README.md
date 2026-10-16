# Handoff: Ondas — centered desktop layout + background transparency (incremental)

**Context:** the Ondas PWA (React + TS + Vite, monorepo `packages/core` + `packages/web`) is already implemented, including the brand handoff (cassette logo, splash, icons). This package adds **only two changes**. Don't touch anything else.

1. **Centered layout on desktop** (like SoundCloud)
2. **Background transparency + blur + wallpaper** (like Ghostty's `background-opacity` / `background-blur`)

`reference/Ondas Terminal.dc.html` is the interactive reference. Open it in a browser (`support.js` and `_ds/` must sit next to it), press `t` and play with the controls at the bottom of the panel.

---

## 1. Centered layout

**Rule:** full-width **bands** (background and borders run edge to edge); **content** sits in a centered column.

```css
--content-max: 1080px;
.band  { width: 100%; }                     /* bg + border */
.inner { max-width: var(--content-max); margin: 0 auto; }
```

Apply it to:
| area | band (full width) | centered inner |
|---|---|---|
| Tab bar (40px) | bg `--color-surface-a`, border-bottom neutral-800 | traffic lights, logo, tabs, palette button (`display:flex; align-items:stretch; height:100%`) |
| Main content | `main` keeps its scroll (`flex:1; overflow-y:auto`) | the existing content column (padding `16px 16px 24px`, gap 14px). It was `max-width:980px` with no centering; now it's `1080px` with `margin: 0 auto` |
| Toast | bg `--color-bg-a`, border-bottom | `padding: 6px 14px` |
| Player row | — (it lives inside the bottom bar, bg `--color-surface-a`) | the row itself gets `max-width:1080px; margin:0 auto` |
| Status line (28px) | border-top neutral-800 | items + shortcut legend |

- The full player already used `max-width: 980px; margin: 0 auto`. No change there.
- On mobile (<860px) nothing changes visually; the max-width just never kicks in.
- The scrollbar stays on the right edge of the screen (on `main`), not on the column.

## 2. Background transparency

### Settings (persisted, local)
| key | type | range | default |
|---|---|---|---|
| `opacity` | number | 0.30 – 1.00 (step 0.01) | 1 (config `defaultOpacity`) |
| `blur` | int px | 0 – 40 | 16 |
| `wall` | `'capa' \| 'imagem' \| 'nenhum'` | — | `'capa'` |
| `wallImg` | dataURL (JPEG) | — | `''` |

Put these in the existing `useSettings`/theme store (Zustand + `idb-keyval`). Store `wallImg` in **IndexedDB**, not localStorage, because of its size.

### New derived tokens
Computed in `applyTheme()` next to the existing ones:
```
--color-bg-a      = color-mix(in srgb, <bg> <op>%, transparent)
--color-surface-a = color-mix(in srgb, <surface> <op>%, transparent)   // surface = mix(fg 6%, bg)
```
`op = round(opacity * 100)`. **All other ramps stay opaque** (neutral/accent are derived from the opaque bg), so text and borders keep their contrast. Re-run `applyTheme` when the opacity changes, including during the theme picker's live preview.

### Layer structure
```
body                       background: var(--color-bg)   (opaque, behind everything)
└─ #root  (background: transparent)
   ├─ <Wallpaper/>         position:fixed; inset:-60px; z-index:0; pointer-events:none
   │                       background-image; cover; center; filter: blur(<blur>px)
   └─ <AppShell/>          position:relative; z-index:1; background: var(--color-bg-a)
       (also <LoginScreen/>)
```
- `inset:-60px` hides the faded edges of the `filter: blur`.
- **Don't** use `backdrop-filter` on the root. It creates a containing block and breaks the `position:fixed` overlays. Blur goes on the wallpaper itself, through `filter`.
- What turns translucent: the root/app (`--color-bg-a`), the tab bar and bottom bar (`--color-surface-a`), the active tab (`--color-bg-a`), the toast (`--color-bg-a`).
- **Full player (overlay):** `background: var(--color-bg-a)` plus `backdrop-filter: blur(18px)` (`-webkit-` too), which is fine because it's an isolated fixed overlay. The labels sitting on the border stay on solid `--color-bg` (they need to cover the line).
- The theme picker backdrop dropped from `rgba(0,0,0,.45)` to `.2`, so the effect shows while you adjust it.
- Gate, splash and the picker panel itself stay **opaque**.

### Render the wallpaper only when
`opacity < 1 && wall !== 'nenhum'`. With opacity = 1, nothing is rendered (zero cost).

### Wallpaper image
1. `wall === 'imagem' && wallImg` → `url(wallImg)`
2. otherwise (`'capa'`): the **current track's** artwork, or the first catalog track with artwork. It changes with the track.
3. no artwork available → fallback built from theme colors:
   ```
   radial-gradient(40% 50% at 20% 30%, var(--ansi-5), transparent),
   radial-gradient(40% 50% at 80% 70%, var(--ansi-4), transparent),
   radial-gradient(30% 40% at 60% 15%, var(--ansi-1), transparent)
   ```
Optional: a 300ms crossfade when switching covers (two layers swapping opacity).

### Image upload
`<input type="file" accept="image/*">` (hidden inside a `<label>`):
1. Load the file → draw it on a canvas with the longest side capped at **1600px** → `toDataURL('image/jpeg', 0.82)`.
2. Save it, set `wall = 'imagem'`, and **if opacity is 1, drop it to 0.80** so the effect is visible right away.
3. Revoke the temporary objectURL.

## 3. UI controls (inside the theme picker)
Below the theme list, add a block with top border neutral-800, `margin-top:8px; padding:12px 8px 4px`, gap 10px. Each row has a 19ch label in `--ansi-4` and min-height 32px:

```
background-opacity  [──────●───]  0.85
background-blur     [───●──────]  16      ← 45% opacity while opacity = 1 (no effect)
wallpaper           [capa-atual] imagem nenhum  [enviar imagem…]
```
- Native `input[type=range]` with `accent-color: var(--color-accent)`, flex 1, min-width 140px. The value sits on the right (4ch, tabular-nums). Opacity shows 2 decimals.
- Wallpaper options: the active one renders as `[label]` with bg accent-900 and text accent-200; inactive ones use neutral-400. `imagem` only appears once a `wallImg` exists. `[enviar imagem…]` is in accent-300.
- Changes apply **in real time** (`onInput`/`onChange`).
- Keep the existing footer: "j/k navegar · enter aplicar · esc fechar · passe o mouse para pré-visualizar".

## 4. Config
- New build/config flag: `defaultOpacity` (0.3–1, default 1). The user's saved value takes priority.

## 5. Acceptance criteria
- [ ] On a 1440–1920px desktop, the tabs, list, player row and status line line up on the same centered 1080px column; bands and borders stay full width.
- [ ] Mobile looks the same as before.
- [ ] Opacity 1 → identical to before, with no wallpaper rendered.
- [ ] Opacity < 1 → the wallpaper shows through the app, tab bar and bottom bar. Text stays fully legible (ramps stay opaque).
- [ ] Blur changes in real time. No bright edges show at the screen borders.
- [ ] `capa-atual` follows the track change. Without artwork, the fallback uses the theme colors.
- [ ] Image upload works, stays saved after reload, and drops the opacity to 0.80 when it was 1.
- [ ] Changing the theme keeps the opacity. The picker's live preview shows the translucency.
- [ ] Fixed overlays (full player, gate, picker, splash) keep working (no root `backdrop-filter`).
- [ ] Performance: no jank while scrolling the list with blur at 40. If there is jank on mobile, cap blur at 24 on `pointer: coarse`.

## Files
- `README.md`: this document
- `reference/Ondas Terminal.dc.html`: interactive reference. The relevant parts are `applyTheme()` (tokens `-a`), `setOpacity`/`setWallFile`, the `wallBg`/`hasWall` values, and the picker template block.
- `reference/support.js`, `reference/_ds/`: needed to open the reference
