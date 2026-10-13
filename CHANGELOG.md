# Changelog

Todas as mudanças relevantes do MultTerm. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Menu **Ferramentas** com ferramentas de rede, cada uma numa aba: ping e traceroute num
  terminal embutido (#9), consulta DNS (#11), scanner de portas (#6), scanner de rede com
  criação de sessão a partir do resultado (#5) e portas abertas locais com o processo dono (#7).
- Consulta SNMP v1/v2c/v3 (get, getnext, getbulk e walk), com nomes de OIDs comuns e valores
  formatados; credenciais só em memória. (#14)
- Scanner de rede busca o nome pelo `sysName` via SNMP quando não há DNS reverso, com a
  coluna **Fonte** (DNS/SNMP).
- Exportar sessões (todas, pela barra, ou uma pasta com subpastas, pelo menu de contexto) para
  um YAML que a importação lê.
- Menu de contexto nas pastas da árvore: nova subpasta, nova sessão aqui, renomear (move
  sessões e subpastas) e excluir pasta vazia; na área vazia, nova pasta na raiz.

### Corrigido

- As notas da versão aparecem como texto (e não HTML cru) ao anunciar uma atualização na
  ajuda. (#13)
- Publicação de release sem rascunhos duplicados (`npm run release`).
- O scanner de rede mostra o nome (DNS reverso) usando os servidores DNS do sistema.
- A aba **Sessão** ficava espremida (metade da altura) quando havia uma aba de terminal ou
  ferramenta aberta.

## [0.2.0] - 2026-10-12

### Adicionado

- Importação de inventário do Ansible (INI ou YAML): grupos viram pastas, hosts viram sessões
  SSH (ou RDP para `winrm`/`psrp`); detecção automática do formato em **Importar sessões…**
  e em `multterm import` (com `--folder` para a pasta raiz). (#4)
- Ícone próprio do aplicativo (janela, executável e instalador), gerado a partir de
  `desktop/icon.svg` com `npm run icon`. (#1)
- Testes de interface com Playwright abrindo o app real (`npm run test:ui`) e CI no GitHub
  Actions rodando typecheck, testes de unidade e de interface no Windows. (#2)

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

[Não lançado]: https://github.com/acacio90/MultTerm/compare/v0.2.0...develop
[0.2.0]: https://github.com/acacio90/MultTerm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/acacio90/MultTerm/releases/tag/v0.1.0
