import https from 'node:https';
import type { FileService } from '../fileService.js';
import type { CryptoOperations } from 'nearbytes-crypto';
import type { Log } from 'nearbytes-log';
import { loadMaterializedFileSystem } from '../fileEmit.js';
import { createWebDavHandler } from './handler.js';
import { loadOrCreateLocalTls } from './tls.js';

export interface WebDavServer {
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export interface WebDavServerOptions {
  readonly fileService: FileService;
  readonly crypto: CryptoOperations;
  readonly log: Log;
  readonly host?: string;
  readonly port?: number;
}

export async function startWebDavServer(options: WebDavServerOptions): Promise<WebDavServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? Number(process.env['NEARBYTES_WEBDAV_PORT'] ?? 9843);
  const tls = await loadOrCreateLocalTls();

  const etagForPath = async (secret: string, path: string): Promise<string | undefined> => {
    const fs = await loadMaterializedFileSystem(secret, options.crypto, options.log);
    return fs.fileOrigins.get(path);
  };

  const handler = createWebDavHandler({ fileService: options.fileService, etagForPath });
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
