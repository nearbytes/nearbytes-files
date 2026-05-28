import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export interface WebDavViewState {
  readonly volume: string;
  readonly cursorHash: string | null;
}

const DIR = '.nearbytes';
const FILE = 'webdav-view.json';

export function webDavViewPath(dataDir: string): string {
  return join(dataDir, DIR, FILE);
}

export async function loadWebDavView(dataDir: string): Promise<WebDavViewState | null> {
  try {
    const raw = await readFile(webDavViewPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as WebDavViewState;
    if (typeof parsed.volume !== 'string') return null;
    return {
      volume: parsed.volume,
      cursorHash: typeof parsed.cursorHash === 'string' ? parsed.cursorHash : null,
    };
  } catch {
    return null;
  }
}

export async function saveWebDavView(dataDir: string, state: WebDavViewState): Promise<void> {
  await mkdir(join(dataDir, DIR), { recursive: true, mode: 0o700 });
  const path = webDavViewPath(dataDir);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}
