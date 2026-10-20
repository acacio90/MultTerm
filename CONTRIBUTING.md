# Como contribuir

Obrigado pelo interesse no MultTerm! Este guia junta o padrão de commits, branches, PRs, testes e
versões do projeto. Issues, PRs e mensagens de commit são escritos em português.

## Ambiente

Requer Node.js 22.18+ e Windows (o app é Electron para Windows; os testes de NFS e VNC do CI rodam
também no Linux).

```sh
npm install            # dependências + hook commit-msg (Conventional Commits)
npm run fetch:freerdp  # cliente RDP, uma vez (o npm run release baixa sozinho)
npm start              # compila e abre o app
```

Outros comandos úteis:

```sh
npm run icon           # regenera desktop/icon.png a partir de desktop/icon.svg
npm run multterm -- list
npm run multterm -- import outro.yaml --dry-run
npm run multterm -- import inventario.ini --folder Ansible --dry-run
```

O `wfreerdp.exe` é compilado pelo workflow `.github/workflows/freerdp.yml` a partir do
código-fonte oficial (hash conferido) e publicado numa release auxiliar (`freerdp-<versão>`);
`npm run fetch:freerdp` o baixa para `vendor/freerdp`, conferindo o hash.

## Fluxo de trabalho

1. **Issue**: toda mudança começa numa issue, com label (`bug`, `enhancement`, `documentation`…)
   e o milestone da versão em que deve sair (`vX.Y.Z`).
2. **Branch** a partir de `develop`, com o tipo do commit e o número da issue:
   `feat/<nº>-descricao-curta`, `fix/<nº>-descricao-curta`, `docs/<nº>-…`.
3. **Commits** no padrão abaixo.
4. **PR para `develop`**, com o corpo em português: o que mudou, uma seção de testes (o que foi
   rodado e o resultado) e `Closes #<nº>` no fim.
5. **Merge** por squash (o histórico é linear) e a branch é apagada. Como o `Closes` só fecha a
   issue quando a mudança chega na `main`, a issue é fechada à mão depois do merge.

### Branches

- `develop`: desenvolvimento do dia a dia; todo trabalho novo entra aqui.
- `main`: só versões lançadas; cada atualização da `main` corresponde a uma tag `vX.Y.Z` e a uma
  release no GitHub.

As duas são protegidas: só recebem mudanças por PR, sem push forçado nem exclusão.

### O que precisa passar

- Os checks obrigatórios do CI: `test` (typecheck, testes de unidade e de interface no Windows),
  `nfs-linux` e `vnc-linux` (clientes reais do Linux contra os servidores do MultTerm).
- A aprovação do dono do código (`.github/CODEOWNERS`).
- Todas as conversas do PR resolvidas.

## Commits

As mensagens seguem o [Conventional Commits](https://www.conventionalcommits.org/pt-br/), em
português:

```text
tipo(escopo opcional): descrição

Corpo opcional, separado do título por uma linha em branco.
```

- Tipos aceitos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
  `chore` e `revert`.
- O escopo é opcional, em minúsculas (`terminal`, `sessions`, `nfs`, `deps`…).
- `!` depois do tipo/escopo indica mudança incompatível: `feat(sessions)!: …`.
- O título tem no máximo 100 caracteres, e o corpo vem depois de uma linha em branco.
- Seja curto e direto: o título diz o que muda; o corpo, quando precisa, explica o porquê em
  poucas linhas.
- Sem trailers `Co-Authored-By`.

O hook `commit-msg` (instalado pelo `npm install`) roda `scripts/commit-msg.ts` e recusa mensagens
fora do padrão. Exemplos:

```text
feat(terminal): reconecta a sessão com a tecla R
fix(sessions): rejeita host iniciado por "-"
docs: explica a configuração do agente SSH
```

## Testes

```sh
npm test             # testes de unidade (node --test)
npm run test:ui      # testes de interface (compila e abre o app com Playwright)
npm run typecheck
```

O motor de VPN tem testes de interoperabilidade contra um gateway strongSwan em Docker
(`npm run test:ipsec`) e um teste da pilha completa no Windows, que pede UAC:

```sh
npm run test:ipsec -- --keep && npm run build && node test/ipsec-gateway/e2e-elevated.ts
```

Rode os testes ligados à parte que você mudou e conte no PR o que rodou.

## CHANGELOG

O [`CHANGELOG.md`](CHANGELOG.md) segue o [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Registre na seção **[Não lançado]** só o que o usuário do app percebe (recurso novo, correção,
segurança), escrito para ele e com o número da issue no fim, por exemplo `(#80)`. Refatorações,
testes, CI e documentação de desenvolvimento ficam de fora.

## Versões

O projeto usa [Versionamento Semântico](https://semver.org/lang/pt-BR/): recurso novo sobe a
versão do meio (0.x.0), só correções sobem o patch (0.x.y) e mudança incompatível sobe a maior.

### Gerar e publicar uma versão

1. Em `develop`: suba a `version` no `package.json` e mova as entradas de **[Não lançado]** do
   `CHANGELOG.md` para a nova versão (commit `chore(release): X.Y.Z`).
2. Leve para a `main` e crie a tag:
   `git checkout main && git merge --ff-only develop && git tag -a vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`
3. `npm run release` cria o rascunho da release da tag, gera o instalador e envia o `.exe`, o
   `.blockmap` e o `latest.yml`. Usa o login do `gh` (ou `GH_TOKEN`) e recusa versões já
   publicadas; `node scripts/release.mjs --dry-run` só confere.
4. Confira os arquivos do rascunho, escreva as notas e publique. Os apps instalados encontram a
   versão nova em **Ajuda → Buscar atualizações**.
5. Feche o milestone da versão e volte para `develop`.

## Dependências (Dependabot)

O Dependabot (`.github/dependabot.yml`) abre PRs semanais para a `develop`, agrupados (Electron à
parte, produção, desenvolvimento e GitHub Actions); versões recém-publicadas esperam uma semana.
Os commits saem como `build(deps): …` e `ci(deps): …`.

Se uma atualização quebrar o typecheck ou os testes, a correção vai num PR à parte, com issue
própria, e o PR do Dependabot é refeito depois (como em #88, para os tipos do Node 26).

## Grafo de código (code-review-graph)

O projeto usa o [code-review-graph](https://github.com/tirth8205/code-review-graph) para manter um
grafo do código (funções, chamadas, testes) consultado antes de mudanças e revisões:

```sh
uv tool install code-review-graph==2.3.9
code-review-graph install   # registra o servidor MCP e os hooks no seu ambiente
code-review-graph build     # indexação completa
code-review-graph update    # atualização incremental (só arquivos alterados)
code-review-graph status
```

O build indexa só arquivos conhecidos pelo git: rode `git add -N <arquivo>` em arquivos novos antes.
O banco local fica em `.code-review-graph/` (ignorado pelo git).

## Licença

Ao contribuir, você concorda que sua contribuição seja distribuída sob a [GPL-3.0](LICENSE).
