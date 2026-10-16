import { createRef } from 'react';

/**
 * O atalho `/` precisa focar o campo de busca de qualquer aba, então a ref é
 * um singleton em vez de atravessar a árvore por contexto.
 */
export const searchInputRef = createRef<HTMLInputElement>();
