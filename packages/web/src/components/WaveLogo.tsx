import { useId } from 'react';
import s from './wave.module.css';

/**
 * A geometria da marca, no viewBox 48×46. A onda é desenhada em 48×44 e entra
 * reduzida a 80% e encostada no mar, para sobrar céu por cima e à direita da
 * crista — é nesse céu que o sol aparece, e é o que faz o disco ler como sol
 * e não como uma bola no colo da onda.
 */
const WAVE =
  'M0 44 C4 30 10 8 28 6 C36.5 5 43.5 9.5 45.6 17.6 C41.5 13.6 36.5 12.6 32.5 14.6 C27.5 17.4 25.6 24 27 30 C29 37.5 37 42.5 48 44 Z';
/** A faixa de espuma que acompanha a crista até a ponta. */
const CAP =
  'M18.5 10.4 C24 7 30 5.4 35.2 6.3 C40.5 7.3 44.3 11.2 45.6 17.6 C42.6 14 39.4 12.3 35.4 11.6 C29.8 10.7 24.5 12 18.5 10.4 Z';
/** Os "dedos" da espuma, pendurados na borda de baixo da faixa. */
const CLAWS: readonly (readonly [number, number, number])[] = [
  [24.4, 11.5, 1.8],
  [29.4, 11.4, 1.8],
  [34.2, 12.1, 1.8],
  [38.7, 13.6, 1.7],
  [42.3, 16, 1.6],
];
/** As gotas que caem da ponta da crista. */
const DROPS: readonly (readonly [number, number, number])[] = [
  [45.9, 21.2, 1.4],
  [43.3, 23.8, 1.1],
  [46.7, 25.6, 1],
];
/**
 * Onde o mar começa: o sol nunca aparece abaixo desta linha.
 *
 * Fica 1.4 ACIMA do pé da onda (que é 44) de propósito: a onda sobe 1.2 quando
 * se mexe, e com o mar começando no pé dela abria-se uma fresta da cor do fundo
 * entre os dois a cada subida.
 */
const SEA_Y = 42.6;
/** Quanto o sol sobe do começo ao fim da faixa, em unidades do viewBox. */
const SUNRISE = 16;

interface Props {
  /** A onda sobe e desce e as gotas escorrem. Acompanha o player: pausa quando o áudio pausa. */
  playing?: boolean;
  /** 0..1 — o sol nasce: começa quase no mar e termina alto, atrás da crista. */
  progress?: number;
  /** Segundos de cada subida da onda. */
  speed?: number;
  /** Largura; por padrão ocupa o container. */
  size?: number | string;
  /**
   * Nome acessível. Sem ele o logo é decorativo (`aria-hidden`) — que é o caso
   * na maioria dos lugares, porque o texto ao lado já diz "ondas" e três logos
   * anunciando a mesma coisa só poluiriam o leitor de tela.
   */
  ariaLabel?: string;
}

/**
 * O logo: a Grande Onda de Kanagawa com o sol vermelho atrás. A onda se mexe
 * com o áudio e o sol nasce conforme a faixa avança.
 *
 * Substitui a fita cassete, e herda dela o contrato: as mesmas props nos mesmos
 * cinco lugares. O que era bobina girando virou onda subindo; o que era fita
 * passando de um carretel ao outro virou o sol subindo.
 *
 * As cores saem das CSS vars do tema, então trocar de tema recolore o logo na
 * hora, sem este componente saber que temas existem. O sol usa o vermelho do
 * tema (`--ansi-1`), a onda a cor de destaque.
 */
export function WaveLogo({ playing = false, progress = 0, speed = 1.8, size, ariaLabel }: Props) {
  const q = Math.min(1, Math.max(0, progress));
  const width = typeof size === 'number' ? `${size}px` : (size ?? '100%');
  // O recorte do sol na linha do mar precisa de um id, e o logo aparece várias
  // vezes na mesma tela (barra de abas e linha do player, no mínimo).
  const clip = useId();
  const vivo = playing ? '' : ` ${s.paused}`;

  return (
    <svg
      viewBox="0 0 48 46"
      className={s.logo}
      style={{ width, ['--wave-speed' as string]: `${speed}s` }}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : { 'aria-hidden': true })}
    >
      <defs>
        <clipPath id={clip}>
          <rect x={0} y={0} width={48} height={SEA_Y} />
        </clipPath>
      </defs>

      {/* o sol, atrás de tudo e cortado na linha do mar */}
      <g clipPath={`url(#${clip})`}>
        <circle cx={29.5} cy={20 + (1 - q) * SUNRISE} r={17} fill="var(--ansi-1)" />
      </g>

      <g className={s.bob + vivo}>
        <g transform="translate(0 8.8) scale(.8)">
          <path d={WAVE} fill="var(--color-accent)" />
          {/* as estrias do dorso, vazadas na cor do fundo */}
          <path
            d="M8.5 44 C11.5 32 16.5 19.5 27.5 14.6"
            fill="none"
            stroke="var(--color-bg)"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <path
            d="M16 44 C17 35 19 27.5 23.6 21.6"
            fill="none"
            stroke="var(--color-bg)"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
          <g className={s.foam}>
            <path d={CAP} />
            {CLAWS.map(([cx, cy, r]) => (
              <circle key={cx} cx={cx} cy={cy} r={r} />
            ))}
            <g className={s.drift + vivo}>
              {DROPS.map(([cx, cy, r]) => (
                <circle key={cx} cx={cx} cy={cy} r={r} />
              ))}
            </g>
          </g>
        </g>
      </g>

      {/* o mar: fica parado, é a onda que se mexe sobre ele */}
      <rect x={0} y={SEA_Y} width={48} height={46 - SEA_Y} fill="var(--color-accent)" />
    </svg>
  );
}
