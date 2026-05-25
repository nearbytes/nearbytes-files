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
import { readConfig, emptyConfig, defaultDataDir } from 'nearbytes-skeleton';
import { createContext } from './context.js';
import { cmdSetup, cmdVolumeOpen, cmdFileAdd, cmdFileList, cmdFileGet, cmdFileRemove, cmdTimeline, cmdFriendList, cmdFriendAdd, cmdFriendRemove, cmdProfileAdd, cmdProfileUse, cmdProfileList, cmdProfileShow, cmdProfilePublish, cmdProfileRemove, red, } from './commands.js';
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
    const config = await readConfig(opts.config).catch(() => emptyConfig(opts.dataDir));
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
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
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
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
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
// ── timeline ──────────────────────────────────────────────────────────────
program
    .command('timeline')
    .description('Show volume event timeline (chronological audit log)')
    .requiredOption('-s, --secret <secret>', 'Volume secret')
    .action(async (opts) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(() => cmdTimeline(ctx, opts.secret));
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
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
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
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
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
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
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
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(() => cmdFileRemove(ctx, opts.name, opts.secret));
});
// ── profile ───────────────────────────────────────────────────────────────
const profileCmd = program
    .command('profile')
    .description('Profile (sync keypair — one or many served in parallel)');
profileCmd
    .command('add')
    .description('Add a named profile slot (first one becomes active)')
    .argument('<name>', 'Local name for this profile (unique)')
    .argument('<secret>', 'Profile secret (name:password)')
    .action(async (name, secret) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdProfileAdd(ctx, name, secret);
        await ctx.destroy();
    });
});
profileCmd
    .command('use')
    .description('Set the active profile (signs publish/follower dials)')
    .argument('<name>', 'Name of an existing profile')
    .action(async (name) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdProfileUse(ctx, name);
        await ctx.destroy();
    });
});
profileCmd
    .command('list')
    .alias('ls')
    .description('List configured profiles with active marker')
    .action(async () => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdProfileList(ctx);
        await ctx.destroy();
    });
});
profileCmd
    .command('show')
    .description('Show the public key of a profile (default: active)')
    .argument('[name]', 'Profile name (default: active)')
    .action(async (name) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdProfileShow(ctx, name);
        await ctx.destroy();
    });
});
profileCmd
    .command('publish')
    .description('Publish nb.identity.record.v1 signed by the active or selected profile')
    .requiredOption('-n, --name <name>', 'Display name')
    .option('-b, --bio <bio>', 'Optional bio')
    .option('--as <profile>', 'Sign with this profile name instead of the active one')
    .action(async (opts) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdProfilePublish(ctx, opts.name, opts.bio, opts.as);
        await ctx.destroy();
    });
});
profileCmd
    .command('remove')
    .alias('rm')
    .description('Remove a profile slot (re-elects active if needed)')
    .argument('<name>', 'Profile name')
    .action(async (name) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdProfileRemove(ctx, name);
        await ctx.destroy();
    });
});
// ── friend ────────────────────────────────────────────────────────────────
const friendCmd = program.command('friend').description('Follow friends for sync');
friendCmd
    .command('list')
    .alias('ls')
    .description('List followed profile public keys')
    .action(async () => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdFriendList(ctx);
        await ctx.destroy();
    });
});
friendCmd
    .command('add')
    .description('Follow a friend by profile public key')
    .argument('<publicKey>', 'Friend profile public key (130 hex chars)')
    .action(async (publicKey) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdFriendAdd(ctx, publicKey);
        await ctx.destroy();
    });
});
friendCmd
    .command('remove')
    .alias('rm')
    .description('Unfollow a friend')
    .argument('<publicKeyOrPrefix>', 'Friend key or prefix')
    .action(async (publicKeyOrPrefix) => {
    const gopts = program.opts();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
        await cmdFriendRemove(ctx, publicKeyOrPrefix);
        await ctx.destroy();
    });
});
// ── parse ─────────────────────────────────────────────────────────────────
program.parse();
//# sourceMappingURL=index.js.map