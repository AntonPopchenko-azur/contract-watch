import { createHash } from 'node:crypto';
import { readBounded } from './history-files.js';
import { parseStrictJson } from './strict-json.js';
import { validateSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_V4_BYTES } from './snapshot.js';
import { address, data } from './validate.js';
import { codeDetails } from './report.js';
import { fail } from './errors.js';

// EIP-1167 Specification: only the exact deployed 45-byte PUSH20 form.
// The vanity PUSHn optimization and other runtimes are deliberately unsupported.
const PREFIX = '363d3d373d3d3d363d73';
const SUFFIX = '5af43d82803e903d91602b57fd5bf3';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
export const MAX_MINIMAL_PROXY_REPORT_BYTES = 8 * 1024;

export function matchMinimalProxy(code, target) {
  try {
    if (data(code) !== code || address(target) !== target) fail('MINIMAL_PROXY_INPUT');
    if (code === '0x') return { status: 'empty-code', delegateTarget: null };
    if (code.length !== 92 || code.slice(2, 22) !== PREFIX || code.slice(62) !== SUFFIX) {
      return { status: 'no-supported-match', delegateTarget: null };
    }
    // Slice all twenty bytes; never parse the address through an integer.
    const extracted = `0x${code.slice(22, 62)}`;
    return { status: 'matched', delegateTarget: { address: extracted,
      zeroAddress: extracted === ZERO_ADDRESS, selfReference: extracted === target,
      provenance: { field: 'code', firstByte: 10, lastByte: 29 },
      availability: 'unverified', behavior: 'unverified' } };
  } catch { fail('MINIMAL_PROXY_INPUT'); }
}

export async function analyzeMinimalProxy(path) {
  if (typeof path !== 'string' || !path) fail('USAGE');
  try {
    const bytes = await readBounded(path, MAX_SNAPSHOT_V4_BYTES, 'MINIMAL_PROXY_INPUT');
    const value = validateSnapshot(parseStrictJson(bytes, 'MINIMAL_PROXY_INPUT'));
    if (value.schemaVersion === 1 && bytes.length > MAX_SNAPSHOT_BYTES) fail('MINIMAL_PROXY_INPUT');
    const match = matchMinimalProxy(value.code, value.address);
    return { kind: 'contract-watch-minimal-proxy', schemaVersion: 1, mode: 'offline', source: value.source,
      snapshot: { schemaVersion: value.schemaVersion, capturedAt: value.capturedAt,
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, migration: value.migration ?? null },
      address: value.address, chainId: value.chainId, block: value.block,
      genesis: value.genesis ?? { status: 'not-recorded' },
      pattern: { id: 'eip-1167-standard-runtime', runtimeBytes: 45, firstTargetByte: 10, lastTargetByte: 29 },
      evidence: { field: 'code', ...codeDetails(value.code), matchedRuntime: match.status === 'matched' ? value.code : null },
      ...match, implementationObservation: 'not-analyzed', traversal: 'not-performed',
      caveats: [
        'This is an exact match of saved target code to one supported runtime, not an execution test or independent authentication of the snapshot.',
        'No supported match does not establish that the target is not a proxy. Vanity PUSHn, PUSH0, other runtimes, creation code and appended data are not recognized.',
        'The extracted address preserves all twenty bytes, including zero and self references. Its availability, code and behavior are not checked or inferred from a separate implementation observation.',
        'Source, chain, block and recorded genesis are saved claims; unknown genesis stays unknown. No ancestry, current canonicality, finality, history, upgrade or safety conclusion follows.',
        'No RPC, environment discovery, target fetch, execution, migration or recursive proxy traversal occurs. The input is read only; synthetic evidence remains synthetic.'
      ] };
  } catch { fail('MINIMAL_PROXY_INPUT'); }
}

export function minimalProxyJson(document) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_MINIMAL_PROXY_REPORT_BYTES) fail('MINIMAL_PROXY_REPORT');
  return text;
}
