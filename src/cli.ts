#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { effectivePort, SessionError, type Session } from './sessions/model.ts';
import { readImportFile } from './sessions/import.ts';
import { groupByFolder, loadSessionFile, mergeSessions, saveSessionFile, serializeSessions } from './sessions/store.ts';

const USAGE = `uso: multterm <comando> [opções]

comandos:
  list                         lista as sessões agrupadas por pasta
  validate                     valida o arquivo de sessões
  import <arquivo>             importa sessões YAML ou inventário do Ansible (INI/YAML), mantendo as existentes

opções:
  --file <caminho>   arquivo de sessões (padrão: $MULTTERM_SESSIONS ou ./sessions.yaml)
  --folder <pasta>   (import) pasta raiz para as sessões importadas
  --dry-run          (import) mostra o resultado sem gravar
`;

function describe(s: Session): string {
  const target = `${s.user ? `${s.user}@` : ''}${s.host}:${effectivePort(s)}`;
  return `${s.name}  [${s.type}] ${target}`;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      folder: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    process.stdout.write(USAGE);
    return command || values.help ? 0 : 1;
  }
  const file = values.file ?? process.env.MULTTERM_SESSIONS ?? 'sessions.yaml';

  switch (command) {
    case 'list': {
      const sessions = await loadSessionFile(file);
      for (const [folder, list] of groupByFolder(sessions)) {
        console.log(folder ? `${folder}/` : '(raiz)');
        for (const s of list) console.log(`  ${describe(s)}`);
      }
      console.log(`\n${sessions.length} sessões em ${file}`);
      return 0;
    }

    case 'validate': {
      const sessions = await loadSessionFile(file);
      console.log(`${file}: ok (${sessions.length} sessões)`);
      return 0;
    }

    case 'import': {
      const source = rest[0];
      if (!source) {
        process.stderr.write('informe o arquivo a importar (sessões YAML ou inventário do Ansible)\n');
        return 1;
      }
      const { format, sessions: imported, warnings } = await readImportFile(source, values.folder ?? '');
      console.error(`formato: ${format === 'ansible' ? 'inventário do Ansible' : 'sessões do MultTerm'}`);
      for (const w of warnings) console.warn(`aviso: ${w}`);

      const existing = await loadSessionFile(file);
      const { merged, added, skipped } = mergeSessions(existing, imported);
      for (const s of skipped) console.warn(`já existe, mantida: ${s.folder ? `${s.folder}/` : ''}${s.name}`);

      if (values['dry-run']) {
        process.stdout.write(serializeSessions(merged));
      } else {
        await saveSessionFile(file, merged);
      }
      console.error(`${added.length} importadas, ${skipped.length} já existentes` +
        (values['dry-run'] ? ' (dry-run, nada gravado)' : ` → ${file}`));
      return 0;
    }

    default:
      process.stderr.write(`comando desconhecido: ${command}\n\n${USAGE}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`erro: ${err instanceof SessionError ? err.message : (err as Error).stack}\n`);
    process.exitCode = 1;
  },
);
