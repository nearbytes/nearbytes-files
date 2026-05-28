import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FileService } from '../fileService.js';
import { normalizeVolumePath } from '../pathUtils.js';
import { credentialsFromRequest } from './auth.js';
import { multistatus, responseHref } from './xml.js';

export interface WebDavHandlerDeps {
  readonly fileService: FileService;
  readonly etagForPath: (secret: string, path: string) => Promise<string | undefined>;
}

function send(
  res: ServerResponse,
  status: number,
  body?: string,
  headers: Record<string, string> = {},
): void {
  const extra =
    body === undefined ? { 'Content-Length': '0' } : { 'Content-Length': String(Buffer.byteLength(body)) };
  res.writeHead(status, { ...extra, ...headers });
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
  const volume = decodeURIComponent(segments[0]!);
  const inner = segments.length > 1 ? normalizeVolumePath(segments.slice(1).join('/')) : '';
  return { volume, inner };
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

export function createWebDavHandler(deps: WebDavHandlerDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    try {
      if (req.method === 'OPTIONS') {
        send(res, 204, undefined, {
          Allow: 'OPTIONS,GET,HEAD,PUT,DELETE,PROPFIND,MKCOL,MOVE',
          DAV: '1,2',
        });
        return;
      }

      if (req.method === 'PROPFIND') {
        const [files, dirs] = await Promise.all([
          fileService.listFiles(secret),
          fileService.listDirectories(secret),
        ]);
        const parts: string[] = [];
        const baseHref = hrefFor(parsed.volume, inner);
        const baseEtag = inner.length > 0 ? await etagForPath(secret, inner) : undefined;
        const baseIsDir =
          inner === '' ||
          dirs.some((d) => d.path === inner) ||
          files.some((f) => f.path === inner);
        parts.push(
          responseHref(baseHref.endsWith('/') ? baseHref : `${baseHref}/`, {
            isCollection: baseIsDir,
            etag: baseEtag,
          }),
        );

        for (const dir of dirs) {
          if (!underScope(inner, dir.path) || dir.path === inner) continue;
          const etag = await etagForPath(secret, dir.path);
          parts.push(
            responseHref(`${hrefFor(parsed.volume, dir.path)}/`, {
              isCollection: true,
              etag,
            }),
          );
        }
        for (const file of files) {
          if (!underScope(inner, file.path)) continue;
          const etag = await etagForPath(secret, file.path);
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
        const files = await fileService.listFiles(secret);
        const meta = files.find((f) => f.path === inner);
        if (meta === undefined) {
          send(res, 404);
          return;
        }
        const etag = await etagForPath(secret, inner);
        const headers: Record<string, string> = {
          'Content-Type': meta.mimeType ?? 'application/octet-stream',
        };
        if (etag !== undefined) headers.ETag = `"${etag}"`;
        if (req.method === 'HEAD') {
          send(res, 200, undefined, headers);
          return;
        }
        const data = await fileService.getFile(secret, meta.blobHash);
        res.writeHead(200, { ...headers, 'Content-Length': String(data.length) });
        res.end(data);
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
        const destSegs = destUrl.pathname.split('/').filter((s) => s.length > 0);
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
