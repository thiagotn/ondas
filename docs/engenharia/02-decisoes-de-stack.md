---
title: "A stack do Ondas: React porque a fase 2 é nativa, e Go porque a imagem é vazia"
date: 2026-10-19
description: "Por que um player de música escolheu React em vez de Svelte, Go para a API, uma única dependência de runtime no domínio e nenhum framework de CSS — com o custo de cada escolha."
slug: "ondas-decisoes-de-stack"
draft: true
tags:
  - arquitetura
  - react
  - go
  - typescript
---

A stack do Ondas não foi escolhida no teclado. Ela estava escrita num documento de handoff de design
antes de existir uma linha de código, e a justificativa de cada item vinha junto. Isso é incomum o
bastante para valer o registro: quando a primeira decisão técnica é tomada com o problema inteiro na
frente, em vez de no meio do terceiro componente, as escolhas seguintes param de ser preferência e
passam a ser consequência.

Este documento percorre as cinco escolhas que importam e o que cada uma cobrou.

## A escolha que arrastou todas as outras

`design_handoff_ondas_terminal_player/README.md:16` decide React 18 + TypeScript + Vite com uma
frase que não fala de React:

> Chosen over Svelte so the domain logic and hooks can be reused later in React Native/Expo.

A v1 é uma PWA. A fase 2 é um app nativo. Svelte compila componentes menores e mais rápidos, e para
uma PWA de 460 KB de app shell isso seria uma vitória real — mas não existe caminho de Svelte para
React Native. Escolher Svelte significaria escrever a lógica de fila, de permissão, de tema e de
cache duas vezes, uma em cada linguagem de componente.

A decisão, então, não é "React é melhor". É: **a reusabilidade entre duas plataformas vale mais do
que o tamanho do bundle numa delas**. É uma aposta datada, com uma data concreta — se a fase 2 nunca
sair, o Ondas pagou bundle a mais por nada.

E a aposta só se paga se a lógica for de fato reusável, o que levou ao monorepo com um pacote de
domínio sem acesso ao DOM. Esse é o assunto do [documento 04](04-monorepo-e-ports.md); o que importa
aqui é que ele é **consequência** desta escolha, não uma preferência independente por arquitetura
hexagonal.

## O domínio com uma dependência só

`packages/core/package.json` lista exatamente uma dependência de runtime:

```json
"dependencies": {
  "zustand": "^5.0.2"
}
```

São 2.441 linhas de regra de negócio — fila de reprodução, permissões, formatação, codec de link
compartilhável, codec de forma de onda, geração de tokens de tema, cliente de catálogo com três
níveis de fallback — e nada mais entra. Sem `lodash`, sem `date-fns`, sem biblioteca de validação.
`packages/core/src/format.ts:4` implementa um hash FNV-1a em sete linhas;
`packages/core/src/theme/oklab.ts` traz as matrizes de conversão de espaço de cor à mão, em 69
linhas.

Isso não é ascetismo. É que `core` é o pacote que a fase 2 vai importar dentro de um bundler
diferente, num runtime diferente, e cada dependência ali é uma aposta de que ela funciona em React
Native também. Zustand entra porque é agnóstico de plataforma por construção — e, como o [documento
05](05-estado-e-stores.md) detalha, o Ondas usa a variante `zustand/vanilla`, que nem sabe que React
existe.

O pacote da PWA, que não tem essa restrição, tem onze dependências.

## A divisão de trabalho entre duas bibliotecas de estado

Ter TanStack Query **e** Zustand no mesmo app costuma ser sinal de que ninguém decidiu nada. Aqui a
fronteira é explícita e cai sempre no mesmo lugar:

| Pertence a | Quem manda | Onde mora |
|---|---|---|
| Dado que vem de fora e pode ficar velho | TanStack Query | `packages/web/src/query/` |
| Dado que é da sessão e de mais ninguém | Zustand | `packages/core/src/stores/` |

O catálogo é do Query: ele tem `staleTime`, `gcTime`, revalidação, persistência em IndexedDB e chave
de cache. O que está tocando, o que está curtido, qual tema está ativo e onde o cursor da lista está
é do Zustand: nada disso tem "versão do servidor" para reconciliar.

A fronteira paga uma dívida concreta. Como a chave do catálogo é escopada pela sessão
(`packages/web/src/query/catalog.ts:12`), sair da conta remove o catálogo do logado do cache
persistido em vez de deixar metadados do acervo privado no aparelho esperando o próximo visitante.
Se o catálogo morasse num store de Zustand persistido à mão, essa limpeza seria uma linha que alguém
teria de lembrar de escrever.

Há exatamente uma exceção, e ela é deliberada: faixas abertas por link direto ficam **fora** do
Query, num store próprio (`packages/web/src/app/extras.ts:10-19`). A razão é boa e está no documento
05.

## Go na API, e por que são duas imagens

A API do acervo é Go: `chi` para roteamento, `pgx` para Postgres, `envconfig` para configuração,
`slog` para log estruturado. O que esse conjunto compra fica visível no `api/Dockerfile:15-19`:

```dockerfile
FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /out/api /api
```

A imagem de produção tem **dois arquivos**. Não há shell, não há gerenciador de pacotes, não há
interpretador — nada que um atacante com execução de código possa invocar, porque não há nada
instalado. As migrações estão embutidas no binário por `go:embed` (`api/internal/db/pool.go:15-16`),
então não há um segundo artefato para manter em sincronia nem um initContainer para orquestrar.

O worker de ingestão é a imagem irmã, e `api/Dockerfile.worker:1-3` explica por que ela existe:

```
# Imagem do worker de ingestão. Separada da API porque aqui o ffmpeg é
# obrigatório — a imagem da API é scratch, sem nada do sistema.
```

É o ponto interessante da decisão. Um único binário com os dois modos seria mais simples de
publicar, mas forçaria a API a carregar o ffmpeg e o Alpine inteiro embaixo dele — e a API é o
processo exposto à internet. Separar troca uma imagem por duas para que **a superfície de ataque
grande fique no processo que não aceita conexão de fora**: o worker não tem Service nem Ingress, só
puxa trabalho de uma fila no Postgres.

## `minio-go` em vez do SDK da AWS

O bucket é Cloudflare R2, que fala o protocolo S3. O cliente é `minio/minio-go/v7`
(`api/go.mod:10`), não o `aws-sdk-go-v2`.

A razão registrada no repositório é a mais simples que existe: **precedente**. O comentário em
`api/Dockerfile.worker:3` anota que esse é o mesmo padrão de um projeto anterior no mesmo cluster, e
`api/internal/storage/r2.go:1-3` diz "minio-go, como a API do rachão". Repetir uma escolha que já
rodou em produção não é preguiça — é a única forma de evidência disponível quando as duas opções
funcionam.

E as duas funcionam. O `minio-go` cobre tudo o que o Ondas usa — `PutObject`, `GetObject`, URL
assinada de GET e de PUT, política de CORS do bucket — com credenciais estáticas explícitas e
`Region: "auto"`, que é o que o R2 espera (`api/internal/storage/r2.go:46-51`). Não há recurso do
SDK da AWS que fizesse falta aqui.

Vale uma observação que **não** foi o motivo da escolha, mas que a reforça em retrospecto: a cadeia
de credenciais do SDK da AWS tenta, entre outras fontes, o serviço de metadados da instância em
`169.254.169.254` — justamente um dos endereços que a trava de SSRF deste projeto existe para
bloquear (`api/internal/ingest/baixar.go:20-39`). Num binário cujo trabalho é buscar URLs de
terceiros, menos código que saiba falar com endereços internos é melhor. Mas isso é argumento
encontrado depois; a decisão foi tomada por precedente.

## Nenhum framework de CSS

São 2.035 linhas de CSS em dez CSS Modules e um arquivo global. Sem Tailwind, sem
`styled-components`, sem biblioteca de componentes.

O motivo é que o Ondas tem um sistema de cor próprio e ele é pequeno: cada tema define quatro
valores (`bg`, `fg`, `accent` e oito cores ANSI) e **todo o resto é derivado** em tempo de execução
por `color-mix(in oklab, …)`, gerando 41 variáveis CSS (`packages/core/src/theme/tokens.ts:34`). Os
módulos só consomem `var(--…)`: são 243 referências sobre 28 nomes distintos, e nenhum módulo
declara cor própria.

Um framework utilitário não ajudaria a gerar essas rampas e atrapalharia a troca de tema em tempo de
execução, que aqui é um `setProperty` na raiz e nada mais. O detalhe completo está no [documento
07](07-tema-e-design-system.md), inclusive por que existe **um único** `@media` de layout em todo o
projeto.

## O que foi descartado

| Opção | Por que não |
|---|---|
| Svelte / SvelteKit | Sem caminho para React Native; a lógica de domínio teria de ser reescrita na fase 2 |
| Next.js | A PWA é estática e serve por nginx; renderização no servidor não tem o que fazer num player cujo dado vem de uma API pública e de um bucket privado |
| Backend em Node, dividindo tipos com o `core` | Perderia a imagem `scratch` e o binário único; e a única coisa que valia compartilhar — o alfabeto do codec de forma de onda — está travada por um teste que lê o arquivo TypeScript de dentro do Go |
| `aws-sdk-go-v2` | Nenhum recurso que fizesse falta; o `minio-go` já tinha precedente em produção no mesmo cluster |
| Redux / Context API para tudo | Context re-renderiza a árvore e não funciona fora do React — o controller imperativo precisa ler estado sem hooks |
| Tailwind | Não gera as rampas derivadas; e o tema troca em tempo de execução, não em build |
| Um binário Go só, com dois modos | Obrigaria a API exposta a carregar ffmpeg e Alpine |

## O que isso custou

**O bundle é maior do que precisaria.** React + React DOM + Router + três pacotes do TanStack num
app cuja interface é texto monoespaçado é desproporcional, e o preço é pago por todo visitante novo.
Só se justifica pela fase 2.

**Duas bibliotecas de estado é uma fronteira para explicar.** Ela está documentada e é consistente,
mas qualquer pessoa nova no código precisa aprendê-la antes de saber onde pôr um campo.

**A ausência de dependências em `core` significa código próprio para manter.** O hash, a conversão
oklab e o codec de picos são setenta linhas que uma biblioteca resolveria — e que agora são
responsabilidade do projeto, cobertas por 216 testes.

**O codec de forma de onda está escrito duas vezes**, em TypeScript e em Go, porque a imagem da API
é construída com o contexto `api/` apenas e não pode importar nada do monorepo. A divergência
silenciosa que isso permitiria é travada por um teste que lê o arquivo do outro idioma e compara o
alfabeto caractere a caractere (`api/internal/ingest/picos.go:21-25`).

## Numa entrevista

**"Por que React e não Svelte, num app que é basicamente texto?"** Porque a fase 2 é React Native, e
a lógica de domínio — fila, permissões, tema, cache — precisa ser a mesma. Svelte venceria no
tamanho do bundle da v1 e perderia na duplicação da v2. A aposta está registrada e tem data: se o
app nativo não sair, eu paguei bundle a mais por nada.

**"Por que duas bibliotecas de estado?"** Porque elas resolvem problemas diferentes. TanStack Query
cuida de dado que vem de fora e fica velho: tem revalidação, chave de cache e persistência. Zustand
cuida de dado da sessão, que não tem versão no servidor para reconciliar. A fronteira é "isso pode
ficar obsoleto?" e nunca precisei discutir caso a caso.

**"Por que Go e não Node, se o frontend já é TypeScript?"** Pela imagem de produção: a da API é
`FROM scratch` com dois arquivos, sem shell e sem interpretador. As migrações vão embutidas no
binário, então não há um segundo artefato a versionar. O que eu perderia — compartilhar tipos com o
frontend — era uma coisa só, o alfabeto do codec de picos, e ela está travada por um teste que
compara os dois lados.

**"Você não está sobre-engenheirando um player de música?"** Para a v1 isolada, sim. A arquitetura
só se justifica pela fase 2 e pelo acervo privado, que é o que exige conta de verdade, bucket
privado e ingestão. Se o escopo fosse só tocar o catálogo público, um único pacote com React e
`fetch` resolveria — e eu teria escrito isso.

**"Como você garante que o `core` não vaza acesso à plataforma?"** Pelo compilador. O `tsconfig` de
`core` fixa `lib: ["ES2022"]` sem a biblioteca do DOM, então `document`, `window` e `localStorage`
são erro de compilação ali. Não é convenção nem revisão de código: o build quebra.
