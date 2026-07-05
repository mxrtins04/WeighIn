import { ContractBenchmark, BenchmarkResult, Metrics, MetricValue } from './measurement';

// All 11 metric keys in display order
export const METRIC_KEYS = [
  'cpu_instructions',
  'memory_bytes',
  'ledger_read_entries',
  'ledger_read_bytes',
  'ledger_write_entries',
  'ledger_write_bytes',
  'historical_data_read_bytes',
  'contract_data_hard_limit',
  'tx_size_bytes',
  'events_count',
  'event_data_bytes',
] as const;

export type MetricKey = typeof METRIC_KEYS[number];

export interface MetricDiff {
  key: MetricKey;
  base: MetricValue;
  head: MetricValue;
  /** Absolute change: head.consumed - base.consumed */
  delta: number;
  /** Percentage change relative to base.consumed, or null when base.consumed === 0 */
  pct: number | null;
  /** True if head.consumed > base.consumed */
  regression: boolean;
}

export interface FunctionDiff {
  function_name: string;
  metrics: MetricDiff[];
  /** True if any metric regressed */
  hasRegression: boolean;
}

export interface ContractDiff {
  contract_id: string;
  base_commit: string;
  head_commit: string;
  functions: FunctionDiff[];
  /** True if any function in this contract has a regression */
  hasRegression: boolean;
  /** Functions present in head but missing from base (new functions) */
  newFunctions: string[];
  /** Functions present in base but missing from head (removed functions) */
  removedFunctions: string[];
}

export interface DiffResult {
  contracts: ContractDiff[];
  /** True if any contract has a regression */
  hasRegression: boolean;
  /** Contracts present in head but not base */
  newContracts: string[];
  /** Contracts present in base but not head */
  removedContracts: string[];
}

function diffMetrics(base: Metrics, head: Metrics): MetricDiff[] {
  return METRIC_KEYS.map((key) => {
    const b = base[key];
    const h = head[key];
    const delta = h.consumed - b.consumed;
    const pct = b.consumed === 0 ? null : (delta / b.consumed) * 100;
    return {
      key,
      base: b,
      head: h,
      delta,
      pct,
      regression: delta > 0,
    };
  });
}

function diffFunctions(
  baseFns: BenchmarkResult[],
  headFns: BenchmarkResult[]
): { functions: FunctionDiff[]; newFunctions: string[]; removedFunctions: string[] } {
  const baseMap = new Map(baseFns.map((f) => [f.function_name, f]));
  const headMap = new Map(headFns.map((f) => [f.function_name, f]));

  const newFunctions: string[] = [];
  const removedFunctions: string[] = [];
  const functions: FunctionDiff[] = [];

  for (const name of headMap.keys()) {
    if (!baseMap.has(name)) newFunctions.push(name);
  }
  for (const name of baseMap.keys()) {
    if (!headMap.has(name)) removedFunctions.push(name);
  }

  // Diff only functions present in both
  for (const [name, headFn] of headMap) {
    const baseFn = baseMap.get(name);
    if (!baseFn) continue;

    const metrics = diffMetrics(baseFn.metrics, headFn.metrics);
    const hasRegression = metrics.some((m) => m.regression);
    functions.push({ function_name: name, metrics, hasRegression });
  }

  return { functions, newFunctions, removedFunctions };
}

/**
 * Compute a structural diff between a base and head measurement run.
 *
 * Contracts are matched by contract_id. Functions within each contract are
 * matched by function_name. New/removed contracts and functions are tracked
 * but do not count as regressions on their own.
 */
export function diffBenchmarks(
  base: ContractBenchmark[],
  head: ContractBenchmark[]
): DiffResult {
  const baseMap = new Map(base.map((c) => [c.contract_id, c]));
  const headMap = new Map(head.map((c) => [c.contract_id, c]));

  const newContracts: string[] = [];
  const removedContracts: string[] = [];
  const contracts: ContractDiff[] = [];

  for (const id of headMap.keys()) {
    if (!baseMap.has(id)) newContracts.push(id);
  }
  for (const id of baseMap.keys()) {
    if (!headMap.has(id)) removedContracts.push(id);
  }

  for (const [id, headContract] of headMap) {
    const baseContract = baseMap.get(id);
    if (!baseContract) continue;

    const { functions, newFunctions, removedFunctions } = diffFunctions(
      baseContract.benchmarks,
      headContract.benchmarks
    );
    const hasRegression = functions.some((f) => f.hasRegression);

    contracts.push({
      contract_id: id,
      base_commit: baseContract.git_commit,
      head_commit: headContract.git_commit,
      functions,
      hasRegression,
      newFunctions,
      removedFunctions,
    });
  }

  return {
    contracts,
    hasRegression: contracts.some((c) => c.hasRegression),
    newContracts,
    removedContracts,
  };
}
