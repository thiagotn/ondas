-- A administração sai do ConfigMap e vai para o banco, e a conta ganha cota.
--
-- Até aqui, três decisões de PRODUTO moravam em variável de ambiente do
-- cluster: se o cadastro está aberto (`SIGNUP_OPEN`), quais e-mails pulam a
-- análise (`SIGNUP_ALLOWLIST`) e para quais contas o bot pode publicar
-- (`INGEST_DESTINOS`). Liberar uma pessoa era um commit no repositório de
-- infra, uma sincronização do Argo e um restart de pod. Nada disso é
-- configuração de infraestrutura — é dado que o admin muda no dia a dia, e
-- dado mora no banco.
--
-- A API importa os valores do env UMA vez (ver `admin.ImportarEnv`), marca
-- que importou, e daí em diante só o banco vale.

-- Chave/valor para o pouco que é global. Texto e não jsonb: são duas chaves,
-- e um tipo mais rico convidaria a guardar aqui o que merece coluna própria.
CREATE TABLE IF NOT EXISTS config (
    chave         text PRIMARY KEY,
    valor         text NOT NULL,
    atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- O convite é a decisão do admin tomada ANTES de a pessoa pedir conta: o
-- e-mail que estiver aqui nasce aprovado, com as marcas abaixo, e a linha é
-- consumida no cadastro. Substitui `SIGNUP_ALLOWLIST`.
--
-- O e-mail é guardado já em minúsculas (o CHECK garante), que é o critério do
-- índice único de `users`: comparar com `lower()` nos dois lados exigiria um
-- índice de expressão para uma tabela de meia dúzia de linhas.
CREATE TABLE IF NOT EXISTS convites (
    email         text PRIMARY KEY,
    pode_enviar   boolean NOT NULL DEFAULT false,
    recebe_do_bot boolean NOT NULL DEFAULT false,
    nota          text NOT NULL DEFAULT '',
    criado_em     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT convites_email_ck CHECK (email = lower(email) AND position('@' IN email) > 1),
    CONSTRAINT convites_nota_ck CHECK (char_length(nota) <= 200)
);

-- O bot (token de máquina) pode publicar faixa PARA esta conta? Substitui
-- `INGEST_DESTINOS`. Fechado por padrão, como `pode_enviar`: é o teto do
-- alcance do token, e conta nova não entra nele sem alguém decidir.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recebe_do_bot boolean NOT NULL DEFAULT false;

-- Quando a conta entrou pela última vez. O cookie é sem estado e nada mais
-- registrava atividade de conta; o admin não tinha como distinguir conta
-- abandonada de conta em uso.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ultimo_login_em timestamptz;

-- Planos: quanto de armazenamento uma conta tem.
--
-- Não há cobrança aqui, e é de propósito que a tabela não saiba o que é preço
-- nem validade: ela responde só "qual é a cota". O que vier depois —
-- assinatura, compra avulsa — é quem ESCREVE em `users.plano_id` e em
-- `users.cota_extra_bytes`, e não precisa mudar a forma desta conta:
--
--     cota da conta = planos.cota_bytes + users.cota_extra_bytes
--
-- O plano é o que se renova (assinatura troca o `plano_id`); o extra é o que se
-- compra uma vez e fica (avulso soma em `cota_extra_bytes`).
CREATE TABLE IF NOT EXISTS planos (
    id         text PRIMARY KEY,
    nome       text NOT NULL,
    cota_bytes bigint NOT NULL,
    criado_em  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT planos_id_ck CHECK (id ~ '^[a-z0-9-]{1,32}$'),
    CONSTRAINT planos_nome_ck CHECK (char_length(nome) BETWEEN 1 AND 40),
    CONSTRAINT planos_cota_ck CHECK (cota_bytes >= 0)
);

-- O plano de toda conta que ninguém mudou. 1 GiB é ponto de partida, não
-- decisão comercial: o admin troca o número na tela.
INSERT INTO planos (id, nome, cota_bytes) VALUES ('padrao', 'padrão', 1073741824)
ON CONFLICT (id) DO NOTHING;

-- RESTRICT (o padrão do FK): um plano com conta dentro não pode ser apagado, e
-- hoje nem há rota para apagar plano.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plano_id text NOT NULL DEFAULT 'padrao' REFERENCES planos (id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cota_extra_bytes bigint NOT NULL DEFAULT 0;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_cota_extra_ck;
ALTER TABLE users ADD CONSTRAINT users_cota_extra_ck CHECK (cota_extra_bytes >= 0);

-- O tamanho das capas (a de 960 e a miniatura, somadas).
--
-- `size_bytes` sempre foi só o áudio; as capas eram medidas no worker na hora
-- de subir e o número era jogado fora. Para a conta de ocupação fechar com o
-- que o bucket cobra, elas entram. As faixas antigas ficam em 0 até o
-- `worker medir-capas` passar por elas.
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS art_bytes bigint NOT NULL DEFAULT 0;

-- O que o admin fez, e quando. Antes era só linha de log, que some com o pod.
--
-- Sem FK para `users`/`tracks` de propósito: o registro de "conta apagada" tem
-- de sobreviver à conta. `alvo_rotulo` guarda o e-mail ou o título como eram
-- na hora, pelo mesmo motivo.
CREATE TABLE IF NOT EXISTS admin_eventos (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    em          timestamptz NOT NULL DEFAULT now(),
    acao        text NOT NULL,
    alvo_tipo   text NOT NULL DEFAULT '',
    alvo_id     text NOT NULL DEFAULT '',
    alvo_rotulo text NOT NULL DEFAULT '',
    detalhe     text NOT NULL DEFAULT '',
    ip          text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS admin_eventos_em_idx ON admin_eventos (em DESC);
