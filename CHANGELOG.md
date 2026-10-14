# Changelog

Todas as mudanças relevantes do MultTerm. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado

- Agente MCP: servidor MCP local (HTTP em 127.0.0.1 com token, ou ponte stdio pelo próprio
  executável) que deixa um agente de IA listar, ler e operar os terminais compartilhados, com
  permissão por aba (somente leitura, aprovar cada envio ou controle livre), janela de
  aprovação, marca nas abas, corte imediato e registro de atividade. (#30)

## [0.3.0] - 2026-10-13

### Adicionado

- Menu **Ferramentas** com ferramentas de rede, cada uma numa aba: ping e traceroute num
  terminal embutido (#9), consulta DNS (#11), scanner de portas (#6), scanner de rede com
  criação de sessão a partir do resultado (#5) e portas abertas locais com o processo dono (#7).
- Consulta SNMP v1/v2c/v3 (get, getnext, getbulk e walk), com nomes de OIDs comuns e valores
  formatados; credenciais só em memória. (#14)
- Scanner de rede busca o nome pelo `sysName` via SNMP quando não há DNS reverso, com a
  coluna **Fonte** (DNS/SNMP).
- Wake-on-LAN: campo **MAC** opcional nas sessões (validado e normalizado), ferramenta avulsa
  e ação **Ligar** no novo menu de contexto das sessões, que também traz Conectar, Ping,
  Traceroute, Scanner de portas e Consulta SNMP com o host da sessão. (#10)
- Captura de pacotes com o `dumpcap` do Wireshark (Npcap): interface, filtro BPF e limites,
  contagem ao vivo, arquivo `.pcapng` e atalho para abrir no Wireshark; sem Wireshark, a
  ferramenta orienta a instalação. (#8)
- Captura de pacotes sem instalar nada: modo de reserva com o `pktmon` do Windows, com filtros
  de IP, porta e protocolo, uma confirmação do UAC por captura e o mesmo `.pcapng` no fim;
  com os dois disponíveis, um seletor escolhe o motor. (#15)
- Servidores locais em Ferramentas → Servidores (iniciar/parar, porta, pasta raiz, parada
  automática, log e configurações lembradas): TFTP com opções blksize/tsize/timeout e arquivos
  grandes, e HTTP de arquivos com listagem e Range. (#20, #21, #22)
- Servidor FTP com usuário e senha (cifrada pelo Windows), anônimo só leitura, modos passivo e
  ativo, retomada, FTPS implícito com certificado autoassinado e confirmação de cada conexão.
  (#23)
- Servidor SSH/SFTP com usuário e senha, SFTP restrito à pasta raiz, shell do Windows pelo ConPTY,
  execução de comandos e chave de host ed25519 persistente. (#24)
- Servidor Telnet com senha, shell do Windows pelo ConPTY (PowerShell ou cmd), tamanho de janela
  (NAWS) e confirmação de cada conexão. (#25)
- Agendador de comandos no formato do crontab (intervalos, passos, nomes e atalhos @daily etc.),
  com saída no log e opção de iniciar junto com o app. (#27)
- Servidor de teste de banda compatível com o cliente iperf3 (TCP, reverso e vários fluxos). (#26)
- VPN IPsec sem instalar nada: motor próprio (IKEv1 Main Mode com PSK e XAuth, Mode Config,
  Quick Mode com PFS, ESP em UDP com NAT-T, DPD e renovação de chaves) com adaptador Wintun num
  processo auxiliar elevado (UAC por conexão); mostra estado, log, erros traduzidos e as redes
  acessíveis (com atalho para o scanner de rede), indicador na barra superior e desconexão ao
  sair; campo opcional `vpn` na sessão conecta a VPN antes de abri-la. (#16, #18, #19)
- Editor de sites da VPN: criar, editar, renomear, excluir, importar e exportar (.vpn), com
  padrões fortes para sites novos, a PSK fora da interface e preservação das opções que o
  editor não conhece. (#17)
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

[Não lançado]: https://github.com/acacio90/MultTerm/compare/v0.3.0...develop
[0.3.0]: https://github.com/acacio90/MultTerm/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/acacio90/MultTerm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/acacio90/MultTerm/releases/tag/v0.1.0
