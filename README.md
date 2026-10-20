# MultTerm

[![CI](https://github.com/acacio90/MultTerm/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/acacio90/MultTerm/actions/workflows/ci.yml)

Gerenciador de sessões SSH/RDP com terminal em abas.
As sessões ficam num arquivo YAML legível e versionável, **sem limite de quantidade**.

## Funcionalidades

- Árvore de sessões com pastas e busca; criar, editar e excluir sessões
- **Terminal SSH embutido em abas** (xterm.js + node-pty), usando o OpenSSH do sistema
- Login por chave via agente SSH (ssh-agent do Windows, KeePassXC)
- **RDP numa aba** (cliente FreeRDP embutido), ou no cliente do Windows (`mstsc`) pelo menu
- Importação de sessões de outro arquivo YAML ou de um **inventário do Ansible** (INI/YAML)
- Exportação das sessões (todas ou uma pasta), dos sites de VPN ou de um **backup completo** para
  levar tudo a outra máquina
- **Ferramentas de rede**: ping, traceroute, consulta DNS, consulta SNMP (v1/v2c/v3), scanner de
  portas, scanner de rede, portas abertas locais, Wake-on-LAN e captura de pacotes
- **Servidores locais** TFTP, FTP/FTPS e HTTP para trocar arquivos com equipamentos, Iperf (iperf3)
  para medir banda, SSH/SFTP, Telnet, NFS somente leitura e VNC (experimentais) e um agendador
  de comandos (cron)
- **Agente MCP**: um agente de IA (configurado por você) lê e opera os terminais que você
  compartilhar, com aprovação de cada comando
- **VPN IPsec** sem instalar nada (motor próprio, IKEv1 + XAuth), com editor de sites, botão próprio
  na barra (com o estado) e sessões que conectam a VPN antes de abrir
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
    vpn: Matriz          # opcional: site de VPN conectado antes de abrir
  - name: ad-01
    folder: Servidores/Infraestrutura
    type: rdp
    host: 10.0.0.9       # porta omitida = padrão (22 ssh / 3389 rdp)
```

A gravação é determinística (ordenada por pasta e nome, campos em ordem fixa) para gerar
diffs limpos. No app, o arquivo padrão fica em `%APPDATA%\MultTerm\sessions.yaml`; use
**Arquivo → Abrir arquivo de sessões…** para apontar para um arquivo versionado (a escolha é lembrada) ou defina
a variável `MULTTERM_SESSIONS`.

## Uso

A barra superior tem só o que se usa toda hora: **+ Nova sessão** e **Ferramentas** à esquerda;
**VPN**, **Agente** e **Ajuda** à direita. O resto fica no menu do topo:

- **Arquivo**: nova sessão, nova pasta, abrir/recarregar o arquivo de sessões, **Importar** e
  **Exportar** (sessões, sites de VPN ou backup completo) e sair.
- **Sessão**: conectar, janela externa, Wake-on-LAN, editar e excluir a sessão selecionada.
- **Ferramentas**: terminal local, ferramentas de rede, servidores, VPN e agente.
- **Exibir**: mostrar/ocultar a barra lateral, zoom (Ctrl + / Ctrl - / Ctrl 0) e tela cheia (F11).
- **Ajuda**: ajuda (F1), verificar atualizações, página do projeto e sobre.

O menu quase não tem atalhos de teclado de propósito: eles valeriam antes do terminal e
roubariam teclas do bash, do tmux e de outros programas (Ctrl+N, Ctrl+O, Ctrl+B, F5...).

- **Duplo clique** numa sessão abre uma aba: terminal (SSH) ou área de trabalho remota (RDP).
- **Botão direito numa sessão**: Conectar, Janela externa, Ligar (Wake-on-LAN, se a sessão
  tem MAC), Ping, Traceroute, Scanner de portas, Consulta SNMP, Editar e **Excluir…** (com
  confirmação; com várias selecionadas, **Excluir as N selecionadas…**).
- **Várias sessões**: Ctrl+clique adiciona ou tira sessões da seleção e Shift+clique seleciona um
  intervalo (Esc limpa); botão direito numa delas → **Conectar as N selecionadas**.
- **Botão direito numa pasta**: Conectar todas, Nova subpasta, Nova sessão aqui, Renomear (move as sessões e
  subpastas) e Excluir (só pastas vazias). Na área vazia da árvore: Nova pasta. Uma pasta nova
  é gravada no arquivo quando uma sessão é salva dentro dela.
- Selecionar texto copia; botão direito cola (ou Ctrl+Shift+C / Ctrl+Shift+V).
- Botão do meio do mouse fecha a aba; quando a sessão termina, **R** reconecta.
- Chave `.ppk` (PuTTY): o app usa a versão OpenSSH com o mesmo nome ao lado, se existir.
- **Janela externa** abre a sessão no Windows Terminal.
- **Ordem das abas**: arraste uma aba para outra posição, use o botão direito na aba (**Mover
  para a esquerda/direita/início/fim**) ou **Ctrl+Shift+PageUp/PageDown** na aba ativa.
- **Arrastar uma aba de terminal para fora da barra de abas** a destaca numa janela própria, aberta
  onde a aba foi solta (soltar perto da barra não destaca).
- **Layout da área de abas** (ícones no canto direito da barra de abas): uma aba, duas lado a
  lado ou duas empilhadas. Na tela dividida, clicar numa aba a coloca na metade em foco (com
  borda destacada) e clicar dentro de uma metade passa o foco para ela. O layout fica lembrado.
- Switches e servidores antigos que só falam algoritmos SHA-1/ssh-rsa/CBC (o ssh recusa com
  "no matching key exchange method found"): a aba oferece **Permitir algoritmos antigos nesta
  sessão e reconectar**, que vale só para aquela sessão (opção *Aceitar algoritmos antigos* no
  formulário, gravada como `legacySsh: true`). Só entram os algoritmos que o `ssh` local suporta.
- **F1** ou o botão **Ajuda** abre a tela de ajuda.

### Ferramentas de rede

No menu **Ferramentas** (cada uma abre numa aba; o host da sessão selecionada vem preenchido):

- **Ping / Traceroute** — rodam num terminal embutido; ping sem quantidade é contínuo
  (Ctrl+C para parar) e **R** executa de novo.
- **Consulta DNS** — A, AAAA, CNAME, MX, TXT, NS, SOA e SRV; IP faz a consulta reversa (PTR).
  Usa os servidores DNS do sistema ou um IP informado.
- **Consulta SNMP** — v1/v2c (community) ou v3 (usuário, nível de segurança, autenticação
  MD5/SHA-1/SHA-2 e criptografia DES/AES); operações get, getnext, getbulk e walk; OIDs numéricos
  ou nomes comuns (`sysName`, `ifDescr`…), com valores formatados. As credenciais não são gravadas.
- **Scanner de portas** — lista e faixas (`22,80,8000-8100`) ou predefinições (`comuns`, `web`,
  `bancos`, `windows`); mostra aberta, fechada ou filtrada. Exporta CSV.
- **Scanner de rede** — CIDR (`10.0.0.0/24`), faixa (`10.0.0.10-50`) ou lista; descobre hosts por
  conexão TCP (22, 80, 443, 445, 3389), mostra nome e portas e cria sessões a partir do resultado.
  O nome vem do DNS reverso; com SNMP configurado (v1/v2c/v3), hosts sem DNS reverso são
  consultados pelo `sysName`. A coluna **Fonte** indica a origem do nome.
- **Portas abertas locais** — conexões e portas em escuta desta máquina com o processo dono
  (Windows), com filtro e atualização automática.

- **Wake-on-LAN** — envia o pacote mágico para um MAC (broadcast e porta configuráveis); com o
  campo **MAC** preenchido na sessão, liga a máquina pelo botão direito.
- **Captura de pacotes** — escolhe a interface, um filtro de captura (BPF, ex.: `host 10.0.0.5`)
  e limites opcionais; mostra a contagem ao vivo e grava `.pcapng` em
  `Documentos\MultTerm\Capturas`, com atalho para abrir no Wireshark. Requer o **Wireshark com
  o Npcap** instalados (o app usa o `dumpcap`); sem eles, a ferramenta explica como instalar.
  Sem o Wireshark, a captura usa o **pktmon** do Windows (10 1809+ / 11): filtros de IP, porta
  e protocolo em todas as placas de rede, mostra o tamanho capturado ao vivo e converte para
  `.pcapng` ao parar. O pktmon exige administrador: o Windows pede confirmação (UAC) a cada
  captura, só para ela (o app continua sem privilégios).

Nenhuma ferramenta exige rodar o app como administrador (a captura usa o Npcap no modo padrão,
sem a opção "restringir a administradores"; o modo pktmon pede a elevação só durante a captura).

### Agente MCP

O botão **Agente** liga um servidor [MCP](https://modelcontextprotocol.io) local para que um agente
de IA compatível com MCP — configurado por você, com a sua conta — leia e opere os terminais
abertos. O MultTerm não fala com nenhum serviço de IA: ele só expõe ferramentas ao agente.

- **Nada é compartilhado por padrão.** Para cada aba de terminal você escolhe: não compartilhar,
  **somente leitura**, **aprovar cada envio** (o MultTerm mostra exatamente o que será digitado e
  em qual aba, com Permitir / Permitir sempre nesta aba / Recusar) ou **controle livre**. Abas
  compartilhadas ganham uma marca (◉); **Definir todas** aplica um modo a todas as abas de uma vez e
  **Parar de compartilhar tudo** corta o acesso na hora.
- Ferramentas: `list_terminals`, `read_terminal` (a saída como texto, sem cores),
  `run_command` (digita, aperta Enter e devolve a saída quando ela para), `send_input` e
  `send_keys` (Enter, Ctrl+C, setas...). Os comandos rodam nos servidores reais das sessões.
- Conexão só em `127.0.0.1`, com token (guardado cifrado); pedidos de navegador são recusados.
  A tela do agente mostra a configuração pronta para colar: **stdio** (o próprio executável do
  MultTerm faz a ponte) ou **HTTP** (endereço e token).
- Tudo o que o agente lê ou envia fica no registro de atividade.
- **Abrir o agente no MultTerm**: escolha o agente na lista e clique em **Abrir o agente** — ele
  abre numa aba de terminal local, já ligado ao servidor, com a conta que você tem nele nesta
  máquina. A lista mostra os agentes encontrados na máquina (no PATH e nos caminhos de instalação
  comuns), com a versão; os não instalados aparecem desabilitados, e **Procurar de novo** refaz a
  busca depois de instalar um. Por enquanto o catálogo tem o Claude Code.

### Terminal local

**Ferramentas → Terminal local** abre PowerShell, Prompt de comando ou WSL numa aba, com a mesma
cópia/cola e reabertura (**R**) das abas SSH.

### Janelas separadas

Clique com o botão direito numa aba de terminal → **Abrir em janela separada** para levá-la a uma
janela própria (útil para ver duas sessões lado a lado ou em outro monitor). A sessão não é
reiniciada: a tela é redesenhada e o processo segue. Na janela separada, **Devolver à janela
principal** traz a aba de volta; o compartilhamento com o agente vai junto.

**Fechar a janela separada** (X ou Alt+F4) também devolve as abas à janela principal, sem
reiniciar as sessões; para encerrar uma sessão, feche a **aba**. Fechar a janela principal encerra o
MultTerm, inclusive as janelas separadas.

### Servidores

**Ferramentas → Servidores** inicia e para servidores locais, cada um com porta, pasta raiz,
"parar depois de N segundos" (1 hora por padrão) e log com horário; as configurações ficam
lembradas e todos param ao sair do MultTerm. Os arquivos ficam em `Documentos\MultTerm\Servidor`
(ou na pasta escolhida) e nenhum servidor sai da pasta raiz.
**Escutar em** escolhe onde cada servidor atende: todas as interfaces, só esta máquina
(127.0.0.1) ou uma placa de rede específica (a lista mostra as placas com o IPv4 de cada uma).
Fora do localhost, o log lembra de liberar a porta no Firewall do Windows se os equipamentos não
conseguirem conectar.

- **TFTP** (porta 69): baixar e enviar firmware e configurações de equipamentos, com negociação
  de bloco (até 64 KB), tamanho e timeout, arquivos grandes, opção de bloquear envio ou
  sobrescrita e aviso do Windows a cada transferência.
- **FTP** (porta 21): usuário e senha (guardada cifrada pelo Windows, nunca em texto puro),
  anônimo só leitura opcional, modos passivo e ativo, retomada, renomear e apagar; FTPS
  implícito opcional com certificado autoassinado gerado na primeira vez; opção de perguntar
  antes de aceitar cada conexão.
- **HTTP** (porta 8080): serve a pasta só para leitura, com listagem opcional, `index.html` e
  retomada de download.
- **SSH/SFTP** (porta 22): usuário e senha do painel (cifrada), SFTP restrito à pasta raiz e shell
  do Windows (PowerShell ou cmd) pelo ConPTY, inclusive `ssh usuário@ip comando`. A chave de host
  ed25519 é gerada na primeira vez e a impressão digital aparece no log.
- **Telnet** (porta 23): shell do Windows (PowerShell ou cmd) pelo ConPTY, com senha obrigatória
  e confirmação de cada conexão ligada por padrão. Não é cifrado: use só em rede confiável.
- **Agendador (cron)**: tarefas no formato do crontab (`*/5 * * * * comando`, `0 7 * * mon-fri ...`,
  `@daily ...`) rodadas no PowerShell ou no cmd enquanto o MultTerm estiver aberto, com a saída
  no log; pode iniciar junto com o app.
- **Iperf** (porta 5201): compatível com o cliente `iperf3` (TCP, `-R` e `-P`; UDP ainda não).
  O cliente iperf3 do Windows usa buffer de envio pequeno: para medir acima de ~600 Mbit/s, use
  `-P 4` ou `-w 1M`.
- **NFS** (experimental, porta 2049 + portmapper na 111): NFSv3 **somente leitura** da pasta
  raiz, exportada como `/`, para equipamentos que fazem boot ou atualização por NFS
  (`mount -t nfs -o vers=3,nolock <ip>:/ /mnt`). TCP e UDP; MOUNT v1/v3. **Clientes permitidos**
  limita por IP ou faixa (`10.0.0.0/24`). O log mostra quem montou e quais arquivos foram lidos.
  Sem o portmapper (porta 111 ocupada), o cliente precisa de `port=2049,mountport=2049`.
- **VNC** (experimental, porta 5900): compartilha a tela principal com qualquer visualizador VNC
  (TightVNC, RealVNC, TigerVNC...). Senha obrigatória (até 8 caracteres, limite do protocolo);
  **somente visualização** e **perguntar antes de aceitar** vêm ligados; com o controle ligado,
  mouse e teclado do visualizador agem neste computador. **Clientes permitidos** como no NFS.
  O VNC não cifra o tráfego: use só em rede confiável ou por um túnel (VPN, SSH). A tela segura
  do Windows (UAC, Ctrl+Alt+Del) não aparece. Acesso pelo navegador ainda não.

Na primeira vez, o Firewall do Windows pergunta se o MultTerm pode receber conexões na rede.

### VPN

O botão **VPN** (barra superior, ao lado do Agente) conecta a VPNs IPsec/IKEv1 sem instalar
nada: o próprio MultTerm negocia o IKEv1 (Main Mode, chave compartilhada com ou sem usuário e senha/XAuth, Mode Config) e cifra o
tráfego (ESP em UDP 4500/NAT-T). O adaptador "MultTerm VPN" usa o [Wintun](https://www.wintun.net)
que acompanha o instalador; criá-lo exige administrador, então o Windows pede confirmação (UAC) a
cada conexão — só o processo do túnel roda elevado, o MultTerm não. IP, rotas e DNS ficam só na
memória e somem ao desconectar.

- **Novo site / Editar / Exportar… / Excluir / Importar site (.vpn)…**: gateway, autenticação
  (PSK, usuário lembrado, identificações), cliente (endereço, DNS), NAT-T, fragmentação, fases 1
  e 2 e redes da VPN em CIDR. Um site novo já vem com AES-256, SHA-2 256 e DH 14. A chave
  compartilhada nunca aparece na tela (em branco mantém a atual) e opções que o editor não
  mostra são preservadas. Os sites ficam em `%APPDATA%\multterm\vpn-sites` no formato `.vpn`
  (o mesmo de outros clientes IPsec); na primeira vez, sites de um cliente IPsec instalado antes
  são copiados para lá.
- Mostra o estado (conectando/conectada), o log da negociação e o motivo das falhas (gateway sem
  resposta, chave ou senha recusadas, propostas que não conferem). O registro completo fica em
  `%TEMP%\multterm-vpn.log`.
- Conectada, mostra o IP recebido e as redes roteadas pelo túnel, com atalho para o scanner de
  rede — o caminho para descobrir os ativos do outro lado.
- A conexão é uma só e não depende da aba: o botão **VPN** na barra superior mostra o
  estado (`VPN: <site>` com um ponto colorido quando ligada) e abre a aba. Sair do MultTerm
  desconecta a VPN.
- Uma sessão com o campo **VPN** preenchido abre a VPN primeiro e se conecta assim que ela sobe.
- Limites atuais: só chave compartilhada (sem certificados), Main Mode, NAT-T sempre ligado, IPv4.

### Exportar e importar

Os menus **Arquivo → Exportar** e **Arquivo → Importar** oferecem:

- **Sessões** (abaixo).
- **Sites de VPN**: exporta todos os sites, um `.vpn` por site, numa pasta; importa um `.vpn`.
- **Backup completo**: um arquivo `.multterm` com as sessões, os sites de VPN, as configurações
  dos servidores e a escolha do agente. Ao importar, sessões e sites que já existem são mantidos
  (só os novos entram) e as configurações dos servidores e do agente são substituídas.
  As senhas dos servidores e o token do agente **não** vão no backup (são cifrados para o seu
  usuário do Windows e não abririam em outra máquina): preencha de novo depois de importar.
  Os sites de VPN levam a chave compartilhada (PSK): guarde o backup com cuidado.

### Exportar sessões

**Arquivo → Exportar → Sessões…** grava todas as sessões num YAML; **Exportar pasta…**
(botão direito numa pasta) grava só a pasta e as subpastas, com os caminhos completos. O
arquivo é o mesmo formato que **Arquivo → Importar → Sessões…** lê — serve de backup e para levar as
sessões a outra máquina. Não há senhas no arquivo (o app não guarda senhas).

**Arquivo → Abrir arquivo de sessões…** é diferente: troca o arquivo de sessões que o app usa (por exemplo, um
`sessions.yaml` versionado no git), e a escolha é lembrada.

### Importar sessões

**Arquivo → Importar → Sessões…** (ou `multterm import <arquivo>`) detecta o formato do arquivo e mescla
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

### RDP numa aba

Sessões RDP abrem numa aba, com o cliente [FreeRDP](https://www.freerdp.com) (Apache 2.0)
que vem com o instalador encaixado na área da aba:

- O MultTerm pede usuário e senha ao conectar. A senha não é gravada: fica só na memória da
  aba (para **Reconectar** sem digitar de novo) e vai ao cliente pela entrada padrão, nunca pela
  linha de comando. Usuário no formato `DOMINIO\usuario` ou `usuario@dominio`.
- A resolução acompanha o tamanho da aba. Área de transferência compartilhada.
- Menus e diálogos do MultTerm que passam por cima da área escondem a sessão enquanto estão
  abertos (a área remota é uma janela nativa e ficaria por cima deles).
- Quando a sessão cai, a aba mostra o motivo em português (senha incorreta, porta fechada,
  conta bloqueada...) com **Reconectar** e **Abrir no cliente do Windows**.
- Servidores Windows antigos que só falam TLS 1.0 são recusados por padrão. A tela de erro
  oferece **Permitir TLS antigo nesta sessão e reconectar**, que vale só para aquela sessão
  (opção *Aceitar TLS antigo* no formulário, gravada como `legacyTls: true`).
- **Janela externa (cliente do Windows)** no botão direito abre no `mstsc`, como antes.
- **Abrir em todos os monitores** (botão direito na sessão ou na aba RDP): abre o cliente do
  Windows em tela cheia usando todos os monitores, e o Windows remoto enxerga cada monitor
  separado. Se a sessão estava numa aba, a aba fecha (a conexão nova assume a sessão remota). Com a
  opção *Abrir sempre em todos os monitores* no formulário (`multimon: true`), o duplo clique já
  abre assim.
- **Enviar Ctrl+Alt+Del** (botão direito na aba RDP): pelo teclado, essa combinação fica no
  Windows local; pelo menu, vai para a sessão remota (bloquear, trocar a senha, gerenciador de
  tarefas).
- Abas RDP não podem ir para uma janela separada.

O `wfreerdp.exe` é compilado pelo workflow `.github/workflows/freerdp.yml` a partir do
código-fonte oficial (hash conferido) e publicado numa release auxiliar (`freerdp-<versão>`);
`npm run fetch:freerdp` o baixa para `vendor/freerdp`, conferindo o hash.

## Desenvolvimento

Ambiente, padrão de commits e branches, fluxo de PRs, testes e como gerar uma versão estão no
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

[GPL-3.0](LICENSE). O instalador inclui o [FreeRDP](https://github.com/FreeRDP/FreeRDP) (Apache 2.0,
licença em `resources/freerdp/LICENSE.txt`) e o [Wintun](https://www.wintun.net).
