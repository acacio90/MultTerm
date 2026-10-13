# MultTerm

[![CI](https://github.com/acacio90/MultTerm/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/acacio90/MultTerm/actions/workflows/ci.yml)

Gerenciador de sessões SSH/RDP com terminal em abas.
As sessões ficam num arquivo YAML legível e versionável, **sem limite de quantidade**.

## Funcionalidades

- Árvore de sessões com pastas e busca; criar, editar e excluir sessões
- **Terminal SSH embutido em abas** (xterm.js + node-pty), usando o OpenSSH do sistema
- Login por chave via agente SSH (ssh-agent do Windows, KeePassXC)
- RDP pelo cliente do sistema (`mstsc` no Windows)
- Importação de sessões de outro arquivo YAML ou de um **inventário do Ansible** (INI/YAML)
- Tela de ajuda e atualização automática pelas releases do GitHub

## Instalação

Baixe o instalador `MultTerm-setup-<versão>.exe` na página de
[releases](https://github.com/acacio90/MultTerm/releases) e execute. A instalação é por
usuário (não pede administrador). O instalador não é assinado: o SmartScreen avisa na
primeira execução (*Mais informações → Executar assim mesmo*).

O próprio app verifica novas versões ao abrir e em **Ajuda → Buscar atualizações**.

## Sessões

```yaml
version: 1
sessions:
  - name: web-01
    folder: Servidores/Produção
    type: ssh            # ssh (padrão) ou rdp
    host: web-01.example.org
    user: deploy
    identityFile: ~/.ssh/id_ed25519
  - name: ad-01
    folder: Servidores/Infraestrutura
    type: rdp
    host: 10.0.0.9       # porta omitida = padrão (22 ssh / 3389 rdp)
```

A gravação é determinística (ordenada por pasta e nome, campos em ordem fixa) para gerar
diffs limpos. No app, o arquivo padrão fica em `%APPDATA%\MultTerm\sessions.yaml`; use
**Abrir arquivo…** para apontar para um arquivo versionado (a escolha é lembrada) ou defina
a variável `MULTTERM_SESSIONS`.

## Uso

- **Duplo clique** numa sessão abre uma aba de terminal (SSH) ou o cliente RDP.
- Selecionar texto copia; botão direito cola (ou Ctrl+Shift+C / Ctrl+Shift+V).
- Botão do meio do mouse fecha a aba; quando a sessão termina, **R** reconecta.
- Chave `.ppk` (PuTTY): o app usa a versão OpenSSH com o mesmo nome ao lado, se existir.
- **Janela externa** abre a sessão no Windows Terminal.
- **F1** ou o botão **Ajuda** abre a tela de ajuda.

### Importar sessões

**Importar sessões…** (ou `multterm import <arquivo>`) detecta o formato do arquivo e mescla
com as sessões existentes (mesma pasta + nome não é sobrescrito):

- **Sessões do MultTerm** (YAML com `sessions:`).
- **Inventário do Ansible** (INI ou YAML): cada grupo vira uma pasta (grupos filhos viram
  subpastas) e cada host uma sessão SSH, usando `ansible_host`, `ansible_port`,
  `ansible_user` e `ansible_ssh_private_key_file` (variáveis do host valem sobre as do grupo).
  Hosts com `ansible_connection=winrm`/`psrp` viram sessões RDP; faixas como `web[01:03]`
  são expandidas; valores com template Jinja são ignorados com aviso.

### Login sem senha (agente SSH)

1. PowerShell como administrador:
   `Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent`
2. KeePassXC → Configurações → Agente SSH: habilitar e marcar
   *Usar OpenSSH para Windows em vez do Pageant*.
3. Na entrada da chave (senha da chave no campo *Senha*), aba *Agente SSH*: escolher a chave
   privada (anexo ou arquivo) e marcar *Adicionar ao agente quando o banco for aberto* e
   *Remover quando for fechado*.

## Desenvolvimento

Requer Node.js 22.18+.

```sh
npm install
npm start            # compila e abre o app
npm test             # testes de unidade
npm run test:ui      # testes de interface (abre o app com Playwright)
npm run typecheck
npm run icon         # regenera desktop/icon.png a partir de desktop/icon.svg
npm run multterm -- list
npm run multterm -- import outro.yaml --dry-run
npm run multterm -- import inventario.ini --folder Ansible --dry-run
```

### Commits

As mensagens seguem o [Conventional Commits](https://www.conventionalcommits.org/pt-br/):
`tipo(escopo opcional): descrição`, com tipo em `feat`, `fix`, `docs`, `style`,
`refactor`, `perf`, `test`, `build`, `ci`, `chore` ou `revert` (`!` após o tipo/escopo
indica mudança incompatível). O `npm install` instala um hook `commit-msg` que recusa
mensagens fora do padrão.

```text
feat(terminal): reconecta a sessão com a tecla R
fix(sessions): rejeita host iniciado por "-"
docs: explica a configuração do agente SSH
```

### Branches

- `develop`: desenvolvimento do dia a dia; todo trabalho novo entra aqui.
- `main`: só versões lançadas; cada merge em `main` corresponde a uma tag `vX.Y.Z` e a uma
  release no GitHub.

### Gerar e publicar uma versão

1. Em `develop`: suba a `version` no `package.json` e registre as mudanças no `CHANGELOG.md`
   (commit `chore(release): X.Y.Z`).
2. Leve para a `main` e crie a tag:
   `git checkout main && git merge --ff-only develop && git tag -a vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`
3. `npm run release` gera o instalador e envia o `.exe`, o `.blockmap` e o `latest.yml` para uma
   release em rascunho; requer `GH_TOKEN` (ex.: `$env:GH_TOKEN = gh auth token`).
4. Confira os arquivos do rascunho, escreva as notas e publique. Os apps instalados encontram a
   versão nova em **Ajuda → Buscar atualizações**.
5. Feche o milestone da versão e volte para `develop`.

### Grafo de código (code-review-graph)

O projeto usa o [code-review-graph](https://github.com/tirth8205/code-review-graph) (MCP + hooks)
para manter um grafo do código atualizado:

```sh
uv tool install code-review-graph==2.3.9
code-review-graph build     # indexa só arquivos conhecidos pelo git (git add -N em arquivos novos)
```

O grafo é atualizado pelo hook `pre-commit` do git; o banco local fica em
`.code-review-graph/` (ignorado).

## Licença

[GPL-3.0](LICENSE)
