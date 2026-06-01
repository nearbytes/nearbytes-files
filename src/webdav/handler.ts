import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FileService } from '../fileService.js';
import type { FileReplayContext } from '../fileEmit.js';
import { normalizeVolumePath } from '../pathUtils.js';
import type { WebDavAccess } from './access.js';
import { logWebDavAuthFailure } from './access.js';
import { debugEnabled } from '../debug.js';
import { debugLog } from '../debugLog.js';
import { lockDiscovery, multistatus, responseHref } from './xml.js';
import { snapshotViewLastModified, webDavResourceEtag } from './viewEpoch.js';

export interface WebDavHandlerDeps {
  readonly fileService: FileService;
  readonly access: WebDavAccess;
  readonly etagForPath: (secret: string, path: string) => Promise<string | undefined>;
  readonly snapshotForSecret: (secret: string) => Promise<FileReplayContext>;
  readonly readFileFromSnapshot: (
    secret: string,
    path: string,
    snapshot: FileReplayContext,
  ) => Promise<Buffer>;
}

type ParsedPath =
  | { readonly kind: 'root' }
  | { readonly kind: 'volume'; readonly volume: string; readonly inner: string };

function send(
  res: ServerResponse,
  status: number,
  body?: string,
  headers: Record<string, string> = {},
): void {
  const extra =
    body === undefined ? { 'Content-Length': '0' } : { 'Content-Length': String(Buffer.byteLength(body)) };
  res.writeHead(status, {
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    ...extra,
    ...headers,
  });
  if (body !== undefined) res.end(body);
  else res.end();
}

function unauthorized(res: ServerResponse): void {
  send(res, 401, undefined, { 'WWW-Authenticate': 'Basic realm="nearbytes-files"' });
}

function serviceUnavailable(res: ServerResponse, message: string): void {
  send(res, 503, message, { 'Content-Type': 'text/plain; charset=utf-8' });
}

function parseUrl(req: IncomingMessage): ParsedPath | null {
  const url = new URL(req.url ?? '/', 'https://localhost');
  const segments = url.pathname.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return { kind: 'root' };
  const volume = decodeURIComponent(segments[0]!);
  const inner =
    segments.length > 1
      ? normalizeVolumePath(segments.slice(1).map((s) => decodeURIComponent(s)).join('/'))
      : '';
  return { kind: 'volume', volume, inner };
}

function debugStage(
  req: IncomingMessage,
  inner: string,
  stage: string,
  started: number,
): void {
  if (!debugEnabled('timing')) return;
  const elapsed = Math.round((performance.now() - started) * 10) / 10;
  debugLog(
    'timing',
    'webdav',
    `${req.method ?? 'UNKNOWN'} path=${JSON.stringify(inner)} stage=${stage} ${elapsed}ms`,
  );
}

function debugRequest(req: IncomingMessage, label: string): void {
  if (!debugEnabled('webdav')) return;
  const depth = Array.isArray(req.headers.depth) ? req.headers.depth[0] : req.headers.depth;
  const destination = Array.isArray(req.headers.destination)
    ? req.headers.destination[0]
    : req.headers.destination;
  debugLog(
    'webdav',
    'request',
    `${req.method ?? 'UNKNOWN'} ${req.url ?? '/'} path=${JSON.stringify(label)}` +
      (depth !== undefined ? ` depth=${depth}` : '') +
      (destination !== undefined ? ` destination=${destination}` : ''),
  );
}

function debugResponse(req: IncomingMessage, res: ServerResponse, label: string): void {
  if (!debugEnabled('webdav')) return;
  const started = performance.now();
  res.once('finish', () => {
    const elapsed = Math.round((performance.now() - started) * 10) / 10;
    debugLog(
      'webdav',
      'response',
      `-> ${res.statusCode} ${req.method ?? 'UNKNOWN'} path=${JSON.stringify(label)} ${elapsed}ms`,
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

function hrefFor(volume: string | null, inner: string): string {
  if (volume === null) return '/';
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

function ensureWebDavReady(
  access: WebDavAccess,
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (access.getActiveProfile() === null) {
    serviceUnavailable(res, 'No active sync profile — run profile add / profile use in nbf first');
    return false;
  }
  if (!access.isAuthenticated()) {
    if (!access.checkAuth(req.headers.authorization)) {
      logWebDavAuthFailure(access, req.headers.authorization);
      unauthorized(res);
      return false;
    }
    access.markAuthenticated();
  }
  return true;
}

export function createWebDavHandler(deps: WebDavHandlerDeps) {
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

    const label =
      parsed.kind === 'root' ? '/' : hrefFor(parsed.volume, parsed.inner);
    debugRequest(req, label);
    debugResponse(req, res, label);

    if (!ensureWebDavReady(deps.access, req, res)) return;

    const { fileService, access, etagForPath } = deps;

    try {
      if (req.method === 'OPTIONS') {
        send(res, 204, undefined, {
          Allow: 'OPTIONS,GET,HEAD,PUT,DELETE,PROPFIND,MKCOL,MOVE,LOCK,UNLOCK',
          DAV: '1,2',
        });
        return;
      }

      if (parsed.kind === 'root') {
        if (req.method === 'PROPFIND') {
          const viewEpoch = access.getViewEpoch();
          const rootModified = new Date();
          const parts: string[] = [
            responseHref('/', {
              isCollection: true,
              etag: webDavResourceEtag(viewEpoch, 'root'),
              lastModified: rootModified,
            }),
          ];
          for (const name of access.listVolumeNames()) {
            parts.push(
              responseHref(`/${encodeURIComponent(name)}/`, {
                isCollection: true,
                etag: webDavResourceEtag(viewEpoch, `vol:${name}`),
                lastModified: rootModified,
              }),
            );
          }
          send(res, 207, multistatus(parts.join('\n')), {
            'Content-Type': 'application/xml; charset=utf-8',
          });
          return;
        }
        send(res, 404);
        return;
      }

      const secret = access.resolveVolumeSecret(parsed.volume);
      if (secret === undefined) {
        send(res, 404);
        return;
      }

      const readOnly = access.isReadOnlySecret(secret);
      const inner = parsed.inner;
      const volume = parsed.volume;
      const viewEpoch = access.getViewEpoch();
      const etagFor = (tag: string | undefined) => webDavResourceEtag(viewEpoch, tag);

      if (req.method === 'LOCK') {
        await readBody(req);
        const token = `opaquelocktoken:${randomUUID()}`;
        lockTokens.add(token);
        send(res, 200, lockDiscovery(hrefFor(volume, inner), token), {
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
        const viewModified = snapshotViewLastModified(snapshot);

        const files = [...snapshot.fs.files.values()].sort((a, b) => a.path.localeCompare(b.path));
        const dirs = [...snapshot.fs.directories.values()].sort((a, b) => a.path.localeCompare(b.path));
        const parts: string[] = [];
        const baseHref = hrefFor(volume, inner);
        const baseResourceTag =
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
            etag: etagFor(baseResourceTag),
            length: baseFile?.size,
            lastModified:
              baseFile !== undefined ? new Date(baseFile.createdAt) : baseIsDir ? viewModified : undefined,
          }),
        );

        if (depth === '0') {
          send(res, 207, multistatus(parts.join('\n')), { 'Content-Type': 'application/xml; charset=utf-8' });
          return;
        }

        for (const dir of dirs) {
          if (!underScope(inner, dir.path) || dir.path === inner) continue;
          if (depth === '1' && !isDirectChild(inner, dir.path)) continue;
          const dirTag = snapshot.fs.entryHeads.get(dir.path) ?? snapshot.observedHead;
          parts.push(
            responseHref(`${hrefFor(volume, dir.path)}/`, {
              isCollection: true,
              etag: etagFor(dirTag),
              lastModified: viewModified,
            }),
          );
        }
        for (const file of files) {
          if (!underScope(inner, file.path)) continue;
          if (file.path === inner) continue;
          if (depth === '1' && !isDirectChild(inner, file.path)) continue;
          const fileTag = snapshot.fs.fileOrigins.get(file.path) ?? snapshot.fs.entryHeads.get(file.path);
          parts.push(
            responseHref(hrefFor(volume, file.path), {
              isCollection: false,
              etag: etagFor(fileTag),
              length: file.size,
              lastModified: new Date(file.createdAt),
            }),
          );
        }
        send(res, 207, multistatus(parts.join('\n')), { 'Content-Type': 'application/xml; charset=utf-8' });
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const snapshot = await deps.snapshotForSecret(secret);
        const meta = snapshot.fs.files.get(inner);
        if (meta === undefined) {
          send(res, 404);
          return;
        }
        const fileTag = snapshot.fs.fileOrigins.get(inner) ?? snapshot.fs.entryHeads.get(inner);
        const headers: Record<string, string> = {
          'Content-Type': meta.mimeType ?? 'application/octet-stream',
        };
        headers.ETag = `"${etagFor(fileTag)}"`;
        headers['Last-Modified'] = new Date(meta.createdAt).toUTCString();
        if (req.method === 'HEAD') {
          if (meta.size > 0) headers['Content-Length'] = String(meta.size);
          send(res, 200, undefined, headers);
          return;
        }
        const data = await deps.readFileFromSnapshot(secret, inner, snapshot);
        res.writeHead(200, {
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
          ...headers,
          'Content-Length': String(data.length),
        });
        res.end(data);
        return;
      }

      if (readOnly) {
        send(res, 403);
        return;
      }

      if (req.method === 'PUT') {
        const body = await readBody(req);
        await fileService.addFile(secret, inner, body);
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
        if (destSegs[0] !== volume) {
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
