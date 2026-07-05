import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { runMeasurement, ContractBenchmark } from './measurement';
import { diffBenchmarks, DiffResult } from './diff';
import { loadConfig, enforceThresholds, Violation } from './threshold';
import { renderComment } from './comment';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a shell command through @actions/exec, capturing stdout.
 * Throws on non-zero exit.
 */
async function capture(cmd: string, args: string[], cwd?: string): Promise<string> {
  let out = '';
  await exec.exec(cmd, args, {
    cwd,
    listeners: {
      stdout: (data: Buffer) => { out += data.toString(); },
    },
    silent: true,
  });
  return out.trim();
}

/** Get the current HEAD SHA in cwd. */
async function getHeadSha(cwd: string): Promise<string> {
  try {
    return await capture('git', ['rev-parse', 'HEAD'], cwd);
  } catch {
    return 'unknown';
  }
}

/** Get the default Soroban SDK version by parsing cargo metadata (best-effort). */
function getSdkVersion(cwd: string): string {
  try {
    const lockPath = path.join(cwd, 'contract', 'Cargo.lock');
    if (fs.existsSync(lockPath)) {
      const lock = fs.readFileSync(lockPath, 'utf8');
      const m = lock.match(/name = "soroban-sdk"\nversion = "([^"]+)"/);
      if (m) return m[1];
    }
  } catch { /* ignore */ }
  return 'unknown';
}

/**
 * Build all WASM contracts declared in the fixtures file.
 *
 * The fixtures file references wasm_path values relative to the repo root.
 * For each unique directory that contains a Cargo.toml, we run:
 *   cargo build --release --target wasm32-unknown-unknown
 */
async function buildContracts(fixturesPath: string, repoRoot: string): Promise<void> {
  const raw = fs.readFileSync(fixturesPath, 'utf8');
  const fixtures = JSON.parse(raw) as { contracts: Array<{ wasm_path: string }> };

  // Collect unique Cargo.toml directories
  const cargoDirs = new Set<string>();
  for (const contract of fixtures.contracts) {
    const wasmAbs = path.resolve(repoRoot, contract.wasm_path);
    // Walk up from the wasm_path to find the first Cargo.toml
    let dir = path.dirname(wasmAbs);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
        cargoDirs.add(dir);
        break;
      }
      dir = path.dirname(dir);
    }
  }

  for (const dir of cargoDirs) {
    core.info(`Building WASM in ${dir} ...`);
    await exec.exec('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: dir });
  }
}

// ---------------------------------------------------------------------------
// PR comment management
// ---------------------------------------------------------------------------

const COMMENT_MARKER = '<!-- weighin-report -->';

async function upsertPrComment(
  token: string,
  body: string
): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const prNumber = github.context.payload.pull_request?.number;

  if (!prNumber) {
    core.warning('Not running in a pull_request context; skipping PR comment.');
    return;
  }

  // Look for an existing weighin comment to update
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });

  const existing = comments.find((c: { id: number; body?: string | null }) => c.body?.includes(COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    core.info(`Updated existing PR comment #${existing.id}`);
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    core.info('Created new PR comment');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  // --- Read inputs ---
  const fixturesPathRel  = core.getInput('fixtures-path', { required: true });
  const configPathRel    = core.getInput('config-path');
  const rpcUrl           = core.getInput('rpc-url');
  const githubToken      = core.getInput('github-token');
  const baseRefInput     = core.getInput('base-ref');

  // Determine working directory (the caller's repo root)
  const repoRoot = process.env['GITHUB_WORKSPACE'] ?? process.cwd();

  const fixturesPath = path.resolve(repoRoot, fixturesPathRel);
  const configPath   = path.resolve(repoRoot, configPathRel || 'weighin.toml');

  if (!fs.existsSync(fixturesPath)) {
    core.setFailed(`fixtures-path not found: ${fixturesPath}`);
    return;
  }

  // Determine base ref
  const baseRef = baseRefInput
    || github.context.payload.pull_request?.base?.ref
    || 'main';

  core.info(`Base ref: ${baseRef}`);
  core.info(`Fixtures: ${fixturesPath}`);
  core.info(`Config:   ${configPath}`);
  core.info(`RPC URL:  ${rpcUrl}`);

  // --- Measure HEAD (current checkout) ---
  core.startGroup('Measuring HEAD');
  const headSha = await getHeadSha(repoRoot);
  core.info(`HEAD SHA: ${headSha}`);

  let headResults: ContractBenchmark[];
  try {
    await buildContracts(fixturesPath, repoRoot);
    headResults = await runMeasurement(fixturesPath, headSha, getSdkVersion(repoRoot), rpcUrl);
  } catch (err: any) {
    core.setFailed(`HEAD measurement failed: ${err.message}`);
    return;
  }
  core.endGroup();

  // --- Check out base ref and measure baseline ---
  core.startGroup(`Measuring base (${baseRef})`);

  // Stash the head results path so we can restore the workspace
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weighin-'));
  const headResultsPath = path.join(tmpDir, 'head.json');
  fs.writeFileSync(headResultsPath, JSON.stringify(headResults, null, 2));

  let baseResults: ContractBenchmark[] | null = null;
  let baseSha = 'unknown';

  try {
    // Fetch and check out the base branch without switching the whole workspace
    await exec.exec('git', ['fetch', '--depth=1', 'origin', baseRef], { cwd: repoRoot });
    await exec.exec('git', ['stash'], { cwd: repoRoot });

    try {
      await exec.exec('git', ['checkout', `origin/${baseRef}`], { cwd: repoRoot });
      baseSha = await getHeadSha(repoRoot);
      core.info(`Base SHA: ${baseSha}`);

      await buildContracts(fixturesPath, repoRoot);
      baseResults = await runMeasurement(fixturesPath, baseSha, getSdkVersion(repoRoot), rpcUrl);
    } finally {
      // Always restore the HEAD workspace
      await exec.exec('git', ['checkout', '-'], { cwd: repoRoot });
      await exec.exec('git', ['stash', 'pop'], { cwd: repoRoot }).catch(() => {
        // stash pop can fail if there was nothing stashed or conflicts; non-fatal
        core.warning('git stash pop did not cleanly restore; the workspace may need attention');
      });
    }
  } catch (err: any) {
    core.warning(`Base measurement failed (${err.message}); reporting head-only, no diff.`);
  }
  core.endGroup();

  // --- Restore head results from file ---
  headResults = JSON.parse(fs.readFileSync(headResultsPath, 'utf8'));

  // --- If no base, emit head-only output and exit pass ---
  if (!baseResults) {
    const headJson = JSON.stringify(headResults, null, 2);
    core.setOutput('result', 'no-baseline');
    core.setOutput('diff-json', '{}');
    core.info('No baseline available; emitting head measurements only.');

    if (githubToken) {
      const body = [
        '## ⚪ WeighIn Benchmark Report',
        '',
        'No baseline available for comparison. Head measurements recorded.',
        '',
        '```json',
        headJson,
        '```',
        '',
        COMMENT_MARKER,
      ].join('\n');
      await upsertPrComment(githubToken, body);
    }
    return;
  }

  // --- Diff ---
  core.startGroup('Computing diff');
  const diff: DiffResult = diffBenchmarks(baseResults, headResults);
  core.info(`Regression detected: ${diff.hasRegression}`);
  core.endGroup();

  // --- Threshold enforcement ---
  core.startGroup('Enforcing thresholds');
  const config = loadConfig(configPath);
  const violations: Violation[] = enforceThresholds(diff, config);
  core.info(`Violations: ${violations.length}`);
  for (const v of violations) {
    core.error(`[${v.function_name}] ${v.message}`);
  }
  core.endGroup();

  // --- Outputs ---
  const result = violations.length > 0 ? 'fail' : 'pass';
  core.setOutput('result', result);
  core.setOutput('diff-json', JSON.stringify(diff));

  // --- PR comment ---
  if (githubToken) {
    core.startGroup('Posting PR comment');
    try {
      const body = renderComment(diff, violations, baseRef, headSha);
      await upsertPrComment(githubToken, body);
    } catch (err: any) {
      // Comment failure is non-fatal; don't mask the real result
      core.warning(`Failed to post PR comment: ${err.message}`);
    }
    core.endGroup();
  }

  // --- Exit status ---
  if (violations.length > 0) {
    core.setFailed(`${violations.length} threshold violation(s) detected`);
  }
}

run();
