/**
 * Portable REPL terminal helpers (Node readline + process signals).
 */

import * as readline from 'readline';

export type ReadlineWithLine = readline.Interface & { line: string; cursor: number };

/** Clears the current input line without injecting key sequences (avoids readline recursion). */
export function clearReadlineLine(rl: readline.Interface): void {
  const iface = rl as ReadlineWithLine;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  iface.line = '';
  iface.cursor = 0;
  rl.prompt(true);
}

/**
 * Traps Ctrl+C so the REPL stays open: clears the line or cancels ^R search.
 * Registers on both `process` and the readline interface for Unix and Windows terminals.
 */
export function installReplInterruptHandlers(
  rl: readline.Interface,
  options: { cancelSearch?: () => boolean } = {},
): void {
  const handle = (): void => {
    if (options.cancelSearch?.()) {
      return;
    }
    clearReadlineLine(rl);
  };

  process.on('SIGINT', handle);
  rl.on('SIGINT', handle);

  const remove = (): void => {
    process.removeListener('SIGINT', handle);
    rl.removeListener('SIGINT', handle);
  };

  rl.once('close', remove);
}
