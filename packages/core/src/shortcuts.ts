/**
 * A lista de atalhos — fonte única.
 *
 * Antes isto vivia espalhado: o mapa de teclas em `useShortcuts`, a legenda do
 * rodapé, os keycaps do player e uns `title` de botão. Já tinham divergido — a
 * legenda anunciava `o` em produção, onde a tecla não existe, e não anunciava
 * `f`, `s`, `r` nem os dígitos. Quem muda uma tecla mexe aqui, e a janela
 * `ondas --help` e a status line acompanham.
 *
 * O `dev` entra como parâmetro em vez de ser lido aqui porque `import.meta.env`
 * é do bundler da web, e este pacote não conhece navegador nenhum.
 */

export type GrupoAtalho = 'tocar' | 'ir' | 'selecionar' | 'janela' | 'dev';

export interface Atalho {
  tecla: string;
  acao: string;
  grupo: GrupoAtalho;
}

/** Ordem e rótulo das seções da janela. `dev` não aparece em produção. */
export const GRUPOS: readonly (readonly [GrupoAtalho, string])[] = [
  ['tocar', 'tocar'],
  ['ir', 'ir'],
  ['selecionar', 'selecionar'],
  ['janela', 'janela'],
  ['dev', 'dev'],
];

const TABELA: readonly Atalho[] = [
  { tecla: '␣', acao: 'tocar ou pausar', grupo: 'tocar' },
  { tecla: 'n/p', acao: 'próxima e anterior', grupo: 'tocar' },
  { tecla: '←/→', acao: 'avançar e voltar 10s', grupo: 'tocar' },
  { tecla: 'l', acao: 'curtir', grupo: 'tocar' },
  { tecla: 'd', acao: 'baixar ou remover do aparelho', grupo: 'tocar' },
  { tecla: 'c', acao: 'compartilhar o link', grupo: 'tocar' },
  { tecla: 's', acao: 'aleatório', grupo: 'tocar' },
  { tecla: 'r', acao: 'repetir', grupo: 'tocar' },

  { tecla: 'j/k', acao: 'descer e subir na lista', grupo: 'ir' },
  { tecla: 'enter', acao: 'tocar a linha marcada', grupo: 'ir' },
  { tecla: ':nº', acao: 'ir para a faixa pelo número da calha', grupo: 'ir' },
  { tecla: '/', acao: 'buscar', grupo: 'ir' },
  { tecla: '1', acao: '~/em-alta', grupo: 'ir' },
  { tecla: '2', acao: '~/buscar', grupo: 'ir' },
  { tecla: '3', acao: '~/biblioteca', grupo: 'ir' },

  // A marca é `x` e não espaço: espaço toca e pausa, e roubá-lo no modo de
  // seleção faria a mesma tecla fazer duas coisas opostas dependendo de um
  // estado que não está escrito em lugar nenhum da tela.
  { tecla: 'v', acao: 'marcar faixas (e sair da marcação)', grupo: 'selecionar' },
  { tecla: 'x', acao: 'marcar ou desmarcar a linha', grupo: 'selecionar' },
  // `a` e não `enter`: `enter` já é "tocar a linha marcada", e a mesma tecla
  // listada duas vezes na janela `?` não se explica — ela diria duas coisas
  // dependendo de um modo. Com `a`, o `enter` continua tocando a linha, o que
  // serve para ouvir a faixa antes de pôr na playlist.
  { tecla: 'a', acao: 'pôr as marcadas numa playlist', grupo: 'selecionar' },
  { tecla: 'J/K', acao: 'mover a faixa na playlist aberta', grupo: 'selecionar' },

  { tecla: '0', acao: 'detalhes da faixa que está tocando', grupo: 'janela' },
  { tecla: '4', acao: 'temas', grupo: 'janela' },
  { tecla: '5', acao: 'conta e aparelho', grupo: 'janela' },
  { tecla: '? ou 6', acao: 'esta janela', grupo: 'janela' },
  { tecla: 'esc', acao: 'fechar a janela de cima', grupo: 'janela' },

  { tecla: 'o', acao: 'simular queda de rede', grupo: 'dev' },
];

/** A referência completa. Sem `dev`, o grupo `dev` sai inteiro. */
export function atalhos(dev: boolean): readonly Atalho[] {
  return dev ? TABELA : TABELA.filter((a) => a.grupo !== 'dev');
}

/**
 * Recorte para a status line, que é uma linha estreita e não cabe tudo.
 *
 * Mora ao lado da tabela, e não no componente do rodapé, para as duas listas
 * serem editadas de uma vez. É um resumo: `1-5 ir` cobre cinco teclas, e o
 * resto está a um `?` de distância.
 */
export const LEGENDA: readonly (readonly [string, string])[] = [
  ['␣', 'play'],
  ['n/p', 'faixa'],
  ['←/→', '±10s'],
  ['/', 'buscar'],
  ['1-5', 'ir'],
  [':', 'nº'],
  ['?', 'atalhos'],
];
