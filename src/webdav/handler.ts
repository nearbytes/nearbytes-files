import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FileService } from '../fileService.js';
import type { MaterializedFileSystem } from '../fileMaterializer.js';
import { normalizeVolumePath } from '../pathUtils.js';
import { credentialsFromRequest } from './auth.js';
import { debugEnabled } from '../debug.js';
import { lockDiscovery, multistatus, responseHref } from './xml.js';

export interface WebDavHandlerDeps {
  readonly fileService: FileService;
  readonly etagForPath: (secret: string, path: string) => Promise<string | undefined>;
  readonly snapshotForSecret: (
    secret: string,
  ) => Promise<{
    readonly fs: MaterializedFileSystem;
    readonly observedHead?: string;
    readonly liveEncryptedKeys: ReadonlyMap<string, Uint8Array>;
  }>;
  readonly readFileFromSnapshot: (
    secret: string,
    path: string,
    snapshot: {
      readonly fs: MaterializedFileSystem;
      readonly liveEncryptedKeys: ReadonlyMap<string, Uint8Array>;
    },
  ) => Promise<Buffer>;
}

function send(
  res: ServerResponse,
  status: number,
  body?: string,
  headers: Record<string, string> = {},
): void {
  const extra =
    body === undefined ? { 'Content-Length': '0' } : { 'Content-Length': String(Buffer.byteLength(body)) };
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    ...extra,
    ...headers,
  });
  if (body !== undefined) res.end(body);
  else res.end();
}

function unauthorized(res: ServerResponse): void {
  send(res, 401, undefined, { 'WWW-Authenticate': 'Basic realm="nearbytes-files"' });
}

function parseUrl(req: IncomingMessage): { volume: string; inner: string } | null {
  const url = new URL(req.url ?? '/', 'https://localhost');
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const decodedSegments = segments.map((segment) => decodeURIComponent(segment));
  const volume = decodedSegments[0]!;
  const inner = decodedSegments.length > 1 ? normalizeVolumePath(decodedSegments.slice(1).join('/')) : '';
  return { volume, inner };
}

function debugStage(
  req: IncomingMessage,
  inner: string,
  stage: string,
  started: number,
): void {
  if (!debugEnabled('timing')) return;
  const elapsed = Math.round((performance.now() - started) * 10) / 10;
  console.error(
    `[nearbytes-webdav][timing] ${req.method ?? 'UNKNOWN'} path=${JSON.stringify(inner)} stage=${stage} ${elapsed}ms`,
  );
}

function debugRequest(req: IncomingMessage, inner: string): void {
  if (!debugEnabled('webdav')) return;
  const depth = Array.isArray(req.headers.depth) ? req.headers.depth[0] : req.headers.depth;
  const destination = Array.isArray(req.headers.destination)
    ? req.headers.destination[0]
    : req.headers.destination;
  console.error(
    `[nearbytes-webdav] ${new Date().toISOString()} ${req.method ?? 'UNKNOWN'} ${req.url ?? '/'} path=${JSON.stringify(inner)}` +
      (depth !== undefined ? ` depth=${depth}` : '') +
      (destination !== undefined ? ` destination=${destination}` : ''),
  );
}

function debugResponse(req: IncomingMessage, res: ServerResponse, inner: string): void {
  if (!debugEnabled('webdav')) return;
  const started = performance.now();
  res.once('finish', () => {
    const elapsed = Math.round((performance.now() - started) * 10) / 10;
    console.error(
      `[nearbytes-webdav] ${new Date().toISOString()} -> ${res.statusCode} ${req.method ?? 'UNKNOWN'} path=${JSON.stringify(inner)} ${elapsed}ms`,
    );
  });
}

function isBrowserProbe(req: IncomingMessage): boolean {
  const pathname = new URL(req.url ?? '/', 'https://localhost').pathname;
  return (
    pathname === '/favicon.ico' ||
    pathname === '/apple-touch-icon.png' ||
    pathname === '/apple-touch-icon-precomposed.png'
  );
}

function hrefFor(volume: string, inner: string): string {
  const encoded = inner.length > 0 ? `/${inner.split('/').map(encodeURIComponent).join('/')}` : '';
  return `/${encodeURIComponent(volume)}${encoded}`;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function underScope(prefix: string, path: string): boolean {
  if (prefix === '') return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isDirectChild(parent: string, path: string): boolean {
  if (path === parent) return false;
  if (parent === '') return !path.includes('/');
  if (!path.startsWith(`${parent}/`)) return false;
  return !path.slice(parent.length + 1).includes('/');
}

export function createWebDavHandler(deps: WebDavHandlerDeps) {
  /**
   * Finder and other WebDAV clients expect RFC4918 LOCK/UNLOCK round-trips
   * before writes. These tokens are a transport compatibility shim only:
   * they do not gate PUT/MOVE/DELETE and they are not FILES application locks.
   * Causal overwrite semantics stay in FILES v0.5 observed-log-head refs.
   */
  const lockTokens = new Set<string>();

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (isBrowserProbe(req)) {
      send(res, 404);
      return;
    }

    const parsed = parseUrl(req);
    if (parsed === null) {
      send(res, 404);
      return;
    }

    const creds = credentialsFromRequest(parsed.volume, req.headers.authorization);
    if (creds === null) {
      unauthorized(res);
      return;
    }

    const { fileService, etagForPath } = deps;
    const secret = creds.secret;
    const inner = parsed.inner;
    debugRequest(req, inner);
    debugResponse(req, res, inner);

    try {
      if (req.method === 'OPTIONS') {
        send(res, 204, undefined, {
          Allow: 'OPTIONS,GET,HEAD,PUT,DELETE,PROPFIND,MKCOL,MOVE,LOCK,UNLOCK',
          DAV: '1,2',
        });
        return;
      }

      if (req.method === 'LOCK') {
        await readBody(req);
        const token = `opaquelocktoken:${randomUUID()}`;
        lockTokens.add(token);
        send(res, 200, lockDiscovery(hrefFor(parsed.volume, inner), token), {
          'Content-Type': 'application/xml; charset=utf-8',
          'Lock-Token': `<${token}>`,
        });
        return;
      }

      if (req.method === 'UNLOCK') {
        const raw = req.headers['lock-token'];
        const value = Array.isArray(raw) ? raw[0] : raw;
        if (value !== undefined) {
          lockTokens.delete(value.replace(/^<|>$/g, ''));
        }
        send(res, 204);
        return;
      }

      if (req.method === 'PROPFIND') {
        const depthHeader = Array.isArray(req.headers.depth) ? req.headers.depth[0] : req.headers.depth;
        const depth = depthHeader ?? 'infinity';
        const snapshotStarted = performance.now();
        const snapshot = await deps.snapshotForSecret(secret);
        debugStage(req, inner, 'snapshotForSecret', snapshotStarted);

        const sortStarted = performance.now();
        const files = [...snapshot.fs.files.values()].sort((a, b) => a.path.localeCompare(b.path));
        const dirs = [...snapshot.fs.directories.values()].sort((a, b) => a.path.localeCompare(b.path));
        debugStage(req, inner, 'snapshot-sort', sortStarted);
        const parts: string[] = [];
        const baseHref = hrefFor(parsed.volume, inner);
        const baseEtag =
          inner.length > 0
            ? snapshot.fs.fileOrigins.get(inner) ?? snapshot.fs.entryHeads.get(inner) ?? snapshot.observedHead
            : snapshot.observedHead;
        const baseFile = files.find((f) => f.path === inner);
        const baseIsDir = inner === '' || dirs.some((d) => d.path === inner);
        if (inner !== '' && baseFile === undefined && !baseIsDir) {
          send(res, 404);
          return;
        }
        parts.push(
          responseHref(baseIsDir && !baseHref.endsWith('/') ? `${baseHref}/` : baseHref, {
            isCollection: baseIsDir,
            etag: baseEtag,
            length: baseFile?.size,
            lastModified: baseFile !== undefined ? new Date(baseFile.createdAt) : undefined,
          }),
        );

        if (depth === '0') {
          send(res, 207, multistatus(parts.join('\n')), { 'Content-Type': 'application/xml; charset=utf-8' });
          return;
        }

        for (const dir of dirs) {
          if (!underScope(inner, dir.path) || dir.path === inner) continue;
          if (depth === '1' && !isDirectChild(inner, dir.path)) continue;
          const etag = snapshot.fs.entryHeads.get(dir.path) ?? snapshot.observedHead;
          parts.push(
            responseHref(`${hrefFor(parsed.volume, dir.path)}/`, {
              isCollection: true,
              etag,
            }),
          );
        }
        for (const file of files) {
          if (!underScope(inner, file.path)) continue;
          if (file.path === inner) continue;
          if (depth === '1' && !isDirectChild(inner, file.path)) continue;
          const etag = snapshot.fs.fileOrigins.get(file.path) ?? snapshot.fs.entryHeads.get(file.path);
          parts.push(
            responseHref(hrefFor(parsed.volume, file.path), {
              isCollection: false,
              etag,
              length: file.size,
              lastModified: new Date(file.createdAt),
            }),
          );
        }
        send(res, 207, multistatus(parts.join('\n')), { 'Content-Type': 'application/xml; charset=utf-8' });
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const snapshotStarted = performance.now();
        const snapshot = await deps.snapshotForSecret(secret);
        debugStage(req, inner, 'snapshotForSecret', snapshotStarted);
        const meta = snapshot.fs.files.get(inner);
        if (meta === undefined) {
          send(res, 404);
          return;
        }
        const etag = snapshot.fs.fileOrigins.get(inner) ?? snapshot.fs.entryHeads.get(inner);
        const headers: Record<string, string> = {
          'Content-Type': meta.mimeType ?? 'application/octet-stream',
        };
        if (etag !== undefined) headers.ETag = `"${etag}"`;
        if (req.method === 'HEAD') {
          if (meta.size > 0) headers['Content-Length'] = String(meta.size);
          send(res, 200, undefined, headers);
          return;
        }
        const getFileStarted = performance.now();
        const data = await deps.readFileFromSnapshot(secret, inner, snapshot);
        debugStage(req, inner, 'readFileFromSnapshot', getFileStarted);
        res.writeHead(200, {
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
          ...headers,
          'Content-Length': String(data.length),
        });
        res.end(data);
        return;
      }

      if (req.method === 'PUT') {
        const bodyStarted = performance.now();
        const body = await readBody(req);
        debugStage(req, inner, 'readBody', bodyStarted);
        const putStarted = performance.now();
        await fileService.addFile(secret, inner, body);
        debugStage(req, inner, 'fileService.addFile', putStarted);
        const etag = await etagForPath(secret, inner);
        const putHeaders: Record<string, string> = {};
        if (etag !== undefined) putHeaders.ETag = `"${etag}"`;
        send(res, 201, undefined, putHeaders);
        return;
      }

      if (req.method === 'DELETE') {
        await fileService.delete(secret, inner);
        send(res, 204);
        return;
      }

      if (req.method === 'MKCOL') {
        await fileService.mkdir(secret, inner);
        send(res, 201);
        return;
      }

      if (req.method === 'MOVE') {
        const destRaw = req.headers.destination;
        const destHeader = Array.isArray(destRaw) ? destRaw[0] : destRaw;
        if (destHeader === undefined) {
          send(res, 400);
          return;
        }
        const destUrl = new URL(destHeader);
        const destSegs = destUrl.pathname
          .split('/')
          .filter((s) => s.length > 0)
          .map((segment) => decodeURIComponent(segment));
        if (destSegs[0] !== parsed.volume) {
          send(res, 403);
          return;
        }
        const toPath =
          destSegs.length > 1 ? normalizeVolumePath(destSegs.slice(1).join('/')) : '';
        await fileService.rename(secret, inner, toPath);
        send(res, 201);
        return;
      }

      send(res, 405);
    } catch {
      send(res, 500);
    }
  };
}
