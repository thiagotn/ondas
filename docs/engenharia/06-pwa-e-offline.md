---
title: "Três caches que não se misturam, e um Blob de 55 MB que não existe mais"
date: 2026-10-19
description: "Service Worker próprio, download em fluxo com TransformStream e por que encher o telefone precisa de uma mensagem diferente de ficar sem rede."
slug: "ondas-pwa-e-offline"
draft: true
tags:
  - pwa
  - offline
  - performance
---

Um player que promete ouvir offline tem um problema que um site não tem: ele guarda arquivos
grandes, num armazenamento que o sistema operacional pode esvaziar sem avisar, com uma cota que pode
encher no meio da escrita. Nada disso é teórico — todas as três coisas acontecem, e as três têm
tratamento próprio neste código.

Este documento cobre as camadas de cache da PWA, o download em fluxo, e os dois modos de falha que
pareciam o mesmo e não são.

## Três camadas disjuntas, e nenhuma delas cuida de áudio

`packages/web/src/sw.ts:9-16` declara a divisão:

| Camada | O que guarda | Quem escreve |
|---|---|---|
| App shell | JS, CSS, HTML, fontes, ícones | Workbox, no Service Worker |
| Faixas baixadas | os bytes do áudio | o armazenamento offline, **fora** do SW |
| Streams de áudio | nada | ninguém |

A terceira linha é a mais importante: **áudio em streaming não é cacheado**. Ele é grande, é pedido
em pedaços (`Range`) e ocuparia o cache do app shell — que existe para fazer o app abrir sem rede,
não para guardar música.

E a segunda linha tem a decisão que mais economizou dor. As faixas baixadas vão para um cache
próprio (`ondas-offline`), escrito e lido **só** pelo `CacheOfflineStore`, nunca pelo Service
Worker. O motivo está no comentário: *para o índice da biblioteca e os bytes no disco nunca
divergirem*.

Se o SW também escrevesse ali, existiriam duas fontes de verdade sobre "esta faixa está baixada?" —
o índice em IndexedDB, que a biblioteca mostra, e o conteúdo do cache, que o player usa. Elas
divergiriam no primeiro caso de borda, e o sintoma seria uma faixa marcada como disponível offline
que não toca. Uma só escritora elimina a classe inteira de bug.

Não há `runtimeCaching` configurado. A ausência é a decisão.

## O Service Worker é próprio, e tem um denylist

A configuração usa `strategies: 'injectManifest'` (`packages/web/vite.config.ts:11-45`), não
`generateSW`. Isso significa que o Service Worker é um arquivo TypeScript do projeto
(`packages/web/src/sw.ts`), e o plugin só injeta nele a lista do que pré-cachear.

A parte que vale copiar está em `packages/web/src/sw.ts:25-33`: o *fallback* de aplicação de página
única — aquela regra que faz qualquer navegação devolver o `packages/web/index.html` — tem uma lista
de exclusão:

```ts
new NavigationRoute(createHandlerBoundToURL('index.html'), {
  denylist: [/^\/healthz$/, /^\/sw\.js$/, /^\/api\//],
})
```

O raciocínio está escrito logo acima: abrir `/api/acervo` na barra de endereços **é** uma navegação,
e sem essa exclusão o Service Worker devolveria o app shell no lugar do JSON.

Esse é um bug que se instala sozinho em qualquer PWA com API de mesma origem, e ele é
particularmente desagradável porque só aparece quando o SW está ativo — isto é, nunca em
desenvolvimento, sempre em produção. É também um argumento a favor de rodar o teste de ponta a ponta
contra o build de produção, que é o que o Ondas faz ([documento 13](13-qa.md)).

O registro do SW é manual e só em produção (`packages/web/src/main.tsx:10`): em desenvolvimento ele
fica fora do caminho. E as telas de abertura do iOS — ~830 KB de PNG — são excluídas do pré-cache
(`packages/web/vite.config.ts:21-24`), porque o Safari as busca na instalação; pré-cacheá-las seria
pagar duas vezes.

## O download em fluxo, e o Blob que havia antes

Este é o conserto com o número mais concreto do projeto.

A versão anterior do download acumulava os pedaços da resposta num array e montava um `Blob` no
final. Funciona, é o que todo mundo escreve primeiro, e tem um custo que só aparece com arquivo
grande: **um arquivo de 54,9 MB virava um único `Blob` de 54,9 MB**
(`packages/web/src/platform/CacheOfflineStore.ts:62-75`).

A versão atual manda o corpo da resposta direto para a Cache API através de um `TransformStream` que
só conta os bytes de passagem (`packages/web/src/platform/CacheOfflineStore.ts:90-100`). A barra de
progresso continua funcionando, e a contrapressão é do próprio cano — se a escrita no disco for mais
lenta que a rede, o fluxo desacelera sozinho.

Para uma faixa de quatro minutos, a diferença é irrelevante. Para um set de uma hora — ~120 MB — é o
pico de memória que decide qual aba o celular mata. E essa é a razão de a correção valer: o caso que
quebra não é o caso comum, é o caso que o usuário mais quer.

O teste de regressão é uma espiã no construtor de `Blob`, exigindo que nenhum `Blob` grande exista
durante o download (`packages/web/tests/smoke.spec.ts:640`). Vale notar o que torna esse teste bom:
a primeira versão dele media o pico de memória, que é ruidoso e dependente de coletor de lixo. Medir
*"nenhum `Blob` grande foi construído"* é determinístico, e falha exatamente quando a correção for
desfeita.

## Encher o telefone não é o mesmo que ficar sem rede

Antes, as duas falhas mostravam "falha no download", e a pessoa tentava de novo — contra um telefone
cheio, onde tentar de novo não resolve nada.

`QuotaExceededError` do `cache.put` tem saída própria agora: `ehCotaExcedida(err)`
(`packages/web/src/platform/CacheOfflineStore.ts:20`) cobre os dois nomes que os navegadores usam
(`QuotaExceededError` e `NS_ERROR_DOM_QUOTA_REACHED`), e o controller dá a mensagem que diz o que
fazer (`packages/web/src/app/controller.ts:273-280`).

Duas consequências disso que são mais interessantes que a mensagem:

**A entrada parcial é apagada antes de o erro propagar**
(`packages/web/src/platform/CacheOfflineStore.ts:107-113`). Sem isso, a reconciliação do boot
encontraria os bytes incompletos e juraria que a faixa está lá — e o resultado seria uma faixa
marcada como offline que toca metade e para.

**O painel mostra quanto ainda cabe**, não quanto já foi usado
(`packages/core/src/view.ts:118-126`). É uma inversão pequena e certa: o número com que se decide
baixar um set de uma hora é o espaço livre, não o ocupado.

## O iOS apaga o armazenamento, então o boot reconcilia

O iOS evacua armazenamento de PWAs que ficam ociosas. Não há como impedir; o que há é como
descobrir.

`hydrate()` (`packages/web/src/app/hydrate.ts:11`) lê três coisas em paralelo — o snapshot da
biblioteca, a sessão e as preferências de fundo — e termina com um passo que não é leitura
(`packages/web/src/app/hydrate.ts:21-22`): compara o índice de faixas baixadas com o que de fato
existe no cache (`offlineStore.keys()`) e descarta da biblioteca o que sumiu.

É `reconcile(presentIds)` (`packages/core/src/stores/library.ts:79-90`), e ele **reconstrói** o
índice a partir do que existe em vez de confiar nele. A mesma função é reusada pelo botão de limpar
downloads (`packages/web/src/app/controller.ts:326`): apagar os bytes e depois reconciliar é mais
seguro do que apagar os bytes e zerar o índice na mão, porque as duas operações podem falhar pela
metade.

`navigator.storage.persist()` é pedido na primeira gravação
(`packages/web/src/platform/CacheOfflineStore.ts:152`). Ele reduz a chance de evacuação; não
elimina.

## Dois detalhes que custaram tempo

**A chave do cache precisa de uma barra na frente.**`keyOf(id) = '/offline/' + id`
(`packages/web/src/platform/CacheOfflineStore.ts:10`), e o comentário explica: os ids do acervo têm
o prefixo `acervo:`, então `new URL('acervo:123')` seria interpretado como **esquema** de URL. A
barra inicial força a leitura como caminho.

**O armazenamento chave-valor engole exceção de
propósito.**`packages/web/src/platform/IdbKeyValueStore.ts:11-30` envolve os três métodos em
`try/catch` sem propagar: *"Modo privado / cota cheia: a sessão segue, só não persiste."* É a
decisão certa para preferências — um tema que não salvou não é motivo para a tela quebrar — e seria
a decisão errada para os bytes de uma faixa, que é exatamente por que o armazenamento offline
**propaga** o erro de cota.

Dois armazenamentos, duas políticas de erro opostas, pela mesma razão: o que está em jogo é
diferente.

## O que foi descartado

| Opção | Por que não |
|---|---|
| `generateSW` do Workbox | O *fallback* de SPA precisa de um denylist para `/api/`; e o cache de áudio tem regra própria |
| Áudio no cache do Service Worker | Grande, pedido por `Range`, e criaria uma segunda escritora do índice offline |
| Acumular pedaços e montar um `Blob` | 54,9 MB de arquivo = 54,9 MB de pico; é o que decide qual aba o celular mata |
| `runtimeCaching` para as respostas da API | O JSON do acervo não pode ser cacheado — ele é por sessão |
| Mensagem única para falha de download | Cota cheia e rede caída pedem ações diferentes de quem está lendo |
| Confiar no índice de faixas baixadas no boot | O iOS evacua armazenamento; o índice tem de ser reconstruído do que existe |
| Pré-cachear as telas de abertura do iOS | ~830 KB que o Safari já busca na instalação |
| Propagar erro no armazenamento de preferências | Um tema que não salvou não é motivo para quebrar a tela |

## O que isso custou

**O Service Worker é código próprio para manter.**`injectManifest` traz liberdade e traz a
responsabilidade de acertar o `NavigationRoute`, o `skipWaiting` e a limpeza de caches antigos.

**Há duas políticas de erro de armazenamento no mesmo app**, e quem mexer precisa saber qual é qual:
preferências engolem, bytes propagam.

**Não há Background Fetch.** O download acontece em primeiro plano, com progresso, porque a API não
existe no Safari. Fechar a aba no meio cancela — e é por isso que a entrada parcial precisa ser
limpa.

**A evacuação do iOS não é resolvida, só detectada.** A faixa desaparece da biblioteca no boot
seguinte. É honesto e é uma experiência ruim, e a alternativa seria mentir.

## Numa entrevista

**"Como você guarda áudio offline numa PWA?"** Em três camadas que não se misturam: o app shell é
pré-cacheado pelo Workbox; as faixas baixadas vão para um cache próprio escrito só pelo meu código,
nunca pelo Service Worker; e streaming não é cacheado. A segunda regra é a que importa — com o SW
escrevendo lá também, existiriam duas fontes de verdade sobre "esta faixa está baixada", e elas
divergiriam.

**"Qual foi a otimização de memória mais relevante que você fez?"** Trocar
acumular-pedaços-e-montar-um-`Blob` por `TransformStream` direto para a Cache API. Um arquivo de
54,9 MB virava um `Blob` de 54,9 MB. Para uma faixa de quatro minutos não muda nada; para um set de
uma hora, é o pico que decide se o navegador mata a aba. O teste de regressão é uma espiã no
construtor de `Blob` — determinística, ao contrário de medir pico de memória.

**"Por que o `fallback` de SPA precisa de exclusões?"** Porque abrir `/api/acervo` na barra de
endereços é uma navegação, e o Service Worker devolveria o `packages/web/index.html` no lugar do
JSON. É um bug que só aparece com o SW ativo, ou seja, nunca em desenvolvimento e sempre em produção
— e é um dos motivos de eu rodar o teste de ponta a ponta contra o build de produção.

**"Como você trata cota de armazenamento esgotada?"** Como um caso distinto de falha de rede, com
mensagem própria, porque as ações do usuário são diferentes: tentar de novo não resolve telefone
cheio. E a entrada parcial é apagada antes de o erro propagar — senão a reconciliação do boot
acharia os bytes incompletos e marcaria a faixa como disponível.

**"O iOS apaga o armazenamento de PWAs ociosas. O que você faz?"** Não tem como impedir, então eu
detecto: no boot, o índice de faixas baixadas é reconciliado contra o que de fato existe no cache, e
o que sumiu sai da biblioteca. Também peço `storage.persist()` na primeira gravação, que reduz a
chance sem eliminar. A faixa desaparecer é uma experiência ruim; a alternativa é mostrar uma faixa
offline que não toca.
