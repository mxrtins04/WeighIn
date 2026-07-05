import * as fs from 'fs';
import { execSync } from 'child_process';
import { runMeasurement } from './measurement';

function getGitCommit(): string {
  try {
    return execSync('git rev-parse HEAD').toString().trim();
  } catch {
    return 'unknown_commit';
  }
}

function parseArgs(): { fixturesPath: string; outputPath: string; rpcUrl: string } {
  const args = process.argv.slice(2);
  let fixturesPath = 'weighin-fixtures.json';
  let outputPath = 'weighin-results.json';
  let rpcUrl = 'http://localhost:8000/rpc';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rpc-url' && args[i + 1]) {
      rpcUrl = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      outputPath = args[++i];
    } else if (!args[i].startsWith('--')) {
      // Positional: first is fixtures path, second is output path
      if (fixturesPath === 'weighin-fixtures.json') {
        fixturesPath = args[i];
      } else {
        outputPath = args[i];
      }
    }
  }

  return { fixturesPath, outputPath, rpcUrl };
}

async function main() {
  const { fixturesPath, outputPath, rpcUrl } = parseArgs();
  const gitCommit = getGitCommit();

  // Best-effort: read soroban-sdk version from contract/Cargo.lock if present
  let sdkVersion = 'unknown';
  try {
    const lock = fs.readFileSync('contract/Cargo.lock', 'utf8');
    const m = lock.match(/name = "soroban-sdk"\nversion = "([^"]+)"/);
    if (m) sdkVersion = m[1];
  } catch { /* ignore */ }

  console.log(`Starting Weighin Benchmarking...`);
  console.log(`Fixtures: ${fixturesPath}`);
  console.log(`Output:   ${outputPath}`);
  console.log(`RPC URL:  ${rpcUrl}`);
  console.log(`Commit:   ${gitCommit}`);
  console.log(`SDK:      ${sdkVersion}`);

  try {
    const results = await runMeasurement(fixturesPath, gitCommit, sdkVersion, rpcUrl);
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`Done. Results written to ${outputPath}`);
  } catch (error: any) {
    console.error(`Benchmarking failed:`, error);
    process.exit(1);
  }
}

main();
