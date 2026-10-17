import {
  AcervoCatalogClient,
  AcervoUploader,
  AudiusCatalogClient,
  HttpAuthService,
} from '@ondas/core';
import { BrowserConnectivity } from '../platform/BrowserConnectivity';
import { CacheOfflineStore } from '../platform/CacheOfflineStore';
import { IdbKeyValueStore } from '../platform/IdbKeyValueStore';
import { WebPlayerEngine } from '../platform/WebPlayerEngine';
import { enviarParaR2 } from '../platform/XhrEnviador';

/** Implementações web dos ports de `core`. Trocar de plataforma é trocar este arquivo. */
export const kv = new IdbKeyValueStore();
/**
 * Auth contra a nossa API. O `LocalAuthService` continua existindo em `core`
 * como implementação de referência dos testes de domínio — aqui, em produção,
 * a senha é conferida no servidor (argon2id) e a sessão é um cookie HttpOnly
 * que este código não consegue ler.
 */
export const auth = new HttpAuthService(kv);
export const offlineStore = new CacheOfflineStore();
export const connectivity = new BrowserConnectivity();
export const catalogClient = new AudiusCatalogClient();
/** Segunda fonte do catálogo: as faixas próprias, só para quem está logado. */
export const acervoClient = new AcervoCatalogClient();
/**
 * Envio de arquivo local para o acervo. Os bytes vão do navegador DIRETO para
 * o R2 (PUT assinado); a nossa API só reserva a vaga e enfileira a ingestão.
 */
export const acervoUploader = new AcervoUploader<File>({ enviarBytes: enviarParaR2 });
export const engine = new WebPlayerEngine();

/** Flag de dev: força o catálogo demo sem bater na API. */
export const FORCE_DEMO = import.meta.env['VITE_FORCE_DEMO'] === 'true';

/** Abertura no boot. Ligada por padrão; `VITE_SHOW_SPLASH=false` desliga. */
export const SHOW_SPLASH = import.meta.env['VITE_SHOW_SPLASH'] !== 'false';

/**
 * Opacidade do fundo quando o usuário ainda não escolheu uma
 * (`VITE_DEFAULT_OPACITY`, 0.3–1). O valor salvo sempre tem prioridade.
 */
export const DEFAULT_OPACITY = Number(import.meta.env['VITE_DEFAULT_OPACITY'] ?? 1) || 1;
