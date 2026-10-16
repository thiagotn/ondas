import { AudiusCatalogClient, LocalAuthService } from '@ondas/core';
import { BrowserConnectivity } from '../platform/BrowserConnectivity';
import { CacheOfflineStore } from '../platform/CacheOfflineStore';
import { IdbKeyValueStore } from '../platform/IdbKeyValueStore';
import { WebPlayerEngine } from '../platform/WebPlayerEngine';

/** Implementações web dos ports de `core`. Trocar de plataforma é trocar este arquivo. */
export const kv = new IdbKeyValueStore();
export const auth = new LocalAuthService(kv);
export const offlineStore = new CacheOfflineStore();
export const connectivity = new BrowserConnectivity();
export const catalogClient = new AudiusCatalogClient();
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
