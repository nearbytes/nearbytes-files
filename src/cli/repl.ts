/**
 * Interactive REPL (Read-Eval-Print Loop) for the Nearbytes file CLI.
 *
 * Launched with `nbf repl [--data-dir <d>]`.
 * Maintains a persistent Context across commands — opened volumes stay open.
 *
 * Command grammar is deliberately minimal:
 *   <verb> [<noun>] [<args>...]   — positional; flags are for one-shot mode only
 *
 * Examples:
 *   setup myvolume:password
 *   volume open myvolume:password
 *   file add /path/to/file.txt readme.txt
 *   file list
 *   file get readme.txt /tmp/out.txt
 *   file rm readme.txt
 */

import * as readline from 'readline';
import { cyan, dim, red, bold } from './output.js';
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
  cmdRefresh,
  cmdTimeline,
  cmdHelp,
} from './commands.js';
import type { Context } from './context.js';
import { createReplCompleter } from './replCompleter.js';
import {
  loadReplHistory,
  createReplHistorySession,
  attachReverseSearch,
  REPL_HISTORY_MAX_ENTRIES,
} from './replHistory.js';
import { installReplInterruptHandlers } from './replTerminal.js';

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

function tokenise(line: string): string[] {
  // Basic shell-like split: honour "quoted strings"
  const tokens: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (const ch of line.trim()) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) { tokens.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

class ExitReplSignal extends Error {
  override readonly name = 'ExitReplSignal';
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function dispatch(ctx: Context, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;

  const [verb, ...rest] = tokens;

  switch (verb.toLowerCase()) {
    // ---- meta ----
    case 'help':
      cmdHelp();
      break;

    case 'exit':
    case 'quit':
      throw new ExitReplSignal();
      break;

    // ---- setup ----
    case 'setup': {
      const [secret] = rest;
      if (!secret) throw new Error('Usage: setup <secret>');
      await cmdSetup(ctx, secret);
      break;
    }

    // ---- volume ----
    case 'volume': {
      const [subverb, ...subargs] = rest;
      if (!subverb || subverb === 'open') {
        const [secret] = subargs.length > 0 ? subargs : rest;
        if (!secret) throw new Error('Usage: volume open <secret>');
        await cmdVolumeOpen(ctx, secret);
      } else if (subverb === 'info' || subverb === 'show') {
        await cmdVolumeInfo(ctx);
      } else {
        throw new Error(`Unknown volume sub-command: ${subverb}`);
      }
      break;
    }

    case 'volumes':
      await cmdVolumes(ctx);
      break;

    case 'use': {
      const [target] = rest;
      if (!target) throw new Error('Usage: use <key-prefix|secret>');
      await cmdUse(ctx, target);
      break;
    }

    case 'info':
      await cmdVolumeInfo(ctx);
      break;

    case 'refresh':
      await cmdRefresh(ctx);
      break;

    case 'timeline': {
      const secret = resolveSecret(ctx, rest);
      await cmdTimeline(ctx, secret);
      break;
    }

    // ---- file ----
    case 'file': {
      const [subverb, ...subargs] = rest;
      switch ((subverb ?? '').toLowerCase()) {
        case 'add': {
          const [filePath, name] = subargs;
          if (!filePath) throw new Error('Usage: file add <path> [name]');
          const secret = resolveSecret(ctx, subargs);
          await cmdFileAdd(ctx, filePath, secret, name && !name.startsWith('-') ? name : undefined);
          break;
        }
        case 'list':
        case 'ls': {
          const secret = resolveSecret(ctx, subargs);
          await cmdFileList(ctx, secret);
          break;
        }
        case 'get': {
          const [fileName, outputPath] = subargs;
          if (!fileName || !outputPath) throw new Error('Usage: file get <name> <output-path>');
          const secret = resolveSecret(ctx, subargs);
          await cmdFileGet(ctx, fileName, secret, outputPath);
          break;
        }
        case 'rm':
        case 'remove':
        case 'del':
        case 'delete': {
          const [fileName] = subargs;
          if (!fileName) throw new Error('Usage: file rm <name>');
          const secret = resolveSecret(ctx, subargs);
          await cmdFileRemove(ctx, fileName, secret);
          break;
        }
        default:
          throw new Error(`Unknown file sub-command: ${subverb ?? '(none)'}. Try "help".`);
      }
      break;
    }

    default:
      throw new Error(`Unknown command: ${verb}. Type "help" for a list of commands.`);
  }
}

/**
 * Resolves the secret for a command: uses -s / --secret flag from the token
 * list, falls back to the active volume's secret, then throws.
 */
function resolveSecret(ctx: Context, tokens: string[]): string {
  const flagIdx = tokens.findIndex((t) => t === '-s' || t === '--secret');
  if (flagIdx !== -1 && tokens[flagIdx + 1]) {
    return tokens[flagIdx + 1]!;
  }
  if (ctx.activeVolume) {
    return ctx.activeVolume.volume.secret as string;
  }
  throw new Error('No active volume and no -s <secret> provided');
}

// ---------------------------------------------------------------------------
// REPL loop
// ---------------------------------------------------------------------------

export async function startRepl(ctx: Context): Promise<void> {
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
      dim(' — Tab complete, ↑↓ history, ^R search, ^C cancel line, ^D exit'),
  );
  console.log(dim(`  History: ${historySession.lines.length} entries (saved on exit)`));
  console.log('');

  // If the user pre-configured volumes in config, open them now.
  for (const vc of ctx.config.volumes) {
    try {
      await cmdVolumeOpen(ctx, vc.secret);
      // Make the last opened volume active
      const lastKey = [...ctx.volumes.keys()].at(-1);
      if (lastKey !== undefined) {
        ctx.activeVolume = ctx.volumes.get(lastKey) ?? null;
      }
    } catch {
      // Non-fatal — volume may not exist on disk yet
    }
  }

  rl.prompt();

  rl.on('line', (line) => {
    historySession.remember(line);

    const tokens = tokenise(line);
    if (tokens.length === 0) { rl.prompt(); return; }

    dispatch(ctx, tokens)
      .then(() => rl.prompt())
      .catch((err: unknown) => {
        if (err instanceof ExitReplSignal) {
          void ctx.destroy().then(() => rl.close());
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        console.error(red(`✗ ${msg}`));
        rl.prompt();
      });
  });

  rl.on('close', () => {
    void historySession.flush().finally(() => {
      console.log('');
      console.log(dim('Goodbye.'));
      void ctx.destroy().then(() => process.exit(0));
    });
  });
}
