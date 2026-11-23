import {
  BANDEIRAS,
  idioma,
  LOCALES,
  NOMES_DE_IDIOMA,
  THEMES,
  type Locale,
  type ThemeId,
} from '@ondas/core';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ErroDaApi } from './api';
import { fmtBytes } from './formato';
import { t } from './i18n';
import { temaAtual, trocarIdioma, trocarTema } from './prefs';

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
      setErro(e instanceof Error ? e.message : t('comum.falhaCarregar'));
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
        setFalha(e instanceof Error ? e.message : t('comum.falhou'));
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
  if (erro) return <p className="erro">{t('comum.erro', { msg: erro })}</p>;
  if (!tem) return <p className="mudo">{carregando ? t('comum.carregando') : t('comum.nadaAqui')}</p>;
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
        {t('comum.sim')}
      </button>
      <button type="button" className="link" onClick={() => setAberto(false)}>
        {t('comum.nao')}
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
    <span className="uso" title={t('uso.porcento', { p: Math.round(fracao * 100) })}>
      <span className={acima ? 'erro' : 'destaque'} aria-hidden="true">
        {'█'.repeat(cheios)}
      </span>
      <span className="apagado" aria-hidden="true">
        {'░'.repeat(LARGURA - cheios)}
      </span>{' '}
      <span className={acima ? 'erro' : undefined}>
        {t('uso.de', { usado: fmtBytes(usado), cota: fmtBytes(cota) })}
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

/**
 * Um botão que abre uma lista de escolha única — o seletor de tema e o de
 * idioma. Sem `<select>` nativo: a lista dele é desenhada pelo sistema, fora
 * do tema, e era a única coisa do painel que não pareceria o produto.
 *
 * `curto` é o que o botão mostra em tela estreita, onde a barra do topo já
 * disputa espaço com as abas; o nome completo continua no `aria-label`.
 */
export function Menu<T extends string>({
  rotulo,
  curto,
  texto,
  opcoes,
  valor,
  aoEscolher,
}: {
  rotulo: string;
  curto: ReactNode;
  texto: string;
  opcoes: readonly { valor: T; rotulo: ReactNode; lang?: string }[];
  valor: T;
  aoEscolher: (v: T) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!aberto) return;
    // Abre com o foco na opção marcada: seta para cima e para baixo já andam
    // a partir de onde a pessoa está.
    caixa.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const fora = (e: PointerEvent) => {
      if (!caixa.current?.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener('pointerdown', fora);
    return () => document.removeEventListener('pointerdown', fora);
  }, [aberto]);

  const fechar = () => {
    setAberto(false);
    botao.current?.focus();
  };

  return (
    <div
      className="menu"
      ref={caixa}
      onKeyDown={(e) => {
        if (!aberto) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          fechar();
          return;
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const itens = [...(caixa.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
        const atual = itens.indexOf(document.activeElement as HTMLElement);
        const passo = e.key === 'ArrowDown' ? 1 : -1;
        itens[(atual + passo + itens.length) % itens.length]?.focus();
      }}
    >
      <button
        type="button"
        ref={botao}
        className="link menu-botao"
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-controls={aberto ? id : undefined}
        aria-label={`${rotulo}: ${texto}`}
        title={rotulo}
        onClick={() => setAberto((a) => !a)}
      >
        <span aria-hidden="true">{curto}</span>
        <span className="menu-texto" aria-hidden="true">
          {texto}
        </span>
      </button>
      {aberto && (
        <div className="menu-lista" role="menu" id={id} aria-label={rotulo}>
          {opcoes.map((o) => (
            <button
              key={o.valor}
              type="button"
              role="menuitemradio"
              aria-checked={o.valor === valor}
              lang={o.lang}
              className={o.valor === valor ? 'menu-item ativo' : 'menu-item'}
              onClick={() => {
                fechar();
                if (o.valor !== valor) aoEscolher(o.valor);
              }}
            >
              {o.rotulo}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Tema e idioma, lado a lado — na barra do topo e na tela de entrada.
 *
 * O tema vive em estado aqui só para o botão mostrar o nome certo: quem
 * pinta a tela é `trocarTema`, que escreve os tokens em `:root`. O idioma não
 * precisa de estado, porque trocá-lo recarrega a página.
 */
export function Preferencias() {
  const [tema, setTema] = useState<ThemeId>(temaAtual);
  const atual = THEMES.find((x) => x.id === tema) ?? THEMES[0]!;
  return (
    <div className="prefs">
      <Menu<ThemeId>
        rotulo={t('prefs.tema')}
        curto="◐"
        texto={atual.name.toLowerCase()}
        valor={tema}
        aoEscolher={(v) => {
          trocarTema(v);
          setTema(v);
        }}
        opcoes={THEMES.map((x) => ({
          valor: x.id,
          rotulo: (
            <>
              {/* As cores DO tema da linha, e não as do tema atual: é a
                  amostra do que a pessoa vai receber. */}
              <span className="amostra" aria-hidden="true" style={{ background: x.bg }}>
                <span style={{ color: x.accent }}>●</span>
                <span style={{ color: x.ansi[2] }}>●</span>
                <span style={{ color: x.ansi[1] }}>●</span>
              </span>
              {x.name.toLowerCase()}
            </>
          ),
        }))}
      />
      <Menu<Locale>
        rotulo={t('prefs.idioma')}
        curto={BANDEIRAS[idioma()]}
        texto={idioma()}
        valor={idioma()}
        aoEscolher={trocarIdioma}
        // Cada idioma no próprio idioma, com o `lang` dele: é o que o leitor
        // de tela usa para pronunciar certo.
        opcoes={LOCALES.map((l) => ({
          valor: l,
          lang: l,
          rotulo: `${BANDEIRAS[l]} ${NOMES_DE_IDIOMA[l]}`,
        }))}
      />
    </div>
  );
}
