# Changelog

Todas as entregas do ondas, da mais nova para a mais velha.

**Este arquivo é gerado.** A nota se escreve em
`packages/core/src/release/notas.json` e sai daqui por `pnpm release` — a mesma lista é a
página `/changelog` do app, nos três idiomas. Editar este arquivo à mão é trabalho que o
próximo `pnpm release` desfaz.

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
