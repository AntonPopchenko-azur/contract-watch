const messages = {
  USAGE: 'Invalid command or options. Run contract-watch --help.',
  CONFIG_READ: 'Cannot read a stable regular configuration file (maximum 16 KiB).',
  CONFIG: 'Invalid configuration; expected the strict version 1 target format.',
  CONFIG_TARGET: 'Selected target name is invalid or is not defined in the configuration.',
  CONFIG_ENV: 'Selected RPC environment reference is missing, empty or not a valid HTTP(S) endpoint.',
  WATCH_LIMIT: 'Watch requires a canonical interval of 100-60000 ms and count 1-128 or duration 100-600000 ms.',
  WATCH_DURATION: 'Watch duration reached; the current observation was not committed.',
  WATCH_EXISTS: 'Watch destination already exists; choose a new directory.',
  WATCH_DIRECTORY: 'Cannot create the watch directory; use an existing trusted writable parent.',
  WATCH_CANCELLED: 'Watch stopped; committed observations were retained and unfinished output was removed.',
  WATCH_CLEANUP: 'Watch output cleanup or close was incomplete; inspect the retained directory and retry in a new directory.',
  STABILITY_OPTION: 'Watch stable count must be a canonical decimal integer from 1 to 16.',
  STABILITY_INPUT: 'Invalid committed-observation sequence for the bounded watch policy.',
  BATCH_TARGETS: 'Batch capture requires 1 to 32 unique, explicitly selected targets.',
  BATCH_EXISTS: 'Batch output destination already exists; choose a new directory.',
  BATCH_DIRECTORY: 'Cannot create the batch output directory; use an existing writable parent.',
  CONCURRENCY: 'Batch concurrency must be an integer from 1 to 8, written as one decimal digit.',
  SHARED_BLOCK_UNAVAILABLE: 'The first selected member could not resolve this chain group\'s shared block.',
  SHARED_GENESIS_MISMATCH: 'RPC genesis identity does not match the shared block group\'s observed genesis.',
  ADDRESS: 'Address must be 0x followed by exactly 40 hexadecimal digits.',
  ADDRESS_CHECKSUM: 'Address must use its exact EIP-55 checksum casing.',
  CHAIN_ID: 'Chain ID must be a positive decimal or hexadecimal integer of at most 256 bits.',
  BLOCK: 'Block must be latest, safe, finalized, or a nonnegative decimal/hexadecimal integer.',
  BLOCK_HASH: 'Block hash must be 0x followed by exactly 64 hexadecimal digits.',
  DEPTH: 'Depth must be a canonical unsigned decimal integer from 0 to 2^256-1.',
  DEPTH_UNDERFLOW: 'Depth exceeds the initial latest block height.',
  RPC_URL: 'RPC URL must use HTTP(S), without embedded credentials or a fragment.',
  TIMEOUT_OPTION: 'Timeout must be an integer from 100 to 60000 milliseconds.',
  RETRIES_OPTION: 'Retries must be one decimal digit from 0 to 3.',
  DEADLINE_OPTION: 'Capture deadline must be a canonical decimal integer from 100 to 600000 milliseconds.',
  RETRIES_DEADLINE: 'Positive retries require an explicit capture deadline.',
  CAPTURE_DEADLINE: 'Capture exceeded its overall time limit.',
  CAPTURE_CANCELLED: 'Capture cancelled; owned output was removed.',
  CANCEL_CLEANUP: 'Capture cancelled; output cleanup was incomplete. Inspect the destination before reuse.',
  RETRY_CANCELLED: 'RPC retry wait was cancelled.',
  RPC_TIMEOUT: 'RPC request exceeded its time limit.',
  RPC_NETWORK: 'RPC connection failed.',
  RPC_HTTP: 'RPC returned an unsuccessful HTTP status; redirects are not followed.',
  RPC_SIZE: 'RPC response exceeded the 1 MiB limit.',
  RPC_ENCODING: 'RPC returned an unsupported content encoding.',
  RPC_ENVELOPE: 'RPC returned an invalid JSON-RPC response.',
  RPC_REMOTE: 'RPC rejected a read request. Check chain availability, historical state, and EIP-1898 support.',
  RPC_DATA: 'RPC returned malformed chain, block, bytecode, or storage data.',
  BEACON_RESULT: 'Beacon implementation() must return exactly one nonzero ABI-encoded address.',
  BEACON_SIZE: 'Beacon RPC response exceeded the 4 KiB limit.',
  CHAIN_MISMATCH: 'RPC chain ID does not match the requested chain ID.',
  BLOCK_UNAVAILABLE: 'Requested block is unavailable.',
  BLOCK_NOT_CANONICAL: 'Requested block hash is not canonical at its reported height.',
  BLOCK_CHANGED: 'The pinned block is no longer canonical. Capture a fresh snapshot.',
  GENESIS_CHANGED: 'RPC genesis identity changed during capture.',
  GENESIS_MISMATCH: 'Snapshots have different recorded genesis hashes; network identities do not match.',
  GENESIS_UNAVAILABLE: 'Genesis identity was not recorded in both snapshots; network equivalence is unknown.',
  SNAPSHOT: 'Invalid or unsupported snapshot; expected the documented version 1, 2, 3 or 4 format.',
  HISTORY_INPUT: 'Cannot read a stable, bounded snapshot v1, v2, v3 or v4 for history.',
  HISTORY_DIRECTORY: 'History requires an explicit trusted directory containing only its documented files.',
  HISTORY_EXISTS: 'History destination already exists; choose a new directory.',
  HISTORY_CORRUPT: 'History index or snapshot is missing, invalid, inconsistent or exceeds its byte limit.',
  HISTORY_IDENTITY: 'Snapshot target, chain, source, version or genesis does not match this history.',
  HISTORY_LIMIT: 'History capacity exceeded: at most 128 indexed observations and 512 directory entries.',
  HISTORY_CHANGED: 'History changed during this operation; verify it and retry explicitly.',
  HISTORY_RECOVERY: 'No matching pending observation exists; use history add for a new observation.',
  HISTORY_WRITE: 'History write or cleanup failed; verify the directory and recover explicitly before reuse.',
  RETENTION_KEEP: 'Retention requires --keep-last as a canonical decimal integer from 0 to 128; the first baseline is always kept.',
  RETENTION_PLAN: 'Retention plan does not match the verified source state and policy; preview again before applying.',
  RETENTION_DESTINATION: 'Retention requires a new output directory outside the source history in an existing trusted parent.',
  RETENTION_WRITE: 'Retention copy did not finish cleanly; preserve the source and inspect the destination before choosing a new output directory.',
  FILE_READ: 'Cannot read snapshot as a regular file (maximum 512 KiB for v1, 768 KiB for v2/v3/v4).',
  FILE_WRITE: 'Cannot save snapshot. Check the destination directory and permissions.',
  FILE_EXISTS: 'Destination already exists; choose a new snapshot filename.',
  INCOMPARABLE: 'Snapshots must have the same chain ID, address, and source kind.',
  DIFF_VERSION: 'Snapshots must use the same schema version; missing implementation observations cannot be inferred.',
  MIGRATION_VERSION: 'Migration target must be version 3 or 4; other targets and downgrades are unsupported.',
  MIGRATION_CURRENT: 'Snapshot already uses the requested version; no migration or output is needed.',
  MIGRATION_PATH: 'Migration requires a new output path; in-place migration is forbidden.',
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
export function errorDetails(error) {
  const safe = error instanceof WatchError ? new WatchError(error.code) : new WatchError('INTERNAL');
  return { code: safe.code, message: safe.message };
}

export function publicError(error) {
  const safe = errorDetails(error);
  return `Error [${safe.code}]: ${safe.message}`;
}
