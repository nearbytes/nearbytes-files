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
import { type Context, openAndWatch, refreshIfOpen } from './context.js';

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

/** Open a volume, materialise its state, and print a summary. */
export async function cmdVolumeOpen(
  ctx: Context,
  secret: string,
  watch = true,
): Promise<void> {
  const rv = await openAndWatch(ctx, secret, watch);
  const files = await ctx.fileService.listFiles(secret);
  const keyHex = bytesToHex(rv.volume.publicKey);
  console.log(green('✓ Volume opened'));
  console.log(`  Public key: ${keyHex}`);
  console.log(`  Files     : ${files.length}`);
  if (files.length > 0) {
    console.log('');
    console.log(formatFileTable(files));
  }
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

/** Set the active volume by public-key hex prefix or secret. */
export async function cmdUse(ctx: Context, keyPrefixOrSecret: string): Promise<void> {
  // First try exact or prefix match against already-open volumes.
  let rv = ctx.volumes.get(keyPrefixOrSecret);
  if (!rv) {
    for (const [key, vol] of ctx.volumes) {
      if (key.startsWith(keyPrefixOrSecret)) {
        rv = vol;
        break;
      }
    }
  }
  // Fall back to treating the argument as a secret and opening the volume.
  if (!rv) rv = await openAndWatch(ctx, keyPrefixOrSecret);

  ctx.activeVolume = rv;
  console.log(green(`✓ Active volume: ${bytesToHex(rv.volume.publicKey)}`));
}

// ---------------------------------------------------------------------------
// file add
// ---------------------------------------------------------------------------

export async function cmdFileAdd(
  ctx: Context,
  filePath: string,
  secret: string,
  name?: string,
): Promise<void> {
  const resolvedPath = expandUserPath(filePath);
  const filename = name ?? basename(resolvedPath);
  if (!filename || filename.trim().length === 0) throw new Error('File name cannot be empty');

  const data = Buffer.from(await readFile(resolvedPath));
  const meta = await ctx.fileService.addFile(secret, filename, data);

  console.log(green('✓ File added'));
  console.log(`  Name : ${meta.filename}`);
  console.log(`  Size : ${data.length} bytes`);
  console.log(`  Hash : ${meta.blobHash.slice(0, 32)}…`);

  await refreshIfOpen(ctx, secret);
}

// ---------------------------------------------------------------------------
// file list
// ---------------------------------------------------------------------------

export async function cmdFileList(ctx: Context, secret: string): Promise<void> {
  const files = await ctx.fileService.listFiles(secret);
  if (files.length === 0) {
    console.log(yellow('  (no files)'));
    return;
  }
  console.log(green(`✓ ${files.length} file(s):`));
  console.log('');
  console.log(formatFileTable(files));
}

// ---------------------------------------------------------------------------
// file get
// ---------------------------------------------------------------------------

export async function cmdFileGet(
  ctx: Context,
  filename: string,
  secret: string,
  outputPath?: string,
): Promise<void> {
  const files = await ctx.fileService.listFiles(secret);
  const meta = files.find((f) => f.filename === filename);
  if (!meta) throw new Error(`File "${filename}" not found in volume`);

  /**
   * FTP/SFTP convention: `get <remote>` (no local arg) writes into the
   * current local working directory under the remote's name. `get <remote>
   * <local>` writes to the explicit local path; an existing directory is
   * treated as a parent (file lands at `<dir>/<remote>`).
   */
  const resolvedOutput = await resolveLocalSink(outputPath, filename);
  const data = await ctx.fileService.getFile(secret, meta.blobHash);
  await writeFile(resolvedOutput, data);

  console.log(green('✓ File retrieved'));
  console.log(`  Remote : ${filename}`);
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
// file remove
// ---------------------------------------------------------------------------

export async function cmdFileRemove(
  ctx: Context,
  filename: string,
  secret: string,
): Promise<void> {
  await ctx.fileService.deleteFile(secret, filename);

  console.log(green('✓ File removed'));
  console.log(`  Name: ${filename}`);

  await refreshIfOpen(ctx, secret);
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

/** Show the volume event timeline (audit log of creates, deletes, renames, …). */
export async function cmdTimeline(ctx: Context, secret: string): Promise<void> {
  const events = await ctx.fileService.getTimeline(secret);
  if (events.length === 0) {
    console.log(yellow('  (no events in this volume yet)'));
    return;
  }

  console.log(green(`✓ Timeline — ${events.length} event(s)`));
  console.log('');
  console.log(formatTimelineTable(events));
  console.log('');
  console.log(
    dim(
      'Replay order is a total order (timestamp → log position → filename → event hash).',
    ),
  );
  console.log(
    dim(
      'Raw events on disk are sorted by event hash; the timeline above is the causal replay order.',
    ),
  );

  await refreshIfOpen(ctx, secret);
}

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

export async function cmdRefresh(ctx: Context): Promise<void> {
  if (!ctx.activeVolume) throw new Error('No active volume');
  await ctx.activeVolume.refresh();
  const state = ctx.activeVolume.get();
  console.log(green(`✓ Refreshed — ${state.files.size} file(s)`));
}

// ---------------------------------------------------------------------------
// rename (FTP `rename` / `mv`)
// ---------------------------------------------------------------------------

export async function cmdRename(
  ctx: Context,
  fromName: string,
  toName: string,
  secret: string,
): Promise<void> {
  await ctx.fileService.renameFile(secret, fromName, toName);
  console.log(green('✓ File renamed'));
  console.log(`  ${fromName} ${dim('→')} ${toName}`);
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
  const targets = new Map<string, (typeof files)[number]>();
  for (const pat of patterns) {
    const re = compileGlob(pat);
    let matched = 0;
    for (const f of files) {
      if (re.test(f.filename)) {
        targets.set(f.filename, f);
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
    const local = join(destBase, meta.filename);
    try {
      const data = await ctx.fileService.getFile(secret, meta.blobHash);
      await writeFile(local, data);
      console.log(green(`  ✓ ${meta.filename}`) + dim(` → ${local} (${data.length} bytes)`));
      ok += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red(`  ✗ ${meta.filename}: ${msg}`));
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
      const meta = await ctx.fileService.addFile(secret, basename(local), data);
      console.log(green(`  ✓ ${meta.filename}`) + dim(` ← ${local} (${data.length} bytes)`));
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

/** FTP `pwd` — print active "remote directory" (the active volume's identity). */
export async function cmdPwd(ctx: Context): Promise<void> {
  if (!ctx.activeVolume) {
    throw new Error('No active volume — `open <secret>` or `use <key|secret>` first');
  }
  const keyHex = bytesToHex(ctx.activeVolume.volume.publicKey);
  const state = ctx.activeVolume.get();
  console.log(`${bold('volume')} : ${keyHex}`);
  console.log(`${bold('files')}  : ${state.files.size}`);
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
  /** Maximum wall time to wait for sync to go quiet (default 10 s). */
  readonly maxMs?: number;
  /** Cancellation: set by ^C to abort the wait early and exit immediately. */
  readonly abortSignal?: AbortSignal;
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
  const maxMs = opts.maxMs ?? 10000;
  const QUIET_MS = 1000;
  const POLL_MS = 256;
  const started = Date.now();
  let lastBusyAt = started;
  let lastLineLen = 0;
  const tty = process.stdout.isTTY === true;

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
    const busy = snap.inflightInbound + snap.inflightOutbound;
    if (busy > 0) lastBusyAt = Date.now();
    lastSnap = snap;

    const elapsed = Date.now() - started;
    const sinceQuiet = Date.now() - lastBusyAt;
    writeStatus(
      `  ${dim(`[${(elapsed / 1000).toFixed(1)}s]`)} ` +
        `in ${bold(String(snap.inflightInbound))} · ` +
        `out ${bold(String(snap.inflightOutbound))}` +
        (busy === 0 ? dim(`  quiet for ${(sinceQuiet / 1000).toFixed(1)}s / ${(QUIET_MS / 1000).toFixed(1)}s`) : ''),
    );

    if (busy === 0 && sinceQuiet >= QUIET_MS) break;
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
  } else {
    const busy = lastSnap.inflightInbound + lastSnap.inflightOutbound;
    if (busy === 0) {
      console.log(green(`✓ Sync flushed in ${elapsed}s`));
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

${cyan('File transfer')}
  ls ${dim('[-s <secret>]')}                       List files in the active volume     ${dim('(alias: dir, list)')}
  get <remote> ${dim('[local]')}                   Download a file ${dim('(default local: ./<remote>)')}
  put <local> ${dim('[remote]')}                   Upload a file ${dim('(default remote: basename)')}
  mget <name|pattern>... ${dim('[-d <dir>]')}      Download multiple files (* and ? wildcards)
  mput <local|pattern>...                Upload multiple files (* and ? wildcards)
  rm <remote>                            Delete a file ${dim('(alias: delete, del)')}
  mv <from> <to>                         Rename a file ${dim('(alias: rename)')}

${cyan('Local-filesystem navigation (FTP semantics)')}
  lpwd                                   Print local working directory
  lcd ${dim('[path]')}                             Change local working directory ${dim('(default: ~)')}
  lls ${dim('[path]')}                             List local entries ${dim('(default: cwd)')}
  pwd                                    Show active volume identity ${dim('(remote "directory")')}

${cyan('Volume connections')}
  open <secret>                          Open a volume and make it active ${dim('(alias: volume open)')}
  close                                  Close the active volume connection
  use <key-prefix|secret>                Switch the active volume
  volumes                                List all open volumes in this session
  setup <secret>                         Derive and display the public key for a secret
  info                                   Show active volume info ${dim('(alias of pwd)')}
  timeline ${dim('[-s <secret>]')}                 Chronological audit log of volume events
  refresh                                Reload active volume state

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

${cyan('Session')}
  help                                   Show this message
  bye ${dim('/ quit / exit / ^D')}                 Flush sync, then exit ${dim('(^C aborts the flush)')}
                                         ${dim('^C cancel line · ^R search · ↑↓ command history')}

${dim('Tab completion knows commands, options, local paths, remote filenames, secrets, and friend keys.')}
${dim('Use -s <secret> on any file-transfer command to override the active volume.')}
`);
}

export { red };
