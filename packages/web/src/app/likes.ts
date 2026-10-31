import {
  FILA_VAZIA,
  LikesError,
  aplicarFila,
  enfileirar,
  filaVazia,
  leFila,
  semOQueSubiu,
  type FilaDeCurtidas,
} from '@ondas/core';
import { kv, likesClient } from './services';
import { libraryStore, sessionStore } from './stores';

/** A fila do que ainda não subiu. */
export const FILA_KEY = 'likes-fila';
/**
 * Marca que as curtidas que já estavam NESTE aparelho subiram uma vez.
 *
 * É um marcador de migração, não um mecanismo contínuo: ele existe para
 * carregar o que o IndexedDB guardava antes de a curtida virar da conta. Depois
 * da primeira subida bem-sucedida ele nunca mais muda nada.
 */
export const ADOTADAS_KEY = 'likes-adotadas';

/** Curtir cinco faixas seguidas é um PATCH, não cinco. */
const DEBOUNCE_MS = 400;

let fila: FilaDeCurtidas | null = null;
let agendado: ReturnType<typeof setTimeout> | null = null;
let rodando: Promise<void> | null = null;

async function filaAtual(): Promise<FilaDeCurtidas> {
  if (!fila) fila = leFila(await kv.get(FILA_KEY));
  return fila;
}

async function gravarFila(nova: FilaDeCurtidas): Promise<void> {
  fila = nova;
  await kv.set(FILA_KEY, nova);
}

/**
 * Registra uma curtida que já valeu na tela.
 *
 * O otimismo aqui é o oposto do `togglePublico`, que grava no servidor antes de
 * mexer em qualquer coisa. Lá um erro deixaria a lista inteira mudando sozinha;
 * aqui o pior caso é um coração que sobe dez segundos depois. É a fila que
 * compra esse direito — sem ela, otimismo seria perda silenciosa.
 */
export async function registrar(id: string, curtir: boolean): Promise<void> {
  await gravarFila(enfileirar(await filaAtual(), id, curtir));
  if (agendado) clearTimeout(agendado);
  agendado = setTimeout(() => {
    agendado = null;
    void sincronizar();
  }, DEBOUNCE_MS);
}

/**
 * Põe o aparelho de acordo com o servidor.
 *
 * Chamada em três lugares, e nenhum deles é um laço: no fim do `hydrate`
 * (boot), depois do login, e quando a rede volta (`bootstrap`).
 */
export function sincronizar(): Promise<void> {
  // O debounce que estivesse pendente perde a razão de ser: a subida é agora.
  // Sem isto, `logout` subiria a fila e o timer dispararia logo depois, contra
  // um cookie já morto.
  if (agendado) {
    clearTimeout(agendado);
    agendado = null;
  }
  if (!sessionStore.getState().user) return Promise.resolve();
  // Uma de cada vez: duas subidas simultâneas mandariam a mesma fila duas
  // vezes e a segunda resposta desfaria a primeira.
  if (rodando) return rodando;
  rodando = executar().finally(() => {
    rodando = null;
  });
  return rodando;
}

async function executar(): Promise<void> {
  let enviada = await filaAtual();

  // A adoção é a fila pré-carregada, e não um código à parte: com isso ela
  // herda o retry, o debounce e o tratamento de erro de graça.
  const adotadas = await kv.get<boolean>(ADOTADAS_KEY);
  if (!adotadas) {
    for (const id of Object.keys(libraryStore.getState().liked)) {
      enviada = enfileirar(enviada, id, true);
    }
  }

  try {
    const ids = filaVazia(enviada)
      ? await likesClient.list()
      : await likesClient.apply(enviada.add, enviada.remove);

    // A fila só diminui DEPOIS de o servidor confirmar, e só perde o que de
    // fato subiu: o que a pessoa tocou durante o voo tem de sobreviver.
    const sobrou = semOQueSubiu(fila ?? FILA_VAZIA, enviada);
    await gravarFila(sobrou);
    await kv.set(ADOTADAS_KEY, true);
    libraryStore.getState().setLiked(aplicarFila(ids, sobrou));
    if (!filaVazia(sobrou)) void sincronizar();
  } catch (err) {
    // Só o 401 invalida — é o mesmo critério do `restore()`: falta de rede não
    // é o servidor dizendo não. Aqui a fila fica intacta e o espelho na tela
    // continua certo; a próxima chamada tenta de novo.
    if (err instanceof LikesError && err.semSessao) await esquecerCurtidas();
  }
}

/**
 * Esquece o que é da conta que saiu.
 *
 * Sem isto, as curtidas de quem saiu continuariam no store e seriam ADOTADAS
 * pela próxima conta que entrasse neste navegador — o gosto de uma pessoa
 * subindo para a conta de outra. Vale tanto para o clique em `[sair]` quanto
 * para um 401, que é a mesma situação sem o clique.
 *
 * Apagar é seguro porque agora elas estão no servidor: entrar de novo as traz.
 * `cached`/`sizes` NÃO são tocados — os bytes só existem aqui.
 *
 * A exceção é o aparelho que nunca sincronizou: aquelas curtidas são de antes
 * desta mudança, ainda não são de conta nenhuma, e apagá-las seria destruir
 * exatamente o que a adoção existe para salvar.
 */
export async function esquecerCurtidas(): Promise<void> {
  await gravarFila(FILA_VAZIA);
  if (await kv.get<boolean>(ADOTADAS_KEY)) {
    libraryStore.getState().setLiked([]);
    await kv.remove(ADOTADAS_KEY);
  }
}
