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
| `library` | `packages/core/src/stores/library.ts` | curtidas e playlists (espelho da conta), baixadas, tamanhos, progresso |
| `session` | `packages/core/src/stores/session.ts` | usuário e se a sessão já foi lida |
| `ui` | `packages/core/src/stores/ui.ts` | tema, cursor, toast, gate, pickers, marcação, fundo |
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

- **`LibrarySnapshot`** — o que vai para o disco: curtidas, playlists, faixas baixadas, tamanhos,
preferência de *prefetch*;
- **`LibraryState`** — o snapshot mais `dl: Record<string, number>`, o progresso de download, que
**não** persiste.

Os campos do snapshot não têm o mesmo **dono**, e essa diferença é mais importante que a anterior.
`cached`, `sizes` e `prefetch` são deste aparelho — os bytes estão nele. `liked` e `playlists` são da
**conta**: desde as migrações `0006` e `0008` o servidor é o dono, e o que fica no disco é espelho. É
por isso que sair da conta zera os dois e não encosta no resto (`controller.logout`): curtidas e
playlists voltam no próximo login, os bytes não voltam de lugar nenhum.

A playlist entra no espelho pela mesma razão da curtida — a PWA abre offline e precisa desenhar a
fileira antes de falar com alguém — e com uma simplificação: **não há adoção a fazer**. Playlist
nunca existiu neste aparelho antes de existir no servidor, então o marcador `ADOTADAS_KEY` das
curtidas não tem par aqui.

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

## A aparência também é da conta — e copia o marcador sem o relógio

Tema, idioma e os ajustes do fundo (transparência, desfoque, modo) seguem a conta desde a migração
`0010`. O que este documento descreve acima continua de pé — o tema no `localStorage` porque é
síncrono, o fundo no IndexedDB porque é grande —, só que os dois passaram a ser **espelho**: a dona é
a conta, e `packages/web/src/app/prefs.ts` os regrava quando ela diz outra coisa.

Três decisões separam isto do marcador e da curtida:

- **Não há leitura própria.** As preferências chegam dentro do usuário que o `/me` do boot e o
`/login` já devolvem. O custo, aceito: um aparelho aberto por dias só vê a mudança feita em outro no
próximo boot.
- **Não há relógio.** O `PATCH` é parcial e o conflito é por campo: trocar o tema num aparelho não
desfaz o idioma trocado em outro. O único caso que um `em` resolveria — o mesmo campo mudado em dois
aparelhos, um deles offline por dias — custa um gesto para desfazer, e não paga uma tabela. Quem
decide, campo a campo, é `decidirPrefs` (`packages/core/src/prefs.ts`).
- **A imagem de fundo não sobe.** Só `wall`, o modo. Num aparelho sem a imagem, `imagem` é exibido
como capa (`wallEfetivo`) e a preferência fica como está — trocá-la ali desfaria a escolha no
aparelho que tem a imagem.

Duas chaves novas no `kv`, com papéis diferentes. `prefs-pendente` é a fila do que foi mudado aqui,
com sessão, e ainda não subiu; sai no logout, **antes** de `setUser(null)`, porque é essa linha que
leva a tela para o login. `prefs-adotadas` marca que este aparelho já entregou a uma conta o que
tinha de antes, e **nunca** é apagada: o tema fica na tela depois de sair, e sem a marca ele seria
gravado na próxima conta que entrasse.

`User.prefs` indefinido não é o mesmo que `{}`. `{}` é o servidor dizendo "esta conta nunca
escolheu"; indefinido é não haver servidor que saiba do assunto, e aí o aparelho segue só local e
não manda nada.

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

Com a migração `0007` nasceu um quarto recorte, `shared`, e ele trouxe à tona um acoplamento que
dois recortes esconderam por acidente. `promptLine` montava o comando com
`seg === 'liked' ? 'curtidas' : seg`: funcionava porque `acervo` e `offline` são a mesma palavra nos
dois vocabulários. Com `shared`, o prompt escreveria `ondas ls --shared` no meio de um app em
português. São **dois** mapas agora, e de propósito — `SEGMENT_SLUGS` para a URL (inglês) e `CHIPS`
para a tela (português) —, porque a coincidência de duas palavras não é uma regra.

## A fronteira com o cache de consultas

Duas bibliotecas de estado no mesmo app precisam de uma regra, e a do Ondas é:

| | TanStack Query | Zustand | URL |
|---|---|---|---|
| Natureza | dado de fora, que pode ficar velho | dado da sessão, sem versão no servidor | o conteúdo em foco |
| Exemplo | o catálogo | o que toca, tema, cursor | a faixa aberta, o recorte, o filtro |
| Tem revalidação? | sim | não faz sentido | é o navegador que guarda |

### O caso que não cabe na tabela: a curtida

A curtida esteve na coluna do meio até a migração `0006`, e a frase "sem versão no servidor" era
verdade. Deixou de ser. Mas ela também não foi para a coluna da esquerda, e isso não é preguiça:

**O TanStack Query é para dado que a tela LÊ de fora. A curtida a tela também ESCREVE — e escreve
offline.** A PWA é instalada e toca sem rede; curtir no avião tem de valer na hora e subir depois.
Uma consulta não tem onde guardar isso.

O molde certo já existia no repo, e é a própria sessão (`packages/core/src/auth/http.ts:76-99`): o
servidor é o dono, o IndexedDB é espelho, e sem rede a tela lê o espelho em vez de fingir que não
há nada. A curtida copia a sessão, não o catálogo. O que ela acrescenta é a **fila**
(`packages/core/src/likes/fila.ts`, `packages/web/src/app/likes.ts`), porque a sessão só precisa
ser lida offline e a curtida precisa ser escrita.

Três detalhes da fila que são regra e não implementação:

- **As duas listas são disjuntas.** `enfileirar` tira o id da lista contrária antes de pôr na sua,
  então curtir–descurtir–curtir sem rede vira **um** `add`. É isso que dispensa o servidor de
  decidir uma ordem entre apagar e inserir.
- **A fila só diminui depois do servidor confirmar, e só perde o que subiu.** Entre mandar e a
  resposta chegar a pessoa pode tocar em mais um coração; zerar a fila na volta apagaria essa
  última. Daí `semOQueSubiu` e `aplicarFila` existirem como funções puras.
- **Só o 401 invalida.** Falta de rede deixa a fila intacta e o espelho na tela — o mesmo critério
  do `restore()`. Um 401 é o servidor dizendo não, e aí o aparelho esquece o que era da conta que
  saiu (ver abaixo).

E a adoção das curtidas que já estavam num aparelho antes de tudo isso **não é um código à parte**:
é a fila pré-carregada no primeiro boot com sessão. Com isso ela herda o retry, o debounce e o
tratamento de erro de graça.

### Sair da conta tem de esquecer a curtida

Essa é a parte perigosa, e as duas falhas possíveis são a mesma: `liked` sobreviver a uma troca de
dono. Sem limpar, as curtidas de quem saiu seriam **adotadas pela próxima conta** que entrasse
naquele navegador, e subiriam para o servidor dela.

A regra é única e mora em `esquecerCurtidas` (`packages/web/src/app/likes.ts`): tudo que derruba a
sessão — o clique em `[sair]` e um 401 — zera as curtidas, a fila e o marcador de adoção. Com uma
exceção escrita lá: o aparelho que **nunca** sincronizou guarda curtidas de antes desta mudança,
que ainda não são de conta nenhuma; apagá-las seria destruir o que a adoção existe para salvar.

E a fila sobe **antes** de `auth.logout()`. Curtir e sair em seguida é um gesto só, e o debounce de
`registrar` pode nem ter disparado — depois que o cookie morre, o PATCH só levaria 401. O e2e que
sai e entra de novo é o que trava isso.

### A playlist copia a curtida, menos a fila

A playlist é dado da conta que a tela também **escreve**, então ela segue o desenho da curtida:
servidor como dono, IndexedDB como espelho, 401 como único invalidador, e `esquecerPlaylists` no
logout pelo mesmo risco de a próxima conta herdar o que não é dela.

O que ela **não** copia é a fila (`packages/web/src/app/playlists.ts`). Curtir é reflexo que se faz
sem rede, e perder o gesto seria perder a informação; criar e reordenar playlist é trabalho
deliberado, e sem rede a resposta honesta é recusar e dizer. Uma reordenação guardada para aplicar
depois, sobre um estado que mudou, é pior que a recusa.

A exceção é o `J`/`K`, e ela é a única escrita otimista daqui: a tecla repetida precisa mover a linha
no mesmo quadro, senão a pessoa aperta cinco vezes esperando a rede e a faixa anda cinco casas de uma
vez. O otimismo sai barato porque a correção é de graça — **toda** resposta da API é a coleção
inteira, então uma falha restaura o estado de verdade sem nenhum código de desfazer. E a ordem
pendente sobe **antes** de `auth.logout()`, pelo mesmo motivo da fila de curtidas.

### O marcador copia a curtida, com uma fila de tamanho um

Desde a migração `0009` a conta lembra **onde parou**: a última faixa e o segundo dela
(`packages/web/src/app/historico.ts`). É o terceiro dado da conta que a tela escreve, e o desenho é o
da curtida — servidor como dono, espelho no IndexedDB (chave `marcador`), 401 como único invalidador,
`esquecer()` no logout. A "fila" aqui tem tamanho um: só o marcador mais recente importa, então em
vez de fila há um campo `pendente` no espelho.

Três coisas nele não têm par na curtida, e as três vêm de o player estar no meio.

**O `playerStore` continua não sendo persistido.** O que persiste é um *derivado* dele, e quem decide
quando gravar é uma função pura do core, `observar` (`packages/core/src/historico/marcador.ts`), que
recebe amostras do player e devolve efeitos: espelhar a cada 5 s de música, subir a cada 15 s, subir
na hora em pausa, salto e primeiro som de uma faixa. O módulo da web só assina a store e executa os
efeitos. A alternativa — `persist` no store — gravaria `t` quatro vezes por segundo e levaria junto
`playing`, que restaurado como `true` é uma mentira.

**Restaurar é ARMAR, e não carregar.** No boot a faixa do marcador entra na store por `loadPaused`
(pausada, na posição) e o motor de áudio **não fica sabendo**. O `engine.load` só acontece no
primeiro play, já com o ponto de partida. Carregar no boot daria ao `engine.on('error')` — que pula
para a próxima faixa e a toca — a chance de fazer som sozinho por causa de um stream que morreu desde
ontem. A regra "guarde o id" vale inteira aqui: o marcador guarda `trackId`, e o índice sai de
`indexOfTrack` na hora de armar, contra a lista daquele aparelho.

**O conflito entre aparelhos tem duas metades, uma em cada lado do fio.** O servidor ignora a escrita
mais velha que a vigente, pelo relógio de quem ouviu (assunto do
[documento 08](08-auth.md)). E o cliente não escreve nada enquanto não sai som: `observar` só emite
efeito para faixa que já `tocou`. Sem a segunda metade a primeira não serve — um celular esquecido
aberto, com a faixa de ontem armada, carimbaria "agora" a cada volta para a tela e venceria sempre.

O **histórico** é irmão do marcador e é o primeiro dado de conta a morar no TanStack Query além do
catálogo (`packages/web/src/query/historico.ts`): ele é lista que vem de fora e pode ficar velha, que
é a definição da coluna da esquerda na tabela acima. Como o cache inteiro vai para o IndexedDB, a
consulta é removida no logout e no 401, pelo mesmo motivo de `CATALOG_LOGADO_KEY`. A escrita — uma
faixa que passou de trinta segundos de escuta — é otimista com fila (`historico-fila`), como a
curtida.

E ele é o único recorte que guarda um **retrato** da faixa (título, artista, duração), e não só o id.
Curtida e playlist são filtros sobre o catálogo carregado e aceitam "decair" quando o trending gira;
um histórico que encolhe sozinho não é um histórico. A faixa que saiu do catálogo aparece como linha
de retrato, sem capa nem botão de baixar, e tocá-la abre o endereço dela — o caminho que já existia
para "faixa que não está na lista" (`TrackRoute`).

### A fila de reprodução deixou de ser o catálogo

`j`/`k` já andavam pelo que está na tela; `n` não. Ele andava pelo catálogo inteiro, o que em
`~/biblioteca --curtidas` já significava sair do recorte na primeira tecla. Com playlist isso deixa
de ser esquisitice e passa a ser defeito: tocar uma playlist a abandonaria na segunda faixa.

`QueueContext` ganhou `fila`: os ids visíveis, que o `TrackList` já empurrava para o controller. O
detalhe que faz a mudança ser pequena é que `tracks` continua sendo o catálogo completo e é ele que
dá o índice — as regras de acesso dependem da posição global (`isLocked`, e o heurístico `index % 3`
do protótipo por baixo dela). A fila decide só o **caminho**, e `stepIndex` devolve índice global de
volta. Fila vazia cai no comportamento anterior, que é o que mantém os testes antigos de `queue.ts`
válidos sem uma linha de mudança.

Duas regras ficaram escritas porque a aritmética circular não as daria de graça: id da fila que não
está no catálogo **some do caminho** (faixa pública que saiu do trending e continua na playlist), e
faixa atual **fora** da fila faz `n` entrar pela primeira linha e `p` pela última.

A regra pega bem, e paga uma dívida concreta. A chave do catálogo é **escopada pela sessão e pela
preferência** (`packages/web/src/query/catalog.ts:41`), em três: `[...,'visitante']` para quem não
tem conta, `[...,'logado','com-publico']` para quem tem e mantém o catálogo público, e
`[...,'logado','so-acervo']` para quem o desligou. Entrar, sair ou desligar troca de catálogo em
vez de reaproveitar o anterior, *"e o cache persistido do visitante nunca guarda faixa do acervo"*.

Os dois escopos do logado ficam sob um prefixo comum (`CATALOG_LOGADO_KEY`,
`packages/web/src/query/catalog.ts:25`) porque duas operações precisam alcançar **os dois**: sair da
conta, que remove as consultas do logado (`packages/web/src/app/controller.ts:322`) para não deixar
metadados de faixa própria no aparelho esperando o próximo visitante, e a invalidação depois de um
envio (`packages/web/src/app/uploads.ts`), sem a qual a faixa nova não apareceria justamente para
quem usa o acervo puro. O filtro do TanStack é `exact: false` por padrão, então uma chave cobre os
dois — e listá-los à mão seria uma lista que alguém esquece no dia em que aparecer um terceiro.

Se o catálogo morasse num store persistido à mão, essa limpeza seria uma linha que alguém teria de
lembrar de escrever.

### A quarta volta do mesmo bug: trocar de escopo esvazia a lista

A lição do começo deste documento voltou mais uma vez, agora por uma porta que não existia: a
preferência de catálogo público. Desligá-la troca a chave da consulta, e por **um commit** o `data`
é `undefined` — o efeito de `AppLayout` chama `setTracks([])`, a reancoragem não acha o `curId` e
crava `cur: -1`. A barra de baixo desaparece com o áudio ainda tocando.

Para faixa do acervo isso se cura quando a consulta nova resolve. Para a faixa **pública** que
estava tocando, não se cura nunca: ela não está mais na lista.

A correção não mora em `setTracks` — ele está certo, e reancorar é o trabalho dele. Mora na ordem de
`controller.togglePublico`: grava no servidor, manda a faixa pública que toca para as `avulsas`
(que `comFaixasAvulsas` anexa a qualquer catálogo), **semeia** a chave nova com `setQueryData`, e só
então troca a sessão. Nenhum commit chega a ver a lista vazia, nos dois sentidos — e a semente só
entra quando a chave nova está vazia, senão religar dentro das 24h de `gcTime` jogaria fora a lista
misturada que ainda estava boa.

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
