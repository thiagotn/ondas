import {
  indexOfTrack,
  parseTrackToken,
  whoAmI,
  type PromptLine,
  type Session,
} from '@ondas/core';
import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as controller from '../app/controller';
import { useAvulsas } from '../app/extras';
import { playerStore, useSession } from '../app/stores';
import s from '../components/shell.module.css';
import { TabScaffold } from '../components/TabScaffold';
import { useCatalog } from '../query/catalog';
import { useTrackById } from '../query/track';
import { HomeRoute } from './HomeRoute';
import { PATHS } from './paths';

/** Prefixo do id das faixas próprias, igual ao que a API emite. */
const PREFIXO_ACERVO = 'acervo:';

/**
 * `/t/<slug>-<id>`: o endereço da faixa — o link que se manda para alguém, e o
 * player cheio aberto, que são a mesma coisa.
 *
 * Carrega a faixa; quem desenha o player é o `AppLayout`, porque estar nesta
 * rota já é tê-lo aberto (ver `usePlayerOverlay`). Por baixo do overlay fica a
 * aba em-alta, para quem chegou pelo link fechar o player e já estar no app,
 * em vez de encarar uma tela morta.
 */
export function TrackRoute() {
  const { link } = useParams();
  const id = parseTrackToken(link);
  const user = useSession((st) => st.user);
  const { data } = useCatalog();
  const add = useAvulsas((st) => st.add);

  const doAcervo = !!id?.startsWith(PREFIXO_ACERVO);
  // Faixa própria sem sessão para AQUI: nada é consultado, então não há
  // metadado a vazar nem oráculo que confirme se aquele uuid existe.
  const privada = doAcervo && !user;
  const naLista = id && !privada ? data?.tracks.find((t) => t.id === id) : undefined;

  // Só id público é resolvido pela API externa. Faixa do acervo que não está
  // na lista é "não é sua, ou não existe" — e perguntar seria o vazamento.
  const resolvendo = !!id && !privada && !doAcervo && !naLista;
  const busca = useTrackById(resolvendo ? id : null);

  useEffect(() => {
    if (busca.data) add(busca.data);
  }, [busca.data, add]);

  useEffect(() => {
    if (!naLista || !data) return;
    // Idempotente pelo próprio estado do player, não por um ref: assim voltar
    // e avançar no histórico não reinicia a faixa do zero.
    if (playerStore.getState().curId === naLista.id) return;
    // Reafirma a fila antes de pedir a faixa, e isto não é zelo: quem alimenta
    // o controller é o `AppLayout`, efeito de filho roda antes de efeito de
    // pai, e o react-query pode notificar os dois em commits diferentes. Sem
    // esta linha o deeplink às vezes pedia a faixa de uma fila ainda vazia,
    // `play` saía no `if (!track)` e o player não abria. É idempotente.
    controller.setTracks(data.tracks);
    const i = indexOfTrack(data.tracks, naLista.id);
    if (i < 0) return;
    void controller.play(i);
  }, [naLista, data]);

  useEffect(() => {
    if (!naLista) return;
    // O título da aba é a única parte da página que o link compartilhado
    // mostra antes de carregar o áudio.
    document.title = `${naLista.title} — ondas`;
    return () => {
      document.title = 'ondas';
    };
  }, [naLista]);

  if (!id) return <Aviso texto="link de faixa inválido." />;
  if (privada) {
    return (
      <Aviso
        texto="faixa privada — ela é do acervo de alguém e só abre com a conta dona."
        acao="[entrar]"
      />
    );
  }
  if (naLista) return <HomeRoute />;
  if (busca.isPending || busca.isFetching) return <Resolvendo id={id} user={user} />;
  return <Aviso texto="faixa não encontrada — o link pode estar velho ou a faixa saiu do ar." />;
}

function Resolvendo({ id, user }: { id: string; user: Session }) {
  const line: PromptLine = {
    who: whoAmI(user),
    cwd: '~/t',
    cmd: `ondas open ${id}`,
    comment: '# procurando a faixa…',
  };
  return (
    <TabScaffold line={line}>
      <div className={s.empty}>⠋ resolvendo o link…</div>
    </TabScaffold>
  );
}

/** Painel de recado, no mesmo desenho do aviso de visitante. */
function Aviso({ texto, acao }: { texto: string; acao?: string }) {
  const navigate = useNavigate();
  return (
    <div className={s.notice}>
      <span className={s.noticeLabel}>aviso:</span>
      <span className={s.noticeText}>{texto}</span>
      <button
        type="button"
        className={s.link}
        onClick={() => navigate(acao ? PATHS.login : PATHS.home)}
      >
        {acao ?? '[em-alta]'}
      </button>
    </div>
  );
}
