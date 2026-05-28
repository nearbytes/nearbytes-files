import { mkdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface VolumeSessionEntry {
  readonly name: string;
  readonly secret: string;
}

export interface VolumeSessionFile {
  volumes: VolumeSessionEntry[];
  active: string | null;
}

const SESSION_DIR = '.nearbytes';
const SESSION_FILE = 'volume-session.json';

export function volumeSessionPath(dataDir: string): string {
  return join(dataDir, SESSION_DIR, SESSION_FILE);
}

export function secretVolumePrefix(secret: string): string {
  const colon = secret.indexOf(':');
  if (colon < 0) {
    throw new Error(
      'Volume secret must be two words: name and password separated by a colon inside the secret ' +
        '(e.g. test2:my-password). Example: volume add test2 test2:my-password',
    );
  }
  const prefix = secret.slice(0, colon);
  if (prefix.length === 0) {
    throw new Error('Volume secret must have a non-empty name before ":"');
  }
  return prefix;
}

/**
 * `volume add <name> <secret>` or `volume add <name:password>` (name from prefix).
 */
export function parseVolumeAddArgs(parts: readonly string[]): { name: string; secret: string } {
  if (parts.length === 1) {
    const secret = parts[0]!.trim();
    return { name: secretVolumePrefix(secret), secret };
  }
  if (parts.length === 2) {
    const name = parts[0]!.trim();
    const secret = parts[1]!.trim();
    if (secret.includes(':')) {
      return { name, secret };
    }
    throw new Error(
      `Password for volume "${name}" must include the colon form. ` +
        `Example: volume add ${name} ${name}:your-password`,
    );
  }
  throw new Error(
    'Usage: volume add <name> <name:password>   or   volume add <name:password>',
  );
}

export function profileWebDavPassword(profileSecret: string): string {
  const colon = profileSecret.indexOf(':');
  return colon >= 0 ? profileSecret.slice(colon + 1) : profileSecret;
}

export async function loadVolumeSession(dataDir: string): Promise<VolumeSessionFile> {
  const path = volumeSessionPath(dataDir);
  try {
    const st = await stat(path);
    if ((st.mode & 0o077) !== 0) {
      throw new Error(`${path} must be mode 0600 (owner read/write only)`);
    }
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as VolumeSessionFile;
    if (!Array.isArray(parsed.volumes)) {
      throw new Error(`Invalid ${path}: volumes must be an array`);
    }
    return {
      volumes: parsed.volumes,
      active: typeof parsed.active === 'string' ? parsed.active : null,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { volumes: [], active: null };
    }
    throw err;
  }
}

export async function saveVolumeSession(dataDir: string, session: VolumeSessionFile): Promise<void> {
  const path = volumeSessionPath(dataDir);
  await mkdir(join(dataDir, SESSION_DIR), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}
