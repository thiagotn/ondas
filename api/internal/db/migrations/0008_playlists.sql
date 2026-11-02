-- Playlists: a primeira lista da biblioteca que a PESSOA escolhe.
--
-- Os quatro recortes que existiam não são escolha: `--curtidas` é um booleano
-- por faixa, `--acervo` e `--compartilhadas` são procedência, `--offline` é o
-- que está neste aparelho. Nenhum deles sabe dizer "estas sete, nesta ordem".
--
-- A régua é a da migração 0005 e da 0006: escolha sobre o que a pessoa quer
-- ouvir mora na conta, e segue para o celular e para o desktop. O que fica no
-- aparelho continua sendo o que é do aparelho — os bytes baixados.

CREATE TABLE IF NOT EXISTS playlists (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    nome       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- A listagem é sempre "as minhas playlists", como a de `tracks`.
CREATE INDEX IF NOT EXISTS playlists_user_idx ON playlists (user_id, created_at);

-- NOME ÚNICO POR CONTA, SEM DISTINGUIR MAIÚSCULA, e isto é regra de produto e
-- não arrumação: o seletor de playlist é justamente a tela onde a escolha
-- acontece, e duas linhas "Treino" ali são indistinguíveis — quem adiciona não
-- tem como saber em qual das duas a faixa caiu. O `lower()` é o mesmo truque do
-- `users_email_lower_idx`, e o handler traduz o conflito em 409, como o
-- cadastro faz com e-mail em uso.
CREATE UNIQUE INDEX IF NOT EXISTS playlists_nome_idx ON playlists (user_id, lower(nome));

-- Os itens. `track_id` É `text` E NÃO TEM FK PARA `tracks`, pela mesma razão da
-- migração 0006: a maioria dos ids é de faixa do Audius, que não existe naquela
-- tabela nenhuma — uma FK tornaria impossível justamente o caso comum. Os dois
-- espaços de id convivem porque `prefixoID = "acervo:"` já os separa.
--
-- E o preço é o mesmo de lá, com o mesmo conserto: apagar uma faixa do acervo
-- deixaria itens apontando para o nada, então `removerFaixa` os apaga à mão
-- (api/internal/httpapi/acervo.go), ao lado da limpeza da curtida. É o que a FK
-- daria de graça e aqui não dá.
--
-- A FK PARA `playlists`, AO CONTRÁRIO, É DE GRAÇA — este id é nosso. Apagar a
-- playlist leva os itens dela junto, sem código.
--
-- A PK É (playlist_id, track_id): a mesma faixa duas vezes na mesma playlist é
-- o MESMO item, não dois. Com isso um `add` repetido é um `ON CONFLICT DO
-- NOTHING` em vez de erro — e um pedido que subiu duas vezes não duplica a
-- linha, que é o caso normal de um toque que o celular repetiu.
--
-- `pos` existe ALÉM de `created_at` porque ordem aqui é escolha, e não
-- cronologia: reordenar não muda quando a faixa entrou. Os valores só valem
-- relativamente — buracos entre eles são esperados e inofensivos.
CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id uuid NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
    track_id    text NOT NULL,
    pos         integer NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (playlist_id, track_id)
);

-- Toda leitura de itens é "os desta playlist, na ordem". Com `playlist_id` na
-- frente a PK serviria para o recorte, mas não para a ordem — e ordenar é o que
-- esta tabela existe para fazer.
CREATE INDEX IF NOT EXISTS playlist_items_ordem_idx ON playlist_items (playlist_id, pos);
