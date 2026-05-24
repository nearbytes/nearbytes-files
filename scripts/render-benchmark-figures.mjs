#!/usr/bin/env node
/**
 * Render LaTeX fragments for the paper from bench-report.json
 *
 *   node scripts/render-benchmark-figures.mjs --report bench-report.json --outdir ../paper-nearbytes-hypercore/figures
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function esc(s) {
  return String(s)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/[&%$#_{}]/g, (c) => `\\${c}`)
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function fmtMs(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '---';
  const n = Number(v);
  if (n < 0) return '---';
  return n >= 1000 ? `${(n / 1000).toFixed(2)}\\,s` : `${Math.round(n)}\\,ms`;
}

function fmtMbps(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '---';
  return `${Number(v).toFixed(1)}`;
}

const reportPath = arg('--report', 'bench-report.json');
const outDir = arg('--outdir', path.join(process.cwd(), '.local/bench/reports/tex'));
const report = JSON.parse(await readFile(reportPath, 'utf-8'));

await mkdir(outDir, { recursive: true });

const topology = esc(report.topology ?? 'two peers');
function tableFromMerged(report) {
  const bySize = new Map();
  for (const t of report.mergedTrials ?? []) {
    const v = t.oneWayLatencyMs ?? t.syncLatencyMs ?? t.listLatencyMs;
    if (v === null || v === undefined || !Number.isFinite(v) || v < 0) continue;
    if (!bySize.has(t.sizeBytes)) bySize.set(t.sizeBytes, []);
    bySize.get(t.sizeBytes).push(v);
  }
  const stats = (values) => {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (v.length === 0) return null;
    const sum = v.reduce((a, b) => a + b, 0);
    const p = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
    return { n: v.length, min: v[0], p50: p(50), p95: p(95), max: v[v.length - 1], mean: sum / v.length };
  };
  return [...bySize.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([sizeBytes, values]) => {
      const s = stats(values);
      return {
        sizeBytes,
        sizeLabel:
          sizeBytes >= 1024 * 1024
            ? `${sizeBytes / (1024 * 1024)} MiB`
            : `${sizeBytes / 1024} KiB`,
        ...s,
      };
    })
    .filter((r) => r.n > 0);
}

const latencySource =
  (report.syncLatencyTable?.length ?? 0) > 0
    ? report.syncLatencyTable
    : (report.latencyTable?.length ?? 0) > 0
      ? report.latencyTable
      : tableFromMerged(report);

function fmtCi(r) {
  if (
    r.ci95Low === null ||
    r.ci95Low === undefined ||
    r.ci95High === null ||
    r.ci95High === undefined
  ) {
    return '---';
  }
  const lo = Math.max(0, r.ci95Low);
  const hi = r.ci95High;
  if (hi - lo < 1) return `$${Math.round(r.mean)}$`;
  return `$${Math.round(lo)}$--$${Math.round(hi)}$`;
}

const hasCi = latencySource.some((r) => r.ci95Low !== undefined && r.n > 1);
const latencyRows = latencySource
  .map((r) =>
    hasCi
      ? `${esc(r.sizeLabel)} & ${r.n ?? 0} & ${fmtMs(r.p50)} & ${fmtMs(r.p95)} & ${fmtCi(r)} \\\\`
      : `${esc(r.sizeLabel)} & ${r.n ?? 0} & ${fmtMs(r.p50)} & ${fmtMs(r.p95)} & ${fmtMs(r.mean)} \\\\`,
  )
  .join('\n');

const latencyCaption =
  report.profile === 'bidirectional-1mib'
    ? `Bidirectional friend carriage (Implementation~0): encrypted ${esc(topology)}. One-way receive latency is wall-clock from peer \\texttt{addFile} to local \\texttt{listFiles} ($n$ per direction).`
    : report.profile === 'paper'
      ? `One-way convergence latency (${esc(topology)}, \\textbf{paper profile}): encrypted payloads after \\texttt{friend-session-attached}; $n$ repeats per size (warmup discarded). Metric: sender \\texttt{file-published} to receiver first \\texttt{inbound-stored} block. Last column: 95\\% CI of the mean when $n{>}1$.`
      : `One-way convergence latency (${esc(topology)}) for friend carriage v0 after friend-session formation. Payloads are encrypted volume files; metric uses first \\texttt{inbound-stored} block when available.`;

const ciCol = hasCi ? '95\\% CI (mean)' : 'mean';
const resultsTable = `% Auto-generated — nearbytes-files/scripts/render-benchmark-figures.mjs
% Requires: \\usepackage{booktabs}
\\begin{table}[t]
\\centering
\\caption{${latencyCaption}}
\\label{tab:bench-latency}
\\small
\\setlength{\\tabcolsep}{3pt}
\\begin{tabular}{@{}lrrrr@{}}
\\toprule
Payload & $n$ & $p_{50}$ & $p_{95}$ & ${ciCol} \\\\
\\midrule
${latencyRows || '--- & 0 & --- & --- & --- \\\\'}
\\bottomrule
\\end{tabular}
\\end{table}
`;

function phaseRow(label, p) {
  if (!p) return `${esc(label)} & --- & --- & --- \\\\`;
  return `${esc(label)} & ${fmtMs(p.bootMs)} & ${fmtMs(p.friendSessionMs)} & ${fmtMs(p.totalWallMs)} \\\\`;
}

const alicePhases = report.phases?.alice;
const bobPhases = report.phases?.bob;
const senderPhases = report.phases?.sender ?? alicePhases;
const receiverPhases = report.phases?.receiver ?? bobPhases;

const phasesTable = `% Auto-generated phase breakdown (wall clock per process)
\\begin{table}[t]
\\centering
\\caption{Measured wall-clock phases (${esc(topology)}). \\emph{Boot} is config + skeleton + sync start; \\emph{Friend session} is until \\texttt{friend-session-attached} (handshake + mDNS/Hyperswarm); \\emph{Total} includes publish/receive/grace for the benchmark driver.}
\\label{tab:bench-phases}
\\small
\\setlength{\\tabcolsep}{5pt}
\\begin{tabular}{@{}lrrr@{}}
\\toprule
Node & Boot & Friend session & Total \\\\
\\midrule
${senderPhases ? phaseRow('Alice / sender', senderPhases) : ''}
${receiverPhases ? phaseRow('Bob / receiver', receiverPhases) : ''}
\\bottomrule
\\end{tabular}
\\end{table}
`;

const swarmAlice = report.swarmFormation?.senderMs ?? '---';
const swarmBob = report.swarmFormation?.receiverMs ?? '---';
const goodput = report.throughput?.receiverGoodputMbps;
const nominalMb =
  report.throughput?.nominalBytes != null
    ? `${(report.throughput.nominalBytes / (1024 * 1024)).toFixed(0)}\\,MiB`
    : '---';
const inboundDur = fmtMs(report.throughput?.inboundDurationMs);

const goodputTable = `% Auto-generated throughput summary
\\begin{table}[t]
\\centering
\\caption{Friend-session formation and sustained goodput (${esc(topology)}). Goodput $=8\\times$nominal payload / $(t_{\\mathrm{last}}-t_{\\mathrm{first}})$ over receiver \\texttt{inbound-stored} blocks between \\texttt{throughput-phase-start/end} (includes encryption and framing).}
\\label{tab:bench-goodput}
\\small
\\begin{tabular}{@{}lr@{}}
\\toprule
Metric & Value \\\\
\\midrule
Friend session (Alice) & ${typeof swarmAlice === 'number' ? fmtMs(swarmAlice) : '---'} \\\\
Friend session (Bob) & ${typeof swarmBob === 'number' ? fmtMs(swarmBob) : '---'} \\\\
Throughput payload & ${nominalMb} \\\\
Inbound transfer span & ${inboundDur} \\\\
Receiver goodput & ${fmtMbps(goodput)}\\,Mb/s \\\\
\\bottomrule
\\end{tabular}
\\end{table}
`;

const mscFigure = `% Auto-generated MSC-style collaboration diagram
\\begin{figure}[t]
\\centering
\\begin{tikzpicture}[font=\\small, node distance=0.55cm and 3.0cm]
  \\node[draw, rounded corners, minimum width=2.4cm] (alice) {Alice};
  \\node[draw, rounded corners, minimum width=2.4cm, right=of alice] (bob) {Bob};
  \\node[draw, rounded corners, minimum width=2.0cm, below=0.85cm of alice] (lan) {mDNS + DHT};
  \\draw[dashed,->] (alice) -- node[above,sloped,font=\\footnotesize]{\\topic(profile)} (lan);
  \\draw[dashed,->] (bob) -- node[above,sloped,font=\\footnotesize]{\\topic(profile)} (lan);
  \\draw[->] (lan) -- node[left,font=\\footnotesize]{duplex} (alice);
  \\draw[->] (lan) -- node[right,font=\\footnotesize]{duplex} (bob);
  \\node[below=0.12cm of alice,font=\\footnotesize] {$+${swarmAlice}\\,ms};
  \\node[below=0.12cm of bob,font=\\footnotesize] {$+${swarmBob}\\,ms};
\\end{tikzpicture}
\\caption{Collaboration timeline (${esc(topology)}). Both nodes publish profile records, complete \\texttt{hello}, then reactive \\texttt{have}/\\texttt{want} on \\texttt{nearbytes.sync.v1} (no timer-driven delta polling).}
\\label{fig:bench-msc}
\\end{figure}
`;

const masterTable = `% Auto-generated — include in paper preamble: \\usepackage{booktabs}
\\input{benchmark-phases-table.tex}
\\input{benchmark-latency-table.tex}
\\input{benchmark-goodput-table.tex}
`;

await writeFile(path.join(outDir, 'benchmark-latency-table.tex'), resultsTable);
await writeFile(path.join(outDir, 'benchmark-phases-table.tex'), phasesTable);
await writeFile(path.join(outDir, 'benchmark-goodput-table.tex'), goodputTable);
await writeFile(path.join(outDir, 'benchmark-msc.tex'), mscFigure);
await writeFile(path.join(outDir, 'benchmark-tables.tex'), masterTable);

const summaryTex = `% Auto-generated benchmark summary (${esc(report.generatedAt?.slice(0, 10) ?? '')})
\\paragraph{Harness results (${esc(topology)}).}
Friend session formation: $+${swarmAlice}$ (Alice) and $+${swarmBob}$ (Bob). Receiver goodput ${fmtMbps(goodput)}\\,Mb/s. See Tables~\\ref{tab:bench-phases}--\\ref{tab:bench-goodput} and Figure~\\ref{fig:bench-msc}.
`;
await writeFile(path.join(outDir, 'benchmark-summary.tex'), summaryTex);

console.log(`Wrote LaTeX to ${outDir}`);
console.log('  benchmark-latency-table.tex  (Table~\\ref{tab:bench-latency})');
console.log('  benchmark-phases-table.tex   (Table~\\ref{tab:bench-phases})');
console.log('  benchmark-goodput-table.tex    (Table~\\ref{tab:bench-goodput})');
console.log('  benchmark-msc.tex            (Figure~\\ref{fig:bench-msc})');
console.log('  benchmark-tables.tex         (\\input{} all tables)');
