# Changelog

Todas as mudanças relevantes do MultTerm. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Importação de inventário do Ansible (INI ou YAML): grupos viram pastas, hosts viram sessões
  SSH (ou RDP para `winrm`/`psrp`); detecção automática do formato em **Importar sessões…**
  e em `multterm import` (com `--folder` para a pasta raiz). (#4)
- Ícone próprio do aplicativo (janela, executável e instalador), gerado a partir de
  `desktop/icon.svg` com `npm run icon`. (#1)

## [0.1.0] - 2026-10-12

Primeira versão.

### Adicionado

- Sessões SSH e RDP num arquivo YAML legível e versionável, sem limite de quantidade,
  com gravação determinística para diffs limpos.
- Árvore de sessões com pastas e busca; criar, editar, excluir e importar sessões de outro
  arquivo YAML (mesclando com as existentes).
- Terminal SSH embutido em abas (xterm.js + node-pty) usando o OpenSSH do sistema:
  selecionar copia, botão direito cola, botão do meio fecha a aba e **R** reconecta.
- Login por chave via agente SSH (ssh-agent do Windows / KeePassXC); chaves `.ppk` usam a
  versão OpenSSH ao lado, quando existe.
- RDP pelo cliente do sistema (`mstsc`) e opção de abrir SSH em janela externa
  (Windows Terminal).
- Tela de ajuda (F1) com atalhos, status do agente SSH e informações do sistema.
- Atualização automática pelas releases do GitHub.
- Instalador para Windows x64 (NSIS, instalação por usuário).
- CLI `multterm` (`list`, `validate`, `import`).

[Não lançado]: https://github.com/acacio90/MultTerm/compare/v0.1.0...develop
[0.1.0]: https://github.com/acacio90/MultTerm/releases/tag/v0.1.0
