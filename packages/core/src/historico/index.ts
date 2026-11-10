export {
  ESPELHAR_A_CADA_MS,
  LIMIAR_DE_ESCUTA_S,
  OBSERVADOR_VAZIO,
  SUBIR_A_CADA_MS,
  decidirRestauracao,
  leEspelho,
  leMarcador,
  limiarDeEscuta,
  maisNovo,
  marcadorDaAmostra,
  observar,
  posicaoDeRetomada,
} from './marcador.js';
export type { Amostra, Efeito, EspelhoDoMarcador, EstadoDoObservador } from './marcador.js';
export {
  MAX_NA_FILA,
  comAFila,
  enfileirar as enfileirarNoHistorico,
  faixasDoHistorico,
  leItens as leItensDoHistorico,
  retratoDe,
  semOQueSubiu as semOQueSubiuDoHistorico,
} from './fila.js';
export { HttpHistoricoService } from './http.js';
