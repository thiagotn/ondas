import { t } from '@ondas/core';
import { forwardRef } from 'react';
import s from './shell.module.css';

export interface SearchBoxProps {
  value: string;
  count: string;
  onChange(value: string): void;
}

/** Campo de busca com prefixo `/`, como numa busca de pager. */
export const SearchBox = forwardRef<HTMLInputElement, SearchBoxProps>(function SearchBox(
  { value, count, onChange },
  ref,
) {
  return (
    <label className={s.search}>
      <span className={s.searchPrefix}>/</span>
      <input
        ref={ref}
        className={s.searchInput}
        placeholder={t('busca.placeholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t('busca.aria')}
        autoComplete="off"
        enterKeyHint="search"
      />
      <span className={s.searchCount}>{count}</span>
    </label>
  );
});
