import { app, Menu, type MenuItemConstructorOptions } from 'electron';

/*
 * Menu do topo da janela. Cada item manda um comando para a janela principal, que reaproveita
 * as mesmas funções dos botões. Quase nenhum atalho de teclado é registrado: atalhos do menu
 * valem antes do terminal e roubariam teclas do bash/tmux/vim (Ctrl+N, Ctrl+O, Ctrl+B, F5...).
 * O F1 aparece no menu mas é tratado pela página (que sabe se o foco está num terminal).
 */
export type MenuCommand =
  | 'new-session' | 'new-folder' | 'open-file' | 'reload' | 'default-key'
  | 'import-sessions' | 'import-zabbix' | 'import-vpn' | 'import-backup'
  | 'export-sessions' | 'export-vpn' | 'export-backup'
  | 'connect' | 'external' | 'wol' | 'edit' | 'delete'
  | 'local-powershell' | 'local-cmd' | 'local-wsl'
  | 'ping' | 'traceroute' | 'dns' | 'snmp' | 'portscan' | 'netscan' | 'localports' | 'capture'
  | 'wol-tool' | 'servers' | 'vpn' | 'agent'
  | 'toggle-sidebar' | 'help' | 'check-updates';

export interface MenuActions {
  send: (command: MenuCommand) => void;
  openProject: () => void;
  about: () => void;
}

export function buildAppMenu({ send, openProject, about }: MenuActions): Menu {
  const cmd = (id: MenuCommand, label: string, extra: Partial<MenuItemConstructorOptions> = {}): MenuItemConstructorOptions =>
    ({ id, label, click: () => send(id), ...extra });
  const sep: MenuItemConstructorOptions = { type: 'separator' };

  const template: MenuItemConstructorOptions[] = [
    {
      label: '&Arquivo',
      submenu: [
        cmd('new-session', 'Nova sessão'),
        cmd('new-folder', 'Nova pasta…'),
        sep,
        cmd('open-file', 'Abrir arquivo de sessões…'),
        cmd('reload', 'Recarregar sessões do arquivo'),
        cmd('default-key', 'Chave SSH padrão…'),
        sep,
        {
          label: 'Importar',
          submenu: [
            cmd('import-sessions', 'Sessões (YAML ou inventário INI)…'),
            cmd('import-zabbix', 'Hosts do Zabbix…'),
            cmd('import-vpn', 'Site de VPN (.vpn)…'),
            sep,
            cmd('import-backup', 'Backup completo…'),
          ],
        },
        {
          label: 'Exportar',
          submenu: [
            cmd('export-sessions', 'Sessões…'),
            cmd('export-vpn', 'Sites de VPN…'),
            sep,
            cmd('export-backup', 'Backup completo…'),
          ],
        },
        sep,
        { role: 'quit', label: 'Sair' },
      ],
    },
    {
      label: '&Sessão',
      submenu: [
        cmd('connect', 'Conectar'),
        cmd('external', 'Abrir em janela externa'),
        cmd('wol', 'Ligar (Wake-on-LAN)'),
        sep,
        cmd('edit', 'Editar'),
        cmd('delete', 'Excluir…'),
      ],
    },
    {
      label: '&Ferramentas',
      submenu: [
        {
          label: 'Terminal local',
          submenu: [
            cmd('local-powershell', 'PowerShell'),
            cmd('local-cmd', 'Prompt de comando'),
            cmd('local-wsl', 'WSL'),
          ],
        },
        sep,
        cmd('ping', 'Ping…'),
        cmd('traceroute', 'Traceroute…'),
        cmd('dns', 'Consulta DNS'),
        cmd('snmp', 'Consulta SNMP'),
        sep,
        cmd('portscan', 'Scanner de portas'),
        cmd('netscan', 'Scanner de rede'),
        cmd('localports', 'Portas abertas locais'),
        cmd('capture', 'Captura de pacotes'),
        cmd('wol-tool', 'Wake-on-LAN'),
        sep,
        cmd('servers', 'Servidores (TFTP, HTTP…)'),
        cmd('vpn', 'VPN'),
        cmd('agent', 'Agente MCP'),
      ],
    },
    {
      label: '&Exibir',
      submenu: [
        cmd('toggle-sidebar', 'Mostrar/ocultar a barra lateral'),
        sep,
        { role: 'zoomIn', label: 'Aumentar o zoom' },
        { role: 'zoomOut', label: 'Diminuir o zoom' },
        { role: 'resetZoom', label: 'Zoom normal' },
        sep,
        { role: 'togglefullscreen', label: 'Tela cheia' },
        ...(app.isPackaged ? [] : [sep, { role: 'toggleDevTools', label: 'Ferramentas do desenvolvedor' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: 'Aj&uda',
      submenu: [
        cmd('help', 'Ajuda', { accelerator: 'F1', registerAccelerator: false }),
        cmd('check-updates', 'Verificar atualizações'),
        sep,
        { id: 'project', label: 'Página do projeto', click: openProject },
        { id: 'about', label: 'Sobre o MultTerm', click: about },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
