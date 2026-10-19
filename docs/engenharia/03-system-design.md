---
title: "O system design do Ondas: três processos e um 302 que salva o link de casa"
date: 2026-10-19
description: "Como uma PWA estática, uma API Go e um worker com ffmpeg se dividem para que o áudio nunca atravesse um túnel residencial — e quais partes podem cair sozinhas sem derrubar as outras."
slug: "ondas-system-design"
draft: true
tags:
  - arquitetura
  - system-design
  - infraestrutura
---

O Ondas roda num cluster Kubernetes de nó único, dentro de casa, atrás de um túnel. Essa frase é o
enunciado de quase todo o desenho do sistema: o link é residencial, o túnel tem teto por requisição,
e nenhuma dessas limitações é negociável. O resto é consequência.

Há um [diagrama interativo](../arquitetura.html) no repositório — abra o HTML, que é onde ele serve
para alguma coisa: dá para percorrer os três roteiros, clicar num componente para ver só as ligações
dele e traçar a rota entre dois pontos. Este documento é o raciocínio por trás dele.

## As três peças, e por que são três

| Imagem | O que é | Exposta? |
|---|---|---|
| `ondas` | nginx servindo a PWA estática | sim, `/` |
| `ondas-api` | Go em imagem `scratch` | sim, `/api` |
| `ondas-worker` | Go + ffmpeg | **não** — sem Service, sem Ingress |

A PWA **não fala com backend nenhum** para funcionar. Os metadados do catálogo público vêm direto do
navegador para a API do Audius; as faixas baixadas ficam na Cache API do aparelho. A API existe só
para o que é privado: conta de verdade e o acervo pessoal.

Isso significa que a divisão não é "frontend e backend". É **público e privado**, e a fronteira caiu
num lugar que tem uma consequência agradável: quem nunca criou conta usa um sistema que é só um
nginx com arquivos estáticos.

O worker é separado da API por dois motivos que se somam. O primeiro é operacional: baixar uma URL
arbitrária não cabe no `ReadTimeout` de 15 s do servidor HTTP
(`api/internal/db/migrations/0002_acervo.sql:24-26`). O segundo é de superfície: o worker precisa do
ffmpeg, e a API é o processo que aceita conexão da internet. Separar mantém **a dependência grande
no processo que ninguém alcança de fora** — a imagem da API é `scratch`, com dois arquivos e sem
shell.

## A API mora na mesma origem, e isso não é detalhe de deploy

`api/internal/httpapi/server.go:66-67` registra:

> **Não há CORS**: a API é servida na mesma origem da PWA (um path a mais no Ingress), o que também
> evita preflight.

Mesma origem compra três coisas de uma vez: o cookie de sessão é same-site, não há *preflight* em
nenhuma requisição, e — a parte que decide o esquema de autenticação inteiro — **uma tag `<audio>`
ou `<img>` leva o cookie sozinha**. Como nenhuma das duas aceita cabeçalho, um token em header
autenticaria o catálogo e não tocaria nenhuma faixa. Esse raciocínio está completo no [documento
08](08-auth.md).

No Ingress, `/api` é roteado **antes** de `/`, e não existe remoção de prefixo: as rotas da API
possuem `/api` nelas mesmas. Um prefixo removido no proxy é um acoplamento invisível entre o
manifesto e o código, e aqui ele não existe.

## O áudio nunca passa por casa

Esta é a decisão central do sistema. `api/internal/httpapi/acervo.go:159-164`:

> Os bytes não passam pelo homelab: o link é residencial e o túnel tem teto de ~100MB por
> requisição (ADR 0007). O que passa é um 302 de ~1KB. E como a assinatura é feita a cada
> pedido, ela nunca vence dentro do cache do catálogo.

`GET /api/acervo/{id}/audio` não serve o arquivo. Ele confere a sessão, resolve a faixa do dono,
assina uma URL temporária do bucket e responde **302** com ela no `Location`. O navegador segue o
redirect e passa a pedir intervalos de bytes direto para o R2.

O que isso resolve, em ordem de importância:

1. **O teto do túnel deixa de existir** para o caso de uso. Um set de uma hora tem ~120 MB e nunca
cabe numa requisição; em pedaços pedidos ao bucket, cabe sempre.
2. **A banda de upload de casa não é consumida.** Servir o áudio pelo cluster gastaria o upload
residencial uma vez por ouvinte.
3. **O `Range` funciona de graça.** Pular no meio da faixa é um pedido de intervalo que o R2 atende
nativamente — algo que eu teria de implementar à mão se os bytes passassem pela API.

E duas coisas que o desenho obriga a cuidar:

**A assinatura tem prazo, e o catálogo tem cache.** A URL assinada vale uma hora, mas o catálogo
fica 24 h no navegador. Por isso a URL assinada **nunca** entra no catálogo: o que vai no JSON é
sempre o endereço interno `/api/acervo/<id>/audio`, e a assinatura é refeita a cada play
(`api/internal/httpapi/acervo.go:23-24`). Guardar a assinatura no catálogo faria o áudio parar de
tocar depois de uma hora de app aberto.

**O 302 não pode ser cacheado por ninguém.** Ele carrega uma credencial com prazo; um proxy que o
guardasse entregaria a URL de uma sessão para outra. A resposta sai com
`Cache-Control: private, no-store`, e há um teste dedicado a isso
(`api/internal/httpapi/json.go:16-18`).

Por que uma hora, e não cinco minutos? Porque o prazo tem de cobrir a escuta inteira: o navegador
segue o 302 uma vez e depois pede os `Range` na URL em que caiu. Curto demais quebra o seek de quem
pausou e voltou (`api/internal/config/config.go:47-49`).

## Três domínios de falha que não se contaminam

O sistema foi desenhado para degradar em pedaços, e cada pedaço tem comportamento declarado.

**A API fora do ar.** A PWA continua inteira para o catálogo público; só o acervo some da lista.
Isso não é acidente: `loadCatalog` busca as duas fontes em paralelo e trata a falha de cada uma
isoladamente (`packages/core/src/catalog/resolve.ts:54-66`) — quem falha **sai da lista** em vez de
virar erro de tela.

**O R2 sem credencial.** A API sobe normalmente e só o acervo responde 503
(`api/internal/httpapi/server.go:50-61`): *"Credencial presente mas inválida é erro de configuração,
não motivo para derrubar o login de quem já tem conta."* O worker, no mesmo cenário, faz o
**oposto** — falha alto e entra em reinício, porque sem R2 ele não tem o que fazer
(`api/cmd/worker/main.go:84-88`). A assimetria é intencional: num processo que serve usuários,
falhar em silêncio parcial é melhor; num processo de trabalho em lote, o reinício é o sinal.

**O banco fora do ar.** Aqui a assimetria é entre as duas sondas: `/api/healthz` responde sem tocar
o banco, e `/api/readyz` faz `Ping` com 2 s de prazo (`api/internal/httpapi/server.go:145-146`). O
motivo é evitar que uma indisponibilidade momentânea do Postgres faça o orquestrador **matar** o
processo em vez de só tirá-lo do balanceamento. É um dos erros de configuração mais comuns em
Kubernetes, e a correção é escolher sondas diferentes.

**O Audius fora do ar.** O catálogo público tem três níveis
(`packages/core/src/catalog/resolve.ts:75-91`): API ao vivo → metadados em cache local, se tiverem
menos de 24 h → catálogo demo de 12 faixas. A validade de 24 h existe por um motivo específico e não
óbvio: as capas do Audius são servidas pelo nó que guarda o arquivo, não por um CDN, e **metadados
velhos viram uma lista de capas quebradas** (`packages/core/src/catalog/resolve.ts:11-15`).

## A prévia de link, e um `proxy_pass` que não existe

A PWA é estática, então o robô que desembrulha um link no WhatsApp receberia um HTML sem nada da
faixa. A solução tem duas partes.

No nginx, um `map` de User-Agent reconhece dezoito robôs conhecidos e **só eles** são mandados para
a rota de prévia (`packages/web/nginx.conf:33-36`). Gente continua recebendo o
`packages/web/index.html` e a SPA.

E o encaminhamento é um **302, não um `proxy_pass`** (`packages/web/nginx.conf:86-95`). A razão é
boa o bastante para virar regra geral: o nginx resolve o nome do upstream **no start**, então
apontar para o serviço da API derrubaria o pod da PWA em reinício contínuo sempre que o DNS da API
falhasse. Hoje a API fora do ar degrada apenas o acervo; com `proxy_pass`, ela derrubaria o site
estático junto. O redirect reentra pelo Ingress — que já roteia `/api` — e a imagem da PWA segue sem
conhecer o nome de nenhum serviço do cluster.

Para faixa do acervo, a prévia é genérica e **idêntica para qualquer id**, sem tocar no banco
(`api/internal/httpapi/og.go:93-95`): um 404 diferenciado já contaria a um estranho que aquele
identificador existe.

## Onde o estado mora

| Estado | Onde | Observação |
|---|---|---|
| Contas, faixas do acervo, fila de ingestão | Postgres | banco e papel próprios por aplicação |
| Áudio e capas do acervo | bucket R2 privado | sem domínio público; só URL assinada |
| Metadados do catálogo | IndexedDB `ondas` | validade de 24 h |
| Cache de consulta | IndexedDB `ondas-query` | banco separado, de propósito |
| Faixas baixadas | Cache API `ondas-offline` | fora do Service Worker |
| Tema | `localStorage` | tem de ser síncrono, antes do primeiro paint |

Os dois bancos IndexedDB separados têm uma razão técnica concreta: `createStore` do `idb-keyval` só
cria o *object store* quando o banco nasce, então dividir o banco `ondas` para o cache de consulta
falharia com `NotFoundError` (`packages/web/src/query/client.ts:10`).

E as faixas baixadas ficam **fora** do Service Worker de propósito: o SW só pré-cacheia o app shell,
e o áudio é escrito e lido só pelo armazenamento offline, para que o índice da biblioteca e os bytes
em disco nunca divirjam (`packages/web/src/sw.ts:9-16`). O detalhe está no [documento
06](06-pwa-e-offline.md).

## Um aprendizado de produção que mudou o desenho

A API roda as migrações no start do próprio processo. Isso funcionou até o primeiro rollout, e
`api/internal/db/pool.go:47-56` guarda o que aconteceu:

> Tudo corre sob um advisory lock porque dois pods sobem juntos em qualquer rollout (maxSurge)
> — e `CREATE TABLE IF NOT EXISTS` NÃO é atômico no Postgres: as duas sessões passam pela
> checagem de existência e uma estoura com duplicate key em pg_type. Foi exatamente o que
> derrubou o primeiro boot desta API em produção.

A correção foi um `pg_advisory_lock` em volta de toda a sequência de migração, numa única conexão
tomada do pool do começo ao fim, com desbloqueio explícito sob um contexto que não cancela. O
documento 10 detalha a mecânica. O que vale aqui é a lição de desenho: **"idempotente" e "seguro
para concorrência" não são a mesma propriedade**, e o rollout é o lugar onde a diferença aparece.

## O que foi descartado

| Opção | Por que não |
|---|---|
| Servir o áudio pela API | Teto de ~100 MB por requisição no túnel, banda de upload residencial, e `Range` a implementar na mão |
| URL assinada dentro do catálogo | O catálogo fica 24 h no navegador e a assinatura vale 1 h |
| Bucket público ou domínio `r2.dev` | O acervo é privado; um objeto legível sem assinatura anula a autorização |
| `proxy_pass` do nginx para a API | nginx resolve upstream no start; a PWA cairia em reinício quando o DNS da API falhasse |
| Um processo só, servindo HTTP e ingerindo | Download de URL arbitrária não cabe no timeout de leitura, e a API passaria a carregar ffmpeg |
| Renderização no servidor para a prévia de link | A PWA é estática; a prévia é um redirect para uma rota que só robô recebe |
| Áudio no cache do Service Worker | Faixas são grandes e pedidas por `Range`; ocupariam o cache do app shell |
| Migração em initContainer | Um segundo artefato para manter em sincronia; embutida no binário por `go:embed` não há |

## O que isso custou

**O áudio depende de um terceiro para ser entregue.** Se o R2 ficar fora do ar, não há plano B: o
cluster não tem os bytes. É o preço de não ter os bytes passando por casa, e é uma troca que eu
faria de novo — mas é uma dependência externa no caminho crítico.

**O catálogo tem duas fontes com falhas independentes, e isso complica o estado.** A lista muda de
tamanho ao entrar e ao sair da conta, e porque as faixas próprias entram **na frente**, todo índice
desloca. Isso gerou três bugs distintos antes de o padrão ficar claro: guardar sempre o id, nunca a
posição. O [documento 05](05-estado-e-stores.md) é sobre isso.

**O `map` de User-Agent é uma lista que envelhece.** Robô novo recebe o app em vez do cartão, e o
comentário no nginx assume isso explicitamente: errar para o lado do app é o certo.

**O rate-limit mora na aplicação porque o proxy do cluster não vê o IP real.** Funciona, e deixa a
API com uma responsabilidade que normalmente é de infraestrutura.

## Numa entrevista

**"Desenhe o sistema."** Três processos. Uma PWA estática servida por nginx, que não precisa de
backend para o catálogo público — os metadados vêm direto do navegador para uma API pública. Uma API
em Go na **mesma origem**, sob `/api`, que cuida só do que é privado: conta e acervo. E um worker
sem Service nem Ingress, que puxa trabalho de uma fila no Postgres e tem o ffmpeg. O estado está em
Postgres, num bucket privado e em três armazenamentos do navegador.

**"Como você serve arquivos grandes de um servidor residencial?"** Não servindo. A rota de áudio
responde 302 para uma URL assinada do bucket, com validade de uma hora. O que atravessa o túnel de
casa é um redirect de ~1 KB; os bytes vão do bucket direto para o navegador, com `Range` nativo.
Isso resolve o teto por requisição do túnel, a banda de upload e o seek, de uma vez.

**"Por que a validade é de uma hora e não de cinco minutos?"** Porque o prazo tem de cobrir a escuta
inteira. O navegador segue o redirect uma vez e depois pede os intervalos de bytes na URL em que
caiu — com cinco minutos, quem pausa e volta perde o seek. E por isso mesmo a URL assinada nunca vai
dentro do catálogo, que fica 24 h no aparelho: ela é emitida a cada play.

**"O que acontece quando cada parte cai?"** API fora: o catálogo público funciona, o acervo some da
lista — as duas fontes são buscadas em paralelo e a falha de uma não contamina a outra. R2 sem
credencial: a API sobe e só o acervo responde 503, porque um segredo ausente não pode derrubar o
login; o worker, no mesmo cenário, falha alto de propósito. Banco fora: `readyz` falha e o pod sai
do balanceamento, mas `healthz` não toca o banco, então ninguém mata o processo por uma
indisponibilidade momentânea.

**"Qual foi o erro de arquitetura que você só descobriu em produção?"** Rodar migração no start do
processo. Funcionou no primeiro deploy e quebrou no primeiro rollout, porque dois pods subiram
juntos e `CREATE TABLE IF NOT EXISTS` não é atômico no Postgres — as duas sessões passam pela
checagem e uma estoura com chave duplicada. A correção foi um advisory lock em volta de toda a
sequência, numa conexão só. A lição foi que idempotência não é o mesmo que segurança sob
concorrência.
