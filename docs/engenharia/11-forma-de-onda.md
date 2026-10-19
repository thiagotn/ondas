---
title: "O áudio de verdade em 200 bytes — e a barra lisa como resposta honesta"
date: 2026-10-19
description: "RMS de 200 trechos medido em fluxo pelo ffmpeg, um alfabeto de 6 bits compartilhado entre Go e TypeScript por um teste que lê o arquivo do outro, e seis paths de SVG em vez de duzentos nós."
slug: "ondas-forma-de-onda"
draft: true
tags:
  - audio
  - performance
  - frontend
---

A versão anterior da barra de progresso desenhava, para toda faixa, uma onda derivada do hash do id
da música. Era bonita, era convincente e **não tinha nenhuma relação com o som**. Duas faixas
diferentes tinham desenhos diferentes, o que fazia parecer informação; a mesma faixa tinha sempre o
mesmo desenho, o que fazia parecer medição.

Hoje a barra desenha o áudio de verdade — e, quando o áudio é desconhecido, desenha uma linha reta.
Este documento é sobre as duas metades disso: como medir barato e como mostrar honestamente.

## O problema: medir no cliente é caro, e no servidor é tarde

Para desenhar a envoltória de uma faixa, alguém precisa ler o arquivo inteiro. Há três lugares
possíveis, e dois não servem:

- **No navegador, ao tocar.** Exigiria baixar o arquivo completo antes de desenhar — justamente o
que o streaming evita.
- **Numa requisição separada, por faixa.** A primeira tela tem doze linhas; seriam doze viagens de
rede para desenhar barras.
- **Na ingestão, uma vez.** O arquivo já está em disco, o processo já roda ffmpeg, e o resultado é
pequeno o suficiente para viajar junto com o resto dos metadados.

A terceira é a escolhida, e o "pequeno o suficiente" é a decisão inteira.

## A decisão: 200 trechos, 6 bits cada, uma coluna de texto

`api/internal/ingest/picos.go:19`: **200 picos por faixa**, porque *"A tela nunca desenha mais que
isto (a barra mais larga do app cabe ~180 barras de 2px), e a PWA reduz para o que couber. Guardar
mais seria detalhe que ninguém vê."*

O número não é redondo por estética: é derivado do maior tamanho que a barra pode ter na tela.

Cada pico é um caractere de um alfabeto de 64 símbolos — 6 bits (`api/internal/ingest/picos.go:26`).
Resultado: **200 caracteres, 200 bytes**, numa coluna `text` da própria faixa.

E é esse tamanho que justifica o lugar onde o dado mora. A migração
`api/internal/db/migrations/0004_picos.sql` registra:

> Fica aqui, e não num objeto no R2, porque são 200 bytes e a listagem do acervo já é uma consulta
> só — buscar a forma de onda à parte seria uma viagem de rede por faixa para desenhar a primeira
> tela.

Duzentos bytes a mais por linha numa consulta que já acontece contra uma requisição por faixa. Não é
uma escolha difícil quando o tamanho está medido.

## A medição: em fluxo, nunca em memória

`api/internal/ingest/picos.go:49-58`:

```
ffmpeg -v error -nostdin -i <arquivo> -vn -ac 1 -ar 4000 -f s16le -
```

Cada bandeira resolve uma coisa:

| Bandeira | Por quê |
|---|---|
| `-vn` | a capa embutida é um stream de vídeo; sem isso ela entraria na conta |
| `-ac 1` | mono: a envoltória não precisa de dois canais |
| `-ar 4000` | 4 kHz — cada pico resume centenas de milissegundos, então interessa a envoltória, não a banda |
| `-f s16le -` | PCM cru para a **saída padrão**, consumida em fluxo |

A taxa de 4 kHz é escolhida por **memória**, não por qualidade (`api/internal/ingest/picos.go:31`).
E o comentário em `api/internal/ingest/picos.go:41-43` tem o número: a 4 kHz, uma hora de música são
28 MB de PCM, e o worker divide 1 GiB de disco temporário com o arquivo original. Lendo por um
`StdoutPipe`, o que fica em memória é um buffer de 64 KiB.

### Por que RMS e não o pico absoluto

`api/internal/ingest/picos.go:36-39`:

> o pico cru de um trecho de música comprimida está quase sempre no teto, e a forma de onda vira um
> retângulo. O RMS é o que o olho lê como "mais alto aqui".

Música moderna é comprimida: o valor máximo de praticamente qualquer trecho de 1 s está perto de 0
dBFS. Desenhar máximos produz um bloco. O RMS — a raiz da média dos quadrados — mede energia, que é
o que corresponde à sensação de volume.

### Por que normalizar pela própria faixa

`api/internal/ingest/picos.go:83-85`:

> uma gravação inteira baixa desenharia um fio reto se a escala fosse absoluta, e o que a barra
> precisa mostrar é o relevo DELA, não quanto ela é alta comparada com outra.

A barra responde "onde está o refrão desta música", não "esta música é mais alta que a outra".
Escala absoluta serviria para a segunda pergunta, que ninguém faz olhando uma barra de progresso.

### Dois detalhes do laço que um `io.ReadFull` erraria

**A amostra cortada entre leituras.** Cada amostra são 2 bytes, e uma leitura de 64 KiB pode
terminar no meio de uma. `api/internal/ingest/picos.go:97-110` guarda o byte solto e o reprepende na
iteração seguinte. Sem isso, todas as amostras depois da primeira leitura ímpar sairiam deslocadas
em um byte — e o resultado seria ruído plausível, não um erro.

**O último balde recolhe o excedente** (`api/internal/ingest/picos.go:113-119`): *"a duração do
ffprobe erra por frações de segundo, e o fim da faixa é justamente onde o fade precisa aparecer
inteiro."* O número de amostras por balde vem de uma estimativa; o clamp garante que o resto da
faixa não seja descartado nem transborde o array.

## O alfabeto está em dois idiomas, e um teste trava os dois

O codec existe duas vezes: em Go (`api/internal/ingest/picos.go`) e em TypeScript
(`packages/core/src/waveform.ts`). Não por descuido — a imagem da API é construída com o contexto
`api/` apenas, então nada ali pode importar arquivo do monorepo.

O risco disso é específico e silencioso (`api/internal/ingest/picos.go:21-25`):

> Tem de ser IGUAL ao de `packages/core/src/waveform.ts`. Se os dois saírem de acordo, a forma de
> onda aparece embaralhada e nada falha em voz alta — é por isso que `TestPicosAlfabetoBateComOCore`
> lê o arquivo do core e compara.

Um teste Go que abre um arquivo TypeScript e compara o alfabeto caractere a caractere. É feio e é a
única coisa que mata esse mutante: **nenhum teste funcional de nenhum dos dois lados falharia** se
os alfabetos divergissem — o codec continuaria codificando e decodificando consistentemente dentro
de cada linguagem, e o defeito apareceria como um desenho estranho que ninguém reconheceria como
bug.

Vale dizer que o alfabeto é exatamente o conjunto base64url, mas o codec **não é** base64: é um
caractere por valor, sem empacotamento de bits. Base64 de verdade custaria bits atravessados dos
dois lados por nenhum ganho de tamanho relevante (`packages/core/src/waveform.ts:13-21`).

## O desenho: seis `path`, não duzentos nós

`packages/core/src/waveform.ts:139-147`: *"duzentas barras custam seis nós no DOM"*.

`wavePaths()` (`packages/core/src/waveform.ts:148`) gera **seis strings de `path`** — três faixas de
cor (tocado, em buffer, resto) × duas versões (o desenho e o reflexo do player cheio). Cada barra é
um traço vertical dentro de um desses caminhos.

A alternativa — um elemento por barra — são 200 nós que o React precisa reconciliar a cada
atualização de tempo, isto é, várias vezes por segundo. Seis nós com o atributo `d` trocado é um
problema de outra ordem de magnitude.

Duas decisões de geometria:

**A reamostragem usa o máximo do trecho, não a média** (`packages/core/src/waveform.ts:51-58`). Ao
reduzir 200 picos para as ~60 barras que caibam num celular, a média suaviza os transientes e achata
o desenho; o máximo preserva o relevo. É o inverso da escolha na medição — e por um motivo coerente:
lá o objetivo era medir energia, aqui é preservar contraste visual.

**Quantas barras cabem é medido na caixa, não deduzido da viewport.** Um `ResizeObserver`, uma barra
a cada 3 px, com limites de 12 a 200 (`packages/core/src/waveform.ts:96`). Deduzir da largura da
janela erraria em todo layout que não ocupa a tela inteira — e a barra aparece em dois tamanhos
diferentes neste app.

## A interação: arrastar, e só buscar ao soltar

A barra captura o ponteiro e o desenho acompanha o dedo, mas **a faixa só anda ao soltar**.

O motivo é de rede: buscar a cada movimento faria o áudio engasgar, porque cada pulo numa faixa que
vem pela rede é um pedido novo de intervalo de bytes. Arrastar atravessando a faixa inteira geraria
dezenas de requisições de `Range`, das quais só a última importa.

No toque, o CSS resolve metade do problema: `touch-action: pan-y` deixa o gesto vertical rolar a
página e reserva o horizontal para a barra. Sem isso, arrastar na barra trava a rolagem ou
vice-versa — e qual dos dois depende do navegador.

E a barra é um `<button>`, não um `<span>`: dá para posicionar a faixa com as setas, `Home` e `End`.
Antes era um `<span tabindex="-1">` que só o mouse alcançava.

## A metade honesta: barra lisa

Faixa sem picos medidos desenha uma linha reta a 34% da altura (`picosLisos`,
`packages/core/src/waveform.ts:73`). Ela continua clicável e arrastável — só não mostra relevo.

Isso vale para **todo o catálogo público**, porque o Audius não publica forma de onda e o app nunca
baixa o arquivo inteiro para medir. Na prática, a maioria das faixas que alguém vê tem barra lisa.

É uma perda visível de densidade visual, e é o ponto:

> **Assim o relevo passa a significar uma coisa só — o Ondas conhece este áudio.**

A versão com onda derivada do hash era mais bonita em toda tela e mentia em todas elas. Trocar
informação inventada por ausência de informação deixou a interface mais pobre e passou a permitir
que alguém **confie** no que ela mostra.

O cliente ainda defende o limite: o validador do catálogo recusa mais de 800 caracteres de picos
(`packages/core/src/catalog/acervo.ts:48-69`), quatro vezes os 200 reais — para que uma PWA antiga
não pare de desenhar se o servidor um dia aumentar a resolução.

## A dívida que o melhor esforço criou

Medir picos é melhor esforço na ingestão: se o ffmpeg falhar, o worker registra um aviso, grava
string vazia e segue (`api/internal/worker/worker.go:187-193`). Faixa sem onda desenha barra lisa, e
isso não é motivo para reprovar uma ingestão que já subiu o áudio.

A consequência é que a medição chegou **depois** de parte do acervo: faixas ingeridas antes da
migração ficaram com a coluna nula. Duas opções:

| Opção | Custo |
|---|---|
| Reingerir | UUID novo → mata os links `/t/...` já compartilhados, e sobe de novo um arquivo que já está no bucket |
| Remedir e atualizar a coluna | Baixa o áudio do bucket, roda o mesmo medidor, muda **200 bytes** |

A segunda virou `worker repicos` (`api/cmd/worker/repicos.go:84-90`), com três cuidados que valem
registro:

- **Ensaio é o padrão.** Sem `--gravar`, ele lista o que mudaria e não escreve nada. O padrão de um
comando que mexe em produção tem de ser o inofensivo.
- **O `UPDATE` repete a condição da listagem** (`api/cmd/worker/repicos.go:64-71`): entre listar e
gravar pode ter entrado uma ingestão nova para a mesma faixa, e um comando de recuperação nunca deve
passar por cima de uma medição mais recente que a dele.
- **Nulo e vazio são os dois estados de "sem onda"**: nulo é quem foi ingerido antes da coluna
existir, vazio é quem o ffmpeg não conseguiu medir. A consulta cobre os dois.

## O que foi descartado

| Opção | Por que não |
|---|---|
| Onda derivada do hash do id | Bonita, convincente e sem nenhuma relação com o som |
| Medir no navegador ao tocar | Exigiria baixar o arquivo inteiro, que é o que o streaming evita |
| Buscar a onda numa requisição por faixa | Doze viagens de rede para desenhar a primeira tela |
| Guardar os picos num objeto no bucket | 200 bytes cabem na consulta que já existe |
| Pico absoluto em vez de RMS | Música comprimida está no teto; o desenho vira um retângulo |
| Escala absoluta entre faixas | Gravação baixa desenharia um fio reto; a barra mostra o relevo dela |
| Base64 de verdade | Bits atravessados dos dois lados por nenhum ganho de tamanho |
| Compartilhar o codec entre Go e TypeScript | A imagem da API é construída só com o contexto `api/` |
| Um elemento SVG por barra | 200 nós reconciliados várias vezes por segundo |
| Média na reamostragem | Suaviza os transientes e achata o desenho |
| Deduzir o número de barras da viewport | A barra aparece em dois tamanhos no mesmo app |
| Buscar a cada movimento do arrasto | Um pedido de `Range` por movimento; o áudio engasga |
| Reingerir para preencher as faixas antigas | UUID novo mata os links compartilhados |

## O que isso custou

**O codec está escrito duas vezes.** A trava é um teste que lê o arquivo do outro idioma — feio, e a
única coisa que pega a divergência.

**A maioria das faixas mostra barra lisa.** A interface é visivelmente mais pobre do que a versão
que mentia. Foi a troca pretendida, e ela é perceptível.

**Melhor esforço na medição gerou dívida de dados** e um subcomando de operação para resolvê-la.

**200 picos é uma escolha fixa.** Aumentar a resolução depois exigiria remedir tudo — e é exatamente
por isso que o cliente aceita até 800, para não quebrar numa PWA antiga.

## Numa entrevista

**"Como você desenha a forma de onda de um áudio sem baixar o arquivo no cliente?"** Medindo uma
vez, na ingestão, onde o arquivo já está em disco. São 200 trechos de RMS, decodificados a 4 kHz
mono em fluxo pelo ffmpeg para a saída padrão, nunca em memória — a 4 kHz, uma hora de música são 28
MB de PCM, e o worker divide 1 GiB de disco temporário. O resultado são 200 caracteres de 6 bits,
numa coluna de texto que viaja na listagem que já acontecia.

**"Por que RMS e não o valor de pico?"** Porque música comprimida tem o pico de quase todo trecho no
teto, e o desenho vira um retângulo. RMS mede energia, que é o que o olho lê como "mais alto aqui".
E eu normalizo pela própria faixa, não numa escala absoluta: a barra responde "onde está o refrão
desta música", não "esta música é mais alta que a outra".

**"Você tem o mesmo codec em duas linguagens. Como evita divergência?"** Com um teste em Go que abre
o arquivo TypeScript e compara o alfabeto caractere a caractere. É feio e é necessário, porque
**nenhum teste funcional dos dois lados falharia** se eles divergissem: cada linguagem continuaria
consistente consigo mesma e o defeito apareceria como um desenho estranho que ninguém reconheceria
como bug.

**"Duzentas barras no DOM não é caro?"** Seria. São seis `path` de SVG — três faixas de cor vezes o
desenho e o reflexo — com cada barra sendo um traço dentro do caminho. Um elemento por barra seriam
200 nós para o React reconciliar várias vezes por segundo.

**"Por que o seek só acontece quando solta o dedo?"** Porque cada pulo numa faixa que vem pela rede
é um pedido novo de intervalo de bytes. Buscar a cada movimento geraria dezenas de requisições das
quais só a última importa, e o áudio engasgaria. O desenho acompanha o dedo em tempo real; a faixa
anda uma vez.

**"Você já tomou uma decisão de produto que deixou a interface pior?"** Esta. Antes, toda faixa
tinha uma onda derivada do hash do id — bonita e sem relação com o som. Hoje, faixa cujo áudio o
sistema não conhece mostra uma linha reta, e isso é a maioria das faixas, porque o catálogo público
não publica onda. A tela ficou mais pobre e o relevo passou a significar exatamente uma coisa. Eu
prefiro ausência de informação a informação inventada.
