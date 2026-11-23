import { idioma } from '@ondas/core';
import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { t } from './i18n';

/**
 * Filtro de texto e ordenação por coluna, para qualquer tabela do painel.
 *
 * Tudo acontece NO NAVEGADOR, sobre as linhas que a API já mandou. É a escolha
 * certa para o tamanho que o painel tem (dezenas de contas, até 200 faixas por
 * pedido) e tem um limite que a tela diz em voz alta: numa lista que o
 * servidor corta (faixas, ingestões, histórico), filtrar e ordenar não
 * alcançam o que ficou de fora do corte.
 *
 * O estado mora no endereço (`?q=…&ord=-usado`), como o filtro de status já
 * morava: recarregar, voltar e mandar o link para si mesmo preservam o
 * recorte. Duas tabelas na mesma tela usam `prefixo` para não disputar as
 * mesmas chaves.
 */

export type Valor = string | number | boolean | null | undefined;

export interface Config<T> {
  /** Coluna ordenável → o valor que a representa. */
  colunas: Record<string, (item: T) => Valor>;
  /** O texto em que a busca procura. */
  texto: (item: T) => string;
  /** Colunas cujo primeiro clique ordena do MAIOR para o menor (tamanho, data). */
  descPrimeiro?: readonly string[];
  prefixo?: string;
}

export interface Lista<T> {
  visiveis: T[];
  /** Quantas linhas havia antes do filtro de texto. */
  total: number;
  busca: string;
  buscar: (q: string) => void;
  /** A coluna que ordena agora, ou `null` para a ordem em que o servidor mandou. */
  chave: string | null;
  desc: boolean;
  ordenar: (chave: string) => void;
}

/** Minúsculas e sem acento: `analise` acha `análise`. */
const plano = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

const vazio = (v: Valor): boolean => v === null || v === undefined || v === '';

export function useLista<T>(itens: readonly T[] | null | undefined, config: Config<T>): Lista<T> {
  const [params, setParams] = useSearchParams();
  const prefixo = config.prefixo ?? '';
  const chaveQ = prefixo + 'q';
  const chaveOrd = prefixo + 'ord';

  const busca = params.get(chaveQ) ?? '';
  const bruto = params.get(chaveOrd) ?? '';
  const desc = bruto.startsWith('-');
  const nome = desc ? bruto.slice(1) : bruto;
  // Coluna que não existe (endereço velho, digitado à mão) vale "sem ordem".
  const chave = Object.prototype.hasOwnProperty.call(config.colunas, nome) ? nome : null;

  const mudar = (k: string, v: string) =>
    setParams(
      (antes) => {
        const novo = new URLSearchParams(antes);
        if (v) novo.set(k, v);
        else novo.delete(k);
        return novo;
      },
      // Cada letra digitada não vira uma entrada no histórico do navegador.
      { replace: true },
    );

  const visiveis = useMemo(() => {
    let linhas = [...(itens ?? [])];
    const termos = plano(busca).split(/\s+/).filter(Boolean);
    if (termos.length > 0) {
      linhas = linhas.filter((item) => {
        const alvo = plano(config.texto(item));
        // Todos os termos, em qualquer ordem: `gmail aprovada` estreita.
        return termos.every((termo) => alvo.includes(termo));
      });
    }
    if (chave) {
      const valorDe = config.colunas[chave]!;
      const comparar = new Intl.Collator(idioma(), { numeric: true, sensitivity: 'base' });
      const sinal = desc ? -1 : 1;
      // `sort` é estável: no empate fica a ordem do servidor.
      linhas.sort((a, b) => {
        const va = valorDe(a);
        const vb = valorDe(b);
        // Sem valor vai para o fim nos DOIS sentidos: "nunca entrou" não é a
        // menor data, é a ausência dela.
        if (vazio(va) || vazio(vb)) return vazio(va) === vazio(vb) ? 0 : vazio(va) ? 1 : -1;
        if (typeof va === 'string' || typeof vb === 'string') {
          return sinal * comparar.compare(String(va), String(vb));
        }
        return sinal * (Number(va) - Number(vb));
      });
    }
    return linhas;
    // `config` é literal de módulo em quem chama; só os dados e o recorte mudam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itens, busca, chave, desc]);

  const ordenar = (c: string) => {
    const primeiroDesc = config.descPrimeiro?.includes(c) ?? false;
    // Três cliques: o sentido natural da coluna, o inverso, e de volta à ordem
    // do servidor.
    if (chave !== c) mudar(chaveOrd, (primeiroDesc ? '-' : '') + c);
    else if (desc === primeiroDesc) mudar(chaveOrd, (primeiroDesc ? '' : '-') + c);
    else mudar(chaveOrd, '');
  };

  return {
    visiveis,
    total: itens?.length ?? 0,
    busca,
    buscar: (q) => mudar(chaveQ, q),
    chave,
    desc,
    ordenar,
  };
}

/** Cabeçalho de coluna que ordena ao clique. */
export function ThOrd<T>({
  lista,
  chave,
  children,
  className,
  title,
}: {
  lista: Lista<T>;
  chave: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const ativa = lista.chave === chave;
  return (
    <th
      className={className}
      title={title}
      aria-sort={ativa ? (lista.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button type="button" className={ativa ? 'ord ativa' : 'ord'} onClick={() => lista.ordenar(chave)}>
        {children}
        {/* A seta é só para o olho: o sentido já está no `aria-sort`. */}
        <span className="seta" aria-hidden="true">
          {ativa ? (lista.desc ? '▼' : '▲') : ''}
        </span>
      </button>
    </th>
  );
}

/** O campo de filtro, com a contagem do que sobrou. */
export function Busca<T>({ lista, rotulo }: { lista: Lista<T>; rotulo: string }) {
  return (
    <div className="busca">
      <input
        type="search"
        value={lista.busca}
        onChange={(e) => lista.buscar(e.target.value)}
        aria-label={rotulo}
        placeholder={t('lista.filtrar')}
        autoComplete="off"
        spellCheck={false}
        size={22}
      />
      {lista.busca && (
        <span className="mudo" role="status">
          {t('lista.contagem', { n: lista.visiveis.length, total: lista.total })}
        </span>
      )}
    </div>
  );
}

/** Dito quando o filtro não deixou nada — uma tabela só de cabeçalho parece defeito. */
export function NadaCasa<T>({ lista }: { lista: Lista<T> }) {
  if (lista.total === 0 || lista.visiveis.length > 0) return null;
  return <p className="mudo">{t('lista.nadaCasa')}</p>;
}
