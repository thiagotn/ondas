import { AcervoError, tituloDoArquivo, type EstadoEnvio } from '@ondas/core';
import { create } from 'zustand';
import { CATALOG_LOGADO_KEY } from '../query/catalog';
import { queryClient } from '../query/client';
import { acervoUploader } from './services';

export interface ItemEnvio {
  /** Id local da fila da tela — não é o id do envio na API. */
  id: string;
  nome: string;
  estado: EstadoEnvio;
  /** 0 a 1 dos bytes enviados ao bucket. */
  fracao: number;
  erro?: string;
  /** Se a sessão caiu: a tela manda entrar de novo em vez de culpar o arquivo. */
  semSessao?: boolean;
}

interface Uploads {
  itens: ItemEnvio[];
  enviar(arquivos: File[]): Promise<void>;
  remover(id: string): void;
  limparConcluidos(): void;
}

let sequencia = 0;

/**
 * Fila de envios da tela.
 *
 * Store e não estado do componente porque o envio **sobrevive à troca de
 * aba**: o XHR continua, e se o progresso morasse no componente a barra
 * voltaria do zero (ou desapareceria) ao sair da biblioteca e voltar.
 */
export const useUploads = create<Uploads>((set) => ({
  itens: [],

  async enviar(arquivos) {
    const novos: ItemEnvio[] = arquivos.map((a) => ({
      id: `env-${++sequencia}`,
      nome: tituloDoArquivo(a.name) || a.name,
      estado: 'preparando' as const,
      fracao: 0,
    }));
    set((st) => ({ itens: [...novos, ...st.itens] }));

    const mudar = (id: string, mudanca: Partial<ItemEnvio>) =>
      set((st) => ({
        itens: st.itens.map((i) => (i.id === id ? { ...i, ...mudanca } : i)),
      }));

    // Um por vez, de propósito: o link de casa é residencial e o gargalo é o
    // upload. Em paralelo, três arquivos terminariam todos mais devagar e a
    // barra de cada um andaria em espasmos.
    for (const [i, arquivo] of arquivos.entries()) {
      const item = novos[i];
      if (!item) continue;
      try {
        await acervoUploader.enviar(arquivo, {
          aoMudar: (p) => mudar(item.id, { estado: p.estado, fracao: p.fracao }),
        });
        // A faixa nova só aparece na lista se o catálogo do logado for
        // relido: o cache dele tem 5 minutos de frescor.
        //
        // Pelo PREFIXO, não por um dos dois escopos: quem desligou o catálogo
        // público está no outro, e invalidar só um faria o envio não aparecer
        // justamente para quem usa o acervo puro.
        await queryClient.invalidateQueries({ queryKey: CATALOG_LOGADO_KEY });
      } catch (err) {
        const acervo = err instanceof AcervoError ? err : null;
        mudar(item.id, {
          estado: 'erro',
          erro: err instanceof Error ? err.message : 'falhou',
          ...(acervo?.semSessao ? { semSessao: true } : {}),
        });
      }
    }
  },

  remover: (id) => set((st) => ({ itens: st.itens.filter((i) => i.id !== id) })),

  limparConcluidos: () =>
    set((st) => ({ itens: st.itens.filter((i) => i.estado !== 'pronto' && i.estado !== 'erro') })),
}));

/** Quantos envios ainda estão em andamento — a tela usa para avisar antes de sair. */
export const emAndamento = (itens: ItemEnvio[]): number =>
  itens.filter((i) => i.estado !== 'pronto' && i.estado !== 'erro').length;
