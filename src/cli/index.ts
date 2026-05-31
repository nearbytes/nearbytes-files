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
import {
  cmdSetup,
  cmdVolumeOpen,
  cmdFileAdd,
  cmdFileList,
  cmdFileGet,
  cmdFileRemove,
  cmdTimeline,
  flushAndStop,
  cmdFriendList,
  cmdFriendAdd,
  cmdFriendRemove,
  cmdProfileAdd,
  cmdProfileUse,
  cmdProfileList,
  cmdProfileShow,
  cmdProfilePublish,
  cmdProfileRemove,
  red,
} from './commands.js';
import { cmdPeers, cmdMonitor, cmdWhoami } from './peersMonitor.js';
import { startRepl } from './repl.js';
import { applyDebugOption, debugEnabled, parseDevInspectPort, parseWebDavPort } from '../debug.js';
import { killStaleNbfProcesses } from '../dev/killNbf.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(msg: string): never {
  console.error(red(`✗ ${msg}`));
  process.exit(1);
}

function isDebugEnabled(): boolean {
  return debugEnabled('cli');
}

function formatErrorForCli(err: unknown, debug: boolean): string {
  if (err instanceof Error) {
    if (debug && err.stack) return err.stack;
    return err.message;
  }
  return String(err);
}

async function bail(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    die(formatErrorForCli(err, isDebugEnabled()));
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
  .option('-d, --data-dir <path>', 'Storage directory', defaultDataDir())
  .option(
    '-m, --monitor',
    'Auto-activate the sticky live monitor when launching the REPL',
    false,
  )
  .option(
    '--debug [areas]',
    'Debug logging: cli, webdav, timing (comma-separated; omit areas to enable all)',
  )
  .option('--webdav-port <port>', 'WebDAV HTTPS listen port (REPL only)', '9843')
  .option(
    '--dev-inspect [port]',
    'REPL: extra loopback HTTP port for live replay debug JSON (default 9845)',
  );

program.hook('preAction', (thisCommand) => {
  applyDebugOption(thisCommand.opts<{ debug?: boolean | string }>().debug);
});

/**
 * Boot the interactive REPL. Shared by the explicit `repl` subcommand and
 * the no-subcommand default action below so `nbf` and `nbf repl` behave
 * identically. Keeping a single launch function means custom-flag handling
 * (`-d`, `-c`, `-m`, `--debug`) can't drift between the two entry points.
 */
function printDevInspectBanner(server: { baseUrl: string }): void {
  console.error(`Dev inspect: ${server.baseUrl}/`);
  console.error(
    '  GET /health  /volumes  /view  /replay/<vol>?at=live|<#>|<hash>|cursor',
  );
}

async function runRepl(): Promise<void> {
  const opts = program.opts<{
    config?: string;
    dataDir: string;
    monitor: boolean;
    webdavPort: string;
    devInspect?: boolean | string;
  }>();
  const webdavPort = parseWebDavPort(opts.webdavPort);
  const devInspectPort = parseDevInspectPort(opts.devInspect);
  killStaleNbfProcesses({
    webdavPort,
    devInspectPort: devInspectPort ?? 9845,
  });
  const config = await readConfig(opts.config).catch(() => emptyConfig(opts.dataDir));
  const ctx = await createContext(
    { ...config, dataDir: opts.dataDir ?? config.dataDir },
    {
      webdav: true,
      webdavPort,
      devInspectPort,
    },
  );
  if (ctx.devInspect !== null) {
    printDevInspectBanner(ctx.devInspect);
  }
  if (ctx.webdav !== null) {
    const profile = ctx.config.activeProfile;
    console.error(`WebDAV: ${ctx.webdav.baseUrl}/ (registered volumes at root)`);
    if (profile !== null) {
      console.error(
        `  Finder: user="${profile}" password=<part after ":" in profile secret> — type "webdav status" to see login state`,
      );
    } else {
      console.error('  Requires an active profile (profile add / profile use) before serving paths');
    }
  }
  await startRepl(ctx, {
    autoMonitor: opts.monitor === true,
    debug: debugEnabled('cli'),
  });
}

// ── repl ──────────────────────────────────────────────────────────────────
//
// REPL is also the default action (`program.action(runRepl)` at the bottom),
// so `nbf -d /tmp/x` and `nbf -d /tmp/x repl` are equivalent. The explicit
// subcommand stays for discoverability via `--help`.

program
  .command('repl')
  .description('Start an interactive REPL (default when no subcommand is given)')
  .action(runRepl);

// ── setup ─────────────────────────────────────────────────────────────────

program
  .command('setup')
  .description('Initialise a new channel (derive keys)')
  .requiredOption('-s, --secret <secret>', 'Channel secret  e.g. "myvolume:password"')
  .action(async (opts: { secret: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdSetup(ctx, opts.secret);
      await ctx.destroy();
    });
  });

// ── volume ────────────────────────────────────────────────────────────────

const volumeCmd = program.command('volume').description('Volume operations');

volumeCmd
  .command('open')
  .description('Open a volume and display its state')
  .requiredOption('-s, --secret <secret>', 'Volume secret')
  .action(async (opts: { secret: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdVolumeOpen(ctx, opts.secret, false);
      await ctx.destroy();
    });
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
  .action(async (opts: { secret: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdTimeline(ctx, opts.secret);
      await ctx.destroy();
    });
  });

// ── peers (diagnostics) ───────────────────────────────────────────────────

program
  .command('peers')
  .description('Snapshot of currently-connected peers (role, route, age, transport)')
  .option('-w, --wide', 'Show full peer ids and instance public keys in the peer table')
  .action(async (opts: { wide?: boolean }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdPeers(ctx, { wide: opts.wide === true });
      await ctx.destroy();
    });
  });

program
  .command('whoami')
  .description('Show this node\'s peerId, instance key, active profile, and sync configuration')
  .action(async () => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdWhoami(ctx);
      await ctx.destroy();
    });
  });

program
  .command('monitor')
  .alias('top')
  .description('Live htop-style peer monitor — boots sync, opens panel directly (q/Enter/Esc/^C to exit)')
  .option('--interval <ms>', 'Refresh interval in ms', '500')
  .action(async (opts: { interval: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    const intervalMs = Math.max(100, parseInt(opts.interval, 10) || 500);
    await bail(async () => {
      await cmdMonitor(ctx, { intervalMs });
      await ctx.destroy();
    });
  });

// ── file ──────────────────────────────────────────────────────────────────

const fileCmd = program.command('file').description('File operations');

fileCmd
  .command('add')
  .description('Add a file to a volume')
  .requiredOption('-p, --path <path>', 'Local file path')
  .requiredOption('-s, --secret <secret>', 'Volume secret')
  .option('-n, --name <name>', 'Name to store the file under (default: basename of path)')
  .action(async (opts: { path: string; secret: string; name?: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdFileAdd(ctx, opts.path, opts.secret, opts.name);
      await flushAndStop(ctx);
    });
  });

fileCmd
  .command('list')
  .alias('ls')
  .description('List files in a volume')
  .requiredOption('-s, --secret <secret>', 'Volume secret')
  .action(async (opts: { secret: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdFileList(ctx, opts.secret);
      await ctx.destroy();
    });
  });

fileCmd
  .command('get')
  .description('Retrieve a file from a volume')
  .requiredOption('-n, --name <name>', 'File name in the volume')
  .requiredOption('-s, --secret <secret>', 'Volume secret')
  .requiredOption('-o, --output <path>', 'Output file path')
  .action(async (opts: { name: string; secret: string; output: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdFileGet(ctx, opts.name, opts.secret, opts.output);
      await ctx.destroy();
    });
  });

fileCmd
  .command('remove')
  .alias('rm')
  .description('Remove a file from a volume')
  .requiredOption('-n, --name <name>', 'File name to remove')
  .requiredOption('-s, --secret <secret>', 'Volume secret')
  .action(async (opts: { name: string; secret: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdFileRemove(ctx, opts.name, opts.secret);
      await flushAndStop(ctx);
    });
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
  .action(async (name: string, secret: string) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
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
  .action(async (name: string) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
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
    const gopts = program.opts<{ config?: string; dataDir: string }>();
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
  .action(async (name?: string) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
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
  .action(async (opts: { name: string; bio?: string; as?: string }) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdProfilePublish(ctx, opts.name, opts.bio, opts.as);
      await flushAndStop(ctx);
    });
  });

profileCmd
  .command('remove')
  .alias('rm')
  .description('Remove a profile slot (re-elects active if needed)')
  .argument('<name>', 'Profile name')
  .action(async (name: string) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
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
    const gopts = program.opts<{ config?: string; dataDir: string }>();
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
  .action(async (publicKey: string) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
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
  .action(async (publicKeyOrPrefix: string) => {
    const gopts = program.opts<{ config?: string; dataDir: string }>();
    const config = await readConfig(gopts.config).catch(() => emptyConfig(gopts.dataDir));
    const ctx = await createContext({ ...config, dataDir: gopts.dataDir ?? config.dataDir });
    await bail(async () => {
      await cmdFriendRemove(ctx, publicKeyOrPrefix);
      await ctx.destroy();
    });
  });

// ── default action + parse ────────────────────────────────────────────────
//
// When the user runs `nbf` (or `nbf -d /tmp/x`) with no subcommand, drop
// into the REPL. Together with the matching package.json change that
// dropped the hard-coded `repl` token from the script line, this makes
// `yarn repl -d /tmp/x` (note: WITHOUT the `--` separator — Yarn 4
// forwards `--` literally, where Commander reads it as POSIX end-of-
// options and silently drops the flag) route through the default action
// with the correct dataDir.

program.action(runRepl);
program.parse();
