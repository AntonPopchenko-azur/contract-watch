import { address, data, quantity } from './validate.js';
import { fail, WatchError } from './errors.js';

// EIP-1967 event ABI; these are signature Keccak-256 topics, not selectors.
export const EVENTS = Object.freeze([
  Object.freeze({ name: 'Upgraded', slot: 'implementation', topic: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b' }),
  Object.freeze({ name: 'AdminChanged', slot: 'admin', topic: '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f' }),
  Object.freeze({ name: 'BeaconUpgraded', slot: 'beacon', topic: '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e' })
]);
export const MAX_EVENT_LOGS = 256;
export const MAX_EVENT_RESPONSE_BYTES = 256 * 1024;
export const MAX_BLOCK_TRANSACTIONS = 4096;
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const KEYS = ['address', 'blockHash', 'blockNumber', 'transactionHash', 'transactionIndex', 'logIndex', 'removed', 'topics', 'data'];
const compare = (a, b) => BigInt(a.logIndex) < BigInt(b.logIndex) ? -1 : BigInt(a.logIndex) > BigInt(b.logIndex) ? 1 : 0;

function addressWord(word) {
  if (!/^0x0{24}[0-9a-f]{40}$/.test(word)) fail('EVENT_LOG');
  return `0x${word.slice(-40)}`;
}

// Require the complete mined provenance subset, with only the documented
// optional blockTimestamp. Normalize hex casing but never truncate an ABI word.
export function decodeEventLogs(result, target, block) {
  try {
    if (!Array.isArray(result)) fail('EVENT_LOG');
    if (result.length > MAX_EVENT_LOGS) fail('EVENT_LIMIT');
    const logs = result.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('EVENT_LOG');
      const timestamp = Object.hasOwn(value, 'blockTimestamp');
      if (Object.keys(value).sort().join(',') !== [...KEYS, ...(timestamp ? ['blockTimestamp'] : [])].sort().join(',')) fail('EVENT_LOG');
      const emitter = address(value.address), blockHash = data(value.blockHash, 32), blockNumber = quantity(value.blockNumber);
      const transactionHash = data(value.transactionHash, 32), transactionIndex = quantity(value.transactionIndex), logIndex = quantity(value.logIndex);
      if (value.removed !== false || emitter !== target || blockHash !== block.hash || blockNumber !== block.number ||
          transactionHash === ZERO_HASH || BigInt(transactionIndex) >= BigInt(block.transactions.length) ||
          block.transactions[Number(BigInt(transactionIndex))] !== transactionHash) fail('EVENT_LOG');
      const blockTimestamp = timestamp ? quantity(value.blockTimestamp) : undefined;
      if (timestamp && blockTimestamp !== block.timestamp) fail('EVENT_LOG');
      if (!Array.isArray(value.topics) || value.topics.length < 1 || value.topics.length > 2) fail('EVENT_LOG');
      const topics = value.topics.map(topic => data(topic, 32));
      const event = EVENTS.find(event => event.topic === topics[0]);
      if (!event) fail('EVENT_LOG');
      const admin = event.slot === 'admin';
      if (topics.length !== (admin ? 1 : 2)) fail('EVENT_LOG');
      const encoded = data(value.data, admin ? 64 : 0);
      const previous = admin ? `0x${encoded.slice(2, 66)}` : null;
      const word = admin ? `0x${encoded.slice(66)}` : topics[1];
      const args = admin ? { previousAdmin: addressWord(previous), newAdmin: addressWord(word) }
        : { [event.slot]: addressWord(word) };
      return { address: emitter, blockHash, blockNumber, transactionHash, transactionIndex, logIndex,
        removed: false, ...(timestamp ? { blockTimestamp } : {}), topics, data: encoded,
        event: event.name, slot: event.slot, arguments: args, valueWord: word, previousWord: previous };
    }).sort(compare);
    for (let i = 1; i < logs.length; i++) {
      // Global log ordinals cannot be duplicated, including identical repeats.
      if (logs[i].logIndex === logs[i - 1].logIndex ||
          BigInt(logs[i].transactionIndex) < BigInt(logs[i - 1].transactionIndex)) fail('EVENT_LOG');
    }
    return logs;
  } catch (error) {
    if (error instanceof WatchError && error.code === 'EVENT_LIMIT') throw error;
    fail('EVENT_LOG');
  }
}

// End-of-block storage is compared only with the last returned event per slot.
// Earlier emitted values remain evidence, never standalone endpoint comparisons.
export function compareEventSlots(logs, slots) {
  return EVENTS.map(event => {
    const related = logs.filter(log => log.slot === event.slot), last = related.at(-1);
    const gaps = related.slice(1).filter((log, i) => event.slot === 'admin' && log.previousWord !== related[i].valueWord).map(log => log.logIndex);
    let status = 'unavailable', reason = 'NO_RETURNED_EVENT';
    if (last) {
      if (gaps.length) reason = 'ADMIN_SEQUENCE_GAP';
      else if (slots[event.slot].status === 'noncanonical') reason = 'NONCANONICAL_SLOT';
      else {
        status = last.valueWord === slots[event.slot].raw ? 'agreement' : 'disagreement';
        reason = status === 'agreement' ? 'LAST_RETURNED_VALUE_MATCHES' : 'LAST_RETURNED_VALUE_DIFFERS';
      }
    }
    return { slot: event.slot, event: event.name, status, reason, eventCount: related.length,
      selectedLogIndex: last?.logIndex ?? null, selectedValueWord: last?.valueWord ?? null,
      earlierLogIndexes: related.slice(0, -1).map(log => log.logIndex), adminSequenceGaps: gaps };
  });
}
