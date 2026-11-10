import type { ItemDoHistorico } from '@ondas/core';
import { useQuery } from '@tanstack/react-query';
import { lerHistorico } from '../app/historico';
import { useSession } from '../app/stores';

/**
 * O histórico da conta.
 *
 * É a única consulta além do catálogo que guarda dado de UMA conta, e como ela
 * o cache inteiro vai para o IndexedDB (`main.tsx`). Daí a chave ser exportada:
 * `esquecer()` em `app/historico.ts` a remove no logout e no 401, pelo mesmo
 * motivo de `CATALOG_LOGADO_KEY` — o que uma conta ouviu não pode ficar no
 * aparelho à espera da próxima.
 */
export const HISTORICO_KEY = ['historico'] as const;

export function useHistorico() {
  const user = useSession((s) => s.user);
  return useQuery<ItemDoHistorico[]>({
    queryKey: HISTORICO_KEY,
    // Sem conta não há histórico, e nem vale pedir: a API responderia 401.
    enabled: !!user,
    queryFn: ({ signal }) => lerHistorico(signal),
    // Quem escreve aqui é `app/historico.ts`, com a resposta de cada subida —
    // que é a coleção inteira. O refetch só serve para o que foi ouvido em
    // OUTRO aparelho, e para isso abrir o recorte basta.
    staleTime: 0,
  });
}
