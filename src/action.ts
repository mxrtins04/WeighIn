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
// RPC health check
// ---------------------------------------------------------------------------

/**
 * Verify that the RPC endpoint is reachable and responding to getNetwork.
 * Fails the action with a clear message if not — the caller is responsible
 * for starting the network before invoking this action.
 */
async function assertRpcHealthy(rpcUrl: string): Promise<void> {
  core.info(`Checking RPC health at ${rpcUrl} ...`);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getNetwork' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const json = await res.json() as any;
    if (json.error) {
      throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
    }
    core.info(`RPC healthy — network: ${json.result?.passphrase ?? '(no passphrase)'}`);
  } catch (err: any) {
    core.setFailed(
      `Soroban RPC at ${rpcUrl} is not reachable: ${err.message}\n` +
      `Start the network before invoking this action (e.g. via stellar/quickstart ` +
      `or scripts/start-local-network.sh), then pass its URL as the rpc-url input.`
    );
    throw err;  // halt execution
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a command and capture stdout. Throws on non-zero exit. */
async function capture(cmd: string, args: string[], cwd?: string): Promise<string> {
  let out = '';
  await exec.exec(cmd, args, {
    cwd,
    listeners: { stdout: (d: Buffer) => { out += d.toString(); } },
    silent: true,
  });
  return out.trim();
}

/** Get HEAD SHA in the given directory. */
async function getHeadSha(dir: string): Promise<string> {
  try {
    return await capture('git', ['rev-parse', 'HEAD'], dir);
  } catch {
    return 'unknown';
  }
}

/** Read soroban-sdk version from Cargo.lock (best-effort). */
function getSdkVersion(repoDir: string): string {
  // Try common locations: repo root Cargo.lock, or contract/Cargo.lock
  for (const rel of ['Cargo.lock', 'contract/Cargo.lock']) {
    const lockPath = path.join(repoDir, rel);
    try {
      if (fs.existsSync(lockPath)) {
        const lock = fs.readFileSync(lockPath, 'utf8');
        const m = lock.match(/name = "soroban-sdk"\nversion = "([^"]+)"/);
        if (m) return m[1];
      }
    } catch { /* ignore */ }
  }
  return 'unknown';
}

/**
 * Build all WASM contracts declared in the fixtures file.
 * wasm_path entries are relative to the fixtures file's directory.
 * Walks up from each wasm_path to find the owning Cargo.toml workspace/crate.
 */
async function buildContracts(fixturesPath: string): Promise<void> {
  const fixturesDir = path.dirname(path.resolve(fixturesPath));
  const raw = fs.readFileSync(fixturesPath, 'utf8');
  const fixtures = JSON.parse(raw) as { contracts: Array<{ wasm_path: string }> };

  const cargoDirs = new Set<string>();
  for (const contract of fixtures.contracts) {
    const wasmAbs = path.resolve(fixturesDir, contract.wasm_path);
    let dir = path.dirname(wasmAbs);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, 'Cargo.toml'))) {
        cargoDirs.add(dir);
        break;
      }
      dir = path.dirname(dir);
    }
  }

  if (cargoDirs.size === 0) {
    throw new Error(`No Cargo.toml found for any wasm_path in ${fixturesPath}`);
  }

  for (const dir of cargoDirs) {
    core.info(`cargo build --release --target wasm32-unknown-unknown in ${dir}`);
    await exec.exec(
      'cargo',
      ['build', '--release', '--target', 'wasm32-unknown-unknown'],
      { cwd: dir }
    );
  }
}

// ---------------------------------------------------------------------------
// Two-directory checkout
// ---------------------------------------------------------------------------

/**
 * Check out a git ref into a fresh temporary directory using a bare clone
 * of the repository that is already checked out at repoRoot.
 *
 * Returns the path to the new directory and the resolved SHA.
 */
async function checkoutRef(
  repoRoot: string,
  ref: string,
  label: string
): Promise<{ dir: string; sha: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `weighin-${label}-`));
  core.info(`Checking out ${ref} into ${dir}`);

  // Fetch the ref into the existing repo's object store, then use
  // git worktree add to get a clean directory without touching the
  // main workspace.
  await exec.exec('git', ['fetch', '--depth=1', 'origin', ref], { cwd: repoRoot });
  await exec.exec('git', ['worktree', 'add', '--detach', dir, `origin/${ref}`], { cwd: repoRoot });

  const sha = await getHeadSha(dir);
  core.info(`${label} SHA: ${sha}`);
  return { dir, sha };
}

/** Remove a worktree directory created by checkoutRef. */
async function removeWorktree(repoRoot: string, dir: string): Promise<void> {
  try {
    await exec.exec('git', ['worktree', 'remove', '--force', dir], { cwd: repoRoot });
  } catch {
    // Non-fatal; runner will clean up temp dirs anyway
    core.warning(`Could not remove git worktree at ${dir}`);
  }
}

// ---------------------------------------------------------------------------
// PR comment management
// ---------------------------------------------------------------------------

const COMMENT_MARKER = '<!-- weighin-report -->';

async function upsertPrComment(token: string, body: string): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const prNumber = github.context.payload.pull_request?.number;

  if (!prNumber) {
    core.warning('Not in a pull_request context; skipping PR comment.');
    return;
  }

  const { data: comments } = await octokit.rest.issues.listComments({
    owner, repo, issue_number: prNumber,
  });

  const existing = comments.find(
    (c: { id: number; body?: string | null }) => c.body?.includes(COMMENT_MARKER)
  );

  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    core.info(`Updated PR comment #${existing.id}`);
  } else {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    core.info('Created new PR comment');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const fixturesPathRel = core.getInput('fixtures-path', { required: true });
  const configPathRel   = core.getInput('config-path');
  const rpcUrl          = core.getInput('rpc-url') || 'http://localhost:8000/rpc';
  const githubToken     = core.getInput('github-token');
  const baseRefInput    = core.getInput('base-ref');

  // The runner's checkout of the PR head is at GITHUB_WORKSPACE
  const headWorkspace = process.env['GITHUB_WORKSPACE'] ?? process.cwd();

  const baseRef = baseRefInput
    || github.context.payload.pull_request?.base?.ref
    || 'main';

  // Key file lives outside either worktree so both measurements share it
  const sharedKeyFile = path.join(os.tmpdir(), 'weighin-deployer.key');

  core.info(`Base ref:   ${baseRef}`);
  core.info(`RPC URL:    ${rpcUrl}`);
  core.info(`Fixtures:   ${fixturesPathRel}`);
  core.info(`Key file:   ${sharedKeyFile}`);

  // 1. RPC health check — fail fast with a clear message
  await assertRpcHealthy(rpcUrl);

  // 2. Resolve paths from the HEAD workspace (fixtures, config live there)
  const headFixturesPath = path.resolve(headWorkspace, fixturesPathRel);
  const configPath       = path.resolve(headWorkspace, configPathRel || 'weighin.toml');

  if (!fs.existsSync(headFixturesPath)) {
    core.setFailed(`fixtures-path not found: ${headFixturesPath}`);
    return;
  }

  // 3. Measure HEAD (the PR branch — already checked out at headWorkspace)
  core.startGroup('Building + measuring HEAD');
  const headSha = await getHeadSha(headWorkspace);
  core.info(`HEAD SHA: ${headSha}`);

  let headResults: ContractBenchmark[];
  try {
    await buildContracts(headFixturesPath);
    headResults = await runMeasurement({
      fixturesPath: headFixturesPath,
      gitCommit: headSha,
      sdkVersion: getSdkVersion(headWorkspace),
      rpcUrl,
      keyFile: sharedKeyFile,
    });
  } catch (err: any) {
    core.setFailed(`HEAD measurement failed: ${err.message}`);
    return;
  }
  core.endGroup();

  // Log WASM hashes from HEAD for the determinism audit trail
  for (const contract of headResults) {
    for (const bench of contract.benchmarks) {
      core.info(`[HEAD] WASM SHA256 (${bench.function_name}): ${bench.wasm_sha256}`);
    }
  }

  // 4. Check out base ref into a separate worktree — never touch headWorkspace
  core.startGroup(`Building + measuring base (${baseRef})`);
  let baseResults: ContractBenchmark[] | null = null;
  let baseDir: string | null = null;
  let baseSha = 'unknown';

  try {
    const checkout = await checkoutRef(headWorkspace, baseRef, 'base');
    baseDir = checkout.dir;
    baseSha = checkout.sha;

    // The fixtures file in the base worktree — same relative path
    const baseFixturesPath = path.resolve(baseDir, fixturesPathRel);
    if (!fs.existsSync(baseFixturesPath)) {
      core.warning(`fixtures-path not found in base ref; skipping baseline.`);
    } else {
      await buildContracts(baseFixturesPath);
      baseResults = await runMeasurement({
        fixturesPath: baseFixturesPath,
        gitCommit: baseSha,
        sdkVersion: getSdkVersion(baseDir),
        rpcUrl,
        keyFile: sharedKeyFile,
      });

      // Log WASM hashes from base
      for (const contract of baseResults) {
        for (const bench of contract.benchmarks) {
          core.info(`[BASE] WASM SHA256 (${bench.function_name}): ${bench.wasm_sha256}`);
        }
      }
    }
  } catch (err: any) {
    core.warning(`Base measurement failed (${err.message}); reporting head-only.`);
  } finally {
    if (baseDir) await removeWorktree(headWorkspace, baseDir);
  }
  core.endGroup();

  // 5. No-baseline path (first PR, base build failed, etc.)
  if (!baseResults) {
    core.setOutput('result', 'no-baseline');
    core.setOutput('diff-json', '{}');
    core.info('No baseline; emitting head-only measurements.');

    if (githubToken) {
      const body = [
        '## ⚪ WeighIn Benchmark Report',
        '',
        'No baseline available for comparison. Head measurements recorded.',
        '',
        '```json',
        JSON.stringify(headResults, null, 2),
        '```',
        '',
        COMMENT_MARKER,
      ].join('\n');
      await upsertPrComment(githubToken, body).catch((e) =>
        core.warning(`PR comment failed: ${e.message}`)
      );
    }
    return;
  }

  // 6. Diff
  core.startGroup('Computing diff');
  const diff: DiffResult = diffBenchmarks(baseResults, headResults);
  core.info(`Any regression: ${diff.hasRegression}`);
  core.endGroup();

  // 7. Threshold enforcement
  core.startGroup('Enforcing thresholds');
  const config = loadConfig(configPath);
  if (config) {
    core.info('weighin.toml loaded');
  } else {
    core.info('No weighin.toml found — no thresholds enforced');
  }
  const violations: Violation[] = enforceThresholds(diff, config);
  core.info(`Violations: ${violations.length}`);
  for (const v of violations) {
    core.error(`[${v.function_name}] ${v.message}`);
  }
  core.endGroup();

  // 8. Outputs
  const result = violations.length > 0 ? 'fail' : 'pass';
  core.setOutput('result', result);
  core.setOutput('diff-json', JSON.stringify(diff));

  // 9. PR comment
  if (githubToken) {
    core.startGroup('Posting PR comment');
    try {
      const body = renderComment(diff, violations, baseRef, headSha);
      await upsertPrComment(githubToken, body);
    } catch (err: any) {
      core.warning(`Failed to post PR comment: ${err.message}`);
    }
    core.endGroup();
  }

  // 10. Exit status
  if (violations.length > 0) {
    core.setFailed(`${violations.length} threshold violation(s) detected`);
  }
}

run();
