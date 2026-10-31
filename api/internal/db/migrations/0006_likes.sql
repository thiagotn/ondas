-- Curtidas, por conta. Até aqui elas eram um `Record<string, boolean>` no
-- IndexedDB do navegador (`packages/core/src/stores/library.ts`), o que
-- significava que não seguiam ninguém: entrar na mesma conta no celular trazia
-- o acervo e não trazia as curtidas, e limpar os dados do site apagava tudo.
--
-- É a mesma régua da migração 0005: escolha sobre o que a pessoa quer ouvir
-- mora na conta. O que continua no aparelho é o que é do aparelho — os bytes
-- baixados e a preferência de buffer.
--
-- `track_id` É `text` E NÃO TEM FK PARA `tracks`, de propósito. A maioria das
-- curtidas é de faixa do Audius, que não existe nesta tabela nenhuma — uma FK
-- tornaria impossível curtir justamente o caso comum. Os dois espaços de id
-- convivem porque `prefixoID = "acervo:"` já os separa
-- (api/internal/httpapi/acervo.go); é o mesmo motivo pelo qual aquele
-- comentário lá fala em "chaves de curtida" desde antes de existir curtida no
-- servidor.
--
-- O preço de não ter a FK é a linha órfã: apagar uma faixa do acervo deixaria
-- uma curtida apontando para o nada. É inofensiva na tela (a lista é um filtro
-- sobre o catálogo carregado), mas `removerFaixa` apaga a curtida à mão para o
-- banco não acumular lixo — o que a FK daria de graça e aqui não dá.
--
-- A PK composta é a regra de unicidade E o índice de "minhas curtidas": curtir
-- duas vezes é um `ON CONFLICT DO NOTHING`, e `WHERE user_id = $1` já usa este
-- índice. Um segundo índice aqui seria peso morto.
CREATE TABLE IF NOT EXISTS likes (
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    track_id   text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, track_id)
);
