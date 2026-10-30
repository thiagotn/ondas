-- Preferência de conta: o catálogo público entra na lista ou não.
--
-- Quem tem acervo quer ver o acervo. Hoje logar traz as duas fontes sempre
-- (`loadCatalog` em packages/core/src/catalog/resolve.ts), e esta coluna é o
-- jeito de dizer "só o meu".
--
-- Ela mora na conta, e não no aparelho, porque é uma escolha sobre o que a
-- pessoa quer ouvir — segue para o celular e para o desktop. O `buffer`, que é
-- sobre este navegador, continua no IndexedDB.
--
-- O PADRÃO É DECIDIDO AQUI, UMA VEZ, E GRAVADO: conta que já tem faixa no
-- acervo nasce desligada — é para isso que ela existe —, e conta vazia nasce
-- ligada, porque o catálogo público é a única fonte que ela tem. Derivar ao
-- vivo da contagem do acervo seria pior: o primeiro envio faria as 24 faixas
-- do trending desaparecerem da tela sem ninguém pedir.
--
-- A ORDEM DOS QUATRO COMANDOS É A REGRA, e é por isso que `DEFAULT true` vem
-- depois do UPDATE: num `ADD COLUMN ... DEFAULT true` só, o Postgres
-- materializaria `true` em toda linha que já existe, o `WHERE publico IS NULL`
-- não casaria com nada, e TODA CONTA ANTIGA ABRIRIA COM O CATÁLOGO PÚBLICO
-- LIGADO — o oposto do que esta migração existe para fazer. O bug é invisível
-- no diff; só este comentário impede que alguém "limpe" os quatro em um.
--
-- `DEFAULT true` é o certo para cadastro novo: uma conta não tem faixa nenhuma
-- no instante em que nasce (`Users.Create` insere a linha pelada, e o caminho
-- do token só resolve um dono que já existe).
ALTER TABLE users ADD COLUMN IF NOT EXISTS publico boolean;
UPDATE users SET publico = NOT EXISTS (SELECT 1 FROM tracks WHERE user_id = users.id)
 WHERE publico IS NULL;
ALTER TABLE users ALTER COLUMN publico SET DEFAULT true;
ALTER TABLE users ALTER COLUMN publico SET NOT NULL;
