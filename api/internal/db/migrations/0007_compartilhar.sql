-- Faixa do acervo deixa de ter um dono só para ouvi-la.
--
-- Até aqui o acervo era estritamente de uma conta: `tracks.user_id` existe
-- desde a migração 0002 e TODA consulta filtra por ele no SQL (ver o comentário
-- de `PorID` em api/internal/acervo/tracks.go, que explica por que a
-- autorização não pode ficar num `if` depois da leitura). Não havia caminho
-- nenhum para duas pessoas ouvirem o mesmo arquivo — nem o link de faixa
-- resolvia, porque a faixa não entra no catálogo de quem não é dono.
--
-- A partir daqui existem DOIS DIREITOS DIFERENTES sobre a mesma linha, e
-- misturá-los é o bug que esta migração e o código em volta existem para
-- impedir:
--
--   ouvir = sou o dono, OU a faixa é 'todos', OU existe concessão para mim;
--   mexer = sou o dono, e nada mais (apagar, compartilhar, mudar visibilidade).
--
-- São dois mecanismos porque as duas perguntas do produto são diferentes:
-- "publica para todo mundo que tem conta aqui" é uma propriedade DA FAIXA, e
-- "publica só para esta pessoa" é uma relação entre a faixa e alguém.

-- `visibilidade` é a REGRA VIVA: faixa marcada 'todos' é vista por qualquer
-- conta, inclusive as que se cadastrarem depois. A alternativa — gravar uma
-- concessão por conta existente no momento da publicação — congelaria o
-- passado, e conta nova nasceria sem ver nada.
--
-- `DEFAULT 'privada'` é o que torna esta migração segura: as faixas que já
-- existem continuam privadas sem backfill nenhum. Diferente da 0005, aqui NÃO
-- há motivo para o default depender do que a conta já tem — ninguém
-- compartilhou nada ainda, então o passado inteiro tem uma resposta só.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS visibilidade text NOT NULL DEFAULT 'privada';

-- O CHECK é a peneira final: `visibilidade` entra por JSON de pedido, e sem ele
-- um valor desconhecido viraria faixa que nenhuma consulta encontra — invisível
-- para o dono e para todos, sem erro em lugar nenhum.
ALTER TABLE tracks DROP CONSTRAINT IF EXISTS tracks_visibilidade_ck;
ALTER TABLE tracks ADD CONSTRAINT tracks_visibilidade_ck
    CHECK (visibilidade IN ('privada', 'todos'));

-- Concessão nominal: "esta faixa, para esta pessoa".
--
-- ESTA TABELA TEM FK PARA `tracks`, AO CONTRÁRIO DE `likes` (migração 0006), e
-- o contraste é o que explica as duas. Curtida aponta quase sempre para faixa
-- do Audius, que não existe em `tracks` nenhuma — ali uma FK tornaria
-- impossível o caso comum, e o preço foi `removerFaixa` apagar a curtida à mão.
-- Concessão só aponta para faixa do acervo, então a FK é de graça: apagar a
-- faixa leva as concessões dela junto, sem código.
--
-- A PK é (track_id, user_id) e existe um índice SEPARADO por user_id. Em
-- `likes` a PK composta serviu também de índice porque a pergunta era "as
-- minhas" e `user_id` estava na frente. Aqui a pergunta de toda listagem é
-- "compartilhadas COMIGO" — com `track_id` na frente, a PK não serve para ela,
-- e sem o índice abaixo cada listagem varreria a tabela inteira.
CREATE TABLE IF NOT EXISTS track_shares (
    track_id   uuid NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (track_id, user_id)
);
CREATE INDEX IF NOT EXISTS track_shares_user_idx ON track_shares (user_id);

-- O destino viaja no job de ingestão, porque é no worker que a faixa nasce.
--
-- `destino_id` NULL = a faixa é de quem pediu, que é o comportamento de hoje.
-- Preenchido, a faixa nasce na conta do destino — e `ingest_jobs.user_id`
-- CONTINUA SENDO QUEM PEDIU. Os dois não são a mesma coisa e não podem ser
-- unificados: `user_id` é o que reconstrói a key da área de espera no R2
-- (storage.KeyUploadStage) e o que deixa o bot ler o status do próprio job.
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS destino_id uuid
    REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS visibilidade text NOT NULL DEFAULT 'privada';

ALTER TABLE ingest_jobs DROP CONSTRAINT IF EXISTS ingest_jobs_visibilidade_ck;
ALTER TABLE ingest_jobs ADD CONSTRAINT ingest_jobs_visibilidade_ck
    CHECK (visibilidade IN ('privada', 'todos'));

-- O ÍNDICE DE DEDUPE GANHOU O DESTINO, e isto não é arrumação.
--
-- O índice da 0002 dizia "a mesma URL não entra duas vezes enquanto a primeira
-- está pending/processing", para o reenvio do Telegram não virar duas faixas.
-- Com destino, a mesma URL para duas pessoas diferentes são DOIS pedidos
-- legítimos: sem os campos novos aqui, o segundo cairia no "já estava na fila"
-- e receberia o job do primeiro — a faixa iria para o destino errado, em
-- silêncio, e a resposta 200 pareceria certa.
--
-- `coalesce(destino_id, user_id)` em vez de `destino_id` puro porque NULL nunca
-- conflita com NULL num índice único: sem o coalesce, dois pedidos sem destino
-- para a mesma URL deixariam de ser deduplicados e o reenvio do bot voltaria a
-- criar faixa repetida — exatamente o bug que o índice original existe para
-- impedir.
DROP INDEX IF EXISTS ingest_jobs_ativo_idx;
CREATE UNIQUE INDEX IF NOT EXISTS ingest_jobs_ativo_idx
    ON ingest_jobs (user_id, source_url, coalesce(destino_id, user_id), visibilidade)
    WHERE status IN ('pending', 'processing');
