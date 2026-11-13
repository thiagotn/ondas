# Handoff: Ondas — a marca da onda (substitui a fita cassete)

A marca do ondas é a Grande Onda de Kanagawa (Hokusai, domínio público) com o sol vermelho atrás.
Ela substitui a fita cassete de `design_handoff_ondas_brand_assets/`, que fica no repositório só
como histórico. O contrato com o app é o mesmo: um componente, as mesmas props, os mesmos cinco
lugares.

## 1. `<WaveLogo />`

`packages/web/src/components/WaveLogo.tsx`, SVG inline pintado com as CSS vars do tema.

```ts
type Props = { playing?: boolean; progress?: number /* 0..1 */; speed?: number /* s */; size?: number | string; ariaLabel?: string }
```

viewBox `0 0 48 46`, `width: 100%` (o container define o tamanho). Camadas, de trás para a frente:

| elemento | geometria | cor |
|---|---|---|
| sol | `circle cx29.5 r17`, `cy = 20 + (1 − progress)·16`, recortado em `y ≤ 42.6` | `--ansi-1` (o vermelho do tema) |
| onda | o path `WAVE`, dentro de `translate(0 8.8) scale(.8)` | `--color-accent` |
| estrias do dorso | dois traços de 1.5, ponta redonda | `--color-bg` |
| espuma | o path `CAP` + cinco círculos (os dedos) + três círculos (as gotas) | destaque 22% + branco, em oklab |
| mar | `rect y42.6 w48 h3.4` (começa acima do pé da onda, para não abrir fresta quando ela sobe) | `--color-accent` |

A onda é desenhada em 48×44 e entra a 80%, encostada no mar. É o que deixa céu por cima e à direita
da crista: o sol precisa aparecer **fora** da silhueta da onda para ler como sol atrás dela, e não
como uma bola no colo da onda.

O que faz a forma ler como onda é a **face**: depois da ponta da crista o contorno não volta para
dentro (isso fechava um "C" nas primeiras tentativas); ele desce côncavo e escorre para a direita
até virar mar.

### O que se mexe

| estado | o que acontece | onde |
|---|---|---|
| `playing` | a onda sobe e desce 1.2 unidades; as gotas escorrem | `wave.module.css` (`ondas-bob`, `ondas-drift`) |
| `progress` | o sol nasce: de quase no mar (0) até alto, atrás da crista (1) | atributo `cy` do círculo |
| pausado | as duas animações param no ponto em que estavam | `animation-play-state: paused` |
| `prefers-reduced-motion` | sem animação; o sol continua acompanhando o progresso, que é estado | media query |

### A espuma é a única cor fora dos tokens

Espuma tem de ser clara em qualquer tema. `--color-text` serviria nos oito escuros e ficaria quase
preta no claro; `--color-bg` faria o contrário. Daí `color-mix(in oklab, var(--color-accent) 22%, white)`.

## 2. Onde aparece

| lugar | largura | anima |
|---|---|---|
| abertura | `min(170px, 44vw)` | sempre; o sol nasce com a barra de carregamento |
| login e pedido de conta | 68px | sempre, devagar (`speed=3`), sol alto |
| barra de abas | 26px | quando o player toca |
| linha do player | 32px | quando o player toca |
| player cheio, faixa sem capa | o quadro da capa, com 14% de margem | quando o player toca |

A fita era larga (64×42) e a onda é quase quadrada: as larguras caíram para a altura ficar onde estava.

## 3. Ícones do sistema

Em `assets/`, com as cores do tema padrão (Catppuccin Mocha) fixas — o sistema operacional não
conhece o tema escolhido no app. Fundo `#1e1e2e`, onda `#cba6f7`, sol `#f38ba8`, espuma `#f3ecfe`.

| arquivo | o que é | vira |
|---|---|---|
| `logo-mark.svg` | a marca inteira, sem fundo | referência |
| `logo-mark-mini.svg` | a versão simplificada: sem estrias, sem dedos, uma gota só, mar mais grosso | referência |
| `favicon.svg` | a mini num quadrado de canto 14 | `public/favicon.svg`, `favicon-16.png`, `favicon-32.png` |
| `icon.svg` | a marca num quadrado de canto 112 | `icon-192.png`, `icon-512.png` |
| `icon-apple.svg` | a mesma, sem cantos e sem transparência (o iOS arredonda sozinho) | `apple-touch-icon-180.png` |
| `icon-maskable.svg` | a marca menor, dentro da zona segura | `icon-maskable-512.png` |
| `splash.svg` | marca + "ondas" + assinatura, 1170×2532 | as 18 telas de abertura do iOS |

Para regenerar os PNGs depois de mexer num SVG:

```bash
pnpm --filter @ondas/web icons    # favicon e ícones
pnpm --filter @ondas/web splash   # telas de abertura do iOS
```

## 4. Textos

A fita deixava quatro frases órfãs. Ficaram assim, nos três idiomas:

| chave | antes | agora |
|---|---|---|
| `login.assinatura` (era `login.ladoA`) | lado A | a grande onda |
| `splash.tagline` | lado A · streaming independente | a grande onda · streaming independente |
| `splash.carregando` | rebobinando · carregando metadados | subindo a maré · carregando metadados |
| `sobre.texto1` | …a fita roda… | …a onda quebra… |

A marca não leva texto dentro (a fita levava "ONDAS · LADO A" na etiqueta).
