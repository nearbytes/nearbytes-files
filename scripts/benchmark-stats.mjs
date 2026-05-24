/**
 * Shared statistics for benchmark merge + LaTeX render.
 */

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Student-t multiplier for 95% two-sided CI (small n). */
const T95 = {
  1: 12.706,
  2: 4.303,
  3: 3.182,
  4: 2.776,
  5: 2.571,
  6: 2.447,
  7: 2.365,
  8: 2.306,
  9: 2.262,
  10: 2.228,
  15: 2.131,
  20: 2.086,
  30: 2.042,
};

function tMultiplier(n) {
  if (n <= 0) return 1.96;
  if (n >= 30) return 2.042;
  return T95[n] ?? 2.0;
}

export function stats(values) {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const sum = v.reduce((a, b) => a + b, 0);
  const mean = sum / v.length;
  const variance =
    v.length > 1
      ? v.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (v.length - 1)
      : 0;
  const stddev = Math.sqrt(variance);
  const margin = tMultiplier(v.length) * (stddev / Math.sqrt(v.length));
  return {
    n: v.length,
    min: v[0],
    p50: percentile(v, 50),
    p95: percentile(v, 95),
    max: v[v.length - 1],
    mean,
    stddev,
    ci95Low: mean - margin,
    ci95High: mean + margin,
  };
}

export function sizeLabel(sizeBytes) {
  if (sizeBytes >= 1024 * 1024) return `${sizeBytes / (1024 * 1024)} MiB`;
  return `${sizeBytes / 1024} KiB`;
}

export function parseBenchActivityLines(activityLog) {
  const events = [];
  for (const line of activityLog ?? []) {
    if (!line.startsWith('bench ')) continue;
    try {
      events.push(JSON.parse(line.slice(6)));
    } catch {
      /* skip */
    }
  }
  return events.sort((a, b) => a.t - b.t);
}

/** Goodput from receiver inbound-stored blocks after sender throughput-phase-start. */
export function goodputFromInboundMarkers(receiverLog, payloadBytes, senderLog = [], sinceWallMs) {
  const phaseEvents = parseBenchActivityLines(senderLog.length ? senderLog : receiverLog);
  const start = phaseEvents.find((e) => e.bench === 'throughput-phase-start');
  const t0 = start?.t ?? sinceWallMs;
  if (t0 === undefined) return null;
  const minBlockBytes =
    payloadBytes > 16 * 1024 * 1024
      ? 1024 * 1024
      : payloadBytes > 0
        ? Math.max(4096, Math.floor(payloadBytes / 16))
        : 4096;

  const events = parseBenchActivityLines(receiverLog);
  const blocks = events.filter(
    (e) =>
      e.bench === 'inbound-stored' &&
      e.kind === 'block' &&
      e.t >= t0 &&
      Number(e.bytes) >= minBlockBytes,
  );
  if (blocks.length === 0) return null;

  const first = blocks[0].t;
  const last = blocks[blocks.length - 1].t;
  const durationMs =
    blocks.length === 1 ? Math.max(1, last - t0) : Math.max(1, last - first);

  const bytesReceived = blocks.reduce((s, b) => s + (Number(b.bytes) || 0), 0);
  const effectiveBytes =
    payloadBytes > 0 ? Math.min(payloadBytes, bytesReceived) : bytesReceived;
  const goodputMbps = (effectiveBytes * 8) / (durationMs * 1000);
  return {
    goodputMbps,
    durationMs,
    bytesReceived,
    nominalBytes: payloadBytes > 0 ? payloadBytes : bytesReceived,
    firstInboundMs: first,
    lastInboundMs: last,
    blockCount: blocks.length,
  };
}

export function isWarmupTrialName(name) {
  return typeof name === 'string' && name.includes('-warm-');
}
