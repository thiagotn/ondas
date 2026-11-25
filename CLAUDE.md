# ondas — como se entrega aqui

## Toda entrega incrementa a versão e escreve a nota

Nenhuma mudança de comportamento visível sai daqui sem versão nova. São **dois sistemas**, cada um
com a sua nota, o seu número e o seu CHANGELOG — a versão de um não acompanha a do outro:

| | nota | recebe a versão | CHANGELOG gerado |
|---|---|---|---|
| **produto** (PWA, core, e a API vista por quem usa o app) | `packages/core/src/release/notas.json` | `package.json` da raiz, do `core` e do `web` | `CHANGELOG.md` |
| **painel de admin** | `packages/admin/src/release/notas.json` | `packages/admin/package.json` | `packages/admin/CHANGELOG.md` |

A nota certa é a de quem VÊ a mudança: o que só aparece no painel vai na do admin e não toca a
versão do produto, e vice-versa. Mudança que aparece nos dois ganha uma entrada em cada. O passo:

1. acrescentar a entrada no TOPO da nota do sistema — `versao` (SemVer), `data` (`YYYY-MM-DD`) e os
   `itens`, cada um escrito nos **três** idiomas (`pt-BR`, `en`, `es`), em frases sobre o efeito
   para quem usa, não sobre o diff;
2. rodar `pnpm release`, que escreve a versão nos `package.json` de cada sistema e gera os dois
   CHANGELOG;
3. commitar tudo junto com a mudança.

Que casa incrementar:

| | quando |
|---|---|
| **patch** | correção de comportamento que ninguém pediu para mudar |
| **minor** | recurso novo, ou mudança visível que foi pedida |
| **major** | quebra do que atravessa versão: formato guardado no IndexedDB, contrato com a API, endereço já compartilhado |

O que NÃO precisa ser tocado à mão: a versão em `ondas --about`, na tela de login e no rodapé do
painel (vem de `__APP_VERSION__`, que o Vite lê do `package.json` de cada pacote), as páginas
`/changelog` do app e do painel (cada uma lê o `RELEASES` da sua nota) e os dois `CHANGELOG.md` (são
gerados — editá-los à mão é trabalho que o próximo `pnpm release` desfaz).

O que reclama quando o passo é esquecido: `release.test.ts` na suíte de domínio e
`pnpm release --check` no CI.

O raciocínio inteiro, com o que foi descartado, está em
[docs/engenharia/14-versionamento-e-releases.md](docs/engenharia/14-versionamento-e-releases.md).

## Antes de dizer que está pronto

```bash
pnpm -r typecheck
pnpm test            # domínio (Vitest em @ondas/core)
pnpm release --check # nota × pacotes × CHANGELOG, nos dois sistemas
pnpm test:e2e        # smoke da PWA; roda contra o BUILD, na porta 4173
```

`pnpm test:e2e` reaproveita o que já estiver na 4173 (`reuseExistingServer`): derrube qualquer
`vite preview` antigo antes, senão a suíte passa contra um build velho.
