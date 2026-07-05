import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { runMeasurement } from './measurement';

function getGitCommit(): string {
  try {
    return execSync('git rev-parse HEAD').toString().trim();
  } catch {
    return 'unknown_commit';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const fixturesPath = args[0] || 'weighin-fixtures.json';
  const outputPath = args[1] || 'weighin-results.json';

  const gitCommit = getGitCommit();
  // Default to Soroban SDK version 21.2.0 (as used in scratch/contract_test)
  const sdkVersion = '21.2.0';

  console.log(`Starting Weighin Benchmarking...`);
  console.log(`Fixtures configuration: ${fixturesPath}`);
  console.log(`Output results target: ${outputPath}`);
  console.log(`Git Commit: ${gitCommit}`);
  console.log(`Soroban SDK Version: ${sdkVersion}`);

  try {
    const results = await runMeasurement(fixturesPath, gitCommit, sdkVersion);
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf8');
    console.log(`Benchmarking completed successfully! Results written to ${outputPath}`);
  } catch (error: any) {
    console.error(`Benchmarking failed:`, error);
    process.exit(1);
  }
}

main();
