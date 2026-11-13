# Changelog

Todas as entregas do ondas, da mais nova para a mais velha.

**Este arquivo é gerado.** A nota se escreve em
`packages/core/src/release/notas.json` e sai daqui por `pnpm release` — a mesma lista é a
página `/changelog` do app, nos três idiomas. Editar este arquivo à mão é trabalho que o
próximo `pnpm release` desfaz.

## 1.9.0 — 2026-11-13

- as faixas do acervo não levam mais a etiqueta `#acervo` na lista, também na tela larga — ela aparecia igual em toda linha. O filtro `acervo` e o recorte `--acervo` da biblioteca continuam

## 1.8.0 — 2026-11-13

- `ondas --about` mostra a marca da onda no lugar do nome em blocos, e a linha de bugs ficou só com o link `[reportar um bug]` — o texto que explicava o que informar ocupava meia tela no celular

## 1.7.1 — 2026-11-13

- o favicon, o ícone do app e a tela de abertura do iOS agora trocam junto com a marca — na 1.7.0 eles continuavam mostrando a fita, porque o endereço dos arquivos não mudava e a cópia antiga ficava guardada por semanas

## 1.7.0 — 2026-11-13

- marca nova: a Grande Onda de Kanagawa, com o sol vermelho atrás, no lugar da fita cassete. A onda se mexe enquanto a música toca, e o sol nasce conforme a faixa avança
- o ícone do app, o favicon e a tela de abertura do iOS acompanham a marca nova — em quem já instalou o app, o ícone pode demorar a trocar

## 1.6.0 — 2026-11-13

- dá para pedir uma conta: a tela de login ganhou `[c] pedir uma conta`. O pedido passa por análise, e é a própria tela de login que diz se ele foi aprovado
- contas novas ouvem, curtem e montam playlists, mas ainda não enviam arquivos — o painel de envio só aparece para quem tem o envio liberado
- `ondas whoami` deixa trocar o nome e a senha, e apagar a conta de vez — a senha é pedida de novo para as duas últimas
- achou um bug? `ondas --about` agora diz o que informar e leva direto às issues do projeto no GitHub

## 1.5.1 — 2026-11-13

- entrar na conta logo depois de sair não derruba mais a sessão nova — acontecia em rede lenta, quando a saída anterior ainda não tinha terminado

## 1.5.0 — 2026-11-13

- a lista de faixas ficou mais limpa: saem os selos `[meu]` e `[off]`. O `#acervo` já diz que a faixa é sua, e o ✓ verde no botão de download já diz que ela está no aparelho

## 1.4.0 — 2026-11-12

- tema, idioma e os ajustes do fundo (transparência e desfoque) agora seguem a sua conta: escolha num aparelho e os outros abrem do mesmo jeito. A imagem de fundo que você enviou continua só no aparelho em que foi enviada — nos outros, o fundo usa a capa da faixa
- na biblioteca, `]` e `[` passam para o recorte seguinte e o anterior, dando a volta no fim da fileira
- a linha de comando aceita o nome de um recorte: `:historico` (ou só `:hist`) leva direto para ele, de qualquer tela
- `enter` não toca mais uma faixa que não está na tela — acontecia na lista de `--playlists`, com a linha que tinha ficado marcada no recorte anterior
- no painel de temas, as opções de wallpaper voltam a ter nome (`capa-atual`, `imagem`, `nenhum`) em vez de um código interno

## 1.3.0 — 2026-11-12

- no computador, a tela de login fica no meio da janela em vez de encostada no canto

## 1.2.0 — 2026-11-10

- o app lembra onde você parou: abrindo com a mesma conta em qualquer aparelho, o player já vem com a última faixa, pausada no segundo certo — um toque e ela continua dali
- a biblioteca ganhou o recorte `--historico`, com o que você já ouviu — inclusive as faixas que saíram do em-alta desde então — e um botão para limpar

## 1.1.2 — 2026-11-06

- no sobre, o link para as notas voltou a ficar na mesma altura do número da versão

## 1.1.1 — 2026-11-05

- a próxima faixa continua sendo guardada no aparelho mesmo quando o celular jura que está sem rede — é o que faz a música não parar na troca, com a tela desligada
- quando o som não começa, o player insiste algumas vezes antes de desistir, em vez de emudecer no primeiro tropeço
- acender a tela volta a tocar o que tinha parado, sem precisar esperar a rede cair e voltar
- a tela de bloqueio deixou de dizer que está tocando quando o som já tinha parado

## 1.1.0 — 2026-11-05

- a janela do sobre ficou centrada, com o github no próprio @thiagotn do texto e a tabela só com versão e tecnologias
- página nova com as notas de cada versão, a um clique do sobre
- a bandeira de cada idioma no lugar do ícone de tradução
- trocar de versão não recarrega mais a página por conta própria — e a abertura deixou de rodar duas vezes
- o navegador dizer que não há rede não cala mais a música
- a tela que vai embora não é mais desenhada, e nunca mais aparece preto sem explicação
- o catálogo guardado ontem não derruba mais a tela de hoje

## 1.0.0 — 2026-10-16

- primeira versão: player com estética de terminal, acervo próprio, playlists, curtidas, faixas offline e link de faixa
