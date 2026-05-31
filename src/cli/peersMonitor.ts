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

import { networkInterfaces } from 'node:os';
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

// ── route classification (LAN / local / DHT) ──────────────────────────────

/**
 * Cached set of "this machine's addresses": loopback + every address
 * advertised by every up local interface. We use this to recognise a
 * peer as `local` even when the discovery layer announces the LAN IP
 * (192.168.x) instead of 127.x — which is what mDNS does on macOS
 * when broadcasting to siblings on the same machine.
 *
 * Refreshed lazily every {@link LOCAL_ADDR_TTL_MS} so VPN
 * connects/disconnects, interface up/down, etc. eventually take
 * effect without restarting the CLI.
 */
let cachedLocalAddrs: Set<string> | null = null;
let cachedLocalAddrsAt = 0;
const LOCAL_ADDR_TTL_MS = 5_000;

function getLocalAddresses(): Set<string> {
  const now = Date.now();
  if (cachedLocalAddrs !== null && now - cachedLocalAddrsAt < LOCAL_ADDR_TTL_MS) {
    return cachedLocalAddrs;
  }
  const set = new Set<string>(['127.0.0.1', '::1', 'localhost']);
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const iface of list) {
      set.add(iface.address.toLowerCase());
    }
  }
  cachedLocalAddrs = set;
  cachedLocalAddrsAt = now;
  return set;
}

/**
 * "Is this address served by an interface on this machine?" — used to
 * promote LAN-looking peers to `local` when they are in fact running
 * on the same host. Includes the standard loopback wildcards plus
 * every address found in `os.networkInterfaces()`.
 */
function isLocalAddress(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower.startsWith('127.') || lower === '::1' || lower === 'localhost') {
    return true;
  }
  // IPv6 link-local prefix.
  if (lower.startsWith('fe80:')) return true;
  return getLocalAddresses().has(lower);
}

/**
 * Parse `host:port` (or bracketed IPv6) out of discovery transport labels:
 *
 *   dht:192.168.1.5:42393
 *   dht:[fe80::1]:53432
 *   mdns-tcp:192.168.1.5:53432->041703b9
 *   tcp:127.0.0.1:51999
 *
 * Legacy `hyperswarm:<pubkey>` labels carry no endpoint → `null`.
 */
function parseHostPortFromLabel(label: string): { host: string; port: number } | null {
  if (label.startsWith('hyperswarm:') || label.startsWith('mdns:')) {
    return null;
  }
  const prefixes = ['dht:', 'mdns-tcp:', 'tcp:'] as const;
  let rest: string | null = null;
  for (const prefix of prefixes) {
    if (label.startsWith(prefix)) {
      rest = label.slice(prefix.length);
      break;
    }
  }
  if (rest === null) {
    return null;
  }
  const arrow = rest.indexOf('->');
  const hostPort = arrow >= 0 ? rest.slice(0, arrow) : rest;
  if (hostPort === 'unknown') {
    return { host: 'unknown', port: 0 };
  }
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close > 0) {
      const host = hostPort.slice(1, close).toLowerCase();
      const portPart = hostPort.slice(close + 1);
      const port = portPart.startsWith(':') ? parseInt(portPart.slice(1), 10) : 0;
      return { host, port: Number.isNaN(port) ? 0 : port };
    }
  }
  const lastColon = hostPort.lastIndexOf(':');
  if (lastColon < 0) {
    return { host: hostPort.toLowerCase(), port: 0 };
  }
  const host = hostPort.slice(0, lastColon).toLowerCase();
  const port = parseInt(hostPort.slice(lastColon + 1), 10);
  return { host, port: Number.isNaN(port) ? 0 : port };
}

function extractIpFromLabel(label: string, prefix: string): string | null {
  if (!label.startsWith(prefix)) {
    return null;
  }
  return parseHostPortFromLabel(label)?.host ?? null;
}

/**
 * Compact endpoint for monitor / peer table (no `via hyperswarm:…` noise).
 * Route (LAN / DHT / local) stays in its own column.
 */
function formatTransportEndpoint(label: string): string {
  const hp = parseHostPortFromLabel(label);
  if (hp !== null) {
    if (hp.host === 'unknown') {
      return yellow('… resolving route');
    }
    const hostShown = hp.host.includes(':') ? `[${hp.host}]` : hp.host;
    return hp.port > 0 ? `${hostShown}:${hp.port}` : hostShown;
  }
  if (label.startsWith('hyperswarm:')) {
    return `DHT ${label.slice('hyperswarm:'.length, 'hyperswarm:'.length + 8)}`;
  }
  if (label.startsWith('mdns:')) {
    return 'mDNS';
  }
  return label.length > 28 ? `${label.slice(0, 28)}…` : label;
}

const ACTIVITY_ROLLUP_MS = 1_000;

function transferPeerKey(e: SyncEvent): string | null {
  switch (e.kind) {
    case 'block-sent':
      return e.toPeerId;
    case 'block-received':
    case 'event-received':
      return e.fromPeerId;
    default:
      return null;
  }
}

function canRollupTransfer(a: SyncEvent, b: SyncEvent): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind !== 'block-sent' && a.kind !== 'block-received' && a.kind !== 'event-received') {
    return false;
  }
  const pa = transferPeerKey(a);
  const pb = transferPeerKey(b);
  if (pa === null || pa !== pb) {
    return false;
  }
  return b.at - a.at <= ACTIVITY_ROLLUP_MS;
}

function fmtTransferLine(
  kind: 'block-sent' | 'block-received' | 'event-received',
  count: number,
  bytes: number,
  peerId: string,
  hashSample: string,
  at: number,
): string {
  const time = dim(fmtTime(at));
  const peer = peerId.slice(0, 8);
  const hash = hashSample.slice(0, 8);
  const size = bold(fmtBytes(bytes));
  const mult = count > 1 ? dim(` ×${count}`) : '';
  switch (kind) {
    case 'block-sent':
      return (
        time +
        '  ' + cyan('↑ blk') + mult +
        '  ' + hash +
        '  ' + dim('→ ') + peer +
        '  ' + size
      );
    case 'block-received':
      return (
        time +
        '  ' + green('↓ blk') + mult +
        '  ' + hash +
        '  ' + dim('← ') + peer +
        '  ' + size
      );
    case 'event-received':
      return (
        time +
        '  ' + yellow('⊕ evt') + mult +
        '  ' + hash +
        '  ' + dim('← ') + peer +
        '  ' + dim(size)
      );
  }
}

/**
 * Classify the transport label into a short, colour-coded "where from"
 * hint. The label itself is already authoritative; this is just a
 * human-friendly summary so the operator can answer at a glance:
 *
 *   local   — same machine: a sibling on this host (different process /
 *             dataDir / daemon). Detected by matching the remote IP
 *             against the local interface table — so a sibling that
 *             announces its LAN IP (192.168.x) instead of 127.x is
 *             still correctly marked local.
 *   LAN     — different machine on the same subnet, mDNS or mDNS-TCP.
 *   DHT     — Hyperswarm routed; transport could be UDX or TCP, the
 *             destination could be local or WAN — but typically WAN.
 *   ?       — fallback when the discovery layer did not tag the label.
 *
 * Note: a sibling on the same machine reached over the DHT (because
 * mDNS is blocked or both processes refuse mDNS) still classifies as
 * `DHT` — the route label answers "how did we get there", not "where
 * is the destination". For "is this peer local?", see the `local`
 * column directly.
 */
function classifyTransport(label: string): { route: string; tint: (s: string) => string } {
  const mdnsTcpIp = extractIpFromLabel(label, 'mdns-tcp:');
  if (mdnsTcpIp !== null) {
    return isLocalAddress(mdnsTcpIp)
      ? { route: 'local', tint: dim }
      : { route: 'LAN', tint: green };
  }
  if (label.startsWith('mdns:')) return { route: 'LAN', tint: green };
  if (label.startsWith('dht:') || label.startsWith('hyperswarm:')) {
    return { route: 'DHT', tint: cyan };
  }
  const tcpIp = extractIpFromLabel(label, 'tcp:');
  if (tcpIp !== null) {
    return isLocalAddress(tcpIp)
      ? { route: 'local', tint: dim }
      : { route: 'LAN', tint: green };
  }
  return { route: '?', tint: yellow };
}

/**
 * Returns true when the peer is co-located on this machine. The
 * detection mirrors `classifyTransport`'s `local` branch: an mDNS-TCP
 * peer whose IP matches a local interface, or a plain TCP peer at
 * 127.x. DHT-routed siblings on the same machine are *not* reported
 * as local from this function because their wire label carries no IP
 * to compare; if you want to detect those reliably, the peer's
 * `localAssociationProfile === remoteProfilePublicKey` (sibling) plus
 * a low ping is a heuristic.
 */
export function isPeerLocal(peer: ConnectedPeer): boolean {
  const parsed = parseHostPortFromLabel(peer.transportLabel);
  const ip =
    (parsed !== null && parsed.host !== 'unknown' ? parsed.host : null) ??
    extractIpFromLabel(peer.transportLabel, 'mdns-tcp:') ??
    extractIpFromLabel(peer.transportLabel, 'tcp:');
  if (ip === null) return false;
  return isLocalAddress(ip);
}

function shortHex(hex: string, n = 8): string {
  if (!hex) return dim('—'.padEnd(n));
  return hex.slice(0, n);
}

interface PeerRow {
  readonly role: 'sibling' | 'friend';
  readonly profile: string;
  readonly peerId: string;
  readonly instanceId: string;
  readonly route: string;
  readonly routeTint: (s: string) => string;
  readonly label: string;
  readonly age: string;
}

function toRow(peer: ConnectedPeer, now: number, wide = false): PeerRow {
  const { route, tint } = classifyTransport(peer.transportLabel);
  const instanceId =
    (peer as ConnectedPeer & { readonly remoteInstancePublicKey?: string })
      .remoteInstancePublicKey ?? '';
  return {
    role: peer.role,
    profile: wide ? peer.remoteProfilePublicKey : shortHex(peer.remoteProfilePublicKey),
    peerId: wide ? peer.remotePeerId : shortHex(peer.remotePeerId),
    instanceId: wide ? instanceId : shortHex(instanceId),
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
function renderPeerTableLines(rows: readonly PeerRow[], wide = false): string[] {
  if (rows.length === 0) {
    return [yellow('  (no peers connected)')];
  }
  const COL_NUM = 3;
  const COL_ROLE = 8;
  const COL_PROFILE = wide ? 66 : 10;
  const COL_PEERID = wide ? 34 : 10;
  const COL_INSTANCE = wide ? 132 : 10;
  const COL_ROUTE = 10;
  const COL_AGE = 6;
  const header =
    bold('#'.padEnd(COL_NUM)) +
    bold('Role'.padEnd(COL_ROLE)) +
    bold('Profile'.padEnd(COL_PROFILE)) +
    bold('PeerId'.padEnd(COL_PEERID)) +
    bold('Instance'.padEnd(COL_INSTANCE)) +
    bold('Route'.padEnd(COL_ROUTE)) +
    bold('Age'.padEnd(COL_AGE)) +
    bold('Endpoint');
  const sep = dim('─'.repeat(COL_NUM + COL_ROLE + COL_PROFILE + COL_PEERID + COL_INSTANCE + COL_ROUTE + COL_AGE + 24));
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
      r.instanceId.padEnd(COL_INSTANCE) +
      padThenTint(r.route, COL_ROUTE, r.routeTint) +
      r.age.padEnd(COL_AGE) +
      dim(formatTransportEndpoint(r.label))
    );
  });
  return [header, sep, ...body];
}

function renderPeerTable(rows: readonly PeerRow[], wide = false): string {
  return renderPeerTableLines(rows, wide).join('\n');
}

/**
 * Print this node's DISC-26/27 peer and instance identity plus sync
 * configuration. Use it to match either diagnostic id against the peer table.
 */
export async function cmdWhoami(ctx: Context): Promise<void> {
  const state = await readMonitorState(ctx);
  const sync = ctx.skeleton.sync;
  const profileName = ctx.config.activeProfile;

  console.log('');
  console.log(bold('Node identity') + '   ' + describeMode(state));
  console.log(dim('─'.repeat(60)));
  console.log(`  ${bold('dataDir:')}      ${ctx.config.dataDir}`);
  console.log(
    `  ${bold('instance:')}     ${state.localInstanceId !== '' ? cyan(state.localInstanceId) : dim('(none - no profile or unreadable sync/instance.json)')}`,
  );
  console.log(
    `  ${bold('peerId:')}       ${state.localPeerId !== '' ? cyan(state.localPeerId) : dim('(none - no profile or unreadable .nearbytes-node-id)')}`,
  );
  console.log(
    `  ${bold('profile:')}      ${profileName !== null ? green(profileName) : dim('(none)')}`,
  );
  console.log(
    `  ${bold('profilePk:')}    ${state.localActiveProfile !== '' ? state.localActiveProfile : dim('(none)')}`,
  );
  console.log(`  ${bold('served:')}       ${sync.serveProfilePublicKeys.length} profile(s)`);
  console.log(`  ${bold('friends:')}      ${sync.friends.length}`);
  if (state.mode !== 'local') {
    console.log('');
    console.log(
      dim(
        '  Network view (peers, events, throughput) comes from the daemon beacon — ' +
          'run `peers` or `monitor` to inspect remote peerIds and instances.',
      ),
    );
  } else {
    console.log('');
    console.log(
      dim(
        '  When a remote peer connects, its PeerId and Instance columns identify that machine. ' +
          'Match the first 8 hex chars against known ids.',
      ),
    );
  }
  console.log('');
}

/**
 * Tally peers by their classified route (`local`, `LAN`, `DHT`, `?`)
 * so the title-bar summary can answer the question the operator
 * usually has first — "are these blocks coming from another process
 * on this machine, or from the wider network?" — without forcing them
 * to scan the peer table.
 */
function countPeersByRoute(peers: readonly ConnectedPeer[]): {
  local: number;
  lan: number;
  dht: number;
  other: number;
} {
  let local = 0;
  let lan = 0;
  let dht = 0;
  let other = 0;
  for (const p of peers) {
    const route = classifyTransport(p.transportLabel).route;
    if (route === 'local') local += 1;
    else if (route === 'LAN') lan += 1;
    else if (route === 'DHT') dht += 1;
    else other += 1;
  }
  return { local, lan, dht, other };
}

function renderSummary(snap: SyncSnapshot, peers: readonly ConnectedPeer[]): string {
  const breakdown = countPeersByRoute(peers);
  /**
   * Only emit non-zero buckets. A connected peer with all four counts
   * at zero is impossible (every peer falls into exactly one bucket),
   * so suppressing zeroes keeps the line short when only one route is
   * active without losing information.
   */
  const parts: string[] = [];
  if (breakdown.local > 0) parts.push(dim(`${breakdown.local} local`));
  if (breakdown.lan > 0) parts.push(green(`${breakdown.lan} LAN`));
  if (breakdown.dht > 0) parts.push(cyan(`${breakdown.dht} DHT`));
  if (breakdown.other > 0) parts.push(yellow(`${breakdown.other} ?`));
  const breakdownStr = parts.length > 0 ? '  ' + dim('(') + parts.join(dim(' · ')) + dim(')') : '';
  return (
    bold('peers ') + String(peers.length).padStart(2) + breakdownStr + '  ' +
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
        '  ' + green('+ conn') +
        '  ' + roleStr +
        '  ' + e.remoteProfilePublicKey.slice(0, 8) +
        '  ' + cyan(formatTransportEndpoint(e.transportLabel))
      );
    }
    case 'peer-disconnected': {
      return (
        time +
        '  ' + red('− conn') +
        '  ' + dim('       ') +
        '  ' + e.remoteProfilePublicKey.slice(0, 8) +
        '  ' + dim(formatTransportEndpoint(e.transportLabel))
      );
    }
    case 'peer-connect-failed': {
      const who =
        e.remoteProfilePublicKey !== ''
          ? e.remoteProfilePublicKey.slice(0, 8)
          : dim('?');
      const tries = e.attempts > 1 ? dim(` ×${e.attempts}`) : '';
      return (
        time +
        '  ' + yellow('! fail') +
        '  ' + dim(e.reason) +
        tries +
        '  ' + who +
        '  ' + yellow(formatTransportEndpoint(e.transportLabel))
      );
    }
    case 'block-sent':
      return fmtTransferLine(
        'block-sent',
        1,
        e.bytes,
        e.toPeerId,
        e.blockHash,
        e.at,
      );
    case 'block-received':
      return fmtTransferLine(
        'block-received',
        1,
        e.bytes,
        e.fromPeerId,
        e.blockHash,
        e.at,
      );
    case 'event-received':
      return fmtTransferLine(
        'event-received',
        1,
        e.bytes,
        e.fromPeerId,
        e.eventHash,
        e.at,
      );
  }
}

/**
 * Collapse bursty block/event lines (same peer, same direction, within
 * 1 s) so a sync storm reads as one row instead of fifty.
 */
function buildActivityLines(events: readonly SyncEvent[]): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < events.length) {
    const e = events[i]!;
    if (
      e.kind === 'block-sent' ||
      e.kind === 'block-received' ||
      e.kind === 'event-received'
    ) {
      const group: SyncEvent[] = [e];
      i++;
      while (i < events.length && canRollupTransfer(e, events[i]!)) {
        group.push(events[i]!);
        i++;
      }
      const first = group[0]!;
      const last = group[group.length - 1]!;
      const bytes = group.reduce((s, ev) => {
        if (
          ev.kind === 'block-sent' ||
          ev.kind === 'block-received' ||
          ev.kind === 'event-received'
        ) {
          return s + ev.bytes;
        }
        return s;
      }, 0);
      const peer = transferPeerKey(first) ?? '';
      const hash =
        last.kind === 'event-received'
          ? last.eventHash
          : last.kind === 'block-sent' || last.kind === 'block-received'
            ? last.blockHash
            : '';
      lines.push(
        fmtTransferLine(
          first.kind as 'block-sent' | 'block-received' | 'event-received',
          group.length,
          bytes,
          peer,
          hash,
          last.at,
        ),
      );
      continue;
    }
    lines.push(fmtEvent(e));
    i++;
  }
  return lines;
}

/**
 * Render the most-recent `maxRows` events as a `string[]` of lines,
 * newest at the bottom (the natural reading order — your eye lands on
 * the latest activity). An empty buffer renders a single placeholder
 * line so the panel never collapses to zero height between transfers.
 */
function renderEventLogLines(events: readonly SyncEvent[], maxRows: number): string[] {
  if (events.length === 0) {
    return [
      dim('  (no activity yet — peer connects, block sync, and file events appear here)'),
    ];
  }
  const lines = buildActivityLines(events);
  const start = Math.max(0, lines.length - maxRows);
  return lines.slice(start).map((line) => '  ' + line);
}

function renderEventLog(events: readonly SyncEvent[], maxRows: number): string {
  return renderEventLogLines(events, maxRows).join('\n');
}

// ── monitor state source ──────────────────────────────────────────────────

interface MonitorState {
  readonly snapshot: SyncSnapshot;
  readonly peers: readonly ConnectedPeer[];
  /**
   * This node's DISC-26 identity and active profile, as seen by the
   * process that owns the sync engine (LIVE) or published by the daemon
   * beacon (DAEMON). In writer-only / beacon-missing modes we fall
   * back to the on-disk node id + configured profile intent.
   */
  readonly localPeerId: string;
  readonly localInstanceId: string;
  readonly localActiveProfile: string;
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
  const syncWithInstance = sync as typeof sync & { readonly instancePublicKey?: string };
  const daemon = (sync as { daemon?: { holderPid: number; lockPath: string } }).daemon;
  if (daemon === undefined) {
    return {
      snapshot: sync.snapshot(),
      peers: sync.peers(),
      events: sync.recentEvents(),
      stats: sync.stats(),
      localPeerId: sync.peerId,
      localInstanceId: syncWithInstance.instancePublicKey ?? '',
      localActiveProfile: sync.activeProfilePublicKey,
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
      localPeerId: sync.peerId,
      localInstanceId: syncWithInstance.instancePublicKey ?? '',
      localActiveProfile: sync.activeProfilePublicKey,
      mode: 'beacon-missing',
      beaconPid: daemon.holderPid,
    };
  }
  const peers: ConnectedPeer[] = beacon.payload.peers.map((p) => ({
    remoteProfilePublicKey: p.remoteProfilePublicKey,
    remoteInstancePublicKey:
      (p as typeof p & { readonly remoteInstancePublicKey?: string }).remoteInstancePublicKey ?? '',
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
    localPeerId: beacon.payload.peerId ?? sync.peerId,
    localInstanceId:
      (beacon.payload as typeof beacon.payload & { readonly instancePublicKey?: string })
        .instancePublicKey ??
      syncWithInstance.instancePublicKey ??
      '',
    localActiveProfile: beacon.payload.activeProfilePublicKey ?? sync.activeProfilePublicKey,
    mode,
    beaconAgeMs: beacon.ageMs,
    beaconPid: beacon.payload.pid,
  };
}

/**
 * One-line summary of *this* instance's wire identity so the operator can
 * map peer-table rows to known machines without opening `sync/instance.json`.
 */
function renderLocalIdentityLine(state: MonitorState, compact = false): string {
  if (state.localPeerId === '' && state.localInstanceId === '' && state.localActiveProfile === '') {
    return dim('  me (no profile — use `profile add` first)');
  }
  const parts: string[] = [];
  if (state.localPeerId !== '') {
    const peerShown = compact ? state.localPeerId.slice(0, 8) : state.localPeerId;
    parts.push(bold('peer=') + cyan(peerShown));
  }
  if (state.localInstanceId !== '') {
    const instanceShown = compact ? state.localInstanceId.slice(0, 8) : state.localInstanceId;
    parts.push(bold('inst=') + cyan(instanceShown));
  }
  if (state.localActiveProfile !== '') {
    const pkShown = compact
      ? state.localActiveProfile.slice(0, 8) + '…'
      : state.localActiveProfile;
    parts.push(bold('profile=') + yellow(pkShown));
  }
  return dim('  me ') + parts.join(dim(' · '));
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
export interface PeersCommandOptions {
  /** Show full peer ids, instance public keys, and profile keys in the peer table. */
  readonly wide?: boolean;
}

export async function cmdPeers(ctx: Context, opts: PeersCommandOptions = {}): Promise<void> {
  const wide = opts.wide === true;
  const state = await readMonitorState(ctx);
  const now = Date.now();

  console.log('');
  console.log(bold('Sync state') + '   ' + describeMode(state));
  console.log(dim('─'.repeat(60)));
  console.log(renderLocalIdentityLine(state));
  console.log('  ' + renderSummary(state.snapshot, state.peers));
  console.log(renderThroughputRow(state.stats));
  console.log('');
  console.log(bold('Connected peers'));
  console.log(dim('─'.repeat(60)));
  const rows = state.peers.map((p) => toRow(p, now, wide));
  console.log(renderPeerTable(rows, wide));
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
  const rows = state.peers.map((p) => toRow(p, now, false));

  const title =
    bold(' Nearbytes monitor ') +
    dim('─ ') +
    describeMode(state) +
    dim(' ─ ') +
    renderSummary(state.snapshot, state.peers) +
    dim(' ─ ') +
    dim(new Date().toLocaleTimeString());
  const visibleLen = (title.match(/[^\x1b]/g) || []).length;
  const trail = dim(' ' + '─'.repeat(Math.max(0, cols - visibleLen - 1)));

  const lines: string[] = [];
  lines.push(title + trail);
  lines.push(renderLocalIdentityLine(state, true));
  lines.push(renderThroughputRow(state.stats));

  // Peer table (cap so the events region keeps at least 3 rows).
  const PEER_TABLE_OVERHEAD = 2; // header + separator
  const ACTIVITY_OVERHEAD = 3; // blank + subhead + separator
  const MIN_EVENT_ROWS = 3;
  const peerBudget = Math.max(
    0,
    height - 3 /* title + identity + throughput */ - PEER_TABLE_OVERHEAD - ACTIVITY_OVERHEAD - MIN_EVENT_ROWS,
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
  return Math.max(14, Math.min(22, ideal));
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
