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

## API do acervo (`api/`, Go)

A PWA é estática e pública; a API existe só para o que é **privado**: conta de verdade e as faixas
próprias, guardadas num bucket R2 **privado**. Ela é servida na **mesma origem**, sob `/api` — o
que dispensa CORS e deixa o cookie de sessão same-site. (A PWA ainda não consome o acervo: isso é
a fase 3 da ADR 0013.)

| Rota | O que faz |
| --- | --- |
| `POST /api/auth/signup` | cria conta (fechado por allowlist) e já devolve o cookie |
| `POST /api/auth/login` | 8 tentativas por IP em 5min, depois 429 |
| `POST /api/auth/logout` | limpa o cookie |
| `GET /api/auth/me` | sessão atual; 401 quando não há |
| `GET /api/healthz` / `readyz` | probes — `readyz` confere o banco, `healthz` não |
| `GET /api/acervo` | faixas do dono, no formato do `Track` do core |
| `GET /api/acervo/{id}/audio` | **302** para URL assinada do R2 |
| `GET /api/acervo/{id}/art` | idem para a capa (`?p=thumb` para a de 150) |
| `DELETE /api/acervo/{id}` | apaga a faixa e os objetos |
| `POST /api/acervo/ingest` | enfileira ingestão por URL — cookie **ou** `X-Ondas-Token` |
| `GET /api/acervo/ingest/{id}` | `pending \| processing \| ready \| error` |

Rodar local (precisa de um Postgres; `docker run -e POSTGRES_PASSWORD=… -p 55432:5432 postgres:16-alpine`):

```bash
cd api
DATABASE_URL='postgres://postgres:teste@127.0.0.1:55432/ondas?sslmode=disable' \
SESSION_SECRET='qualquer-coisa-local' SESSION_INSECURE=true SIGNUP_ALLOWLIST='voce@email.com' \
go run ./cmd/api
go test ./...
```

Os testes de migração precisam de banco de verdade (a corrida de dois pods subindo juntos não
aparece sem ele) e se **pulam** quando falta `TEST_DATABASE_URL`. O nome do banco tem de terminar
em `_test`: eles dão `DROP SCHEMA`, e a trava existe para que uma variável apontada por descuido
para o banco real não apague o acervo.

```bash
TEST_DATABASE_URL='postgres://postgres:teste@127.0.0.1:55432/ondas_test' go test ./...
```

### Ingestão (o contrato que o bot do Telegram vai chamar)

```bash
# Enfileira. 202 com id; 200 (mesmo id) se a mesma URL já estava a caminho.
curl -X POST https://music.thiagotn.com/api/acervo/ingest \
  -H "X-Ondas-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{"url":"https://exemplo.com/musica.mp3","title":"opcional","artist":"opcional"}'

# Acompanha.
curl -H "X-Ondas-Token: $TOKEN" https://music.thiagotn.com/api/acervo/ingest/<id>
```

Quem faz o trabalho é o **worker** (`cmd/worker`, imagem própria com ffmpeg): baixa a URL, examina
com ffprobe, extrai a capa embutida em 480 e 150, sobe no R2 privado e grava a faixa. `title` e
`artist` do pedido ganham das tags do arquivo; o que faltar vem das tags.

Três coisas que o worker **recusa**, de propósito:

- **endereço não público** — ele roda dentro do cluster, então `10.43.x.x` (services), `100.64/10`
  (malha), `169.254.169.254` e companhia são vetados. A checagem é na hora de conectar, com o IP
  já resolvido, e vale para cada salto de redirect: validar só o nome deixaria passar DNS
  rebinding;
- **arquivo grande demais** — teto em `INGEST_MAX_MB`, medido nos bytes que chegam, sem acreditar
  no `Content-Length`;
- **formato que o navegador não toca** — a régua é a tag `<audio>` (mp3, aac, flac, opus, wav), e
  quem decide o que o arquivo é é o ffprobe, não o `Content-Type` da origem.

O worker tem três subcomandos de operação, que rodam como Job com a imagem que já está no nó:

```bash
worker diag                 # grava/lê/apaga um objeto de descarte: prova a credencial
worker cors [origem]        # imprime a política de CORS para colar no painel da Cloudflare
worker conferir <track-id>  # objeto no bucket + URL assinada honrando Range (206)
```

A política de CORS vive em `internal/storage/r2.go` e sai em duas formas da **mesma** regra: o XML
do S3 API e o JSON do painel. Aplicar CORS é **configuração de bucket** e exige token
`Admin Read & Write`, que na Cloudflare é de **conta inteira** e não dá para escopar — então o
caminho normal é colar o JSON no painel, e o token do app segue sendo `Object Read & Write`
escopado ao bucket, o mínimo de que ele precisa.

O áudio nunca é servido pelo homelab: `/audio` responde **302** para uma URL assinada do R2, com
validade de uma hora. Os bytes não passam pelo túnel, e a assinatura é refeita a cada play — por
isso ela não vence dentro do cache de 24h do catálogo.

### A PWA com as duas fontes

Logado, o catálogo passa a ter duas origens: o Audius (público) e o acervo (privado). O
`loadCatalog` de `core` busca as duas **em paralelo** e são independentes — acervo fora do ar não
derruba o catálogo público e vice-versa; quem falha some da lista em vez de virar erro de tela.

As faixas próprias entram **na frente**, marcadas com `[meu]`, e o gênero `acervo` vira um filtro
de graça nos chips. A linha do prompt admite as duas:
`# 13 faixas · fonte: audius api (ao vivo) + acervo (1)`.

Três armadilhas tratadas aqui, todas com teste:

- **`cur` é índice**, e a lista muda de tamanho ao entrar e ao sair. O `controller.setTracks`
  reancora pelo `curId`, senão o player mostraria uma faixa e tocaria outra.
- **`premium: false` explícito** nas faixas do acervo: com `undefined`, o heurístico do protótipo
  (`index % 3`) marcaria música própria como `[pro]`.
- **`restore()` não derruba a sessão sem rede.** A PWA é instalada e abre offline; só um **401**
  invalida, porque só ele significa "o servidor disse que não".

Ao sair, o catálogo do logado é removido do cache persistido: os metadados das faixas próprias não
ficam no aparelho esperando o próximo visitante.

Decisões registradas em `docs/adr/0013-ondas-acervo-privado.md` no repo `homelab`: cookie HMAC em
vez de JWT, argon2id, migrações sob advisory lock, rate-limit por `CF-Connecting-IP`, bucket R2
privado com URL assinada e a trava de SSRF do worker.

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
