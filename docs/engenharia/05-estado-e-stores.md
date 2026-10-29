---
title: "Guarde o id, nunca a posição: a lição que este projeto aprendeu três vezes"
date: 2026-10-19
description: "Oito stores, duas estratégias de persistência e um bug que voltou três vezes com nomes diferentes — porque a lista de faixas muda de tamanho quando alguém entra na conta."
slug: "ondas-estado-e-stores"
draft: true
tags:
  - arquitetura
  - react
  - estado
---

Existe um bug neste projeto que apareceu três vezes, com três nomes diferentes, e sempre pela mesma
causa. Ele é a melhor coisa que eu tenho para contar sobre gerência de estado, porque não é sobre
qual biblioteca usar — é sobre o que uma referência significa quando a coleção referida pode mudar
de tamanho embaixo dela.

Este documento é sobre os oito stores do Ondas, a fronteira entre eles e o cache de consultas, e
esse bug.

## O problema: a lista muda de tamanho quando alguém entra

O catálogo do Ondas tem duas fontes. Para visitante, só o catálogo público. Para quem tem conta, as
faixas do acervo privado entram **na frente** da lista (`packages/core/src/catalog/resolve.ts:71`).

Isso quer dizer que entrar na conta insere N itens no começo de um array, e sair remove. Toda
posição desloca. E um player tem várias coisas que apontam para "aquela faixa ali":

- o que está tocando agora;
- o cursor da lista, movido por `j`/`k`;
- a próxima faixa, para o *prefetch*;
- o número que aparece na calha de cada linha.

Se qualquer uma dessas for guardada como **índice**, ela passa a apontar para outra faixa no
instante em que alguém faz login. O sintoma não é um erro: é o player mostrando uma faixa e tocando
outra.

## A decisão: id na memória, índice só na borda

A regra que o projeto convergiu, depois de errar três vezes:

> **Estado guarda id. Índice existe só no instante do uso, derivado do id.**

Ela aparece em três lugares, e vale olhar os três porque são o mesmo erro em escalas diferentes.

### Primeira vez: o que está tocando

`packages/core/src/stores/player.ts:39` guarda **os dois**: `cur` (índice) e `curId` (id). O
comentário em `packages/core/src/stores/player.ts:6` diz por que o id existe: *"sobrevive a
reordenações da lista"*.

O índice continua existindo porque o motor de áudio e a navegação de fila trabalham com posição. O
que resolve é **reancorar na troca de lista** — `setTracks`, no controller, não aceita a lista nova
em silêncio (`packages/web/src/app/controller.ts:39`): ele recalcula `cur` por
`indexOfTrack(next, curId)`. Sem essa linha, o player mostraria uma faixa e tocaria outra.

### Segunda vez: a identidade da faixa dentro do domínio

`indexOfTrack(tracks, id)` (`packages/core/src/queue.ts:80`) tem dez linhas de comentário explicando
a reancoragem, e existe para que a conversão id → índice tenha **um lugar só** no código. Essa é a
parte que o primeiro conserto não resolveu: eu tinha corrigido o sintoma num ponto, e a conversão
continuava espalhada.

### Terceira vez: o cursor da lista

Quando `j`/`k` entraram, o cursor nasceu como id — `cursorId: string | null`
(`packages/core/src/stores/ui.ts:39-45`) — com a justificativa escrita no próprio store: entrar na
conta põe o acervo na frente e deslocaria todo índice.

E aqui é onde a lição fica interessante, porque há um **contraexemplo deliberado**. O número que
aparece na calha de cada linha é a posição no catálogo **inteiro**, não no recorte visível
(`packages/web/src/hooks/useTrackRows.ts:58`). Então `:08` significa a mesma faixa em qualquer aba.
Em troca, nas abas filtradas os números são esparsos — `03`, `17`, `42` — e a faixa 08 pode não
estar na tela. A resposta foi fazer o comando `:08` **levar** para a aba onde os números são
contíguos, em vez de inventar uma numeração por aba.

Ou seja: índice *é* a coisa certa quando ele é a identidade que o usuário vê. O erro é usá-lo como
identidade **interna**.

## Oito stores, e por que quatro são "vanilla"

| Store | Onde | Guarda |
|---|---|---|
| `player` | `packages/core/src/stores/player.ts` | o que toca, tempo, buffer, shuffle, repeat |
| `library` | `packages/core/src/stores/library.ts` | curtidas, baixadas, tamanhos, progresso |
| `session` | `packages/core/src/stores/session.ts` | usuário e se a sessão já foi lida |
| `ui` | `packages/core/src/stores/ui.ts` | tema, cursor, toast, gate, picker, fundo |
| `avulsas` | `packages/web/src/app/extras.ts` | faixas abertas por link direto |
| `guest` | `packages/web/src/app/guest.ts` | modo visitante (não persiste) |
| `uploads` | `packages/web/src/app/uploads.ts` | fila de envio de arquivos |
| `splash` | `packages/web/src/app/splash.ts` | a tela de abertura |

Os quatro de `core` usam `createStore` de `zustand/vanilla`, não o `create` com React. A diferença
importa por um motivo concreto: **o controller imperativo não roda dentro do React**. Ele é um
módulo de funções (`packages/web/src/app/controller.ts`), chamado por atalhos de teclado, por
*listeners* do elemento de áudio e por ações do Media Session — contextos onde não existe hook.

Com stores vanilla, ele faz `playerStore.getState()` e pronto. Os hooks tipados ficam numa camada
fininha na web (`packages/web/src/app/stores.ts:48-51`), uma linha cada, via `useStore`. Os
componentes usam os hooks; o controller usa `getState`. Nenhum dos dois sabe da existência do outro.

Os quatro stores da web usam `create` com React porque são estado de interface que só a interface
lê.

## O que persiste, e o que não pode persistir

`library` é o exemplo mais limpo de uma fronteira que normalmente fica implícita. O store separa
dois tipos por construção (`packages/core/src/stores/library.ts:4-9`):

- **`LibrarySnapshot`** — o que vai para o disco: curtidas, faixas baixadas, tamanhos, preferência
de *prefetch*;
- **`LibraryState`** — o snapshot mais `dl: Record<string, number>`, o progresso de download, que
**não** persiste.

O mecanismo é um closure chamado `commit` (`packages/core/src/stores/library.ts:44-47`): ele aplica
a mudança e chama `persist?.(snapshotOf(get()))`. E `setDl`
(`packages/core/src/stores/library.ts:71`) é a única ação que **não** usa `commit` — usa `set` cru.

Essa única linha de diferença é o que impede o progresso de um download de gerar uma escrita em
IndexedDB a cada 150 ms. A fronteira não é um comentário dizendo "não persista progresso": é a
ausência de um `commit`.

O store de interface faz a mesma separação de outro jeito. Nem todo campo de `ui` persiste — só as
preferências de fundo —, e a escolha é implementada como uma assinatura com comparação manual de
quatro campos antes de gravar (`packages/web/src/app/stores.ts:27-38`). O tema, por sua vez, mora no
`localStorage` e não no IndexedDB, porque precisa ser lido **antes do primeiro paint**, de forma
síncrona (assunto do [documento 07](07-tema-e-design-system.md)).

E um detalhe que parece pequeno: o fundo personalizado é um dataURL de até ~1 MB, que estouraria a
cota de 5 MB do `localStorage` (`packages/web/src/app/stores.ts:22-26`). É o mesmo app usando os
dois armazenamentos por razões opostas — um porque é síncrono, o outro porque é grande.

## O terceiro dono: a URL

O store de interface guardava mais do que devia. Aba, recorte da biblioteca, chip de gênero e termo
de busca eram campos de `ui` — e nenhum deles sobrevivia a um reload, nenhum era linkável, e a aba
chegou a ter **dois** donos (o campo `tab` e o pathname), que divergiram até o campo virar código
morto que ninguém lia.

Hoje a regra é: **o que descreve o conteúdo em foco mora no endereço.** O recorte é path
(`/library/offline`), o chip e o termo são query (`/?genre=jazz`, `/search?q=mar`), e o player
cheio é a rota da faixa (`/t/<slug>-<id>`) em vez de um `?player=1` que sabia dizer que havia
música na tela mas não qual. O que sobra em `ui` é o que não é conteúdo: tema, cursor, toast, gate,
picker e as preferências de fundo.

Isso teve um custo de zero em `core`, e o motivo vale registrar: `visibleTracks`, `promptLine` e
`emptyText` (`packages/core/src/view.ts`) sempre receberam o filtro **por argumento**, nunca lendo
store. Trocar a fonte do filtro não tocou numa linha de `core` nem num teste de `core` — é o
desenho antigo pagando dividendo.

O que atravessa a fronteira em sentido contrário também é pouco: `parseLibrarySegment`
(`packages/core/src/view.ts`) é a peneira do que entra pela URL. Sem ela, `/library/lixo` faria o
prompt escrever `ondas ls --lixo` e a lista mostrar o recorte errado — a URL mandando no app.

A peneira precisa de um padrão, e ele não é constante: `defaultLibrarySegment` dá `acervo` com conta
e `liked` sem ela. É para onde vai tanto `/library` sem segmento quanto o lixo, e depende da sessão
porque sem conta o acervo não existe — abrir nele marcaria um chip que a tela nem desenha.

## A fronteira com o cache de consultas

Duas bibliotecas de estado no mesmo app precisam de uma regra, e a do Ondas é:

| | TanStack Query | Zustand | URL |
|---|---|---|---|
| Natureza | dado de fora, que pode ficar velho | dado da sessão, sem versão no servidor | o conteúdo em foco |
| Exemplo | o catálogo | o que toca, curtidas, tema, cursor | a faixa aberta, o recorte, o filtro |
| Tem revalidação? | sim | não faz sentido | é o navegador que guarda |

A regra pega bem, e paga uma dívida concreta. A chave do catálogo é **escopada pela sessão**
(`packages/web/src/query/catalog.ts:12`): `['catalog','trending','com-acervo']` para quem está
logado, `[...,'visitante']` para quem não está. O comentário em
`packages/web/src/query/catalog.ts:27-29` explica o ganho: entrar ou sair troca de catálogo em vez
de reaproveitar o anterior, *"e o cache persistido do visitante nunca guarda faixa do acervo"*.

Sair da conta então remove explicitamente as consultas do logado
(`packages/web/src/app/controller.ts:303`), porque sair sem apagar deixaria os metadados das faixas
próprias no aparelho esperando o próximo visitante. Se o catálogo morasse num store persistido à
mão, essa limpeza seria uma linha que alguém teria de lembrar de escrever.

### A exceção, e por que ela é a melhor parte

Faixas abertas por link direto ficam **fora** do cache de consultas, num store próprio. O comentário
em `packages/web/src/app/extras.ts:10-19` descreve o bug que a decisão evita, e ele é específico o
bastante para ser útil:

> A alternativa curta seria `queryClient.setQueryData(catalogKey(...), …)`, mas o próximo refetch
> do trending sobrescreveria `tracks`: no meio da escuta a faixa sumiria da lista, `setTracks`
> reancoraria para `cur: -1` e a barra de baixo desapareceria com o áudio ainda tocando.

Vale desmontar a cadeia, porque ela mostra como esses sistemas falham:

1. alguém abre um link de uma faixa que não está nas 24 do trending;
2. a faixa é resolvida pelo id e injetada na lista;
3. cinco minutos depois, o trending revalida e devolve a lista original — sem ela;
4. `setTracks` reancora pelo id, não encontra, e põe `cur: -1`;
5. a barra inferior do player, que depende de `cur >= 0`, desaparece;
6. **o áudio continua tocando**, porque o elemento de áudio não tem nada a ver com isso.

Um player sem controles e com som é um dos piores estados possíveis, e ele teria nascido da decisão
aparentemente inócua de usar o cache de consultas como lugar de guardar uma faixa. A correção é
compor **depois** da consulta: `comFaixasAvulsas(query.data, avulsas)` num `useMemo`
(`packages/web/src/query/catalog.ts:54`), devolvido como `{...query, data}`. Nenhum consumidor sabe
— todos leem `data.tracks`.

## Dois detalhes de implementação que valem a leitura

**O toast guarda o timer fora do estado.**`flash(msg)` (`packages/core/src/stores/ui.ts:106-110`)
mantém o identificador do temporizador num closure e limpa o anterior antes de criar o novo.
Mensagem nova **substitui** a anterior em vez de empilhar, e o timer não polui o estado que os
componentes observam. Guardar o timer no store faria cada toast disparar re-render de quem observa o
store inteiro.

**Uma ação com regra de produto dentro.**`setWallImage` (`packages/core/src/stores/ui.ts:127-133`) é
a única ação que faz mais do que atribuir: se o fundo está opaco, ela baixa a opacidade para 0,8. A
razão está escrita: enviar uma imagem de fundo com o fundo opaco não mostraria nada. É uma regra de
produto no lugar certo — no domínio, testável sem DOM, e não num `onChange` de componente.

Os limites de opacidade e desfoque também são aplicados **dentro** das ações
(`packages/core/src/stores/ui.ts:124-125`), não na interface. Um valor fora do intervalo não é um
problema do campo de entrada; é um problema do estado.

## O que foi descartado

| Opção | Por que não |
|---|---|
| Guardar só `cur` (índice) | Login insere faixas na frente; o player mostraria uma faixa e tocaria outra |
| Guardar só `curId` (id) | O motor e a fila trabalham com posição; a conversão aconteceria em todo lugar |
| Numerar as linhas pelo recorte visível | O mesmo número significaria faixas diferentes em cada aba, e `:08` deixaria de ser endereço |
| Zustand com React nos stores de domínio | O controller imperativo não roda dentro do React |
| Redux | Mais cerimônia para o mesmo resultado; e nada aqui precisa de viagem no tempo |
| Context API para estado de player | Re-renderiza a árvore e não funciona fora do React |
| Faixa de link direto no cache de consultas | O refetch do trending a derrubaria no meio da escuta, deixando o player sem controles e com som |
| Progresso de download no snapshot persistido | Uma escrita em IndexedDB a cada 150 ms |

## O que isso custou

**Dois campos para a mesma coisa.**`cur` e `curId` convivem, e quem mexer no player precisa saber
que a fonte da verdade é o id. Está documentado no store, mas é uma pegadinha que custou três bugs
para ficar explícita.

**Oito stores é muita superfície.** A divisão é justificável um por um — quatro no domínio porque
precisam rodar sem React, quatro na web porque são interface —, mas é mais estado para manter na
cabeça do que um store único.

**A fronteira entre as duas bibliotecas tem uma exceção.** Faixas avulsas estão fora do cache de
consultas por um bom motivo, e "está fora porque X" é um fato a mais que alguém precisa aprender.

**Números esparsos na lista filtrada.** Em `~/biblioteca --curtidas`, as linhas mostram `03`, `17`,
`42`. É estranho na primeira vez e correto na segunda: aquele número é um endereço do catálogo, não
uma contagem da tela.

## Numa entrevista

**"Como você lida com uma lista que muda de tamanho enquanto algo aponta para ela?"** Guardando id
no estado e derivando o índice no momento do uso. Aqui o problema é concreto: entrar na conta insere
as faixas do acervo **na frente** do catálogo, então toda posição desloca. Eu guardo `cur` e
`curId`, e na troca de lista reancoro `cur` pelo id. Sem isso, o player mostra uma faixa e toca
outra. Esse mesmo erro voltou três vezes no projeto, com nomes diferentes.

**"Por que Zustand vanilla e não a versão com hooks?"** Porque metade das ações do player não vem do
React — vem de atalho de teclado, de `listener` do elemento de áudio e do Media Session. Com stores
vanilla, o controller imperativo lê estado com `getState()`. Os hooks tipados ficam numa camada de
quatro linhas na web, só para os componentes.

**"Você tem TanStack Query e Zustand. Onde fica a fronteira?"** Query cuida de dado que vem de fora
e fica velho; Zustand cuida de dado da sessão, que não tem versão no servidor para reconciliar. A
fronteira paga uma dívida real: a chave do catálogo é escopada pela sessão, então sair da conta
descarta o catálogo do logado em vez de deixar metadados de faixa privada no aparelho esperando o
próximo visitante.

**"Você já tomou uma decisão de cache que ia dar errado?"** Sim, e eu peguei antes de entrar. Faixa
aberta por link direto, injetada no cache de consultas, seria derrubada pelo refetch seguinte do
trending. A cadeia é: a faixa sai da lista, a reancoragem não acha o id, `cur` vira `-1`, a barra do
player desaparece — e o áudio continua tocando. Player sem controles e com som. A correção foi
compor a faixa avulsa **depois** da consulta, num `useMemo`.

**"Onde você põe validação de valor de estado?"** Dentro da ação do store, não no componente.
Opacidade e desfoque são limitados no `set`, e a regra de produto de baixar a opacidade quando
alguém envia uma imagem de fundo também mora lá — porque é regra de domínio, testável sem DOM, e não
um detalhe do `onChange` de um controle.
