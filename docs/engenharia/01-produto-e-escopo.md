---
title: "O handoff de design como especificação executável"
date: 2026-10-19
description: "Três pacotes de design decidiram a stack, nomearam as interfaces de plataforma e disseram o que não tocar. O que isso muda na execução — e o que o Ondas deixou de fora de propósito."
slug: "ondas-produto-e-escopo"
draft: true
tags:
  - produto
  - arquitetura
  - design
---

A maior parte do que chamo de "decisão de produto" num projeto pessoal é, na verdade, decisão tomada
no meio da implementação, quando já é caro voltar. No Ondas foi diferente: existiam três pacotes de
handoff de design no repositório **antes** do primeiro commit de código, e eles não descreviam só a
aparência. Eles decidiam a stack, nomeavam as interfaces de plataforma e, nos dois incrementos
seguintes, diziam explicitamente o que **não** mexer.

Este documento é sobre o efeito disso na execução, e sobre as linhas de escopo que o projeto
desenhou de propósito — incluindo as que doem.

## O problema que um handoff bem-feito resolve

`design_handoff_ondas_terminal_player/README.md:11` abre com uma distinção que vale mais que o resto
do pacote:

> They are **not production code**. The task is to **recreate this design in the target codebase's
> environment** […] using its established patterns and libraries.

Os arquivos de referência são protótipos HTML interativos, com a lógica inteira numa
`class Component` de estado próprio. Seria tentador portá-los. O handoff fecha essa porta na
primeira página: a referência mostra **o que** fazer, e os padrões do código de destino decidem
**como**.

Isso evitou o modo de falha mais comum de protótipo que virou produto, que é o protótipo vencer a
arquitetura. Dois sinais de que funcionou: o `class Component` do protótipo virou um módulo de
funções (`packages/web/src/app/controller.ts:29-33` registra a troca), e o heurístico de faixa
premium do protótipo — `index % 3`, uma posição na lista decidindo o que é pago — sobreviveu só como
*fallback*, com o campo real da API ganhando dele (`packages/core/src/access.ts:11`).

Esse heurístico, por sinal, cobrou seu preço depois. Quando o acervo privado entrou, as faixas
próprias precisaram de `premium: false` **explícito**, porque com `undefined` o heurístico marcaria
música do próprio dono como `[pro]` (`packages/core/src/catalog/acervo.ts:63-66`). Uma regra de
mentira que ficou no código acaba sendo consultada por quem não sabia que era de mentira.

## O handoff nomeou as portas antes de o código existir

A parte mais inesperada: `design_handoff_ondas_terminal_player/README.md:43-46` lista quatro
interfaces de plataforma por nome e assinatura.

```
PlayerEngine { load(track, src), play(), pause(), seek(s), on(event) }
OfflineStore { has(id), get(id), put(id, stream, onProgress), remove(id), usage() }
KeyValueStore { get, set }
Connectivity { isOnline(), subscribe(cb) }
```

É literalmente o que existe hoje em `packages/core/src/ports/`, mais uma quinta porta
(`AuthService`) que apareceu com a conta de verdade. Um documento de design especificando a
fronteira de portabilidade do sistema é raro — e o motivo está declarado: *"Native apps will come
later, so structure the code to make that easy."*

O documento 04 trata do que essa fronteira custa e compra. O ponto de produto é outro: **a
portabilidade era requisito, não refinamento**. Ela não precisou ser negociada contra prazo depois,
porque estava na especificação desde o começo.

## Dois modos de acesso, e o que cada um pode

`design_handoff_ondas_terminal_player/README.md:5` define o visitante em uma linha: ouve só faixa
livre, não baixa e não toca `[pro]`.

| | Visitante | Com conta |
|---|---|---|
| Catálogo público | sim | sim |
| Faixas `[pro]` | não (abre um aviso) | sim |
| Download para ouvir offline | não | sim |
| Acervo privado | não existe | entra na frente da lista, marcado `[meu]` |
| Sessão | **efêmera** — recarregar volta ao login | 30 dias |
| Tema, curtidas, downloads | persistem | persistem |

A linha da sessão efêmera é a mais interessante, porque é a única que **contraria** a intuição de
produto. O normal seria lembrar do visitante. A escolha é do protótipo e foi mantida: só o login
persiste. Em troca, as preferências do aparelho sobrevivem — tema, curtidas e downloads não dependem
de quem está logado.

Essa separação virou, mais tarde, uma decisão de tela. Conta e biblioteca moravam no mesmo painel,
dentro de `~/biblioteca`, e isso **insinuava uma sincronia que não existe**: a conta vive no
servidor e segue a pessoa para qualquer aparelho; curtidas, downloads e buffer vivem no IndexedDB
*daquele navegador* e não seguem ninguém. Hoje a biblioteca é só biblioteca, e a conta abre pelo
próprio nome (`ondas whoami`) no prompt ou na barra de status.

O corolário dessa honestidade é um comportamento que desaponta de propósito: **`[sair]` não apaga o
que é do aparelho** — e o painel diz isso com todas as letras. Quem quiser apagar usa
`[limpar downloads]`, que pergunta antes. Sem isso, sair deixaria o áudio do acervo privado no
navegador sem nenhuma tela para mostrá-lo.

## Os incrementos disseram o que não tocar

Os dois handoffs seguintes começam com a mesma frase.
`design_handoff_ondas_brand_assets/README.md:3`: *"the Ondas PWA […] **is already implemented**.
This package adds **only** the brand […] Don't change anything else."* E
`design_handoff_ondas_layout_transparency/README.md:3`: *"This package adds **only two changes**.
Don't touch anything else."*

Parece burocracia. Não é: é o mecanismo que impede um pedido de marca de virar um refactor. O
segundo pacote pede exatamente duas coisas — layout centralizado no desktop e transparência de fundo
com blur — e nomeia as três armadilhas de cada uma, incluindo a de não usar `backdrop-filter` na
raiz, porque isso cria um *containing block* e quebra todo overlay `position: fixed`. Um handoff que
já sabe onde o implementador vai se machucar economiza um ciclo de revisão inteiro.

O terceiro pacote também chegou com uma tabela de **cinco lugares de aplicação** para um único
componente novo (a abertura, o login, a barra de abas, a linha do player e a capa ausente), com
tamanho e parâmetros de cada um. Não houve "onde eu uso isso?".

## Entrega em fases, visível no histórico

O acervo privado não entrou de uma vez. O histórico do git marca o recorte no próprio assunto do
commit:

```
68424aa  acervo no R2 privado: ingestão por URL com worker (fase 2)
d94b436  a PWA enxerga o acervo: login de verdade e duas fontes (fase 3)
9f1c64e  tela de envio: arquivo local vai do navegador direto para o R2 (fase 4)
```

São oito fases ao todo, e o ponto de produto é a **ordem**: a API e o worker entraram antes de a PWA
saber que o acervo existia. Isso quer dizer que, por duas fases, havia backend em produção sem
nenhuma tela — ingestão funcionando, faixas no bucket, e a interface ainda mostrando só o catálogo
público. Para um projeto de um dono só, essa inversão é confortável: dá para conferir o backend por
`curl` sem a tela mentir sobre ele. Num time, seria uma conversa difícil sobre valor entregue.

## O que ficou de fora de propósito

Produto também é a lista do que não se faz. As recusas registradas:

| Deixado de fora | Por quê |
|---|---|
| Áudio em segundo plano garantido no iOS | Funciona na PWA instalada, mas o iOS pode suspender. Aceito, não contornado |
| Background Fetch | Não existe no Safari; o download acontece em primeiro plano, com progresso |
| Áudio no cache do Service Worker | As faixas são grandes e parciais (`Range`); ocuparia o cache do app shell. Elas vão para um cache próprio |
| Forma de onda para faixa do Audius | O catálogo público não publica a onda, e o app **não** baixa o arquivo inteiro para medir. Barra lisa é a resposta honesta |
| `g`/`G` e `h`/`l` no teclado | `l` já é curtir, e um segundo vocabulário de navegação só depois de `j`/`k` estarem de pé |
| Botão `[?]` na tela do celular | Não há teclado lá, e a janela é sobre teclas |
| Edição de metadados da faixa | A API não tem `UPDATE` em `tracks`; corrigir título é reingerir |
| Cadastro aberto | `SIGNUP_OPEN` é `false` por default e a allowlist nasce vazia |

A linha da forma de onda é a que mais parece bug e mais é produto. A versão anterior desenhava, para
toda faixa, uma onda derivada do hash do id: bonita, convincente e **sem nenhuma relação com o
som**. Trocar isso por uma barra lisa onde o áudio é desconhecido fez a interface ficar visivelmente
mais pobre — e fez o relevo passar a significar uma coisa só: *o Ondas conhece este áudio*. É uma
troca de densidade visual por veracidade, e eu faria de novo.

## O que isso custou

**O handoff fixou a stack cedo, e cedo demais é uma aposta.** React foi escolhido por causa de uma
fase 2 que ainda não começou ([documento 02](02-decisoes-de-stack.md)). Se ela não sair, a v1 pagou
bundle a mais por um ganho que nunca chegou.

**"Pixel-perfect" num handoff de alta fidelidade é um contrato caro.** O pacote declara cores,
tipografia, espaçamento e textos como finais. Isso elimina discussão de gosto e também elimina a
possibilidade de descobrir, durante a implementação, que uma escolha não funciona — o que de fato
aconteceu: o player cheio não cabia na tela do celular, e a correção precisou de um `@media`, o
único do projeto.

**A inversão de ordem das fases deixou backend sem tela por dois commits.** Funcionou porque o
usuário e o desenvolvedor são a mesma pessoa.

**O heurístico do protótipo sobreviveu no código** e cobrou um `premium: false` explícito numa fonte
de dados que nada tinha a ver com ele.

## Numa entrevista

**"Como você trabalha a partir de um handoff de design?"** Neste projeto o handoff fazia mais do que
aparência: decidia a stack e nomeava as quatro interfaces de plataforma por assinatura. O que eu li
primeiro foi a frase que diz que os protótipos **não são código de produção** e que a tarefa é
recriar o design com os padrões do codebase de destino. Isso é o que impede o protótipo de vencer a
arquitetura — e aqui era um risco real, porque o protótipo vinha com a lógica inteira numa classe de
estado próprio.

**"Como você decide o que fica fora da v1?"** Pelo critério de se o limite é da plataforma ou meu.
Áudio em segundo plano no iOS e ausência de Background Fetch são limites do Safari: eu aceito e
documento, em vez de inventar contorno frágil. Já teclas de navegação extra ou edição de metadados
são escopo meu, e ficam fora porque não têm demanda ainda. A lista está escrita no README — recusa
não documentada volta como pergunta.

**"Me dá um exemplo de decisão de produto que deixou o app pior."** A forma de onda. Antes, toda
faixa tinha um desenho derivado do hash do id: bonito e sem nenhuma relação com o som. Hoje, faixa
cujo áudio o sistema não conhece — todo o catálogo público — mostra uma barra lisa. A tela ficou
mais pobre, e em troca o relevo passou a significar exatamente uma coisa. Preferi menos informação a
informação inventada.

**"Como você comunica que uma funcionalidade é limitada ao aparelho?"** Escrevendo na tela. Conta e
biblioteca eram o mesmo painel, o que insinuava sincronia entre coisas que não sincronizam: a conta
está no servidor, as curtidas e os downloads estão naquele navegador. Separei as telas e pus a frase
explícita de que sair não apaga o que é do aparelho, com um botão separado para quem quiser apagar.
