/**
 * Armazenamento das faixas baixadas. Na web é a Cache API (`ondas-offline`);
 * no nativo será `expo-file-system`.
 */
export interface OfflineUsage {
  /** Bytes usados pelas faixas baixadas (soma do índice). */
  bytes: number;
  /** Cota do dispositivo, quando a plataforma informa. */
  quota?: number;
}

export interface OfflineStore {
  has(id: string): Promise<boolean>;
  /** Fonte tocável para a faixa (object URL na web, caminho no nativo). */
  get(id: string): Promise<string | null>;
  /** Baixa e grava, reportando progresso 0..1. Devolve o tamanho em bytes. */
  put(id: string, url: string, onProgress?: (p: number) => void): Promise<number>;
  remove(id: string): Promise<void>;
  usage(): Promise<OfflineUsage>;
  /** Ids realmente presentes — usado para reconciliar o índice no boot. */
  keys(): Promise<string[]>;
}
