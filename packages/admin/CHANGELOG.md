# Changelog do painel de administração

Todas as entregas do painel, da mais nova para a mais velha. O painel é um sistema à parte:
a versão dele não acompanha a do app, cujas entregas estão em
[`CHANGELOG.md`](../../CHANGELOG.md).

**Este arquivo é gerado.** A nota se escreve em
`packages/admin/src/release/notas.json` e sai daqui por `pnpm release` — a mesma lista é a
tela `/changelog` do painel, nos três idiomas. Editar este arquivo à mão é trabalho que o
próximo `pnpm release` desfaz.

## 1.3.0 — 2026-11-25

- o painel passa a ter versão e notas próprias, separadas das do app: a versão do rodapé abre a lista do que mudou em cada entrega, no idioma do painel

## 1.2.0 — 2026-11-25

- os endereços das telas passam a ser em inglês — `/accounts`, `/tracks`, `/ingestions`, `/signup`, `/plans` e `/history`. Os endereços antigos continuam funcionando: quem guardou um chega à mesma tela, com o mesmo filtro
- a lista de faixas abre com as mais novas em vez das maiores

## 1.1.0 — 2026-11-23

- toda lista ganhou um campo de filtro e colunas que ordenam ao clique — contas, faixas, ingestões, convites, planos e histórico. O filtro ignora acento e maiúsculas, e o recorte fica no endereço: recarregar a página não o desfaz
- o painel passa a ter os nove temas do app e os três idiomas (português, inglês e espanhol), trocados na barra do topo e guardados no navegador

## 1.0.0 — 2026-11-23

- o painel de administração nasce: a visão geral mostra o que espera decisão, e as contas são aprovadas, negadas, liberadas para envio, ajustadas de plano e apagadas daqui
- as outras telas: faixas do acervo inteiro, ingestões recentes, abertura do cadastro e convites, planos com a cota de cada um, e o histórico do que foi decidido
