import * as fs from 'fs';
import * as crypto from 'crypto';
import {
  xdr,
  hash,
  StrKey,
  Address,
  TransactionBuilder,
  Operation,
  Keypair,
  rpc,
} from '@stellar/stellar-sdk';

const RPC_URL = 'http://localhost:8000/rpc';
const NETWORK_PASSPHRASE = 'Standalone Network ; February 2017';
const TEMP_KEY_FILE = '.weighin-temp-key';

export interface MetricValue {
  consumed: number;
  limit: number;
}

export interface Metrics {
  cpu_instructions: MetricValue;
  memory_bytes: MetricValue;
  ledger_read_entries: MetricValue;
  ledger_read_bytes: MetricValue;
  ledger_write_entries: MetricValue;
  ledger_write_bytes: MetricValue;
  historical_data_read_bytes: MetricValue;
  contract_data_hard_limit: MetricValue;
  tx_size_bytes: MetricValue;
  events_count: MetricValue;
  event_data_bytes: MetricValue;
}

export interface BenchmarkResult {
  function_name: string;
  metrics: Metrics;
}

export interface ContractBenchmark {
  contract_id: string;
  git_commit: string;
  soroban_sdk_version: string;
  timestamp: number;
  benchmarks: BenchmarkResult[];
}

export interface InvocationArg {
  type: string;
  value: any;
}

export interface InvocationSpec {
  function_name: string;
  args: InvocationArg[];
}

export interface ContractSpec {
  wasm_path: string;
  invocations: InvocationSpec[];
}

export interface FixturesSpec {
  contracts: ContractSpec[];
}

// Convert native type/value to ScVal
function toScVal(arg: InvocationArg): xdr.ScVal {
  const type = arg.type.toLowerCase();
  const val = arg.value;
  switch (type) {
    case 'symbol':
      return xdr.ScVal.scvSymbol(val);
    case 'string':
      return xdr.ScVal.scvString(val);
    case 'u32':
      return xdr.ScVal.scvU32(val);
    case 'i32':
      return xdr.ScVal.scvI32(val);
    case 'bool':
      return xdr.ScVal.scvBool(val);
    default:
      throw new Error(`Unsupported argument type: ${arg.type}`);
  }
}

// Deterministically calculate contract ID
function calculateContractId(deployerAddress: string, salt: Buffer): string {
  const addressSc = Address.fromString(deployerAddress).toScAddress();
  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: addressSc,
      salt: salt,
    })
  );

  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE));
  const hashIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: networkId,
      contractIdPreimage: preimage,
    })
  );

  const contractIdBytes = hash(hashIdPreimage.toXDR());
  return StrKey.encodeContract(contractIdBytes);
}

// Load or generate/fund a keypair
async function getOrInitAccount(server: rpc.Server): Promise<Keypair> {
  let secret: string;
  if (fs.existsSync(TEMP_KEY_FILE)) {
    secret = fs.readFileSync(TEMP_KEY_FILE, 'utf8').trim();
    return Keypair.fromSecret(secret);
  }

  const keypair = Keypair.random();
  secret = keypair.secret();
  fs.writeFileSync(TEMP_KEY_FILE, secret, 'utf8');

  console.log(`Funding temporary deployer account: ${keypair.publicKey()} ...`);
  const friendbotUrl = `http://localhost:8000/friendbot?addr=${keypair.publicKey()}`;
  const res = await fetch(friendbotUrl);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed: ${res.statusText}`);
  }
  // Wait for ledger inclusion
  await new Promise((resolve) => setTimeout(resolve, 3000));
  return keypair;
}

// Poll transaction completion
async function waitForTransaction(server: rpc.Server, hash: string): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < 30; i++) {
    const tx = await server.getTransaction(hash);
    if (tx.status !== 'NOT_FOUND') {
      return tx;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Transaction ${hash} not found after 30 seconds`);
}

// Check if contract is already deployed
async function isContractDeployed(server: rpc.Server, contractId: string): Promise<boolean> {
  try {
    const contractScAddress = Address.fromString(contractId).toScAddress();
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractScAddress,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    const res = await server.getLedgerEntries(ledgerKey);
    return !!(res.entries && res.entries.length > 0);
  } catch {
    return false;
  }
}

// Measure instance size from stateChanges or fallback to getLedgerEntries
async function getInstanceSize(
  server: rpc.Server,
  contractId: string,
  stateChanges?: rpc.Api.LedgerEntryChange[]
): Promise<number> {
  // Try parsing from simulation stateChanges first
  if (stateChanges) {
    for (const change of stateChanges) {
      if (change.after) {
        const val = change.after.data();
        if (val.switch() === xdr.LedgerEntryType.contractData()) {
          const contractData = val.contractData();
          const contractAddressStr = Address.fromScAddress(contractData.contract()).toString();
          if (
            contractAddressStr === contractId &&
            contractData.key().switch() === xdr.ScValType.scvLedgerKeyContractInstance()
          ) {
            return change.after.toXDR().length;
          }
        }
      }
    }
  }

  // Fallback to querying the ledger directly
  try {
    const contractScAddress = Address.fromString(contractId).toScAddress();
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractScAddress,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    const res = await server.getLedgerEntries(ledgerKey);
    if (res.entries && res.entries.length > 0) {
      return res.entries[0].val.toXDR().length;
    }
  } catch {}

  return 0;
}

export async function runMeasurement(
  fixturesPath: string,
  gitCommit: string,
  sdkVersion: string,
  rpcUrl: string = RPC_URL
): Promise<ContractBenchmark[]> {
  const server = new rpc.Server(rpcUrl, { allowHttp: true });
  const deployer = await getOrInitAccount(server);
  const deployerAddress = Address.fromString(deployer.publicKey());

  const rawFixtures = fs.readFileSync(fixturesPath, 'utf8');
  const fixturesSpec: FixturesSpec = JSON.parse(rawFixtures);

  const results: ContractBenchmark[] = [];

  for (const contractSpec of fixturesSpec.contracts) {
    const wasmPath = contractSpec.wasm_path;
    if (!fs.existsSync(wasmPath)) {
      throw new Error(`WASM file not found at ${wasmPath}. Build the contract first!`);
    }

    const wasmBytes = fs.readFileSync(wasmPath);
    const wasmHash = crypto.createHash('sha256').update(wasmBytes).digest();

    // Use deterministic salt based on WASM hash to avoid duplicate deployments
    const salt = crypto.createHash('sha256').update(wasmHash).digest();
    const contractId = calculateContractId(deployer.publicKey(), salt);

    console.log(`Checking deployment status of contract: ${contractId} (WASM: ${wasmPath})`);
    const deployed = await isContractDeployed(server, contractId);

    if (!deployed) {
      console.log(`Contract not deployed. Installing Wasm...`);
      let account = await server.getAccount(deployer.publicKey());

      // 1. Upload WASM
      const uploadTx = new TransactionBuilder(account, {
        fee: '1000000',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(Operation.uploadContractWasm({ wasm: wasmBytes }))
        .setTimeout(30)
        .build();

      console.log("Simulating Wasm upload transaction...");
      const simUpload = await server.simulateTransaction(uploadTx);
      console.log("Upload Simulation Result:", JSON.stringify(simUpload, null, 2));
      const preparedUpload = await server.prepareTransaction(uploadTx);
      preparedUpload.sign(deployer);
      const uploadSend = await server.sendTransaction(preparedUpload);
      const uploadRes = await waitForTransaction(server, uploadSend.hash);
      if (uploadRes.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Wasm upload failed: ${JSON.stringify(uploadRes)}`);
      }

      console.log(`Wasm installed successfully. Deploying contract instance...`);
      account = await server.getAccount(deployer.publicKey());

      // 2. Create Contract Instance
      const createTx = new TransactionBuilder(account, {
        fee: '1000000',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.createCustomContract({
            wasmHash,
            address: deployerAddress,
            salt,
          })
        )
        .setTimeout(30)
        .build();

      const preparedCreate = await server.prepareTransaction(createTx);
      preparedCreate.sign(deployer);
      const createSend = await server.sendTransaction(preparedCreate);
      const createRes = await waitForTransaction(server, createSend.hash);
      if (createRes.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Contract instantiation failed: ${JSON.stringify(createRes)}`);
      }
      console.log(`Contract deployed successfully at ID: ${contractId}`);
    } else {
      console.log(`Contract ${contractId} is already deployed.`);
    }

    const benchmarks: BenchmarkResult[] = [];

    // 3. Invoke/Simulate functions
    for (const invokeSpec of contractSpec.invocations) {
      console.log(`Simulating call to function '${invokeSpec.function_name}'...`);
      const account = await server.getAccount(deployer.publicKey());
      const argsSc = invokeSpec.args.map(toScVal);

      const invokeTx = new TransactionBuilder(account, {
        fee: '1000000',
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.invokeContractFunction({
            contract: contractId,
            function: invokeSpec.function_name,
            args: argsSc,
          })
        )
        .setTimeout(30)
        .build();

      const simRes = await server.simulateTransaction(invokeTx);
      if (rpc.Api.isSimulationError(simRes)) {
        throw new Error(`Simulation failed: ${simRes.error}`);
      }

      // Parse 11 Metrics
      const simSuccess = simRes as any;

      // Extract SorobanTransactionData and footprint
      const transactionData = simSuccess.transactionData;
      const parsedData = transactionData.build();
      const resources = parsedData.resources();
      const footprint = resources.footprint();

      const readEntries = footprint.readOnly().length;
      const writeEntries = footprint.readWrite().length;
      const readBytes = resources.diskReadBytes();
      const writeBytes = resources.writeBytes();

      // CPU and Memory limits
      const cpuConsumed = Number(simSuccess.cost.cpuInsns);
      const memConsumed = Number(simSuccess.cost.memBytes);

      // Event Data and Count
      const eventsCount = simSuccess.events.length;
      const eventBytes = simSuccess.events.reduce((acc: number, e: any) => {
        const event = e.event();
        if (event.type().name !== 'contract') {
          return acc;
        }
        return acc + event.toXDR().length;
      }, simSuccess.result?.retval.toXDR().length || 0);

      // 4 Unresolved Metrics
      // A. Transaction Size Bytes
      const preparedTx = await server.prepareTransaction(invokeTx);
      const txSizeBytes = Buffer.from(preparedTx.toEnvelope().toXDR()).length;

      // B. Max Entry Bytes
      // Parse sizes of all readWrite entries and readOnly entries to find the maximum
      let maxEntryBytes = 0;
      const stateChanges = simSuccess.stateChanges || [];
      for (const change of stateChanges) {
        if (change.after) {
          maxEntryBytes = Math.max(maxEntryBytes, change.after.toXDR().length);
        }
      }
      // If we need the maximum of read-only entries as well, query them
      const readOnlyKeys = footprint.readOnly();
      if (readOnlyKeys.length > 0) {
        try {
          const res = await server.getLedgerEntries(...readOnlyKeys);
          for (const entry of res.entries) {
            maxEntryBytes = Math.max(maxEntryBytes, entry.val.toXDR().length);
          }
        } catch {}
      }

      // C. Contract Data Hard Limit (Instance entry size)
      const contractDataHardLimit = await getInstanceSize(server, contractId, stateChanges);

      // D. Historical Read Bytes (Historical storage reads are not metered during simulation; always 0)
      const historicalReadBytes = 0;

      // Limits sourced from live network config (protocol 25, standalone).
      // configSettingContractComputeV0:    txMaxInstructions=100_000_000, txMemoryLimit=41_943_040
      // configSettingContractLedgerCostV0: txMaxReadLedgerEntries=100, txMaxReadBytes=200_000,
      //                                    txMaxWriteLedgerEntries=50, txMaxWriteBytes=132_096
      // configSettingContractBandwidthV0:  txMaxSizeBytes=132_096
      // configSettingContractEventsV0:     txMaxContractEventsSizeBytes=16_384
      // configSettingContractDataEntrySizeBytes: 65_536
      // historical_data_read_bytes: no size limit in config (fee-only); tracked as known gap.
      const metrics: Metrics = {
        cpu_instructions:           { consumed: cpuConsumed,            limit: 100_000_000 },
        memory_bytes:               { consumed: memConsumed,            limit: 41_943_040 },
        ledger_read_entries:        { consumed: readEntries,            limit: 100 },
        ledger_read_bytes:          { consumed: readBytes,              limit: 200_000 },
        ledger_write_entries:       { consumed: writeEntries,           limit: 50 },
        ledger_write_bytes:         { consumed: writeBytes,             limit: 132_096 },
        historical_data_read_bytes: { consumed: historicalReadBytes,    limit: 0 }, // TODO: no size limit in config; fee-only
        contract_data_hard_limit:   { consumed: contractDataHardLimit,  limit: 65_536 },
        tx_size_bytes:              { consumed: txSizeBytes,            limit: 132_096 },
        events_count:               { consumed: eventsCount,            limit: 100 },
        event_data_bytes:           { consumed: eventBytes,             limit: 16_384 },
      };

      benchmarks.push({
        function_name: invokeSpec.function_name,
        metrics,
      });
    }

    results.push({
      contract_id: contractId,
      git_commit: gitCommit,
      soroban_sdk_version: sdkVersion,
      timestamp: Math.floor(Date.now() / 1000),
      benchmarks,
    });
  }

  return results;
}
