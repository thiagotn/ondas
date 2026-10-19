---
title: "O domínio que não compila se enxergar o DOM"
date: 2026-10-19
description: "Como um tsconfig sem a biblioteca do DOM transforma portabilidade em erro de compilação, e os três mecanismos de injeção que o Ondas usa para atravessar a fronteira."
slug: "ondas-monorepo-e-ports"
draft: true
tags:
  - arquitetura
  - typescript
  - monorepo
---

Arquitetura hexagonal costuma ser uma intenção. Alguém escreve "a camada de domínio não deve
depender de infraestrutura" numa página de wiki, e seis meses depois há um `localStorage.getItem` no
meio de uma regra de negócio, porque era mais rápido e ninguém reclamou.

No Ondas essa fronteira não é intenção: é uma linha de configuração do compilador. Este documento
mostra como ela funciona, quais são as cinco portas, os três mecanismos diferentes de injeção que
atravessam a fronteira — e o que a indireção cobra.

## O problema: convenção não se defende sozinha

A promessa do monorepo é que a fase 2 (um app nativo) reaproveite tudo menos a interface. Para isso,
`packages/core` tem de ser puro: tipos, regras de permissão, fila de reprodução, codec de link,
codec de forma de onda, geração de tokens de tema, cliente de catálogo. Nada que só exista num
navegador.

A pergunta prática é: o que impede alguém — eu, numa sexta-feira — de escrever `window.innerWidth`
ali?

## A decisão: o compilador cobra

`packages/core/tsconfig.json` fixa:

```json
"lib": ["ES2022"]
```

Sem `"DOM"`. O comentário ao lado diz o que isso significa: *`document`, `window` e `localStorage`
precisam continuar sendo erro de compilação aqui*.

É tudo. Não há regra de lint, não há revisão de código, não há acordo de equipe. Quem tentar usar
uma API de navegador em `packages/core` descobre no `tsc`, antes do commit — e o CI roda
`pnpm -r typecheck` como primeiro portão.

O `tsconfig.base.json` compartilhado ainda liga quatro opções que mudam o dia a dia mais do que
parece:

| Opção | O que cobra |
|---|---|
| `strict` | o básico: `null` e `undefined` tratados |
| `noUncheckedIndexedAccess` | `arr[i]` tem tipo `T \| undefined` — é por isso que o código de fila está cheio de `?? null` honestos em vez de `!` |
| `noUnusedLocals` / `noUnusedParameters` | import órfão não sobrevive a um refactor |
| `verbatimModuleSyntax` | `import type` explícito; nenhum import de tipo sobra no bundle |

`noUncheckedIndexedAccess` é o que mais incomoda e o que mais paga. Num player, metade dos bugs de
lista são "o índice saiu do intervalo e eu li `undefined` como se fosse faixa". Com a opção ligada,
esse caso não compila sem tratamento.

## As cinco portas

Elas estão em `packages/core/src/ports/`, somam cerca de 90 linhas e são só interface:

| Porta | Assinatura essencial | Na web | Na fase 2 |
|---|---|---|---|
| `PlayerEngine` | `load`, `play`, `pause`, `seek`, `currentTime`, `duration`, `on`, `destroy` | `HTMLAudioElement` + Media Session | `react-native-track-player` |
| `OfflineStore` | `has`, `get`, `put`, `remove`, `usage`, `keys` | Cache API | `expo-file-system` |
| `KeyValueStore` | `get`, `set`, `remove` | `idb-keyval` | MMKV / AsyncStorage |
| `Connectivity` | `isOnline`, `subscribe` | `navigator.onLine` | NetInfo |
| `AuthService` | `login`, `logout`, `restore` | implementação HTTP | a mesma, provavelmente |

Quatro delas foram **nomeadas no handoff de design**, por assinatura, antes de existir código
(`design_handoff_ondas_terminal_player/README.md:43-46`). A quinta apareceu quando a conta de
verdade entrou — e o jeito como ela apareceu é a melhor evidência de que a fronteira valeu a pena,
como mostro mais abaixo.

### Um detalhe de tipo que vale o espaço

`packages/core/src/ports/player-engine.ts:7-20` não declara os eventos como união de strings.
Declara um **mapa de payloads**:

```ts
interface PlayerEngineEvents {
  time: number;
  buffer: number;
  ended: void;
  waiting: boolean;
  playing: boolean;
  duration: number;
  error: Error;
}
```

E `on` é genérico sobre `keyof` desse mapa (`packages/core/src/ports/player-engine.ts:35`). O efeito
é que o callback chega **já tipado por evento**: em `on('time', t => …)`, `t` é `number`; em
`on('error', e => …)`, `e` é `Error`. Com uma união de nomes de evento, todo handler receberia
`unknown` ou um union que precisa ser estreitado à mão.

É pouco código para um ganho que aparece em cada um dos sete *listeners* do `bootstrap`
(`packages/web/src/app/controller.ts:351-376`).

## Três mecanismos de injeção, e por que não um

Não há container de injeção de dependência. Há três padrões diferentes, cada um onde faz sentido.

### 1. Singleton de borda

`packages/web/src/app/services.ts:13` tem o comentário mais curto e mais útil do pacote:

> Trocar de plataforma é trocar este arquivo.

É onde as implementações são instanciadas: armazenamento chave-valor, autenticação, armazenamento
offline, conectividade, os dois clientes de catálogo, o enviador de bytes e o motor de áudio. Um
arquivo, oito objetos, nenhuma mágica. O resto do app importa o que precisa dali.

A alternativa — passar tudo por props ou contexto — seria mais "correta" e tornaria o controller
imperativo impossível, porque ele não roda dentro do React.

### 2. Construtor

Para o que tem variante: `LocalAuthService` recebe o armazenamento chave-valor
(`packages/core/src/auth/local.ts:18`); os clientes de catálogo recebem um `fetchImpl` opcional
(`packages/core/src/catalog/audius.ts:53-55`).

Esse `fetchImpl` tem uma armadilha documentada no próprio código: guardar `fetch` nu como valor
padrão dá **"Illegal invocation"** no navegador, porque a função perde o `this` do `window`. O
default é um wrapper, não a referência direta. É o tipo de detalhe que só se descobre em runtime, e
o comentário existe para que ninguém "simplifique" de volta.

### 3. Objeto de dependências por chamada

O mais interessante. `loadCatalog` não é um método de uma classe com dependências no construtor — é
uma função que recebe suas dependências em cada chamada
(`packages/core/src/catalog/resolve.ts:18-38`):

```ts
interface LoadCatalogDeps {
  remote: CatalogClient;
  readCache: () => Promise<CachedCatalog | null>;
  writeCache: (c: CachedCatalog) => Promise<void>;
  forceDemo?: boolean;
  maxAgeMs?: number;
  now?: () => number;      // injetável para teste
  onError?: (e: unknown) => void;
  acervo?: (signal?: AbortSignal) => Promise<Track[]>;
}
```

O `now?: () => number` é a razão de ser do padrão. A função decide se o cache de metadados expirou
comparando com 24 horas, e testar isso com uma classe exigiria mexer no relógio do sistema ou
esperar. Com o relógio como dependência da chamada, o teste passa uma função e pronto. O mesmo
padrão aparece em `stepIndex(ctx, dir, rnd = Math.random)` (`packages/core/src/queue.ts:37`) — o
sorteio do modo aleatório é injetável, então o comportamento do shuffle é determinístico no teste.

### Uma porta que é uma função

`packages/core/src/acervo/upload.ts:40` define `EnviadorDeBytes<A>` como um tipo de função, não uma
interface com métodos. Ela existe porque `fetch` **não reporta progresso de upload**
(`packages/core/src/acervo/upload.ts:33-39`), e a implementação na web é XHR
(`packages/web/src/platform/XhrEnviador.ts:5-8`) — que também é a única opção porque corpo em
`ReadableStream` não existe no Safari.

Nem toda porta precisa de uma interface. Quando a dependência é "uma coisa que faz um trabalho e
reporta progresso", um tipo de função é a forma honesta.

## A prova de que a fronteira pagou

O protótipo tinha autenticação de mentira: um `LocalAuthService` que validava um e-mail com uma
expressão regular frouxa e guardava o usuário no armazenamento local. Quando a API de verdade
entrou, apareceu `HttpAuthService`, que fala com `/api/auth/*`, lida com cookie e trata 401.

As duas implementam `AuthService`. A troca aconteceu **em `packages/web/src/app/services.ts`**, numa
linha, e nenhum componente de interface mudou — porque nenhum componente conhecia
`LocalAuthService`; todos conheciam a porta.

Vale notar o que a implementação nova documenta de volta, em `packages/core/src/auth/http.ts:27-30`:
a sessão vive num cookie `HttpOnly` que **este código não consegue ler**. O que fica no
armazenamento chave-valor é só o nome do usuário, para a tela não piscar entre o boot e a resposta
de `/me`. A porta `AuthService` não promete um token — promete `login`, `logout` e `restore` —, e
foi justamente por isso que ela aceitou uma implementação cuja credencial é invisível ao JavaScript.

Há um segundo detalhe de produto escondido nessa implementação: `restore()` só invalida a sessão num
**401**, nunca numa falha de rede. A PWA é instalada e abre offline; tratar "não consegui perguntar"
como "não estou logado" expulsaria o usuário do app sempre que ele abrisse no metrô.

## O que fica de fora das portas

`packages/web/src/platform/` tem oito arquivos, mas só cinco são implementações de porta. Os outros
três são adaptadores sem porta correspondente: Media Session, compartilhamento e redução de imagem
em canvas.

A escolha é consciente. Media Session é um enfeite de plataforma — se não existir, o app funciona
igual, só não aparece no controle de mídia do sistema. Criar uma porta para ela seria inventar uma
abstração para um recurso que a fase 2 resolve de outro jeito inteiramente (o
`react-native-track-player` já cuida disso). **Porta é para o que o domínio precisa; adaptador é
para o que a plataforma oferece.**

## O que foi descartado

| Opção | Por que não |
|---|---|
| Convenção de pasta + revisão de código | Não se defende sozinha; o `lib` do `tsconfig` defende |
| Lint customizado proibindo globais de navegador | Mais peças para manter, e o compilador já faz |
| Container de injeção de dependência | Oito objetos num arquivo não precisam de um framework para serem resolvidos |
| Dependências por contexto do React | O controller imperativo não roda dentro do React e precisa ler estado sem hooks |
| `PlayerEngine` com união de nomes de evento | Handler receberia tipo não estreitado; o mapa de payloads tipa cada callback |
| Porta para Media Session e compartilhamento | São recursos de plataforma, não necessidades do domínio |

## O que isso custou

**Indireção real, com um custo de leitura.** Para saber o que acontece quando o áudio termina, é
preciso ir do `controller` ao `queue` do domínio e à implementação do motor. Em três arquivos, num
projeto de 8.800 linhas de frontend, é um custo que vale. Num projeto de 800 linhas, não valeria.

**A quinta porta apareceu depois.**`AuthService` não estava no handoff, e teve de ser desenhada com
o `LocalAuthService` já existindo — o que enviesou a interface para o que a implementação de mentira
fazia. O conserto foi barato porque a fronteira já existia, mas o nome "porta desenhada a partir de
uma implementação" descreve a origem dela.

**`noUncheckedIndexedAccess` gera ruído.** Todo acesso indexado precisa de tratamento, inclusive os
que são obviamente seguros. O código tem `?? null` em lugares onde um humano sabe que o índice é
válido, e isso é ruído que a opção cobra em troca de pegar os casos em que o humano estava errado.

**A promessa da fase 2 ainda é uma promessa.** A coluna "na fase 2" da tabela de portas é hipótese.
A arquitetura só prova o que vale quando o segundo adaptador existir; até lá, é uma aposta
bem-estruturada.

## Numa entrevista

**"Como você garante que a camada de domínio não depende de infraestrutura?"** Pelo `tsconfig` do
pacote: ele fixa `lib: ["ES2022"]`, sem a biblioteca do DOM. `document`, `window` e `localStorage`
são erro de compilação ali, e o CI roda `typecheck` como primeiro portão. A diferença entre isso e
uma convenção é que uma convenção depende de alguém reparar na revisão.

**"Você usa injeção de dependência?"** Três formas, sem container. Um arquivo de borda instancia as
implementações e tem o comentário "trocar de plataforma é trocar este arquivo". Construtor onde há
variante. E objeto de dependências por chamada onde o teste precisa controlar algo — o `loadCatalog`
recebe o relógio como dependência, e é isso que permite testar a expiração do cache de 24 horas sem
mexer no relógio do sistema.

**"Como você provou que a arquitetura de portas valeu?"** Quando a autenticação de mentira do
protótipo foi trocada pela API de verdade, a mudança foi uma linha no arquivo de borda e zero
componentes de interface. Nenhum deles conhecia a implementação antiga — todos conheciam a porta. A
implementação nova tem até uma propriedade que a antiga não tinha: a credencial é um cookie
`HttpOnly` que o JavaScript não consegue ler.

**"Toda API de plataforma virou porta?"** Não, e isso é deliberado. Porta é para o que o domínio
precisa; adaptador é para o que a plataforma oferece. Media Session e compartilhamento são
adaptadores sem porta, porque, se não existirem, o app funciona igual. Criar abstração para eles
seria inventar uma interface que a fase 2 resolve de outro jeito.

**"Qual o custo dessa estrutura?"** Indireção. Entender o fim de uma faixa exige abrir três
arquivos. Isso vale num frontend de 8.800 linhas com uma segunda plataforma planejada; não valeria
num app de 800 linhas. E a promessa da segunda plataforma ainda é promessa — a arquitetura só se
prova quando existir o segundo adaptador.
