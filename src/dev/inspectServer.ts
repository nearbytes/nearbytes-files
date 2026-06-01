/**
 * Local HTTP inspect API for development.
 * Shares the live REPL {@link Context} so commands and replay match what you see in `nbf`.
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { FileService } from '../fileService.js';
import { replayContextThrough } from '../fileEmit.js';
import { loadVolumeSession, type VolumeSessionFile } from '../cli/volumeSessionStore.js';
import { loadWebDavView, type WebDavViewState } from '../cli/webdavViewState.js';
import type { ReplCommandResult } from '../cli/replExec.js';

export interface DevInspectServer {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export type DevInspectRunCommand = (line: string) => Promise<ReplCommandResult>;

export interface DevInspectServerOptions {
  readonly dataDir: string;
  readonly fileService: FileService;
  readonly runCommand: DevInspectRunCommand;
  readonly host?: string;
  readonly port?: number;
}

const DEFAULT_PORT = 9845;

const API_INDEX = {
  endpoints: [
    { method: 'GET', path: '/health', description: 'dataDir ping' },
    { method: 'GET', path: '/help', description: 'REPL command help text' },
    {
      method: 'GET|POST',
      path: '/cmd',
      description: 'run one REPL line (?line=ls or JSON {"line":"ls"})',
    },
    { method: 'GET', path: '/volumes', description: 'volume-session.json' },
    { method: 'GET', path: '/view', description: 'webdav-view.json' },
    { method: 'GET', path: '/sync/summary', description: 'reception tail + fetch cursors' },
    { method: 'GET', path: '/replay/<vol>?at=live|<#>|<hash>', description: 'replay snapshot JSON' },
  ],
};

export async function startDevInspectServer(
  options: DevInspectServerOptions,
): Promise<DevInspectServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_PORT;
  const { dataDir, fileService, runCommand } = options;

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

  async function readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(`${JSON.stringify(body, null, 2)}\n`);
  }

  const server: Server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${host}:${port}`);

        if (url.pathname === '/' || url.pathname === '/api') {
          json(res, 200, API_INDEX);
          return;
        }

        if (url.pathname === '/health') {
          json(res, 200, { ok: true, dataDir });
          return;
        }

        if (url.pathname === '/help' && req.method === 'GET') {
          const result = await runCommand('help');
          json(res, 200, result);
          return;
        }

        if (url.pathname === '/cmd') {
          let line = url.searchParams.get('line') ?? url.searchParams.get('cmd') ?? '';
          if (req.method === 'POST') {
            const raw = await readBody(req);
            if (raw.trim().startsWith('{')) {
              const parsed = JSON.parse(raw) as { line?: string; cmd?: string };
              line = parsed.line ?? parsed.cmd ?? line;
            } else if (raw.trim().length > 0) {
              line = raw.trim();
            }
          }
          if (line.trim().length === 0) {
            json(res, 400, {
              ok: false,
              error: 'missing command — use ?line=ls or POST {"line":"ls"}',
            });
            return;
          }
          const result = await runCommand(line);
          echoResultToTerminal(result);
          json(res, result.ok ? 200 : 400, result);
          return;
        }

        if (url.pathname === '/volumes') {
          json(res, 200, await loadSession());
          return;
        }

        if (url.pathname === '/view') {
          json(res, 200, await loadWebDavView(dataDir));
          return;
        }

        if (url.pathname === '/sync/summary') {
          json(res, 200, await loadSyncSummary(dataDir));
          return;
        }

        const m = url.pathname.match(/^\/replay\/([^/]+)$/);
        if (m !== null && req.method === 'GET') {
          const volume = decodeURIComponent(m[1]!);
          const atParam = url.searchParams.get('at') ?? 'cursor';
          const at = atParam === 'cursor' ? 'file' : atParam;
          const snap = await snapshotFor(volume, at);
          json(res, 200, {
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
          });
          return;
        }

        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found — GET /api for routes\n');
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
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

/** Mirror dev-API command output in the REPL terminal (same process). */
function echoResultToTerminal(result: ReplCommandResult): void {
  if (process.stdout.isTTY !== true) {
    return;
  }
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  if (result.error !== undefined && result.error.length > 0) {
    process.stderr.write(`${result.error}\n`);
  }
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
