-- A aparência passa a ser da conta: tema, idioma e os ajustes do fundo.
--
-- Até aqui a única preferência de conta era `publico` (migração 0005). Tema,
-- fundo e idioma moravam só no navegador — `localStorage` e IndexedDB —, e
-- entrar com a mesma conta em outro aparelho abria tudo no padrão. Estas
-- colunas são o que faz a escolha seguir a pessoa.
--
-- A IMAGEM de fundo NÃO tem coluna, e é de propósito: ela é um arquivo de até
-- ~1 MB, e guardá-la pediria armazenamento de objeto e uma rota de envio. O que
-- sobe é só `pref_wall`, o MODO ('imagem' inclusive). Num aparelho que não tem
-- a imagem, a PWA mostra a capa da faixa e mantém a preferência como está.
--
-- SEM `DEFAULT` E SEM BACKFILL, ao contrário da 0005, e o contraste é a regra:
-- lá o padrão precisava ser decidido e gravado uma vez; aqui `NULL` É
-- INFORMAÇÃO. Ele quer dizer "esta conta nunca escolheu", e é o que faz o
-- primeiro aparelho que abrir depois desta migração subir as preferências que
-- já tinha, em vez de ser sobrescrito por um padrão que ninguém pediu. Um
-- `DEFAULT 'catppuccin-mocha'` apagaria o tema de todo mundo no dia do deploy.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_tema text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_idioma text;
-- `double precision` e não `real`: float4 devolveria 0.55 como
-- 0.550000011920929, e o cliente veria para sempre uma diferença entre o que
-- gravou e o que leu — e a "corrigiria" a cada boot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_opacity double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_blur smallint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pref_wall text;

-- Os CHECKs são a peneira final, como o de `visibilidade` na 0007: os valores
-- entram por JSON de pedido.
--
-- Tema e idioma só têm teto de tamanho, e não lista: o catálogo dos dois é do
-- cliente (`themes.ts`, `LOCALES`), e uma lista aqui seria a terceira cópia —
-- tema novo passaria a exigir migração antes de poder ser salvo. Quem lê é que
-- descarta o que não conhece (`lePrefs`, no core).
--
-- As faixas de `opacity` e `blur` são as de `OPACITY_MIN`/`OPACITY_MAX`/
-- `BLUR_MAX` em packages/core/src/stores/ui.ts.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pref_tema_ck;
ALTER TABLE users ADD CONSTRAINT users_pref_tema_ck CHECK (char_length(pref_tema) <= 32);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pref_idioma_ck;
ALTER TABLE users ADD CONSTRAINT users_pref_idioma_ck CHECK (char_length(pref_idioma) <= 16);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pref_opacity_ck;
ALTER TABLE users ADD CONSTRAINT users_pref_opacity_ck CHECK (pref_opacity BETWEEN 0.3 AND 1);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pref_blur_ck;
ALTER TABLE users ADD CONSTRAINT users_pref_blur_ck CHECK (pref_blur BETWEEN 0 AND 40);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pref_wall_ck;
ALTER TABLE users ADD CONSTRAINT users_pref_wall_ck
    CHECK (pref_wall IN ('capa', 'imagem', 'nenhum'));
