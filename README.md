# Ondas

Player de música com estética de terminal, fiel ao handoff em
[`design_handoff_ondas_terminal_player/`](./design_handoff_ondas_terminal_player/README.md).
A v1 é uma **PWA React + TypeScript + Vite**; o monorepo já separa a lógica de
domínio para que o app nativo (Expo) da fase 2 reaproveite tudo menos a UI.

```
packages/
  core/   TS puro, sem DOM: tipos, regras de acesso, fila, tokens de tema,
          cliente de catálogo, auth e stores (Zustand vanilla)
  web/    PWA: UI React, PlayerEngine (HTMLAudio), OfflineStore (Cache API)
apps/     (futuro) mobile/ Expo, reusando `core`
```

## Rodando

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # typecheck + build de produção da PWA
pnpm preview    # serve o build em :4173 (service worker ativo)
```

| Script | O que faz |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` nos dois pacotes |
| `pnpm test` | Vitest em `core` (90 testes) |
| `pnpm test:e2e` | Playwright na web (build + preview + smoke) |
| `pnpm --filter @ondas/web splash` | regenera as telas de abertura do iOS a partir do `splash.svg` da marca |

Antes do primeiro `test:e2e`: `pnpm --filter @ondas/web exec playwright install chromium`.

Variáveis de ambiente (opcionais, em `packages/web/.env.local`):

- `VITE_FORCE_DEMO=true` — pula a API e usa o catálogo demo de 12 faixas.
- `VITE_SHOW_SPLASH=false` — desliga a abertura no boot (o logo da barra de abas
  continua reexibindo-a sob demanda).
- `VITE_DEFAULT_OPACITY=0.85` — opacidade inicial do fundo (0,3–1) para quem
  ainda não escolheu uma; o valor salvo pelo usuário sempre tem prioridade.

## Arquitetura

**`core` não enxerga o DOM.** O `tsconfig` dele exclui a lib DOM de propósito:
`document`, `window` e `localStorage` são erro de compilação ali. Tudo que é
plataforma entra por interfaces (`src/ports/`) que a web implementa em
`packages/web/src/platform/`:

| Port | Web | Nativo (fase 2) |
| --- | --- | --- |
| `PlayerEngine` | `HTMLAudioElement` + Media Session | `react-native-track-player` |
| `OfflineStore` | Cache API (`ondas-offline`) | `expo-file-system` |
| `KeyValueStore` | `idb-keyval` | MMKV / AsyncStorage |
| `Connectivity` | `navigator.onLine` | NetInfo |
| `AuthService` | `LocalAuthService` (regras do protótipo) | OAuth/JWT |

Decisões que valem registrar:

- **Catálogo com 3 níveis** (`core/src/catalog/resolve.ts`): Audius ao vivo →
  metadados em cache local → catálogo demo. Trocar o Audius por um backend
  próprio é implementar `CatalogClient` e injetar.
- **Capa que se recupera de nó fora do ar.** As capas do Audius são servidas
  pelo nó que guarda o arquivo, não por um CDN: um catálogo de 24 faixas
  costuma espalhá-las por ~18 hosts, e basta um estar fora para a linha exibir
  imagem quebrada. Como o caminho carrega o CID, qualquer outro nó devolve os
  mesmos bytes — `artworkSources()` monta essa reserva e `TrackArt` troca de
  host no `onError`. A lista usa a variante 150x150 (5KB contra 35KB).
- **Faixa de largura total, conteúdo centralizado.** No desktop o fundo e as
  bordas da barra de abas, do rodapé e do toast vão de ponta a ponta, mas o
  conteúdo se alinha a uma coluna de `--content-max` (1080px). A rolagem
  continua na borda da tela, não na coluna.
- **Transparência sem `backdrop-filter` na raiz.** Só `--color-bg-a` e
  `--color-surface-a` ficam translúcidos; as rampas neutral/accent continuam
  derivadas do bg opaco, então texto e bordas não perdem contraste por cima do
  wallpaper. O desfoque mora na camada do wallpaper (`filter`), porque um
  `backdrop-filter` na raiz criaria um containing block e quebraria todo overlay
  `position: fixed` — full player, gate, picker e abertura.
- **A marca é um componente, não uma imagem.** O logo (`components/CassetteLogo`)
  é SVG inline pintado com as CSS vars do tema, então trocar de tema o recolore
  na hora e um só componente serve abertura, login, barra de abas, linha do
  player e a capa ausente. Os PNGs em `public/` são só para o sistema
  operacional (ícone instalado, favicon, abertura do iOS).
- **Áudio offline fora do Service Worker.** O SW só pré-cacheia o app shell; as
  faixas baixadas são gravadas e lidas pelo `CacheOfflineStore`, para o índice da
  biblioteca e os bytes em disco nunca divergirem.
- **Tema aplicado antes do primeiro paint** por um script inline no `index.html`
  (daí ele morar no `localStorage`, que é síncrono). Os tokens completos saem de
  `themeCssVars()`; `mixOklab()` resolve os mesmos valores em hex para o
  `theme-color` e para o theme provider nativo.
- **Full player é uma rota** (`?player=1`), então o botão voltar o fecha.
- **Sessão de visitante é efêmera**, como no protótipo: recarregar volta ao login
  (só o login persiste). Tema, curtidas e downloads sobrevivem.
- **Simulação de queda de rede** (`o` e o clique no `●`) existe apenas no build de
  dev; em produção o indicador só reflete `navigator.onLine`.
- **Faixas sem `stream`** (catálogo demo) tocam em modo simulado, para a UI
  continuar demonstrável sem rede nem API.

## Deploy

A imagem é um **nginx servindo o estático** (`Dockerfile` na raiz, multi-stage, non-root em
`:8080`, `/healthz` para as probes). Não há backend: metadados vêm da API do Audius direto do
browser e as faixas baixadas ficam na Cache API do aparelho.

```bash
docker build -t ondas:local .
docker run --rm -p 8080:8080 ondas:local   # http://localhost:8080
```

O destino é o **k3s do homelab** (repo `homelab`), em `https://music.thiagotn.com`:

1. `git push` na `main` → o workflow `build-image.yml` roda typecheck + testes de `core` + smoke
   da PWA, publica `ghcr.io/thiagotn/ondas:sha-<sha>` e **escreve a tag** em
   `helm/apps/ondas/kustomization.yaml` no repo `homelab`.
2. O **Argo CD** detecta o commit e faz o rollout (`prune` + `selfHeal`).

Manifests, regra do Cloudflare Tunnel e o checklist de primeira subida estão em
`homelab/docs/adr/0012-ondas-no-homelab.md`. Dois segredos no Actions deste repo:
`GITHUB_TOKEN` (automático, publica no GHCR) e `HOMELAB_DEPLOY_KEY` (deploy key de escrita do
`homelab`).

### Trocar de domínio

Nada no app conhece o hostname: o manifesto usa `start_url`/`scope` relativos, o nginx escuta em
`server_name _` e não há URL absoluta própria no código. Migrar para um domínio próprio é só
infra, em três lugares do repo `homelab` — `helm/apps/ondas/ingress*.yml`,
`helm/cloudflared/configmap.yml` e o CNAME na Cloudflare. O molde
`helm/apps/ondas/ingress-dominio-proprio.example.yml` traz o ingress pronto e o checklist; os dois
domínios podem servir o mesmo pod em paralelo durante a migração.

## Limites conhecidos no iOS (aceitos na v1)

- Áudio em segundo plano funciona na PWA instalada, mas o iOS pode suspender.
- O iOS evacua armazenamento de PWAs ociosas: no boot o índice `cached` é
  reconciliado com a Cache API e o que sumiu é descartado da biblioteca.
- Sem Background Fetch: o download acontece em primeiro plano, com progresso.
