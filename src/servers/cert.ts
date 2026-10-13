import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/*
 * Certificado autoassinado para os servidores com TLS (FTPS): gerado pelo próprio Windows
 * (New-SelfSignedCertificate), exportado como PFX protegido por senha e removido do repositório
 * de certificados logo em seguida. O app guarda o PFX e a senha (cifrada) para reutilizar.
 */

export interface PfxCert {
  pfx: Buffer;
  passphrase: string;
}

/** Gera o PFX em `path` (se ainda não existir) e devolve o conteúdo. */
export async function ensureSelfSignedPfx(path: string, passphrase: string | undefined): Promise<PfxCert & { created: boolean }> {
  if (passphrase && (await stat(path).then((s) => s.isFile(), () => false))) {
    return { pfx: await readFile(path), passphrase, created: false };
  }
  if (!/^[\w:\\/ .()-]+$/.test(path)) throw new Error('caminho do certificado inválido');
  const pass = randomBytes(24).toString('hex');
  await mkdir(dirname(path), { recursive: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$c = New-SelfSignedCertificate -Subject 'CN=MultTerm' -FriendlyName 'MultTerm (servidores locais)' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(5)",
    'try {',
    `  Export-PfxCertificate -Cert $c -FilePath '${path.replace(/'/g, "''")}' -Password (ConvertTo-SecureString '${pass}' -AsPlainText -Force) | Out-Null`,
    '} finally {',
    '  Remove-Item -LiteralPath $c.PSPath -Force',
    '}',
  ].join('\n');
  await new Promise<void>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 60_000 }, (err, _o, stderr) => {
      if (err) reject(new Error(`não foi possível gerar o certificado: ${String(stderr || err.message).trim().split('\n')[0]}`));
      else resolve();
    });
  });
  return { pfx: await readFile(path), passphrase: pass, created: true };
}
