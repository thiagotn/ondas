import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Filtro de tela guardado na query, com o valor padrão fora do endereço.
 *
 * Na query, e não em estado solto: `/?genre=jazz` e `/search?q=mar` são
 * linkáveis e sobrevivem a um reload, que é o que o chip e o campo de busca
 * em memória não faziam.
 *
 * `modo` é a diferença entre um chip e um campo de texto. O chip é uma escolha
 * e vale um "voltar"; digitar letra a letra empilharia um passo de histórico
 * por caractere, então o campo escreve com `replace`.
 */
export function useQueryParam(
  key: string,
  padrao: string,
  modo: 'push' | 'replace',
): readonly [string, (next: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? padrao;

  const set = useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const proximos = new URLSearchParams(prev);
          // O padrão sai do endereço em vez de virar `?genre=tudo`: a URL
          // limpa é a mesma coisa, e é ela que se manda para alguém.
          if (next === padrao) proximos.delete(key);
          else proximos.set(key, next);
          return proximos;
        },
        { replace: modo === 'replace', preventScrollReset: true },
      );
    },
    [key, padrao, modo, setParams],
  );

  return [value, set] as const;
}
