import { definirIdioma, LOCALES, type Locale } from '@ondas/core';

/**
 * Qual idioma o app fala, e como se troca de idioma.
 *
 * O endereço é a fonte da verdade: `/en/...` e `/es/...` são prefixados,
 * pt-BR fica na raiz. Essa assimetria é deliberada — todo link já
 * compartilhado de `music.thiagotn.com` continua valendo, e a prévia do
 * WhatsApp, que casa em `/t/`, segue casando para o português.
 *
 * A ordem de decisão no boot: o endereço manda; sem prefixo, a preferência
 * salva; sem ela, o navegador; e pt-BR de reserva.
 */

const CHAVE = 'ondas:idioma';

/** Os que entram na URL. pt-BR não tem prefixo — ele é a raiz. */
const PREFIXOS: Record<Locale, string> = { 'pt-BR': '', en: '/en', es: '/es' };

/** O prefixo que o `basename` do router recebe. */
export function prefixoDe(locale: Locale): string {
  return PREFIXOS[locale];
}

/** O idioma que o primeiro segmento do caminho anuncia, se anunciar algum. */
export function idiomaDoCaminho(pathname: string): Locale | null {
  const seg = pathname.split('/')[1];
  return LOCALES.find((l) => l !== 'pt-BR' && PREFIXOS[l] === '/' + seg) ?? null;
}

function salvo(): Locale | null {
  try {
    const v = localStorage.getItem(CHAVE);
    return LOCALES.find((l) => l === v) ?? null;
  } catch {
    // Modo privado, cookies bloqueados: a preferência some, o resto funciona.
    return null;
  }
}

/** O idioma do navegador, quando é um dos três. `pt` casa `pt-BR`. */
function doNavegador(): Locale | null {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (base === 'pt') return 'pt-BR';
    const achado = LOCALES.find((l) => l.toLowerCase().split('-')[0] === base);
    if (achado) return achado;
  }
  return null;
}

/**
 * Decide o idioma e o fixa no core. Roda UMA vez, antes de desenhar.
 *
 * Devolve o escolhido para o `basename` do router. Depois disto o valor não
 * muda enquanto a página viver — é o que torna seguro o idioma de módulo lá
 * no core (ver `i18n/motor.ts`).
 */
export function iniciarIdioma(): { locale: Locale; redirecionando: boolean } {
  const doPath = idiomaDoCaminho(location.pathname);
  const escolhido = doPath ?? salvo() ?? doNavegador() ?? 'pt-BR';

  // Chegou na raiz, mas o idioma dele não é o da raiz: manda para o endereço
  // que corresponde, porque o `basename` do router (`/en`) não casa com um
  // caminho sem prefixo.
  //
  // `replace` e não `assign`: o voltar tem de sair do site, e não cair de
  // volta na raiz para ser redirecionado de novo.
  //
  // E quem chama NÃO PODE desenhar depois disto. `location.replace` agenda a
  // navegação, não interrompe o script: montar o React aqui cria uma janela em
  // que o router tem `basename` de um idioma e a URL ainda é a do outro — e
  // nessa janela ele não casa rota nenhuma e pinta o fundo do tema e mais
  // nada. Era transitório num navegador rápido e permanente no app instalado,
  // que foi onde apareceu. Por isso o retorno diz se vai navegar.
  if (!doPath && escolhido !== 'pt-BR') {
    location.replace(prefixoDe(escolhido) + location.pathname + location.search + location.hash);
    return { locale: escolhido, redirecionando: true };
  }

  definirIdioma(escolhido);
  return { locale: escolhido, redirecionando: false };
}

/**
 * Troca de idioma NAVEGANDO, e não re-renderizando.
 *
 * O `basename` do router não muda com o router de pé, e metade das frases já
 * está montada em estado — um re-render deixaria a tela meio traduzida. Sair
 * e entrar de novo no mesmo endereço, sob o outro prefixo, garante catálogo,
 * `<html lang>` e formatação de número coerentes.
 *
 * O preço é o estado não persistido da tela, e ele é aceitável: trocar de
 * idioma é gesto deliberado e raro.
 */
export function trocarIdioma(destino: Locale): void {
  try {
    localStorage.setItem(CHAVE, destino);
  } catch {
    // Sem onde guardar, a escolha vale só para esta navegação.
  }
  const atual = idiomaDoCaminho(location.pathname);
  const semPrefixo = atual ? location.pathname.slice(PREFIXOS[atual].length) : location.pathname;
  const caminho = prefixoDe(destino) + (semPrefixo || '/');
  location.assign(caminho + location.search + location.hash);
}
