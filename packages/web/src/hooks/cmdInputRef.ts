import { createRef } from 'react';

/**
 * O `:` precisa focar a linha de comando do prompt de qualquer aba, então a
 * ref é um singleton em vez de atravessar a árvore por contexto. Mesmo motivo
 * do `searchInputRef`.
 */
export const cmdInputRef = createRef<HTMLInputElement>();
