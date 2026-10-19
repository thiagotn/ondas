import { useEffect, useState } from 'react';

interface Props {
  /** A capa e seus substitutos, em ordem (ver `artworkSources` em core). */
  sources: readonly string[];
  className?: string;
}

/**
 * Capa que se recupera de nó fora do ar.
 *
 * Cada capa do Audius é servida pelo nó que guarda o arquivo, não por um CDN —
 * um catálogo de 24 faixas costuma espalhá-las por ~18 hosts, e basta um estar
 * fora para a linha exibir o ícone de imagem quebrada do navegador. Como o
 * caminho carrega o CID, qualquer outro nó devolve os mesmos bytes: no erro a
 * gente tenta o próximo e, só quando acabam, deixa o espaço vazio.
 */
export function TrackArt({ sources, className }: Props) {
  const [tentativa, setTentativa] = useState(0);
  const chave = sources.join('|');

  // Faixa nova (ou catálogo recarregado) recomeça pelo endereço original.
  useEffect(() => setTentativa(0), [chave]);

  const src = sources[tentativa];
  if (!src) return null;

  return (
    <img
      src={src}
      alt=""
      // `ondas-art` é global (styles/global.css): tira a capa do caminho do
      // ponteiro, e com isso some o menu de imagem do toque longo.
      className={className ? `ondas-art ${className}` : 'ondas-art'}
      loading="lazy"
      decoding="async"
      onError={() => setTentativa((n) => n + 1)}
    />
  );
}
