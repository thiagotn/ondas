-- O cadastro passa a ser um PEDIDO: a conta nasce em análise e só entra depois
-- que o admin aprova.
--
-- Até aqui a porta era uma só, e binária: `SIGNUP_OPEN` (ou a allowlist) deixava
-- criar a conta, e quem criava já saía logado. Abrir a plataforma para quem
-- quer experimentar pede um estado no meio — a pessoa pediu, ninguém decidiu
-- ainda —, e ele mora na linha da conta, não numa tabela de pedidos à parte:
-- o pedido aprovado É a conta, com a senha que a pessoa já escolheu, e duas
-- tabelas obrigariam a copiar o hash de uma para a outra na aprovação.
--
-- A ORDEM DOS DOIS PASSOS É A MIGRAÇÃO, como na 0005. `ADD COLUMN ... DEFAULT
-- 'aprovada'` grava o valor em toda linha que já existe — quem tinha conta antes
-- deste arquivo continua entrando —, e só então o padrão vira 'pendente', que é
-- o que vale para conta nova. Com o padrão final direto, o deploy trancaria
-- todo mundo para fora, o admin inclusive.
--
-- O padrão da COLUNA é o estado mais fechado de propósito: um INSERT que
-- esqueça o campo cria uma conta que não entra, e não uma que entra sem ninguém
-- ter decidido.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'aprovada';
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pendente';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_ck;
ALTER TABLE users ADD CONSTRAINT users_status_ck
    CHECK (status IN ('pendente', 'aprovada', 'negada'));

-- Quem pode ENTRAR COM FAIXA NOVA (enviar arquivo, pedir ingestão de URL).
--
-- É separado do `status` porque são duas perguntas: a conta aprovada usa a
-- plataforma inteira, e ainda assim não envia arquivo — o envio custa
-- armazenamento, e o formato comercial disso não está decidido. Uma coluna
-- própria deixa liberar conta por conta (`ondasctl contas envio`) sem migração
-- e sem inventar um terceiro status.
--
-- A mesma dança de padrões do `status`, pelo mesmo motivo: as contas que já
-- existem (a do dono, a do bot de ingestão) continuam enviando; as novas não.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pode_enviar boolean NOT NULL DEFAULT true;
ALTER TABLE users ALTER COLUMN pode_enviar SET DEFAULT false;

-- O que a pessoa escreveu ao pedir a conta — opcional, e só o admin lê. É o que
-- ele tem para decidir além de um e-mail.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pedido_msg text;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pedido_msg_ck;
ALTER TABLE users ADD CONSTRAINT users_pedido_msg_ck CHECK (char_length(pedido_msg) <= 500);

-- Quando o admin decidiu. NULL em quem ainda está em análise e em quem já tinha
-- conta antes desta migração (ninguém decidiu nada sobre essas).
ALTER TABLE users ADD COLUMN IF NOT EXISTS decidido_em timestamptz;

-- A fila do admin é "os pendentes, do mais antigo para o mais novo".
CREATE INDEX IF NOT EXISTS users_status_idx ON users (status, created_at);
