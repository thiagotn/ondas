-- O que a conta ouviu: onde parou, e o que já passou pelo player.
--
-- Até aqui nada do player era guardado em lugar nenhum — `bootstrap()` zera o
-- `playerStore` e um reload recomeça do 0:00. É a mesma régua das migrações
-- 0005, 0006 e 0008: o que é da pessoa mora na conta, e segue ela para o outro
-- aparelho. O que continua no aparelho são os bytes baixados.
--
-- SÃO DUAS TABELAS, e não "o marcador é a linha mais recente do histórico", por
-- três razões que apareceram ao desenhar:
--   1. limpar o histórico apagaria junto o ponto de onde continuar;
--   2. uma faixa ouvida por dez segundos tem marcador e NÃO entra no histórico
--      (o limiar de "ouvi isto" é do cliente), e numa tabela só ela não teria
--      onde morar;
--   3. o marcador é reescrito a cada quinze segundos de música; fazer isso numa
--      tabela indexada por data seria reordenar um índice para guardar um número.

-- O marcador: UMA linha por conta. A PK é o dono, e isso é a regra inteira.
--
-- `em` É O RELÓGIO DE QUEM OUVIU, e não o `now()` de quando o pedido chegou.
-- Parece o contrário do que se quer num servidor, e é de propósito: a posição
-- gravada sem rede há duas horas sobe quando a rede volta, e não pode vencer a
-- que o outro aparelho gravou há dez minutos. Quem decide a ordem é o instante
-- em que o som saiu.
--
-- O preço é confiar num relógio que não é nosso. O lado que machuca é o futuro
-- — um aparelho com a data adiantada gravaria um marcador que nenhum outro
-- conseguiria superar, para sempre — e esse é contido na escrita, com
-- `LEAST(em, now())`. Relógio atrasado só faz aquele aparelho perder a disputa.
--
-- `updated_at` é o nosso relógio, e existe só para diagnóstico: é o que diz, num
-- chamado, quando a linha foi tocada de verdade.
--
-- `track_id` é `text` sem FK pelo motivo da 0006: a maioria é faixa do Audius.
CREATE TABLE IF NOT EXISTS playback (
    user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    track_id   text NOT NULL,
    pos_s      double precision NOT NULL,
    dur_s      double precision NOT NULL DEFAULT 0,
    em         timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- O histórico: uma linha POR FAIXA, e ouvir de novo só move a data.
--
-- Um log de cada reprodução mostraria a mesma faixa cinco vezes seguidas para
-- quem deixa uma música em repetição, e a tela teria de agregar para dizer o
-- que esta tabela já diz.
--
-- `titulo` E `artista` SÃO UM RETRATO, e esta é a diferença para as curtidas,
-- que guardam só o id (ver o comentário do pacote `likes`). Curtida é filtro
-- sobre o catálogo carregado e pode ser. Histórico não pode: o trending do
-- Audius gira, e a faixa de ontem não está no catálogo de hoje — sem o retrato
-- a lista esvaziaria sozinha, que é o contrário do que um histórico promete.
-- Capa não entra: a URL é presa ao nó que a serviu.
--
-- Tem teto por conta, podado na escrita (ver `history.MaxItens`).
CREATE TABLE IF NOT EXISTS history (
    user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    track_id  text NOT NULL,
    titulo    text NOT NULL,
    artista   text NOT NULL,
    dur_s     integer NOT NULL DEFAULT 0,
    tocada_em timestamptz NOT NULL,
    PRIMARY KEY (user_id, track_id)
);

-- A PK serve o upsert; a leitura é "as minhas, da mais recente para trás", e a
-- poda também. Este índice é das duas.
CREATE INDEX IF NOT EXISTS history_recentes_idx ON history (user_id, tocada_em DESC);
