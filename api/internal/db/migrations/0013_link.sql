-- Trazer faixa por LINK DE PÁGINA (YouTube, SoundCloud) pela PWA, e a cota
-- passa a valer.
--
-- Até aqui `ingest_jobs` tinha um executor só: o worker do cluster, que baixa
-- uma URL DIRETA de mídia ou lê um arquivo já enviado. Link de página não é
-- mídia — quem o resolve é o node do Hermes, com yt-dlp/scdl, e a decisão de
-- não fazer isso no cluster continua (ADR 0013 do homelab, decisões 37 e 74).
--
-- Então o job ganha um TIPO, que diz QUEM o atende:
--
--   midia  → o worker do cluster, como sempre.
--   pagina → o node. Ele baixa, grava o arquivo na área de espera de quem
--            pediu, e o job VIRA `midia` (fonte `upload:<id>`) para o worker
--            fazer o resto — ffprobe, capas, forma de onda.
--
-- O id do job não muda nessa passagem: quem pediu acompanha uma coisa só.
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'midia';
ALTER TABLE ingest_jobs DROP CONSTRAINT IF EXISTS ingest_jobs_tipo_ck;
ALTER TABLE ingest_jobs ADD CONSTRAINT ingest_jobs_tipo_ck CHECK (tipo IN ('midia', 'pagina'));

-- O link como a pessoa o mandou (já canonizado). `source_url` é reescrita
-- quando o job vira `midia`, e sem esta coluna o status passaria a mostrar
-- `upload:<uuid>` no lugar do link que ela reconhece.
ALTER TABLE ingest_jobs ADD COLUMN IF NOT EXISTS pagina_url text;

-- A fila do node: os de página, do mais antigo para o mais novo.
CREATE INDEX IF NOT EXISTS ingest_jobs_paginas_idx
    ON ingest_jobs (created_at) WHERE tipo = 'pagina';

-- A cota passa a RECUSAR (até a 0012 ela só era medida). É chave, e não regra
-- fixa, para o admin poder desligar sem deploy se o número se mostrar errado.
-- `DO NOTHING`: rodar de novo não religa o que o admin desligou.
INSERT INTO config (chave, valor) VALUES ('cota_bloqueia', 'true')
ON CONFLICT (chave) DO NOTHING;
