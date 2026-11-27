import {
  AcervoError,
  canUpload,
  fmtBytes,
  rotuloDoLink,
  tErro,
  tituloDoArquivo,
  type EstadoEnvio,
  type LinkAchado,
} from '@ondas/core';
import { create } from 'zustand';
import { CATALOG_LOGADO_KEY } from '../query/catalog';
import { queryClient } from '../query/client';
import { acervoUploader, auth } from './services';
import { sessionStore } from './stores';

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
  /** Traz uma faixa por link (URL de mídia, YouTube ou SoundCloud). */
  adicionarLink(link: LinkAchado): Promise<void>;
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
    // A tela já esconde o painel de quem não pode enviar (`canUpload`); isto é
    // para o envio não depender de a tela ter lembrado. Quem recusa de verdade
    // continua sendo o servidor.
    if (!canUpload(sessionStore.getState().user)) return;

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
        // O limite vem em bytes e a frase o quer escrito ("60,0 MB"). Sem isto
        // a recusa por tamanho mostrava a marca `{limite}` crua.
        const limite = acervo?.params?.limite;
        const params = typeof limite === 'number' ? { limite: fmtBytes(limite) } : undefined;
        mudar(item.id, {
          estado: 'erro',
          // O código da API traduzido quando esta versão o conhece; senão a
          // frase que veio, como sempre foi.
          erro: tErro(acervo?.codigo, params) ?? (err instanceof Error ? err.message : 'falhou'),
          ...(acervo?.semSessao ? { semSessao: true } : {}),
        });
        // O admin tirou o envio desta conta com a tela aberta: a sessão que o
        // navegador guarda ainda diz que pode. Relê-la tira o painel da tela
        // (`canUpload`), e os arquivos que faltam da fila param aqui em vez de
        // ouvirem o mesmo "não" um por um.
        if (acervo?.codigo === 'envio_nao_permitido') {
          const user = await auth.restore();
          sessionStore.getState().setUser(user);
          const resto = new Set(novos.slice(i + 1).map((n) => n.id));
          set((st) => ({ itens: st.itens.filter((it) => !resto.has(it.id)) }));
          break;
        }
      }
    }
  },

  async adicionarLink(link) {
    if (!canUpload(sessionStore.getState().user)) return;

    const item: ItemEnvio = {
      id: `env-${++sequencia}`,
      nome: rotuloDoLink(link),
      estado: 'preparando',
      fracao: 0,
    };
    set((st) => ({ itens: [item, ...st.itens] }));
    const mudar = (mudanca: Partial<ItemEnvio>) =>
      set((st) => ({ itens: st.itens.map((i) => (i.id === item.id ? { ...i, ...mudanca } : i)) }));

    // Sem fila aqui, ao contrário dos arquivos: não há upload do aparelho para
    // disputar banda — quem baixa é o servidor —, e o teto de pedidos em
    // andamento é dele (`muitos_pedidos`).
    try {
      await acervoUploader.ingerirLink(link.url, {
        aoMudar: (p) => mudar({ estado: p.estado, fracao: p.fracao }),
      });
      await queryClient.invalidateQueries({ queryKey: CATALOG_LOGADO_KEY });
    } catch (err) {
      const acervo = err instanceof AcervoError ? err : null;
      mudar({
        estado: 'erro',
        erro: tErro(acervo?.codigo) ?? (err instanceof Error ? err.message : 'falhou'),
        ...(acervo?.semSessao ? { semSessao: true } : {}),
      });
      // A mesma régua do envio de arquivo: o admin tirou o envio com a tela
      // aberta, e reler a sessão é o que tira o painel dela.
      if (acervo?.codigo === 'envio_nao_permitido') {
        sessionStore.getState().setUser(await auth.restore());
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
