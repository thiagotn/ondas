#!/usr/bin/env bash
# Gera o token de admin do ondas (o da `ondasctl` e das rotas `/api/admin`).
#
# O token nasce e fica NESTA máquina, num arquivo que só você lê. O que este
# script imprime é o SHA-256 dele — que é a única coisa que a API guarda
# (`ADMIN_TOKEN_SHA256`) e que pode ir para o Secret do cluster, para um chat ou
# para um log sem dar a ninguém o poder de aprovar conta.
#
# uso:
#   scripts/gerar-token-admin.sh [caminho-do-arquivo]
#
# Depois:
#   1. ponha a soma impressa em ADMIN_TOKEN_SHA256, no Secret do `ondas-api`;
#   2. aponte a CLI para o arquivo:  export ONDAS_ADMIN_TOKEN_FILE=<caminho>
#
# Trocar o token é rodar de novo (apagando o arquivo antes) e atualizar o Secret.
set -euo pipefail

arquivo="${1:-${XDG_CONFIG_HOME:-$HOME/.config}/ondas/admin-token}"

if [ -e "$arquivo" ]; then
  echo "já existe um token em $arquivo — apague-o antes, se a ideia é trocar." >&2
  exit 1
fi

umask 077
mkdir -p "$(dirname "$arquivo")"
# 32 bytes do sistema: 256 bits, em hex para caber em qualquer cabeçalho.
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$arquivo"

echo "token gravado em: $arquivo" >&2
echo "ADMIN_TOKEN_SHA256 (é isto que vai para o Secret):" >&2
# Sem quebra de linha no arquivo, então a soma é a do token exato — a mesma
# conta que a API faz com o cabeçalho que a CLI manda.
sha256sum < "$arquivo" | cut -d' ' -f1
