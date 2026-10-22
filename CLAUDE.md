# MultTerm: regras para o Claude Code

Gerenciador de sessões SSH/RDP com terminal em abas (Electron + TypeScript, Windows). Responda
e escreva tudo (código, comentários, commits, PRs, issues) em **português do Brasil**.

## Fluxo de trabalho

Siga o [CONTRIBUTING.md](CONTRIBUTING.md). Em resumo:

- Toda mudança começa numa **issue** com label e o milestone da próxima versão (`vX.Y.Z`).
- **Branch** a partir de `develop`: `feat/<nº>-descricao`, `fix/<nº>-…`, `docs/<nº>-…`.
- `develop` e `main` são protegidas: só recebem mudanças por **PR**, com merge por squash.
  Não use `gh pr merge --admin` sem o usuário pedir.
- Commits em Conventional Commits, em português (o hook `commit-msg` confere).
- Corpo do PR: o que mudou, uma seção **Testes** com o que foi rodado e o resultado, e
  `Closes #<nº>` no fim.
- Mudança que o usuário do app percebe entra em **[Não lançado]** no `CHANGELOG.md`, com o
  número da issue.

## Sem atribuição ao Claude

- **Nunca** adicione `Co-Authored-By` nos commits.
- **Nunca** adicione "🤖 Generated with [Claude Code]" (ou parecido) em PRs, issues ou comentários.

## Grafo de código

O projeto usa o `code-review-graph` (dados em `.code-review-graph/`, fora do git):

- **Antes** de responder ou mudar código, consulte o grafo para achar quem usa o quê:
  `code-review-graph search <termo>`, `code-review-graph query importers_of|callers_of <alvo>`.
- **No fim** de qualquer mudança, rode `code-review-graph update`.

## Testes

```sh
npm run typecheck
npm test             # unidade (node --test)
npm run test:ui      # interface (compila e abre o app com Playwright; ~2 min)
```

- Rode os testes ligados à parte mudada e, antes de commit/PR, a suíte completa.
- Comandos longos (como `npm run test:ui`) rodam **em segundo plano**, avisando o usuário, para
  a conversa não parecer travada.
- O Node roda os `.ts` direto (só remove os tipos): nada de *parameter properties*, `enum` ou
  `namespace`.
