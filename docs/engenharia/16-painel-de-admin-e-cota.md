---
title: "Tirar a decisão de produto do ConfigMap"
date: 2026-11-23
description: "Liberar uma pessoa no ondas era um commit no repositório de infra, uma sincronização e um restart. Isso virou um painel de administração separado da PWA, com as três decisões de produto no banco e uma cota de armazenamento por conta que, por enquanto, só mede."
slug: "ondas-painel-de-admin-e-cota"
draft: true
tags:
  - administracao
  - autorizacao
  - modelagem
---

Para liberar uma pessoa no ondas eu editava uma lista de e-mails no ConfigMap, no repositório de
infra, esperava o Argo e reiniciava dois pods. Duas listas, na verdade: `SIGNUP_ALLOWLIST` para ela
entrar sem análise e `INGEST_DESTINOS` para o bot poder publicar para ela. Numa tarde fiz isso duas
vezes seguidas, e ficou claro que a pergunta "quem pode" estava no lugar errado.

## Configuração é o que o operador decide; dado é o que o admin decide

`INGEST_MAX_MB` é configuração: muda com a capacidade do nó, é o padrão de todo mundo, e faz
sentido viver ao lado do `sizeLimit` do volume. "A fulana pode se cadastrar" não é nada disso — é
um fato sobre uma pessoa, que muda no dia a dia, e que eu quero mudar do celular.

A migração `0012` leva as três decisões de produto para o banco:

| Era (env) | Virou | Onde |
|---|---|---|
| `SIGNUP_OPEN` | chave `cadastro_aberto` | tabela `config` |
| `SIGNUP_ALLOWLIST` | um **convite** por e-mail | tabela `convites` |
| `INGEST_DESTINOS` | `recebe_do_bot` na conta | coluna em `users` |

O convite ganhou uma coisa que a allowlist não tinha: ele diz **com o que a conta nasce**
(`pode_enviar`, `recebe_do_bot`). Antes, liberar alguém de verdade eram três passos em dois
lugares — allowlist, esperar o cadastro, `ondasctl contas envio on`. Agora é um convite. E ele é
consumido no cadastro: não fica uma aprovação sobrando na lista.

### A importação que acontece uma vez

O deploy não podia mudar nada para ninguém. `admin.ImportarEnv` roda no boot da API, numa transação
travada por um marcador (`env_importado`): copia o que o env dizia e nunca mais olha para ele —
inclusive quando o env diz o contrário do que o admin já decidiu na tela, que é exatamente quando
reimportar faria estrago.

Um caso pediu decisão: e-mail em `INGEST_DESTINOS` **sem conta e sem convite**. Criar um convite
para ele pré-aprovaria um cadastro que o env nunca aprovou — estar na lista de destinos nunca deixou
ninguém pular a análise. Esses são descartados e logados.

## O painel é outra aplicação

O [documento 15](15-cadastro-e-administracao.md) recusou um papel de admin em `users`, por dois
motivos: o poder de aprovar conta passaria a morar no cookie de sessão, e a PWA ganharia código de
administração no bundle que todo visitante baixa. Os dois continuam valendo, e o painel não desfaz
nenhum:

- **É outro pacote, outra imagem, outro host** (`packages/admin`, `ondas-admin.thiagotn.com`). O
  cliente HTTP de admin mora nele, não no `@ondas/core`.
- **O admin continua não sendo um usuário.** A credencial é o mesmo token de admin da `ondasctl`.

O que mudou é onde o token fica enquanto se usa a tela. Guardá-lo em `localStorage` o deixaria ao
alcance de qualquer script da página. Então `POST /api/admin/sessao` o troca por um cookie:

| Atributo | Valor | Por quê |
|---|---|---|
| `HttpOnly` | sim | script não lê |
| `SameSite` | `Strict` | nenhum fluxo legítimo chega ao painel vindo de outro site; é a defesa de CSRF |
| `Path` | `/api/admin` | o resto da API nem o recebe |
| validade | 12 h | um aparelho esquecido para de ser admin sozinho |

A chave que assina esse cookie junta `SESSION_SECRET` com a soma do token de admin. Trocar o token
derruba as sessões do painel; e um cookie de usuário não confere aqui nem renomeado — há um teste
que tenta os dois sentidos (`TestCookieDoPainelEDeUsuarioNaoSeMisturam`).

O Ingress do host do painel só roteia `/api/admin`. Sessão de usuário e sessão de admin vivem em
origens que não se enxergam.

### O freio que não tranca o dono

O freio de tentativas do admin contava todo pedido e zerava no acerto — bom para uma CLI, que faz
um pedido por vez. Um painel abre uma tela com três pedidos em paralelo, e pergunta "estou dentro?"
sem credencial nenhuma toda vez que é aberto deslogado. Agora ele conta só a **credencial errada**:
token recusado ou cookie forjado. Pedido válido e pedido sem credencial não gastam nada.

### Filtro, ordem, tema e idioma: tudo no navegador

As listas filtram por texto e ordenam por coluna **no cliente**, sobre as linhas que a API já
mandou (`packages/admin/src/lista.tsx`). É a escolha certa para o tamanho que o painel tem — dezenas
de contas, até 200 faixas por pedido — e evita uma segunda linguagem de consulta no servidor. O
limite é dito na tela: numa lista que o servidor corta, filtrar e ordenar não alcançam o que ficou
de fora do corte. Os filtros que **mudam o que a API manda** (status de conta, status de ingestão,
"maiores"/"mais novas" nas faixas) continuam sendo pedidos novos, e ficam separados da busca de
propósito. O recorte mora no endereço (`?q=…&ord=-usado`): recarregar e voltar o preservam.

Tema e idioma são os da PWA — os temas vêm de `THEMES`/`themeCssVars` e o motor de frases é o do
core —, mas o **catálogo de frases é do pacote do painel**: o core vai para o bundle de todo
visitante, e frase de administração não deve chegar lá. As duas preferências ficam no
`localStorage` deste host (`prefs.ts`). Não há de quem herdar: o token de admin não tem identidade,
e o `localStorage` da PWA é de outra origem. Trocar de idioma recarrega a página, pelo mesmo motivo
da PWA (idioma de módulo, fixado no boot).

O que **não** é traduzido: o que o servidor escreveu como dado — a frase de erro de uma ingestão, o
detalhe de um evento do histórico, o nome de um plano. Erro de pedido à API é traduzido pelo
código quando o catálogo do app o conhece; sem isso, aparece a frase em português do servidor.

## Cota: o modelo antes da cobrança

O envio custa armazenamento, e o "formato comercial" disso continua indefinido. O que dá para
decidir agora é a forma do dado, de modo que a cobrança, quando vier, só precise **escrever** nela:

```
cota da conta = planos.cota_bytes + users.cota_extra_bytes
```

O plano é o que se renova (assinatura troca `users.plano_id`); o extra é o que se compra uma vez e
fica (avulso soma em `cota_extra_bytes`). A tabela `planos` não sabe o que é preço nem validade —
ela responde só "qual é a cota".

A cota é **calculada**, não copiada: mudar a cota de um plano vale na hora para todas as contas dele.

### Medir antes de recusar

Na 1.11 nada era recusado: o número aparecia no painel e no `ondas whoami` de cada conta, e só.
Bloquear antes de ter visto os números reais seria escolher um limite no escuro.

A recusa chegou na 1.12, junto com o motivo para ela existir — cada conta passou a trazer faixa
sozinha, por link ([documento 17](17-faixa-por-link.md)). É uma chave do admin (`cota_bloqueia`, na
tela de planos), e não regra fixa: se o número se mostrar errado, desliga-se sem deploy. Uma falha
ao LER a cota não recusa ninguém — ela é teto de crescimento, e o banco piscando não pode virar
"sem espaço" para quem tem.

Para o número fechar com o que o bucket cobra, as capas passaram a contar (`tracks.art_bytes`). O
worker sempre mediu a capa na hora de subir e jogava o resultado fora; as faixas antigas são
preenchidas por `worker medir-capas`, que pergunta o tamanho ao R2 (HEAD) sem baixar nada.

A recusa mora em todo caminho de entrada: o pedido de vaga e a finalização do upload
(`httpapi/upload.go`), o pedido de ingestão (conta já no limite nem enfileira), a vaga do arquivo
que o node baixou (`httpapi/paginas.go`) e o worker depois de baixar uma URL — único momento em que
o tamanho de uma ingestão por URL é conhecido, e ali a falha é definitiva: repetir o download não
cria espaço. Em todos, a conta que conta é a que vai ser **dona** da faixa, não quem pediu.

Com a recusa valendo, faltava a saída: até a 1.13 só o admin apagava faixa, então conta cheia
dependia dele. Na 1.14 a própria pessoa apaga do acervo pela PWA (a rota `DELETE /api/acervo/{id}`
já existia, só de sessão e só para o dono), e a mesma faixa deixa de entrar duas vezes — que era
cota gasta à toa ([documento 10](10-ingestao-e-ssrf.md), "Faixa repetida").

## O teto de envio também pode ser de uma conta

`INGEST_MAX_MB` continua sendo configuração, e continua sendo o teto de todo mundo — até o admin
escrever outro número numa conta. A migração `0015` põe `users.max_upload_bytes`, anulável: `NULL` é
"o padrão do servidor", e é o que toda conta tem. Guardar o padrão em cada linha faria o env deixar
de valer no dia em que alguém o mudasse.

O motivo foi testar a plataforma com faixa longa (um set de três horas passa de 150 MB) sem abrir o
mesmo teto para todas as contas. Três decisões saíram daí:

- **O teto é de quem pede o envio**, não de quem vai ser dono da faixa: é na área de espera de quem
  pediu que o arquivo é gravado. Um lugar só responde a pergunta — `admin.Painel.TetoDeEnvio` — e a
  API (na vaga e no finalizar), as rotas do node e o worker perguntam nele.
- **Há um teto absoluto, 900 MiB**, no código (`admin.MaxTetoDeEnvio`) e não no banco: ele vem do
  disco temporário do worker, um emptyDir de 1 GiB onde o arquivo inteiro fica antes do ffprobe.
  Subir o número sem subir o volume derruba o pod.
- **Os prazos pensados para 60 MB viraram proporcionais.** A validade do PUT assinado (15 min), o
  prazo do job no worker (`INGEST_TIMEOUT_S`) e o tempo que a PWA acompanha a ingestão crescem um
  bloco a cada 60 MB. O prazo do job para em 12 minutos, abaixo dos 15 de `PrazoTravado` — acima
  disso a fila daria o job como travado e a faixa seria ingerida duas vezes ao mesmo tempo. Quem
  tem o teto padrão não vê diferença em nenhum dos três.

A assinatura do GET do áudio era de uma hora fixa e passou a ser a duração da faixa mais uma hora: o
player volta à mesma URL a cada seek, e um set de três horas parava de responder no meio.

O `PATCH /api/admin/contas/{id}` usa ponteiros, em que ausente é "não mexa"; para LIMPAR o teto o
valor é zero, que grava `NULL`.

## O que foi descartado

| Alternativa | Por que não |
|---|---|
| Área `/admin` dentro da PWA | Os dois motivos do documento 15: poder no cookie de sessão, código de admin no bundle público |
| Painel só na malha (Tailscale) | Era a minha recomendação; a escolha foi poder abrir de qualquer lugar. O custo é a tela de entrada exposta, protegida pelo token |
| Token em `localStorage` | Ao alcance de script. O cookie `HttpOnly` custa uma rota |
| `users.limite_bytes` direto, sem plano | Resolveria hoje e obrigaria a migrar no dia em que existir mais de um plano |
| Copiar a cota do plano para a conta | Mudar o plano viraria um UPDATE em massa, e as duas cópias divergiriam |
| Bloquear o envio na mesma versão que mediu | Sem ter medido, o limite seria um chute — o bloqueio veio uma versão depois |

## Custos assumidos

- **A tela de admin é pública.** Token de 256 bits, freio por IP, cookie restrito — mas é uma
  superfície que antes não existia.
- **Sem identidade de admin.** O histórico (`admin_eventos`) registra o quê, quando e de qual IP;
  não registra quem. Com um admin só, é o que há.
- **`/api/admin` continua acessível pelo host da PWA**, que é por onde a `ondasctl` fala.

## Numa entrevista

**"O que vai no ConfigMap e o que vai no banco?"** O que muda com a infraestrutura e é igual para
todos, no ConfigMap. O que é um fato sobre uma pessoa ou muda no dia a dia, no banco. O sintoma do
erro é fazer deploy para atender um usuário.

**"Como você migrou configuração para o banco sem mudar o comportamento?"** Importação única no
boot, transacional, com um marcador que é também a trava contra duas réplicas. Depois dela o env é
ignorado, e só então sai do cluster.

**"Por que um cookie se o admin já tinha um token?"** Porque o token numa aba de navegador precisa
morar em algum lugar, e todo lugar que JavaScript lê é alcançável por um XSS. O cookie `HttpOnly`,
`Strict`, restrito a `/api/admin` e assinado com uma chave que inclui a soma do token dá a mesma
credencial sem deixá-la legível.

**"Como modelar cota sem saber como vai cobrar?"** Separando o que se renova do que se acumula. Um
plano com cota e um extra por conta cobrem assinatura e compra avulsa sem a tabela saber o que é
dinheiro.
