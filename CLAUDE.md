# ondas — como se entrega aqui

## Toda entrega incrementa a versão e escreve a nota

Nenhuma mudança de comportamento visível sai daqui sem versão nova. O passo é um só:

1. acrescentar a entrada no TOPO de `packages/core/src/release/notas.json` — `versao` (SemVer),
   `data` (`YYYY-MM-DD`) e os `itens`, cada um escrito nos **três** idiomas (`pt-BR`, `en`, `es`),
   em frases sobre o efeito para quem usa, não sobre o diff;
2. rodar `pnpm release`, que escreve a versão nos três `package.json` e gera o `CHANGELOG.md`;
3. commitar os dois junto com a mudança.

Que casa incrementar:

| | quando |
|---|---|
| **patch** | correção de comportamento que ninguém pediu para mudar |
| **minor** | recurso novo, ou mudança visível que foi pedida |
| **major** | quebra do que atravessa versão: formato guardado no IndexedDB, contrato com a API, endereço já compartilhado |

O que NÃO precisa ser tocado à mão: a versão em `ondas --about` e na tela de login (vem de
`__APP_VERSION__`, que o Vite lê do `package.json`), a página `/changelog` (lê `RELEASES` do core) e
o `CHANGELOG.md` (é gerado — editá-lo à mão é trabalho que o próximo `pnpm release` desfaz).

O que reclama quando o passo é esquecido: `release.test.ts` na suíte de domínio e
`pnpm release --check` no CI.

O raciocínio inteiro, com o que foi descartado, está em
[docs/engenharia/14-versionamento-e-releases.md](docs/engenharia/14-versionamento-e-releases.md).

## Antes de dizer que está pronto

```bash
pnpm -r typecheck
pnpm test            # domínio (Vitest em @ondas/core)
pnpm release --check # nota × pacotes × CHANGELOG
pnpm test:e2e        # smoke da PWA; roda contra o BUILD, na porta 4173
```

`pnpm test:e2e` reaproveita o que já estiver na 4173 (`reuseExistingServer`): derrube qualquer
`vite preview` antigo antes, senão a suíte passa contra um build velho.
