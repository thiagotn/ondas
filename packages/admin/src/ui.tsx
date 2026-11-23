import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ErroDaApi } from './api';
import { fmtBytes } from './formato';

/**
 * Carrega um dado da API e sabe recarregar. Sem biblioteca de cache de
 * propósito: painel de admin quer o dado de AGORA, e cada tela faz um ou dois
 * pedidos.
 */
export function useDados<T>(buscar: () => Promise<T>, deps: readonly unknown[]) {
  const [dados, setDados] = useState<T | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const pedido = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const funcao = useCallback(buscar, deps);

  const recarregar = useCallback(async () => {
    const meu = ++pedido.current;
    setCarregando(true);
    try {
      const r = await funcao();
      // Resposta de um pedido antigo (filtro trocado no meio) não pode
      // sobrescrever a do mais novo.
      if (meu !== pedido.current) return;
      setDados(r);
      setErro(null);
    } catch (e) {
      if (meu !== pedido.current) return;
      setErro(e instanceof Error ? e.message : 'falha ao carregar');
    } finally {
      if (meu === pedido.current) setCarregando(false);
    }
  }, [funcao]);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  return { dados, erro, carregando, recarregar };
}

/** Roda uma escrita e guarda a falha para mostrar ao lado do botão. */
export function useAcao() {
  const [ocupado, setOcupado] = useState(false);
  const [falha, setFalha] = useState<string | null>(null);

  const rodar = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setOcupado(true);
    setFalha(null);
    try {
      await fn();
      return true;
    } catch (e) {
      // 401 já mandou a tela para a entrada; não há o que mostrar aqui.
      if (!(e instanceof ErroDaApi && e.status === 401)) {
        setFalha(e instanceof Error ? e.message : 'falhou');
      }
      return false;
    } finally {
      setOcupado(false);
    }
  }, []);

  return { ocupado, falha, rodar, limpar: () => setFalha(null) };
}

/**
 * O que mostrar enquanto o dado não está na tela. `tem` é "já há algo para
 * desenhar": numa recarga a tabela antiga fica visível em vez de piscar.
 */
export function Estado({
  carregando,
  erro,
  tem,
  vazio,
  children,
}: {
  carregando: boolean;
  erro: string | null;
  tem: boolean;
  vazio?: string | false;
  children: ReactNode;
}) {
  if (erro) return <p className="erro">erro: {erro}</p>;
  if (!tem) return <p className="mudo">{carregando ? '⠋ carregando…' : 'nada aqui.'}</p>;
  if (vazio) return <p className="mudo">{vazio}</p>;
  return <>{children}</>;
}

/** `[x]` / `[ ]` clicável — o mesmo vocabulário do `ondas whoami`. */
export function Marca({
  ligado,
  rotulo,
  aoMudar,
  desabilitado,
}: {
  ligado: boolean;
  rotulo: string;
  aoMudar: (novo: boolean) => void;
  desabilitado?: boolean;
}) {
  return (
    <button
      type="button"
      className="marca"
      role="switch"
      aria-checked={ligado}
      aria-label={rotulo}
      title={rotulo}
      disabled={desabilitado}
      onClick={(e) => {
        e.stopPropagation();
        aoMudar(!ligado);
      }}
    >
      <span className={ligado ? 'ok' : 'mudo'}>{ligado ? '[x]' : '[ ]'}</span>
    </button>
  );
}

/**
 * Botão de ação sem volta: o primeiro clique pergunta, o segundo faz. Sem
 * `confirm()` nativo, pelo mesmo motivo do app — e porque um diálogo modal do
 * navegador não diz O QUE vai ser apagado.
 */
export function Confirmar({
  rotulo,
  pergunta,
  aoConfirmar,
  desabilitado,
}: {
  rotulo: string;
  pergunta: string;
  aoConfirmar: () => void;
  desabilitado?: boolean;
}) {
  const [aberto, setAberto] = useState(false);
  if (!aberto) {
    return (
      <button
        type="button"
        className="perigo"
        disabled={desabilitado}
        onClick={(e) => {
          e.stopPropagation();
          setAberto(true);
        }}
      >
        {rotulo}
      </button>
    );
  }
  return (
    <span className="confirma" onClick={(e) => e.stopPropagation()}>
      <span className="aviso">{pergunta}</span>
      <button
        type="button"
        className="perigo"
        onClick={() => {
          setAberto(false);
          aoConfirmar();
        }}
      >
        [sim]
      </button>
      <button type="button" className="link" onClick={() => setAberto(false)}>
        [não]
      </button>
    </span>
  );
}

/** Ocupação contra a cota: a barra de blocos do terminal e os dois números. */
export function Uso({ usado, cota }: { usado: number; cota: number }) {
  const LARGURA = 10;
  const fracao = cota > 0 ? usado / cota : usado > 0 ? 1 : 0;
  const cheios = Math.min(LARGURA, Math.round(fracao * LARGURA));
  const acima = usado > cota;
  return (
    <span className="uso" title={`${Math.round(fracao * 100)}% da cota`}>
      <span className={acima ? 'erro' : 'destaque'} aria-hidden="true">
        {'█'.repeat(cheios)}
      </span>
      <span className="apagado" aria-hidden="true">
        {'░'.repeat(LARGURA - cheios)}
      </span>{' '}
      <span className={acima ? 'erro' : undefined}>
        {fmtBytes(usado)} de {fmtBytes(cota)}
      </span>
    </span>
  );
}

export function Segmentos<T extends string>({
  opcoes,
  valor,
  aoMudar,
  rotulo,
}: {
  opcoes: readonly { valor: T; rotulo: string }[];
  valor: T;
  aoMudar: (v: T) => void;
  rotulo: string;
}) {
  return (
    <div className="segmentos" role="group" aria-label={rotulo}>
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          className={o.valor === valor ? 'segmento ativo' : 'segmento'}
          aria-pressed={o.valor === valor}
          onClick={() => aoMudar(o.valor)}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}
