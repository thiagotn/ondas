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

import { t as traduzir, type Chave } from './i18n/index.js';

export type GrupoAtalho = 'tocar' | 'ir' | 'selecionar' | 'janela' | 'dev';

export interface Atalho {
  tecla: string;
  /** Já traduzida: `atalhos()` resolve a chave no idioma de agora. */
  acao: string;
  grupo: GrupoAtalho;
}

/** A tabela crua, antes da tradução: a ação é a CHAVE, não a frase. */
interface AtalhoBruto {
  /** A tecla literal, ou vazia quando ela é palavra e vem de `teclaChave`. */
  tecla: string;
  /**
   * Para as "teclas" que são PALAVRA e não símbolo: `segurar` é um gesto, e
   * `:nº` tem uma abreviação de "número" dentro. As duas mudam de idioma; as
   * outras (`j/k`, `esc`, `␣`) não mudam em lugar nenhum.
   */
  teclaChave?: Chave;
  acao: Chave;
  grupo: GrupoAtalho;
}

/** Ordem e rótulo das seções da janela. `dev` não aparece em produção. */
const ORDEM_DOS_GRUPOS: readonly GrupoAtalho[] = ['tocar', 'ir', 'selecionar', 'janela', 'dev'];

/** Ordem e rótulo das seções, no idioma de agora. */
export function grupos(): readonly (readonly [GrupoAtalho, string])[] {
  return ORDEM_DOS_GRUPOS.map((g) => [g, traduzir(`atalho.grupo.${g}`)] as const);
}

const TABELA: readonly AtalhoBruto[] = [
  { tecla: '␣', acao: 'atalho.playPause', grupo: 'tocar' },
  { tecla: 'n/p', acao: 'atalho.proxAnterior', grupo: 'tocar' },
  { tecla: '←/→', acao: 'atalho.seek', grupo: 'tocar' },
  { tecla: 'l', acao: 'atalho.curtir', grupo: 'tocar' },
  { tecla: 'd', acao: 'atalho.baixar', grupo: 'tocar' },
  { tecla: 'c', acao: 'atalho.compartilhar', grupo: 'tocar' },
  { tecla: 's', acao: 'atalho.aleatorio', grupo: 'tocar' },
  { tecla: 'r', acao: 'atalho.repetir', grupo: 'tocar' },

  { tecla: 'j/k', acao: 'atalho.cursor', grupo: 'ir' },
  { tecla: 'enter', acao: 'atalho.tocarLinha', grupo: 'ir' },
  { tecla: ':', teclaChave: 'tecla.numero', acao: 'atalho.irPorNumero', grupo: 'ir' },
  // A mesma linha de comando, com um nome no lugar do número. Entra como linha
  // própria, e não como "nº ou recorte" na de cima, porque são dois destinos.
  { tecla: ':', teclaChave: 'tecla.recorte', acao: 'atalho.irPorRecorte', grupo: 'ir' },
  // Colchetes e não `h`/`l`: `l` já é curtir. E não as setas: elas são o seek.
  { tecla: '[/]', acao: 'atalho.recorteVizinho', grupo: 'ir' },
  { tecla: '/', acao: 'atalho.buscar', grupo: 'ir' },
  { tecla: '1', acao: 'atalho.irHome', grupo: 'ir' },
  { tecla: '2', acao: 'atalho.irBuscar', grupo: 'ir' },
  { tecla: '3', acao: 'atalho.irBiblioteca', grupo: 'ir' },

  // A marca é `x` e não espaço: espaço toca e pausa, e roubá-lo no modo de
  // seleção faria a mesma tecla fazer duas coisas opostas dependendo de um
  // estado que não está escrito em lugar nenhum da tela.
  { tecla: 'v', acao: 'atalho.marcar', grupo: 'selecionar' },
  // Um gesto numa tabela de teclas: é irregular, e entra mesmo assim porque
  // esta janela é a única referência do app, e porque segurar a linha é a
  // ÚNICA porta de quem não tem teclado — não há botão na tela.
  { tecla: '', teclaChave: 'tecla.segurar', acao: 'atalho.segurar', grupo: 'selecionar' },
  { tecla: 'x', acao: 'atalho.marcarLinha', grupo: 'selecionar' },
  // `a` e não `enter`: `enter` já é "tocar a linha marcada", e a mesma tecla
  // listada duas vezes na janela `?` não se explica — ela diria duas coisas
  // dependendo de um modo. Com `a`, o `enter` continua tocando a linha, o que
  // serve para ouvir a faixa antes de pôr na playlist.
  { tecla: 'a', acao: 'atalho.porNaPlaylist', grupo: 'selecionar' },
  { tecla: 'J/K', acao: 'atalho.moverNaPlaylist', grupo: 'selecionar' },

  { tecla: '0', acao: 'atalho.detalhesDaFaixa', grupo: 'janela' },
  { tecla: '4', acao: 'atalho.temas', grupo: 'janela' },
  { tecla: '5', acao: 'atalho.conta', grupo: 'janela' },
  { tecla: '7', acao: 'atalho.sobre', grupo: 'janela' },
  { tecla: '8', acao: 'atalho.idiomas', grupo: 'janela' },
  { tecla: '?|6', acao: 'atalho.estaJanela', grupo: 'janela' },
  { tecla: 'esc', acao: 'atalho.fecharJanela', grupo: 'janela' },

  { tecla: 'o', acao: 'atalho.simularOffline', grupo: 'dev' },
];

/** A referência completa. Sem `dev`, o grupo `dev` sai inteiro. */
export function atalhos(dev: boolean): readonly Atalho[] {
  const lista = dev ? TABELA : TABELA.filter((a) => a.grupo !== 'dev');
  // `|` separa teclas alternativas, e vira a conjunção do idioma: `? ou 6`
  // em português, `? or 6` em inglês. Escrevê-la na tabela deixaria um "ou"
  // português no meio de uma janela em espanhol.
  const ou = ' ' + traduzir('tecla.ou') + ' ';
  return lista.map((a) => ({
    tecla: (a.tecla + (a.teclaChave ? traduzir(a.teclaChave) : '')).split('|').join(ou),
    acao: traduzir(a.acao),
    grupo: a.grupo,
  }));
}

/**
 * Recorte para a status line, que é uma linha estreita e não cabe tudo.
 *
 * Mora ao lado da tabela, e não no componente do rodapé, para as duas listas
 * serem editadas de uma vez. É um resumo: `1-5 ir` cobre cinco teclas, e o
 * resto está a um `?` de distância.
 */
const LEGENDA_BRUTA: readonly (readonly [string, Chave])[] = [
  ['␣', 'legenda.play'],
  ['n/p', 'legenda.faixa'],
  ['←/→', 'legenda.seek'],
  ['/', 'legenda.buscar'],
  ['1-5', 'legenda.ir'],
  [':', 'legenda.numero'],
  ['?', 'legenda.atalhos'],
];

/** O resumo do rodapé, no idioma de agora. */
export function legenda(): readonly (readonly [string, string])[] {
  return LEGENDA_BRUTA.map(([tecla, chave]) => [tecla, traduzir(chave)] as const);
}
