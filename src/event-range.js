import { createHash } from 'node:crypto';
import { setImmediate as turn } from 'node:timers/promises';
import { address, chainId, blockHash, data, quantity, rpcUrl, timeout, deadline } from './validate.js';
import { configuredEndpoint } from './config.js';
import { createRpc } from './rpc.js';
import { createCapturePolicy } from './capture-policy.js';
import { checkCancellation } from './cancellation.js';
import { validateEventBlock } from './event-check.js';
import { decodeEventLogs, MAX_EVENT_LOGS, MAX_EVENT_RESPONSE_BYTES } from './event-logs.js';
import { RANGE_LIMITS, rangeBounds, pageLimit, splitRange, rangeBudget, hexNumber as hex } from './event-range-policy.js';
import { fail, WatchError, errorDetails } from './errors.js';

const ZERO = `0x${'0'.repeat(64)}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function options(input) {
  if ((input.rpc === undefined) === (input.rpcEnv === undefined)) fail('USAGE');
  const target = address(input.address), expected = chainId(input.chainId);
  const genesis = blockHash(input.genesisHash), anchor = blockHash(input.toHash);
  if (genesis === ZERO || anchor === ZERO) fail('BLOCK_HASH');
  const bounds = rangeBounds(input.fromBlock, input.toBlock), maxPages = pageLimit(input.maxPages);
  if (input.rpcEnv !== undefined && (typeof input.rpcEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(input.rpcEnv))) fail('USAGE');
  if (input.rpc !== undefined) rpcUrl(input.rpc);
  const ms = input.timeoutMs ?? '10000';
  if (typeof ms !== 'string' || !/^[1-9][0-9]{2,4}$/.test(ms)) fail('TIMEOUT_OPTION');
  return { ...bounds, target, expected, genesis, anchor, maxPages, timeoutMs: timeout(ms), deadlineMs: deadline(input.deadlineMs ?? '30000') };
}

function genesisHeader(value) {
  if (value === null) fail('BLOCK_UNAVAILABLE');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RPC_DATA');
  const result = { number: quantity(value.number), hash: data(value.hash, 32), parentHash: data(value.parentHash, 32) };
  if (result.number !== '0x0' || result.hash === ZERO || result.parentHash !== ZERO) fail('RPC_DATA');
  return result;
}

function rangeBlock(value) {
  const block = { ...validateEventBlock(value), parentHash: data(value.parentHash, 32) };
  if ((block.number === '0x0') !== (block.parentHash === ZERO)) fail('BRANCH_HEADERS');
  return block;
}

// Every raw log is validated before deduplication, including its own page bounds.
// The old single-block decoder continues rejecting even identical duplicates.
export function decodeRangePage(raw, target, blocks, from, to) {
  if (!Array.isArray(raw)) fail('EVENT_LOG');
  if (raw.length > MAX_EVENT_LOGS) fail('EVENT_LIMIT');
  const unique = new Map();
  for (const value of raw) {
    let number;
    try { number = quantity(value?.blockNumber); } catch { fail('EVENT_LOG'); }
    if (BigInt(number) < from || BigInt(number) > to || !blocks.has(number)) fail('EVENT_LOG');
    const log = decodeEventLogs([value], target, blocks.get(number))[0];
    const key = `${log.blockHash}:${log.logIndex}`, prior = unique.get(key);
    if (prior && !same(prior, log)) fail('RANGE_DUPLICATE');
    unique.set(key, log);
  }
  const logs = [...unique.values()].sort((a, b) => {
    for (const key of ['blockNumber', 'logIndex']) if (a[key] !== b[key]) return BigInt(a[key]) < BigInt(b[key]) ? -1 : 1;
    return 0;
  });
  for (let i = 1; i < logs.length; i++) if (logs[i].blockNumber === logs[i - 1].blockNumber &&
      BigInt(logs[i].transactionIndex) < BigInt(logs[i - 1].transactionIndex)) fail('EVENT_LOG');
  return { logs, duplicates: raw.length - logs.length };
}

export function eventRangeJson(document) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > RANGE_LIMITS.reportBytes) fail('RANGE_REPORT');
  return text;
}

export async function readEventRange(input, environment = process.env, runtime = {}) {
  const config = options(input);
  checkCancellation(runtime.signal); runtime.check?.();
  const policy = createCapturePolicy({ retries: 0, deadlineMs: config.deadlineMs }, runtime);
  const endpoint = input.rpc ?? configuredEndpoint(input.rpcEnv, environment);
  const budget = rangeBudget(config.maxPages), pages = [], coverage = Array.from({ length: config.count }, (_, i) =>
    ({ number: hex(config.first + BigInt(i)), status: 'unread', pageId: null, uniqueLogs: null }));
  let activePage, phase = 'binding', receivedLogs = 0, duplicateLogs = 0;
  const rpc = createRpc(endpoint, config.timeoutMs, policy, { strictJson: true, budget: {
    beforeRequest(method) { budget.beforeRequest(method); if (method === 'eth_getLogs') activePage.attempt = budget.snapshot().logRequests; },
    receiveBytes: budget.receiveBytes
  } });
  const addPage = (first, last, parent = null) => {
    const page = { id: pages.length + 1, parentId: parent?.id ?? null, depth: parent ? parent.depth + 1 : 0,
      fromBlock: hex(first), toBlock: hex(last), status: 'unread', attempt: null, returnedLogs: null, duplicates: null,
      anchorBefore: false, anchorAfter: false, error: null };
    if (page.depth > RANGE_LIMITS.depth || pages.length === RANGE_LIMITS.pages) fail('RANGE_BUDGET');
    pages.push(page); return page;
  };
  const pending = [addPage(config.first, config.last)];
  const startedAt = new Date().toISOString();
  let blocks, initialGenesis, rangeSha256;
  const document = (status, failure = null) => ({ kind: 'contract-watch-event-range', schemaVersion: 1, status,
    source: 'rpc', address: config.target, chainId: config.expected, expectedGenesisHash: config.genesis,
    range: { fromBlock: hex(config.first), toBlock: hex(config.last), toHash: config.anchor },
    completeness: 'unverified', coverageVerified: status === 'complete', failure, pages, coverage,
    blocks: status === 'complete' ? [...blocks.values()] : null, logs: status === 'complete' ? collected : null,
    verification: { startedAt, completedAt: new Date().toISOString(), phase, ...budget.snapshot(), receivedLogs, duplicateLogs,
      rangeSha256: status === 'complete' ? rangeSha256 : null, chainGenesisRechecked: status === 'complete' },
    limits: { ...RANGE_LIMITS, maxPages: config.maxPages, pageLogs: MAX_EVENT_LOGS, pageResponseBytes: MAX_EVENT_RESPONSE_BYTES,
      timeoutMs: config.timeoutMs, deadlineMs: config.deadlineMs },
    caveats: [
      'Complete means every requested block has checked page coverage on the bound branch, not that the provider returned every matching log.',
      'Empty pages, gaps in filtered global log indices and successful pagination never establish absence of changes, provider honesty, consensus, finality or contract safety.',
      'Only the three proxy EIP-1967 events are collected. BeaconUpgraded concerns its beacon slot, not an implementation change inside a beacon.',
      'No storage, receipts, saved snapshots or history are read or correlated. No files or resumable checkpoint are written.',
      'Incomplete reports contain only an unverified coverage journal, never partial logs or a verified branch. An explicit rerun starts from the original inputs.'
    ] });
  let collected = [];
  try {
    return await policy.guard(async () => {
      const chain = async () => { if (BigInt(quantity(await rpc('eth_chainId'))).toString() !== config.expected) fail('CHAIN_MISMATCH'); };
      await chain(); initialGenesis = genesisHeader(await rpc('eth_getBlockByNumber', ['0x0', false]));
      if (initialGenesis.hash !== config.genesis) fail('EVENT_GENESIS');
      const anchor = rangeBlock(await rpc('eth_getBlockByHash', [config.anchor, false]));
      if (anchor.hash !== config.anchor || anchor.number !== hex(config.last)) fail('BRANCH_HEADERS');
      const confirm = async (block, code = 'BLOCK_CHANGED') => {
        const found = rangeBlock(await rpc('eth_getBlockByNumber', [block.number, false]));
        if (!same(found, block)) fail(code);
      };
      await confirm(anchor, 'BLOCK_NOT_CANONICAL');
      const descending = [anchor], hashes = new Set(), transactions = new Set();
      for (let i = 0; i < config.count; i++) {
        const block = descending[i];
        if (hashes.has(block.hash) || ((block.number === '0x0') !== (block.hash === config.genesis)) ||
            ((block.number === '0x1') !== (block.parentHash === config.genesis))) fail('BRANCH_HEADERS');
        hashes.add(block.hash);
        for (const tx of block.transactions) {
          if (transactions.has(tx)) fail('EVENT_BLOCK');
          transactions.add(tx);
          if (transactions.size > RANGE_LIMITS.transactions) fail('RANGE_TRANSACTIONS');
        }
        if (i + 1 < config.count) {
          const parent = rangeBlock(await rpc('eth_getBlockByHash', [block.parentHash, false]));
          if (parent.hash !== block.parentHash || BigInt(parent.number) !== BigInt(block.number) - 1n) fail('BRANCH_HEADERS');
          descending.push(parent);
        }
      }
      if (hashes.has(descending.at(-1).parentHash)) fail('BRANCH_HEADERS');
      blocks = new Map(descending.reverse().map(block => [block.number, block]));
      rangeSha256 = digest([...blocks.values()]);
      while (pending.length) {
        // A finite inter-page turn lets queued signals win before the next request.
        await turn(); policy.check();
        activePage = pending.pop();
        phase = 'before-page';
        if (budget.snapshot().logRequests === config.maxPages) fail('RANGE_PAGES');
        await confirm(anchor); activePage.anchorBefore = true;
        phase = 'page';
        let raw, decoded, limited = false;
        try { raw = await rpc.eip1967RangeLogs(config.target, activePage.fromBlock, activePage.toBlock); }
        catch (error) {
          if (!(error instanceof WatchError) || error.code !== 'RANGE_PROVIDER_LIMIT') throw error;
          limited = true;
        }
        if (!limited) {
          phase = 'page-validation';
          if (!Array.isArray(raw)) fail('EVENT_LOG');
          receivedLogs += raw.length; activePage.returnedLogs = raw.length;
          if (receivedLogs > RANGE_LIMITS.receivedLogs) fail('RANGE_LOGS');
          decoded = decodeRangePage(raw, config.target, blocks, BigInt(activePage.fromBlock), BigInt(activePage.toBlock));
          activePage.duplicates = decoded.duplicates;
          if (collected.length + decoded.logs.length > RANGE_LIMITS.uniqueLogs) fail('RANGE_LOGS');
        }
        phase = 'after-page';
        await confirm(anchor); activePage.anchorAfter = true;
        const first = BigInt(activePage.fromBlock), last = BigInt(activePage.toBlock);
        if (limited) {
          if (first === last) fail('RANGE_UNSPLITTABLE');
          const children = splitRange(first, last).map(([a, b]) => addPage(a, b, activePage));
          activePage.status = 'split'; activePage.error = errorDetails(new WatchError('RANGE_PROVIDER_LIMIT'));
          pending.push(children[1], children[0]);
        } else {
          // Leaves partition the input; a prior covered block indicates a bug or
          // overlap, never permission to publish a mixed/duplicated result.
          for (const entry of coverage.filter(c => BigInt(c.number) >= first && BigInt(c.number) <= last)) {
            if (entry.status !== 'unread') fail('RANGE_COVERAGE');
            entry.status = 'read-unverified'; entry.pageId = activePage.id;
            entry.uniqueLogs = decoded.logs.filter(log => log.blockNumber === entry.number).length;
          }
          collected.push(...decoded.logs); duplicateLogs += decoded.duplicates;
          Object.assign(activePage, { status: 'read-unverified', returnedLogs: raw.length, duplicates: decoded.duplicates });
        }
        activePage = undefined;
      }
      phase = 'final-checks';
      for (const block of blocks.values()) await confirm(block);
      if (!same(initialGenesis, genesisHeader(await rpc('eth_getBlockByNumber', ['0x0', false])))) fail('GENESIS_CHANGED');
      await chain();
      if (coverage.some(c => c.status !== 'read-unverified')) fail('RANGE_COVERAGE');
      policy.check();
      for (const page of pages) if (page.status === 'read-unverified') page.status = page.returnedLogs === 0 ? 'read-empty' : 'read';
      for (const entry of coverage) entry.status = entry.uniqueLogs === 0 ? 'read-empty' : 'read';
      phase = 'complete';
      return document('complete');
    });
  } catch (error) {
    checkCancellation(runtime.signal);
    // The guard can expire while building a result: never leave verified labels
    // on any incomplete output, even when all preceding checks had passed.
    for (const page of pages) if (['read', 'read-empty'].includes(page.status)) page.status = 'read-unverified';
    for (const entry of coverage) if (['read', 'read-empty'].includes(entry.status)) entry.status = 'read-unverified';
    const failure = errorDetails(error);
    if (activePage) {
      activePage.status = 'failed'; activePage.error = failure;
      for (const entry of coverage) if (BigInt(entry.number) >= BigInt(activePage.fromBlock) && BigInt(entry.number) <= BigInt(activePage.toBlock)) {
        entry.status = 'failed'; entry.pageId = activePage.id; entry.uniqueLogs = null;
      }
    }
    collected = [];
    return document('incomplete', { phase, ...failure });
  }
}
