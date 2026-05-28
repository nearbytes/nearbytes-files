import https from 'node:https';
import type { FileService } from '../fileService.js';
import { createWebDavHandler } from './handler.js';
import type { WebDavAccess } from './access.js';
import { loadOrCreateLocalTls } from './tls.js';

export interface WebDavServer {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface WebDavServerOptions {
  readonly fileService: FileService;
  readonly access: WebDavAccess;
  readonly host?: string;
  readonly port?: number;
}

export async function startWebDavServer(options: WebDavServerOptions): Promise<WebDavServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 9843;
  const tls = await loadOrCreateLocalTls();
  const { fileService, access } = options;

  const snapshotForSecret = async (secret: string) => {
    const through = access.timelineCursorForSecret(secret);
    return fileService.getReplayContext(secret, {
      enrichSizes: true,
      ...(through !== undefined ? { throughEventHash: through } : {}),
    });
  };

  const etagForPath = async (secret: string, path: string): Promise<string | undefined> => {
    const { fs, observedHead } = await snapshotForSecret(secret);
    return fs.fileOrigins.get(path) ?? observedHead;
  };

  const handler = createWebDavHandler({
    fileService,
    access,
    etagForPath,
    snapshotForSecret,
    readFileFromSnapshot: async (secret, path, snapshot) =>
      fileService.readFileAtReplay(secret, path, snapshot),
  });

  const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    void handler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    port,
    baseUrl: `https://${host}:${port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
