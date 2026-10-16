# Handoff: Ondas — cassette logo, splash and app icons (incremental)

**Context:** the Ondas PWA (React + TS + Vite, monorepo `packages/core` + `packages/web`) **is already implemented**. This package adds **only** the brand: the animated cassette logo, the splash screen and the PWA icons/manifest. Don't change anything else.

The files here are **design references**. Recreate them following the existing codebase's patterns. `reference/Ondas Terminal.dc.html` shows the logo applied and animated (open it in a browser; `support.js` must sit next to it).

## 1. `<CassetteLogo />` component
Create it in `packages/web/src/components/CassetteLogo.tsx`, as inline SVG with colors from the active theme's CSS vars (so the logo follows the theme).

```ts
type Props = { playing?: boolean; progress?: number /*0..1*/; label?: boolean; speed?: number /*s per turn, default 1.8*/; size?: number|string }
```

viewBox `0 0 64 42`, `width: 100%` (the container sets the size). Layers, back to front:

| element | geometry | fill / stroke |
|---|---|---|
| body | `rect x1 y1 w62 h40 rx4` | fill `--color-surface`, stroke `--color-text` 1.6 |
| screws | `circle r0.9` at (4.5,4.5) (59.5,4.5) (4.5,37.5) (59.5,37.5) | `--color-neutral-600` |
| label | `rect x7 y5 w50 h24 rx2` | fill `--color-bg`, stroke `--color-neutral-700` 0.8 |
| label stripe | `rect x7 y5 w50 h2.2` | `--color-accent` |
| label text (if `label`) | `text x32 y27.4 anchor middle, 2.6, letter-spacing .3` — `ONDAS · LADO A` | `--color-neutral-500`, JetBrains Mono |
| window | `rect x14 y10 w36 h14 rx7` | fill `--color-neutral-900`, stroke `--color-neutral-600` 0.8 |
| left reel | center (23,17) | see below |
| right reel | center (41,17) | see below |
| trapezoid | `path M16 41 L19.5 33.5 H44.5 L48 41` | no fill, stroke `--color-neutral-600` 0.9 |
| holes | `circle r1.3` at (25,37.5) (39,37.5) | `--color-neutral-700` |

**Reel:**
- **Tape pack:** `circle` in `--color-neutral-700`, not animated. Radius: left `2.9 + 3.6·(1−progress)`, right `2.9 + 3.6·progress`. The tape passes from one side to the other as the track advances.
- **Hub** (`<g>` that spins): `circle r2.6` with fill `--color-neutral-900` and stroke `--color-accent` 1.2, plus 3 spokes from the center to the edge at 0°/120°/240° (stroke accent 1.2, round cap).
- **Animation** on the hub `<g>`:
  ```css
  transform-box: fill-box; transform-origin: center;
  animation: spin var(--speed) linear infinite;
  animation-play-state: playing ? running : paused;
  @keyframes spin { to { transform: rotate(360deg) } }
  @media (prefers-reduced-motion: reduce) { animation: none }
  ```

## 2. Where to apply it
| place | size | playing | progress | speed | label |
|---|---|---|---|---|---|
| Splash | `min(220px, 56vw)` | true | splash progress | 1.2s | yes |
| Login (replaces the ASCII logo) | 92px + "ondas" 24px/500 + "lado A" 12px neutral-500, gap 14 | true | 0.3 | 3s | no |
| Tab bar, before the tabs | 34px, 10px horizontal padding, right border neutral-800. **Click → replays the splash** | player playing | track progress | 1.8s | no |
| Player row (after the PLAY/PAUSE block) | 40px | player playing | track progress | 1.8s | no |
| Full player, when the track has no cover | centered, 14% padding | player playing | track progress | 1.8s | yes |

## 3. In-app splash screen
`<Splash />` component, rendered above everything (`fixed inset 0`, z 50, bg `--color-bg`), with a centered column, gap 22px:
1. `CassetteLogo` (row 1 of the table above). Progress = `min(1, elapsed/2200)`.
2. "ondas" 30px/500, letter-spacing −0.02em, `--color-text`. Below it, "lado A · streaming independente" 12px `--color-neutral-500` (gap 6).
3. 20-character bar: `█` × filled (accent) + `░` × rest (neutral-800), where filled = round(progress·20).
4. Braille spinner `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (one frame per 80ms, accent) + message: `rebobinando · carregando metadados` while loading, then `pronto ▶`.

**Rules:**
- Closes when **≥2.2s have passed AND the catalog has loaded**, or after a 4.5s cap.
- **Tap/click** skips it.
- Clicking the logo in the tab bar replays it.
- Add an env/config flag `showSplash` (default true).

## 4. PWA icons and manifest
Copy into `packages/web/public/`:
```
favicon.svg                      ← assets/favicon.svg
icons/icon-192.png               ← assets/icon-192.png
icons/icon-512.png               ← assets/icon-512.png
icons/icon-maskable-512.png      ← assets/icon-maskable-512.png
icons/apple-touch-icon-180.png   ← assets/apple-touch-icon-180.png
icons/favicon-32.png, favicon-16.png
splash/splash-1170x2532.png      ← assets/splash-1170x2532.png
```
- **Manifest:** use `assets/manifest.webmanifest` as the base. If the project already sets the manifest through `vite-plugin-pwa`, move the `icons`, `background_color` and `theme_color` (#1e1e2e) entries into the plugin config instead of duplicating them.
- **Other iOS splash sizes:**
  ```
  npx pwa-asset-generator assets/splash.svg public/splash --splash-only --background "#1e1e2e" --index index.html
  ```
  (it inserts the `apple-touch-startup-image` tags into the head).
- **Head of `index.html`:**
  ```html
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/icons/favicon-32.png" sizes="32x32">
  <link rel="apple-touch-icon" href="/icons/apple-touch-icon-180.png">
  <meta name="theme-color" content="#1e1e2e">
  ```
- Add the new icons to the Service Worker precache (`includeAssets`).

## 5. Reference files (`assets/`)
Static assets use Catppuccin Mocha (the default theme). Inside the app, the logo uses the theme vars.
- `logo-mark.svg`: static
- `logo-mark-animated.svg`: reels spinning via CSS (README, docs, social)
- `logo-mark-label.svg`: with "ONDAS · LADO A"
- `logo-mono.svg`: single color (`currentColor`)
- `logo-lockup.svg` / `.png`: mark + "ondas"
- `favicon.svg`, `icon.svg`, `icon-maskable.svg`, `splash.svg`: the PNG sources

Note: SVGs with text use JetBrains Mono. Convert the text to outlines if they have to render without the font.

## 6. Acceptance criteria
- [ ] The logo spins only while audio is playing and pauses with the player.
- [ ] Tape moves from the left reel to the right with progress.
- [ ] Changing the theme recolors the logo immediately.
- [ ] Splash appears on boot, respects the 2.2s minimum / 4.5s cap, closes on tap, and replays from the tab bar logo.
- [ ] `prefers-reduced-motion` stops the rotation.
- [ ] Lighthouse: installable, maskable icon valid, correct apple-touch-icon.
- [ ] No regressions in the existing flows.
