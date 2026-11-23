import { acharLink, barraDeProgresso, dlPct, t } from '@ondas/core';
import { useRef, useState } from 'react';
import { lerNoGesto } from '../app/linkSugerido';
import { useUploads, type ItemEnvio } from '../app/uploads';
import { useWide } from '../hooks/useWide';
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
  const adicionarLink = useUploads((st) => st.adicionarLink);
  const input = useRef<HTMLInputElement>(null);
  // O campo de colar só abre quando o navegador não deixou ler o clipboard, ou
  // quando o que estava lá não era link de música.
  const [colando, setColando] = useState(false);
  const [texto, setTexto] = useState('');
  const [semLink, setSemLink] = useState(false);

  const tentar = (bruto: string | null): boolean => {
    const link = acharLink(bruto, location.host);
    if (!link) return false;
    setColando(false);
    setTexto('');
    setSemLink(false);
    void adicionarLink(link);
    return true;
  };

  // O toque no `[+ link]` é o gesto que deixa ler o clipboard — inclusive no
  // iPhone, e é ele que concede a permissão que a leitura automática usa
  // depois (ver `app/linkSugerido.ts`).
  const aoPedirLink = async () => {
    if (tentar(await lerNoGesto())) return;
    setColando(true);
  };
  const wide = useWide();
  const concluidos = itens.some((i) => i.estado === 'pronto' || i.estado === 'erro');

  return (
    <div className={s.panel}>
      <div className={s.panelRow}>
        <span className={s.panelLabel}>{t('upload.enviar')}</span>
        <button type="button" className={s.link} onClick={() => input.current?.click()}>
          {t('upload.adicionarArquivo')}
        </button>
        <button type="button" className={s.link} onClick={() => void aoPedirLink()}>
          {t('upload.adicionarLink')}
        </button>
        <span className={`${s.panelFormatos} ${s.panelMuted} ${wide ? '' : s.panelFormatosSolo}`}>
          mp3 · flac · opus · m4a
        </span>
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

      {colando && (
        <form
          className={s.panelRow}
          onSubmit={(e) => {
            e.preventDefault();
            if (!tentar(texto)) setSemLink(true);
          }}
        >
          <input
            className={u.campoLink}
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              setSemLink(false);
            }}
            placeholder={t('upload.colarLink')}
            aria-label={t('upload.colarLink')}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
          <button type="submit" className={s.link} disabled={!texto.trim()}>
            {t('upload.adicionar')}
          </button>
          <button
            type="button"
            className={s.link}
            onClick={() => {
              setColando(false);
              setTexto('');
              setSemLink(false);
            }}
          >
            {t('upload.cancelar')}
          </button>
          {semLink && <span className={u.erro}>{t('upload.semLink')}</span>}
        </form>
      )}

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
          aria-label={t('faixa.dispensar', { faixa: item.nome })}
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
      return <span className={s.panelMuted}>{t('upload.preparando')}</span>;
    case 'enviando':
      return (
        <span
          className={u.barra}
          role="progressbar"
          aria-valuenow={Math.round(item.fracao * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t('upload.enviando', { nome: item.nome })}
        >
          {barraDeProgresso(item.fracao)} {dlPct(item.fracao)}
        </span>
      );
    case 'baixando':
      // Link de página: o arquivo ainda está sendo trazido do site.
      return <span className={u.processando}>{t('upload.baixando')}</span>;
    case 'processando':
      // O arquivo já está no bucket; agora é o worker examinando e subindo.
      return <span className={u.processando}>{t('upload.processando')}</span>;
    case 'pronto':
      return <span className={u.pronto}>{t('upload.pronto')}</span>;
    case 'erro':
      return (
        <span className={u.erro}>{item.semSessao ? t('upload.sessaoExpirou') : item.erro}</span>
      );
  }
}
