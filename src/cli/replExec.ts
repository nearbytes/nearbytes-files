/**
 * Run one REPL command line against a live Context (dev inspect API, automation).
 * Uses the same dispatcher as the interactive REPL; output is captured, not echoed.
 */

import { format } from 'node:util';
import type { Context } from './context.js';
import { runReplDispatch, tokeniseReplLine, ExitReplSignal } from './repl.js';

export interface ReplCommandResult {
  readonly ok: boolean;
  readonly line: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  /** True when the line was `bye` / `quit` / `exit` (not executed over HTTP). */
  readonly exitRepl?: boolean;
}

export function createReplCommandRunner(
  ctx: Context,
  options: { readonly debug?: boolean } = {},
): (line: string) => Promise<ReplCommandResult> {
  return (line) => executeReplCommand(ctx, line, options);
}

export async function executeReplCommand(
  ctx: Context,
  line: string,
  options: { readonly debug?: boolean } = {},
): Promise<ReplCommandResult> {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { ok: true, line: trimmed, stdout: '', stderr: '' };
  }

  const stdout: string[] = [];
  const stderr: string[] = [];
  const prevLog = console.log;
  const prevError = console.error;
  console.log = (...args: unknown[]) => {
    stdout.push(format(...args));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(format(...args));
  };

  try {
    const tokens = tokeniseReplLine(trimmed);
    await runReplDispatch(ctx, tokens, undefined);
    return {
      ok: true,
      line: trimmed,
      stdout: joinLines(stdout),
      stderr: joinLines(stderr),
    };
  } catch (err) {
    if (err instanceof ExitReplSignal) {
      return {
        ok: false,
        line: trimmed,
        stdout: joinLines(stdout),
        stderr: joinLines(stderr),
        exitRepl: true,
        error: 'bye/quit/exit is not supported via dev API — use the REPL terminal',
      };
    }
    const message =
      err instanceof Error
        ? options.debug === true && err.stack
          ? err.stack
          : err.message
        : String(err);
    return {
      ok: false,
      line: trimmed,
      stdout: joinLines(stdout),
      stderr: joinLines(stderr),
      error: message,
    };
  } finally {
    console.log = prevLog;
    console.error = prevError;
  }
}

function joinLines(parts: string[]): string {
  if (parts.length === 0) return '';
  return `${parts.join('\n')}\n`;
}
