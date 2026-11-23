import { useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { oferecerDoTexto } from '../app/linkSugerido';
import { librarySegPath } from './paths';

/**
 * A chegada do "Compartilhar para o Ondas" (o `share_target` do manifest, no
 * Android): o app do YouTube ou do SoundCloud manda o link em `url`, ou — o
 * mais comum — dentro de `text`, junto com o título.
 *
 * Esta rota não desenha nada: transforma o que chegou numa SUGESTÃO e vai para
 * a biblioteca, onde está o painel de envio. Não enfileira sozinha, pelo mesmo
 * motivo do clipboard: quem decide trazer a faixa é a pessoa, no toque. E
 * limpa o endereço (`replace`), para o link compartilhado não ficar na barra
 * nem no histórico.
 */
export function ShareRoute() {
  const [params] = useSearchParams();
  const texto = [params.get('url'), params.get('text'), params.get('title')].filter(Boolean).join(' ');

  useEffect(() => {
    oferecerDoTexto(texto, 'compartilhado', true);
  }, [texto]);

  return <Navigate to={librarySegPath('acervo')} replace />;
}
