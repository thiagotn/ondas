import type { ErroDaApi } from '../types.js';
import type { PrefsDaConta } from '../prefs.js';
import type { Session, User } from '../types.js';

export interface Credentials {
  email: string;
  password: string;
}

/**
 * Recusa da autenticação.
 *
 * `message` continua sendo a frase do servidor (pt-BR) e é a reserva; quem
 * desenha a tela prefere `codigo`, que é o que se traduz.
 */
export class AuthError extends Error {
  readonly codigo?: string;
  readonly params?: Record<string, unknown>;

  constructor(message: string, erro?: ErroDaApi) {
    super(message);
    this.name = 'AuthError';
    this.codigo = erro?.codigo;
    this.params = erro?.params;
  }
}

/**
 * O mínimo de caracteres de uma senha, para a tela poder dizê-lo ANTES de a
 * pessoa digitar. É cópia de `auth.SenhaMinima`, na API — quem decide é ela, e
 * se as duas divergirem o que aparece é o `senha_curta` do servidor, com o
 * número certo.
 */
export const SENHA_MINIMA = 8;

/** O que a tela de cadastro manda. `mensagem` é o recado opcional para o admin. */
export interface PedidoDeConta {
  name: string;
  email: string;
  password: string;
  mensagem?: string;
}

/**
 * O que aconteceu com o pedido de conta.
 *
 * `pendente` é o caso comum: a conta existe, mas só entra depois que o admin
 * aprovar — não há sessão. `aprovada` é o do e-mail que o admin já tinha
 * liberado de antemão: aí o servidor devolve a sessão junto.
 */
export type ResultadoDoPedido = { status: 'pendente' } | { status: 'aprovada'; user: User };

/** Autenticação. `LocalAuthService` implementa as regras do protótipo; OAuth/JWT entram aqui depois. */
export interface AuthService {
  /** Rejeita com `AuthError` e mensagem em pt-BR quando as credenciais não servem. */
  login(credentials: Credentials): Promise<User>;
  logout(): Promise<void>;
  /** Sessão persistida, se houver. */
  restore(): Promise<Session>;
  /**
   * Liga ou desliga o catálogo público desta conta, devolvendo o usuário novo.
   *
   * Fica no serviço de auth, e não num store, porque a preferência é um campo
   * da conta: quem a grava é o servidor, e o espelho local tem de acompanhar —
   * é ele que `restore()` devolve sem rede.
   */
  setPublico(on: boolean): Promise<User>;
  /**
   * Grava na conta as preferências de aparência dadas, e só elas — o que não
   * vem no objeto fica como está. Devolve o usuário novo.
   *
   * `keepalive` é para a troca de idioma, que recarrega a página logo depois:
   * sem ele o pedido morreria com a navegação.
   */
  setPrefs(parcial: PrefsDaConta, opts?: { keepalive?: boolean }): Promise<User>;
  /** Pede uma conta. Rejeita com `AuthError` quando o pedido não serve. */
  signup(pedido: PedidoDeConta): Promise<ResultadoDoPedido>;
  /** Troca o nome de exibição da conta, devolvendo o usuário novo. */
  renomear(name: string): Promise<User>;
  /**
   * Troca a senha. Pede a atual mesmo com sessão: o cookie prova que este
   * navegador entrou um dia, a senha prova quem está na frente dele agora.
   */
  trocarSenha(atual: string, nova: string): Promise<void>;
  /** Apaga a conta e tudo que é dela, no servidor. Sem volta; pede a senha. */
  apagarConta(senha: string): Promise<void>;
}
