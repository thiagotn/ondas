---
title: "Por que o cookie de sessão do Ondas não é um JWT"
date: 2026-10-19
description: "Uma tag <audio> não manda header. Dessa restrição saem o cookie assinado com HMAC, os parâmetros do argon2id que ditam a memória do pod e três camadas de autorização no roteador."
slug: "ondas-sessao-sem-jwt"
draft: true
tags:
  - seguranca
  - go
  - arquitetura
---

Quase toda API que eu escrevi antes autenticava por `Authorization: Bearer <token>`. Esta não — e a
razão não é preferência, é uma restrição do navegador que elimina a opção antes de qualquer debate
sobre JWT contra sessão.

Este documento é o caminho dessa restrição até o resto: o formato do cookie, a ordem em que ele é
verificado, os parâmetros do argon2id e por que eles decidem quanta memória o pod precisa, os dois
oráculos que o login fecha e as três camadas de autorização do roteador.

## O problema: o áudio é carregado por uma tag, não por `fetch`

O acervo é privado. Cada faixa é um objeto num bucket sem domínio público, e a PWA toca a faixa
assim:

```html
<audio src="/api/acervo/<id>/audio">
```

É aqui que o esquema de token em header morre. `<audio>` não aceita cabeçalhos: o elemento faz o
pedido sozinho, e nada em JavaScript consegue anexar um `Authorization` naquela requisição. O mesmo
vale para `<img>` nas capas. Se a sessão vivesse num header, o catálogo autenticaria bem e **nenhuma
faixa tocaria** — e descobrir isso só aconteceria quando alguém apertasse play.

Um cookie, ao contrário, vai sozinho em qualquer subrecurso de mesma origem, incluindo o que uma tag
busca. Isso decide duas coisas de uma vez:

1. **A sessão é um cookie.**
2. **A API tem de ser servida na mesma origem da PWA** — o que ela é, num path a mais do Ingress
(`/api`), o que também dispensa CORS e preflight (`api/internal/httpapi/server.go:66-67`).

A partir daí, a pergunta "JWT ou sessão?" vira outra: o que é melhor **dentro** de um cookie?

## A decisão: cookie opaco assinado com HMAC-SHA256

`api/internal/auth/session.go:14-18` é a decisão inteira em quatro linhas de comentário:

> Cookie opaco assinado com HMAC-SHA256 em vez de JWT: quem valida o token é a mesma API que o
> emitiu, então não há motivo para carregar uma biblioteca e a superfície de erro de JWT (alg=none,
> confusão de chave, kid).

O argumento é de escopo. JWT resolve um problema que o Ondas não tem: **verificação por terceiros**.
Ele existe para que um serviço valide um token que outro serviço emitiu, e por isso carrega
negociação de algoritmo, identificação de chave e um cabeçalho que o próprio atacante controla —
donde a família de falhas `alg: none`, confusão entre HMAC e RSA, e `kid` apontando para onde não
devia. Aqui o emissor e o verificador são o mesmo processo, lendo a mesma variável de ambiente. Não
há nada a negociar, então não há nada que possa ser negociado para baixo.

O formato é este:

```
v1.<base64url(userID + "." + expiraUnix)>.<base64url(HMAC-SHA256(segredo, "v1." + corpo))>
```

Três detalhes de implementação que valem mais que o formato:

**A versão entra no MAC.**`mac()` assina `"v1." + corpo`, não o corpo nu
(`api/internal/auth/session.go:73-77`). Se um dia existir um `v2` com outro conteúdo, nenhum MAC de
`v1` pode ser reaproveitado nele. Assinar só o corpo seria o erro clássico de confusão de contexto.

**A ordem da verificação é deliberada**, e o comentário em `api/internal/auth/session.go:42-43` diz
por quê: *"confere a assinatura antes de olhar a expiração, para não vazar nada sobre um cookie
forjado"*. Um cookie inventado por um atacante recebe `ErrSessaoInvalida` sem que a API jamais tenha
interpretado o que estava escrito dentro dele. Um cookie legítimo mas vencido recebe
`ErrSessaoExpirada`. Só a assinatura decide qual dos dois caminhos é tomado.

```go
if !hmac.Equal([]byte(partes[2]), []byte(s.mac(partes[1]))) {
    return "", ErrSessaoInvalida
}
```

`hmac.Equal` e não `==`: comparação em tempo constante, pela mesma razão que aparece em outros três
lugares deste código.

**O corte do corpo usa `LastIndex`, não `Split`** (`api/internal/auth/session.go:56`). O corpo é
`<userID>.<expira>`, e se um dia um id contiver ponto, `Split` quebraria o parse em silêncio.
`LastIndex` com a guarda `corte < 1` lê sempre o último separador.

O relógio é injetável (`api/internal/auth/session.go:29`), o que permite testar expiração sem dormir
no teste.

### As flags do cookie

Em `api/internal/httpapi/server.go:224-237`:

| Flag | Valor | Por quê |
|---|---|---|
| `HttpOnly` | `true` | Tira o token do alcance de qualquer script, inclusive de um XSS |
| `Secure` | `true`, exceto em dev | Em `http://localhost` o navegador descartaria o cookie |
| `SameSite` | `Lax` | Basta, porque a PWA e a API dividem a origem |
| `MaxAge` | 30 dias | A PWA é instalada e não deve pedir login toda semana |
| `Path` | `/` | O cookie precisa acompanhar `/api/...` e a navegação |

`HttpOnly` tem uma consequência que o cliente documenta de volta, em
`packages/core/src/auth/http.ts:27-30`: o código do frontend **não consegue ler** a sessão. O que
fica no armazenamento local é apenas o nome do usuário, para a tela não piscar entre o boot e a
resposta do `/me`. A fonte da verdade é o cookie que nenhum script alcança.

## A senha: argon2id, e o limite de memória que ela dita

`api/internal/auth/password.go:15-24`:

```go
const (
	argonTime    = 1          // 1 passada
	argonMemory  = 64 * 1024  // 64 MiB
	argonThreads = 4
	argonKeyLen  = 32
	saltLen      = 16
)
```

É o perfil de segundo plano da RFC 9106, e custa ~50 ms por verificação. Esse é o ponto: 50 ms é
irrelevante para quem sabe a senha e ruinoso para quem está adivinhando.

Mas o número que importa operacionalmente é o **64 MiB**. Argon2 é memory-hard de propósito: cada
verificação aloca 64 MiB. Isso significa que o processo precisa de folga de memória suficiente para
um login — e é a função de hash de senha, não o volume de tráfego, que dimensiona o limite de
memória do contêiner. Apertar esse limite não faz o pod ficar lento: faz o pod **morrer no primeiro
login**, que é um modo de falha bem mais difícil de diagnosticar do que parece.

O hash é guardado em formato PHC, com os parâmetros embutidos:

```
$argon2id$v=19$m=65536,t=1,p=4$<salt>$<hash>
```

`api/internal/auth/password.go:28-30` explica a escolha: assim o custo pode ser endurecido depois
**sem invalidar os hashes antigos**, porque `VerifyPassword` lê os parâmetros do próprio hash em vez
das constantes. Uma senha gravada hoje com 64 MiB continua verificando amanhã, mesmo que o padrão
novo seja 128.

### A guarda que existe por causa de um panic

O trecho mais fácil de deixar passar está em `api/internal/auth/password.go:69-76`:

```go
// `argon2.IDKey` entra em panic com parâmetro zerado (keyLen 0, p=0, m
// abaixo de 8*p). Hash truncado ou adulterado chega exatamente assim, e um
// panic no handler de login seria um jeito trivial de derrubar a API.
if len(salt) == 0 || len(esperado) == 0 || tempo == 0 || threads == 0 || mem < 8*uint32(threads) {
    return false
}
```

Um hash corrompido no banco — truncado por um `varchar` curto demais, cortado por uma migração mal
feita, ou simplesmente escrito errado — produz parâmetros zerados no parse. `argon2.IDKey` entra em
panic com eles. Sem essa guarda, uma linha ruim na tabela `users` transforma cada tentativa de login
daquela conta em um panic no handler. O `Recoverer` do chi devolveria 500 em vez de derrubar o
processo, mas o efeito prático seria um login permanentemente quebrado sem nenhuma mensagem útil.

Hash malformado é tratado como senha errada, nunca como erro distinto
(`api/internal/auth/password.go:45-47`) — pelo mesmo motivo da próxima seção.

## Dois oráculos fechados

Um endpoint de login conta coisas sem querer. O Ondas fecha duas vias.

**Mesma resposta para e-mail inexistente e senha errada.** Os dois casos devolvem
`ErrSenhaInvalida`. Sem isso, qualquer pessoa enumera quais e-mails têm conta.

**Mesmo tempo de resposta para os dois.** Essa é a parte que quase sempre fica de fora. Se o e-mail
não existe, não há hash para verificar, a resposta sai em microssegundos, e a diferença de latência
reabre o oráculo que a mensagem única acabou de fechar. `api/internal/auth/users.go:78-84`:

```go
if errors.Is(err, pgx.ErrNoRows) {
    // Gasta o mesmo tempo de um hash real, senão a diferença de latência
    // entrega quais e-mails existem.
    _ = VerifyPassword("$argon2id$v=19$m=65536,t=1,p=4$"+
        "c2FsdHNhbHRzYWx0c2E$Y2FmZWNhZmVjYWZlY2FmZWNhZmVjYWZlY2FmZWNhZmU", senha)
    return nil, ErrSenhaInvalida
}
```

Um hash de mentira, com parâmetros realistas, verificado contra a senha que o atacante mandou. O
resultado é descartado; o que interessa são os 50 ms gastos.

A conta também nunca expõe o e-mail: `type User` serializa apenas `name`, com `ID` e `Email`
marcados `json:"-"` (`api/internal/auth/users.go:27-32`).

## O freio de login mora na aplicação, não no proxy

Limite: 8 tentativas por 5 minutos, depois 429. O interessante é **onde** ele mora, e
`api/internal/auth/ratelimit.go:8-17` registra o porquê:

> Mora aqui e não no Traefik porque o Traefik do cluster não enxerga o IP real (o hostPort mascara a
> origem), então o rate-limit dele vale para o host inteiro.

É um caso em que a arquitetura de rede decide o desenho da aplicação. O proxy do cluster recebe
todas as conexões por um `hostPort`, e o `RemoteAddr` que ele vê é sempre interno — um rate-limit
ali limitaria a soma de todo mundo, não cada cliente. Como o único caminho de entrada é um túnel da
Cloudflare, o header `CF-Connecting-IP` é confiável o bastante para a contagem, e
`api/internal/httpapi/middleware.go:30` o lê em cascata: `CF-Connecting-IP`, depois o primeiro
elemento de `X-Forwarded-For`, depois `RemoteAddr`.

O algoritmo é janela deslizante por marcas de tempo, não token bucket
(`api/internal/auth/ratelimit.go:32`):

```go
recentes := l.recentes(chave, agora)
if len(recentes) >= l.max {
    l.tentou[chave] = recentes
    return false
}
l.tentou[chave] = append(recentes, agora)
return true
```

Dois detalhes: a tentativa **bloqueada não é registrada**, então martelar o endpoint não estende o
próprio bloqueio indefinidamente; e `recentes` filtra reusando o array (`l.tentou[chave][:0]`), sem
alocar no caminho quente. A limpeza do mapa é amortizada — só varre quando passou uma janela inteira
desde a última vez (`api/internal/auth/ratelimit.go:66-76`) — porque sem ela o mapa cresceria para
sempre com IPs que nunca voltam.

A limitação está assumida por escrito no mesmo comentário: o contador é em memória, então um restart
do pod zera os bloqueios. Para um punhado de contas é aceitável; o lugar certo, se virar problema, é
o Postgres. Vale mais ter isso escrito do que ter um Redis a mais para operar.

## Cadastro fechado por padrão

`api/internal/config/config.go:86-96`. `SIGNUP_OPEN` é `false` por default e a allowlist nasce
**vazia** — a configuração de partida não permite nenhum cadastro. O handler responde 403 antes de
tocar o banco (`api/internal/httpapi/server.go:165-168`), e a comparação é feita em minúsculas nos
dois lados, com entradas vazias descartadas (o que protege de um `"a@b.c,"` que liberaria tudo).

A unicidade do e-mail é um índice funcional, não uma constraint direta:
`CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email))`
(`api/internal/db/migrations/0001_init.sql`). Ninguém cadastra `Thiago@` e `thiago@` como contas
diferentes. O custo dessa escolha é um acoplamento feio: a detecção de duplicata compara o nome do
índice dentro da string do erro do Postgres (`api/internal/auth/users.go:60`).

## Três camadas de autorização no roteador

A API tem um segundo sujeito autenticável além do usuário: um **token de máquina**, usado por um bot
que enfileira ingestões. Isso cria uma pergunta que não existe quando só há sessão: *o que o token
pode fazer?*

A resposta está na forma do roteador, e não num campo de permissão.
`api/internal/httpapi/server.go:90-94`:

> O corte entre os dois grupos abaixo é **entrar com faixa nova** vs. **mexer no acervo que já
> existe**. Não é um detalhe de arrumação: é onde mora o teto do token de máquina.

| Camada | Alcance | Rotas |
|---|---|---|
| Pública | sem credencial | `healthz`, `readyz`, `og/t/{seg}`, `signup`, `login`, `logout` |
| Sessão **ou** token | entrar com faixa nova | `POST ingest`, `GET ingest/{id}`, `POST upload`, `POST upload/{id}/finalizar` |
| Só sessão | mexer no que já existe | `GET /acervo/`, `GET {id}/audio`, `GET {id}/art`, `DELETE {id}` |
| Só sessão | mexer na própria conta | `GET /auth/me`, `PATCH /auth/prefs` |

A última linha é a mesma régua aplicada a um caso novo. `PATCH /auth/prefs` liga e desliga o
catálogo público da conta (`users.publico`), e o token de máquina **não** a alcança: ele existe para
entrar com faixa nova, e mudar o que alguém vê não é isso. A garantia é geométrica como as outras —
`exigirSessao` nem lê o header do token —, e `TestPrefsExigeSessaoENaoAceitaToken` a fixa, pelo
mesmo motivo que `TestEscopoDoTokenNoAcervo` existe.

O corpo é `{"publico": bool}` lido num **ponteiro**: com um `bool`, um corpo sem a chave
decodificaria para `false` e desligaria o catálogo de quem só mandou um JSON errado. Ausente é 400.
E o campo sai em **toda** resposta de auth — `signup`, `login` e `me` —, porque é no boot que a PWA
decide a fonte do catálogo, antes de qualquer outra chamada.

E `api/internal/httpapi/server.go:122-127` nomeia o modelo de ameaça:

> É aqui que um token vazado viraria exfiltração (listar, baixar) ou destruição (apagar), e não em
> criar um objeto na própria área de espera. `TestEscopoDoTokenNoAcervo` trava esta divisão: mover
> uma rota de grupo sem querer compila, e só o teste denuncia.

Esse último detalhe é o que torna a decisão durável. A divisão é geométrica — duas chamadas
`r.Group` num arquivo —, e mover uma rota de uma para a outra é uma mudança de indentação que
compila, passa na revisão e não aparece em diff nenhum como "mudança de segurança". O teste é a
única coisa que reclama.

O token em si é guardado como SHA-256 do valor real, nunca em claro
(`api/internal/config/config.go:52-54`): a API só precisa **verificar**, então o segredo original
não precisa existir no cluster. A comparação é `subtle.ConstantTimeCompare`
(`api/internal/httpapi/acervo.go:138`), com o comentário certo ao lado: com `==`, o tempo de
resposta entrega o prefixo correto byte a byte.

## O que foi descartado

| Opção | Por que não |
|---|---|
| JWT no cookie | Resolve verificação por terceiros, que aqui não existe; traz `alg=none`, confusão de chave e `kid` de graça |
| Token em `Authorization: Bearer` | `<audio>` e `<img>` não mandam header; o catálogo autenticaria e nenhuma faixa tocaria |
| Sessão em tabela no Postgres | Uma consulta por requisição para resolver o que o HMAC resolve sem I/O; o custo só se paga quando é preciso revogar uma sessão específica, e aqui o botão de pânico é trocar o segredo |
| bcrypt | Não é memory-hard; argon2id é a recomendação atual e o custo em memória cabe no envelope |
| Rate-limit no proxy | O proxy não enxerga o IP real; o limite valeria para o host inteiro |
| Redis para o rate-limit | Um serviço a mais para operar; a limitação de contador em memória está assumida por escrito |
| Campo de permissão para o token de máquina | A divisão por grupo de rota é mais difícil de afrouxar sem querer, e tem um teste que a trava |

## O que isso custou

**Não há revogação de sessão individual.** O cookie é autocontido, então o único jeito de invalidar
uma sessão específica seria uma lista de bloqueio — isto é, exatamente o estado no servidor que a
decisão evitou. O que existe é o botão de pânico: trocar `SESSION_SECRET` invalida **todas** as
sessões de uma vez (`api/internal/config/config.go:18-20`). Para um sistema de um dono, é a troca
certa; para um produto multiusuário, seria inaceitável.

**O rate-limit zera no deploy.** Um rollout reinicia o contador. Com janela de 5 minutos e um app
que faz rollout raramente, é uma brecha estreita — mas é uma brecha.

**O argon2id amarra a configuração de memória.** Quem mexer no envelope do contêiner sem saber disso
descobre pelo pod morrendo no login, não por lentidão.

**O acoplamento ao nome do índice** (`users_email_lower_idx` dentro de uma comparação de string) é
frágil. Renomear o índice numa migração futura quebra a detecção de e-mail duplicado, e o sintoma
seria um 500 no cadastro em vez de uma mensagem.

## Numa entrevista

**"Por que não JWT?"** Porque JWT resolve verificação por terceiros, e aqui o emissor e o
verificador são o mesmo processo lendo a mesma variável de ambiente. Não há nada a negociar, então
não vale carregar a superfície de erro da negociação — `alg=none`, confusão de chave, `kid`. O
cookie é opaco, assinado com HMAC-SHA256, e a versão do formato entra no MAC para que nenhuma
assinatura de `v1` seja reaproveitável num `v2`.

**"Por que cookie e não um token em header?"** Essa não foi uma escolha, foi uma restrição. A faixa
é carregada por `<audio src="/api/.../audio">`, e uma tag não aceita cabeçalho. Com a sessão num
header, o catálogo autenticaria normalmente e nenhuma faixa tocaria. O cookie vai sozinho em
qualquer subrecurso de mesma origem — e é por isso que a API também **tem** de estar na mesma origem
da PWA.

**"Como você protege contra enumeração de usuários?"** Em duas frentes. A mensagem é a mesma para
e-mail inexistente e senha errada; e, quando o e-mail não existe, o código verifica um hash de
mentira com parâmetros realistas só para gastar os mesmos 50 ms. Sem a segunda parte, a diferença de
latência reabriria o oráculo que a primeira fechou.

**"Por que o rate-limit está na aplicação e não no ingress?"** Porque o proxy do cluster não vê o IP
real do cliente — todas as conexões chegam por um `hostPort` e o endereço de origem é sempre
interno. Um limite ali valeria para a soma de todo mundo. Como o único caminho de entrada é um túnel
da Cloudflare, eu conto por `CF-Connecting-IP` dentro da API.

**"Você tem um token de máquina. Como garante que ele não faz o que não deve?"** Pela forma do
roteador, não por um campo de permissão. Há dois grupos: "entrar com faixa nova" aceita sessão ou
token; "mexer no acervo que já existe" — listar, baixar, apagar — aceita só sessão. Um token vazado
consegue criar objeto na própria área de espera e não consegue exfiltrar nem destruir nada. E como
mover uma rota entre os dois grupos é uma mudança de indentação que compila, existe um teste
dedicado a travar a divisão.

**"Qual o maior risco que você aceitou aqui?"** Não ter revogação de sessão individual. O cookie é
autocontido; para invalidar uma sessão específica eu precisaria de uma lista de bloqueio, que é
exatamente o estado no servidor que eu evitei. O que tenho é trocar o segredo, que derruba todas as
sessões ao mesmo tempo. Para um sistema de um dono, é a troca certa — para um produto com usuários
de verdade, não seria.
