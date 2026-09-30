const messages = {
  USAGE: 'Invalid command or options. Run contract-watch --help.',
  ADDRESS: 'Address must be 0x followed by exactly 40 hexadecimal digits.',
  CHAIN_ID: 'Chain ID must be a positive decimal or hexadecimal integer of at most 256 bits.',
  BLOCK: 'Block must be latest, safe, finalized, or a nonnegative decimal/hexadecimal integer.',
  RPC_URL: 'RPC URL must use HTTP(S), without embedded credentials or a fragment.',
  TIMEOUT_OPTION: 'Timeout must be an integer from 100 to 60000 milliseconds.',
  RPC_TIMEOUT: 'RPC request exceeded its time limit.',
  RPC_NETWORK: 'RPC connection failed.',
  RPC_HTTP: 'RPC returned an unsuccessful HTTP status; redirects are not followed.',
  RPC_SIZE: 'RPC response exceeded the 1 MiB limit.',
  RPC_ENCODING: 'RPC returned an unsupported content encoding.',
  RPC_ENVELOPE: 'RPC returned an invalid JSON-RPC response.',
  RPC_REMOTE: 'RPC rejected a read request. Check chain availability, historical state, and EIP-1898 support.',
  RPC_DATA: 'RPC returned malformed chain, block, bytecode, or storage data.',
  CHAIN_MISMATCH: 'RPC chain ID does not match the requested chain ID.',
  BLOCK_UNAVAILABLE: 'Requested block is unavailable.',
  BLOCK_CHANGED: 'The pinned block is no longer canonical. Capture a fresh snapshot.',
  SNAPSHOT: 'Invalid or unsupported snapshot; expected the documented version 1 format.',
  FILE_READ: 'Cannot read snapshot as a regular file (maximum 512 KiB).',
  FILE_WRITE: 'Cannot save snapshot. Check the destination directory and permissions.',
  FILE_EXISTS: 'Destination already exists; choose a new snapshot filename.',
  INCOMPARABLE: 'Snapshots must have the same chain ID, address, and source kind.',
  ORDER: 'The second snapshot must be at the same or a later block height.',
  INTERNAL: 'Unexpected local failure.'
};

export class WatchError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.INTERNAL);
    this.name = 'WatchError';
    this.code = Object.hasOwn(messages, code) ? code : 'INTERNAL';
  }
}

export function fail(code) { throw new WatchError(code); }

// Never display third-party exception messages, URLs, filesystem paths, or stacks.
export function publicError(error) {
  const safe = error instanceof WatchError ? new WatchError(error.code) : new WatchError('INTERNAL');
  return `Error [${safe.code}]: ${safe.message}`;
}
