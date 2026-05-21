#!/usr/bin/env node
/**
 * nbf — Nearbytes file CLI
 *
 * Two modes of operation:
 *
 *   Immediate mode  `nbf <command> [options]`
 *     Each invocation boots, runs one command, and exits.  Matches the UX of
 *     classic Unix tools.  Suitable for scripting.
 *
 *   Interpreter mode  `nbf repl [options]`
 *     Starts an interactive prompt that persists state (open volumes, active
 *     volume) across commands.  Suitable for interactive exploration.
 */
import { Command } from 'commander';
import { readConfig, defaultDataDir } from 'nearbytes-skeleton';
import { createContext } from './context.js';
import { cmdSetup, cmdVolumeOpen, cmdFileAdd, cmdFileList, cmdFileGet, cmdFileRemove, red, } from './commands.js';
import { startRepl } from './repl.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function die(msg) {
    console.error(red(`✗ ${msg}`));
    process.exit(1);
}
async function bail(fn) {
    try {
        await fn();
    }
    catch (err) {
        die(err instanceof Error ? err.message : String(err));
    }
}
// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------
const program = new Command();
program
    .name('nbf')
    .description('Nearbytes file CLI — encrypted file volumes on a cryptographic event log')
    .version('0.1.0')
    .option('-c, --config <path>', 'Config file path')
    .option('-d, --data-dir <path>', 'Storage directory', defaultDataDir());
// ── repl ──────────────────────────────────────────────────────────────────
program
    .command('repl')
    .description('Start an interactive REPL (interpreter mode)')
    .action(async () => {
    const opts = program.opts();
    const config = await readConfig(opts.config).catch(() => ({ dataDir: opts.dataDir, volumes: [] }));
    const ctx = await createContext({ ...config, dataDir: opts.dataDir ?? config.dataDir });
    await startRepl(ctx);
});
// ── setup ─────────────────────────────────────────────────────────────────
program
    .command('setup')
    .description('Initialise a new channel (derive keys)')
    .requiredOption('-s, --secret <secret>', 'Channel secret  e.g. "myvolume:password"')
    .action(async (opts) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => ({ dataDir: gopts.dataDir, volumes: [] }));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(() => cmdSetup(ctx, opts.secret));
});
// ── volume ────────────────────────────────────────────────────────────────
const volumeCmd = program.command('volume').description('Volume operations');
volumeCmd
    .command('open')
    .description('Open a volume and display its state')
    .requiredOption('-s, --secret <secret>', 'Volume secret')
    .action(async (opts) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => ({ dataDir: gopts.dataDir, volumes: [] }));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(() => cmdVolumeOpen(ctx, opts.secret, false));
});
volumeCmd
    .command('info')
    .description('Show info for the active volume')
    .action(async () => {
    die('`volume info` is only meaningful in REPL mode — try `nbf repl`');
});
volumeCmd
    .command('list')
    .alias('ls')
    .description('List all open volumes')
    .action(async () => {
    die('`volume list` is only meaningful in REPL mode — try `nbf repl`');
});
// ── file ──────────────────────────────────────────────────────────────────
const fileCmd = program.command('file').description('File operations');
fileCmd
    .command('add')
    .description('Add a file to a volume')
    .requiredOption('-p, --path <path>', 'Local file path')
    .requiredOption('-s, --secret <secret>', 'Volume secret')
    .option('-n, --name <name>', 'Name to store the file under (default: basename of path)')
    .action(async (opts) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => ({ dataDir: gopts.dataDir, volumes: [] }));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(() => cmdFileAdd(ctx, opts.path, opts.secret, opts.name));
});
fileCmd
    .command('list')
    .alias('ls')
    .description('List files in a volume')
    .requiredOption('-s, --secret <secret>', 'Volume secret')
    .action(async (opts) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => ({ dataDir: gopts.dataDir, volumes: [] }));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(() => cmdFileList(ctx, opts.secret));
});
fileCmd
    .command('get')
    .description('Retrieve a file from a volume')
    .requiredOption('-n, --name <name>', 'File name in the volume')
    .requiredOption('-s, --secret <secret>', 'Volume secret')
    .requiredOption('-o, --output <path>', 'Output file path')
    .action(async (opts) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => ({ dataDir: gopts.dataDir, volumes: [] }));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(() => cmdFileGet(ctx, opts.name, opts.secret, opts.output));
});
fileCmd
    .command('remove')
    .alias('rm')
    .description('Remove a file from a volume')
    .requiredOption('-n, --name <name>', 'File name to remove')
    .requiredOption('-s, --secret <secret>', 'Volume secret')
    .action(async (opts) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => ({ dataDir: gopts.dataDir, volumes: [] }));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(() => cmdFileRemove(ctx, opts.name, opts.secret));
});
// ── parse ─────────────────────────────────────────────────────────────────
program.parse();
//# sourceMappingURL=index.js.map