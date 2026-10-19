---
title: "O caminho do arquivo nunca vem do pedido"
date: 2026-10-19
description: "Bucket privado, dono dentro da chave do objeto, envio direto do navegador por URL assinada — e a conferência de tamanho que acontece três vezes porque a assinatura vale quinze minutos."
slug: "ondas-acervo-r2"
draft: true
tags:
  - seguranca
  - go
  - arquitetura
---

O acervo pessoal do Ondas são arquivos de áudio num bucket privado. Nenhum deles tem URL pública; o
único jeito de ler um objeto é uma assinatura emitida pela API, com prazo
(`api/internal/storage/r2.go:1-3`).

Isso cria um conjunto de problemas que não existem quando os arquivos são públicos: quem pode pedir
a assinatura, por quanto tempo ela vale, e — o problema central deste documento — **como se decide
qual arquivo o pedido está falando**.

## O problema: um identificador é um caminho se você deixar

A forma ingênua de fazer upload é o cliente dizer onde gravar. A forma um pouco menos ingênua é o
cliente dizer um identificador e o servidor montar o caminho com ele. As duas têm o mesmo defeito:
**o caminho acaba derivado de algo que o pedido mandou**.

E num sistema multiusuário — mesmo com um usuário só — o caminho é a fronteira de autorização. Se
dois clientes com o mesmo identificador em mãos conseguem apontar para o mesmo objeto, a autorização
é só o `if` que alguém lembrou de escrever.

## A decisão: a chave é derivada do sujeito autenticado, e refeita duas vezes

Há três prefixos no bucket:

```
u/<userID>/a/<trackID>.<ext>          áudio
u/<userID>/art/<trackID>-<lado>.jpg   capas
stage/<userID>/<uploadID>.bin         área de espera do envio
```

Duas propriedades deliberadas (`api/internal/storage/r2.go:116-125`):

**O dono vai na frente da chave.** A fronteira fica legível no bucket, não só no banco. Dá para
listar o que é de quem sem consultar o Postgres, e um erro de autorização aparece como objeto no
lugar errado em vez de linha no lugar errado.

**Nada de e-mail ou nome.** Chave aparece em log e em mensagem de erro; identificador opaco, não
dado pessoal.

E a parte que importa: a chave do envio é **reconstruída a partir do usuário autenticado** em dois
lugares independentes.

Primeiro na API, ao finalizar um envio (`api/internal/httpapi/upload.go:110-113`):

> A key é derivada do dono AUTENTICADO — sessão ou token —, não de nada que o cliente mandou: não
> existe pedido capaz de finalizar o envio de outra pessoa. Dois clientes com o mesmo id de envio em
> mãos apontam para duas keys diferentes, uma na área de cada um.

Essa última frase é o teste mental que eu passei a aplicar: *se dois clientes mandarem o mesmo
identificador, eles alcançam o mesmo objeto?* Aqui a resposta é não, por construção, e não por
verificação.

Depois no worker, ao ler os bytes (`api/internal/worker/worker.go:257-261`):

> A key do envio é RECONSTRUÍDA do `user_id` do job; o que está guardado na linha é só um id (ver
> acervo.FonteUpload). É essa reconstrução, e não o middleware da API, que protege esta fonte: uma
> fonte adulterada no banco não vira caminho que o worker obedece, porque o worker nunca lê um
> caminho — ele monta o dele a partir do dono do job.

Isso fecha um vetor que o middleware não cobre. Se alguém conseguisse escrever na coluna
`source_url` da fila — por injeção, por bug de outra rota, por acesso ao banco —, um caminho
arbitrário ali não levaria o worker a lugar nenhum, porque ele não usa o que está escrito. A coluna
guarda `upload:<uuid>`, e o prefixo é decodificado por uma função que devolve só o identificador
(`api/internal/acervo/jobs.go:25-32`).

É defesa em profundidade com um custo quase nulo: duas linhas que montam uma string em vez de ler
uma.

## O envio em três passos

O protocolo está documentado em `api/internal/httpapi/upload.go:17-25`:

1. `POST /api/acervo/upload` — a API reserva uma vaga e devolve uma **URL assinada de PUT**;
2. o navegador grava **direto no bucket**;
3. `POST /api/acervo/upload/{id}/finalizar` — a API confere e enfileira a ingestão.

Do passo 3 em diante é a mesma fila da ingestão por URL: mesmo worker, mesmo acompanhamento de
status.

Por que os bytes não passam pela API (`api/internal/storage/r2.go:130-144`): o túnel tem teto de
~100 MB por requisição e o link é residencial — subir por dentro gastaria a banda de upload de casa
**duas vezes**, do cliente para o cluster e do cluster para o bucket.

E o aviso que vale repetir, do mesmo comentário:

> A URL devolvida é **CREDENCIAL DE ESCRITA** no bucket pelo prazo da validade. Trate-a como
> segredo: ela não deve ir para log nem para a saída de um programa que outra coisa vá ler.

É o tipo de coisa que se esquece porque "é só uma URL". Uma URL assinada de PUT com 15 minutos de
validade é, durante esses 15 minutos, permissão de gravação num caminho do bucket. Ela não aparece
em log de acesso, não é ecoada em mensagem de erro e não é impressa por nenhum dos subcomandos de
operação.

### Por que quinze minutos

`api/internal/httpapi/upload.go:42-44`: o prazo tem de cobrir o envio **inteiro**, e 15 minutos para
60 MB ainda funciona num upload de ~70 kB/s. É dimensionado pelo pior link plausível, não pelo caso
médio.

### Três conferências do mesmo tamanho

Isto parece redundância e é a parte mais instrutiva do fluxo.

| Onde | Quando | Por quê |
|---|---|---|
| `POST /upload` | antes de enviar | Recusa com **413** já na reserva — deixar alguém subir 500 MB para só então ouvir "não" seria cruel com o upload dele (`api/internal/httpapi/upload.go:69-71`) |
| `POST /finalizar` | depois de enviar | A URL assinada **não limita bytes**; quem mentiu no passo 1 é pego aqui (`api/internal/httpapi/upload.go:130-132`) |
| no worker | ao ler do bucket | A assinatura vale 15 minutos: o arquivo pode ter sido **trocado por um maior** depois da conferência (`api/internal/worker/worker.go:276-279`) |

A terceira é um TOCTOU explícito, e a consequência de não tê-la está escrita: o disco temporário de
1 GiB do worker enche e o pod morre. Entre "confere" e "usa" existe uma janela de 15 minutos em que
a credencial de escrita continua válida — então quem usa tem de conferir de novo.

Isso tem teste próprio: `TestEnvioTrocadoPorArquivoMaiorEhRecusadoPeloWorker`.

## A varredura de abandonados

Um envio que subiu e nunca foi finalizado — a pessoa fechou a aba — fica no bucket pagando
armazenamento sem nenhuma linha no banco que o aponte (`api/internal/storage/r2.go:186-188`).

A varredura lista o prefixo `stage/` e apaga o que tem mais de 24 horas
(`api/internal/worker/worker.go:227`). O dimensionamento do prazo é um raciocínio que vale copiar:

> Folgado de propósito: o pior caso de um job legítimo é 3 tentativas com recuperação de travado a
> cada 15 minutos — menos de uma hora. 24h não corre risco de apagar arquivo que ainda vai ser
> ingerido.

Isto é: o prazo da limpeza foi derivado do pior caso do processo que ela pode atropelar, com uma
ordem de magnitude de folga. É por isso que o prefixo `stage/` é separado e não `u/<dono>/stage/` —
a varredura lista só a área de espera, sem passear pelo acervo inteiro
(`api/internal/worker/worker.go:176-178`).

Ela roda a cada hora, não a cada ciclo do worker, porque listar o bucket a cada 5 segundos seria
pagar requisição de listagem para quase sempre não achar nada. E **começa já na primeira rodada**,
para que um reinício recolha o que ficou da vez anterior (`api/cmd/worker/main.go:135-138`).

## A ordem de apagar

`removerFaixa` (`api/internal/httpapi/acervo.go:211`) apaga a linha do banco **primeiro** e os três
objetos do R2 depois, em melhor esforço. Se a limpeza do R2 falhar, o objeto fica órfão mas o acervo
do usuário já está correto; o erro vai para o log, não para a resposta
(`api/internal/httpapi/acervo.go:227-229`).

A ordem inversa — apagar os objetos e depois a linha — produziria o estado pior: uma faixa que
aparece na lista e não toca. Entre "lixo invisível no bucket" e "entrada quebrada na tela", a
escolha é fácil, e é o mesmo princípio que faz o worker limpar os objetos quando a gravação da linha
falha (`api/internal/worker/worker.go:213-217`).

A consulta de leitura segue o mesmo cuidado: `PorID` filtra por usuário **no predicado SQL**, não
num `if` depois da leitura (`api/internal/acervo/tracks.go:76-78`) — senão um id de outro dono
vazaria metadados antes da checagem.

## CORS como código, em duas formas de uma fonte

A política de CORS do bucket vive em Go (`api/internal/storage/r2.go:228-235`), e dela saem as
**duas** representações que o R2 aceita: o XML do protocolo S3 e o JSON do painel da Cloudflare.

O motivo de ser fonte única está escrito: duas cópias da mesma política divergem, e *"a divergência
aparece como 'o áudio não toca', longe daqui"*. Há um teste provando que as duas saídas descrevem a
mesma regra.

A política é pequena e cada campo tem justificativa (`api/internal/storage/r2.go:237`):

| Campo | Valor | Por quê |
|---|---|---|
| Métodos | `GET, HEAD, PUT` | `PUT` entrou com a tela de envio, para os bytes não passarem pelo túnel |
| Cabeçalhos aceitos | `range`, condicionais, `content-type` | `range` é o que permite o seek; os condicionais deixam o navegador revalidar em vez de rebaixar |
| Cabeçalhos expostos | `content-length`, `content-range`, `accept-ranges`, `etag` | Sem expor, o JavaScript do download offline não lê o tamanho e a barra de progresso fica cega |

A parte não óbvia é **por que um GET precisa de CORS aqui** (`api/internal/storage/r2.go:220-226`):
o player usa `crossOrigin='anonymous'` no elemento de áudio, o que põe a resposta final do redirect
sob checagem de CORS; e o download offline usa `fetch` e lê `res.body`, que exige resposta não
opaca. Sem a política, o áudio simplesmente não toca — e o erro no console não aponta para o bucket.

### E por que a política é aplicada à mão

Aqui está uma decisão de segurança que contraria o instinto de automatizar tudo
(`api/internal/storage/r2.go:255-262`):

> Existe porque aplicar CORS é **configuração de bucket**, e isso exige token
> `Admin Read & Write`, que na Cloudflare é de CONTA INTEIRA e não dá para escopar a um bucket.
> Um token assim guardado no cluster seria pior que uma colagem no painel […]

Então o subcomando `worker cors` **imprime** o JSON para colar no painel, em vez de aplicar. O token
que o app carrega continua sendo `Object Read & Write` escopado ao bucket — o mínimo de que ele
precisa de verdade.

Vale o contraste: automatizar essa etapa exigiria guardar no cluster uma credencial capaz de
reconfigurar a conta inteira, para executar uma operação que acontece uma vez. A colagem manual é a
opção **mais** segura, e foi escolhida por isso.

Há um detalhe de origem interessante: o subcomando `worker diag` nasceu de um diagnóstico errado.
CORS é a única operação administrativa do fluxo e falha **mesmo com credencial boa**, o que leva
qualquer pessoa a suspeitar da credencial. O `diag` exercita a credencial de ponta a ponta — grava,
mede, lê por `Range` com URL assinada e apaga um objeto de descarte — justamente para separar
"credencial ruim" de "operação que esta credencial não pode fazer".

## O que foi descartado

| Opção | Por que não |
|---|---|
| Bucket público ou domínio `r2.dev` | O acervo é privado; objeto legível sem assinatura anula a autorização |
| Bytes do envio passando pela API | Teto de ~100 MB no túnel e banda de upload residencial gasta duas vezes |
| Caminho do objeto informado pelo cliente | O caminho é a fronteira de autorização; ele tem de ser derivado do sujeito autenticado |
| Caminho guardado no banco e lido pelo worker | Uma linha adulterada viraria caminho obedecido; o worker monta o dele a partir do dono do job |
| Conferir o tamanho só no `finalizar` | A assinatura vale 15 minutos; o arquivo pode ser trocado por um maior depois |
| `stage/` dentro de `u/<dono>/` | A varredura teria de passear pelo acervo todo para achar a área de espera |
| Apagar os objetos antes da linha | Produziria faixa que aparece na lista e não toca |
| Aplicar CORS pelo cluster | Exigiria um token de conta inteira guardado para uma operação que roda uma vez |
| Varrer abandonados a cada ciclo | Listagem de bucket a cada 5 s para quase sempre não achar nada |

## O que isso custou

**Uma etapa manual no provisionamento.** A política de CORS é colada no painel. Está documentada e
há um subcomando que imprime exatamente o que colar, mas é um passo humano — e portanto um passo
esquecível. O sintoma de esquecer é "o áudio não toca", que não aponta para o bucket.

**Objetos órfãos são possíveis.** A limpeza do R2 é melhor esforço, e a varredura só cobre a área de
espera. Um objeto de áudio cujo `DELETE` falhou fica lá, invisível, pagando armazenamento.

**A conferência de tamanho em três lugares é código repetido** que parece redundante numa revisão. O
teste que trava a terceira existe para explicar por que ela não é.

**A autorização está em dois lugares por construção** — na derivação da chave na API e na
reconstrução no worker. É defesa em profundidade e é também mais um ponto a manter coerente.

## Numa entrevista

**"Como você faz upload de arquivo grande para armazenamento de objetos?"** URL assinada de PUT, com
os bytes indo do navegador direto para o bucket. A API só reserva a vaga e, depois, confere e
enfileira. No meu caso o motivo é concreto: o túnel tem teto de ~100 MB por requisição e o link é
residencial — passar por dentro gastaria a banda de upload de casa duas vezes.

**"Como você garante que um usuário não grava na área de outro?"** A chave do objeto é derivada do
usuário autenticado, não de nada que o pedido mandou. O teste mental é: se dois clientes mandarem o
mesmo identificador de envio, eles alcançam o mesmo objeto? Aqui não, porque cada um resolve para
`stage/<dono>/<id>.bin` na sua própria área. E a derivação é refeita no worker a partir do `user_id`
do job — o que está guardado no banco é só um id opaco, então uma linha adulterada não vira caminho
obedecido.

**"Você confere o tamanho do arquivo. Onde?"** Em três lugares, e o terceiro é o que as pessoas
esquecem. Na reserva, para recusar com 413 antes do upload. No `finalizar`, porque a URL assinada
não limita bytes e quem mentiu é pego ali. E no worker, porque a assinatura vale quinze minutos e o
arquivo pode ter sido **trocado por um maior** depois da conferência — é TOCTOU, e sem a terceira
checagem o disco temporário do pod enche e o processo morre.

**"Por que uma URL assinada é um segredo?"** Porque, pelo prazo de validade, ela **é** a permissão.
Uma assinatura de PUT com quinze minutos de validade é permissão de gravação naquele caminho durante
quinze minutos, para quem tiver a string. Ela não vai para log, não é ecoada em erro e nenhum
subcomando de operação a imprime.

**"Você automatizou a configuração do bucket?"** Deliberadamente não. Aplicar política de CORS é
configuração de bucket e exige um token administrativo que, naquele provedor, é de **conta inteira**
e não dá para escopar. Guardar isso no cluster para rodar uma operação que acontece uma vez seria
pior do que colar um JSON no painel. Então eu tenho um subcomando que **imprime** a política, gerada
do mesmo código que produz a versão XML, com teste provando que as duas não divergem. O token do app
segue com permissão de objeto, escopada ao bucket.

**"Em que ordem você apaga uma faixa?"** Linha primeiro, objetos depois, em melhor esforço. A ordem
inversa deixaria uma faixa visível na lista que não toca. Entre lixo invisível no bucket e entrada
quebrada na tela, eu escolho o lixo — e é o mesmo princípio que faz o worker limpar os objetos
quando a gravação da linha falha.
