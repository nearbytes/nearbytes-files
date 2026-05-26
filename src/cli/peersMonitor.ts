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

import type * as readline from 'node:readline';
import type { ConnectedPeer, SyncEvent, SyncSnapshot, SyncStats } from 'nearbytes-sync/node';
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

/**
 * Render a peer table as a `string[]` of lines (no embedded newlines).
 * The sticky overlay needs line-by-line addressing so each row can be
 * written at an absolute cursor position; the legacy one-shot
 * `renderPeerTable` wrapper joins these lines back with `\n`.
 */
function renderPeerTableLines(rows: readonly PeerRow[]): string[] {
  if (rows.length === 0) {
    return [yellow('  (no peers connected)')];
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
  return [header, sep, ...body];
}

function renderPeerTable(rows: readonly PeerRow[]): string {
  return renderPeerTableLines(rows).join('\n');
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
 * Bytes-per-second formatted for a dashboard cell. We pick the unit
 * that keeps the integer part single-digit-ish so the column does not
 * jitter wildly between frames (e.g. "12.3 KB/s" stays the right
 * width whether the rate dips to "3.1 KB/s" or climbs to "98.7 KB/s").
 */
function fmtRate(bytesPerSec: number): string {
  if (bytesPerSec < 1) return '0 B/s';
  if (bytesPerSec < 1_024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1_048_576) return `${(bytesPerSec / 1_024).toFixed(1)} KB/s`;
  if (bytesPerSec < 1_073_741_824) return `${(bytesPerSec / 1_048_576).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1_073_741_824).toFixed(2)} GB/s`;
}

/**
 * Render the throughput / lifetime-totals row as a single line. The
 * row sits directly under the title bar so the operator's eye lands
 * on it first when watching for transfer activity.
 *
 *   ↓ 12.3 KB/s  ·  145 blk · 12 evt · 2.1 MB        ↑ 8.7 KB/s · 87 blk · 1.4 MB
 *
 * Symbols mirror the per-event log so direction reads at a glance.
 * `windowMs` is rendered in dim text so the user knows what "/s"
 * actually averages over.
 */
function renderThroughputRow(stats: SyncStats): string {
  const winLabel = dim(`/ ${Math.round(stats.windowMs / 1000)}s avg`);
  const inBlock =
    green(`↓ ${fmtRate(stats.bytesPerSecIn).padEnd(10)}`) +
    dim(' · ') +
    `${String(stats.totalBlocksIn).padStart(4)} ${dim('blk')}` +
    dim(' · ') +
    `${String(stats.totalEventsIn).padStart(3)} ${dim('evt')}` +
    dim(' · ') +
    bold(fmtBytes(stats.totalBytesIn));
  const outBlock =
    cyan(`↑ ${fmtRate(stats.bytesPerSecOut).padEnd(10)}`) +
    dim(' · ') +
    `${String(stats.totalBlocksOut).padStart(4)} ${dim('blk')}` +
    dim(' · ') +
    bold(fmtBytes(stats.totalBytesOut));
  return '  ' + inBlock + '   ' + dim('│') + '   ' + outBlock + '  ' + winLabel;
}

const ZERO_STATS: SyncStats = {
  totalBytesIn: 0,
  totalBytesOut: 0,
  totalBlocksIn: 0,
  totalBlocksOut: 0,
  totalEventsIn: 0,
  bytesPerSecIn: 0,
  bytesPerSecOut: 0,
  windowMs: 5_000,
};

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
 * Render the most-recent `maxRows` events as a `string[]` of lines,
 * newest at the bottom (the natural reading order — your eye lands on
 * the latest activity). An empty buffer renders a single placeholder
 * line so the panel never collapses to zero height between transfers.
 */
function renderEventLogLines(events: readonly SyncEvent[], maxRows: number): string[] {
  if (events.length === 0) {
    return [dim('  (no events yet — waiting for peer activity)')];
  }
  const start = Math.max(0, events.length - maxRows);
  return events.slice(start).map((e) => '  ' + fmtEvent(e));
}

function renderEventLog(events: readonly SyncEvent[], maxRows: number): string {
  return renderEventLogLines(events, maxRows).join('\n');
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
  /**
   * Cumulative + windowed throughput counters from whichever source
   * we read. Older daemons that omit `stats` from their beacon are
   * surfaced as `ZERO_STATS`, NOT as an error — the UI degrades to
   * "no throughput numbers yet" rather than refusing to render.
   */
  readonly stats: SyncStats;
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
      stats: sync.stats(),
      mode: 'local',
    };
  }
  const beacon = await readSyncStateBeacon(ctx.config.dataDir);
  if (beacon === null) {
    return {
      snapshot: { inflightInbound: 0, inflightOutbound: 0, connectedPeers: 0 },
      peers: [],
      events: [],
      stats: ZERO_STATS,
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
    /**
     * Older daemons did not include `stats` either; same back-compat
     * policy — surface zeroed counters instead of refusing to render.
     */
    stats: beacon.payload.stats ?? ZERO_STATS,
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
  console.log(renderThroughputRow(state.stats));
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

// ── monitor (sticky overlay + legacy fullscreen fallback) ─────────────────

/**
 * Compose the sticky pane content as exactly `height` lines, padded
 * with blank rows when the natural content is shorter. The composer
 * NEVER overflows the budget — overlong content is truncated. This
 * gives the redraw loop a hard upper bound on the rows it touches so
 * scroll-region clipping always works correctly.
 *
 * Layout (height ≥ 12):
 *   row 1 : title bar (mode · summary · clock)
 *   row 2 : separator
 *   row 3 : peer-table header
 *   row 4 : peer-table separator
 *   rows 5..K : peer rows (variable, ≤ MAX_PEER_ROWS)
 *   row K+1 : blank
 *   row K+2 : "Recent activity" subhead
 *   row K+3 : separator
 *   rows K+4..height : event log (newest at bottom)
 */
function renderStickyPaneLines(
  state: MonitorState,
  height: number,
  cols: number,
): string[] {
  const now = Date.now();
  const rows = state.peers.map((p) => toRow(p, now));

  const title =
    bold(' Nearbytes monitor ') +
    dim('─ ') +
    describeMode(state) +
    dim(' ─ ') +
    renderSummary(state.snapshot, state.peers.length) +
    dim(' ─ ') +
    dim(new Date().toLocaleTimeString());
  const visibleLen = (title.match(/[^\x1b]/g) || []).length;
  const trail = dim(' ' + '─'.repeat(Math.max(0, cols - visibleLen - 1)));

  const lines: string[] = [];
  lines.push(title + trail);
  lines.push(renderThroughputRow(state.stats));

  // Peer table (cap so the events region keeps at least 3 rows).
  const PEER_TABLE_OVERHEAD = 2; // header + separator
  const ACTIVITY_OVERHEAD = 3; // blank + subhead + separator
  const MIN_EVENT_ROWS = 3;
  const peerBudget = Math.max(
    0,
    height - 2 /* title + throughput */ - PEER_TABLE_OVERHEAD - ACTIVITY_OVERHEAD - MIN_EVENT_ROWS,
  );
  const cappedRows = rows.slice(0, Math.max(1, peerBudget));
  const peerLines = renderPeerTableLines(cappedRows);
  for (const l of peerLines) lines.push(l);

  // Blank + activity heading.
  lines.push('');
  lines.push(bold('  Recent activity'));
  lines.push(dim('  ' + '─'.repeat(Math.max(20, cols - 4))));

  // Whatever rows remain go to the event log.
  const eventBudget = Math.max(1, height - lines.length);
  const eventLines = renderEventLogLines(state.events, eventBudget);
  for (const l of eventLines) lines.push(l);

  // Pad / truncate to exactly `height`.
  if (lines.length > height) lines.length = height;
  while (lines.length < height) lines.push('');
  return lines;
}

/**
 * Compute the sticky pane height for the current terminal size. We
 * want the pane to feel substantial but never starve the REPL of
 * scrolling room. Heuristic: take ~40% of the terminal, clamped to
 * [13, 22] rows. The minimum 13 is the smallest layout that still
 * fits title + throughput + peer table + activity heading + 3 events.
 */
function computePaneHeight(termRows: number): number {
  const ideal = Math.floor(termRows * 0.4);
  return Math.max(13, Math.min(22, ideal));
}

interface StickyMonitorHandle {
  /** Tear down the overlay: reset scroll region, clear pane, re-prompt. */
  stop(): void;
}

const ANSI_RESET_SCROLL_REGION = '\x1b[r';
const ANSI_SAVE_CURSOR = '\x1b7';
const ANSI_RESTORE_CURSOR = '\x1b8';

/** Module-singleton: only one sticky monitor at a time per process. */
let activeStickyMonitor: StickyMonitorHandle | null = null;

/**
 * Mount a sticky monitor overlay anchored to the top N rows of the
 * terminal, with the REPL continuing to operate in the rows below.
 *
 * The implementation rests on three pieces of ANSI machinery:
 *
 *   1. DECSTBM (`\x1b[<top>;<bottom>r`) — sets the *scrolling region*
 *      of the terminal. Lines that fall outside the region stay fixed
 *      when the inside scrolls; this is what keeps the pane locked at
 *      the top while the REPL's output and prompt scroll naturally
 *      underneath.
 *
 *   2. DECSC / DECRC (`\x1b7` / `\x1b8`) — save and restore the
 *      cursor. The redraw loop saves the REPL's cursor position,
 *      addresses each pane row absolutely with CUP, then restores so
 *      the next keystroke / prompt-redraw lands where the user was
 *      typing.
 *
 *   3. EL (`\x1b[2K`) — clear the entire current line before
 *      rewriting it, so a shorter line in the new frame does not
 *      leave debris from the previous frame.
 *
 * The pane height is a fraction of the terminal rows (see
 * `computePaneHeight`), recomputed on SIGWINCH so a window resize
 * does not break the layout.
 *
 * Cleanup is non-negotiable: stop() resets the scroll region, clears
 * the pane rows, and asks readline to redraw its prompt. We also
 * self-attach to `rl.on('close')` so a REPL exit while the overlay
 * is up never leaves the user staring at a terminal with a tiny
 * scroll region.
 */
function startStickyMonitor(
  ctx: Context,
  rl: readline.Interface,
  intervalMs = 500,
): StickyMonitorHandle {
  const stdout = process.stdout;
  let paneHeight = computePaneHeight(stdout.rows || 24);
  let stopped = false;
  let writing = false;

  const setScrollRegion = (): void => {
    const rows = stdout.rows || 24;
    // Region must be 1-based and bottom > top; on a tiny terminal we
    // fall back to "no overlay, just don't crash".
    if (rows <= paneHeight + 1) {
      stdout.write(ANSI_RESET_SCROLL_REGION);
      return;
    }
    stdout.write(`\x1b[${paneHeight + 1};${rows}r`);
  };

  const clearPaneRows = (): void => {
    for (let i = 1; i <= paneHeight; i++) {
      stdout.write(`\x1b[${i};1H\x1b[2K`);
    }
  };

  const draw = async (): Promise<void> => {
    if (stopped || writing) return;
    writing = true;
    try {
      const state = await readMonitorState(ctx);
      const cols = stdout.columns || 80;
      const lines = renderStickyPaneLines(state, paneHeight, cols);
      stdout.write(ANSI_SAVE_CURSOR);
      for (let i = 0; i < paneHeight; i++) {
        stdout.write(`\x1b[${i + 1};1H\x1b[2K`);
        stdout.write(lines[i] ?? '');
      }
      stdout.write(ANSI_RESTORE_CURSOR);
    } finally {
      writing = false;
    }
  };

  // Initial setup: scroll the existing content up so the top rows are
  // blank, set the scroll region, position the cursor below the pane,
  // and prompt readline to redraw.
  stdout.write('\x1b[2J');           // clear screen
  stdout.write('\x1b[H');             // home
  setScrollRegion();
  stdout.write(`\x1b[${paneHeight + 1};1H`);
  rl.prompt(true);

  void draw();
  const timer = setInterval(() => void draw(), intervalMs);
  timer.unref();

  const onResize = (): void => {
    if (stopped) return;
    paneHeight = computePaneHeight(stdout.rows || 24);
    setScrollRegion();
    void draw();
    // The REPL's prompt-line position is implicit in readline's state;
    // a redraw nudges it to re-flush inside the new region.
    rl.prompt(true);
  };
  stdout.on('resize', onResize);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    stdout.removeListener('resize', onResize);
    rl.removeListener('close', stop);
    stdout.write(ANSI_RESET_SCROLL_REGION);
    stdout.write(ANSI_SAVE_CURSOR);
    clearPaneRows();
    stdout.write(ANSI_RESTORE_CURSOR);
    rl.prompt(true);
  };
  // Self-cleanup on REPL exit so the overlay never outlives the
  // readline session and confuses the next shell.
  rl.once('close', stop);

  return { stop };
}

export interface MonitorOptions {
  /** Tick interval in milliseconds. Default 500 ms. */
  readonly intervalMs?: number;
  /**
   * REPL handle. When provided AND the terminal is a TTY, `monitor`
   * mounts the sticky overlay; when omitted (e.g. `nbf monitor`
   * standalone, or piped invocation) it falls back to the legacy
   * fullscreen monitor with key-driven exit.
   */
  readonly rl?: readline.Interface;
  /**
   * Sub-verb arguments controlling toggle behaviour. Accepts
   *   `on`  / `start` / `+`  — force on
   *   `off` / `stop`  / `-`  — force off
   *   anything else (or empty) — toggle
   */
  readonly args?: readonly string[];
}

/**
 * `monitor` command dispatcher.
 *
 * Three call modes:
 *
 *  1. REPL + TTY (opts.rl set, stdout/stdin TTY): sticky overlay.
 *     The pane is mounted at the top of the terminal, the REPL
 *     prompt stays at the bottom, and `monitor` becomes a toggle —
 *     re-issuing `monitor` (or `monitor off`) tears the overlay down.
 *
 *  2. Standalone TTY (`nbf monitor`, no rl): legacy fullscreen mode
 *     that takes over the entire screen until q/Enter/Esc/^C. There
 *     is no REPL to coexist with, so the takeover is appropriate.
 *
 *  3. Non-TTY (pipes, CI): single-shot snapshot via `cmdPeers`. The
 *     interactive overlay needs cursor addressing that pipes do not
 *     support; the snapshot still answers "what's up right now?".
 */
export async function cmdMonitor(ctx: Context, opts: MonitorOptions = {}): Promise<void> {
  const args = opts.args ?? [];
  const wantOn = args.some((a) => a === 'on' || a === 'start' || a === '+');
  const wantOff = args.some((a) => a === 'off' || a === 'stop' || a === '-');

  const tty = process.stdout.isTTY === true && process.stdin.isTTY === true;
  if (!tty) {
    await cmdPeers(ctx);
    return;
  }

  // REPL mode: sticky overlay toggle.
  if (opts.rl !== undefined) {
    if (wantOff) {
      if (activeStickyMonitor !== null) {
        activeStickyMonitor.stop();
        activeStickyMonitor = null;
        console.log(dim('  monitor: off'));
      } else {
        console.log(dim('  monitor: already off'));
      }
      return;
    }
    if (wantOn) {
      if (activeStickyMonitor !== null) {
        console.log(dim('  monitor: already on'));
        return;
      }
      activeStickyMonitor = startStickyMonitor(ctx, opts.rl, opts.intervalMs);
      console.log(dim('  monitor: on  (use `monitor off` to hide)'));
      return;
    }
    // Bare `monitor` → toggle.
    if (activeStickyMonitor !== null) {
      activeStickyMonitor.stop();
      activeStickyMonitor = null;
      console.log(dim('  monitor: off'));
    } else {
      activeStickyMonitor = startStickyMonitor(ctx, opts.rl, opts.intervalMs);
      console.log(dim('  monitor: on  (use `monitor off` to hide)'));
    }
    return;
  }

  // Standalone (no REPL): legacy fullscreen takeover.
  await cmdMonitorFullscreen(ctx, opts.intervalMs ?? 500);
}

/**
 * Legacy fullscreen monitor for standalone `nbf monitor` invocations
 * (no surrounding REPL). Takes over the entire screen and exits on
 * q/Enter/Esc/^C/^D. Kept intact because there is no REPL to share
 * the screen with — the takeover IS the right UX here.
 */
async function cmdMonitorFullscreen(ctx: Context, intervalMs: number): Promise<void> {
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
    for (const ch of chunk) {
      if (
        ch === 'q' ||
        ch === 'Q' ||
        ch === '\r' ||
        ch === '\n' ||
        ch === '\x1b' ||
        ch === '\x03' ||
        ch === '\x04'
      ) {
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
    const cols = stdout.columns || 80;
    const rowsTotal = stdout.rows || 24;
    const lines = renderStickyPaneLines(state, Math.max(12, rowsTotal - 2), cols);
    stdout.write(ANSI.cursorHome);
    stdout.write(ANSI.clearToEndOfScreen);
    stdout.write(lines.join('\n') + '\n');
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

  stdin.removeListener('data', onKey);
  process.removeListener('SIGINT', onSig);
  process.removeListener('SIGTERM', onSig);
  if (!wasRawMode) stdin.setRawMode(false);
  stdin.pause();
  stdout.write(ANSI.showCursor);
  stdout.write('\n');
  if (stopReasons.bySignal === 'SIGINT') {
    console.log(red('  monitor interrupted (^C)'));
  } else {
    console.log(dim('  monitor closed'));
  }
}
