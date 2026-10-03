#!/usr/bin/env node
import { capture, readSnapshot, saveSnapshot } from '../src/snapshot.js';
import { snapshotReport, diffReport, diffDocument } from '../src/report.js';
import { timeout } from '../src/validate.js';
import { fail, publicError } from '../src/errors.js';

const HELP = `Contract Watch 0.1.0 — read-only EIP-1967 snapshots (Node.js 22+)

Usage:
  contract-watch snapshot --address ADDRESS --chain-id ID --out FILE [options]
  contract-watch inspect FILE
  contract-watch diff [--json] [--exit-code] BEFORE.json AFTER.json

Snapshot options:
  --rpc URL           Explicit HTTP(S) endpoint (or CONTRACT_WATCH_RPC_URL)
  --block BLOCK       latest (default), safe, finalized, decimal or hex number
  --block-hash HASH   Exact 32-byte block hash
  --depth N           N blocks behind the initial latest head (0 means that head)
                      Decimal 0..2^256-1, at most 78 digits, no leading zeros
  --timeout-ms MS     Total timeout per request, 100–60000 (default 10000)
  --strict-checksum   Require exact EIP-55 address casing before any RPC call

Diff options:
  --json             Version 1 JSON report on stdout; errors remain on stderr
  --exit-code        Exit 2 for state changes, 0 without changes, 1 for errors

All state reads use one block hash and require EIP-1898 support.
Choose at most one of --block, --block-hash or --depth. Depth is not finality.
Output files are never overwritten. Parent directory must already exist.
Address validation defaults to 20-byte hex syntax; EIP-55 checking is opt-in.
Diff is offline. Default exit status: 0 success (including changes), 1 error.
Inspect is offline and accepts one snapshot v1 file, no options; exit 0/1.
This tool does not assess safety, resolve beacons, or detect every proxy type.
`;

function parseSnapshot(args) {
  const allowed = new Set([
    '--address', '--chain-id', '--out', '--rpc', '--block', '--block-hash', '--depth', '--timeout-ms', '--strict-checksum'
  ]);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key) || Object.hasOwn(options, key)) fail('USAGE');
    if (key === '--strict-checksum') {
      options[key] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) fail('USAGE');
    options[key] = value;
  }
  if (!options['--address'] || !options['--chain-id'] || !options['--out']) fail('USAGE');
  if (['--block', '--block-hash', '--depth'].filter(key => Object.hasOwn(options, key)).length > 1) fail('USAGE');
  return options;
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

async function main(args) {
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    process.stdout.write(HELP); return;
  }
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write('0.1.0\n'); return;
  }
  if (args[0] === 'snapshot') {
    const options = parseSnapshot(args.slice(1));
    const snapshot = await capture({
      rpcUrl: options['--rpc'] ?? process.env.CONTRACT_WATCH_RPC_URL,
      address: options['--address'], chainId: options['--chain-id'],
      block: options['--block'], blockHash: options['--block-hash'], depth: options['--depth'],
      timeoutMs: timeout(options['--timeout-ms']),
      strictChecksum: options['--strict-checksum'] ?? false
    });
    await saveSnapshot(options['--out'], snapshot);
    process.stdout.write(`${snapshotReport(snapshot)}\nSnapshot saved.\n`);
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
