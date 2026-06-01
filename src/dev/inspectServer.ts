/**
 * Local HTTP inspect API for development — read-only JSON over replay state.
 * Shares one `FileService` with the REPL when started via `nbf --dev-inspect` (REPL only).
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { FileService } from '../fileService.js';
import { replayContextThrough } from '../fileEmit.js';
import { loadVolumeSession, type VolumeSessionFile } from '../cli/volumeSessionStore.js';
import { loadWebDavView, type WebDavViewState } from '../cli/webdavViewState.js';

export interface DevInspectServer {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface DevInspectServerOptions {
  readonly dataDir: string;
  readonly fileService: FileService;
  readonly host?: string;
  readonly port?: number;
}

const DEFAULT_PORT = 9845;

export async function startDevInspectServer(
  options: DevInspectServerOptions,
): Promise<DevInspectServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;
  const { dataDir, fileService } = options;

  async function loadSession(): Promise<VolumeSessionFile> {
    try {
      return await loadVolumeSession(dataDir);
    } catch {
      return { volumes: [], active: null };
    }
  }

  async function snapshotFor(volumeName: string, at: string) {
    const session = await loadSession();
    const vol = session.volumes.find((v) => v.name === volumeName);
    if (vol === undefined) throw new Error(`unknown volume: ${volumeName}`);
    const live = await fileService.getReplayContext(vol.secret);
    if (at === 'live' || at === 'head') return live;

    const view: WebDavViewState | null = await loadWebDavView(dataDir);
    if (
      view !== null &&
      view.volume === volumeName &&
      view.cursorHash !== null &&
      (at === 'cursor' || at === 'file')
    ) {
      return replayContextThrough(live, view.cursorHash);
    }

    const n = Number.parseInt(at, 10);
    if (Number.isFinite(n) && String(n) === at) {
      if (n < 1 || n > live.orderedEntries.length) {
        throw new Error(`event #${n} out of range (1–${live.orderedEntries.length})`);
      }
      return replayContextThrough(live, live.orderedEntries[n - 1]!.eventHash);
    }

    return replayContextThrough(live, at);
  }

  const server: Server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}:${port}`);
        if (url.pathname === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, dataDir }));
          return;
        }
        if (url.pathname === '/volumes') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(await loadSession(), null, 2));
          return;
        }
        if (url.pathname === '/view') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(await loadWebDavView(dataDir), null, 2));
          return;
        }
        if (url.pathname === '/sync/summary') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(await loadSyncSummary(dataDir), null, 2));
          return;
        }
        const m = url.pathname.match(/^\/replay\/([^/]+)$/);
        if (m !== null && req.method === 'GET') {
          const volume = decodeURIComponent(m[1]!);
          const atParam = url.searchParams.get('at') ?? 'cursor';
          const at = atParam === 'cursor' ? 'file' : atParam;
          const snap = await snapshotFor(volume, at);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify(
              {
                volume,
                at: atParam,
                events: snap.orderedEntries.length,
                files: [...snap.fs.files.values()].map((f) => ({
                  path: f.path,
                  size: f.size,
                })),
                dirs: [...snap.fs.directories.values()].map((d) => d.path),
                observedHead: snap.observedHead,
                webdavView: await loadWebDavView(dataDir),
              },
              null,
              2,
            ),
          );
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found\n');
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    port,
    baseUrl: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function loadSyncSummary(dataDir: string): Promise<{
  receptionLines: number;
  receptionTail: unknown[];
  fetchCursors: unknown;
}> {
  const receptionPath = join(dataDir, 'sync', 'reception.jsonl');
  const cursorPath = join(dataDir, 'sync', 'fetch-cursors.json');
  let receptionLines = 0;
  let receptionTail: unknown[] = [];
  try {
    const raw = await readFile(receptionPath, 'utf8');
    const lines = raw.trim().split('\n').filter((line) => line.length > 0);
    receptionLines = lines.length;
    receptionTail = lines.slice(-5).map((line) => JSON.parse(line) as unknown);
  } catch {
    receptionTail = [];
  }
  let fetchCursors: unknown = null;
  try {
    fetchCursors = JSON.parse(await readFile(cursorPath, 'utf8')) as unknown;
  } catch {
    fetchCursors = null;
  }
  return { receptionLines, receptionTail, fetchCursors };
}
