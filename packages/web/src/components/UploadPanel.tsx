import { barraDeProgresso, dlPct } from '@ondas/core';
import { useRef } from 'react';
import { useUploads, type ItemEnvio } from '../app/uploads';
import s from './shell.module.css';
import u from './upload.module.css';

/**
 * Formatos que o `<audio>` toca — os mesmos que o worker aceita. O `accept`
 * aqui é conveniência do seletor de arquivos, não a validação: quem decide é
 * o ffprobe no servidor, porque extensão mente.
 */
const ACEITOS = 'audio/*,.mp3,.m4a,.aac,.flac,.opus,.ogg,.wav';

/** `enviar`: manda um arquivo local para o acervo. Só aparece logado. */
export function UploadPanel() {
  const itens = useUploads((st) => st.itens);
  const enviar = useUploads((st) => st.enviar);
  const limpar = useUploads((st) => st.limparConcluidos);
  const input = useRef<HTMLInputElement>(null);
  const concluidos = itens.some((i) => i.estado === 'pronto' || i.estado === 'erro');

  return (
    <div className={s.panel}>
      <div className={s.panelRow}>
        <span className={s.panelLabel}>enviar</span>
        <button type="button" className={s.link} onClick={() => input.current?.click()}>
          [+ arquivo]
        </button>
        <span className={`${s.panelValue} ${s.panelMuted}`}>mp3 · flac · opus · m4a</span>
        {concluidos && (
          <button type="button" className={s.link} onClick={limpar}>
            [limpar]
          </button>
        )}
        <input
          ref={input}
          type="file"
          multiple
          accept={ACEITOS}
          className={u.escondido}
          onChange={(e) => {
            const arquivos = Array.from(e.target.files ?? []);
            // Zera o input: sem isto, escolher o MESMO arquivo de novo não
            // dispara `change` e o reenvio depois de um erro não funciona.
            e.target.value = '';
            if (arquivos.length) void enviar(arquivos);
          }}
        />
      </div>

      {itens.map((item) => (
        <Linha key={item.id} item={item} />
      ))}
    </div>
  );
}

function Linha({ item }: { item: ItemEnvio }) {
  const remover = useUploads((st) => st.remover);

  return (
    <div className={s.panelRow}>
      <span className={u.nome} title={item.nome}>
        {item.nome}
      </span>
      <span className={u.estado}>
        <Estado item={item} />
      </span>
      {(item.estado === 'pronto' || item.estado === 'erro') && (
        <button
          type="button"
          className={s.link}
          aria-label={`dispensar ${item.nome}`}
          onClick={() => remover(item.id)}
        >
          [x]
        </button>
      )}
    </div>
  );
}

function Estado({ item }: { item: ItemEnvio }) {
  switch (item.estado) {
    case 'preparando':
      return <span className={s.panelMuted}>preparando…</span>;
    case 'enviando':
      return (
        <span
          className={u.barra}
          role="progressbar"
          aria-valuenow={Math.round(item.fracao * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`enviando ${item.nome}`}
        >
          {barraDeProgresso(item.fracao)} {dlPct(item.fracao)}
        </span>
      );
    case 'processando':
      // O arquivo já está no bucket; agora é o worker examinando e subindo.
      return <span className={u.processando}>processando…</span>;
    case 'pronto':
      return <span className={u.pronto}>pronto</span>;
    case 'erro':
      return (
        <span className={u.erro}>
          {item.semSessao ? 'sua sessão expirou — entre de novo' : item.erro}
        </span>
      );
  }
}
