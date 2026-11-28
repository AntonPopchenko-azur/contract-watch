import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { readBounded, parseHistoryJson } from './history-files.js';
import { canonicalHistoryJson } from './history.js';
import { address, chainId, data, quantity } from './validate.js';
import { validateEventBlock } from './event-check.js';
import { decodeEventLogs, MAX_EVENT_LOGS, MAX_EVENT_RESPONSE_BYTES } from './event-logs.js';
import { RANGE_LIMITS, rangeBounds, splitRange, hexNumber as hex } from './event-range-policy.js';
import { fail, WatchError, errorDetails } from './errors.js';

const ZERO = `0x${'0'.repeat(64)}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => canonicalHistoryJson(a) === canonicalHistoryJson(b);
const require = condition => { if (!condition) fail('CORRELATION_INPUT'); };
function keys(value, names) {
  require(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(','));
}
function integer(value, min, max) { require(Number.isSafeInteger(value) && value >= min && value <= max); }
function timestamp(value) {
  require(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value);
}

// A saved report can assert checks that never happened. This validates only its
// bounded internal consistency; neither flags nor a local digest authenticate it.
export function validateRangeReport(value) {
  try {
    keys(value, ['kind', 'schemaVersion', 'status', 'source', 'address', 'chainId', 'expectedGenesisHash',
      'range', 'completeness', 'coverageVerified', 'failure', 'pages', 'coverage', 'blocks', 'logs', 'verification', 'limits', 'caveats']);
    require(value.kind === 'contract-watch-event-range' && value.schemaVersion === 1 && value.status === 'complete' &&
      value.source === 'rpc' && value.completeness === 'unverified' && value.coverageVerified === true && value.failure === null);
    require(address(value.address) === value.address && chainId(value.chainId) === value.chainId &&
      data(value.expectedGenesisHash, 32) === value.expectedGenesisHash && value.expectedGenesisHash !== ZERO);
    keys(value.range, ['fromBlock', 'toBlock', 'toHash']);
    const { first, last, count } = rangeBounds(value.range.fromBlock, value.range.toBlock, true);
    require(hex(first) === value.range.fromBlock && hex(last) === value.range.toBlock &&
      data(value.range.toHash, 32) === value.range.toHash && value.range.toHash !== ZERO);
    const limits = value.limits;
    keys(limits, [...Object.keys(RANGE_LIMITS), 'maxPages', 'pageLogs', 'pageResponseBytes', 'timeoutMs', 'deadlineMs']);
    for (const [key, limit] of Object.entries(RANGE_LIMITS)) require(limits[key] === limit);
    require(limits.pageLogs === MAX_EVENT_LOGS && limits.pageResponseBytes === MAX_EVENT_RESPONSE_BYTES);
    integer(limits.maxPages, 1, RANGE_LIMITS.pages); integer(limits.timeoutMs, 100, 60000); integer(limits.deadlineMs, 100, 600000);
    require(Array.isArray(value.blocks) && value.blocks.length === count);
    const blocks = [], hashes = new Set(), transactions = new Set();
    for (const [i, raw] of value.blocks.entries()) {
      keys(raw, ['number', 'hash', 'timestamp', 'transactions', 'parentHash']);
      const block = { ...validateEventBlock(raw), parentHash: data(raw.parentHash, 32) };
      require(equal(block, raw) && block.number === hex(first + BigInt(i)) && !hashes.has(block.hash));
      require((block.number === '0x0') === (block.parentHash === ZERO) &&
        (block.number === '0x0') === (block.hash === value.expectedGenesisHash) &&
        (block.number === '0x1') === (block.parentHash === value.expectedGenesisHash));
      if (i) require(block.parentHash === blocks[i - 1].hash);
      hashes.add(block.hash);
      for (const tx of block.transactions) { require(!transactions.has(tx)); transactions.add(tx); }
      require(transactions.size <= RANGE_LIMITS.transactions); blocks.push(block);
    }
    require(blocks.at(-1).hash === value.range.toHash && !hashes.has(blocks[0].parentHash));
    const byNumber = new Map(blocks.map(block => [block.number, block]));
    require(Array.isArray(value.logs) && value.logs.length <= RANGE_LIMITS.uniqueLogs);
    const logs = [];
    for (const record of value.logs) {
      const rawKeys = ['address', 'blockHash', 'blockNumber', 'transactionHash', 'transactionIndex', 'logIndex', 'removed',
        'topics', 'data', ...(Object.hasOwn(record ?? {}, 'blockTimestamp') ? ['blockTimestamp'] : [])];
      keys(record, [...rawKeys, 'event', 'slot', 'arguments', 'valueWord', 'previousWord']);
      const block = byNumber.get(quantity(record.blockNumber)); require(block);
      const raw = Object.fromEntries(rawKeys.map(key => [key, record[key]]));
      const decoded = decodeEventLogs([raw], value.address, block)[0];
      require(equal(decoded, record));
      const prior = logs.at(-1);
      if (prior) require(BigInt(decoded.blockNumber) > BigInt(prior.blockNumber) ||
        decoded.blockNumber === prior.blockNumber && BigInt(decoded.logIndex) > BigInt(prior.logIndex) &&
        BigInt(decoded.transactionIndex) >= BigInt(prior.transactionIndex));
      logs.push(decoded);
    }
    require(Array.isArray(value.pages) && value.pages.length >= 1 && value.pages.length <= limits.maxPages);
    const descriptors = [{ id: 1, parentId: null, depth: 0, fromBlock: hex(first), toBlock: hex(last) }], pending = [1];
    const leaves = new Map(); let attempts = 0, received = 0, duplicates = 0;
    while (pending.length) {
      const id = pending.pop(), expected = descriptors[id - 1], page = value.pages[id - 1];
      keys(page, ['id', 'parentId', 'depth', 'fromBlock', 'toBlock', 'status', 'attempt', 'returnedLogs', 'duplicates', 'anchorBefore', 'anchorAfter', 'error']);
      for (const [key, v] of Object.entries(expected)) require(page[key] === v);
      require(page.depth <= RANGE_LIMITS.depth && page.attempt === ++attempts && page.anchorBefore === true && page.anchorAfter === true);
      const a = BigInt(page.fromBlock), b = BigInt(page.toBlock);
      if (page.status === 'split') {
        require(page.returnedLogs === null && page.duplicates === null &&
          equal(page.error, errorDetails(new WatchError('RANGE_PROVIDER_LIMIT'))));
        const children = splitRange(a, b).map(([lo, hi]) => {
          const child = { id: descriptors.length + 1, parentId: id, depth: page.depth + 1, fromBlock: hex(lo), toBlock: hex(hi) };
          descriptors.push(child); return child.id;
        });
        require(descriptors.length <= value.pages.length); pending.push(children[1], children[0]);
      } else {
        const found = logs.filter(log => BigInt(log.blockNumber) >= a && BigInt(log.blockNumber) <= b);
        integer(page.returnedLogs, 0, MAX_EVENT_LOGS); integer(page.duplicates, 0, MAX_EVENT_LOGS);
        require(page.error === null && page.returnedLogs === found.length + page.duplicates &&
          (found.length > 0 || page.duplicates === 0) && page.status === (page.returnedLogs ? 'read' : 'read-empty'));
        received += page.returnedLogs; duplicates += page.duplicates;
        for (let n = a; n <= b; n++) {
          require(!leaves.has(hex(n)));
          const uniqueLogs = found.filter(log => log.blockNumber === hex(n)).length;
          leaves.set(hex(n), { number: hex(n), status: uniqueLogs ? 'read' : 'read-empty', pageId: id, uniqueLogs });
        }
      }
    }
    require(descriptors.length === value.pages.length && attempts === value.pages.length && received <= RANGE_LIMITS.receivedLogs);
    require(equal(value.coverage, blocks.map(block => leaves.get(block.number))));
    const verification = value.verification;
    keys(verification, ['startedAt', 'completedAt', 'phase', 'requests', 'logRequests', 'responseBytes',
      'receivedLogs', 'duplicateLogs', 'rangeSha256', 'chainGenesisRechecked']);
    timestamp(verification.startedAt); timestamp(verification.completedAt);
    integer(verification.responseBytes, 1, RANGE_LIMITS.responseBytes);
    require(verification.phase === 'complete' && verification.requests === 2 * count + 5 + 3 * attempts &&
      verification.requests <= RANGE_LIMITS.requests && verification.logRequests === attempts &&
      verification.receivedLogs === received && verification.duplicateLogs === duplicates &&
      verification.rangeSha256 === digest(JSON.stringify(blocks)) && verification.chainGenesisRechecked === true);
    // Human caveats are bounded but never re-emitted or used as verification.
    require(Array.isArray(value.caveats) && value.caveats.length === 5 &&
      value.caveats.every(text => typeof text === 'string' && text.length >= 1 && text.length <= 512));
    return { address: value.address, chainId: value.chainId, genesisHash: value.expectedGenesisHash,
      range: value.range, blocks, logs, rangeSha256: verification.rangeSha256 };
  } catch { fail('CORRELATION_INPUT'); }
}

const metadata = stat => Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(k => [k, stat[k].toString()]));
export async function readRangeFile(path) {
  try {
    const before = metadata(await lstat(path, { bigint: true }));
    const bytes = await readBounded(path, RANGE_LIMITS.reportBytes, 'CORRELATION_INPUT');
    const after = metadata(await lstat(path, { bigint: true }));
    require(equal(before, after));
    return { evidence: validateRangeReport(parseHistoryJson(bytes, 'CORRELATION_INPUT')),
      sha256: digest(bytes), bytes: bytes.length, metadata: after };
  } catch { fail('CORRELATION_INPUT'); }
}

export async function recheckRangeFile(path, prior) {
  try {
    const final = await readRangeFile(path);
    require(final.sha256 === prior.sha256 && final.bytes === prior.bytes && equal(final.metadata, prior.metadata));
  } catch { fail('CORRELATION_CHANGED'); }
}
