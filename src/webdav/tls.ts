import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';

const TLS_DIR = join(homedir(), '.nearbytes', 'webdav');
const CERT_PATH = join(TLS_DIR, 'tls.pem');
const KEY_PATH = join(TLS_DIR, 'tls-key.pem');

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
}

export async function loadOrCreateLocalTls(): Promise<TlsMaterial> {
  try {
    const [cert, key] = await Promise.all([readFile(CERT_PATH, 'utf8'), readFile(KEY_PATH, 'utf8')]);
    return { cert, key };
  } catch {
    await mkdir(TLS_DIR, { recursive: true, mode: 0o700 });
    const attrs = [{ name: 'commonName', value: 'nearbytes-files-local' }];
    const notAfter = new Date();
    notAfter.setDate(notAfter.getDate() + 825);
    const pems = await generate(attrs, {
      notAfterDate: notAfter,
      keySize: 2048,
      algorithm: 'sha256',
    });
    await writeFile(CERT_PATH, pems.cert, { mode: 0o600 });
    await writeFile(KEY_PATH, pems.private, { mode: 0o600 });
    await chmod(TLS_DIR, 0o700);
    return { cert: pems.cert, key: pems.private };
  }
}
