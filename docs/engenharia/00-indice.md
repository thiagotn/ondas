---
title: "Ondas, decisão por decisão: índice da série"
date: 2026-10-19
description: "Um player de música em PWA com API própria, destrinchado em treze documentos: por que cada ferramenta foi escolhida, o que foi descartado e o que cada decisão custou."
slug: "ondas-serie-engenharia"
draft: true
tags:
  - arquitetura
  - engenharia
---

O **Ondas** é um player de música com estética de terminal: uma PWA que toca um catálogo público (a
API do Audius) e, para quem entra com conta, um acervo pessoal guardado num bucket privado. Ele roda
em `music.thiagotn.com`, num cluster Kubernetes de nó único em casa, e o deploy é um `git push`.

Este é o índice de uma série que explica **por que** ele é assim. Não é um tutorial e não é
documentação de uso — para isso existe o [README](../../README.md), que diz o que o sistema faz e
como rodá-lo. A série responde a outra pergunta, a que aparece numa revisão de arquitetura ou numa
entrevista técnica: *por que essa escolha e não a outra, e o que ela custou?*

Cada documento fecha um assunto sozinho. Dá para ler um só, fora de ordem, sem o código aberto.

## O que se mede

Números apurados em 19/10/2026, no commit `0b330a2`:

| | |
|---|---|
| Commits | 31, entre 16/10/2026 e 19/10/2026 |
| `packages/core` (TS puro, sem DOM) | 2.441 linhas de produção, 2.214 de teste |
| `packages/web` (PWA React) | 4.406 linhas de TS/TSX + 2.035 de CSS |
| `api/` (Go) | 7.640 linhas, das quais 3.322 são teste |
| Testes unitários (Vitest, em `core`) | **216** em 16 arquivos, ambiente Node puro |
| Testes de backend (Go) | **123**, com Postgres de verdade |
| Testes de ponta a ponta (Playwright) | **30**, em 2 viewports = 60 execuções |
| Imagens de container | 3 (PWA, API, worker) |
| Temas | 9, gerando 41 tokens de CSS cada |
| Dependências de runtime em `core` | 1 |

A razão teste/produção em `core` é 0,91:1. Nos dois pacotes Go de maior risco ela se inverte:
`internal/worker` tem 676 linhas de teste contra 364 de produção.

## A série

| # | Documento | A pergunta que ele responde |
|---|---|---|
| 01 | [Produto e escopo](01-produto-e-escopo.md) | O que foi deliberadamente deixado de fora, e como um handoff de design virou especificação executável |
| 02 | [Decisões de stack](02-decisoes-de-stack.md) | Por que React e não Svelte, por que Go na API, por que uma única dependência de runtime no domínio |
| 03 | [System design](03-system-design.md) | Como as três imagens se falam, por que o áudio nunca cruza o túnel de casa e quais partes podem cair sozinhas |
| 04 | [Monorepo e ports](04-monorepo-e-ports.md) | Como o compilador impede o domínio de enxergar o DOM, e o que isso compra para a fase nativa |
| 05 | [Estado e stores](05-estado-e-stores.md) | Por que o cursor guarda um id e nunca um índice — a lição que o projeto aprendeu três vezes |
| 06 | [PWA e offline](06-pwa-e-offline.md) | Três camadas de cache que não se misturam, e por que um arquivo de 55 MB não pode virar um `Blob` |
| 07 | [Tema e design system](07-tema-e-design-system.md) | Nove temas, 41 tokens e um único `@media` em todo o projeto |
| 08 | [Autenticação](08-auth.md) | Por que o cookie de sessão não é um JWT, e como o argon2id dita o limite de memória do pod |
| 09 | [Acervo privado e R2](09-acervo-e-r2.md) | Por que o caminho de um arquivo nunca vem do pedido, e por que uma URL assinada de PUT é um segredo |
| 10 | [Ingestão e SSRF](10-ingestao-e-ssrf.md) | Como se fecha um proxy para a rede interna quando o produto é "me manda uma URL" |
| 11 | [Forma de onda](11-forma-de-onda.md) | Como desenhar o áudio de verdade em 200 bytes, e por que a barra lisa é a resposta honesta |
| 12 | [DevOps e GitOps](12-devops-gitops.md) | O que o CI pode e não pode tocar, e por que ele não fala com o cluster |
| 13 | [QA](13-qa.md) | A disciplina de tirar a correção para ver se o teste reclama — e as quatro vezes em que ele não reclamou |

## Três jeitos de ler

- **Preparando entrevista.** Cada documento termina num bloco **Numa entrevista** com as perguntas
prováveis e a resposta curta. Lidos em sequência, os blocos do 03, 08, 09 e 10 cobrem quase todo
system design de backend; os do 04, 05, 06 e 07 cobrem frontend.
- **Por frente.** Frontend é 04 a 07; backend é 08 a 11; infra é 03 e 12; produto é 01; qualidade
é 13. O 02 atravessa tudo.
- **Pela curiosidade.** Os três documentos com os melhores achados de produção são o 10 (duas
sessões do Postgres se atropelando num rollout), o 11 (uma medição de PSNR decidindo um parâmetro do
ffmpeg) e o 13 (um teste que passava mesmo sem a correção que ele deveria travar).

## Duas ressalvas

**Citação é citação; destaque é meu.** Um trecho recuado **sem negrito**, logo depois de uma
referência `arquivo:linha`, é o comentário do código reproduzido palavra por palavra — com `[…]`
onde eu cortei. Um trecho recuado **em negrito** é uma frase minha, posta em destaque. As 54
citações de código da série foram conferidas contra o arquivo citado.

**As linhas envelhecem.** As referências no formato `arquivo:linha` apontam para o commit `0b330a2`.
O caminho continua certo depois de mudanças; o número, não necessariamente. Quando houver
divergência, vale o nome da função citada ao lado.

**Falta aqui a camada de infraestrutura.** Os manifests do Kubernetes, os registros de decisão de
arquitetura do cluster e a topologia de rede vivem num repositório privado, e nada disso é citado
nesta série — nem por recorte, nem por paráfrase. O documento 12 descreve o pipeline até a fronteira
do que este repositório público já expõe: as imagens, o CI e o contrato de deploy. Onde uma decisão
nasceu de um registro privado, o raciocínio aparece (ele também está nos comentários do código, que
são públicos), mas a fonte é citada só pelo número.
