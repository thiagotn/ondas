import {
  AuthError,
  CAMPOS_DE_PREFS,
  decidirPrefs,
  lePrefs,
  type BackgroundSettings,
  type Locale,
  type PrefsDaConta,
  type User,
} from '@ondas/core';
import { storeTheme, temaSalvo } from '../theme/applyTheme';
import { idiomaSalvo } from './idioma';
import { auth, kv } from './services';
import { BACKGROUND_KEY, sessionStore, uiStore } from './stores';

/**
 * A aparência segue a conta: tema, idioma e os ajustes do fundo.
 *
 * O desenho é o da curtida (`likes.ts`) sem a coleção: o servidor é o dono, o
 * que este aparelho guarda (`localStorage` do tema e do idioma, IndexedDB do
 * fundo) é espelho, e o que foi mudado aqui e ainda não subiu fica numa fila —
 * que aqui é um objeto parcial, porque cada campo só tem um valor por vez.
 *
 * NÃO há leitura própria. As preferências chegam dentro do usuário que o
 * `/me` do boot e o `/login` já devolvem; este arquivo só decide o que fazer
 * com elas (`decidirPrefs`, no core) e sobe o que mudou. A consequência, que é
 * escolha: um aparelho que fica aberto por dias só vê a mudança feita em outro
 * no próximo boot.
 *
 * A IMAGEM de fundo não passa por aqui. Ela fica no aparelho que a escolheu.
 */

/** O que foi mudado aqui, com sessão, e ainda não chegou ao servidor. */
export const PREFS_PENDENTE_KEY = 'prefs-pendente';
/**
 * Marca que este APARELHO já entregou a uma conta o que tinha de antes.
 *
 * Como a `likes-adotadas`, é um marcador de migração — mas este nunca é
 * apagado, nem no logout. A curtida adotada some do aparelho ao sair, então lá
 * a marca pode voltar; o tema fica na tela, e sem a marca ele seria gravado na
 * próxima conta que entrasse neste navegador.
 */
export const PREFS_ADOTADAS_KEY = 'prefs-adotadas';

/** Arrastar o slider de transparência é um PATCH, não trinta. */
const DEBOUNCE_MS = 800;

let pendente: PrefsDaConta | null = null;
let carregando: Promise<void> | null = null;
let agendado: ReturnType<typeof setTimeout> | null = null;
let rodando: Promise<void> | null = null;
let deNovo = false;
let iniciando: Promise<Locale | null> | null = null;
/** Ligada enquanto ESTE arquivo mexe no store — ver `ligar`. */
let semEco = false;

const vazio = (p: PrefsDaConta) => Object.keys(p).length === 0;

/**
 * Lê a fila do disco uma vez. A promessa é guardada, e não só o resultado: dois
 * gestos seguidos logo depois do boot leriam o disco duas vezes, e a segunda
 * leitura a chegar apagaria da memória o que a primeira acabou de enfileirar.
 */
async function carregar(): Promise<PrefsDaConta> {
  if (!pendente) {
    carregando ??= kv.get(PREFS_PENDENTE_KEY).then((bruto) => {
      pendente ??= lePrefs(bruto);
    });
    await carregando;
  }
  return pendente!;
}

async function gravar(nova: PrefsDaConta): Promise<void> {
  pendente = nova;
  if (vazio(nova)) await kv.remove(PREFS_PENDENTE_KEY);
  else await kv.set(PREFS_PENDENTE_KEY, nova);
}

/**
 * Mexe no store SEM que isso conte como gesto de quem usa.
 *
 * Tudo que aplica valor vindo de fora — a conta, ou o IndexedDB no boot —
 * passa por aqui. Sem isto, aplicar o tema da conta dispararia `ligar`, que o
 * mandaria de volta para a conta: um PATCH por boot, para sempre, e a regra
 * "este aparelho não escreveu nada" deixaria de valer.
 *
 * Funciona porque o `subscribe` do store é síncrono: quando o `set` volta, o
 * ouvinte já rodou.
 */
export function aplicarSemEco(mexer: () => void): void {
  semEco = true;
  try {
    mexer();
  } finally {
    semEco = false;
  }
}

/**
 * Observa o store e enfileira o que a pessoa mudou.
 *
 * Observar, em vez de chamar `registrar` de cada botão, é o que cobre os
 * caminhos que ninguém lembraria: enviar uma imagem troca `wall` e pode trocar
 * `opacity` (`setWallImage`), e o tema muda pelo clique, pelo `enter` do
 * seletor e pela tela de login. `wallImg` fica de fora de propósito.
 *
 * A pré-visualização do seletor de tema não passa por aqui: ela pinta sem
 * tocar `themeId`, então só o tema confirmado sobe.
 */
export function ligar(): () => void {
  return uiStore.subscribe((st, prev) => {
    if (semEco) return;
    const mudou: PrefsDaConta = {};
    if (st.themeId !== prev.themeId) mudou.tema = st.themeId;
    if (st.opacity !== prev.opacity) mudou.opacity = st.opacity;
    if (st.blur !== prev.blur) mudou.blur = st.blur;
    if (st.wall !== prev.wall) mudou.wall = st.wall;
    if (!vazio(mudou)) void registrar(mudou);
  });
}

/**
 * Enfileira uma mudança que já valeu na tela.
 *
 * Sem conta não faz nada: a aparência do visitante é só deste aparelho, como
 * sempre foi. E com conta num servidor de antes das preferências
 * (`prefs === undefined`) também não — a fila cresceria para uma rota que a
 * recusa.
 *
 * `agora` é para o idioma, que recarrega a página em seguida: não há 800 ms
 * para esperar. A promessa resolve quando a fila está NO DISCO, e não quando o
 * servidor respondeu — é o disco que garante a entrega se a página morrer
 * antes, e esperar a rede seguraria a troca de idioma por ela.
 */
export async function registrar(mudou: PrefsDaConta, o?: { agora?: boolean }): Promise<void> {
  const user = sessionStore.getState().user;
  if (!user || user.prefs === undefined) return;
  const limpo = lePrefs(mudou);
  if (vazio(limpo)) return;
  await gravar({ ...(await carregar()), ...limpo });

  if (agendado) clearTimeout(agendado);
  agendado = null;
  if (o?.agora) {
    void subirPendente({ keepalive: true });
    return;
  }
  agendado = setTimeout(() => {
    agendado = null;
    void subirPendente();
  }, DEBOUNCE_MS);
}

/**
 * Sobe a fila. Chamada pelo debounce, quando a rede volta, no boot e antes do
 * logout — nenhum deles é um laço.
 */
export function subirPendente(o?: { keepalive?: boolean }): Promise<void> {
  // O debounce pendente perde a razão de ser: a subida é agora. Sem isto o
  // logout subiria a fila e o timer dispararia depois, contra um cookie morto.
  if (agendado) {
    clearTimeout(agendado);
    agendado = null;
  }
  if (!sessionStore.getState().user) return Promise.resolve();
  // Uma de cada vez. O que chegar durante o voo não é perdido: a fila já o
  // tem, e `deNovo` faz a subida repetir quando esta voltar.
  if (rodando) {
    deNovo = true;
    return rodando;
  }
  rodando = executar(o).finally(() => {
    rodando = null;
  });
  return rodando;
}

async function executar(o?: { keepalive?: boolean }): Promise<void> {
  do {
    deNovo = false;
    const enviado = { ...(await carregar()) };
    if (vazio(enviado)) return;
    try {
      await auth.setPrefs(enviado, o);
    } catch (err) {
      // O 401 é a sessão que morreu: a fila era dela, e não pode sobrar para a
      // próxima conta que entrar aqui.
      if (err instanceof AuthError && err.codigo === 'sessao_expirada') await esquecer();
      // "Requisição inválida" é o servidor recusando o CONTEÚDO, e ele vai
      // recusar de novo: guardar seria tentar para sempre. A preferência
      // continua valendo neste aparelho, só não viaja.
      else if (err instanceof AuthError && err.codigo === 'requisicao_invalida') await gravar({});
      // Todo o resto — sem rede, 5xx — deixa a fila intacta. Quem tenta de novo
      // é a rede voltando, o próximo gesto ou o próximo boot.
      return;
    }
    // A fila só perde o que de fato subiu, e só se ninguém mexeu de novo no
    // mesmo campo durante o voo.
    const sobrou: Record<string, unknown> = { ...(await carregar()) };
    for (const k of CAMPOS_DE_PREFS) if (sobrou[k] === enviado[k]) delete sobrou[k];
    await gravar(sobrou as PrefsDaConta);
    if (!vazio(sobrou as PrefsDaConta)) deNovo = true;
  } while (deNovo);
}

/**
 * Põe o aparelho de acordo com a conta. Roda quando a sessão chega: no boot
 * (`hydrate`) e depois do login.
 *
 * Aplica o tema e o fundo, sobe o que couber, e DEVOLVE o idioma que a conta
 * quer quando ele não é o que este aparelho tem guardado. Devolve em vez de
 * aplicar porque trocar de idioma é navegar, e quem sabe para onde é quem
 * chamou (ver `adotarIdiomaDaConta`).
 */
export function iniciar(user: User): Promise<Locale | null> {
  // O StrictMode roda o `hydrate` duas vezes em dev; a segunda pega a primeira.
  iniciando ??= executarInicio(user).finally(() => {
    iniciando = null;
  });
  return iniciando;
}

async function executarInicio(user: User): Promise<Locale | null> {
  if (user.prefs === undefined) return null;

  const [fundo, adotado, fila] = await Promise.all([
    kv.get<BackgroundSettings>(BACKGROUND_KEY),
    kv.get<boolean>(PREFS_ADOTADAS_KEY),
    carregar(),
  ]);
  // Só o que foi ESCOLHIDO aqui. O padrão em vigor não é escolha, e subi-lo
  // gravaria na conta um tema que ninguém pediu.
  const tema = temaSalvo();
  const idioma = idiomaSalvo();
  const local: PrefsDaConta = {
    ...(tema ? { tema } : {}),
    ...(idioma ? { idioma } : {}),
    ...(fundo ? { opacity: fundo.opacity, blur: fundo.blur, wall: fundo.wall } : {}),
  };
  const { subir, aplicar } = decidirPrefs({
    conta: user.prefs,
    local,
    pendente: fila,
    adotado: adotado === true,
  });

  aplicarSemEco(() => {
    const ui = uiStore.getState();
    if (aplicar.tema) {
      // O `localStorage` é o que o script do `index.html` lê antes do primeiro
      // paint: regravá-lo aqui é o que faz o PRÓXIMO boot já abrir certo, sem
      // piscar no tema antigo. Quem repinta agora é o efeito do `App`.
      storeTheme(aplicar.tema);
      ui.setThemeId(aplicar.tema);
    }
    // Sem `wallImg`: a imagem é deste aparelho e fica como está.
    ui.hydrateBackground({
      ...(aplicar.opacity !== undefined ? { opacity: aplicar.opacity } : {}),
      ...(aplicar.blur !== undefined ? { blur: aplicar.blur } : {}),
      ...(aplicar.wall !== undefined ? { wall: aplicar.wall } : {}),
    });
  });

  await kv.set(PREFS_ADOTADAS_KEY, true);
  if (!vazio(subir)) {
    await gravar({ ...(await carregar()), ...subir });
    void subirPendente();
  }
  return aplicar.idioma ?? null;
}

/**
 * Esquece a fila de quem saiu.
 *
 * Só a fila. O tema, o fundo e o idioma FICAM no aparelho: são aparência, e
 * não dado de ninguém — apagar faria a tela piscar no padrão ao sair, e o
 * `localStorage` do tema é o que o primeiro paint lê. O que não pode ficar é o
 * que ainda ia subir, porque subiria para a conta seguinte.
 */
export async function esquecer(): Promise<void> {
  if (agendado) clearTimeout(agendado);
  agendado = null;
  deNovo = false;
  await gravar({});
}
