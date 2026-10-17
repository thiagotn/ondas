-- Contas do acervo. O catálogo público (Audius) continua sem login nenhum:
-- esta tabela só existe por causa das faixas próprias.
CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL,
    -- Nome exibido na UI (`whoAmI`); por padrão a parte local do e-mail.
    name          text NOT NULL,
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive: ninguém deve conseguir cadastrar Thiago@ e thiago@.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
