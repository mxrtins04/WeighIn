import * as fs from 'fs';
import * as TOML from 'toml';
import { DiffResult, FunctionDiff, MetricDiff, MetricKey } from './diff';

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

/**
 * A rule value is either a named policy string or a numeric percentage cap.
 *
 * Named policies:
 *   "strict_zero_tolerance"     — any increase fails
 *   "allow_N_percent_increase"  — N% increase allowed (e.g. "allow_10_percent_increase")
 *   "ignore"                    — never fail on this metric
 */
export type RuleValue = string | number;

export interface GlobalThresholds {
  /** If true, any metric increase (even 1 unit) fails. Default false. */
  fail_on_any_regression?: boolean;
  /** Maximum allowed CPU increase as a percentage. */
  max_allowed_cpu_increase_pct?: number;
  /** Maximum allowed memory increase as a percentage. */
  max_allowed_memory_increase_pct?: number;
}

export interface WeighinConfig {
  thresholds?: {
    global?: GlobalThresholds;
    /** Per-function overrides keyed by function name */
    functions?: Record<string, Partial<Record<MetricKey, RuleValue>>>;
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and parse weighin.toml. Returns null if the file does not exist
 * (no thresholds enforced). Throws on parse errors.
 */
export function loadConfig(configPath: string): WeighinConfig | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  return TOML.parse(raw) as WeighinConfig;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

export interface Violation {
  contract_id: string;
  function_name: string;
  metric: MetricKey;
  delta: number;
  pct: number | null;
  rule: string;
  message: string;
}

function parseAllowPct(rule: string): number | null {
  // Matches "allow_10_percent_increase", "allow_2.5_percent_increase", etc.
  const m = rule.match(/^allow_([\d.]+)_percent_increase$/);
  return m ? parseFloat(m[1]) : null;
}

function evaluateRule(
  rule: RuleValue,
  diff: MetricDiff,
  contractId: string,
  functionName: string
): Violation | null {
  if (!diff.regression) return null; // No increase → never a violation

  const ruleStr = typeof rule === 'number' ? `allow_${rule}_percent_increase` : rule;

  if (ruleStr === 'ignore') return null;

  if (ruleStr === 'strict_zero_tolerance') {
    return {
      contract_id: contractId,
      function_name: functionName,
      metric: diff.key,
      delta: diff.delta,
      pct: diff.pct,
      rule: ruleStr,
      message: `${diff.key} increased by ${diff.delta} (strict zero tolerance)`,
    };
  }

  const allowedPct = parseAllowPct(ruleStr);
  if (allowedPct !== null) {
    if (diff.pct === null || diff.pct > allowedPct) {
      const pctStr = diff.pct === null ? 'Infinity' : diff.pct.toFixed(2);
      return {
        contract_id: contractId,
        function_name: functionName,
        metric: diff.key,
        delta: diff.delta,
        pct: diff.pct,
        rule: ruleStr,
        message: `${diff.key} increased by ${pctStr}% (limit ${allowedPct}%)`,
      };
    }
    return null;
  }

  // Unknown rule string — warn but don't fail
  console.warn(`[weighin] Unknown threshold rule "${ruleStr}" for ${diff.key}, ignoring.`);
  return null;
}

// Map from global threshold fields to metric keys + default rules
const GLOBAL_RULE_MAP: Array<{
  field: keyof GlobalThresholds;
  metric: MetricKey;
  toRule: (val: number) => RuleValue;
}> = [
  {
    field: 'max_allowed_cpu_increase_pct',
    metric: 'cpu_instructions',
    toRule: (v) => `allow_${v}_percent_increase`,
  },
  {
    field: 'max_allowed_memory_increase_pct',
    metric: 'memory_bytes',
    toRule: (v) => `allow_${v}_percent_increase`,
  },
];

/**
 * Enforce all threshold rules against a DiffResult.
 * Returns the list of violations (empty = pass).
 */
export function enforceThresholds(
  diff: DiffResult,
  config: WeighinConfig | null
): Violation[] {
  if (!config?.thresholds) return [];

  const global = config.thresholds.global ?? {};
  const perFunction = config.thresholds.functions ?? {};
  const violations: Violation[] = [];

  for (const contract of diff.contracts) {
    for (const fn of contract.functions) {
      for (const metricDiff of fn.metrics) {
        // 1. Per-function overrides take priority over global rules
        const fnOverrides = perFunction[fn.function_name];
        const fnRule = fnOverrides?.[metricDiff.key];
        if (fnRule !== undefined) {
          const v = evaluateRule(fnRule, metricDiff, contract.contract_id, fn.function_name);
          if (v) violations.push(v);
          continue;
        }

        // 2. Global fail_on_any_regression
        if (global.fail_on_any_regression && metricDiff.regression) {
          violations.push({
            contract_id: contract.contract_id,
            function_name: fn.function_name,
            metric: metricDiff.key,
            delta: metricDiff.delta,
            pct: metricDiff.pct,
            rule: 'fail_on_any_regression',
            message: `${metricDiff.key} increased by ${metricDiff.delta} (fail_on_any_regression)`,
          });
          continue;
        }

        // 3. Named global rules (cpu, memory caps)
        for (const { field, metric, toRule } of GLOBAL_RULE_MAP) {
          if (metricDiff.key !== metric) continue;
          const val = global[field];
          if (val !== undefined) {
            const v = evaluateRule(toRule(val as number), metricDiff, contract.contract_id, fn.function_name);
            if (v) violations.push(v);
          }
        }
      }
    }
  }

  return violations;
}
