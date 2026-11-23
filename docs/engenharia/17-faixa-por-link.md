---
title: "Copiei um link: oferecer sem bisbilhotar, baixar sem abrir a porta"
date: 2026-11-23
description: "Trazer faixa por link era coisa do bot do Telegram. Levar isso para a PWA esbarrou em duas coisas que parecem pequenas: o clipboard é dado privado, e o worker do cluster não resolve página. O link virou uma sugestão que só sai do aparelho no toque, e um job com dois executores."
slug: "ondas-faixa-por-link"
draft: true
tags:
  - privacidade
  - filas
  - ssrf
---

O bot do Telegram já trazia faixa por link. A pessoa mandava um endereço do YouTube, o node baixava
com `yt-dlp`, e a faixa aparecia no acervo. Só que o bot é meu: quem tem conta e envio liberado não
tinha como fazer o mesmo sozinho.

O pedido era simples — "se tiver um link de música no clipboard, sugerir pôr no acervo". As duas
metades dele têm um problema cada.

## O clipboard não é do app

O que está na área de transferência é o que a pessoa copiou por último: pode ser um link, pode ser
uma senha. Três regras saíram disso, e as três estão em `web/src/app/linkSugerido.ts`:

1. **O app nunca pede a permissão sozinho.** Ao voltar para a frente, ele lê o clipboard **só se a
   permissão já estiver concedida** (`navigator.permissions.query`). Onde essa pergunta não existe —
   Safari, Firefox — a resposta é não ler. No iPhone cada leitura mostra um balão "Colar", e um
   balão aparecendo sozinho ao abrir o app é exatamente o que não se quer.
2. **Do texto lido só sobrevive a URL reconhecida.** `acharLink` (`core/src/link.ts`) devolve o
   link ou `null`; o resto do texto é descartado na hora, e não vai para store, log nem servidor.
3. **Nada sai do aparelho antes do toque.** O link vira um aviso — "link do YouTube copiado" — com
   `[adicionar ao acervo]` e `[ignorar]`. Só o primeiro manda a URL.

Quem concede a permissão é a pessoa, tocando no `[+ link]` da biblioteca: aquele toque é o gesto que
todo navegador aceita para ler o clipboard, inclusive o do iPhone. Depois dele, a leitura automática
passa a funcionar onde o navegador a permite.

### Errar para o lado do silêncio

`acharLink` só casa o que é reconhecidamente **uma** faixa: um vídeo do YouTube, uma faixa do
SoundCloud, uma URL que termina em extensão de áudio. Playlist, canal, perfil e qualquer outro site
voltam `null`. Um aviso que aparece para link que não serve ensina a pessoa a ignorar o aviso.

E o mesmo link não é oferecido duas vezes: o clipboard não muda só porque a pessoa disse "não",
então as URLs respondidas ficam em `sessionStorage`. O gesto explícito (`[+ link]`, colar,
compartilhar) ignora essa lista — ali a pessoa **pediu**.

### Três portas, uma sugestão

| Porta | Onde funciona | Como lê |
|---|---|---|
| voltar para o app | Chromium, com a permissão já dada | sozinho, sem prompt |
| `[+ link]` e colar | todo navegador | no gesto |
| Compartilhar para o Ondas | Android, app instalado | `share_target` no manifest, sem clipboard |

As três param no mesmo aviso. Nenhuma enfileira nada sozinha — nem o compartilhar, que é o mais
explícito dos três: a rota `/share` transforma o que chegou em sugestão, vai para a biblioteca e
limpa o endereço.

## O cluster não resolve página

O worker de ingestão baixa **arquivo**. Dar a ele uma URL do YouTube devolve HTML, e o ffprobe
recusa. Ensinar o worker a resolver página foi descartado quando o bot nasceu, por dois motivos que
continuam de pé ([documento 10](10-ingestao-e-ssrf.md)): o YouTube recusa o IP de saída do cluster,
e um resolvedor de página é um programa que segue redirecionamentos e busca recursos por conta
própria — o oposto do que a trava de SSRF existe para garantir.

Quem baixa página é o node, onde `yt-dlp` e `scdl` já rodam para o bot. Então o job ganhou um
**tipo**, que diz quem o atende (migração `0013`):

```
PWA ── POST /ingest ──▶ job tipo=pagina ──▶ node (ondas-fila) baixa
                                              │  PUT na área de espera de QUEM PEDIU
                                              ▼
                        job tipo=midia  ──▶ worker: ffprobe, capas, forma de onda
```

O id do job **não muda** nessa passagem. A PWA acompanha uma coisa só, do "baixando do site" ao
"pronto", no mesmo `GET /ingest/{id}` de sempre.

### O alcance novo do token

O node fala com a API pelo token de máquina, e este desenho o deixa escrever na conta de outra
pessoa. O que mantém isso estreito não é um `if`:

- as rotas do node só acham **job de página em andamento** (`Jobs.PaginaEmCurso`) — um id de job de
  mídia, ou de um job que ninguém reivindicou, é 404;
- a key do arquivo sai do dono **daquele job** (`storage.KeyUploadStage(job.UserID, …)`). O node
  não diz conta nenhuma; ele só carrega o id.

Ou seja: o token grava na conta de alguém **somente** se essa conta pediu, e só o arquivo daquele
pedido. `TestRotasDoNodeSoAbremComOTokenDeMaquina` trava a divisão, como
`TestEscopoDoTokenNoAcervo` trava a do acervo.

### A falha é um código

O node sabe por que um download falhou, e a frase dele poderia ir direto para o job. Não vai: ele
manda um **código** de lista fechada (`pagina_indisponivel`, `pagina_longa_demais`,
`pagina_falhou`), e a frase gravada é escolhida pela API. Texto livre vindo de fora viraria
conteúdo na tela de quem pediu.

## O servidor decide de novo

A PWA classifica o link para decidir se **sugere**. Quem decide o que ele é de verdade é a API
(`ingest.ClassificarLink`), com as mesmas regras — e ela **canoniza**: `youtu.be/ID?si=…`,
`music.youtube.com/watch?v=ID&list=…` e `m.youtube.com/watch?v=ID` viram a mesma
`youtube.com/watch?v=ID`. É a canônica que vai para o banco, e é isso que faz o mesmo vídeo colado
de dois jeitos cair no mesmo job em vez de baixar duas vezes.

A rota não tinha freio de pedidos, e cada job de página é um download num link residencial. Entraram
dois: cinco pedidos em andamento por conta, e a cota — que nesta versão deixou de só medir
([documento 16](16-painel-de-admin-e-cota.md)).

## O que foi descartado

| Alternativa | Por que não |
|---|---|
| Ler o clipboard a cada foco, em todo navegador | No iPhone é um balão "Colar" por leitura; em qualquer lugar, é ler dado privado sem ter sido chamado |
| Enfileirar direto o link compartilhado | O compartilhar é explícito, mas o menu do Android fica a um toque de distância de qualquer link — a confirmação custa um toque e evita a faixa errada |
| `yt-dlp` no worker do cluster | IP de saída recusado e trava de SSRF afrouxada; a decisão do bot continua valendo |
| O node criar um job novo ao entregar | Quem pediu perderia o fio: acompanharia um job que nunca termina, e a faixa apareceria de outro |
| O node dizer a conta de destino | Seria o token escolhendo onde escrever. Com o id do job, quem escolhe é quem pediu |
| Aceitar playlist pela PWA | O bot pergunta "são 40 faixas, tem certeza?"; aqui não há conversa para perguntar |

## Custos assumidos

- **Link de página depende do node.** Com o `ondas-fila` parado, o pedido fica na fila; a PWA
  mostra "baixando do site" até o prazo dela, e a faixa aparece quando o node voltar.
- **Reconhecer a falha é casar texto** da saída das skills. Quando uma frase mudar, a falha deixa
  de ser reconhecida como definitiva e é tentada mais duas vezes — degrada, não quebra.
- **No iPhone não há detecção automática**, e não há compartilhar. Lá o caminho é o `[+ link]`.
- **Direito autoral.** O bot fazia isso para uma pessoa; agora faz para toda conta com envio
  liberado. A trava é a permissão de envio, que o admin liga conta por conta.

## Numa entrevista

**"Como você lê o clipboard sem ser invasivo?"** Não pedindo permissão por conta própria, lendo só
quando ela já existe ou num gesto, descartando tudo que não seja a URL reconhecida, e não mandando
nada ao servidor antes de uma confirmação. E testando o negativo: há um teste que conta as leituras
e exige zero.

**"Por que não baixar do YouTube no próprio worker?"** Porque o worker é um baixador de arquivo com
trava de SSRF, e um resolvedor de página é o contrário disso. A página é resolvida por quem já fazia
isso, e o worker continua recebendo arquivo.

**"Como dois executores dividem uma fila?"** Uma coluna de tipo, e cada um reivindica só o seu, com
o mesmo `SKIP LOCKED`. A passagem de um para o outro é um UPDATE que troca o tipo e a fonte do
mesmo job.

**"O token de máquina escreve na conta de outra pessoa — isso não é um buraco?"** Seria, se ele
escolhesse a conta. Ele manda um id de job, e a consulta só acha job de página em andamento; a
conta é a de quem pediu aquele job.
