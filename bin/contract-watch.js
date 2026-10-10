#!/usr/bin/env node
import { capture, captureWithBeacon, captureWithImplementation, readSnapshot, saveSnapshot } from '../src/snapshot.js';
import { snapshotReport, diffReport, diffDocument } from '../src/report.js';
import { timeout, concurrency } from '../src/validate.js';
import { fail, publicError } from '../src/errors.js';
import { migrateFile } from '../src/migration.js';
import { configuredCapture, MAX_CONFIG_TARGETS } from '../src/config.js';
import { captureMany } from '../src/batch.js';

const HELP = `Contract Watch 0.1.0 — read-only EIP-1967 snapshots (Node.js 22+)

Usage:
  contract-watch snapshot --address ADDRESS --chain-id ID --out FILE [options]
  contract-watch snapshot --config FILE --target NAME --out FILE [options]
  contract-watch snapshot-many --config FILE --target NAME [--target NAME ...] --out-dir NEW [options]
  contract-watch inspect FILE
  contract-watch diff [--json] [--exit-code] BEFORE.json AFTER.json
  contract-watch migrate SOURCE.json --to-version 3 --out NEW.json
  contract-watch migrate SOURCE.json --to-version 4 --out NEW.json

Snapshot options:
  --rpc URL           Explicit HTTP(S) endpoint (or CONTRACT_WATCH_RPC_URL)
  --config FILE       Explicit local JSON target configuration, at most 16 KiB
  --target NAME       Select exactly one named target; requires --config
                      No --address/--chain-id/--rpc overrides; selected rpcEnv only
  --block BLOCK       latest (default), safe, finalized, decimal or hex number
  --block-hash HASH   Exact 32-byte block hash
  --depth N           N blocks behind the initial latest head (0 means that head)
                      Decimal 0..2^256-1, at most 78 digits, no leading zeros
  --timeout-ms MS     Total timeout per request, 100–60000 (default 10000)
  --strict-checksum   Require exact EIP-55 address casing before any RPC call
  --genesis          Save v4 with observed genesis identity; adds two block-0 reads
  --resolve-beacon    Read an eligible beacon's implementation(); live report only
                      At most 1 call, 100000 gas, min(timeout, 5000 ms), 4 KiB response
  --implementation-code  Save v2 with separate implementation code and address provenance
                      Resolves an eligible beacon with the same call limits
                      Cannot combine with --resolve-beacon

Diff options:
  --json             Version 1, 2, 3 or 4 JSON report on stdout, matching the input pair
  --exit-code        Exit 2 for state changes, 0 without changes, 1 for errors

Batch options:
  --target NAME      Repeat for 1-32 unique targets in explicit input/report order
  --out-dir NEW      New directory in an existing parent; no overwrite
  --shared-block     Opt in to one fixed block per expected-chain group; JSON report v2
  --concurrency N    Batch-wide maximum active captures/RPCs, integer 1-8 (default 1)
Batch accepts common capture flags; no --address/--chain-id/--rpc/--out overrides.
Default/1 is sequential; larger limits run ready targets concurrently, with ordered outcomes.
Report v1 (independent) or v2 (shared) and snapshot formats do not change with concurrency.
Shared followers wait without occupying workers; all started work finishes before the report.
No retries, rollback or CLI interrupt/drain guarantee. Partial files survive failures.
Shared mode resolves from each group's first selection, then every RPC checks that anchor.
An unavailable anchor blocks its group without fallback; other groups continue.
Genesis checks each target against the group's observation. No simultaneous-set guarantee.
Reports use ordinal filenames and safe outcomes; saved snapshot formats are unchanged.
Exit 0 only when all files are saved, 1 for any failure; global errors have empty stdout.
Per-target env/RPC/write failures continue; earlier saved files remain. No --json/--exit-code.

All state reads use one block hash and require EIP-1898 support.
Choose at most one of --block, --block-hash or --depth. Depth is not finality.
Output files are never overwritten. Parent directory must already exist.
Config validates all 1-32 targets before reading the selected RPC environment value.
No config discovery, .env loading, interpolation or fallback endpoint.
Address validation defaults to 20-byte hex syntax; EIP-55 checking is opt-in.
Diff is offline. Default exit status: 0 success (including changes), 1 error.
Diff requires matching snapshot versions; v2/v3/v4 compare available implementation observations.
V4 diff requires two equal recorded genesis hashes; unknown/different identities fail.
Skipped observations or changed provenance are shown without inferring code changes.
Inspect is offline and accepts one snapshot v1, v2, v3 or v4 file, no options; exit 0/1.
Migrate is offline: v1/v2 to v3 or v1/v2/v3 to v4; original retained as backup, no overwrite.
V1 migration marks implementation not-recorded; v2 observations are preserved.
Migration to v4 marks genesis not-recorded. Already-current inputs fail without output.
Capture writes v1/v2 unless --genesis is explicit. Genesis is not proof of network trust.
Beacon results are not saved in v1 files. No safety assessment or complete proxy detection.
`;

function parseSnapshot(args, many = false) {
  const allowed = new Set([
    ...(many ? ['--out-dir', '--shared-block', '--concurrency'] : ['--address', '--chain-id', '--out', '--rpc']),
    '--block', '--block-hash', '--depth', '--timeout-ms',
    '--strict-checksum', '--resolve-beacon', '--implementation-code', '--genesis', '--config', '--target'
  ]);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key) || (Object.hasOwn(options, key) && !(many && key === '--target'))) fail('USAGE');
    if (['--strict-checksum', '--resolve-beacon', '--implementation-code', '--genesis', '--shared-block'].includes(key)) {
      options[key] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('USAGE');
    if (many && key === '--target') {
      const names = options[key] ??= [];
      if (names.length === MAX_CONFIG_TARGETS || names.includes(value)) fail('BATCH_TARGETS');
      names.push(value);
    } else options[key] = value;
  }
  if (many) {
    if (!options['--config'] || !options['--target'] || !options['--out-dir']) fail('USAGE');
  } else if (!options['--out']) fail('USAGE');
  if (!many && (options['--config'] || options['--target'])) {
    if (!options['--config'] || !options['--target'] ||
        ['--address', '--chain-id', '--rpc'].some(key => Object.hasOwn(options, key))) fail('USAGE');
  } else if (!many && (!options['--address'] || !options['--chain-id'])) fail('USAGE');
  if (options['--resolve-beacon'] && options['--implementation-code']) fail('USAGE');
  if (['--block', '--block-hash', '--depth'].filter(key => Object.hasOwn(options, key)).length > 1) fail('USAGE');
  return options;
}

function captureFlags(options) {
  return {
    block: options['--block'], blockHash: options['--block-hash'], depth: options['--depth'],
    timeoutMs: timeout(options['--timeout-ms']),
    strictChecksum: options['--strict-checksum'] ?? false,
    genesis: options['--genesis'] ?? false
  };
}

function parseDiff(args) {
  let json = false;
  let exitCode = false;
  const files = [];
  for (const value of args) {
    if (value === '--json') {
      if (json) fail('USAGE');
      json = true;
    } else if (value === '--exit-code') {
      if (exitCode) fail('USAGE');
      exitCode = true;
    } else {
      if (value.startsWith('--')) fail('USAGE');
      files.push(value);
    }
  }
  if (files.length !== 2) fail('USAGE');
  return { json, exitCode, files };
}

function parseMigration(args) {
  const options = {};
  let input;
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--to-version' || key === '--out') {
      if (Object.hasOwn(options, key)) fail('USAGE');
      const value = args[++index];
      if (!value || value.startsWith('--')) fail('USAGE');
      options[key] = value;
    } else {
      if (!key || key.startsWith('-') || input !== undefined) fail('USAGE');
      input = key;
    }
  }
  if (!input || !options['--to-version'] || !options['--out']) fail('USAGE');
  return { input, output: options['--out'], toVersion: options['--to-version'] };
}

async function main(args) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    process.stdout.write(HELP); return;
  }
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write('0.1.0\n'); return;
  }
  if (args[0] === 'migrate') {
    const migrated = await migrateFile(parseMigration(args.slice(1)));
    process.stdout.write(`Snapshot migrated to version ${migrated.schemaVersion}. Original preserved as backup.\n`);
    return;
  }
  if (args[0] === 'snapshot') {
    const options = parseSnapshot(args.slice(1));
    const selectedOptions = captureFlags(options);
    const captureOptions = options['--config']
      ? await configuredCapture(options['--config'], options['--target'], selectedOptions)
      : { ...selectedOptions, rpcUrl: options['--rpc'] ?? process.env.CONTRACT_WATCH_RPC_URL,
        address: options['--address'], chainId: options['--chain-id'] };
    const { snapshot, beaconResolution } = options['--implementation-code']
      ? { snapshot: await captureWithImplementation(captureOptions) }
      : options['--resolve-beacon']
        ? await captureWithBeacon(captureOptions) : { snapshot: await capture(captureOptions) };
    const report = snapshotReport(snapshot, { beaconResolution });
    await saveSnapshot(options['--out'], snapshot);
    process.stdout.write(`${report}\nSnapshot saved.\n`);
    return;
  }
  if (args[0] === 'snapshot-many') {
    const options = parseSnapshot(args.slice(1), true);
    const report = await captureMany({ configPath: options['--config'], names: options['--target'],
      concurrency: concurrency(options['--concurrency']),
      outputDir: options['--out-dir'], options: captureFlags(options),
      includeBeacon: options['--resolve-beacon'] ?? false,
      includeImplementation: options['--implementation-code'] ?? false,
      sharedBlock: options['--shared-block'] ?? false });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failed) process.exitCode = 1;
    return;
  }
  if (args[0] === 'diff') {
    const { json, exitCode, files } = parseDiff(args.slice(1));
    const before = await readSnapshot(files[0]);
    const after = await readSnapshot(files[1]);
    const document = json || exitCode ? diffDocument(before, after) : null;
    const report = json ? JSON.stringify(document, null, 2) : diffReport(before, after);
    process.stdout.write(`${report}\n`);
    if (exitCode && document.changed) process.exitCode = 2;
    return;
  }
  if (args[0] === 'inspect') {
    if (args.length !== 2 || !args[1] || args[1].startsWith('-')) fail('USAGE');
    const snapshot = await readSnapshot(args[1]);
    process.stdout.write(`${snapshotReport(snapshot)}\n`);
    return;
  }
  fail('USAGE');
}

// Broken pipes are normal when output is consumed by tools such as head.
process.stdout.on('error', error => { process.exitCode = error.code === 'EPIPE' ? 0 : 1; });
main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${publicError(error)}\n`);
  process.exitCode = 1;
});
