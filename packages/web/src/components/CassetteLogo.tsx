import s from './cassette.module.css';

/** Ângulos dos raios do cubo, como no handoff: 3 raios a cada 120°. */
const SPOKES = [0, 120, 240];
const CY = 17;
/** Raio do cubo — também o alcance dos raios. */
const HUB_R = 2.6;

interface Props {
  /** Gira os cubos. Acompanha o player: pausa quando o áudio pausa. */
  playing?: boolean;
  /** 0..1 — passa a fita do carretel da esquerda para o da direita. */
  progress?: number;
  /** Mostra "ONDAS · LADO A" na etiqueta. */
  label?: boolean;
  /** Segundos por volta. */
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
 * O logo: uma fita cassete cujos carretéis giram com o áudio e cuja fita passa
 * de um lado para o outro conforme a faixa avança.
 *
 * As cores saem das CSS vars do tema, então trocar de tema recolore o logo na
 * hora, sem este componente saber que temas existem.
 */
export function CassetteLogo({
  playing = false,
  progress = 0,
  label = false,
  speed = 1.8,
  size,
  ariaLabel,
}: Props) {
  const q = Math.min(1, Math.max(0, progress));
  const width = typeof size === 'number' ? `${size}px` : (size ?? '100%');

  return (
    <svg
      viewBox="0 0 64 42"
      style={{ width, display: 'block', overflow: 'visible', ['--reel-speed' as string]: `${speed}s` }}
      {...(ariaLabel ? { role: 'img', 'aria-label': ariaLabel } : { 'aria-hidden': true })}
    >
      {/* corpo */}
      <rect
        x={1}
        y={1}
        width={62}
        height={40}
        rx={4}
        fill="var(--color-surface)"
        stroke="var(--color-text)"
        strokeWidth={1.6}
      />
      {/* parafusos dos cantos */}
      {[
        [4.5, 4.5],
        [59.5, 4.5],
        [4.5, 37.5],
        [59.5, 37.5],
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={0.9} fill="var(--color-neutral-600)" />
      ))}
      {/* etiqueta e a tarja de cor do tema */}
      <rect
        x={7}
        y={5}
        width={50}
        height={24}
        rx={2}
        fill="var(--color-bg)"
        stroke="var(--color-neutral-700)"
        strokeWidth={0.8}
      />
      <rect x={7} y={5} width={50} height={2.2} fill="var(--color-accent)" />
      {label && (
        <text
          x={32}
          y={27.4}
          textAnchor="middle"
          fontSize={2.6}
          fill="var(--color-neutral-500)"
          fontFamily='"JetBrains Mono", monospace'
          letterSpacing={0.3}
        >
          ONDAS · LADO A
        </text>
      )}
      {/* janela da fita */}
      <rect
        x={14}
        y={10}
        width={36}
        height={14}
        rx={7}
        fill="var(--color-neutral-900)"
        stroke="var(--color-neutral-600)"
        strokeWidth={0.8}
      />
      <Reel cx={23} tape={2.9 + 3.6 * (1 - q)} playing={playing} />
      <Reel cx={41} tape={2.9 + 3.6 * q} playing={playing} />
      {/* trapézio e furos da base */}
      <path
        d="M16 41 L19.5 33.5 H44.5 L48 41"
        fill="none"
        stroke="var(--color-neutral-600)"
        strokeWidth={0.9}
      />
      <circle cx={25} cy={37.5} r={1.3} fill="var(--color-neutral-700)" />
      <circle cx={39} cy={37.5} r={1.3} fill="var(--color-neutral-700)" />
    </svg>
  );
}

/** Rolo de fita (não gira) com o cubo girando por cima. */
function Reel({ cx, tape, playing }: { cx: number; tape: number; playing: boolean }) {
  return (
    <g>
      <circle cx={cx} cy={CY} r={tape} fill="var(--color-neutral-700)" />
      <g className={playing ? s.hub : `${s.hub} ${s.hubPaused}`}>
        <circle
          cx={cx}
          cy={CY}
          r={HUB_R}
          fill="var(--color-neutral-900)"
          stroke="var(--color-accent)"
          strokeWidth={1.2}
        />
        {SPOKES.map((angle) => (
          <line
            key={angle}
            x1={cx}
            y1={CY}
            x2={cx + HUB_R * Math.cos((angle * Math.PI) / 180)}
            y2={CY + HUB_R * Math.sin((angle * Math.PI) / 180)}
            stroke="var(--color-accent)"
            strokeWidth={1.2}
            strokeLinecap="round"
          />
        ))}
      </g>
    </g>
  );
}
