import { Component, type ReactNode } from 'react';

/**
 * O que aparece quando o render quebra.
 *
 * Existe porque já aconteceu: um erro dentro do render derrubou a árvore
 * inteira e o que sobrou na tela foi o fundo do tema — sem texto, sem botão,
 * sem nada que dissesse o que houve nem como sair. Num app instalado, "preto"
 * é indistinguível de "não abriu", e o caminho de diagnóstico vira adivinhação.
 *
 * Não tenta consertar nada: diz o que quebrou, oferece recarregar e oferece
 * limpar os dados do aparelho — que é a saída quando o problema é dado velho
 * guardado em disco, e que no app instalado não é óbvio como fazer.
 *
 * Em inglês e português ao mesmo tempo, sem passar pelo `t()`: se o que
 * quebrou FOI a tradução, uma mensagem traduzida não apareceria.
 */
export class Desastre extends Component<{ children: ReactNode }, { erro: Error | null }> {
  override state: { erro: Error | null } = { erro: null };

  static getDerivedStateFromError(erro: Error) {
    return { erro };
  }

  override componentDidCatch(erro: Error) {
    console.error('[ondas] a tela quebrou', erro);
  }

  override render() {
    const { erro } = this.state;
    if (!erro) return this.props.children;

    return (
      <div
        style={{
          padding: 'calc(24px + env(safe-area-inset-top, 0px)) 16px 24px',
          color: 'var(--color-text, #cdd6f4)',
          background: 'var(--color-bg, #1e1e2e)',
          minHeight: '100dvh',
          font: '13px/1.6 ui-monospace, monospace',
        }}
      >
        <p style={{ color: 'var(--ansi-1, #f38ba8)' }}>ondas: a tela quebrou</p>
        <p style={{ color: 'var(--color-neutral-400, #9399b2)', textWrap: 'pretty' }}>
          Recarregue. Se insistir, limpe os dados deste aparelho — o botão abaixo apaga o que está
          guardado aqui (downloads e preferências), não a sua conta.
          <br />
          Reload. If it keeps happening, clear this device&rsquo;s data — the button below wipes
          what is stored here (downloads and preferences), not your account.
        </p>

        <pre
          style={{
            margin: '16px 0',
            padding: 12,
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            border: '1px solid var(--color-neutral-800, #45475a)',
            borderRadius: 4,
            color: 'var(--color-neutral-300, #bac2de)',
          }}
        >
          {String(erro?.message || erro)}
        </pre>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <button type="button" style={botao} onClick={() => location.reload()}>
            [recarregar / reload]
          </button>
          <button type="button" style={botao} onClick={() => void limparTudo()}>
            [limpar dados / clear data]
          </button>
        </div>
      </div>
    );
  }
}

const botao = {
  border: 0,
  background: 'transparent',
  color: 'var(--color-accent-300, #cba6f7)',
  font: 'inherit',
  cursor: 'pointer',
  padding: 0,
  minHeight: 44,
} as const;

/**
 * Apaga tudo o que este navegador guarda do ondas e recarrega.
 *
 * Inclui desregistrar o service worker e apagar os caches: num app instalado,
 * "limpar dados" nas configurações do sistema nem sempre alcança os dois, e
 * eles são justamente onde mora a versão velha que não quer sair.
 */
async function limparTudo(): Promise<void> {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Pode não haver acesso; o resto continua.
  }
  try {
    const nomes = await caches.keys();
    await Promise.all(nomes.map((n) => caches.delete(n)));
  } catch {
    // idem
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    // idem
  }
  try {
    for (const banco of ['ondas', 'ondas-query']) indexedDB.deleteDatabase(banco);
  } catch {
    // idem
  }
  location.replace('/');
}
