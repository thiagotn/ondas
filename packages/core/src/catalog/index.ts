export type { CatalogClient, TrendingOptions } from './client.js';
export { AudiusCatalogClient } from './audius.js';
export { AcervoCatalogClient, AcervoError } from './acervo.js';
export { DemoCatalogClient, demoTracks } from './demo.js';
export { artworkHosts, artworkSources } from './artwork.js';
export { CATALOG_CACHE_MAX_AGE_MS, comFaixasAvulsas, loadCatalog, MAX_AVULSAS } from './resolve.js';
export type { CachedCatalog, LoadCatalogDeps } from './resolve.js';
