/**
 * Observability commands for the CLI: `peers` (snapshot) and `monitor`
 * (htop-style live panel).
 *
 * Goal: answer "where is this block coming from?" with no clutter and no
 * extra dependencies. We render directly to the TTY using a tiny set of
 * ANSI escapes (cursor home / clear-to-end / hide-cursor) — no `blessed`,
 * `ink`, or anything else.
 *
 * Both commands work in REPL mode and in one-shot mode (`nbf peers`).
 */

import type { ConnectedPeer, SyncSnapshot } from 'nearbytes-sync/node';
import type { Context } from './context.js';
import { bold, cyan, dim, green, yellow, red } from './output.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────

const ESC = '\x1b';
const ANSI = {
  /** Clear screen, then move cursor to row 1 col 1. */
  clearScreen: `${ESC}[2J${ESC}[H`,
  cursorHome: `${ESC}[H`,
  clearToEndOfScreen: `${ESC}[J`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
} as const;

// ── shared formatting ─────────────────────────────────────────────────────

function fmtAge(connectedAt: Date, now: number): string {
  const sec = Math.max(0, Math.floor((now - connectedAt.getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 ? ` ${sec % 60}s` : ''}`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? ` ${min % 60}m` : ''}`;
}

/**
 * Classify the transport label into a short, colour-coded "where from"
 * hint. The label itself is already authoritative; this is just a
 * human-friendly summary so the operator can answer at a glance:
 *
 *   loopback   — same machine, mDNS picked up our own daemon / sibling
 *   LAN        — different machine on the same subnet, mDNS-TCP
 *   DHT        — Hyperswarm routed; either local-DHT or WAN — typically WAN
 *   unknown    — fallback when the discovery layer did not tag the label
 */
function classifyTransport(label: string): { route: string; tint: (s: string) => string } {
  if (label.startsWith('mdns-tcp:')) {
    const addr = label.slice('mdns-tcp:'.length);
    if (
      addr.startsWith('127.') ||
      addr.startsWith('::1') ||
      addr.startsWith('localhost')
    ) {
      return { route: 'loopback', tint: dim };
    }
    return { route: 'LAN', tint: green };
  }
  if (label.startsWith('mdns:')) return { route: 'LAN', tint: green };
  if (label.startsWith('hyperswarm:')) return { route: 'DHT', tint: cyan };
  if (label.startsWith('tcp:')) {
    const addr = label.slice('tcp:'.length);
    if (addr.startsWith('127.') || addr.startsWith('::1')) {
      return { route: 'loopback', tint: dim };
    }
    return { route: 'LAN', tint: green };
  }
  return { route: '?', tint: yellow };
}

function shortHex(hex: string, n = 8): string {
  if (!hex) return dim('—'.padEnd(n));
  return hex.slice(0, n);
}

interface PeerRow {
  readonly role: 'sibling' | 'friend';
  readonly profile: string;
  readonly peerId: string;
  readonly route: string;
  readonly routeTint: (s: string) => string;
  readonly label: string;
  readonly age: string;
}

function toRow(peer: ConnectedPeer, now: number): PeerRow {
  const { route, tint } = classifyTransport(peer.transportLabel);
  return {
    role: peer.role,
    profile: shortHex(peer.remoteProfilePublicKey),
    peerId: shortHex(peer.remotePeerId),
    route,
    routeTint: tint,
    label: peer.transportLabel,
    age: fmtAge(peer.connectedAt, now),
  };
}

function renderPeerTable(rows: readonly PeerRow[]): string {
  if (rows.length === 0) {
    return yellow('  (no peers connected)');
  }
  const COL_NUM = 3;
  const COL_ROLE = 8;
  const COL_PROFILE = 10;
  const COL_PEERID = 10;
  const COL_ROUTE = 10;
  const COL_AGE = 6;
  const header =
    bold('#'.padEnd(COL_NUM)) +
    bold('Role'.padEnd(COL_ROLE)) +
    bold('Profile'.padEnd(COL_PROFILE)) +
    bold('PeerId'.padEnd(COL_PEERID)) +
    bold('Route'.padEnd(COL_ROUTE)) +
    bold('Age'.padEnd(COL_AGE)) +
    bold('Transport');
  const sep = dim('─'.repeat(COL_NUM + COL_ROLE + COL_PROFILE + COL_PEERID + COL_ROUTE + COL_AGE + 24));
  /**
   * Pad-first-then-tint: ANSI escape codes are invisible to `String.padEnd`
   * but counted in `.length`, so colouring before padding breaks alignment.
   * We pad the plain string, then apply the colour wrapper.
   */
  const padThenTint = (s: string, width: number, tint: (x: string) => string): string =>
    tint(s.padEnd(width));

  const body = rows.map((r, i) => {
    const roleTint = r.role === 'sibling' ? cyan : yellow;
    return (
      dim(String(i + 1).padEnd(COL_NUM)) +
      padThenTint(r.role, COL_ROLE, roleTint) +
      r.profile.padEnd(COL_PROFILE) +
      r.peerId.padEnd(COL_PEERID) +
      padThenTint(r.route, COL_ROUTE, r.routeTint) +
      r.age.padEnd(COL_AGE) +
      dim(r.label)
    );
  });
  return [header, sep, ...body].join('\n');
}

function renderSummary(snap: SyncSnapshot, peerCount: number): string {
  return (
    bold('peers ') + String(peerCount).padStart(2) + '  ' +
    dim('·') + ' ' +
    bold('in ') + String(snap.inflightInbound).padStart(2) + '  ' +
    dim('·') + ' ' +
    bold('out ') + String(snap.inflightOutbound).padStart(2)
  );
}

// ── peers (single-shot) ───────────────────────────────────────────────────

/**
 * Print the list of currently-connected peers once, with route hints. Used
 * by both the REPL `peers` verb and the standalone `nbf peers` subcommand.
 */
export function cmdPeers(ctx: Context): void {
  const sync = ctx.skeleton.sync;
  const daemon = (sync as { daemon?: { holderPid: number; lockPath: string } }).daemon;
  const snap = sync.snapshot();
  const peers = sync.peers();
  const now = Date.now();

  console.log('');
  console.log(bold('Sync state'));
  console.log(dim('─'.repeat(60)));
  if (daemon !== undefined) {
    console.log(
      yellow('  writer-only mode') +
        dim(` — sync engine owned by daemon pid=${daemon.holderPid}; this CLI just writes locally.`),
    );
    console.log(
      dim(`  Run `) + bold('peers') + dim(' on the daemon (e.g. `nbsync status`) for its peer view.'),
    );
    console.log('');
    return;
  }
  console.log('  ' + renderSummary(snap, peers.length));
  console.log('');
  console.log(bold('Connected peers'));
  console.log(dim('─'.repeat(60)));
  const rows = peers.map((p) => toRow(p, now));
  console.log(renderPeerTable(rows));
  console.log('');
}

// ── monitor (live panel) ──────────────────────────────────────────────────

interface MonitorOptions {
  /** Tick interval in milliseconds. Default 500 ms. */
  readonly intervalMs?: number;
}

/**
 * Live htop-style monitor that redraws every `intervalMs` (default 500 ms)
 * until the user presses q, Enter, Esc, or ^C. Hides the cursor during the
 * session and restores it on exit; toggles raw mode only if stdin is a TTY
 * (no-op for pipes, so it stays safe in CI).
 *
 * Implementation note: the monitor takes over the entire screen using
 * `\x1b[2J` + cursor-home; on exit it restores the cursor and prints a
 * brief "monitor closed" footer. We deliberately do NOT touch readline's
 * own buffers — the REPL's dispatch chain serialises commands so the
 * monitor is the only writer to stdout for its lifetime.
 */
export async function cmdMonitor(ctx: Context, opts: MonitorOptions = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 500;
  const sync = ctx.skeleton.sync;
  const daemon = (sync as { daemon?: { holderPid: number; lockPath: string } }).daemon;

  if (daemon !== undefined) {
    console.log(
      yellow('  monitor not available in writer-only mode') +
        dim(` — sync engine is owned by daemon pid=${daemon.holderPid}.`),
    );
    return;
  }

  const tty = process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (!tty) {
    // Falling back to a single snapshot is more useful than refusing entirely.
    cmdPeers(ctx);
    return;
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  let stopped = false;
  const stopReasons: { byKey?: string; bySignal?: NodeJS.Signals } = {};

  const wasRawMode = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdout.write(ANSI.hideCursor);

  const onKey = (chunk: string): void => {
    // q | Q | Enter | Esc | ^C | ^D → stop
    for (const ch of chunk) {
      if (ch === 'q' || ch === 'Q' || ch === '\r' || ch === '\n' || ch === '\x1b' || ch === '\x03' || ch === '\x04') {
        stopReasons.byKey = ch;
        stopped = true;
        return;
      }
    }
  };
  stdin.on('data', onKey);

  const onSig = (sig: NodeJS.Signals): void => {
    stopReasons.bySignal = sig;
    stopped = true;
  };
  process.once('SIGINT', onSig);
  process.once('SIGTERM', onSig);

  const draw = (): void => {
    const now = Date.now();
    const snap = sync.snapshot();
    const peers = sync.peers();
    const rows = peers.map((p) => toRow(p, now));
    const cols = stdout.columns || 80;
    const titleBar =
      bold(' Nearbytes monitor ') +
      dim('─ ') +
      renderSummary(snap, peers.length) +
      dim(' ─ ') +
      dim(new Date().toLocaleTimeString());
    const titleBarLen = (titleBar.match(/[^\x1b]/g) || []).length; // best-effort visible-length
    const trail = '─'.repeat(Math.max(0, cols - titleBarLen - 1));
    stdout.write(ANSI.cursorHome);
    stdout.write(ANSI.clearToEndOfScreen);
    stdout.write(titleBar + dim(' ' + trail) + '\n');
    stdout.write('\n');
    stdout.write(renderPeerTable(rows) + '\n');
    stdout.write('\n');
    stdout.write(dim('  q · Enter · Esc · ^C   to exit') + '\n');
  };

  stdout.write(ANSI.clearScreen);
  draw();

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (stopped) {
        resolve();
        return;
      }
      draw();
      setTimeout(tick, intervalMs).unref();
    };
    setTimeout(tick, intervalMs).unref();
  });

  // Restore terminal state.
  stdin.removeListener('data', onKey);
  process.removeListener('SIGINT', onSig);
  process.removeListener('SIGTERM', onSig);
  if (!wasRawMode) stdin.setRawMode(false);
  stdin.pause();
  stdout.write(ANSI.showCursor);
  stdout.write('\n');
  if (stopReasons.bySignal === 'SIGINT') {
    // Re-raise SIGINT semantics for the REPL: it will treat ^C as "abort
    // current line", which is exactly the UX we want.
    console.log(red('  monitor interrupted (^C)'));
  } else {
    console.log(dim('  monitor closed'));
  }
}
