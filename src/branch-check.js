import { createRpc } from './rpc.js';
import { createCapturePolicy } from './capture-policy.js';
import { data, quantity } from './validate.js';
import { canonicalHistoryJson } from './history.js';
import { fail } from './errors.js';

const ZERO = `0x${'0'.repeat(64)}`;
const equal = (a, b) => canonicalHistoryJson(a) === canonicalHistoryJson(b);

function header(value) {
  if (value === null) fail('BLOCK_UNAVAILABLE');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RPC_DATA');
  const result = { number: quantity(value.number), hash: data(value.hash, 32), parentHash: data(value.parentHash, 32) };
  if (result.hash === ZERO || (result.number === '0x0' ? result.parentHash !== ZERO : result.parentHash === ZERO)) fail('RPC_DATA');
  return result;
}

// One explicit provider, no latest lookup, state reads, retries or fallback.
// These are checked RPC header assertions, not independently hashed headers.
export async function checkBranch(identity, { endpoint, anchor, maxBlocks, timeoutMs, deadlineMs }, runtime = {}) {
  const policy = createCapturePolicy({ retries: 0, deadlineMs }, runtime);
  const rpc = createRpc(endpoint, timeoutMs, policy);
  let requests = 0;
  const read = async (method, params = []) => { requests++; return rpc(method, params); };
  const chain = async () => {
    const value = BigInt(quantity(await read('eth_chainId'))).toString();
    if (value !== identity.chainId) fail('CHAIN_MISMATCH');
    return value;
  };
  const byNumber = async number => header(await read('eth_getBlockByNumber', [number, false]));
  const byHash = async hash => {
    const value = header(await read('eth_getBlockByHash', [hash, false]));
    if (value.hash !== hash) fail('BRANCH_HEADERS');
    return value;
  };
  const startedAt = new Date().toISOString();
  const initialChain = await chain(), genesis = await byNumber('0x0');
  if (genesis.number !== '0x0' || genesis.hash !== identity.genesis.hash) fail('BRANCH_IDENTITY');
  const selected = await byHash(anchor), initialAnchor = await byNumber(selected.number);
  if (!equal(initialAnchor, selected)) fail('BLOCK_NOT_CANONICAL');
  const headers = [selected], seen = new Set([selected.hash]);
  while (headers.length < maxBlocks && headers.at(-1).number !== '0x0') {
    const child = headers.at(-1), parent = await byHash(child.parentHash);
    if (seen.has(parent.hash) || BigInt(parent.number) !== BigInt(child.number) - 1n) fail('BRANCH_HEADERS');
    seen.add(parent.hash); headers.push(parent);
  }
  // Even at the coverage boundary, an already known hash cannot be a new
  // parent at another height. Refuse contradictions without extending the walk.
  if (seen.has(headers.at(-1).parentHash)) fail('BRANCH_HEADERS');
  for (const value of headers) {
    if ((value.number === '0x0' && !equal(value, genesis)) ||
        (value.hash === genesis.hash && value.number !== '0x0') ||
        ((value.number === '0x1') !== (value.parentHash === genesis.hash))) fail('BRANCH_HEADERS');
  }
  const finalAnchor = await byNumber(selected.number);
  if (!equal(selected, finalAnchor)) fail('BLOCK_CHANGED');
  const finalGenesis = await byNumber('0x0');
  if (!equal(genesis, finalGenesis)) fail('GENESIS_CHANGED');
  const finalChain = await chain();
  policy.check();
  return { startedAt, completedAt: new Date().toISOString(), chainId: initialChain, genesisHash: genesis.hash,
    anchor: selected, headers, maxBlocks, requests,
    checks: { before: { chainId: initialChain, genesis, anchor: initialAnchor },
      after: { chainId: finalChain, genesis: finalGenesis, anchor: finalAnchor } } };
}
