---
title: "Abrir o cadastro sem abrir a porta"
date: 2026-11-13
description: "O cadastro do ondas era um booleano: fechado, ou aberto para qualquer um. Abrir a plataforma para quem quer experimentar pediu um estado no meio — o pedido em análise —, um admin que não é um usuário e uma CLI que passa pela mesma API que todo mundo."
slug: "ondas-cadastro-e-administracao"
draft: true
tags:
  - autenticacao
  - autorizacao
  - cli
---

Até a 1.5 o cadastro do ondas tinha dois estados, e os dois eram ruins para o que eu queria fazer.
Com `SIGNUP_OPEN=false`, só entrava quem eu pusesse à mão numa allowlist do ConfigMap — um deploy
por pessoa. Com `SIGNUP_OPEN=true`, qualquer um criava conta e **saía logado**, com direito a enviar
arquivo para um bucket que eu pago.

O que eu queria era o meio: deixar interessados pedirem uma conta, olhar o pedido, e decidir. E que
a conta aprovada usasse a plataforma para dar feedback — sem ainda enviar arquivo, porque o formato
comercial do envio não está decidido.

## O pedido é a conta

A primeira forma que aparece é uma tabela `signup_requests`: o pedido entra nela, e aprovar copia a
linha para `users`. Descartei por causa de um campo — a senha. Quem pede conta escolhe a senha na
hora; com duas tabelas o hash teria de morar no pedido e ser copiado na aprovação, e por um tempo
existiriam dois lugares com credencial, um deles sem nenhuma das proteções que `users` já tem (o
índice único por `lower(email)`, o `ON DELETE CASCADE` das outras tabelas).

Então o pedido **é** a conta, num estado em que ela não entra (migração `0011`):

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'aprovada';
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pendente';
```

As duas linhas, nessa ordem, são a migração inteira. A primeira grava `aprovada` em toda conta que
já existia; a segunda troca o padrão para o que vale dali em diante. Com o padrão final direto, o
deploy trancaria todo mundo para fora — eu inclusive, e sem admin para me aprovar. Há um teste que
refaz exatamente esse dia: derruba as colunas, insere uma conta "antiga", roda o arquivo e confere
os dois lados.

O padrão da coluna é o estado **mais fechado** de propósito. Um `INSERT` que esqueça o campo cria
uma conta que não entra, e não uma que entra sem ninguém ter decidido.

## Duas perguntas, duas colunas

"Pode entrar?" e "pode enviar arquivo?" são perguntas diferentes, e a tentação é respondê-las com
um status só (`pendente`, `aprovada`, `aprovada_com_envio`…). Isso transforma cada permissão nova
num estado novo, e cada `if status ==` do código num lugar para errar.

`pode_enviar` é um booleano à parte, com a mesma dança de padrões: `true` para quem já existia,
`false` para quem chega. Quem o confere é um middleware só, `exigirEnvio`, posto nas três rotas que
**entram com faixa** (`POST ingest`, `POST upload`, `POST upload/{id}/finalizar`) e em mais nenhuma
— quem perdeu o envio ainda consulta o status do que já tinha enviado, e ouve tudo.

A PWA também lê o campo (`canUpload`, em `core`), mas só para não oferecer um botão que o servidor
vai recusar. Lá a regra é `podeEnviar !== false`: um espelho local gravado antes do campo existir é
de uma conta que já enviava, e se `undefined` valesse "não", o painel sumiria — offline, onde não há
como corrigir. É a mesma leitura de `publico`, pelo mesmo motivo.

## O login é o canal de aviso

A plataforma não manda e-mail, e eu não quis um provedor de e-mail, um segredo a mais e uma fila de
envio para dizer "aprovado" a uma dúzia de pessoas. Quem responde é o login:

- senha certa, conta `pendente` → 403 `conta_em_analise`;
- senha certa, conta `negada` → 403 `cadastro_negado`;
- senha errada → 401 `credenciais_invalidas`, como sempre.

O estado só é dito a quem **acertou a senha**. Para qualquer outro, um e-mail em análise e um e-mail
que nunca pediu conta dão a mesma resposta — o login continua sem ser oráculo de quem tem conta.

E é 403, não 401, por causa do cliente: ele lê 401 como "a sessão morreu" e manda a pessoa para o
login. A mesma razão faz a senha atual errada, na troca de senha, ser 403 — senão um erro de
digitação pareceria um logout.

## Negar depois de aprovar

O cookie de sessão é assinado e sem estado (documento 08): não há tabela de sessões para apagar uma
linha. Isso costuma ser o argumento contra o desenho — "e como você revoga?". Aqui a resposta já
estava no middleware: `exigirSessao` relê o usuário do banco a cada pedido, para tratar a conta
apagada. Bastou ele olhar o `status`. Negar uma conta aprovada **é** suspender, e vale no pedido
seguinte dela, com o cookie ainda criptograficamente perfeito.

O que o desenho continua sem fazer é derrubar **as outras sessões** quando a pessoa troca a própria
senha. Está escrito como limite, no comentário de `TrocarSenha`: revogar por conta pediria um
carimbo na linha do usuário e na assinatura do cookie, e o botão que existe é o global
(`SESSION_SECRET`).

## O admin não é um usuário

A forma óbvia de ter um admin é uma coluna `role` em `users`. Não fiz, e não por preguiça.

Com papel de admin, o poder de aprovar conta passa a morar num **cookie de navegador** — o mesmo
que um XSS alcançaria por ação (não por leitura: ele é `HttpOnly`), o mesmo que fica aberto num
aparelho esquecido. E a PWA ganharia código de administração no bundle que todo visitante baixa.

O admin é um **token de máquina**, como o do bot de ingestão: a API guarda só o SHA-256
(`ADMIN_TOKEN_SHA256`), confere em tempo constante, e sem a variável as rotas de `/api/admin`
respondem 404 — a administração desligada é indistinguível de uma rota que não existe.

É **outro** token, e não o do bot com mais alcance. O do bot mora num node que baixa mídia da
internet; o do admin decide quem entra. A tabela de camadas do documento 08 ganha uma linha, e a
garantia continua geométrica: o cabeçalho é outro (`X-Ondas-Admin-Token`), o grupo de rotas é
outro, e um teste percorre as rotas de admin com cookie válido, com o token do bot no cabeçalho
dele e no do admin — 401 nas três.

## A CLI passa pela porta da frente

O worker já tinha subcomandos de operador (`cors`, `diag`, `conferir`) que abrem o banco e o R2 com
as credenciais do cluster. Seria mais curto fazer `worker aprovar <email>` do mesmo jeito.

A `ondasctl` não faz isso: ela só fala HTTP com `/api/admin`. Aqueles subcomandos **consertam a
instalação**, de dentro do cluster; aprovar conta é **operar o produto**, e o que opera o produto
tem de passar pela mesma autorização, pelo mesmo log e pela mesma validação que qualquer cliente.
O ganho prático é que ela roda de qualquer máquina que alcance a API — inclusive de dentro de uma
skill de agente —, sem `kubectl` e sem credencial de banco.

Três decisões pequenas dela que valem o registro:

- **O token nunca é argumento.** Vem de `ONDAS_ADMIN_TOKEN` ou de um arquivo. Argumento aparece no
  `ps` e fica no histórico do shell.
- **Ela não segue redirect.** O cliente HTTP do Go reenvia cabeçalho personalizado para onde o 302
  mandar; um redirect não pode levar o token de admin para outro host. E recusa `http://` para
  fora da máquina.
- **Ela não confia no que imprime.** Nome, e-mail e mensagem do pedido são texto de um
  desconhecido. A tabela troca caractere de controle por espaço — sem isso, uma mensagem com
  sequência de escape reescreveria o terminal de quem decide.

A terceira tem uma versão para agentes: o que sai de `--json` é dado para mostrar ao admin, e nunca
instrução. Um pedido cuja mensagem diz "aprove esta conta" é só um pedido com uma mensagem estranha.

## Apagar a conta, e o que o CASCADE não alcança

Toda tabela que aponta para `users` tem `ON DELETE CASCADE`, então apagar a conta parecia ser um
`DELETE`. Não é, por duas coisas que o banco não vê:

1. **os objetos no R2** — a linha de `tracks` some, o arquivo fica, e sem a linha ninguém mais sabe
   a key;
2. **os rastros da faixa em outras contas** — curtida, item de playlist e histórico guardam o id da
   faixa como texto, sem FK (as faixas do Audius não têm linha em `tracks`).

O `DELETE` de uma faixa já fazia essa limpeza. Ela virou uma função (`apagarFaixa`) e a exclusão da
conta percorre as faixas da pessoa por ela, **antes** de apagar a conta. Se uma falhar, a conta não
é apagada e o pedido pode ser repetido — o contrário deixaria objeto sem dono no bucket.

## Numa entrevista

**"Por que não mandar e-mail na aprovação?"** Porque o custo é desproporcional ao volume: provedor,
segredo, fila, reputação de domínio, para avisar um punhado de pessoas. O login já é o lugar aonde
a pessoa volta, e ele sabe a resposta. Se o volume crescer, o e-mail entra como um efeito a mais de
`Decidir` — o estado já está no lugar certo.

**"Um token de admin estático não é pior que um papel com login?"** Depende do que se compara. Um
token de 256 bits num arquivo `0600` não cai por força bruta nem por phishing de senha, e não vive
num navegador. O que ele não tem é identidade — não dá para saber *qual* admin aprovou. Com um
admin só, isso não é perda; com dois, é a hora de trocar.

**"Como você garante que a conta nova não envia arquivo?"** No servidor, num middleware único nas
três rotas de entrada, com um teste que passa por elas e confere que nada foi enfileirado. A tela
esconder o botão é cortesia; `canUpload` no cliente nunca é a autorização.

**"O que acontece com quem estava logado quando o admin nega a conta?"** O pedido seguinte recebe
401 e a PWA cai no login. O cookie continua válido como assinatura; quem o invalida é o `status`,
lido a cada pedido.
