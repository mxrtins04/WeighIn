import { DiffResult, FunctionDiff, MetricDiff, MetricKey, METRIC_KEYS } from './diff';
import { Violation } from './threshold';

// Human-readable labels for the 11 metrics
const METRIC_LABELS: Record<MetricKey, string> = {
  cpu_instructions:           'CPU Instructions',
  memory_bytes:               'Memory Bytes',
  ledger_read_entries:        'Ledger Read Entries',
  ledger_read_bytes:          'Ledger Read Bytes',
  ledger_write_entries:       'Ledger Write Entries',
  ledger_write_bytes:         'Ledger Write Bytes',
  historical_data_read_bytes: 'Historical Read Bytes',
  contract_data_hard_limit:   'Contract Data (instance)',
  tx_size_bytes:              'Tx Size Bytes',
  events_count:               'Events Count',
  event_data_bytes:           'Event Data Bytes',
};

// Format a numeric value with thousands separators
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

// Format a delta with sign
function fmtDelta(delta: number): string {
  if (delta === 0) return '±0';
  return delta > 0 ? `+${fmt(delta)}` : fmt(delta);
}

// Format a percentage change
function fmtPct(pct: number | null): string {
  if (pct === null) return 'new';
  if (pct === 0) return '—';
  return pct > 0 ? `+${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
}

// Trend emoji: regression, improvement, or unchanged
function trend(delta: number): string {
  if (delta > 0) return '🔴';
  if (delta < 0) return '🟢';
  return '⚪';
}

function renderFunctionTable(fn: FunctionDiff): string {
  const rows = fn.metrics.map((m) => {
    const t = trend(m.delta);
    const label = METRIC_LABELS[m.key];
    const base = fmt(m.base.consumed);
    const head = fmt(m.head.consumed);
    const delta = fmtDelta(m.delta);
    const pct = fmtPct(m.pct);
    const limit = fmt(m.head.limit);
    return `| ${t} | ${label} | ${base} | ${head} | ${delta} | ${pct} | ${limit} |`;
  });

  return [
    `#### \`${fn.function_name}\``,
    '',
    '| | Metric | Base | Head | Delta | Change | Limit |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * Build a complete markdown body for a PR comment.
 */
export function renderComment(
  diff: DiffResult,
  violations: Violation[],
  baseRef: string,
  headSha: string
): string {
  const lines: string[] = [];

  // Header
  const statusEmoji = violations.length > 0 ? '🔴' : '🟢';
  const statusText = violations.length > 0
    ? `**${violations.length} threshold violation${violations.length > 1 ? 's' : ''}**`
    : '**All thresholds passed**';
  lines.push(`## ${statusEmoji} WeighIn Benchmark Report`);
  lines.push('');
  lines.push(`${statusText} — comparing \`${baseRef}\` → \`${headSha.slice(0, 8)}\``);
  lines.push('');

  // Violations block
  if (violations.length > 0) {
    lines.push('### ❌ Violations');
    lines.push('');
    for (const v of violations) {
      lines.push(`- **\`${v.function_name}\` / ${METRIC_LABELS[v.metric]}**: ${v.message}`);
    }
    lines.push('');
  }

  // New / removed contracts
  if (diff.newContracts.length > 0) {
    lines.push(`> **New contracts** (no baseline): ${diff.newContracts.map((c) => `\`${c}\``).join(', ')}`);
    lines.push('');
  }
  if (diff.removedContracts.length > 0) {
    lines.push(`> **Removed contracts**: ${diff.removedContracts.map((c) => `\`${c}\``).join(', ')}`);
    lines.push('');
  }

  // Per-contract sections
  for (const contract of diff.contracts) {
    lines.push(`### Contract \`${contract.contract_id}\``);
    lines.push('');

    if (contract.newFunctions.length > 0) {
      lines.push(`> New functions (no baseline): ${contract.newFunctions.map((f) => `\`${f}\``).join(', ')}`);
      lines.push('');
    }
    if (contract.removedFunctions.length > 0) {
      lines.push(`> Removed functions: ${contract.removedFunctions.map((f) => `\`${f}\``).join(', ')}`);
      lines.push('');
    }

    for (const fn of contract.functions) {
      lines.push(renderFunctionTable(fn));
      lines.push('');
    }
  }

  // Known limitations footer
  lines.push('---');
  lines.push('');
  lines.push('<details><summary>Known measurement gaps</summary>');
  lines.push('');
  lines.push('- **Historical Read Bytes**: Soroban protocol 25 does not expose a transaction-level');
  lines.push('  size limit for historical reads in the config settings; this metric is tracked as 0.');
  lines.push('- **WASM build determinism**: cross-CI-run hash equality has not yet been verified');
  lines.push('  in two separate GitHub Actions runs. Treat diff values as approximate until confirmed.');
  lines.push('');
  lines.push('</details>');
  lines.push('');
  lines.push(`<!-- weighin-report -->`);

  return lines.join('\n');
}
