---
title: "\"Me manda uma URL\": como fechar um proxy para a rede interna"
date: 2026-10-19
description: "A trava de SSRF roda depois do DNS, com o IP já escolhido, e vale para cada salto de redirect. Mais a fila com SKIP LOCKED, o teto que não acredita no Content-Length e um CREATE TABLE que não é atômico."
slug: "ondas-ingestao-ssrf"
draft: true
tags:
  - seguranca
  - go
  - postgres
---

A funcionalidade é simples de descrever: manda uma URL, o sistema baixa a música e guarda no acervo.
E é uma das mais perigosas que se pode construir, porque ela é literalmente *"faça uma requisição
HTTP para onde eu disser"* — executada por um processo que roda **dentro** do cluster.

`api/internal/ingest/baixar.go:16-19` nomeia o modelo de ameaça:

> Ele roda DENTRO do cluster: sem esta lista, "ingira esta URL" seria um proxy para os ClusterIPs
> (10.43/16), para o Postgres, para a malha Headscale (100.64/10) e para o servidor de metadados da
> nuvem. É SSRF clássico, e quem manda a URL é o bot.

Este documento é sobre essa trava, sobre a fila que carrega o trabalho e sobre três coisas que só se
aprendem em produção.

## A trava de SSRF: validar o nome não serve

A implementação que quase todo mundo escreve primeiro é: resolver o nome, checar se o IP é privado,
e então fazer a requisição. Ela tem um buraco com nome próprio — **DNS rebinding**. Um host que
responde um IP público na primeira consulta e um IP privado na segunda passa por qualquer validação
feita antes da conexão.

A trava do Ondas roda em outro lugar (`api/internal/ingest/baixar.go:71-76`):

> `controlar` roda DEPOIS do DNS e ANTES do connect, com o IP já escolhido. É aqui que a checagem
> tem de ficar, não só na validação do nome: um host que responde IP público na primeira consulta e
> privado na segunda (**DNS rebinding**) passaria por qualquer validação feita antes. Vale para todo
> salto de redirect, porque cada salto abre sua própria conexão.

Ela é instalada como `Control` do `net.Dialer` (`api/internal/ingest/baixar.go:130`) — um gancho que
o Go chama com o endereço já resolvido, imediatamente antes do `connect`. Não há janela entre a
checagem e o uso, porque o que é checado é o IP com que a conexão vai ser aberta.

São três camadas, e cada uma pega o que as outras não pegam:

| Camada | Onde | Pega |
|---|---|---|
| Validação da URL | `api/internal/ingest/baixar.go:89` | esquema que não é HTTP(S), credencial embutida (`user:pass@`), host ausente, IP literal privado |
| `Control` do dialer | `api/internal/ingest/baixar.go:77` | o IP de verdade, em cada conexão aberta — inclusive de cada redirect |
| `CheckRedirect` | `api/internal/ingest/baixar.go:135-142` | o destino de cada `Location`, com teto de 5 saltos |

Dois detalhes de implementação que sustentam o desenho:

**`DisableKeepAlives: true`** (`api/internal/ingest/baixar.go:133`). Sem isso, uma conexão reusada
não passaria pelo `Control` de novo. Desligar a reutilização custa um *handshake* por requisição e
garante que toda conexão é verificada.

**A política mora num campo só** (`api/internal/ingest/baixar.go:110-112`), porque *"duas cópias da
regra divergem com o tempo"*. O construtor público sempre usa a política de produção; existe um
construtor interno, não exportado, que o teste usa para liberar o loopback do servidor de teste
**sem desligar a trava** (`api/internal/ingest/baixar.go:119-122`) — o dialer continua conferindo
cada conexão, inclusive as dos redirects.

Essa última parte é um padrão de teste que vale roubar: a alternativa comum — uma flag "desligar
validação em teste" — testaria um código diferente do que roda em produção.

### As dezoito faixas, e as três que surpreendem

A lista está em `api/internal/ingest/baixar.go:20-39`, cada entrada com o comentário do que ela
protege. As óbvias são loopback, as três faixas privadas, link-local (que inclui `169.254.169.254`,
o servidor de metadados de nuvem), multicast e reservadas. Há também `100.64/10` — CGNAT, onde vive
a malha privada do homelab.

As três que raramente aparecem em listas caseiras:

| Faixa | O que é |
|---|---|
| `64:ff9b::/96` | NAT64 — um caminho para IPv4 privado por via indireta |
| `2002::/16` | 6to4 |
| `2001::/32` | Teredo |

São mecanismos de transição IPv6→IPv4. Uma lista que bloqueia só privados v4 e loopback v6 deixa
esses três abertos, e por eles se alcança `10.0.0.0/8` de novo. É o tipo de lacuna que não aparece
em teste funcional nenhum.

A lista é parseada no carregamento do pacote e **entra em panic** com CIDR inválido
(`api/internal/ingest/baixar.go:41-51`): erro de digitação na lista não chega a produção em
silêncio.

### O teto de bytes não acredita no `Content-Length`

```go
io.Copy(destino, io.LimitReader(resp.Body, b.maxBytes+1))
```

Um byte além do limite: se vier, o arquivo é grande demais
(`api/internal/ingest/baixar.go:171-179`). Confiar no `Content-Length` não serve — ele pode mentir
ou faltar.

O `+1` é o detalhe que faz a diferença entre "truncou e não avisou" e "recusou".

### O ffprobe é quem decide o que o arquivo é

O `Content-Type` da origem serve de pista e nada mais (`api/internal/ingest/baixar.go:147-149`).
Quem decide é o `ffprobe` (`api/internal/ingest/midia.go:76`), e a régua de aceitação não é "o que o
ffmpeg sabe ler": são os oito codecs que **a tag `<audio>` toca em navegador atual**
(`api/internal/ingest/midia.go:20-22`).

Aceitar um `.wma` seria guardar um arquivo que a PWA nunca conseguiria tocar. É uma validação de
produto disfarçada de validação técnica — e por isso a lista é curta e enumerada à mão.

## A fila: um índice parcial e um `SKIP LOCKED`

Baixar uma URL arbitrária não cabe no `ReadTimeout` de 15 s do servidor HTTP
(`api/internal/db/migrations/0002_acervo.sql:24-26`), então a ingestão é assíncrona. A fila é uma
tabela no Postgres, sem broker.

### Deduplicação por índice parcial

```sql
CREATE UNIQUE INDEX ingest_jobs_ativo_idx ON ingest_jobs (user_id, source_url)
    WHERE status IN ('pending','processing')
```

O comentário diz o problema real (`api/internal/db/migrations/0002_acervo.sql:48-50`): *"Mesma URL
pedida duas vezes enquanto a primeira não terminou é a MESMA ingestão, não duas: o bot reenvia
quando o usuário toca no botão de novo ou quando o Telegram repete a entrega."*

O detalhe bonito é que o índice é **parcial**. Unicidade só vale enquanto o job está ativo — o que
significa que a mesma URL pode ser reingerida depois que terminou, sem precisar apagar nada.
Unicidade incondicional proibiria reingerir para sempre.

O enfileiramento explora isso (`api/internal/acervo/jobs.go:114-115`):

```sql
INSERT INTO ingest_jobs (...)
VALUES (...)
ON CONFLICT (user_id, source_url) WHERE status IN ('pending','processing')
DO NOTHING
RETURNING ...
```

`DO NOTHING` com `RETURNING` **não devolve linha** quando há conflito. O código lê a ausência de
linha como "já existia", busca o job ativo e devolve `novo=false` — e o handler usa isso para
escolher **202** (aceitei algo novo) ou **200** (nada novo; o pedido anterior continua)
(`api/internal/httpapi/acervo.go:274-279`).

Há uma fragilidade assumida aqui: o predicado do `ON CONFLICT` é escrito à mão e tem de casar
**literalmente** com o do índice. Divergir não dá erro de compilação; dá duplicação silenciosa.

### Reivindicar sem dois workers pegarem o mesmo

```sql
UPDATE ingest_jobs SET status='processing', attempts=attempts+1, updated_at=now()
WHERE id = (
    SELECT id FROM ingest_jobs
    WHERE (status='pending' AND attempts < $1)
       OR (status='processing' AND updated_at < now() - $2::interval AND attempts < $1)
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
RETURNING ...
```

`FOR UPDATE SKIP LOCKED` (`api/internal/acervo/jobs.go:144-149`) é o padrão de fila em Postgres:
dois workers nunca pegam o mesmo job, e nenhum deles **espera** o outro. Sem o `SKIP LOCKED`, o
segundo worker bloquearia na linha travada; com ele, ele simplesmente pega a próxima.

A segunda cláusula do `WHERE` é a parte que eu teria esquecido: ela resgata job preso em
`processing` por mais de 15 minutos — worker que morreu no meio. Sem isso, um `OOMKill` no momento
errado deixa um job em `processing` para sempre, invisível para a fila e nunca concluído.

O retry é todo no SQL. `Falhar` (`api/internal/acervo/jobs.go:178-180`) devolve o job para `pending`
enquanto houver tentativa sobrando e o encerra como `error` na última — senão o worker repetiria
para sempre uma URL que não existe mais. São três tentativas, e o número tem justificativa empírica
(`api/internal/acervo/jobs.go:18-20`): as falhas que se repetem aqui são quase sempre permanentes
(URL morta, formato que não toca); as temporárias costumam passar na segunda.

Polling de 5 segundos, não `LISTEN/NOTIFY`. Para uma fila que recebe alguns itens por dia, o custo
de uma consulta a cada 5 s é menor que o de manter uma conexão de notificação viva e reconectá-la.

## Três coisas que só se aprendem em produção

### 1. `CREATE TABLE IF NOT EXISTS` não é atômico

`api/internal/db/pool.go:47-56`:

> Tudo corre sob um advisory lock porque dois pods sobem juntos em qualquer rollout (maxSurge)
> — e `CREATE TABLE IF NOT EXISTS` NÃO é atômico no Postgres: as duas sessões passam pela
> checagem de existência e uma estoura com duplicate key em pg_type. Foi exatamente o que
> derrubou o primeiro boot desta API em produção.

A correção tem três partes que merecem atenção (`api/internal/db/pool.go:57`):

- **Uma conexão só, do começo ao fim.**`pool.Acquire` em vez de usar o pool
(`api/internal/db/pool.go:61-67`): o advisory lock é de sessão, então precisa ser a mesma conexão
que o pega, usa e devolve.
- **Desbloqueio sob `context.WithoutCancel`** (`api/internal/db/pool.go:72-80`): *"Sem unlock
explícito o lock viaja com a conexão de volta para o pool e tranca o próximo boot. WithoutCancel
porque o unlock precisa sair mesmo quando é o próprio prazo acima que venceu."*
- **Uma transação por migração**, contendo o SQL e o registro em `schema_migrations`.

A lição que ficou: **idempotente e seguro para concorrência não são a mesma propriedade.** Cada
migração era idempotente, e isso não bastou.

### 2. `WithoutCancel` outra vez, por outro motivo

`api/internal/worker/worker.go:95-99`:

> **WithoutCancel de propósito**: o SIGTERM do rollout não deve abortar uma ingestão em curso — ela
> gastaria uma tentativa por um deploy. O laço acima é que para de pegar job novo […] O prazo por
> job continua, para que uma origem lenta não prenda o worker para sempre.

O padrão é: o laço externo respeita o cancelamento e para de pegar trabalho; o job em andamento tem
prazo próprio e termina. Um `ctx` propagado ingenuamente faria todo deploy consumir uma tentativa de
cada job em curso.

Vale notar a consequência honesta disso: se o prazo do job vencer, a marcação da falha também pode
falhar, e o job fica em `processing`. Quem o resgata é o timeout de 15 minutos da fila. As duas
decisões se apoiam uma na outra.

### 3. Um `map[string]string` que quebrou o decode inteiro

Em `api/internal/audius/audius.go:58-63`:

> Campos nomeados, e não um mapa de strings: `artwork` também traz `mirrors`, que é um ARRAY. Com
> `map[string]string` o decode INTEIRO falha nele e a faixa vira cartão genérico — foi o que
> aconteceu no primeiro deploy disto. **O TypeScript ignorava calado porque não valida em tempo de
> execução.**

Esse é o achado mais transferível do projeto. O mesmo JSON era consumido há semanas pelo frontend
sem problema, porque um `interface` de TypeScript é apagado no build e ninguém valida nada. Ao
portar o consumo para Go, o campo inesperado virou erro de decodificação — e o sintoma foi "a prévia
de link parou de funcionar", longe da causa.

Go não é mais exigente por capricho: ele está mostrando um problema que já existia e era invisível.

## Capas e picos são melhor esforço, de propósito

Duas etapas da ingestão podem falhar sem reprovar o trabalho. Picos
(`api/internal/worker/worker.go:187-193`):

```go
picos, err := ingest.Picos(ctx, bruto, midia.DuracaoS)
if err != nil {
    log.Warn("forma de onda não medida", "erro", err)
    picos = ""
}
```

O raciocínio: faixa sem forma de onda desenha barra lisa, e isso não é motivo para reprovar uma
ingestão que já subiu o áudio. Mesma coisa para capa — cada passo (extrair, medir, enviar) falha com
aviso no log e deixa a chave vazia (`api/internal/worker/worker.go:301`).

A diferença entre melhor esforço e falha é uma pergunta de produto: *sem isto, o usuário ainda tem o
que ele pediu?* Para capa e forma de onda, sim — ele tem a música. Para o arquivo de áudio, não.

E existe uma dívida que isso gerou: faixas ingeridas antes de a medição existir ficaram sem picos. A
correção foi um subcomando de backfill, `worker repicos`, em vez de reingerir — reingerir daria um
UUID novo, matando os links já compartilhados e subindo de novo um arquivo que já está no bucket. O
backfill muda **uma coluna de 200 bytes**, e o `UPDATE` repete a condição da listagem
(`api/cmd/worker/repicos.go:64-71`) para nunca passar por cima de uma medição mais recente que a
dele.

## A mensagem de erro tem política

`api/internal/worker/worker.go:121-125`:

> Erro de destino vetado aparece inteiro de propósito: é a resposta para "por que minha URL interna
> não funciona". Já erro de rede cru pode carregar endereço e porta, então vira texto genérico.

| Erro | O que o dono lê |
|---|---|
| destino vetado | "endereço de destino não é público — só URLs da internet" |
| arquivo grande demais | a mensagem com o limite |
| formato que não toca | a mensagem com o codec |
| origem demorou | "a origem demorou demais" |
| **qualquer outro** | "não foi possível ingerir esta mídia" |

O default é o genérico, e isso é a escolha certa: a lista enumera o que **pode** ser dito, em vez de
tentar enumerar o que não pode. Dois testes travam as duas pontas:
`TestErroDeDestinoVetadoChegaLegivelAoDono` e `TestErroCruNaoVazaDetalheNaMensagem`.

## O que foi descartado

| Opção | Por que não |
|---|---|
| Validar só o nome do host | DNS rebinding: o nome resolve diferente na segunda consulta |
| Checar o IP antes de conectar, no código do chamador | Existe janela entre checar e usar; o gancho do dialer não tem |
| Bloquear só privados v4 e loopback v6 | NAT64, 6to4 e Teredo alcançam a rede privada por via indireta |
| Reaproveitar conexão (keep-alive) | Conexão reusada não passaria pelo `Control` de novo |
| Flag "desligar validação em teste" | Testaria código diferente do de produção; o teste afrouxa só a política e mantém a trava |
| Confiar no `Content-Length` | Pode mentir ou faltar; o teto é medido nos bytes que chegam |
| Decidir formato pelo `Content-Type` | Quem decide o que o arquivo é tem de ser o `ffprobe` |
| Broker de fila | Uma tabela com índice parcial e `SKIP LOCKED` resolve, sem um serviço a mais |
| Unicidade incondicional em `(user_id, source_url)` | Proibiria reingerir a mesma URL depois que terminou |
| Migração em initContainer | Um segundo artefato a manter; embutida no binário não há |
| Propagar o cancelamento do SIGTERM para o job | Todo deploy gastaria uma tentativa de cada job em curso |
| Reingerir para corrigir a forma de onda | UUID novo mata os links compartilhados e sobe de novo um arquivo que já está lá |

## O que isso custou

**A lista de faixas vetadas envelhece.** Mecanismo de transição novo, faixa reservada nova, e a
lista precisa de manutenção. Ela é explícita e comentada justamente para que a revisão seja
possível.

**`DisableKeepAlives` custa um handshake por requisição.** Para uma ingestão por vez, é irrelevante;
num sistema de alto volume, seria uma conversa.

**O predicado do `ON CONFLICT` duplica o do índice.** Divergir não quebra o build — produz
duplicação silenciosa.

**Polling de 5 segundos é latência garantida.** Uma ingestão espera em média 2,5 s para começar.
Para este caso de uso, trocar isso por `LISTEN/NOTIFY` seria complexidade sem ganho perceptível.

**Melhor esforço gera dívida de dados.** A forma de onda ausente em faixas antigas precisou de um
subcomando de backfill. A decisão de não reprovar a ingestão foi certa; o custo foi um comando a
mais para operar.

## Numa entrevista

**"Você tem um endpoint que baixa uma URL que o usuário manda. Como fecha o SSRF?"** A checagem vai
no `Control` do dialer, que o Go chama **depois do DNS e antes do connect**, com o IP já escolhido.
Validar o nome não serve: um host pode responder IP público na primeira consulta e privado na
segunda, que é DNS rebinding. E, porque cada salto de redirect abre a própria conexão, a trava vale
para todos — com keep-alive desligado, para nenhuma conexão reusada escapar do gancho.

**"Que faixas você bloqueia?"** As óbvias — loopback, as três privadas, link-local com o metadata em
`169.254.169.254`, multicast, reservadas — mais a faixa CGNAT da malha privada. E três que costumam
faltar: NAT64, 6to4 e Teredo. São caminhos de transição IPv6 para IPv4; uma lista que só bloqueia
privados v4 deixa a rede interna acessível por eles.

**"Como você limita o tamanho do download?"** Com `LimitReader` de `max+1` e verificando se o byte
extra veio. Não confio no `Content-Length` — ele pode mentir ou simplesmente faltar. O `+1` é o que
separa "truncou em silêncio" de "recusou".

**"Como é sua fila?"** Uma tabela no Postgres, sem broker. Deduplicação por índice **parcial** único
em `(user_id, source_url)` restrito aos status ativos — então o mesmo pedido repetido devolve 200 em
vez de criar um segundo job, e a URL pode ser reingerida depois que terminou. A reivindicação é um
`UPDATE` com subquery usando `FOR UPDATE SKIP LOCKED`, que também resgata job preso em `processing`
há mais de quinze minutos: worker que morreu no meio.

**"Qual o pior bug que você teve em produção?"** A migração no start do processo. Funcionou no
primeiro deploy e quebrou no primeiro rollout: dois pods subiram juntos e
`CREATE TABLE IF NOT EXISTS` não é atômico no Postgres — as duas sessões passam pela checagem de
existência e uma estoura com chave duplicada em `pg_type`. A correção foi um advisory lock em volta
de toda a sequência, numa conexão única tomada do pool, com desbloqueio sob contexto que não
cancela. A lição é que idempotência não é segurança sob concorrência.

**"Me conta um bug de tipagem que te surpreendeu."** Ao portar o consumo de uma API pública de
TypeScript para Go, eu modelei um objeto como `map[string]string`. O objeto tinha um campo extra que
era um array, e isso faz o decode **inteiro** falhar em Go. O mesmo JSON era consumido há semanas
pelo frontend sem nenhum problema, porque `interface` de TypeScript é apagada no build e não valida
nada em runtime. Go não estava sendo chato — estava mostrando um problema que já existia e era
invisível.

**"Como você decide o que é erro fatal e o que é melhor esforço?"** Perguntando se, sem aquilo, o
usuário ainda tem o que pediu. Capa e forma de onda são melhor esforço: ele tem a música. O arquivo
de áudio não é. E eu registro a falha no log, porque melhor esforço silencioso vira dívida de dados
— foi o que aconteceu, e precisei de um comando de backfill para corrigir faixas antigas sem
reingerir, que daria um id novo e mataria os links já compartilhados.
