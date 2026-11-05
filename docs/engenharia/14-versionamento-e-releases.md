---
title: "A nota de versão como fonte, não como subproduto"
date: 2026-11-05
description: "O app ficou cinco entregas parado na 1.0.0 porque nada forçava o incremento. A correção foi escolher um único arquivo como fonte da nota e fazer dele sair a versão dos pacotes, o CHANGELOG do repositório e uma página dentro da PWA — com três testes travando a divergência."
slug: "ondas-versionamento-releases"
draft: true
tags:
  - versionamento
  - semver
  - processo
---

Em 05/11/2026 o `ondas --about` dizia `versão 1.0.0`. Nos dias anteriores o app tinha ganhado a
bandeira de cada idioma no seletor, parado de recarregar a página sozinho ao trocar de versão,
deixado de calar a música quando o navegador declara que não há rede, e parado de mostrar preto sem
explicação. Cinco entregas de comportamento visível, e o número na tela não se moveu nenhuma vez.

Não é descuido de uma vez só: é o que acontece quando o incremento de versão não tem dono. O
`package.json` nasce em `1.0.0` e fica ali enquanto ninguém o editar à mão, e editar à mão é
exatamente o tipo de passo que não sobrevive a uma sexta-feira.

## O que eu NÃO quis

**Um gerador a partir do `git log`.** `standard-version`, `changesets`, `semantic-release` — todos
resolvem o incremento lendo mensagens de commit num formato convencionado. O commit deste projeto é
uma frase em português que descreve o efeito para quem usa ("o navegador dizer que não há rede não
pode mais calar a música"), e eu gosto dela assim. Convencionar prefixos `feat:`/`fix:` para
alimentar uma ferramenta trocaria a melhor parte do histórico pela conveniência de não escrever uma
nota — e a nota gerada de commits é, na prática, o diff contado de novo. A nota que presta é a que
diz o que mudou *para quem usa*, e essa ninguém extrai de um log.

**Um `CHANGELOG.md` escrito à mão.** Resolve o repositório e não resolve o app: quem usa a PWA não
abre o GitHub para descobrir o que mudou. E duas listas escritas à mão divergem — é só questão de
qual delas é esquecida primeiro.

**A nota nos catálogos de `i18n`.** Tentador, porque o app já tem três idiomas disciplinados ali.
Mas o catálogo é uma tabela de chaves estáveis, e a nota é uma lista que cresce a cada entrega: eu
teria chaves `changelog.v110.item3` nos três arquivos, e um script fora do bundler não conseguiria
ler nenhuma delas.

## A escolha: um arquivo, três destinos

A fonte é `packages/core/src/release/notas.json`. Uma entrada por release, a mais nova no topo, cada
item escrito nos três idiomas:

```json
{
  "versao": "1.1.0",
  "data": "2026-11-05",
  "itens": [
    { "pt-BR": "a bandeira de cada idioma…", "en": "each language's flag…", "es": "la bandera…" }
  ]
}
```

Dela saem três coisas, e nenhuma é escrita à mão:

1. **A versão dos três `package.json`** (raiz, `core`, `web`). É de lá que o Vite monta o
   `__APP_VERSION__` que o `ondas --about` e a tela de login mostram.
2. **O `CHANGELOG.md` da raiz**, para quem lê o repositório.
3. **A página `/changelog` da PWA**, que importa `RELEASES` do `core` e desenha a nota no idioma de
   quem está lendo.

O terceiro destino é o que justifica o formato. A página é parte do app: entra no precache do
Service Worker, funciona offline, e a versão que está rodando aparece marcada com `[em uso]` — a
comparação é com o `__APP_VERSION__` do bundle, e não com o topo da lista, porque numa PWA que ficou
aberta durante um deploy o bundle antigo é quem está na tela, e dizer "em uso" na versão nova seria
mentira.

### Por que JSON, num projeto que é TypeScript inteiro

Porque o arquivo tem dois leitores em mundos diferentes: o bundle, que o importa com tipo
(`resolveJsonModule` já estava ligado), e `scripts/release.mjs`, que é Node puro. Um `.ts` obrigaria
o script a carregar um compilador — ou a confiar no `--experimental-strip-types` de uma versão de
Node específica — para fazer uma coisa que precisa funcionar justamente no dia em que a instalação
está quebrada. O script não tem nenhuma dependência, e isso é deliberado: um script de release que
precisa de `pnpm install` para rodar é um script que não roda quando mais se precisa dele.

O preço do JSON é não ter comentário. O formato está documentado no `release/index.ts` ao lado, que
é também quem o tipa.

## O que trava a divergência

Um ritual que depende de memória não é um ritual, é uma intenção. Três testes em
`release.test.ts` fecham o furo:

- os três `package.json` estão na versão do topo da nota;
- o `CHANGELOG.md` tem a entrada daquela versão;
- nenhum item em português ficou de fora dele.

Eles rodam na suíte de domínio, que é a mais rápida e a que ninguém pula. Além disso,
`pnpm release --check` não escreve nada e sai com código 1 quando algum destino está fora de
sincronia — é o passo que o CI roda junto do `typecheck`, para um bump sem nota (ou uma nota sem
bump) travar o build antes de virar imagem.

A outra metade da disciplina é de teste de ponta a ponta: o smoke abre o `ondas --about`, clica em
`[notas da versão]` e compara o que a tela escreve com o que está no `notas.json`. A versão esperada
sai do `package.json` do pacote, e não de um `'1.1.0'` fixado no teste — fixar faria o teste quebrar
na próxima entrega, que é exatamente quando ele precisa continuar valendo.

## O que SemVer significa aqui

Um app não tem API pública, então as três casas precisam de uma leitura própria. A que eu adotei:

- **patch** — correção de comportamento que ninguém pediu para mudar;
- **minor** — recurso novo, ou mudança visível de comportamento que foi pedida;
- **major** — quebra do que atravessa versão: o formato do que está guardado no IndexedDB, o
  contrato com a API, o endereço de algo que já foi compartilhado.

A terceira é a que importa num app que persiste dados no aparelho de quem usa. Um catálogo guardado
ontem num formato que o código de hoje não conhece já derrubou esta PWA uma vez (está contado no
documento 05), e é por isso que "quebra" aqui se mede em disco e em link, não em assinatura de
função.

## Numa entrevista

**"Por que não `semantic-release`?"** Porque ele compra o incremento automático com o preço de
converter a mensagem de commit em entrada de máquina. Neste projeto a mensagem é prosa sobre o
efeito para quem usa, e a nota de versão é escrita para a mesma pessoa — nos três idiomas. O que eu
automatizei foi a *propagação* (versão nos pacotes, CHANGELOG, página), que é onde o erro humano
acontece, e não a *redação*, que é onde ele não acontece.

**"Qual é o risco de ter a nota dentro do bundle?"** Peso: a lista cresce para sempre, e um app que
embarca cinco anos de notas carrega texto que quase ninguém lê. Hoje são duas entradas e o custo é
irrelevante; quando passar de umas dezenas, a página passa a buscar as antigas da API e o bundle
fica só com as recentes. É uma troca que se faz quando o número justificar, não antes.

**"Por que a versão aparece em três `package.json`?"** Porque o monorepo tem três pacotes e o Vite
lê o do `web` para montar o `__APP_VERSION__`. Mantê-los iguais é mais simples do que explicar por
que divergem: nada aqui é publicado em registry, então versão independente por pacote seria
cerimônia sem ganho. O script escreve os três e o teste confere os três.
