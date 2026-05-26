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

import type { ConnectedPeer, SyncEvent, SyncSnapshot } from 'nearbytes-sync/node';
import { readSyncStateBeacon } from 'nearbytes-sync/node';
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

// ── event-log rendering ───────────────────────────────────────────────────

/**
 * Format an epoch-ms timestamp as `HH:MM:SS.mmm`. We display the
 * milliseconds because sub-second activity is common during a
 * single-block transfer and the ordering tells the operator whether
 * "block sent" preceded or followed the corresponding "block received"
 * on the other side.
 */
function fmtTime(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/**
 * Format a single event into a one-line, colour-coded log entry. The
 * symbols are intentionally non-textual ("+", "−", "↑", "↓", "⊕") so a
 * fast scan of the column shows direction even before the eye parses
 * the verb. Hashes and peer-ids are truncated to 8 hex chars to fit in
 * the column budget; the full identity lives in `peers` for forensics.
 */
function fmtEvent(e: SyncEvent): string {
  const time = dim(fmtTime(e.at));
  switch (e.kind) {
    case 'peer-connected': {
      const roleStr =
        e.role === 'sibling' ? cyan('sibling') : yellow('friend ');
      return (
        time +
        '  ' + green('+ peer connect   ') +
        roleStr +
        '  ' + e.remoteProfilePublicKey.slice(0, 8) +
        '  ' + dim('via ') + dim(e.transportLabel)
      );
    }
    case 'peer-disconnected': {
      return (
        time +
        '  ' + red('− peer disconn.  ') +
        dim('       ') +
        '  ' + e.remoteProfilePublicKey.slice(0, 8) +
        '  ' + dim('via ') + dim(e.transportLabel)
      );
    }
    case 'block-sent': {
      return (
        time +
        '  ' + cyan('↑ block sent     ') +
        dim('       ') +
        '  ' + e.blockHash.slice(0, 8) +
        '  ' + dim('→ ') + e.toPeerId.slice(0, 8) +
        '  ' + bold(fmtBytes(e.bytes))
      );
    }
    case 'block-received': {
      return (
        time +
        '  ' + green('↓ block recv     ') +
        dim('       ') +
        '  ' + e.blockHash.slice(0, 8) +
        '  ' + dim('← ') + e.fromPeerId.slice(0, 8) +
        '  ' + bold(fmtBytes(e.bytes))
      );
    }
    case 'event-received': {
      return (
        time +
        '  ' + yellow('⊕ event recv     ') +
        dim('       ') +
        '  ' + e.eventHash.slice(0, 8) +
        '  ' + dim('← ') + e.fromPeerId.slice(0, 8) +
        '  ' + dim(fmtBytes(e.bytes))
      );
    }
  }
}

/**
 * Render the most-recent `maxRows` events as a vertical log, newest at
 * the bottom (the natural reading order — your eye lands on the latest
 * activity). An empty buffer renders a placeholder so the panel never
 * collapses to zero height between transfers.
 */
function renderEventLog(events: readonly SyncEvent[], maxRows: number): string {
  if (events.length === 0) {
    return dim('  (no events yet — waiting for peer activity)');
  }
  const start = Math.max(0, events.length - maxRows);
  const rows = events.slice(start).map((e) => '  ' + fmtEvent(e));
  return rows.join('\n');
}

// ── monitor state source ──────────────────────────────────────────────────

interface MonitorState {
  readonly snapshot: SyncSnapshot;
  readonly peers: readonly ConnectedPeer[];
  /**
   * Most-recent wire events from whichever source we read.
   * `local` mode → this process's own `SyncEventBuffer`.
   * beacon modes → `payload.events` from the daemon's beacon (may be
   * absent for older daemons; treated as an empty list).
   */
  readonly events: readonly SyncEvent[];
  /** Where this state came from: our own sync engine, or the daemon's beacon. */
  readonly mode: 'local' | 'beacon' | 'beacon-stale' | 'beacon-missing';
  /** Beacon age in ms (only set in beacon modes). */
  readonly beaconAgeMs?: number;
  /** Beacon-publishing daemon pid (only set in beacon modes). */
  readonly beaconPid?: number;
}

const BEACON_STALE_THRESHOLD_MS = 5_000;

/**
 * Read the current monitor state from the appropriate source.
 *
 * In normal mode we are the sync engine for this dataDir, so the state
 * lives in memory — read it from `sync.snapshot()` / `sync.peers()`.
 *
 * In writer-only mode (a daemon already owns the dataDir lock) we are
 * NOT the sync engine and `sync.peers()` would always return `[]`. So
 * we read the daemon's published state beacon
 * (`<dataDir>/.nearbytes-sync.state.json`) and surface what it sees.
 * If the beacon is missing or stale (>5 s old) we report that
 * explicitly so the operator can distinguish "daemon is quietly
 * waiting" from "daemon may be hung".
 */
async function readMonitorState(ctx: Context): Promise<MonitorState> {
  const sync = ctx.skeleton.sync;
  const daemon = (sync as { daemon?: { holderPid: number; lockPath: string } }).daemon;
  if (daemon === undefined) {
    return {
      snapshot: sync.snapshot(),
      peers: sync.peers(),
      events: sync.recentEvents(),
      mode: 'local',
    };
  }
  const beacon = await readSyncStateBeacon(ctx.config.dataDir);
  if (beacon === null) {
    return {
      snapshot: { inflightInbound: 0, inflightOutbound: 0, connectedPeers: 0 },
      peers: [],
      events: [],
      mode: 'beacon-missing',
      beaconPid: daemon.holderPid,
    };
  }
  const peers: ConnectedPeer[] = beacon.payload.peers.map((p) => ({
    remoteProfilePublicKey: p.remoteProfilePublicKey,
    remotePeerId: p.remotePeerId,
    transportLabel: p.transportLabel,
    localAssociationProfile: p.localAssociationProfile,
    connectedAt: new Date(p.connectedAt),
    role: p.role,
  }));
  const mode = beacon.ageMs > BEACON_STALE_THRESHOLD_MS ? 'beacon-stale' : 'beacon';
  return {
    snapshot: beacon.payload.snapshot,
    peers,
    /**
     * Older daemons did not include `events`; treat that as "no events
     * to display" rather than as an error. The mode reported in the
     * title bar (DAEMON vs DAEMON?) already conveys beacon health.
     */
    events: beacon.payload.events ?? [],
    mode,
    beaconAgeMs: beacon.ageMs,
    beaconPid: beacon.payload.pid,
  };
}

function describeMode(state: MonitorState): string {
  switch (state.mode) {
    case 'local':
      return cyan('LIVE') + dim(' (this process is the sync engine)');
    case 'beacon': {
      const age = state.beaconAgeMs ?? 0;
      return (
        green('DAEMON') +
        dim(
          ` (read from beacon — pid=${state.beaconPid ?? '?'}, ${(age / 1000).toFixed(1)}s old)`,
        )
      );
    }
    case 'beacon-stale': {
      const age = state.beaconAgeMs ?? 0;
      return (
        yellow('DAEMON ?') +
        dim(
          ` (beacon ${(age / 1000).toFixed(1)}s stale — daemon pid=${state.beaconPid ?? '?'} may be hung)`,
        )
      );
    }
    case 'beacon-missing':
      return (
        yellow('NO BEACON') +
        dim(
          ` (daemon pid=${state.beaconPid ?? '?'} owns the lock but is not publishing state)`,
        )
      );
  }
}

// ── peers (single-shot) ───────────────────────────────────────────────────

/**
 * Print the list of currently-connected peers once, with route hints. Used
 * by both the REPL `peers` verb and the standalone `nbf peers` subcommand.
 * In writer-only mode reads from the daemon's beacon — never just refuses.
 */
export async function cmdPeers(ctx: Context): Promise<void> {
  const state = await readMonitorState(ctx);
  const now = Date.now();

  console.log('');
  console.log(bold('Sync state') + '   ' + describeMode(state));
  console.log(dim('─'.repeat(60)));
  console.log('  ' + renderSummary(state.snapshot, state.peers.length));
  console.log('');
  console.log(bold('Connected peers'));
  console.log(dim('─'.repeat(60)));
  const rows = state.peers.map((p) => toRow(p, now));
  console.log(renderPeerTable(rows));
  console.log('');
  // Recent activity: a one-shot tail. In writer-only mode this is the
  // daemon's `events` from the beacon, which means `nbf peers` against
  // a daemon-owned dataDir already answers "what is happening right
  // now?" without needing to spin up the live monitor.
  console.log(bold('Recent activity'));
  console.log(dim('─'.repeat(60)));
  console.log(renderEventLog(state.events, 10));
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
 * Source of truth:
 *   - In normal mode: this process's own `sync.snapshot()` / `sync.peers()`.
 *   - In writer-only mode: the daemon's published beacon
 *     (`<dataDir>/.nearbytes-sync.state.json`). The title bar shows the
 *     source explicitly so the operator always knows what they are
 *     looking at.
 *
 * Implementation note: the monitor takes over the entire screen using
 * `\x1b[2J` + cursor-home; on exit it restores the cursor and prints a
 * brief "monitor closed" footer. We deliberately do NOT touch readline's
 * own buffers — the REPL's dispatch chain serialises commands so the
 * monitor is the only writer to stdout for its lifetime.
 */
export async function cmdMonitor(ctx: Context, opts: MonitorOptions = {}): Promise<void> {
  const intervalMs = opts.intervalMs ?? 500;

  const tty = process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (!tty) {
    // Falling back to a single snapshot is more useful than refusing entirely.
    await cmdPeers(ctx);
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

  const draw = async (): Promise<void> => {
    const state = await readMonitorState(ctx);
    const now = Date.now();
    const rows = state.peers.map((p) => toRow(p, now));
    const cols = stdout.columns || 80;
    const titleBar =
      bold(' Nearbytes monitor ') +
      dim('─ ') +
      describeMode(state) +
      dim(' ─ ') +
      renderSummary(state.snapshot, state.peers.length) +
      dim(' ─ ') +
      dim(new Date().toLocaleTimeString());
    const titleBarLen = (titleBar.match(/[^\x1b]/g) || []).length; // best-effort visible-length
    const trail = '─'.repeat(Math.max(0, cols - titleBarLen - 1));
    /**
     * Event-log row budget: take what remains after the chrome we know
     * we render (title + blanks + peer table + footer). For typical
     * terminals (24+ rows) this yields a comfortable 10-line tail.
     * If the terminal is short we shrink to a minimum of 3 rows so the
     * activity panel never disappears entirely — better to have a
     * smaller window than to crop it away on a tiny terminal.
     */
    const peerRowCount = Math.max(1, rows.length);
    const peerTableHeight = peerRowCount + 2; // header + separator
    const chromeHeight = 1 + 1 + peerTableHeight + 1 + 1 + 1 + 1 + 1 + 1;
    const lines = stdout.rows || 24;
    const eventRows = Math.max(3, Math.min(15, lines - chromeHeight));
    stdout.write(ANSI.cursorHome);
    stdout.write(ANSI.clearToEndOfScreen);
    stdout.write(titleBar + dim(' ' + trail) + '\n');
    stdout.write('\n');
    stdout.write(renderPeerTable(rows) + '\n');
    stdout.write('\n');
    stdout.write(bold('  Recent activity') + '\n');
    stdout.write(dim('  ' + '─'.repeat(Math.max(20, cols - 4))) + '\n');
    stdout.write(renderEventLog(state.events, eventRows) + '\n');
    stdout.write('\n');
    stdout.write(dim('  q · Enter · Esc · ^C   to exit') + '\n');
  };

  stdout.write(ANSI.clearScreen);
  await draw();

  await new Promise<void>((resolve) => {
    const tick = async (): Promise<void> => {
      if (stopped) {
        resolve();
        return;
      }
      await draw();
      const t = setTimeout(() => void tick(), intervalMs);
      t.unref();
    };
    const t = setTimeout(() => void tick(), intervalMs);
    t.unref();
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
