/**
 * Command handlers — pure async functions, framework-free.
 *
 * Each handler receives a Context and whatever arguments it needs, then writes
 * human-readable output to stdout.  The same functions are called from:
 *   - Commander.js (immediate mode): program.action(() => handler(ctx, ...))
 *   - REPL (interpreter mode): tokenised input dispatched here
 *
 * All file I/O goes through ctx.fileService (nearbytes-files FileService).
 * ctx.skeleton is used only for crypto (key derivation) and the log.
 *
 * Errors are thrown as plain Error objects; callers decide whether to exit the
 * process (immediate mode) or print the message and continue (REPL).
 */

import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { expandUserPath } from './paths.js';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { green, yellow, red, cyan, dim, bold, formatFileTable, formatTimelineTable } from './output.js';
import {
  assertTimelineWritesAllowed,
  type Context,
  refreshIfOpen,
  reloadVolumeFromDisk,
} from './context.js';
import {
  cmdVolumeAdd,
  cmdVolumeForget,
  cmdVolumeList,
  cmdVolumeUse,
  resetTimelineCursor,
} from './volumeCommands.js';
import { secretVolumePrefix } from './volumeSessionStore.js';
import { findEventIndex, formatTimelineGotoIndexError } from '../fileEmit.js';
import { bumpWebDavView } from '../webdav/access.js';
import { saveWebDavView } from './webdavViewState.js';
import {
  resolveRemotePath,
  joinRemotePaths,
  endsWithSlash,
} from './remotePath.js';

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

/**
 * Derives the public key for a secret without reading or writing any events.
 */
export async function cmdSetup(ctx: Context, secret: string): Promise<void> {
  const keyPair = await ctx.skeleton.crypto.deriveKeys(createSecret(secret));
  console.log(green('✓ Channel initialised'));
  console.log(`  Public key: ${bytesToHex(keyPair.publicKey)}`);
}

// ---------------------------------------------------------------------------
// volume open / info / use
// ---------------------------------------------------------------------------

/** Open a volume, register it, activate, and print a summary. */
export async function cmdVolumeOpen(
  ctx: Context,
  secret: string,
  watch = true,
): Promise<void> {
  const name = secretVolumePrefix(secret);
  if (!ctx.volumeRegistry.has(name)) {
    await cmdVolumeAdd(ctx, name, secret);
  }
  await cmdVolumeUse(ctx, name);
  const rv = ctx.activeVolume;
  if (rv === null) throw new Error('Failed to activate volume');
  const files = await ctx.fileService.listFiles(secret);
  const keyHex = bytesToHex(rv.volume.publicKey);
  console.log(green('✓ Volume opened'));
  console.log(`  Public key: ${keyHex}`);
  console.log(`  Files     : ${files.length}`);
  if (files.length > 0) {
    console.log('');
    console.log(formatFileTable(files));
  }
  void watch;
}

/** Print info for the currently-active volume. */
export async function cmdVolumeInfo(ctx: Context): Promise<void> {
  if (!ctx.activeVolume) {
    throw new Error('No active volume — use `volume open <secret>` or `use <key>` first');
  }
  const keyHex = bytesToHex(ctx.activeVolume.volume.publicKey);
  const state = ctx.activeVolume.get();
  console.log(`${bold('Public key:')} ${keyHex}`);
  console.log(`${bold('Files:')}      ${state.files.size}`);
}

/** Set the active registered volume by name. */
export async function cmdUse(ctx: Context, name: string): Promise<void> {
  await cmdVolumeUse(ctx, name);
}

export { cmdVolumeAdd, cmdVolumeForget, cmdVolumeList };

// ---------------------------------------------------------------------------
// file add (put)
// ---------------------------------------------------------------------------

export async function cmdFileAdd(
  ctx: Context,
  filePath: string,
  secret: string,
  remoteSpec?: string,
): Promise<void> {
  assertTimelineWritesAllowed(ctx);
  const resolvedLocal = expandUserPath(filePath);
  const localName = basename(resolvedLocal);
  if (!localName || localName.trim().length === 0) {
    throw new Error('Local file has no basename');
  }

  /**
   * FTP/SFTP `put <local> [remote]` resolution:
   *   - no remote arg → store at `<cwd>/<basename(local)>`
   *   - remote ends with `/` (or is empty after trim) → directory target,
   *     store at `<resolved-remote>/<basename(local)>`
   *   - else → resolved remote is the full path (basename comes from caller)
   */
  let path: string;
  if (remoteSpec === undefined) {
    path = joinRemotePaths(ctx.remoteCwd, localName);
  } else if (endsWithSlash(remoteSpec) || remoteSpec.trim() === '') {
    const dir = resolveRemotePath(ctx.remoteCwd, remoteSpec);
    path = joinRemotePaths(dir, localName);
  } else {
    path = resolveRemotePath(ctx.remoteCwd, remoteSpec);
  }

  const data = Buffer.from(await readFile(resolvedLocal));
  const meta = await ctx.fileService.addFile(secret, path, data);

  console.log(green('✓ File added'));
  console.log(`  Path : ${meta.path}`);
  console.log(`  Size : ${data.length} bytes`);
  console.log(`  Hash : ${meta.blobHash.slice(0, 32)}…`);

  await refreshIfOpen(ctx, secret);
}

// ---------------------------------------------------------------------------
// file list (ls / dir)
// ---------------------------------------------------------------------------

export async function cmdFileList(
  ctx: Context,
  secret: string,
  pathArg?: string,
): Promise<void> {
  const target = pathArg === undefined ? ctx.remoteCwd : resolveRemotePath(ctx.remoteCwd, pathArg);
  const [files, dirs] = await Promise.all([
    ctx.fileService.listFiles(secret),
    ctx.fileService.listDirectories(secret),
  ]);

  const inScopeFiles = files.filter((f) => pathLivesUnder(f.path, target));
  const inScopeDirs = dirs.filter((d) => d.path !== target && pathLivesUnder(d.path, target));

  if (inScopeFiles.length === 0 && inScopeDirs.length === 0) {
    console.log(yellow('  (no entries)'));
    return;
  }

  if (inScopeDirs.length > 0) {
    console.log(green(`✓ ${inScopeDirs.length} director${inScopeDirs.length === 1 ? 'y' : 'ies'}:`));
    for (const d of inScopeDirs.sort((a, b) => a.path.localeCompare(b.path))) {
      const display = target.length > 0 ? d.path.slice(target.length + 1) : d.path;
      const marker = d.explicit ? cyan('d ') : dim('· ');
      console.log(`  ${marker}${display}/`);
    }
    console.log('');
  }

  if (inScopeFiles.length > 0) {
    console.log(green(`✓ ${inScopeFiles.length} file(s):`));
    console.log('');
    console.log(
      formatFileTable(
        inScopeFiles.map((f) => ({
          ...f,
          path: target.length > 0 ? f.path.slice(target.length + 1) : f.path,
        })),
      ),
    );
  }
}

/**
 * True when `candidate` is either equal to `target` or a direct or
 * transitive child of `target/`. Empty `target` matches every path.
 */
function pathLivesUnder(candidate: string, target: string): boolean {
  if (target === '') return true;
  return candidate === target || candidate.startsWith(`${target}/`);
}

// ---------------------------------------------------------------------------
// file get
// ---------------------------------------------------------------------------

export async function cmdFileGet(
  ctx: Context,
  remoteSpec: string,
  secret: string,
  outputPath?: string,
): Promise<void> {
  const remotePath = resolveRemotePath(ctx.remoteCwd, remoteSpec);
  const files = await ctx.fileService.listFiles(secret);
  const meta = files.find((f) => f.path === remotePath);
  if (!meta) throw new Error(`File "${remotePath}" not found in volume`);

  /**
   * FTP/SFTP convention: `get <remote>` (no local arg) writes into the
   * current local working directory under the remote's basename. `get
   * <remote> <local>` writes to the explicit local path; an existing
   * directory is treated as a parent (file lands at `<dir>/<basename>`).
   */
  const remoteBasename = basename(meta.path);
  const resolvedOutput = await resolveLocalSink(outputPath, remoteBasename);
  const data = await ctx.fileService.getFile(secret, meta.blobHash);
  await writeFile(resolvedOutput, data);

  console.log(green('✓ File retrieved'));
  console.log(`  Remote : ${meta.path}`);
  console.log(`  Local  : ${resolvedOutput}`);
  console.log(`  Size   : ${data.length} bytes`);
}

/**
 * Resolves the local destination path for a download:
 *   - omitted          → `cwd/<remoteName>` (FTP `get` default)
 *   - explicit file    → that path
 *   - explicit dir     → `<dir>/<remoteName>` (mimics `cp file dir/`)
 * Tildes are expanded; relative paths are resolved against `process.cwd()`.
 */
async function resolveLocalSink(outputPath: string | undefined, remoteName: string): Promise<string> {
  if (outputPath === undefined) {
    return resolve(process.cwd(), remoteName);
  }
  const expanded = expandUserPath(outputPath);
  try {
    const s = await stat(expanded);
    if (s.isDirectory()) {
      return join(expanded, remoteName);
    }
  } catch {
    // Does not exist yet — treated as the literal target path below.
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// delete (rm) — files AND directories; materializer cascades
// ---------------------------------------------------------------------------

export async function cmdFileRemove(
  ctx: Context,
  target: string,
  secret: string,
): Promise<void> {
  assertTimelineWritesAllowed(ctx);
  const path = resolveRemotePath(ctx.remoteCwd, target);
  await ctx.fileService.delete(secret, path);

  console.log(green('✓ Deleted'));
  console.log(`  Path: ${path}`);

  await refreshIfOpen(ctx, secret);
}

// ---------------------------------------------------------------------------
// mkdir
// ---------------------------------------------------------------------------

export async function cmdMkdir(
  ctx: Context,
  target: string,
  secret: string,
): Promise<void> {
  assertTimelineWritesAllowed(ctx);
  const path = resolveRemotePath(ctx.remoteCwd, target);
  const meta = await ctx.fileService.mkdir(secret, path);

  console.log(green('✓ Directory created'));
  console.log(`  Path: ${meta.path}/`);

  await refreshIfOpen(ctx, secret);
}

// ---------------------------------------------------------------------------
// cd — change remote working directory
// ---------------------------------------------------------------------------

export async function cmdCd(
  ctx: Context,
  target: string | undefined,
  secret: string,
): Promise<void> {
  if (target === undefined || target.trim() === '' || target.trim() === '~') {
    ctx.remoteCwd = '';
    console.log(`${bold('Remote directory now')}: /`);
    return;
  }
  const path = resolveRemotePath(ctx.remoteCwd, target);
  if (path === '') {
    ctx.remoteCwd = '';
    console.log(`${bold('Remote directory now')}: /`);
    return;
  }
  /**
   * Validate against the materialized directory set so users can't `cd`
   * into a non-existent path. Implicit directories (created by nested
   * files) count as valid targets — they show up in `listDirectories`.
   */
  const dirs = await ctx.fileService.listDirectories(secret);
  if (!dirs.some((d) => d.path === path)) {
    throw new Error(`No such directory in the volume: "${path}"`);
  }
  ctx.remoteCwd = path;
  console.log(`${bold('Remote directory now')}: /${path}`);
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

/** Show the volume event timeline (audit log of creates, deletes, renames, …). */
export async function cmdTimeline(ctx: Context, secret: string): Promise<void> {
  const events = await ctx.fileService.getTimeline(secret);
  ctx.lastTimelineEvents = events;
  if (events.length === 0) {
    console.log(yellow('  (no events in this volume yet)'));
    return;
  }

  const cursorNote =
    ctx.timelineCursorHash !== null
      ? dim(`  Cursor: event #${eventNumberForHash(events, ctx.timelineCursorHash) ?? '?'} (read-only until timeline live)`)
      : dim('  Cursor: live head');

  console.log(green(`✓ Timeline — ${events.length} event(s)`));
  console.log(cursorNote);
  console.log('');
  console.log(formatTimelineTable(events));
  console.log('');
  console.log(
    dim(
      'Replay order is causal: observed-log-head parents first, then timestamp/hash among ready events.',
    ),
  );
  console.log(
    dim(
      'Use timeline goto <n|date|hash> — numbers are event # from the table; hashes need ≥8 hex chars.',
    ),
  );

  await refreshIfOpen(ctx, secret);
}

function eventNumberForHash(
  events: readonly { eventHash: string }[],
  hash: string,
): number | null {
  const idx = events.findIndex((e) => e.eventHash === hash || e.eventHash.startsWith(hash));
  return idx >= 0 ? idx + 1 : null;
}

function parseTimelineInstant(selector: string): number | null {
  const trimmed = selector.trim();
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && trimmed.length >= 10 && !trimmed.includes('-')) {
    return asNum;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Move timeline cursor (read-only historical view). */
export async function cmdTimelineGoto(ctx: Context, selector: string): Promise<void> {
  if (!ctx.activeVolume || ctx.volumeSessionActive === null) {
    throw new Error('No active volume — use `volume use <name>` first');
  }
  const secret = ctx.volumeRegistry.get(ctx.volumeSessionActive);
  if (secret === undefined) throw new Error('Active volume is not registered');
  const replay = await ctx.fileService.getReplayContext(secret);
  const events =
    ctx.lastTimelineEvents ?? (await ctx.fileService.getTimeline(secret));

  const trimmed = selector.trim().replace(/^#/, '');
  let idx: number;
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (n < 1 || n > events.length) {
      throw new Error(
        `Event #${n} is out of range (timeline table has ${events.length} row(s), use 1–${events.length})`,
      );
    }
    idx = n - 1;
  } else {
    idx = findEventIndex(replay.orderedEntries, selector);
    if (idx === -2) {
      throw new Error(formatTimelineGotoIndexError(selector, replay.orderedEntries, -2));
    }
    if (idx < 0) {
      const instant = parseTimelineInstant(selector);
      if (instant !== null) {
        idx = events.findIndex((e) => e.timestamp > instant);
        if (idx < 0) {
          throw new Error(`No event after ${selector}`);
        }
      } else {
        throw new Error(
          formatTimelineGotoIndexError(selector, replay.orderedEntries, -1) ||
            `Unknown timeline selector: ${selector}`,
        );
      }
    }
  }

  const hash = events[idx]?.eventHash ?? replay.orderedEntries[idx]!.eventHash;
  const replayIdx = replay.orderedEntries.findIndex((e) => e.eventHash === hash);
  if (replayIdx < 0) {
    throw new Error(`Event ${hash} is not in the FILES replay log`);
  }
  ctx.timelineCursorHash = hash;
  await saveWebDavView(ctx.config.dataDir, {
    volume: ctx.volumeSessionActive,
    cursorHash: hash,
  });
  bumpWebDavView(ctx);
  const atHead = replayIdx === replay.orderedEntries.length - 1;
  if (atHead) {
    ctx.timelineCursorHash = null;
    await saveWebDavView(ctx.config.dataDir, {
      volume: ctx.volumeSessionActive,
      cursorHash: null,
    });
    console.log(green('✓ Timeline cursor at live head'));
  } else {
    const displayNum = idx + 1;
    const fileCount = (await ctx.fileService.getReplayContext(secret, { throughEventHash: hash }))
      .fs.files.size;
    console.log(
      green(`✓ Timeline cursor at event #${displayNum} (read-only view)`) +
        dim(` — ${fileCount} file(s) visible on WebDAV`),
    );
    console.log(dim(`  ${hash}`));
    console.log(
      dim('  WebDAV ETags updated — if Finder still shows the old tree, press ⌘R in that window'),
    );
  }
}

export async function cmdTimelineLive(ctx: Context): Promise<void> {
  await resetTimelineCursor(ctx);
  console.log(green('✓ Timeline cursor at live head'));
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

export async function cmdRefresh(ctx: Context): Promise<void> {
  if (!ctx.activeVolume || ctx.volumeSessionActive === null) {
    throw new Error('No active volume — use `volume use <name>` first');
  }
  const secret = ctx.volumeRegistry.get(ctx.volumeSessionActive);
  if (secret === undefined) throw new Error('Active volume is not registered');
  const replay = await reloadVolumeFromDisk(ctx, secret);
  console.log(
    green(`✓ Refreshed — ${replay.fs.files.size} file(s), ${replay.orderedEntries.length} event(s)`),
  );
}

// ---------------------------------------------------------------------------
// rename (FTP `rename` / POSIX `mv`)
// ---------------------------------------------------------------------------

export async function cmdRename(
  ctx: Context,
  fromSpec: string,
  toSpec: string,
  secret: string,
): Promise<void> {
  assertTimelineWritesAllowed(ctx);
  const fromPath = resolveRemotePath(ctx.remoteCwd, fromSpec);

  /**
   * POSIX-style `mv` resolution for the destination:
   *   - trailing `/` on toSpec → treat as "move into this directory",
   *     so target becomes `<resolved>/<basename(fromPath)>`.
   *   - resolved target exists as a directory → same behavior.
   *   - else → resolved target is the literal new path.
   * The protocol always emits a single RENAME(fromPath, toPath) event;
   * directory-vs-file conflict resolution lives in the materializer.
   */
  const resolvedTo = resolveRemotePath(ctx.remoteCwd, toSpec);
  const dirs = await ctx.fileService.listDirectories(secret);
  const destIsDir = dirs.some((d) => d.path === resolvedTo);
  const fromBasename = fromPath.includes('/')
    ? fromPath.slice(fromPath.lastIndexOf('/') + 1)
    : fromPath;
  const toPath =
    endsWithSlash(toSpec) || destIsDir
      ? joinRemotePaths(resolvedTo, fromBasename)
      : resolvedTo;

  await ctx.fileService.rename(secret, fromPath, toPath);
  console.log(green('✓ Renamed'));
  console.log(`  ${fromPath} ${dim('→')} ${toPath}`);
  await refreshIfOpen(ctx, secret);
}

// ---------------------------------------------------------------------------
// mget / mput (FTP multi-get / multi-put with `*` `?` globbing)
// ---------------------------------------------------------------------------

/**
 * Compiles `*` / `?` wildcards to an anchored RegExp. Bash-style: `*`
 * matches any run of characters (including dots), `?` matches exactly one.
 * Backslash escapes treat the next char as literal. Used for both `mget`
 * (matches against remote filenames) and `mput`'s caller (matches against
 * local directory entries before passing absolute paths back in).
 */
export function compileGlob(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      re += pattern[i + 1]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    } else if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  re += '$';
  return new RegExp(re);
}

export async function cmdMget(
  ctx: Context,
  patterns: readonly string[],
  secret: string,
  destDir?: string,
): Promise<void> {
  if (patterns.length === 0) throw new Error('Usage: mget <name|pattern>... [-d <dir>]');
  const files = await ctx.fileService.listFiles(secret);
  if (files.length === 0) {
    console.log(yellow('  (volume is empty)'));
    return;
  }
  /**
   * `mget` patterns match against the remote path relative to the active
   * remote cwd, mirroring how `ls` would render them. This keeps the
   * common case (`mget *.txt` from inside a subdir) intuitive.
   */
  const inScope = files.filter((f) => pathLivesUnder(f.path, ctx.remoteCwd));
  const relativeBase = ctx.remoteCwd === '' ? '' : `${ctx.remoteCwd}/`;
  const targets = new Map<string, (typeof files)[number]>();
  for (const pat of patterns) {
    const re = compileGlob(pat);
    let matched = 0;
    for (const f of inScope) {
      const relative = relativeBase === '' ? f.path : f.path.slice(relativeBase.length);
      if (re.test(relative) || re.test(f.path)) {
        targets.set(f.path, f);
        matched += 1;
      }
    }
    if (matched === 0) {
      console.log(yellow(`  ! no remote file matched "${pat}"`));
    }
  }
  if (targets.size === 0) return;

  const destBase = destDir === undefined ? process.cwd() : expandUserPath(destDir);
  await mkdir(destBase, { recursive: true });
  let ok = 0;
  let fail = 0;
  for (const meta of targets.values()) {
    /**
     * Mirror the relative remote path under the local destination so that
     * `mget docs/* -d ./backup` produces `./backup/docs/<basename>` —
     * this is what users expect when grabbing whole subtrees.
     */
    const relative = relativeBase === '' ? meta.path : meta.path.slice(relativeBase.length);
    const local = join(destBase, relative);
    try {
      await mkdir(join(local, '..'), { recursive: true });
      const data = await ctx.fileService.getFile(secret, meta.blobHash);
      await writeFile(local, data);
      console.log(green(`  ✓ ${meta.path}`) + dim(` → ${local} (${data.length} bytes)`));
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red(`  ✗ ${meta.path}: ${msg}`));
      fail += 1;
    }
  }
  console.log(
    bold(`Transferred ${ok}/${ok + fail} file(s)`) +
      (fail > 0 ? red(` — ${fail} failed`) : ''),
  );
}

export async function cmdMput(
  ctx: Context,
  patterns: readonly string[],
  secret: string,
): Promise<void> {
  if (patterns.length === 0) throw new Error('Usage: mput <local-path|pattern>...');
  const expanded: string[] = [];
  for (const pat of patterns) {
    const exp = expandUserPath(pat);
    if (pat.includes('*') || pat.includes('?')) {
      const parent = expandUserPath(pat.includes('/') || pat.includes('\\') ? exp.replace(/[^/\\]*$/, '') : '.');
      const base = basename(exp);
      const re = compileGlob(base);
      try {
        const entries = await readdir(parent, { withFileTypes: true });
        const hits = entries.filter((e) => e.isFile() && re.test(e.name));
        if (hits.length === 0) {
          console.log(yellow(`  ! no local file matched "${pat}"`));
          continue;
        }
        for (const h of hits) expanded.push(join(parent, h.name));
      } catch {
        console.log(yellow(`  ! cannot list "${parent}"`));
      }
    } else {
      expanded.push(exp);
    }
  }
  if (expanded.length === 0) return;

  let ok = 0;
  let fail = 0;
  for (const local of expanded) {
    try {
      const data = Buffer.from(await readFile(local));
      const remotePath = joinRemotePaths(ctx.remoteCwd, basename(local));
      const meta = await ctx.fileService.addFile(secret, remotePath, data);
      console.log(green(`  ✓ ${meta.path}`) + dim(` ← ${local} (${data.length} bytes)`));
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red(`  ✗ ${local}: ${msg}`));
      fail += 1;
    }
  }
  console.log(
    bold(`Transferred ${ok}/${ok + fail} file(s)`) +
      (fail > 0 ? red(` — ${fail} failed`) : ''),
  );
  await refreshIfOpen(ctx, secret);
}

// ---------------------------------------------------------------------------
// pwd / lcd / lpwd / lls — FTP-style local-filesystem helpers
// ---------------------------------------------------------------------------

/**
 * FTP `pwd` — print the active remote working directory inside the volume.
 * If the cwd is the root, this prints `/`; otherwise the leading `/` is
 * shown for clarity so the path looks like a familiar absolute path.
 */
export async function cmdPwd(ctx: Context): Promise<void> {
  if (!ctx.activeVolume) {
    throw new Error('No active volume — `open <secret>` or `use <key|secret>` first');
  }
  const keyHex = bytesToHex(ctx.activeVolume.volume.publicKey);
  console.log(`${bold('volume')} : ${keyHex.slice(0, 16)}…`);
  console.log(`${bold('cwd')}    : /${ctx.remoteCwd}`);
}

/** FTP `lpwd` — print local working directory. */
export function cmdLpwd(): void {
  console.log(process.cwd());
}

/** FTP `lcd` — change local working directory. */
export function cmdLcd(target?: string): void {
  const next = target === undefined ? expandUserPath('~') : expandUserPath(target);
  process.chdir(next);
  console.log(`${bold('Local directory now')}: ${process.cwd()}`);
}

/** FTP `lls` — list local directory entries. */
export async function cmdLls(target?: string): Promise<void> {
  const dir = target === undefined ? process.cwd() : expandUserPath(target);
  const entries = await readdir(dir, { withFileTypes: true });
  if (entries.length === 0) {
    console.log(yellow('  (empty)'));
    return;
  }
  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const e of sorted) {
    const tag = e.isDirectory() ? cyan('d') : e.isSymbolicLink() ? yellow('l') : ' ';
    console.log(`  ${tag} ${e.name}${e.isDirectory() ? '/' : ''}`);
  }
}

/** FTP `close` — close the active volume connection (volume stays on disk). */
export async function cmdClose(ctx: Context): Promise<void> {
  if (!ctx.activeVolume) {
    console.log(yellow('  (no active volume)'));
    return;
  }
  const keyHex = bytesToHex(ctx.activeVolume.volume.publicKey);
  const watcher = ctx.watchers.get(keyHex);
  if (watcher) {
    watcher.close();
    ctx.watchers.delete(keyHex);
  }
  ctx.volumes.delete(keyHex);
  ctx.activeVolume = null;
  console.log(green(`✓ Closed volume ${keyHex.slice(0, 16)}…`));
}

// ---------------------------------------------------------------------------
// flushAndStop — sync quiesce on REPL exit (`bye` / `quit` / `^D`)
// ---------------------------------------------------------------------------

export interface FlushOptions {
  /** Maximum wall time to wait for sync to go quiet (auto-tuned by default). */
  readonly maxMs?: number;
  /** Cancellation: set by ^C to abort the wait early and exit immediately. */
  readonly abortSignal?: AbortSignal;
  /**
   * When false (REPL `bye`), exit once inflight is 0 for the quiet window even if
   * no peer connected. When true (default, one-shot CLI), keep searching for peers
   * up to `maxMs` so WAN first-connect can complete.
   */
  readonly waitForPeer?: boolean;
}

/**
 * Best-in-class `bye` flush: wait until inflight inbound/outbound block
 * streams are quiet for at least `QUIET_MS` consecutive milliseconds, then
 * call `ctx.destroy()` to hard-stop discovery and friend sessions. Prints
 * a live status line that updates every poll (256 ms) and a final summary;
 * ^C during the wait sets `opts.abortSignal` which short-circuits to
 * destroy() immediately and warns about anything still in flight.
 */
export async function flushAndStop(ctx: Context, opts: FlushOptions = {}): Promise<void> {
  /**
   * Drain predicate, expressed precisely:
   *
   *   "DRAINED" iff (everSawPeer ∨ writerOnly)
   *               ∧ inflight === 0
   *               ∧ now − lastBusyAt ≥ QUIET_MS
   *
   * where
   *   - everSawPeer:    snapshot.connectedPeers has been > 0 at least once
   *                     since this flush started.
   *   - writerOnly:     we are running alongside a daemon (skeleton returned
   *                     a writer-only SyncHandle); no peer will ever appear
   *                     in this process — the daemon does the network work
   *                     and propagates our writes via the dataDir watcher
   *                     (DISC-27.4). Treat as drained immediately.
   *   - inflight:       inflightInbound + inflightOutbound
   *   - lastBusyAt:     reset on (a) inflight > 0 and (b) peer-count
   *                     deltas, so a fresh peer connection restarts the
   *                     quiet window and gives the protocol roundtrip
   *                     (`have` → `want` → `data`) time to fire.
   *
   * Without the everSawPeer gate, a one-shot like `nbf file add` against a
   * fresh dataDir trivially satisfies `inflight === 0` from t=0 (no peer
   * connected, nothing to send) and exits before the swarm even bootstraps.
   * We saw exactly this failure mode in the previous test run.
   *
   * The total budget is `maxMs` (default is auto-tuned):
   *   - friends configured: 60s (WAN-friendly)
   *   - no friends:         15s (local/single-node ergonomics)
   * On WAN, first peer discovery can exceed 15s under jitter/NAT churn;
   * giving a longer default avoids false "looks synced but actually exited
   * before first data transfer" outcomes in one-shot commands.
   */
  const waitForPeer = opts.waitForPeer !== false;
  const defaultMaxMs = ctx.config.friends.length > 0 ? 60000 : 15000;
  const maxMs = opts.maxMs ?? defaultMaxMs;
  const QUIET_MS = 1000;
  const POLL_MS = 256;
  const started = Date.now();
  let lastBusyAt = started;
  let everSawPeer = false;
  let lastPeerCount = 0;
  let lastLineLen = 0;
  const tty = process.stdout.isTTY === true;

  // Writer-only detection: skeleton's makeWriterOnlySync attaches a
  // `daemon` property to the SyncHandle. When present, no peer will ever
  // appear in this process and the drain predicate degenerates to "just
  // call destroy".
  const writerOnly =
    (ctx.skeleton.sync as { daemon?: unknown }).daemon !== undefined;

  const writeStatus = (text: string): void => {
    if (!tty) {
      console.log(text);
      return;
    }
    process.stdout.write(`\r${' '.repeat(lastLineLen)}\r${text}`);
    lastLineLen = stripAnsi(text).length;
  };
  const clearStatus = (): void => {
    if (tty && lastLineLen > 0) {
      process.stdout.write(`\r${' '.repeat(lastLineLen)}\r`);
      lastLineLen = 0;
    }
  };

  if (writerOnly) {
    process.stdout.write(
      dim(`Sync is owned by a running daemon — writes propagated via dataDir watcher.\n`),
    );
    await ctx.destroy();
    return;
  }

  process.stdout.write(
    dim(`Flushing sync — waiting for in-flight transfers to drain (^C to abort)\n`),
  );

  let aborted = false;
  let lastSnap = ctx.skeleton.sync.snapshot();
  while (true) {
    if (opts.abortSignal?.aborted) {
      aborted = true;
      break;
    }
    const snap = ctx.skeleton.sync.snapshot();

    if (snap.connectedPeers > 0) everSawPeer = true;
    // Peer-count deltas count as busy events so the QUIET_MS window
    // restarts when a peer arrives — gives the `have`/`want`/`data`
    // roundtrip time to fire before we declare drained.
    if (snap.connectedPeers !== lastPeerCount) {
      lastBusyAt = Date.now();
      lastPeerCount = snap.connectedPeers;
    }
    const busy = snap.inflightInbound + snap.inflightOutbound;
    if (busy > 0) lastBusyAt = Date.now();
    lastSnap = snap;

    const elapsed = Date.now() - started;
    const sinceQuiet = Date.now() - lastBusyAt;
    writeStatus(
      `  ${dim(`[${(elapsed / 1000).toFixed(1)}s]`)} ` +
        `peers ${bold(String(snap.connectedPeers))} · ` +
        `in ${bold(String(snap.inflightInbound))} · ` +
        `out ${bold(String(snap.inflightOutbound))}` +
        (busy === 0
          ? dim(
              everSawPeer
                ? `  quiet ${(sinceQuiet / 1000).toFixed(1)}s / ${(QUIET_MS / 1000).toFixed(1)}s`
                : waitForPeer
                  ? `  no peer yet ${(elapsed / 1000).toFixed(1)}s / ${(maxMs / 1000).toFixed(0)}s max`
                  : `  local quiet ${(sinceQuiet / 1000).toFixed(1)}s / ${(QUIET_MS / 1000).toFixed(1)}s`,
            )
          : ''),
    );

    if (busy === 0 && sinceQuiet >= QUIET_MS && (everSawPeer || !waitForPeer)) break;
    if (elapsed >= maxMs) break;

    await sleep(POLL_MS);
  }

  clearStatus();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (aborted) {
    const remaining = lastSnap.inflightInbound + lastSnap.inflightOutbound;
    console.log(
      yellow(
        `  ! aborted after ${elapsed}s — ${remaining} transfer(s) may not have completed; peers will retry`,
      ),
    );
  } else if (!everSawPeer) {
    console.log(
      yellow(
        `  ! no peer found within ${elapsed}s — write is durable locally; will be picked up by any future sync`,
      ),
    );
  } else {
    const busy = lastSnap.inflightInbound + lastSnap.inflightOutbound;
    if (busy === 0) {
      console.log(green(`✓ Sync flushed in ${elapsed}s (peers: ${lastSnap.connectedPeers})`));
    } else {
      console.log(
        yellow(
          `  ! timed out after ${elapsed}s — ${busy} transfer(s) still in flight; peers will retry`,
        ),
      );
    }
  }
  await ctx.destroy();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ---------------------------------------------------------------------------
// volumes (list all open volumes)
// ---------------------------------------------------------------------------

export async function cmdVolumes(ctx: Context): Promise<void> {
  if (ctx.volumes.size === 0) {
    console.log(yellow('  (no open volumes)'));
    return;
  }
  const activeKey = ctx.activeVolume ? bytesToHex(ctx.activeVolume.volume.publicKey) : null;
  for (const [key, rv] of ctx.volumes) {
    const marker = key === activeKey ? cyan('▶ ') : '  ';
    const count = rv.get().files.size;
    console.log(`${marker}${key.slice(0, 16)}…  ${dim(`${count} file(s)`)}`);
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

export { cmdFriendList, cmdFriendAdd, cmdFriendRemove, cmdFriendShow } from './friendsCommands.js';
export {
  cmdProfileAdd,
  cmdProfileUse,
  cmdProfileList,
  cmdProfileShow,
  cmdProfilePublish,
  cmdProfileRemove,
} from './profileCommands.js';

export function cmdHelp(): void {
  console.log(`
${bold('Nearbytes REPL')} ${dim('— FTP/SFTP-style commands. The "file" prefix is optional everywhere.')}

${cyan('Startup / global CLI options')}
  nbf ${dim('[-c <config>] [-d <dataDir>] [-m] [--debug [areas]] [--webdav-port <port>] [--dev-inspect [port]] [repl]')}
                                         ${dim('-m auto-mounts monitor on REPL start')}
                                         ${dim('--debug areas: cli, webdav, timing (comma-separated; all if omitted)')}
                                         ${dim('--webdav-port default 9843; --dev-inspect extra debug port 9845')}
                                         ${dim('yarn dev = yarn repl --dev-inspect')}

${cyan('Remote filesystem (volume)')}
  ls ${dim('[path] [-s <secret>]')}                List entries under path ${dim('(default: cwd, alias: dir, list)')}
  cd ${dim('[path]')}                              Change remote working directory ${dim('(default: /)')}
  pwd                                    Print the remote working directory
  mkdir <path>                           Create an explicit (possibly empty) directory
  get <remote> ${dim('[local]')}                   Download a file ${dim('(default local: ./<basename>)')}
  put <local> ${dim('[remote|dir/]')}              Upload a file ${dim('(default remote: <cwd>/<basename>)')}
  mget <name|pattern>... ${dim('[-d <dir>]')}      Download multiple files (* and ? wildcards)
  mput <local|pattern>...                Upload multiple files (* and ? wildcards)
  rm <path>                              Delete a path ${dim('(file or directory; cascade, alias: delete)')}
  mv <from> <to>                         Rename a path ${dim('(trailing / on <to> moves into dir)')}

${cyan('Local filesystem (FTP semantics)')}
  lpwd                                   Print local working directory
  lcd ${dim('[path]')}                             Change local working directory ${dim('(default: ~)')}
  lls ${dim('[path]')}                             List local entries ${dim('(default: cwd)')}

${cyan('Volume connections')}
  volume add <name> <name:password>        Register volume ${dim('(or: volume add <name:password>)')}
  volume use <name>                      Set active volume (must be registered)
  volume forget <name>                   Remove from retention and close
  volume list                            List registered volumes ${dim('(▶ = active)')}
  open <secret>                          Open and activate ${dim('(alias: volume open; sugar for add+use)')}
  close                                  Close the active volume in this process
  use <name>                             Alias for volume use
  forget <name>                          Alias for volume forget
  volumes                                List open volumes in this session
  setup <secret>                         Derive and display the public key for a secret
  info                                   Show active volume info
  timeline ${dim('[-s <secret>]')}                 Event audit log (causal replay order)
  timeline goto <#|date|hash>            Read-only cursor: event # first, then date, then ≥8 hex of hash
  timeline live                          Reset cursor to live head ${dim('(alias: timeline head)')}
  refresh                                Reload from disk (sync + timeline cache)

${cyan('WebDAV (local mount)')}
  webdav status                          Show URL, profile credentials hint, client login state
  webdav refresh                         Bump ETags so Finder/Explorer/gvfs pick up timeline changes
  webdav logout                          Force Finder to re-authenticate

${cyan('Dev inspect (HTTP — when started with --dev-inspect or yarn dev)')}
  ${dim('GET|POST')} /cmd?line=…           ${dim('run any REPL command; JSON {"line":"ls"} on POST')}
  ${dim('GET')} /help /health /volumes /view /sync/summary
  ${dim('GET')} /replay/<vol>?at=…       ${dim('at=live | <#> | <hash> | cursor (webdav-view.json)')}

${cyan('Profiles (sync keypairs — many served in parallel)')}
  profile add <name> <secret>            Add a named profile slot ${dim('(first becomes active)')}
  profile use <name>                     Set the active profile ${dim('(signs publishes / dials)')}
  profile list                           List configured profiles with active marker
  profile show ${dim('[<name>]')}                  Show the public key ${dim('(default: active)')}
  profile publish <name> ${dim('[--as <p>]')}      Publish nb.identity.record.v1
  profile remove <name>                  Remove a profile slot

${cyan('Friends (asymmetric follow, shared across all profiles)')}
  friend list                            List followed profile public keys
  friend add <profile-pubkey>            Follow a friend (sync their profile topic)
  friend remove <key|prefix>             Stop following
  friend show <profile-pubkey>           Print a key for sharing

${cyan('Diagnostics (where is this block coming from?)')}
  whoami                                 This node's peerId, instance key + active profile ${dim('(match vs peer table)')}
  peers ${dim('[-w]')}                            Snapshot of connected peers ${dim('(-w = full peer + instance keys)')}
  monitor ${dim('[on|off]')} ${dim('/ top')}                 Toggle sticky live panel above the prompt ${dim('(REPL)')}
                                         ${dim('Launch with `nbf -m` to mount the monitor on startup.')}

${cyan('Session')}
  help                                   Show this message
  bye ${dim('/ quit / exit / ^D')}                 Flush sync, then exit ${dim('(^C aborts the flush)')}
                                         ${dim('^C cancel line · ^R search · ↑↓ command history')}

${dim('Tab completion knows commands, options, local paths, remote filenames, secrets, and friend keys.')}
${dim('Use -s <secret> on any file-transfer command to override the active volume.')}
`);
}

export { red };
