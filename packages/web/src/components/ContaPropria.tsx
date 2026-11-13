import { canUpload, SENHA_MINIMA, t, type User } from '@ondas/core';
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import * as controller from '../app/controller';
import o from './overlay.module.css';
import s from './shell.module.css';

/**
 * A conta administrando a si mesma, dentro de `ondas whoami`: nome, senha, e a
 * saída definitiva.
 *
 * Cada ação abre o próprio formulário NA LINHA, um por vez, em vez de uma
 * janela por cima: o painel já é um overlay, e uma segunda camada pediria mais
 * um elo na cadeia do Esc para fechar uma coisa de dois campos.
 */

/** Um formulário de linha: os campos, a frase de erro e os dois botões. */
function Formulario({
  rotuloDeEnviar,
  perigo,
  pronto,
  aoEnviar,
  aoCancelar,
  children,
}: {
  rotuloDeEnviar: string;
  /** A ação não tem volta: o botão de enviar sai na cor de alerta. */
  perigo?: boolean;
  /** Os campos estão preenchidos o bastante para tentar. */
  pronto: boolean;
  /** Devolve a frase do erro, ou `null` quando deu certo. */
  aoEnviar: () => Promise<string | null>;
  aoCancelar: () => void;
  children: ReactNode;
}) {
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado || !pronto) return;
    setOcupado(true);
    setErro('');
    const falha = await aoEnviar();
    setOcupado(false);
    if (falha) setErro(falha);
  };

  return (
    <form
      className={o.contaForm}
      onSubmit={(e) => void enviar(e)}
      onChange={() => setErro('')}
      onKeyDown={(e) => {
        // Esc fecha SÓ o formulário. Sem segurar o evento aqui ele chegaria ao
        // `useShortcuts`, que fecharia o painel de conta inteiro junto.
        if (e.key === 'Escape') {
          e.stopPropagation();
          aoCancelar();
        }
      }}
    >
      {children}
      {erro && (
        <span className={o.contaErro} role="alert">
          {t('ui.erro')} {erro}
        </span>
      )}
      <button type="submit" className={perigo ? s.logout : s.link} disabled={ocupado || !pronto}>
        {rotuloDeEnviar}
      </button>
      <button type="button" className={s.link} onClick={aoCancelar}>
        {t('conta.cancelar')}
      </button>
    </form>
  );
}

function Campo({
  rotulo,
  valor,
  mudar,
  ...props
}: {
  rotulo: string;
  valor: string;
  mudar: (v: string) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      className={o.contaEntrada}
      aria-label={rotulo}
      placeholder={rotulo}
      value={valor}
      onChange={(e) => mudar(e.target.value)}
      {...props}
    />
  );
}

/**
 * `[renomear]`, dentro da linha `conta` e ao lado do `[sair]`.
 *
 * Não ganhou uma linha `nome` própria porque o nome JÁ é o valor da linha
 * `conta`: uma segunda linha o mostraria duas vezes no mesmo painel.
 */
export function Renomear({ user }: { user: User }) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState('');

  if (!aberto) {
    return (
      <button
        type="button"
        className={s.link}
        onClick={() => {
          setNome(user.name);
          setAberto(true);
        }}
      >
        {t('conta.renomear')}
      </button>
    );
  }
  return (
    <Formulario
      rotuloDeEnviar={t('conta.salvar')}
      pronto={!!nome.trim() && nome.trim() !== user.name}
      aoEnviar={async () => {
        const falha = await controller.renomearConta(nome.trim());
        if (!falha) setAberto(false);
        return falha;
      }}
      aoCancelar={() => setAberto(false)}
    >
      <Campo
        rotulo={t('conta.nomeNovo')}
        valor={nome}
        mudar={setNome}
        type="text"
        autoComplete="nickname"
        maxLength={40}
        autoFocus
      />
    </Formulario>
  );
}

/** As linhas `senha` e (para quem não pode enviar) `envio` do painel. */
export function LinhasDaConta({ user }: { user: User }) {
  const [aberto, setAberto] = useState(false);
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');

  const fechar = () => {
    setAberto(false);
    // As senhas não ficam em memória de componente depois que o formulário some.
    setAtual('');
    setNova('');
  };

  return (
    <>
      <div className={s.panelRow}>
        <span className={s.panelLabel}>{t('conta.senha')}</span>
        <span className={`${s.panelValue} ${s.panelMuted}`}>••••••••</span>
        {aberto ? (
          <Formulario
            rotuloDeEnviar={t('conta.salvar')}
            pronto={!!atual && nova.length >= SENHA_MINIMA}
            aoEnviar={async () => {
              const falha = await controller.trocarSenha(atual, nova);
              if (!falha) fechar();
              return falha;
            }}
            aoCancelar={fechar}
          >
            <Campo
              rotulo={t('conta.senhaAtual')}
              valor={atual}
              mudar={setAtual}
              type="password"
              autoComplete="current-password"
              autoFocus
            />
            <Campo
              rotulo={t('conta.senhaNova', { minimo: SENHA_MINIMA })}
              valor={nova}
              mudar={setNova}
              type="password"
              autoComplete="new-password"
            />
          </Formulario>
        ) : (
          <button type="button" className={s.link} onClick={() => setAberto(true)}>
            {t('conta.trocarSenha')}
          </button>
        )}
      </div>

      {/* Só aparece para quem NÃO pode: para os outros o painel de envio da
          biblioteca já é a resposta, e uma linha "envio: liberado" seria ruído.
          Para estes, é o único lugar que explica por que o botão não existe. */}
      {!canUpload(user) && (
        <div className={s.panelRow}>
          <span className={s.panelLabel}>{t('conta.envio')}</span>
          <span className={`${s.panelValue} ${s.panelMuted}`}>{t('conta.envioFechado')}</span>
        </div>
      )}
    </>
  );
}

/**
 * `[apagar a conta]`, no fim do painel e longe do `[sair]`.
 *
 * Dois passos e a senha, e não os dois toques do `[limpar downloads]`: aquilo
 * apaga arquivos que dá para baixar de novo; isto apaga a conta no servidor.
 */
export function ApagarConta({ aoApagar }: { aoApagar: () => void }) {
  const [aberto, setAberto] = useState(false);
  const [senha, setSenha] = useState('');

  const fechar = () => {
    setAberto(false);
    setSenha('');
  };

  if (!aberto) {
    return (
      <button type="button" className={`${s.logout} ${o.contaApagar}`} onClick={() => setAberto(true)}>
        {t('conta.apagarConta')}
      </button>
    );
  }
  return (
    <div className={s.panel}>
      <div className={s.panelRow}>
        <span className={o.contaConfirma}>{t('conta.apagarAviso')}</span>
        <Formulario
          rotuloDeEnviar={t('conta.apagarDeVez')}
          perigo
          pronto={!!senha}
          aoEnviar={async () => {
            const falha = await controller.apagarConta(senha);
            if (!falha) aoApagar();
            return falha;
          }}
          aoCancelar={fechar}
        >
          <Campo
            rotulo={t('conta.apagarSenha')}
            valor={senha}
            mudar={setSenha}
            type="password"
            autoComplete="current-password"
            autoFocus
          />
        </Formulario>
      </div>
    </div>
  );
}
