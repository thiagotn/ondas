-- A mesma faixa não entra duas vezes no acervo de uma conta.
--
-- Até aqui nada identificava o CONTEÚDO de uma faixa: a key no R2 é um uuid
-- sorteado, e o único freio era o índice `ingest_jobs_ativo_idx`, que só vale
-- enquanto o pedido está em andamento. Mandar o mesmo arquivo de novo, ou colar
-- o mesmo link depois de pronto, criava uma segunda linha igual — e cada uma
-- conta na cota.
--
-- A identidade passa a ser uma de duas coisas, e só elas:
--
--   audio_sha256 → o arquivo, byte a byte. Pega o reenvio do mesmo arquivo.
--   origem_url   → o link de onde veio, já canonizado. Pega o mesmo link do
--                  YouTube/SoundCloud colado de novo — onde o hash NÃO serve,
--                  porque dois downloads do mesmo vídeo não saem idênticos.
--
-- Título, artista e duração ficam de fora de propósito: uma versão ao vivo com
-- o mesmo tempo, um remaster ou duas faixas sem tag ("sem título"/"acervo")
-- seriam barradas por engano, e recusa errada é pior que repetida ocasional.
--
-- As duas são anuláveis. Faixa antiga fica sem hash até o `worker medir-hash`
-- passar por ela, e faixa enviada como arquivo nunca tem origem.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS audio_sha256 text;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS origem_url text;

-- NÃO são únicos, e é de propósito: o acervo já tem pares repetidos (foi o que
-- motivou esta migração), e um índice único faria ela falhar em produção. A
-- recusa mora no código (`Tracks.Repetida`); o worker atende um job por vez,
-- então não há corrida que justifique apagar faixa de alguém para criar o índice.
CREATE INDEX IF NOT EXISTS tracks_sha_idx
    ON tracks (user_id, audio_sha256) WHERE audio_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS tracks_origem_idx
    ON tracks (user_id, origem_url) WHERE origem_url IS NOT NULL;

-- A origem das faixas que já existem está nos jobs que as criaram: o link de
-- página (`pagina_url`) ou a URL direta (`source_url`, quando não é envio).
-- `track_id` vira NULL quando a faixa é apagada, então job de faixa que não
-- existe mais não entra — e ela pode ser trazida de novo.
UPDATE tracks t
   SET origem_url = j.origem
  FROM (
        SELECT DISTINCT ON (track_id)
               track_id,
               coalesce(pagina_url, source_url) AS origem
          FROM ingest_jobs
         WHERE track_id IS NOT NULL
           AND (pagina_url IS NOT NULL OR source_url LIKE 'http%')
         ORDER BY track_id, created_at
       ) j
 WHERE t.id = j.track_id
   AND t.origem_url IS NULL;
