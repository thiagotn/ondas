-- Faixas próprias. O que o navegador recebe nunca é a URL do R2: a coluna
-- guarda a KEY do objeto, e a API devolve um 302 para uma URL assinada na hora
-- (ADR 0013). Assim a assinatura não vence dentro do cache de 24h do catálogo.
CREATE TABLE IF NOT EXISTS tracks (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title          text NOT NULL,
    artist         text NOT NULL,
    -- O gênero alimenta a cor da linha na lista; `acervo` é o padrão.
    genre          text NOT NULL DEFAULT 'acervo',
    duration_s     integer NOT NULL,
    audio_key      text NOT NULL,
    audio_type     text NOT NULL,
    size_bytes     bigint NOT NULL,
    -- Capas são opcionais: nem todo MP3 traz arte embutida.
    art_key        text,
    art_thumb_key  text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- A listagem é sempre "as minhas faixas, mais recentes primeiro".
CREATE INDEX IF NOT EXISTS tracks_user_idx ON tracks (user_id, created_at DESC);

-- Fila de ingestão. O trabalho não cabe no request (baixar uma URL arbitrária
-- não respeita o ReadTimeout de 15s da API), então quem pede recebe um id e
-- pergunta depois — é esse contrato que o bot do Telegram vai chamar.
CREATE TABLE IF NOT EXISTS ingest_jobs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    source_url  text NOT NULL,
    -- Título/artista que o pedido informou; o que vier das tags do arquivo
    -- só preenche o que ficou em branco.
    title       text,
    artist      text,
    status      text NOT NULL DEFAULT 'pending',
    attempts    integer NOT NULL DEFAULT 0,
    error       text,
    track_id    uuid REFERENCES tracks (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ingest_jobs_status_ck
        CHECK (status IN ('pending', 'processing', 'ready', 'error'))
);

-- O worker pega o mais antigo que ainda dá para trabalhar.
CREATE INDEX IF NOT EXISTS ingest_jobs_fila_idx ON ingest_jobs (status, created_at);

-- Mesma URL pedida duas vezes enquanto a primeira não terminou é a MESMA
-- ingestão, não duas: o bot reenvia quando o usuário toca no botão de novo ou
-- quando o Telegram repete a entrega.
CREATE UNIQUE INDEX IF NOT EXISTS ingest_jobs_ativo_idx
    ON ingest_jobs (user_id, source_url)
    WHERE status IN ('pending', 'processing');
