import { createHash } from 'node:crypto';
import { address, chainId, blockHash, quantity, data, rpcUrl, timeout, deadline } from './validate.js';
import { configuredEndpoint } from './config.js';
import { createRpc, MAX_RESPONSE_BYTES } from './rpc.js';
import { createCapturePolicy } from './capture-policy.js';
import { SLOTS, ZERO_WORD } from './snapshot.js';
import { slotDetails } from './report.js';
import { decodeEventLogs, compareEventSlots, MAX_BLOCK_TRANSACTIONS, MAX_EVENT_LOGS, MAX_EVENT_RESPONSE_BYTES } from './event-logs.js';
import { checkCancellation } from './cancellation.js';
import { fail } from './errors.js';

export const MAX_EVENT_REPORT_BYTES = 1024 * 1024;
export function eventCheckJson(document) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_EVENT_REPORT_BYTES) fail('EVENT_REPORT_SIZE');
  return text;
}

function options(input) {
  if ((input.rpc === undefined) === (input.rpcEnv === undefined)) fail('USAGE');
  const target = address(input.address), expected = chainId(input.chainId);
  const hash = blockHash(input.blockHash), genesis = blockHash(input.genesisHash);
  if (hash === ZERO_WORD || genesis === ZERO_WORD) fail('BLOCK_HASH');
  if (input.rpcEnv !== undefined && (typeof input.rpcEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(input.rpcEnv))) fail('USAGE');
  if (input.rpc !== undefined) rpcUrl(input.rpc);
  const ms = input.timeoutMs ?? '10000';
  if (typeof ms !== 'string' || !/^[1-9][0-9]{2,4}$/.test(ms)) fail('TIMEOUT_OPTION');
  return { target, expected, hash, genesis, timeoutMs: timeout(ms), deadlineMs: deadline(input.deadlineMs ?? '30000') };
}

function header(value) {
  if (value === null) fail('BLOCK_UNAVAILABLE');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RPC_DATA');
  const result = { number: quantity(value.number), hash: data(value.hash, 32) };
  if (result.hash === ZERO_WORD) fail('RPC_DATA');
  return result;
}

function selectedBlock(value) {
  const block = { ...header(value), timestamp: quantity(value.timestamp) };
  if (!Array.isArray(value.transactions)) fail('EVENT_BLOCK');
  if (value.transactions.length > MAX_BLOCK_TRANSACTIONS) fail('EVENT_LIMIT');
  block.transactions = value.transactions.map(hash => data(hash, 32));
  if (block.transactions.includes(ZERO_WORD) || new Set(block.transactions).size !== block.transactions.length) fail('EVENT_BLOCK');
  return block;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function blockEvidence(block) {
  const { transactions, ...header } = block;
  return { ...header, transactionsSha256: createHash('sha256').update(JSON.stringify(transactions)).digest('hex') };
}

export async function crossCheckEvents(input, environment = process.env, runtime = {}) {
  const config = options(input);
  checkCancellation(runtime.signal); runtime.check?.();
  const policy = createCapturePolicy({ retries: 0, deadlineMs: config.deadlineMs }, runtime);
  return policy.guard(async () => {
    const endpoint = input.rpc ?? configuredEndpoint(input.rpcEnv, environment);
    const rpc = createRpc(endpoint, config.timeoutMs, policy, { strictJson: true });
    const startedAt = new Date().toISOString();
    const chain = async () => {
      const actual = BigInt(quantity(await rpc('eth_chainId'))).toString();
      if (actual !== config.expected) fail('CHAIN_MISMATCH');
      return actual;
    };
    const genesis = async () => {
      const found = header(await rpc('eth_getBlockByNumber', ['0x0', false]));
      if (found.number !== '0x0') fail('RPC_DATA');
      return found;
    };
    const initialChain = await chain(), initialGenesis = await genesis();
    if (initialGenesis.hash !== config.genesis) fail('EVENT_GENESIS');
    const block = selectedBlock(await rpc('eth_getBlockByHash', [config.hash, false]));
    if (block.hash !== config.hash) fail('RPC_DATA');
    if ((block.number === '0x0') !== (block.hash === config.genesis)) fail('EVENT_BLOCK');
    const initialBlock = selectedBlock(await rpc('eth_getBlockByNumber', [block.number, false]));
    if (!same(initialBlock, block)) fail('BLOCK_NOT_CANONICAL');
    const slots = {}, selector = { blockHash: block.hash, requireCanonical: true };
    for (const [name, position] of Object.entries(SLOTS)) slots[name] = slotDetails(data(await rpc('eth_getStorageAt', [config.target, position, selector]), 32));
    const logs = decodeEventLogs(await rpc.eip1967Logs(config.target, block.hash), config.target, block);
    const finalBlock = selectedBlock(await rpc('eth_getBlockByNumber', [block.number, false]));
    if (!same(finalBlock, block)) fail('BLOCK_CHANGED');
    const finalGenesis = await genesis();
    if (!same(initialGenesis, finalGenesis)) fail('GENESIS_CHANGED');
    const finalChain = await chain();
    const comparisons = compareEventSlots(logs, slots);
    const { transactions, ...point } = block;
    return { kind: 'contract-watch-event-cross-check', schemaVersion: 1, source: 'rpc',
      address: config.target, chainId: config.expected, genesis: { status: 'observed', hash: initialGenesis.hash },
      block: point, storageState: 'end-of-block', slots, transactions, logs, comparisons,
      selection: 'last-returned-event-per-slot', completeness: 'unverified',
      verification: { startedAt, completedAt: new Date().toISOString(), requests: 11,
        before: { chainId: initialChain, genesis: initialGenesis, block: blockEvidence(initialBlock) },
        after: { chainId: finalChain, genesis: finalGenesis, block: blockEvidence(finalBlock) } },
      limits: { blockSpan: 1, maxLogs: MAX_EVENT_LOGS, maxTransactions: MAX_BLOCK_TRANSACTIONS,
        logResponseBytes: MAX_EVENT_RESPONSE_BYTES, rpcResponseBytes: MAX_RESPONSE_BYTES,
        reportBytes: MAX_EVENT_REPORT_BYTES, timeoutMs: config.timeoutMs, deadlineMs: config.deadlineMs },
      caveats: [
        'Agreement compares the last returned event value per slot to end-of-block storage from one RPC; completeness and provider honesty are unverified.',
        'Earlier returned events are retained but not compared to final storage. Absent or omitted events cannot establish that no changes occurred.',
        'Admin previous values are only checked against the preceding returned admin event; the first previous value is not verified against prior storage.',
        'BeaconUpgraded concerns the proxy beacon slot, not an implementation change inside a beacon. No beacon call or implementation-code read is performed.',
        'Matching identity and canonical checks are finite provider assertions, not consensus, finality, header/state/receipt proofs or contract safety.',
        'Only this block is covered. No prior snapshots or history are read or changed; this separate stdout report is not persisted or authenticated.'
      ] };
  });
}
