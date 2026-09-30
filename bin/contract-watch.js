#!/usr/bin/env node
import { capture, readSnapshot, saveSnapshot } from '../src/snapshot.js';
import { snapshotReport, diffReport, diffDocument } from '../src/report.js';
import { timeout } from '../src/validate.js';
import { fail, publicError } from '../src/errors.js';

const HELP = `Contract Watch 0.1.0 — read-only EIP-1967 snapshots (Node.js 22+)

Usage:
  contract-watch snapshot --address ADDRESS --chain-id ID --out FILE [options]
  contract-watch diff [--json] BEFORE.json AFTER.json

Snapshot options:
  --rpc URL           Explicit HTTP(S) endpoint (or CONTRACT_WATCH_RPC_URL)
  --block BLOCK       latest (default), safe, finalized, decimal or hex number
  --timeout-ms MS     Total timeout per request, 100–60000 (default 10000)

Diff options:
  --json             Version 1 JSON report on stdout; errors remain on stderr

All state reads use one block hash and require EIP-1898 support.
Output files are never overwritten. Parent directory must already exist.
Address validation checks 20-byte hex syntax, not EIP-55 checksum.
Diff is offline. Exit status: 0 success (including changes), 1 error.
This tool does not assess safety, resolve beacons, or detect every proxy type.
`;

function parseSnapshot(args) {
  const allowed = new Set(['--address', '--chain-id', '--out', '--rpc', '--block', '--timeout-ms']);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.has(key) || Object.hasOwn(options, key) || !value || value.startsWith('--')) fail('USAGE');
    options[key] = value;
  }
  if (!options['--address'] || !options['--chain-id'] || !options['--out']) fail('USAGE');
  return options;
}

function parseDiff(args) {
  let json = false;
  const files = [];
  for (const value of args) {
    if (value === '--json') {
      if (json) fail('USAGE');
      json = true;
    } else {
      if (value.startsWith('--')) fail('USAGE');
      files.push(value);
    }
  }
  if (files.length !== 2) fail('USAGE');
  return { json, files };
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
      block: options['--block'], timeoutMs: timeout(options['--timeout-ms'])
    });
    await saveSnapshot(options['--out'], snapshot);
    process.stdout.write(`${snapshotReport(snapshot)}\nSnapshot saved.\n`);
    return;
  }
  if (args[0] === 'diff') {
    const { json, files } = parseDiff(args.slice(1));
    const before = await readSnapshot(files[0]);
    const after = await readSnapshot(files[1]);
    const report = json ? JSON.stringify(diffDocument(before, after), null, 2) : diffReport(before, after);
    process.stdout.write(`${report}\n`);
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
