-- Teto de envio POR CONTA.
--
-- Até aqui o tamanho máximo de um arquivo era um número só, `INGEST_MAX_MB`
-- (60 MB), igual para toda conta e para os três caminhos de entrada: arquivo
-- pela tela de envio, link de página pelo node, URL de mídia. Servia enquanto
-- ninguém precisava de mais; não serve para testar a plataforma com uma faixa
-- longa (um set de 3 horas passa de 150 MB) sem abrir o mesmo teto para todos.
--
-- NULL é "usa o padrão do servidor", e é o que toda conta tem depois desta
-- migração: nada muda para ninguém até o admin escrever um número aqui. Guardar
-- o padrão em cada linha faria o `INGEST_MAX_MB` deixar de valer no dia em que
-- alguém o mudasse no ConfigMap.
--
-- É coluna de `users` e não de `planos` de propósito: plano responde "quanto
-- cabe no acervo", e isto responde "qual o maior arquivo que o worker aceita
-- desta conta" — um limite de operação (disco temporário, prazo do job), não
-- um produto. O teto ABSOLUTO do que pode ser escrito aqui fica no Go
-- (`admin.MaxTetoDeEnvio`), ao lado do motivo dele.
--
-- O teto é de quem PEDE o envio (`ingest_jobs.user_id`), não de quem vai ser
-- dono da faixa: é na área de espera de quem pediu que o arquivo é gravado.
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_upload_bytes bigint;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_max_upload_ck;
ALTER TABLE users ADD CONSTRAINT users_max_upload_ck CHECK (max_upload_bytes > 0);
