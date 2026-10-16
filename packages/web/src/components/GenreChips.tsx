import s from './shell.module.css';

export interface GenreChipsProps {
  options: string[];
  value: string;
  onChange(genre: string): void;
}

/** Filtro de gênero no formato de flag de CLI: `--genero=[techno]`. */
export function GenreChips({ options, value, onChange }: GenreChipsProps) {
  return (
    <div className={s.chips}>
      <span className={s.chipsLabel}>--genero=</span>
      {options.map((g) => (
        <button
          key={g}
          type="button"
          onClick={() => onChange(g)}
          aria-pressed={value === g}
          className={value === g ? `${s.chip} ${s.chipActive}` : s.chip}
        >
          {value === g ? `[${g}]` : g}
        </button>
      ))}
    </div>
  );
}
