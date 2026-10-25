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
| `pnpm test` | Vitest em `core` (216 testes) |
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
| `GET /api/og/t/{seg}` | **pública**: meta tags da prévia de link (ver *Link de faixa*) |
| `GET /api/acervo` | faixas do dono, no formato do `Track` do core — inclui `peaks`, a forma de onda medida na ingestão |
| `GET /api/acervo/{id}/audio` | **302** para URL assinada do R2 |
| `GET /api/acervo/{id}/art` | idem para a capa (`?p=thumb` para a de 150) |
| `DELETE /api/acervo/{id}` | apaga a faixa e os objetos |
| `POST /api/acervo/ingest` | enfileira ingestão por URL — cookie **ou** `X-Ondas-Token` |
| `GET /api/acervo/ingest/{id}` | `pending \| processing \| ready \| error` |
| `POST /api/acervo/upload` | reserva vaga e devolve **PUT assinado** do R2 — cookie **ou** `X-Ondas-Token` |
| `POST /api/acervo/upload/{id}/finalizar` | enfileira a ingestão do arquivo já gravado — cookie **ou** `X-Ondas-Token` |

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

URL de **página** não serve aqui, e isso não é limitação a consertar: `/ingest` quer URL de mídia.
Link do SoundCloud e do YouTube são página, então quem baixa é o **node do Hermes** (com `scdl` ou
`yt-dlp`) e o arquivo entra pelo PUT assinado — mesmo worker, mesma fila, mesmo
`GET /acervo/ingest/{id}` dali em diante. As três skills do bot vivem no repo `homelab`, em
`ansible/roles/hermes/files/skills/`.

O worker tem quatro subcomandos de operação, que rodam como Job com a imagem que já está no nó:

```bash
worker diag                 # grava/lê/apaga um objeto de descarte: prova a credencial
worker cors [origem]        # imprime a política de CORS para colar no painel da Cloudflare
worker conferir <track-id>  # objeto no bucket + URL assinada honrando Range (206)
worker repicos [--gravar]   # remede a forma de onda de quem está sem ela
```

`repicos` existe porque a medição chegou **depois** do acervo (migração `0004_picos.sql`): quem
foi ingerido antes ficou com `peaks` nulo, e a PWA desenha barra lisa — que é o certo, ela não
conhece aquele áudio. Reingerir resolveria ao custo de um UUID novo, matando os links `/t/...` já
compartilhados e subindo de novo um arquivo que já está no bucket; o subcomando baixa o áudio do
R2, roda o mesmo `ingest.Picos` da ingestão e atualiza **uma coluna de 200 bytes**, mantendo id,
capa e arquivo. Sem `--gravar` é ensaio: lista o que mudaria e não escreve nada. O `UPDATE` repete
a condição `peaks IS NULL OR peaks = ''` da listagem, para nunca passar por cima de uma medição
que tenha entrado no meio do caminho. O manifesto do Job está em `helm/apps/ondas/jobs/repicos.yml`
no repo `homelab`, de fora do `kustomization.yaml` de propósito — ele roda uma vez, não é estado
desejado.

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

### Link de faixa

Toda música tem um endereço próprio, para mandar para alguém:

```
music.thiagotn.com/t/tohaj-long-drive-J72oWO6
```

**O texto é decoração; o id é a verdade.** A leitura é uma regra só — *o token é o que vem depois
do último hífen, e o token nunca tem hífen*. Isso funciona porque o id do Audius é um hashid
alfanumérico (conferido nas 100 faixas do trending: `[A-Za-z0-9]{6,7}`), então trocar o título de
uma faixa não quebra link antigo. O codec vive em `packages/core/src/share.ts`.

Abrir o link **não passa pela tela de login**: quem recebeu quer ouvir a música, não escolher um
modo de sessão, então `/t/...` liga o modo visitante sozinho e abre o player cheio. Autoplay
continua sendo decisão do navegador — o link carrega a faixa; se o navegador barrar, ela fica
pausada com o botão pronto.

Faixa que não está nas 24 do trending é resolvida pelo id (`GET /v1/tracks/{id}` do Audius) e
entra numa lista de **avulsas**, concatenada no fim do catálogo. Ela fica fora do react-query de
propósito: no cache da query, o próximo refetch do trending a derrubaria no meio da escuta.

**Faixa do acervo é privada, e a URL também.** Ela vira `/t/_<uuid sem hífen>` — sem slug, porque
o slug sai de título e artista e estaria contando o que é a faixa para quem só recebeu o link. Sem
sessão, a rota para num aviso sem consultar nada: um 404 diferenciado já diria a um estranho que
aquele uuid existe.

#### A prévia no WhatsApp

A PWA é estática, então o robô que desembrulha o link receberia um HTML sem nada da faixa. O
`nginx.conf` tem um `map` de User-Agent que manda **só robôs conhecidos** para `/api/og/t/<seg>`,
onde o Go responde as meta tags; gente continua recebendo o `index.html`.

É um **302, não um `proxy_pass`**: o nginx resolve upstream literal no start, então apontar para
`ondas-api` derrubaria o pod da PWA em CrashLoop sempre que o DNS da API falhasse — e hoje a API
fora do ar degrada só o acervo. O redirect reentra pelo Ingress, que já roteia `/api`, e a imagem
segue sem saber o nome de nenhum serviço do cluster.

Para faixa do acervo a prévia é genérica e **idêntica para qualquer id**, sem tocar no banco.

O cliente Go do Audius tem um teste contra a API de verdade, fora do `go test ./...` porque CI não
deve depender de terceiro — rode antes de mexer no formato da resposta:

```bash
cd api && ONDAS_AUDIUS_AO_VIVO=1 go test ./internal/audius/ -run TestAoVivo -v
```

### A forma de onda

A barra de progresso desenha o áudio de verdade, e só quando ele é conhecido.

Na ingestão o worker passa o ffmpeg uma segunda vez sobre o arquivo e mede o **RMS de 200
trechos** (`api/internal/ingest/picos.go`) — menos de 0,1s por faixa, decodificando a 4 kHz mono em
fluxo para não segurar o PCM inteiro na memória. O resultado vira 200 caracteres de 6 bits, uma
coluna `text` na faixa, e sai no catálogo como `peaks`. O alfabeto é o mesmo nos dois lados
(`packages/core/src/waveform.ts`), com um teste em cada ponta para o dia em que alguém mexer em um
só.

Faixa **sem** picos medidos desenha barra lisa, de propósito: o catálogo público do Audius não
publica forma de onda (`track_segments` vem vazio), e o app nunca baixa o arquivo inteiro para
medir. Assim o relevo passa a significar uma coisa só — *o Ondas conhece este áudio*. A versão
anterior desenhava para todas uma onda derivada do hash do id: bonita, convincente e sem nenhuma
relação com o som.

O desenho são três `<path>` SVG (tocado / em buffer / resto), um traço vertical por barra, mais os
três refletidos no player cheio. Quantas barras cabem é medido na caixa com `ResizeObserver`, uma a
cada 3px. E a barra virou `<button>`: dá para posicionar a faixa com as setas, `Home` e `End` —
antes era um `<span tabindex="-1">` que só o mouse alcançava.

Posicionar é um arrasto, não um clique: a barra captura o ponteiro e o desenho acompanha o dedo,
mas **a faixa só anda ao soltar**. Procurar a cada movimento faria o áudio engasgar — cada pulo
numa faixa que vem pela rede é um pedido novo de intervalo de bytes. No toque o CSS vale tanto
quanto o código: `touch-action: pan-y` deixa o gesto vertical rolar a página e reserva o
horizontal para a barra, e `-webkit-tap-highlight-color: transparent` tira o retângulo cinza que o
Chrome no Android pinta sobre a caixa inteira do botão ao tocar.

## Arquitetura

Este README diz **o que** o sistema faz e como rodá-lo. Para **por que** cada escolha foi feita, o
que foi descartado e o que cada decisão custou, há uma série de treze documentos em
[`docs/engenharia/`](./docs/engenharia/00-indice.md) — stack, system design, frontend, backend,
infra, produto e qualidade, em português e inglês, com referências `arquivo:linha`.

E para ver o caminho **acontecer** em vez de lê-lo, [`docs/ingestao.html`](./docs/ingestao.html) é
um passo a passo interativo da ingestão: um link cai no Telegram e você acompanha, com console e
trilha de capítulos, até a faixa tocar no acervo. Quatro cenários — link de mídia direto, SoundCloud
e YouTube (os dois forçam o PUT assinado) e um SSRF negado. É um arquivo só, abre offline, em pt e
en.

[![Diagrama de arquitetura do Ondas](./docs/arquitetura.png)](./docs/arquitetura.html)

O desenho acima é um recorte estático de [`docs/arquitetura.html`](./docs/arquitetura.html) —
**abra o HTML no navegador**, que é onde ele serve para alguma coisa: dá para percorrer os três
roteiros (`tocar uma faixa`, `pôr música no acervo`, `as duas fontes do catálogo`), clicar num
componente para ver só as ligações dele, traçar a rota entre dois pontos e alternar tema. Os
rótulos das setas e os sublabels só aparecem a partir de 125% de zoom; no recorte acima eles estão
todos visíveis.

A fonte é [`docs/arquitetura.architecture.json`](./docs/arquitetura.architecture.json) — mexer no
desenho é mexer nele, nunca no HTML, que é gerado pela skill `archify`:

```bash
node ~/.claude/skills/archify/bin/archify.mjs deliver architecture \
  docs/arquitetura.architecture.json docs/arquitetura.html --quality showcase
```

O `arquitetura.png` é o Share Card do próprio HTML (`Export → Share Card`), regerado à mão quando
o diagrama muda — ele existe só porque o GitHub não renderiza o HTML.

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
- **Download grava em fluxo, não na memória.** O `put()` manda o corpo da resposta
  direto para a Cache API através de um `TransformStream` que só conta os bytes de
  passagem — a barra de progresso continua, e a contrapressão é do próprio cano.
  A versão anterior acumulava os pedaços e montava um `Blob` no fim: medido com
  uma espiã no construtor, um arquivo de 54,9 MB virava **um único Blob de
  54,9 MB**. Para uma faixa de 4 min não faz diferença; para um set de uma hora
  (~120 MB) é o pico que decide qual aba o celular mata. O teste de regressão é a
  mesma espiã, agora exigindo que nenhum Blob grande exista.
- **Encher o aparelho não é o mesmo que ficar sem rede.** `QuotaExceededError` do
  `cache.put` tem saída própria (`ehCotaExcedida`) e mensagem que diz o que fazer;
  antes as duas falhas mostravam "falha no download" e a pessoa tentava de novo
  contra um telefone cheio. A entrada parcial é apagada antes de propagar o erro,
  senão o `reconcile` do boot juraria que a faixa está lá. E o painel
  `ondas whoami` mostra quanto ainda cabe (`storageLabel`), que é o número com que
  se decide se vale baixar o set de uma hora.
- **Tema aplicado antes do primeiro paint** por um script inline no `index.html`
  (daí ele morar no `localStorage`, que é síncrono). Os tokens completos saem de
  `themeCssVars()`; `mixOklab()` resolve os mesmos valores em hex para o
  `theme-color` e para o theme provider nativo.
- **O player cheio cabe na tela no celular**, sem rolagem — rolar para alcançar
  o botão de tocar é perder o player. A conta não dá para fixar em pixels (o
  título tem de uma a três linhas, o bloco de buffer tem ou não o botão de
  baixar), então o painel vira um teto de altura e **a capa fica com o que
  sobrar**: um botão menor não serve para nada, uma capa menor serve. É o único
  `@media` do projeto, no mesmo ponto de corte do `useWide`; acima dele nada
  muda. Abaixo de ~570px de altura a capa bate no piso de 120px e a tela volta a
  rolar, que é o comportamento honesto.
- **Full player é uma rota** (`?player=1`), então o botão voltar o fecha. Conta e
  aparelho (`?conta=1`) e a janela de atalhos (`?atalhos=1`) são o segundo e o
  terceiro overlay nesse molde; os três saem do mesmo `useOverlayParam`, e
  trocar de aba limpa os três da query — antes o overlay ficava colado na tela
  depois de um `1`.
- **A fileira de dígitos cobre as telas, e `0` é "a de agora".** `1`/`2`/`3` são
  as abas, `4` o tema, `5` a conta, `6` (ou `?`) os atalhos, e `0` abre os
  detalhes do que está tocando — o mesmo que o `f` do handoff, que continua
  valendo sem ser anunciado. Os que abrem overlay **alternam**, porque `show()`
  empilha histórico e abrir o que já está aberto deixaria um "voltar" que não
  volta nada.
- **A lista de atalhos tem um dono só** (`core/src/shortcuts.ts`). Ela estava
  espalhada por quatro lugares que já tinham divergido: a legenda do rodapé
  anunciava `o` em produção, onde a tecla só existe sob `import.meta.env.DEV`, e
  não anunciava `f`, `s`, `r` nem os dígitos. Agora a janela `ondas --help` e a
  status line leem a mesma tabela, o grupo `dev` sai inteiro fora do dev, e a
  legenda pôde encurtar — o que não cabe nela está a um `?` de distância.
- **O prompt deixou de ser enfeite: `:08` leva à faixa 08.** O cabeçalho já
  desenhava `❯ ondas trending --genero=tudo` com cursor piscando, e o `:` troca
  aquilo por um `<input>` de verdade. Input, e não teclas lidas do handler
  global, porque o guarda `typing` do `useShortcuts` já desliga todos os atalhos
  enquanto se digita — sem ele, `:12` trocaria de aba no `1`.
- **O número é o da calha, que é posição no catálogo INTEIRO** (`useTrackRows`
  numera pela lista completa, não pelo recorte da aba). Por isso `:08` significa
  a mesma faixa em qualquer tela — e por isso, quando ela não apareceria no
  recorte atual, o comando leva para `~/em-alta`, que é a lista onde os números
  são contíguos. O chip de gênero só é zerado quando é ele que esconde a faixa.
- **O cursor da lista guarda `id`, nunca índice.** Entrar na conta põe o acervo
  na frente e desloca todo número; um cursor por posição passaria a apontar para
  outra faixa depois do login. Mesma lição do `curId` e do `indexOfTrack`.
- **`j`/`k` andam pelo que está na tela**, e é o `TrackList` que diz ao
  controller quais linhas são essas — ele é o único lugar que sabe. Sem esse
  fio, `j` em `~/biblioteca --curtidas` pularia para vizinhos do catálogo que
  não estão na lista. Com overlay aberto as duas teclas não fazem nada: a lista
  não está na tela, e mover um cursor invisível deixaria o `enter` tocando algo
  que ninguém viu. A marca é uma barra à esquerda, e não um `▸` na calha, que
  tem `3ch` e já mostra o número.
- **Conta e biblioteca são telas diferentes porque são coisas diferentes.** A
  conta vive no servidor e te segue para qualquer aparelho; `buffer`, curtidas e
  downloads vivem no IndexedDB **deste navegador** e não seguem ninguém. Os dois
  moravam no mesmo painel dentro de `~/biblioteca`, o que insinuava uma sincronia
  que não existe — e, de quebra, empurrava a primeira faixa para o meio da tela
  do celular. Agora a biblioteca é só biblioteca, e `ondas whoami` abre pelo seu
  próprio nome, no prompt ou na status line: ele já está na tela e já significa
  "você", então não foi preciso inventar ícone nem uma quarta aba.
- **`[sair]` não apaga o que é do aparelho** — e o painel diz isso com todas as
  letras. Quem quiser apagar usa `[limpar downloads]`, que pergunta antes e
  remove os bytes da Cache API, reconciliando o índice com o que sobrou (sem
  isso, sair deixava o áudio do acervo privado no navegador sem tela nenhuma
  para mostrá-lo).
- **Toque longo não vira seleção na casca.** Quase tudo aqui é alvo de toque, e
  segurar o dedo numa linha de faixa abria o callout do iOS ou a barra de copiar
  do Android — ruído puro. O padrão é `user-select: none` no `body`; reabilitam
  explicitamente os campos (`input`/`textarea`, senão o navegador perde cursor e
  menu de colar), o título e o artista do player cheio (o único texto que
  alguém leva embora) e o toast (o plano B do compartilhar mostra o link cru lá
  para ser copiado). O `-webkit-touch-callout` acompanha cada exceção: no iOS,
  selecionar sem callout é selecionar sem poder copiar. **Nada de `contextmenu`
  no JS** — seria a única forma de matar o menu de imagem do Android e mataria o
  clique direito do desktop junto; as capas resolvem isso com
  `pointer-events: none`, que já são decorativas (`alt=""`).
- **Sessão de visitante é efêmera**, como no protótipo: recarregar volta ao login
  (só o login persiste). Tema, curtidas e downloads sobrevivem.
- **Simulação de queda de rede** (`o` e o clique no `●`) existe apenas no build de
  dev; em produção o indicador só reflete `navigator.onLine`.
- **Faixas sem `stream`** (catálogo demo) tocam em modo simulado, para a UI
  continuar demonstrável sem rede nem API.

## Deploy

A imagem da PWA é um **nginx servindo o estático** (`Dockerfile` na raiz, multi-stage, non-root em
`:8080`, `/healthz` para as probes) e não fala com backend nenhum: os metadados do Audius vêm
direto do browser e as faixas baixadas ficam na Cache API do aparelho. O que é privado passa pelas
outras duas imagens, `ondas-api` e `ondas-worker` (acima).

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
