---
title: "O CI que não fala com o cluster"
date: 2026-10-19
description: "Três imagens, um write-back de tag em vez de kubectl, e um seletor de YAML que falha alto em vez de escrever a tag errada. Mais o nginx que redireciona porque um proxy_pass derrubaria o site."
slug: "ondas-devops-gitops"
draft: true
tags:
  - devops
  - gitops
  - docker
---

O pipeline do Ondas tem uma propriedade que vale mais que qualquer otimização de build: **o CI não
tem credencial para falar com o cluster**. Ele publica imagens e escreve uma tag num arquivo de
configuração. Quem aplica no cluster é um agente que roda dentro dele, observando o repositório.

Este documento cobre o que está neste repositório público: o workflow, as três imagens, a
configuração do nginx e o contrato de deploy. Os manifestos e a topologia do cluster vivem num
repositório privado e não aparecem aqui.

## O problema: a credencial que o CI guarda é a credencial que vaza

A forma direta de fazer deploy é o CI rodar `kubectl set image` ou `helm upgrade`. Para isso ele
precisa de um `kubeconfig` com permissão de escrita no cluster, guardado nos segredos do repositório
do app.

Essa credencial é, na prática, acesso ao cluster inteiro para qualquer pessoa que consiga executar
código no CI — o que inclui quem abrir um pull request que mexa no workflow, ou qualquer uma das
centenas de ações de terceiros que um workflow típico invoca.

## A decisão: o CI escreve num arquivo; o cluster lê o arquivo

`.github/workflows/build-image.yml:133-135` registra a regra:

> o cluster **NÃO** recebe nada deste CI (read-only)

O fluxo é:

1. `git push` na `main`;
2. o CI roda os testes, publica as três imagens no registro;
3. o CI escreve a tag nova num arquivo YAML **no repositório de infraestrutura**;
4. o Argo CD, que roda dentro do cluster, detecta o commit e faz o rollout.

A credencial de escrita que o CI carrega alcança **um repositório git**, não um cluster. O pior caso
de um comprometimento do CI é um commit indevido num arquivo versionado — visível, revertível, com
histórico.

E há um efeito colateral que eu não tinha previsto: como o estado desejado é um arquivo no git,
**rollback é um commit**. Não há "qual era a tag anterior?" — está no histórico. Em compensação, um
`kubectl set image` manual não sobrevive, porque o agente reconcilia de volta para o que está
versionado. O caminho durável é sempre o arquivo.

## O portão de qualidade vem antes da publicação

O workflow tem três jobs em cadeia estrita: `verify` → `build-push` → `bump-homelab-tag`
(`.github/workflows/build-image.yml:17`). Nenhuma imagem é publicada sem a suíte inteira verde.

O `verify` roda, em ordem:

```
pnpm -r typecheck
pnpm test                    # 216 testes do domínio
playwright install chromium
pnpm test:e2e                # 30 testes × 2 viewports
go test ./...                # 123 testes, contra Postgres de verdade
```

Três detalhes dessa configuração que valem o espaço:

**Há um Postgres de verdade no CI**, como *service container*
(`.github/workflows/build-image.yml:19-21`), e o comentário diz por quê: a corrida de migração de
dois pods subindo juntos só aparece contra banco real — *"sem este serviço aquele teste viveria
pulado"*. Essa é a distinção que importa: o teste **existe** de qualquer jeito, mas sem o banco ele
se pula em silêncio e o portão fica aberto sem ninguém saber.

**O ffmpeg é garantido antes dos testes Go** (`.github/workflows/build-image.yml:64-65`), pela mesma
razão: os testes de mídia se pulam sem ele.

**O relatório do Playwright é publicado como artefato só em falha**
(`.github/workflows/build-image.yml:73-79`), com sete dias de retenção. Teste de ponta a ponta que
falha no CI e não deixa rastro é uma hora de tentativa de reprodução local.

## As três imagens, e por que são diferentes

| Imagem | Base de runtime | Usuário | Testa no build? |
|---|---|---|---|
| `ondas` (PWA) | `nginx:stable-alpine` | `nginx` (101) | não (o `verify` já rodou) |
| `ondas-api` | **`scratch`** | 65532 | **sim**, `go test ./...` |
| `ondas-worker` | `alpine` + ffmpeg | 65532 | não |

**A da PWA** (`/Dockerfile`) copia os manifestos antes do código (`/Dockerfile:9-12`), para que a
camada de dependências só reconstrua quando um `package.json` muda. Os ícones são versionados, então
`sharp` não entra na imagem (`/Dockerfile:15-16`). O runtime faz o preparo que o nginx non-root
exige — ajustar dono de `/var/cache/nginx` e `/var/run`, criar o arquivo de pid — e expõe `:8080`
com `HEALTHCHECK` em `/healthz`.

**A da API** é `FROM scratch` com dois arquivos: os certificados raiz e o binário
(`/api/Dockerfile:15-19`). Não há shell, não há gerenciador de pacotes, não há nada para invocar.
`api/Dockerfile:22` nota a consequência: *"sem shell e sem usuário no scratch… o deployment confirma
com `runAsNonRoot`"*. O contexto de build é a pasta `api/` justamente para não arrastar o monorepo
inteiro (`/api/Dockerfile:1-2`).

**A do worker** não é `scratch` porque o ffmpeg é obrigatório (`/api/Dockerfile.worker:1-3`). E ela
**não roda os testes** (`/api/Dockerfile.worker:11-12`): *"os testes rodam no build da API (mesmo
módulo, mesma suíte); aqui só compila, para não pagar a suíte duas vezes."*

A assimetria é deliberada e tem um detalhe de desenho: rodar `go test` dentro do build da API
significa que **a imagem não existe se os testes falharem**, independentemente do que o CI fez. É
redundante com o job `verify` e é a redundância certa — um build local que esqueceu de rodar os
testes também não produz imagem.

O cache de build é escopado por imagem (`cache-from: type=gha,scope=${{ matrix.name }}`,
`.github/workflows/build-image.yml:130-131`). Sem o escopo, os três builds da matriz se
sobrescreveriam e o cache serviria para nada.

## O write-back, e a guarda que o torna confiável

Esta é a parte do workflow que eu mais recomendaria copiar.

A tag é escrita no YAML com `yq`, e o seletor é **por nome, não por posição**
(`.github/workflows/build-image.yml:152-156`):

```bash
SELETOR=".images[] | select(.name == \"ghcr.io/thiagotn/${IMG}\")"
```

O comentário explica o que a alternativa custaria: `.images[0]` *"viraria uma roleta e um dia
escreveria a tag da PWA na API"*. Indexar por posição numa lista que alguém pode reordenar é uma
bomba de efeito retardado — e o sintoma seria a API rodando o build do frontend.

E a guarda (`.github/workflows/build-image.yml:157-164`):

```bash
if [ -z "$ATUAL" ] || [ "$ATUAL" = "null" ]; then
  echo "::error::imagem ${IMG} não encontrada"; exit 1
fi
```

A razão é um comportamento silencioso do `yq`: atualizar um campo que não casa com nada **não
escreve nada e não dá erro**. Sem a guarda, renomear uma imagem faria o pipeline passar verde
enquanto o cluster continuava com a tag velha para sempre. Ninguém investiga um pipeline verde.

Esse é o padrão geral: *toda escrita que pode não acontecer precisa de uma verificação de que
aconteceu.* `yq -i`, `sed -i`, `UPDATE` sem `WHERE` conferido — todos têm essa propriedade.

O commit é assinado como bot, com `[skip ci]` no assunto e `git diff --cached --quiet` como guarda
de no-op, para um rebuild sem mudança de tag não gerar commit vazio.

## O nginx, e o `proxy_pass` que não existe

`packages/web/nginx.conf` tem 111 linhas e quatro decisões que valem registro.

**O redirect de prévia de link é um 302, não um `proxy_pass`** (`packages/web/nginx.conf:86-95`). O
nginx resolve o nome do upstream **no start**, então um `proxy_pass` para o serviço da API
derrubaria o pod da PWA em reinício contínuo sempre que o DNS da API falhasse. Hoje a API fora do ar
degrada só o acervo; com `proxy_pass`, ela derrubaria o site estático junto. O redirect reentra pelo
Ingress — que já roteia `/api` — e a imagem da PWA segue sem conhecer o nome de nenhum serviço do
cluster.

**A regra de herança de `add_header`.** Os cabeçalhos de segurança estão no nível do `server`
(`packages/web/nginx.conf:50-53`), e o comentário em `packages/web/nginx.conf:48-49` registra a
consequência: nginx só herda cabeçalho em `location` que **não** tenha `add_header` próprio. Por
isso os blocos de cache usam `expires`, nunca `add_header` — um `add_header Cache-Control` num
`location` apagaria silenciosamente os quatro cabeçalhos de segurança daquele caminho.

É uma das pegadinhas mais caras do nginx, porque o sintoma é invisível: o site funciona, e os
cabeçalhos simplesmente não estão lá.

**`absolute_redirect off` e `port_in_redirect off`** (`packages/web/nginx.conf:21-22`). Sem isso,
qualquer redirect vazaria a porta interna `:8080` no `Location` — o nginx escuta em 8080 atrás de um
proxy que termina TLS.

**Cache escalonado por tipo de recurso:**

| Caminho | Validade | Por quê |
|---|---|---|
| `/sw.js` | `no-cache, must-revalidate` | Service Worker cacheado é uma versão presa para sempre |
| `packages/web/index.html` | `expires -1` | é o documento que aponta para o resto |
| `/assets/` | **1 ano** | o nome tem hash do conteúdo |
| `/icons/` | 7 dias | |
| `/manifest.webmanifest` | 1 hora | |
| `/t/` | `expires -1` | senão o edge guarda o 302 do robô e serve a página de prévia para gente |

A última linha é uma falha que só aparece com CDN no caminho, e o comentário a nomeia.

E o `server_name _` com zero hostname no arquivo (`packages/web/nginx.conf:2-3`): trocar de domínio
não toca a imagem. Como o manifesto da PWA usa `start_url` e `scope` relativos e não há URL absoluta
própria no código, migrar de domínio é mudança de infraestrutura em três lugares — nenhum deles
neste repositório, nenhum deles exigindo rebuild.

## O que foi descartado

| Opção | Por que não |
|---|---|
| `kubectl`/`helm` direto do CI | Exigiria credencial de escrita no cluster guardada nos segredos do repositório do app |
| `.images[0]` no `yq` | Indexar por posição numa lista reordenável; um dia escreve a tag errada |
| `yq -i` sem conferir o resultado | Campo que não casa não escreve nada **e não dá erro**: pipeline verde, tag velha |
| `proxy_pass` para a API | nginx resolve upstream no start; a PWA cairia em reinício quando o DNS da API falhasse |
| `add_header` nos blocos de cache | Apagaria os cabeçalhos de segurança herdados do `server` |
| Cache único para todos os estáticos | `/sw.js` cacheado prende a versão; `/assets/` com hash no nome aguenta um ano |
| Rodar os testes no build do worker | Mesmo módulo, mesma suíte; pagar duas vezes |
| `scratch` no worker | ffmpeg é obrigatório |
| Hostname embutido na imagem | Trocar de domínio deixaria de ser só infraestrutura |
| Cache de build compartilhado entre as três imagens | Os builds se sobrescrevem e o cache não serve para nada |

## O que isso custou

**Há latência entre o push e o rollout.** O agente de reconciliação tem um ciclo; o deploy não é
imediato. Em troca, o estado desejado é auditável.

**Mudança manual no cluster não sobrevive.** Com reconciliação automática ligada, um ajuste feito à
mão é revertido. É a propriedade desejada e é uma surpresa desagradável para quem não sabe.

**O write-back cria commits no repositório de infraestrutura.** O histórico fica intercalado de
commits de deploy do bot. O `[skip ci]` evita o laço; a poluição permanece.

**Três imagens é três vezes o build.** O cache escopado ajuda, e o `verify` ainda roda uma vez para
as três — que é o que mantém o tempo total razoável.

**A guarda do `yq` foi escrita porque eu pensei nela**, não porque a falha aconteceu. É o tipo de
proteção que ninguém sabe se vale até o dia em que vale.

## Numa entrevista

**"Como é seu pipeline de deploy?"** GitOps com write-back de tag. O push roda o portão de
qualidade, publica as três imagens e escreve a tag nova num arquivo YAML no repositório de
infraestrutura. Um agente dentro do cluster detecta o commit e reconcilia. A propriedade que eu mais
valorizo é que o CI **não tem credencial para falar com o cluster** — a que ele guarda alcança um
repositório git.

**"Por que não `kubectl` direto do CI?"** Porque a credencial que o CI guarda é a credencial que
vaza. Um `kubeconfig` com escrita nos segredos do repositório é acesso ao cluster para qualquer um
que consiga executar código no pipeline — o que inclui as ações de terceiros que o workflow invoca.
Com write-back, o pior caso é um commit indevido num arquivo versionado: visível e revertível.

**"Qual o detalhe mais fácil de errar nesse write-back?"** Dois. Selecionar a imagem por posição em
vez de por nome — `.images[0]` funciona até alguém reordenar a lista, e então o pipeline escreve a
tag do frontend na API. E não conferir se a escrita aconteceu: `yq -i` num campo que não casa com
nada **não escreve e não dá erro**. Sem a verificação, renomear uma imagem deixa o pipeline verde e
o cluster com a tag velha para sempre.

**"Por que a imagem da API roda os testes dentro do `docker build`?"** Porque aí a imagem não existe
se os testes falharem, independentemente do CI. É redundante com o job de verificação e é a
redundância certa: um build local que esqueceu de rodar os testes também não produz imagem. Já o
worker não repete a suíte — é o mesmo módulo, e pagar duas vezes não compra nada.

**"Me conta uma pegadinha de nginx que te pegou."** A herança de `add_header`. Os cabeçalhos de
segurança estão no nível do `server`, e o nginx só os herda em `location` que não tenha `add_header`
próprio. Então qualquer bloco de cache que usasse `add_header Cache-Control` apagaria
silenciosamente os quatro cabeçalhos daquele caminho. Os blocos usam `expires`. O sintoma de errar é
invisível: o site funciona e os cabeçalhos não estão lá.

**"E a prévia de link, por que um redirect e não um proxy?"** Porque o nginx resolve o nome do
upstream no start do processo. Um `proxy_pass` para o serviço da API derrubaria o pod da PWA em
reinício contínuo sempre que o DNS da API falhasse — trocando "o acervo está fora" por "o site está
fora". Com 302, a requisição reentra pelo Ingress, que já roteia `/api`, e a imagem da PWA não
precisa conhecer o nome de nenhum serviço do cluster.

**"Como você trocaria o domínio da aplicação?"** Sem tocar na imagem. O nginx escuta em
`server_name _`, o manifesto da PWA usa `start_url` e `scope` relativos e não há URL absoluta
própria no código. Trocar de domínio é mudança em três arquivos de infraestrutura e um registro de
DNS — nenhum rebuild, e os dois domínios podem servir o mesmo pod em paralelo durante a migração.
