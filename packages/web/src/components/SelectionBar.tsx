import { useState } from 'react';
import * as controller from '../app/controller';
import { uiStore, useLibrary, useSession, useUi } from '../app/stores';
import s from './playlist.module.css';

export interface SelectionBarProps {
  /**
   * A playlist ABERTA, quando é o caso. É ela que ganha `[− playlist]` e as
   * setas de ordem — as duas ações que só existem dentro de uma playlist.
   */
  playlistID?: string;
}

/**
 * A barra de seleção — só existe com o modo LIGADO.
 *
 * Desligada ela não desenha nada, e isso é a decisão de layout: um
 * `[selecionar]` sozinho numa linha própria custava 64px de altura (36 da linha
 * mais dois `gap` de 14 do `.content`) logo acima da primeira faixa, na tela
 * onde a lista já começa na metade. As portas de entrada passaram a ser o gesto
 * — segurar a linha (`useToqueLongo`) — e a tecla `v`.
 *
 * Ligada, ela ocupa a linha com conteúdo que a justifica: a contagem e as ações.
 * Uma barra, e não um quarto botão na linha da faixa: no estreito três alvos de
 * 44px já comem o título.
 *
 * Só aparece com sessão: playlist é da conta.
 */
export function SelectionBar({ playlistID }: SelectionBarProps) {
  const user = useSession((st) => st.user);
  const selecionando = useUi((st) => st.selecionando);
  const marcadas = useUi((st) => st.marcadas);
  const playlists = useLibrary((st) => st.playlists);
  const [criando, setCriando] = useState(false);

  if (!user || !selecionando) return null;

  const quantas = Object.keys(marcadas).length;

  return (
    <>
      <div className={`${s.barra} ${s.barraOn}`}>
        <span className={s.contador}>
          {quantas === 1 ? '1 marcada' : `${quantas} marcadas`}
        </span>

        {/* Sem nada marcado os botões de ação sairiam da tela em vez de ficarem
            cinza: um `[+ playlist]` que não faz nada é pior que a sua ausência. */}
        {quantas > 0 && (
          <>
            <button
              type="button"
              className={`${s.acao} ${s.acaoForte}`}
              onClick={() => {
                // Nenhuma playlist ainda: o seletor seria um painel vazio, e o
                // caminho é o mesmo que ele ofereceria.
                if (!playlists.length) setCriando(true);
                else uiStore.getState().abrirSeletorPlaylist();
              }}
            >
              [+ playlist]
            </button>
            {playlistID && (
              <button
                type="button"
                className={`${s.acao} ${s.acaoRisco}`}
                onClick={() => void controller.removerMarcadas(playlistID)}
              >
                [− playlist]
              </button>
            )}
            {/* As setas são o caminho do celular, onde não há cursor para o
                `J`/`K` mover. Com mais de uma marcada não há "a faixa", então
                elas não aparecem — mover duas de uma vez não é uma ordem. */}
            {playlistID && quantas === 1 && (
              <>
                <button
                  type="button"
                  className={s.seta}
                  aria-label="Subir na playlist"
                  onClick={() => controller.moverNaPlaylist(playlistID, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={s.seta}
                  aria-label="Descer na playlist"
                  onClick={() => controller.moverNaPlaylist(playlistID, 1)}
                >
                  ↓
                </button>
              </>
            )}
            <button
              type="button"
              className={s.acao}
              onClick={() => uiStore.getState().limparMarcas()}
            >
              [limpar]
            </button>
          </>
        )}

        <span className={s.espaco} />
        <button
          type="button"
          className={s.acao}
          onClick={() => {
            setCriando(false);
            uiStore.getState().sairDaSelecao();
          }}
        >
          [sair]
        </button>
      </div>

      {criando && (
        <CampoDeNome
          rotulo="nome da playlist"
          onCancelar={() => setCriando(false)}
          onPronto={(nome) => {
            setCriando(false);
            void controller.criarComMarcadas(nome);
          }}
        />
      )}
    </>
  );
}

export interface CampoDeNomeProps {
  rotulo: string;
  inicial?: string;
  onPronto(nome: string): void;
  onCancelar(): void;
}

/**
 * O campo de nome, usado para criar e para renomear.
 *
 * Um `<input>` de verdade, como a linha de comando do prompt: o guarda `typing`
 * do `useShortcuts` desliga os atalhos enquanto o foco está nele, então digitar
 * "vida" não liga o modo de seleção no `v` nem troca de aba no dígito.
 */
export function CampoDeNome({ rotulo, inicial = '', onPronto, onCancelar }: CampoDeNomeProps) {
  const [texto, setTexto] = useState(inicial);
  const limpo = texto.trim();

  return (
    <div className={s.campo}>
      <input
        className={s.entrada}
        value={texto}
        aria-label={rotulo}
        placeholder={rotulo}
        autoComplete="off"
        autoFocus
        maxLength={60}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && limpo) {
            e.preventDefault();
            onPronto(limpo);
          }
          // Esc aqui e não na cadeia global: o campo é a camada de cima
          // enquanto está aberto, e o `useShortcuts` já deixa o Esc sair de um
          // input antes de qualquer outra coisa.
          if (e.key === 'Escape') onCancelar();
        }}
      />
      <button
        type="button"
        className={`${s.acao} ${s.acaoForte}`}
        disabled={!limpo}
        onClick={() => onPronto(limpo)}
      >
        [ok]
      </button>
      <button type="button" className={s.acao} onClick={onCancelar}>
        [cancelar]
      </button>
    </div>
  );
}
