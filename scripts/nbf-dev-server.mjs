#!/usr/bin/env node
/**
 * Minimal dev/inspect HTTP server (read-only). Does not replace WebDAV; mirrors
 * replay state from dataDir + webdav-view.json written by the REPL.
 *
 *   yarn build && node scripts/nbf-dev-server.mjs
 *   curl http://127.0.0.1:9845/health
 *   curl 'http://127.0.0.1:9845/replay/test2?at=32'
 *   curl 'http://127.0.0.1:9845/replay/test2?at=live'
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createFilesystemSkeletonFromConfig } from 'nearbytes-skeleton';
import { createFileService } from '../dist/fileService.js';
import { replayContextThrough } from '../dist/fileEmit.js';

const PORT = Number.parseInt(process.env.NBF_DEV_PORT ?? '9845', 10);
const config = JSON.parse(
  readFileSync(process.env.NEARBYTES_CONFIG ?? `${process.env.HOME}/.nearbytes/config.json`, 'utf8'),
);

function loadView() {
  try {
    return JSON.parse(
      readFileSync(`${config.dataDir}/.nearbytes/webdav-view.json`, 'utf8'),
    );
  } catch {
    return null;
  }
}

function loadSession() {
  return JSON.parse(
    readFileSync(`${config.dataDir}/.nearbytes/volume-session.json`, 'utf8'),
  );
}

const skeletonPromise = createFilesystemSkeletonFromConfig(config);
const fileServicePromise = skeletonPromise.then((sk) =>
  createFileService({ log: sk.log, crypto: sk.crypto }),
);

async function snapshotFor(volumeName, at) {
  const session = loadSession();
  const vol = session.volumes.find((v) => v.name === volumeName);
  if (!vol) throw new Error(`unknown volume: ${volumeName}`);
  const files = await fileServicePromise;
  const live = await files.getReplayContext(vol.secret);
  if (at === 'live' || at === 'head') return live;
  const view = loadView();
  if (view?.volume === volumeName && view.cursorHash && (at === 'cursor' || at === 'file')) {
    return replayContextThrough(live, view.cursorHash);
  }
  const n = Number.parseInt(at, 10);
  if (Number.isFinite(n) && String(n) === at) {
    if (n < 1 || n > live.orderedEntries.length) throw new Error(`#${n} out of range`);
    return replayContextThrough(live, live.orderedEntries[n - 1].eventHash);
  }
  return replayContextThrough(live, at);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dataDir: config.dataDir }));
      return;
    }
    if (url.pathname === '/volumes') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(loadSession(), null, 2));
      return;
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(loadView(), null, 2));
      return;
    }
    const m = url.pathname.match(/^\/replay\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const volume = decodeURIComponent(m[1]);
      const at = url.searchParams.get('at') ?? 'cursor';
      const snap = await snapshotFor(volume, at === 'cursor' ? 'file' : at);
      const body = {
        volume,
        at,
        events: snap.orderedEntries.length,
        files: [...snap.fs.files.values()].map((f) => ({ path: f.path, size: f.size })),
        dirs: [...snap.fs.directories.values()].map((d) => d.path),
        observedHead: snap.observedHead,
        webdavView: loadView(),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
      return;
    }
    res.writeHead(404);
    res.end('not found\n');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err instanceof Error ? err.message : err));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`nbf-dev-server http://127.0.0.1:${PORT}/  dataDir=${config.dataDir}`);
  console.error('  GET /health  /volumes  /view  /replay/<vol>?at=live|32|<hash>|cursor');
});

process.on('SIGINT', async () => {
  const sk = await skeletonPromise;
  await sk.destroy();
  process.exit(0);
});
