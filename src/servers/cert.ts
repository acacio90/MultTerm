import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/*
 * Certificado autoassinado para os servidores com TLS (FTPS): no Windows, gerado pelo próprio
 * sistema (New-SelfSignedCertificate), exportado como PFX protegido por senha e removido do
 * repositório de certificados logo em seguida; nos outros sistemas, pelo openssl. O app guarda o
 * PFX e a senha (cifrada) para reutilizar.
 */

export interface PfxCert {
  pfx: Buffer;
  passphrase: string;
}

/** Gera o PFX em `path` (se ainda não existir) e devolve o conteúdo. */
export async function ensureSelfSignedPfx(path: string, passphrase: string | undefined): Promise<PfxCert & { created: boolean }> {
  const saved = passphrase ? await readFile(path).catch(() => undefined) : undefined;
  if (passphrase && saved) return { pfx: saved, passphrase, created: false };
  if (!/^[\w:\\/ .()-]+$/.test(path)) throw new Error('caminho do certificado inválido');
  const pass = randomBytes(24).toString('hex');
  await mkdir(dirname(path), { recursive: true });
  if (process.platform !== 'win32') {
    await opensslPfx(path, pass);
    return { pfx: await readFile(path), passphrase: pass, created: true };
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // O drive Cert: só existe com o módulo de segurança carregado (o carregamento automático falha às vezes).
    'Import-Module Microsoft.PowerShell.Security, PKI',
    "$c = New-SelfSignedCertificate -Subject 'CN=MultTerm' -FriendlyName 'MultTerm (servidores locais)' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(5)",
    'try {',
    `  Export-PfxCertificate -Cert $c -FilePath '${path.replace(/'/g, "''")}' -Password (ConvertTo-SecureString '${pass}' -AsPlainText -Force) | Out-Null`,
    '} finally {',
    '  Remove-Item -LiteralPath $c.PSPath -Force',
    '}',
  ].join('\n');
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60_000, env: windowsPowerShellEnv() }, (err, _o, stderr) => {
      if (err) reject(new Error(`não foi possível gerar o certificado: ${String(stderr || err.message).trim().split('\n')[0]}`));
      else resolve();
    });
  });
  return { pfx: await readFile(path), passphrase: pass, created: true };
}

const run = (file: string, args: string[], env: NodeJS.ProcessEnv) => new Promise<void>((resolve, reject) => {
  execFile(file, args, { timeout: 60_000, env }, (err, _o, stderr) => {
    if (err) reject(new Error(`não foi possível gerar o certificado (${file}): ${String(stderr || err.message).trim().split('\n')[0]}`));
    else resolve();
  });
});

/**
 * PFX pelo openssl: chave e certificado numa pasta temporária só do usuário, apagada no fim. A
 * senha vai por variável de ambiente (na linha de comando, outros processos a leriam).
 */
async function opensslPfx(path: string, pass: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'multterm-cert-'));
  try {
    const key = join(dir, 'key.pem');
    const crt = join(dir, 'cert.pem');
    const env = { ...process.env, MULTTERM_PFX_PASS: pass };
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt,
      '-days', '1825', '-subj', '/CN=MultTerm'], env);
    await run('openssl', ['pkcs12', '-export', '-inkey', key, '-in', crt, '-out', path, '-name', 'MultTerm (servidores locais)',
      '-passout', 'env:MULTTERM_PFX_PASS'], env);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Ambiente para o Windows PowerShell 5.1 sem o PSModulePath herdado do PowerShell 7 (quando o app
 * é aberto a partir do pwsh, o 5.1 tenta carregar os módulos do 7 e falha com "Error in TypeData").
 */
export function windowsPowerShellEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PSModulePath;
  return env;
}
