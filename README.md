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
- Exportação das sessões (todas ou uma pasta) para backup ou outra máquina
- **Ferramentas de rede**: ping, traceroute, consulta DNS, consulta SNMP (v1/v2c/v3), scanner de
  portas, scanner de rede, portas abertas locais, Wake-on-LAN e captura de pacotes
- **Servidores locais** TFTP, FTP/FTPS e HTTP para trocar arquivos com equipamentos, Iperf (iperf3)
  para medir banda, SSH/SFTP, Telnet e um agendador de comandos (cron)
- **Agente MCP**: um agente de IA (configurado por você) lê e opera os terminais que você
  compartilhar, com aprovação de cada comando
- **VPN IPsec** sem instalar nada (motor próprio, IKEv1 + XAuth), com editor de sites, indicador
  na barra e sessões que conectam a VPN antes de abrir
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
**Abrir arquivo…** para apontar para um arquivo versionado (a escolha é lembrada) ou defina
a variável `MULTTERM_SESSIONS`.

## Uso

- **Duplo clique** numa sessão abre uma aba de terminal (SSH) ou o cliente RDP.
- **Botão direito numa sessão**: Conectar, Janela externa, Ligar (Wake-on-LAN, se a sessão
  tem MAC), Ping, Traceroute, Scanner de portas, Consulta SNMP e Editar.
- **Botão direito numa pasta**: Nova subpasta, Nova sessão aqui, Renomear (move as sessões e
  subpastas) e Excluir (só pastas vazias). Na área vazia da árvore: Nova pasta. Uma pasta nova
  é gravada no arquivo quando uma sessão é salva dentro dela.
- Selecionar texto copia; botão direito cola (ou Ctrl+Shift+C / Ctrl+Shift+V).
- Botão do meio do mouse fecha a aba; quando a sessão termina, **R** reconecta.
- Chave `.ppk` (PuTTY): o app usa a versão OpenSSH com o mesmo nome ao lado, se existir.
- **Janela externa** abre a sessão no Windows Terminal.
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
  compartilhadas ganham uma marca (◉); **Parar de compartilhar tudo** corta o acesso na hora.
- Ferramentas: `list_terminals`, `read_terminal` (a saída como texto, sem cores),
  `run_command` (digita, aperta Enter e devolve a saída quando ela para), `send_input` e
  `send_keys` (Enter, Ctrl+C, setas...). Os comandos rodam nos servidores reais das sessões.
- Conexão só em `127.0.0.1`, com token (guardado cifrado); pedidos de navegador são recusados.
  A tela do agente mostra a configuração pronta para colar: **stdio** (o próprio executável do
  MultTerm faz a ponte) ou **HTTP** (endereço e token).
- Tudo o que o agente lê ou envia fica no registro de atividade.
- **Abrir o agente no MultTerm**: informe o comando do seu agente (uma vez) e clique em **Abrir o
  agente** — ele abre numa aba de terminal local, já ligado ao servidor. Onde o agente espera o
  arquivo de configuração MCP, use `{mcp}` (ex.: `meu-agente --mcp-config {mcp}`); o MultTerm troca
  pelo arquivo que ele gera.

### Terminal local

**Ferramentas → Terminal local** abre PowerShell, Prompt de comando ou WSL numa aba, com a mesma
cópia/cola e reabertura (**R**) das abas SSH.

### Servidores

**Ferramentas → Servidores** inicia e para servidores locais, cada um com porta, pasta raiz,
"parar depois de N segundos" (1 hora por padrão) e log com horário; as configurações ficam
lembradas e todos param ao sair do MultTerm. Os arquivos ficam em `Documentos\MultTerm\Servidor`
(ou na pasta escolhida) e nenhum servidor sai da pasta raiz.

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

Na primeira vez, o Firewall do Windows pergunta se o MultTerm pode receber conexões na rede.

### VPN

**Ferramentas → VPN** conecta a VPNs IPsec/IKEv1 sem instalar nada: o próprio MultTerm negocia
o IKEv1 (Main Mode, chave compartilhada com ou sem usuário e senha/XAuth, Mode Config) e cifra o
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
- A conexão é uma só e não depende da aba: o indicador **VPN:** na barra superior mostra o
  estado e abre a aba. Sair do MultTerm desconecta a VPN.
- Uma sessão com o campo **VPN** preenchido abre a VPN primeiro e se conecta assim que ela sobe.
- Limites atuais: só chave compartilhada (sem certificados), Main Mode, NAT-T sempre ligado, IPv4.

### Exportar sessões

**Exportar sessões…** (barra superior) grava todas as sessões num YAML; **Exportar pasta…**
(botão direito numa pasta) grava só a pasta e as subpastas, com os caminhos completos. O
arquivo é o mesmo formato que **Importar sessões…** lê — serve de backup e para levar as
sessões a outra máquina. Não há senhas no arquivo (o app não guarda senhas).

**Abrir arquivo…** é diferente: troca o arquivo de sessões que o app usa (por exemplo, um
`sessions.yaml` versionado no git), e a escolha é lembrada.

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

O motor de VPN tem testes de interoperabilidade contra um gateway strongSwan em Docker
(`npm run test:ipsec`) e um teste da pilha completa no Windows, que pede UAC:
`npm run test:ipsec -- --keep && npm run build && node test/ipsec-gateway/e2e-elevated.ts`.


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
3. `npm run release` cria o rascunho da release da tag, gera o instalador e envia o `.exe`, o
   `.blockmap` e o `latest.yml`. Usa o login do `gh` (ou `GH_TOKEN`) e recusa versões já
   publicadas; `node scripts/release.mjs --dry-run` só confere.
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
