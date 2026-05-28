/**
 * Interactive REPL for the Nearbytes file CLI — FTP/SFTP-style grammar.
 *
 * Launched with `nbf repl [--data-dir <d>]`. Keeps a persistent Context so
 * open volumes, the active volume, watchers, and sync handles all survive
 * across commands.
 *
 * Grammar (all positional; `-s <secret>` overrides the active volume):
 *
 *   ls | dir | list             list remote files
 *   get <remote> [local]        download
 *   put <local> [remote]        upload
 *   mget <pat>... [-d <dir>]    multi-download (* ? globs)
 *   mput <pat>...               multi-upload   (* ? globs, expanded locally)
 *   rm  | delete | del          delete remote
 *   mv  | rename <from> <to>    rename remote
 *
 *   lpwd / lcd [path] / lls     local-filesystem navigation
 *   pwd                         show active volume identity (FTP semantics)
 *
 *   open <secret>               open and activate a volume   (alias: volume open)
 *   close                       close the active volume
 *   use <key|secret>            switch the active volume
 *   volumes                     list open volumes
 *
 *   setup / info / timeline / refresh / profile … / friend …
 *
 *   help / bye / quit / exit / ^D
 *
 * The literal `file` prefix is accepted and silently stripped, so
 * `file get x` and `get x` are the same command. Tab completion lives in
 * `replCompleter.ts`; the exit-time sync flush lives in
 * `flushAndStop()` (see `commands.ts`).
 */

import * as readline from 'readline';
import { cyan, dim, red, bold, yellow } from './output.js';
import {
  cmdSetup,
  cmdVolumeOpen,
  cmdVolumeInfo,
  cmdUse,
  cmdVolumes,
  cmdFileAdd,
  cmdFileList,
  cmdFileGet,
  cmdFileRemove,
  cmdMkdir,
  cmdCd,
  cmdRefresh,
  cmdTimeline,
  cmdTimelineGoto,
  cmdTimelineLive,
  cmdVolumeAdd,
  cmdVolumeForget,
  cmdVolumeList,
  cmdHelp,
  cmdFriendList,
  cmdFriendAdd,
  cmdFriendRemove,
  cmdFriendShow,
  cmdProfileAdd,
  cmdProfileUse,
  cmdProfileList,
  cmdProfileShow,
  cmdProfilePublish,
  cmdProfileRemove,
  cmdMget,
  cmdMput,
  cmdRename,
  cmdLcd,
  cmdLls,
  cmdLpwd,
  cmdPwd,
  cmdClose,
  flushAndStop,
} from './commands.js';
import { cmdPeers, cmdMonitor, cmdWhoami } from './peersMonitor.js';
import type { Context } from './context.js';
import { restoreVolumeSession } from './volumeCommands.js';
import { parseVolumeAddArgs, secretVolumePrefix } from './volumeSessionStore.js';
import { cmdWebDavLogout, cmdWebDavRefresh, cmdWebDavStatus } from './webdavCommands.js';
import { createReplCompleter } from './replCompleter.js';
import {
  loadReplHistory,
  createReplHistorySession,
  attachReverseSearch,
  REPL_HISTORY_MAX_ENTRIES,
} from './replHistory.js';
import { installReplInterruptHandlers } from './replTerminal.js';

// ---------------------------------------------------------------------------
// Tokeniser (bash-style; identical semantics to before)
// ---------------------------------------------------------------------------

function tokenise(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let hasToken = false;
  let inQuote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote === "'") {
      if (ch === "'") {
        inQuote = null;
      } else {
        current += ch;
        hasToken = true;
      }
    } else if (inQuote === '"') {
      if (ch === '\\' && i + 1 < line.length) {
        const next = line[i + 1]!;
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
        hasToken = true;
      } else if (ch === '"') {
        inQuote = null;
      } else {
        current += ch;
        hasToken = true;
      }
    } else {
      if (ch === '\\' && i + 1 < line.length) {
        current += line[i + 1]!;
        i += 1;
        hasToken = true;
      } else if (ch === '"' || ch === "'") {
        inQuote = ch as '"' | "'";
        hasToken = true;
      } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        if (hasToken) {
          tokens.push(current);
          current = '';
          hasToken = false;
        }
      } else {
        current += ch;
        hasToken = true;
      }
    }
  }

  if (inQuote !== null) {
    throw new Error(`Unterminated ${inQuote === '"' ? 'double' : 'single'} quote in input`);
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

class ExitReplSignal extends Error {
  override readonly name = 'ExitReplSignal';
}

// ---------------------------------------------------------------------------
// Flag / option extraction
// ---------------------------------------------------------------------------

/**
 * Pulls out `-s <val> | --secret <val>` and `-d <val> | --dest <val>` flags
 * from the token list, returning the remaining positional args. Order-
 * independent: a flag may appear anywhere on the line. Unknown `-x` flags
 * are passed through as positional so callers can surface their own error.
 */
function extractFlags(tokens: readonly string[]): {
  positional: string[];
  secret?: string;
  dest?: string;
} {
  const positional: string[] = [];
  let secret: string | undefined;
  let dest: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if ((t === '-s' || t === '--secret') && tokens[i + 1] !== undefined) {
      secret = tokens[i + 1];
      i += 1;
    } else if ((t === '-d' || t === '--dest') && tokens[i + 1] !== undefined) {
      dest = tokens[i + 1];
      i += 1;
    } else {
      positional.push(t);
    }
  }
  const out: { positional: string[]; secret?: string; dest?: string } = { positional };
  if (secret !== undefined) out.secret = secret;
  if (dest !== undefined) out.dest = dest;
  return out;
}

function resolveSecret(ctx: Context, override: string | undefined): string {
  if (override !== undefined) return override;
  if (ctx.activeVolume) return ctx.activeVolume.volume.secret as string;
  throw new Error('No active volume — `open <secret>` or pass -s <secret>');
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatch(ctx: Context, tokens: string[], rl: readline.Interface): Promise<void> {
  if (tokens.length === 0) return;

  /**
   * Optional `file` prefix: `file get x` and `get x` are the same command.
   * Strip it before lowering; do NOT strip if the next token is missing
   * (so a bare `file` is treated as an unknown verb and printed as help).
   */
  const stripped =
    tokens[0]!.toLowerCase() === 'file' && tokens.length > 1 ? tokens.slice(1) : tokens;
  const [verb, ...rest] = stripped;
  const lower = verb!.toLowerCase();

  switch (lower) {
    // ---- meta ----
    case 'help':
    case '?':
      cmdHelp();
      return;

    case 'exit':
    case 'quit':
    case 'bye':
      throw new ExitReplSignal();

    // ---- file transfer (FTP/SFTP) ----
    case 'ls':
    case 'dir':
    case 'list': {
      const { positional, secret } = extractFlags(rest);
      await cmdFileList(ctx, resolveSecret(ctx, secret), positional[0]);
      return;
    }

    case 'mkdir': {
      const { positional, secret } = extractFlags(rest);
      const [target] = positional;
      if (!target) throw new Error('Usage: mkdir <path>');
      await cmdMkdir(ctx, target, resolveSecret(ctx, secret));
      return;
    }

    case 'cd': {
      const { positional, secret } = extractFlags(rest);
      await cmdCd(ctx, positional[0], resolveSecret(ctx, secret));
      return;
    }

    case 'get': {
      const { positional, secret } = extractFlags(rest);
      const [remote, local] = positional;
      if (!remote) throw new Error('Usage: get <remote> [local]');
      await cmdFileGet(ctx, remote, resolveSecret(ctx, secret), local);
      return;
    }

    case 'put':
    case 'add':
    case 'upload': {
      const { positional, secret } = extractFlags(rest);
      const [local, remote] = positional;
      if (!local) throw new Error('Usage: put <local> [remote]');
      await cmdFileAdd(ctx, local, resolveSecret(ctx, secret), remote);
      return;
    }

    case 'rm':
    case 'delete':
    case 'del':
    case 'remove': {
      const { positional, secret } = extractFlags(rest);
      const [name] = positional;
      if (!name) throw new Error('Usage: rm <remote>');
      await cmdFileRemove(ctx, name, resolveSecret(ctx, secret));
      return;
    }

    case 'mv':
    case 'rename': {
      const { positional, secret } = extractFlags(rest);
      const [from, to] = positional;
      if (!from || !to) throw new Error('Usage: mv <from> <to>');
      await cmdRename(ctx, from, to, resolveSecret(ctx, secret));
      return;
    }

    case 'mget': {
      const { positional, secret, dest } = extractFlags(rest);
      if (positional.length === 0) throw new Error('Usage: mget <name|pattern>... [-d <dir>]');
      await cmdMget(ctx, positional, resolveSecret(ctx, secret), dest);
      return;
    }

    case 'mput': {
      const { positional, secret } = extractFlags(rest);
      if (positional.length === 0) throw new Error('Usage: mput <local|pattern>...');
      await cmdMput(ctx, positional, resolveSecret(ctx, secret));
      return;
    }

    // ---- local-filesystem navigation ----
    case 'lpwd':
      cmdLpwd();
      return;

    case 'lcd':
      cmdLcd(rest[0]);
      return;

    case 'lls':
      await cmdLls(rest[0]);
      return;

    case 'pwd':
      await cmdPwd(ctx);
      return;

    // ---- volume connections ----
    case 'open': {
      const [secret] = rest;
      if (!secret) throw new Error('Usage: open <secret>');
      await cmdVolumeOpen(ctx, secret);
      return;
    }

    case 'close':
    case 'disconnect':
      await cmdClose(ctx);
      return;

    case 'use': {
      const [target] = rest;
      if (!target) throw new Error('Usage: use <key-prefix|secret>');
      await cmdUse(ctx, target);
      return;
    }

    case 'volumes':
      await cmdVolumes(ctx);
      return;

    case 'setup': {
      const [secret] = rest;
      if (!secret) throw new Error('Usage: setup <secret>');
      await cmdSetup(ctx, secret);
      return;
    }

    case 'volume': {
      const [subverb, ...subargs] = rest;
      if (!subverb || subverb === 'open') {
        const [secret] = subargs.length > 0 ? subargs : rest;
        if (!secret) throw new Error('Usage: volume open <secret>');
        await cmdVolumeOpen(ctx, secret);
      } else if (subverb === 'add') {
        if (subargs.length === 0) {
          throw new Error(
            'Usage: volume add <name> <name:password>   or   volume add <name:password>',
          );
        }
        const { name, secret } = parseVolumeAddArgs(subargs);
        await cmdVolumeAdd(ctx, name, secret);
      } else if (subverb === 'use') {
        const [name] = subargs;
        if (!name) throw new Error('Usage: volume use <name>');
        await cmdUse(ctx, name);
      } else if (subverb === 'forget') {
        const [name] = subargs;
        if (!name) throw new Error('Usage: volume forget <name>');
        await cmdVolumeForget(ctx, name);
      } else if (subverb === 'list' || subverb === 'ls') {
        await cmdVolumeList(ctx);
      } else if (subverb === 'close') {
        await cmdClose(ctx);
      } else if (subverb === 'info' || subverb === 'show') {
        await cmdVolumeInfo(ctx);
      } else {
        throw new Error(`Unknown volume sub-command: ${subverb}`);
      }
      return;
    }

    case 'info':
      await cmdVolumeInfo(ctx);
      return;

    case 'refresh':
      await cmdRefresh(ctx);
      return;

    case 'timeline': {
      const [sub, ...subrest] = rest;
      if (sub === 'goto') {
        const [selector] = subrest;
        if (!selector) throw new Error('Usage: timeline goto <n|date|event-hash>');
        await cmdTimelineGoto(ctx, selector);
        return;
      }
      if (sub === 'live' || sub === 'head') {
        await cmdTimelineLive(ctx);
        return;
      }
      const { secret } = extractFlags(rest);
      await cmdTimeline(ctx, resolveSecret(ctx, secret));
      return;
    }

    case 'forget': {
      const [name] = rest;
      if (!name) throw new Error('Usage: forget <volume-name>');
      await cmdVolumeForget(ctx, name);
      return;
    }

    case 'webdav': {
      const [sub] = rest;
      if (!sub || sub === 'status') {
        cmdWebDavStatus(ctx);
        return;
      }
      if (sub === 'logout') {
        cmdWebDavLogout(ctx);
        return;
      }
      if (sub === 'refresh') {
        cmdWebDavRefresh(ctx);
        return;
      }
      throw new Error('Usage: webdav status | webdav refresh | webdav logout');
    }

    // ---- profile / friend ----
    case 'profile': {
      const [subverb, ...subargs] = rest;
      switch ((subverb ?? '').toLowerCase()) {
        case 'add': {
          const [name, secret] = subargs;
          if (!name || !secret) throw new Error('Usage: profile add <name> <secret>');
          await cmdProfileAdd(ctx, name, secret);
          return;
        }
        case 'use': {
          const [name] = subargs;
          if (!name) throw new Error('Usage: profile use <name>');
          await cmdProfileUse(ctx, name);
          return;
        }
        case 'list':
        case 'ls':
          await cmdProfileList(ctx);
          return;
        case 'show': {
          const [name] = subargs;
          await cmdProfileShow(ctx, name);
          return;
        }
        case 'publish': {
          const positional: string[] = [];
          let asName: string | undefined;
          for (let i = 0; i < subargs.length; i++) {
            const tok = subargs[i]!;
            if (tok === '--as' && subargs[i + 1]) {
              asName = subargs[i + 1];
              i += 1;
            } else {
              positional.push(tok);
            }
          }
          const [displayName, ...bioParts] = positional;
          if (!displayName) {
            throw new Error('Usage: profile publish <displayName> [bio] [--as <name>]');
          }
          await cmdProfilePublish(
            ctx,
            displayName,
            bioParts.length > 0 ? bioParts.join(' ') : undefined,
            asName,
          );
          return;
        }
        case 'remove':
        case 'rm':
        case 'del':
        case 'delete': {
          const [name] = subargs;
          if (!name) throw new Error('Usage: profile remove <name>');
          await cmdProfileRemove(ctx, name);
          return;
        }
        default:
          throw new Error(`Unknown profile sub-command: ${subverb ?? '(none)'}`);
      }
    }

    // ---- diagnostics ----
    case 'peers': {
      const wide = rest.some((a) => a === '-w' || a === '--wide');
      await cmdPeers(ctx, { wide });
      return;
    }

    case 'whoami':
      await cmdWhoami(ctx);
      return;

    case 'monitor':
    case 'top':
      /**
       * In the REPL we pass `rl` so the sticky overlay can mount
       * above the prompt and toggle on/off as a side-effect of
       * re-issuing `monitor`. `rest` carries any sub-verb (`on`,
       * `off`, `start`, `stop`) so the user can disambiguate when
       * the toggle would otherwise hide the panel they want to see.
       */
      await cmdMonitor(ctx, { rl, args: rest });
      return;

    case 'friend': {
      const [subverb, ...subargs] = rest;
      switch ((subverb ?? '').toLowerCase()) {
        case 'list':
        case 'ls':
          await cmdFriendList(ctx);
          return;
        case 'add': {
          const [pk] = subargs;
          if (!pk) throw new Error('Usage: friend add <profile-public-key-hex>');
          await cmdFriendAdd(ctx, pk);
          return;
        }
        case 'remove':
        case 'rm':
        case 'del':
        case 'delete': {
          const [pk] = subargs;
          if (!pk) throw new Error('Usage: friend remove <profile-public-key-hex|prefix>');
          await cmdFriendRemove(ctx, pk);
          return;
        }
        case 'show': {
          const [pk] = subargs;
          if (!pk) throw new Error('Usage: friend show <profile-public-key-hex>');
          await cmdFriendShow(ctx, pk);
          return;
        }
        default:
          throw new Error(`Unknown friend sub-command: ${subverb ?? '(none)'}`);
      }
    }

    default:
      throw new Error(`Unknown command: ${verb}. Type "help" for the command list.`);
  }
}

// ---------------------------------------------------------------------------
// REPL loop
// ---------------------------------------------------------------------------

export interface StartReplOptions {
  /**
   * When true, mount the sticky live monitor automatically after the
   * REPL has settled (volumes opened, prompt drawn). Wired to the
   * `-m/--monitor` flag on `nbf`/`nbf repl` so the user can boot
   * straight into "I want to watch sync happen" without typing the
   * `monitor` verb manually.
   */
  readonly autoMonitor?: boolean;
  /**
   * When true, REPL command failures print full stack traces rather than
   * only `err.message`. Useful while debugging parser/transport issues.
   */
  readonly debug?: boolean;
}

export async function startRepl(ctx: Context, opts: StartReplOptions = {}): Promise<void> {
  const initialHistory = await loadReplHistory();
  const historySession = createReplHistorySession(initialHistory);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: cyan('nbf') + dim(' › '),
    completer: createReplCompleter(ctx),
    history: historySession.lines,
    historySize: REPL_HISTORY_MAX_ENTRIES,
    removeHistoryDuplicates: true,
  });

  historySession.attach(rl);
  const { cancelSearch } = attachReverseSearch(rl, historySession);
  installReplInterruptHandlers(rl, { cancelSearch });

  console.log(
    bold('Nearbytes REPL') +
      dim(' — FTP/SFTP-style commands · Tab complete · ↑↓ history · ^R search · ^D / bye to exit'),
  );
  console.log(dim(`  History: ${historySession.lines.length} entries (saved on exit)`));
  if (opts.debug === true) {
    console.log(dim('  Debug mode: on (stack traces enabled)'));
  }
  if (ctx.config.profiles.length === 0) {
    console.log('');
    console.log(yellow('  ! No profile configured — sync is offline.'));
    console.log(
      dim('    Run ') +
        bold('profile add <name> <secret>') +
        dim(' to declare your first profile; sync activates automatically once it is saved.'),
    );
  } else {
    const active = ctx.config.activeProfile ?? '(none)';
    console.log('');
    console.log(
      dim(
        `  Profiles served: ${ctx.config.profiles.length} (active: ${bold(active)}). Sync runs for all of them.`,
      ),
    );
  }
  console.log('');

  await restoreVolumeSession(ctx);
  if (ctx.volumeRegistry.size === 0) {
    for (const vc of ctx.config.volumes) {
      try {
        const name = secretVolumePrefix(vc.secret);
        await cmdVolumeAdd(ctx, name, vc.secret);
      } catch {
        // Non-fatal — volume may not exist on disk yet.
      }
    }
  }

  rl.prompt();

  /**
   * If the user passed `-m/--monitor`, auto-mount the sticky overlay
   * right after the prompt is drawn. We do it on the next tick (not
   * synchronously) so the "Nearbytes REPL — …" banner and the
   * profile/volume summary land *before* the overlay takes the top
   * rows — otherwise the banner would scroll above the overlay and
   * disappear immediately on the first redraw.
   *
   * Errors are swallowed (with a dim notice) rather than bubbled:
   * monitor activation is convenience, not correctness, and a stalled
   * boot should never block the REPL from accepting commands.
   */
  if (opts.autoMonitor === true) {
    setImmediate(() => {
      void cmdMonitor(ctx, { rl }).catch((err) => {
        const msg =
          err instanceof Error
            ? opts.debug === true && err.stack
              ? err.stack
              : err.message
            : String(err);
        console.error(red(`✗ monitor auto-start failed: ${msg}`));
      });
    });
  }

  /**
   * Serialise line handling. Without this, piped input (`echo … | nbf repl`)
   * fires `line` events back-to-back and we'd dispatch concurrently, racing
   * later commands against earlier ones (e.g. `ls` running before `open`
   * resolved). A single tail promise per REPL preserves the "type one, see
   * the result, type the next" invariant that interactive users rely on,
   * with zero overhead on a real TTY because lines arrive one at a time.
   */
  let dispatchChain: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    historySession.remember(line);

    dispatchChain = dispatchChain.then(async () => {
      let tokens: string[];
      try {
        tokens = tokenise(line);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(red(`✗ ${msg}`));
        rl.prompt();
        return;
      }
      if (tokens.length === 0) {
        rl.prompt();
        return;
      }

      try {
        await dispatch(ctx, tokens, rl);
        rl.prompt();
      } catch (err) {
        if (err instanceof ExitReplSignal) {
          rl.close();
          return;
        }
        const msg =
          err instanceof Error
            ? opts.debug === true && err.stack
              ? err.stack
              : err.message
            : String(err);
        console.error(red(`✗ ${msg}`));
        rl.prompt();
      }
    });
  });

  rl.on('close', () => {
    /**
     * Close handler runs after `ExitReplSignal`, `^D`, or readline aborting.
     * We:
     *   1. Flush history immediately (cheap, synchronous-ish).
     *   2. Install a one-shot ^C handler that turns Ctrl-C into "abort the
     *      flush" instead of the default "SIGINT kills Node".
     *   3. Poll sync.snapshot() until quiet or timeout — see flushAndStop.
     *   4. Hard-stop sync (destroy) and exit 0.
     */
    void historySession.flush().finally(() => {
      console.log('');
      const abortController = new AbortController();
      const onSigint = (): void => abortController.abort();
      process.once('SIGINT', onSigint);
      void flushAndStop(ctx, { abortSignal: abortController.signal, waitForPeer: false })
        .catch((err) => {
          const msg =
            err instanceof Error
              ? opts.debug === true && err.stack
                ? err.stack
                : err.message
              : String(err);
          console.error(red(`✗ shutdown error: ${msg}`));
        })
        .finally(() => {
          process.removeListener('SIGINT', onSigint);
          console.log(dim('Goodbye.'));
          process.exit(0);
        });
    });
  });
}
