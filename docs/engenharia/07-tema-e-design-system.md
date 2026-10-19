---
title: "Nove temas, quatro cores cada, 41 tokens derivados em oklab"
date: 2026-10-19
description: "Como gerar um design system inteiro a partir de quatro valores por tema, por que o blur não pode morar na raiz e por que existe um único @media em todo o projeto."
slug: "ondas-tema-design-system"
draft: true
tags:
  - css
  - design-system
  - frontend
---

O Ondas tem nove temas, e cada um define **quatro coisas**: a cor de fundo, a cor do texto, a cor de
destaque e as oito cores ANSI do terminal. Mais nada. Não há paleta de cinzas, não há tom de borda,
não há cor de superfície.

Tudo isso é derivado em tempo de execução — 41 variáveis CSS por tema, geradas por `color-mix` no
espaço oklab. Este documento é sobre essa geração, sobre as duas armadilhas que ela criou e sobre
por que o projeto inteiro tem um único `@media`.

## O problema: nove paletas à mão são nove paletas para errar

A estética é de emulador de terminal, e os temas são os esquemas de cor reais desse mundo:
Catppuccin Mocha, TokyoNight, Dracula, Gruvbox, Nord, Rosé Pine, Solarized Dark, GitHub Light e
Nocturne (`packages/core/src/themes.ts:7-26`).

A interface precisa de muito mais que quatro cores: fundo de linha selecionada, borda de divisória,
texto secundário, texto desabilitado, fundo de painel, sombra. Escrever essas doze ou vinte cores à
mão para cada um dos nove temas são 180 valores — e, mais grave, 180 oportunidades de um tema ficar
com contraste pior que os outros sem ninguém notar.

## A decisão: duas rampas e uma função de mistura

`packages/core/src/theme/tokens.ts` tem duas tabelas de derivação:

```
NEUTRAL: 9 paradas, do texto puro até quase o fundo   (100 → 9%)
ACCENT:  9 paradas que mudam de alvo no meio do caminho
```

A rampa de destaque é a parte esperta (`packages/core/src/theme/tokens.ts:13-16`): as paradas 100 a
400 misturam o destaque com a **cor do texto**, a 500 é o destaque puro, e as 600 a 900 misturam com
o **fundo**. Uma única rampa cobre tanto "destaque mais claro que o normal" quanto "destaque
esmaecido até virar quase fundo", e em qualquer um dos nove temas — inclusive no claro, porque a
mistura é sempre em direção ao `fg` ou ao `bg` daquele tema, não em direção a branco ou preto.

`themeCssVars(theme, opacity)` (`packages/core/src/theme/tokens.ts:34`) emite 41 tokens: 15 fixos, 9
neutros, 9 de destaque e 8 ANSI. E o detalhe de implementação que importa: os valores são **strings
`color-mix(in oklab, …)` não resolvidas**. O JavaScript não calcula cor nenhuma; ele monta
expressões e entrega ao CSS.

Por que oklab e não sRGB: misturar em sRGB passa por tons sujos no meio do caminho (o clássico
cinza-esverdeado entre azul e amarelo) e tem luminosidade perceptual irregular. Em oklab, 50% entre
duas cores parece 50%. Para uma rampa de nove paradas que precisa ter espaçamento visual uniforme em
nove temas diferentes, isso é a diferença entre funcionar e precisar de ajuste manual por tema.

## A armadilha da transparência

O handoff de layout pediu transparência de fundo com desfoque, no estilo do `background-opacity` do
Ghostty. A implementação ingênua seria aplicar alfa em tudo. O resultado seria texto e bordas
perdendo contraste sobre o papel de parede.

A regra que o código adotou (`packages/core/src/theme/tokens.ts:25-33`): **só dois tokens ficam
translúcidos** — `--color-bg-a` e `--color-surface-a`. As rampas neutra e de destaque continuam
opacas, porque elas são derivadas do fundo **sólido** — então o texto e as bordas mantêm o contraste
que tinham, independentemente do que esteja por baixo.

E a alfa é aplicada em **sRGB**, não em oklab (`cssAlpha`, `packages/core/src/theme/tokens.ts:23`).
Misturar com `transparent` em oklab produz resultado diferente do esperado na maioria dos
navegadores; para alfa simples, sRGB é o espaço certo.

A segunda armadilha é mais séria, e o handoff a nomeou antes da implementação: **nada de
`backdrop-filter` na raiz**. Um `backdrop-filter` cria um *containing block*, e isso quebraria todo
overlay `position: fixed` do app — o player cheio, o aviso de acesso, o seletor de tema e a tela de
abertura. A solução é o desfoque morar na camada do papel de parede, com `filter`
(`packages/web/src/components/Wallpaper.tsx:43-46`), que não cria *containing block*.

O papel de parede só é renderizado quando `opacity < 1` e há imagem escolhida — com opacidade total,
custo zero.

## Para onde o `color-mix` não serve

Três consumidores precisam de uma cor **concreta**, em hexadecimal, e não entendem `color-mix()`: a
meta tag `theme-color`, o manifesto da PWA e o provedor de tema nativo da fase 2
(`packages/core/src/theme/tokens.ts:61-64`).

Por isso existe `packages/core/src/theme/oklab.ts`: 69 linhas que implementam a conversão sRGB →
linear → oklab e de volta, com as matrizes de Björn Ottosson, para que `mixOklab(a, pct, b)` produza
o **mesmo valor** que o navegador produziria com `color-mix(in oklab, …)`.

É duplicação deliberada de uma função que o CSS já tem. A alternativa seria fixar um hexadecimal por
tema para o `theme-color`, que divergiria do que a tela mostra no dia em que alguém mexesse numa
parada da rampa.

## O tema é aplicado antes do primeiro paint

Trocar de tema depois do primeiro desenho da tela é um flash branco. Para evitá-lo, há um script
inline no `packages/web/index.html:41-74` que replica a tabela dos nove temas — só `bg`, `fg` e
`accent` — e aplica quatro tokens antes de qualquer coisa renderizar. Depois, um efeito no React
aplica o conjunto completo (`packages/web/src/App.tsx:25-30`).

Essa é a razão pela qual o tema mora no `localStorage` e não no IndexedDB
(`packages/web/src/theme/applyTheme.ts:25-28`): o script precisa de leitura **síncrona**, e o
IndexedDB é assíncrono. É o mesmo app usando os dois armazenamentos por razões opostas — este porque
é síncrono, o do papel de parede porque um dataURL de 1 MB não cabe na cota do `localStorage`.

A duplicação da tabela de temas no HTML é um custo reconhecido. Ela cobre três campos dos quatro, e
divergir dela significaria um flash de cor errada no boot — visível, mas não quebrado.

Um detalhe de assinatura que vale copiar: `applyTheme(id, opacity)` tem a opacidade como parâmetro
**obrigatório** (`packages/web/src/theme/applyTheme.ts:10-13`). O comentário diz por quê: esquecê-la
em qualquer chamada devolveria o app ao opaco sem aviso. *"O compilador cobra."* É mais barato que
um valor padrão silencioso.

## O único `@media` do projeto

Há três `@media` no código. Dois são `prefers-reduced-motion`. **Um** é de layout:
`packages/web/src/components/overlay.module.css:311`, `max-width: 859px`.

Toda a outra responsividade é em JavaScript, por um hook: `useWide()`
(`packages/web/src/hooks/useWide.ts:7`), com `(min-width: 860px)` — o mesmo ponto de corte. A
diferença é o que cada mecanismo controla:

- O `useWide` alterna **estrutura**: no estreito, a lista não mostra capa nem botão de
compartilhar, as abas viram ícone, o player esconde os atalhos
(`packages/web/src/components/TrackList.tsx:36-38`).
- O `@media` existe porque há uma conta de **altura** que o JavaScript não resolveria melhor.

E a conta é interessante. No celular, o player cheio tem de caber na tela **sem rolagem** — rolar
para alcançar o botão de tocar é perder o player. Mas a altura necessária não dá para fixar em
pixels: o título tem de uma a três linhas, e o bloco de buffer tem ou não o botão de baixar
(`packages/web/src/components/overlay.module.css:300-310`).

A solução é inverter quem cede: o painel recebe um teto de altura e **a capa fica com o que sobrar**
(`flex: 1 1 auto; min-height: 120px`). O raciocínio de produto é direto — um botão menor não serve
para nada, uma capa menor serve. Abaixo de ~570 px de altura a capa bate no piso de 120 px e a tela
volta a rolar, que é o comportamento honesto.

## Banda e conteúdo

No desktop, o fundo e as bordas da barra de abas, do rodapé e do toast vão de ponta a ponta, mas o
conteúdo se alinha a uma coluna de 1.080 px. O padrão é `.band` com largura total e `.inner` com
`max-width` e `margin: 0 auto`.

A consequência que justifica o padrão: **a barra de rolagem fica na borda da tela, não na coluna**.
Centralizar a coluna inteira, barra incluída, parece certo no mockup e fica errado no uso.

`--content-max: 1080px` (`packages/web/src/styles/global.css:6-15`) é o único token do projeto que
**não** é derivado de tema.

## Como o CSS consome os tokens

Fluxo de mão única: `themeCssVars()` no domínio → `applyTheme()` → `setProperty` na raiz
(`packages/web/src/theme/applyTheme.ts:17-19`). Os dez CSS Modules só **consomem** `var(--…)`: 243
referências sobre 28 nomes distintos, e **nenhum módulo declara cor própria**.

Duas exceções, as duas justificáveis: o componente do logo injeta uma variável de velocidade de
animação inline (`packages/web/src/components/CassetteLogo.tsx:49`), e o papel de parede passa
`backgroundImage` e `filter` inline, porque os dois dependem de dados em tempo de execução.

Há três `@keyframes` no projeto inteiro. O comentário em `packages/web/src/styles/global.css:116`
diz o que isso significa na prática: *"O cursor é o único movimento da interface."*

## O que foi descartado

| Opção | Por que não |
|---|---|
| Nove paletas completas escritas à mão | 180 valores, e um tema com contraste pior sem ninguém notar |
| Derivar misturando em sRGB | Tons sujos no meio da rampa e luminosidade perceptual irregular |
| Tailwind ou biblioteca de componentes | Não gera as rampas derivadas, e o tema troca em tempo de execução |
| Alfa em todas as rampas | Texto e borda perderiam contraste sobre o papel de parede |
| `backdrop-filter` na raiz | Cria *containing block* e quebra todo overlay `position: fixed` |
| Hexadecimal fixo por tema para o `theme-color` | Divergiria da tela no dia em que uma parada da rampa mudasse |
| Tema no IndexedDB | O script antes do primeiro paint precisa de leitura síncrona |
| `@media` para toda a responsividade | O que muda no estreito é estrutura de componente, não só estilo |
| Fixar a altura do player cheio em pixels | O título tem de uma a três linhas e o bloco de buffer é variável |

## O que isso custou

**A tabela de temas está em dois lugares.** O script inline do HTML replica três dos quatro campos
dos nove temas. Divergir significa um flash de cor errada no boot.

**`color-mix(in oklab)` reimplementado em JavaScript.** São 69 linhas que duplicam o que o navegador
já faz, para os três consumidores que precisam de hexadecimal.

**Dois mecanismos de responsividade.**`useWide` e um `@media`, no mesmo ponto de corte, e é preciso
saber qual usar: estrutura no hook, altura no CSS. Os comentários apontam um para o outro, o que
ajuda e não elimina o custo.

**Toda cor é derivada, então um tema não pode ter uma exceção.** Se um dos nove precisasse de uma
borda mais clara que a rampa produz, não haveria lugar para isso sem quebrar o modelo. Até agora não
precisou.

## Numa entrevista

**"Como você monta um design system com nove temas?"** Definindo o mínimo por tema e derivando o
resto. Cada tema tem quatro coisas: fundo, texto, destaque e as oito cores ANSI. As outras 41
variáveis saem de duas rampas de nove paradas, geradas com `color-mix(in oklab)`. Escrever as
paletas à mão seriam 180 valores e nove chances de um tema ter contraste pior sem ninguém perceber.

**"Por que oklab?"** Porque misturar em sRGB passa por tons sujos no meio e tem luminosidade
perceptual irregular. Em oklab, 50% entre duas cores parece 50%. Com nove temas e uma rampa que
precisa ter espaçamento visual uniforme em todos, isso é a diferença entre derivar e ajustar à mão.

**"Como você fez transparência de fundo sem perder contraste?"** Deixando translúcidos apenas dois
tokens: o fundo e a superfície. As rampas de texto e de destaque continuam opacas, porque são
derivadas do fundo sólido — então o contraste não depende do que está por baixo. E o desfoque mora
na camada do papel de parede com `filter`, nunca com `backdrop-filter` na raiz, que criaria um
*containing block* e quebraria todo overlay `fixed`.

**"Como você evita o flash de tema errado no carregamento?"** Um script inline no HTML aplica os
tokens principais antes do primeiro paint. É por isso que o tema mora no `localStorage` e não no
IndexedDB: eu preciso de leitura síncrona. O custo é a tabela de temas estar duplicada no HTML, e eu
aceito porque a alternativa é um flash visível.

**"Quantos breakpoints você tem?"** Um, usado de duas formas. Um hook com `matchMedia` em 860 px
decide **estrutura** — no estreito a lista não mostra capa, as abas viram ícone. E há exatamente um
`@media` no projeto, no mesmo ponto de corte, para uma conta de altura: o player cheio tem de caber
sem rolagem no celular, e a altura necessária é variável porque o título tem de uma a três linhas. A
solução foi dar teto ao painel e deixar a capa ceder — um botão menor não serve, uma capa menor
serve.
