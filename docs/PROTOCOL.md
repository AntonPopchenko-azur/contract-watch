# Protocol and snapshot format, version 1

## RPC sequence

1. Validate CLI input before opening a connection; normalize address and expected
   chain ID. Chain IDs and block numbers use `BigInt`, not floating point.
2. `eth_chainId` must match the requested positive chain ID.
3. `eth_getBlockByNumber` resolves a tag or number to a mined block's number and
   32-byte hash. A null block is an error. For a numeric request the returned
   number must match.
4. `eth_getCode` reads target code using the resolved hash selector.
5. Three `eth_getStorageAt` calls read implementation, admin, and beacon using
   that identical selector: `{ "blockHash": "0x…", "requireCanonical": true }`.
6. `eth_getBlockByNumber` at the resolved number verifies the same hash is still
   canonical, and `eth_chainId` is checked again.
7. Only after all checks succeed, save a complete snapshot.

The hash selector follows [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898).
It makes the state reads refer to the same block even across a head change.
The final recheck detects a reorg at that point, not permanent finality. An
unsupported selector, unavailable historical state, or provider error aborts
capture. No fallback, retry, batch, or write method is used.

The [EIP-1967](https://eips.ethereum.org/EIPS/eip-1967) positions are:

| Field | Position |
| --- | --- |
| implementation | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` |
| admin | `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103` |
| beacon | `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50` |

The standard gives the implementation slot precedence over the beacon slot.
Contract Watch retains both and labels simultaneous population as ambiguous.
Resolving the implementation behind a beacon requires a separate call and is
not part of 0.1.0. An admin slot may be absent; it is not a general authority map.

RPC quantities must be minimally encoded hex strings. Byte data must have a `0x`
prefix and even hex length. Storage words and block hashes must have exactly
32 bytes. Nonzero high bytes in an address slot are retained as anomalous data.
Response IDs must exactly match their requests, `jsonrpc` must be `2.0`, and
exactly one of `result` or `error` must be present. Provider error payloads are
discarded. See [Ethereum JSON-RPC](https://ethereum.org/en/developers/docs/apis/json-rpc/)
and [JSON-RPC 2.0](https://www.jsonrpc.org/specification) for method/envelope details.

## File contract

See [before.json](../examples/before.json) for a complete synthetic specimen.
Each object has exactly these keys; unknown or missing fields are rejected.

| Field | Required representation |
| --- | --- |
| `schemaVersion` | JSON number `1` |
| `source` | `rpc` or `synthetic`; a label, not proof of authenticity |
| `capturedAt` | UTC ISO timestamp with milliseconds from the local clock |
| `chainId` | Positive decimal string, canonical, at most 256 bits |
| `address` | Lowercase `0x` and 40 hex digits |
| `block.number` | Canonical lowercase hex quantity, at most 256 bits |
| `block.hash` | Lowercase 32-byte hex data |
| `code` | Lowercase even-length hex data, including empty `0x`; at most 128 KiB |
| `slots.implementation` | Lowercase 32-byte raw word |
| `slots.admin` | Lowercase 32-byte raw word |
| `slots.beacon` | Lowercase 32-byte raw word |

`block` and `slots` also accept only their documented keys. Derived labels,
decoded slot addresses and code fingerprints are computed when reporting, not
trusted from a file. No endpoint, provider error, key, arbitrary comment, or
filename is included in the format. `capturedAt` is not the block timestamp.

## Persistence and comparison

Saving writes a new, private temporary file in the destination directory, syncs
and closes it, and then creates a hard link at the requested destination.
This publishes complete content with no overwrite window. An existing file,
directory or symlink causes failure; temporary files are cleaned up on normal
success/failure. A crash can leave a dot-prefixed temporary file. This mechanism
requires filesystem hard-link support; it does not promise directory durability
after sudden power loss. Readers accept regular files and cap actual bytes read,
including when a file grows after opening.

Diff checks identity/source compatibility and nondecreasing block height. It
compares full bytecode and all three raw words. Code is rendered as byte length
and SHA-256 of decoded bytes; this fingerprint is not an EVM code hash. Local
capture time and a later block alone are not contract changes. Equal heights with
different hashes receive a possible-reorg notice. Equal hashes with different
content or heights receive an inconsistent-data notice. Neither notice proves
an upgrade or provides a safety judgment.

## JSON diff contract, version 1

`contract-watch diff [--json] BEFORE.json AFTER.json` reads only local files.
On success, `--json` writes one UTF-8 JSON object, indented by two spaces and
terminated by a newline, to stdout. Stderr is empty. It has no text preamble,
timestamps, filenames/paths, endpoint, remote errors, or raw bytecode. The flag
may also follow or appear between the filenames; repeated/unknown options are
usage errors. Use `./` for filenames starting with `--`.

This output schema is independent of the input snapshot schema and package
version. Consumers must check `kind` and `schemaVersion` before processing. All
fields below are always present in version 1. Existing field types, meanings and
enum values are stable; incompatible changes require a new schema version.
Consumers may ignore future extra object fields. Object key order is not a
parsing contract; the order of `changes` is fixed as documented below.

| Field | Type and meaning |
| --- | --- |
| `kind` | Literal string `contract-watch-diff` |
| `schemaVersion` | JSON number `1` |
| `chainId` | Canonical positive decimal string shared by both inputs |
| `address` | Shared lowercase 20-byte target address |
| `source` | Shared `rpc` or `synthetic` label; not proof of authenticity |
| `blocks.before`, `blocks.after` | Objects with `number` (canonical lowercase hex quantity string) and `hash` (lowercase 32-byte hex data) |
| `changed` | Boolean: true if and only if `changes` is nonempty |
| `changes` | Array of changed fields only, ordered `code`, `implementation`, `admin`, `beacon` |
| `notices` | Array of the fixed codes below; empty when neither condition applies |

Chain IDs and block numbers are strings, even for small values. No rounding to
JSON numbers occurs. Each change has `field`, `before`, and `after`:

- For `field: "code"`, both values are objects with `bytes` (nonnegative integer,
  at most 131072) and `sha256` (64 lowercase hex digits, without `0x`, over the
  decoded bytes). Differences are determined from full bytecode, not lengths or
  hashes. SHA-256 here is a reporting fingerprint, not an Ethereum code hash.
- For `implementation`, `admin`, or `beacon`, both values have `raw` (the complete
  lowercase 32-byte word), `status`, and `address`. Status is `empty` for a zero
  word, `address` for a nonzero word with zero high 12 bytes, or `noncanonical`
  otherwise. `address` is the lowercase 20-byte address only for status `address`;
  it is JSON `null` for `empty` and `noncanonical`. Raw anomalous data is preserved.

| Notice code | Condition and interpretation |
| --- | --- |
| `SAME_HEIGHT_DIFFERENT_HASH` | Same block number, different hashes: possible reorg, not evidence of an upgrade |
| `INCONSISTENT_BLOCK_DATA` | Same hash but different block numbers or compared state: check provider or file integrity |

The conditions are mutually exclusive in this version. A notice does not change
`changed` or the exit code. For example, unchanged state on same-height forked
blocks gives `changed: false`, `changes: []`, and
`notices: ["SAME_HEIGHT_DIFFERENT_HASH"]`. Absence of notices or changes is not a
safety rating and does not establish that no intermediate upgrade occurred.

Example of a successful unchanged comparison:

```json
{
  "kind": "contract-watch-diff",
  "schemaVersion": 1,
  "chainId": "1",
  "address": "0x1111111111111111111111111111111111111111",
  "source": "synthetic",
  "blocks": {
    "before": {
      "number": "0x64",
      "hash": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "after": {
      "number": "0x65",
      "hash": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  },
  "changed": false,
  "changes": [],
  "notices": []
}
```

Contract fixtures cover [changed](../test/fixtures/json-diff/changed.json),
[unchanged](../test/fixtures/json-diff/unchanged.json),
[forked](../test/fixtures/json-diff/forked.json), and
[incomparable](../test/fixtures/json-diff/incomparable.json) inputs. They also
preserve golden human output from the published baseline. These fixtures are
synthetic test cases, not additional input snapshot or output document formats.

Failure behavior is unchanged: incompatible chain/address/source gives
`INCOMPARABLE`, decreasing height gives `ORDER`, invalid snapshot content gives
`SNAPSHOT`, and unreadable files give `FILE_READ`. They exit **1**, leave stdout
empty, and print one fixed safe text error to stderr. There is no JSON error
envelope or partial result; input validation happens before output. Success,
including changes and notices, exits **0**. No new exit-code policy is introduced.
Snapshot version 1 and the default human report remain compatible.

## Error categories

| Codes | Meaning / action |
| --- | --- |
| `USAGE`, `ADDRESS`, `CHAIN_ID`, `BLOCK`, `RPC_URL`, `TIMEOUT_OPTION` | Correct local arguments; see `--help` |
| `CHAIN_MISMATCH` | Verify the expected chain and chosen endpoint |
| `RPC_TIMEOUT`, `RPC_NETWORK`, `RPC_HTTP` | Check provider reachability, credentials and configured timeout |
| `RPC_SIZE`, `RPC_ENCODING` | Response exceeds a bound or uses unsupported compression |
| `RPC_ENVELOPE`, `RPC_DATA` | Provider returned invalid protocol data |
| `RPC_REMOTE` | Read rejected; check EIP-1898, block availability and historical state support |
| `BLOCK_UNAVAILABLE`, `BLOCK_CHANGED` | Select an available block or capture again after a reorg |
| `FILE_READ`, `FILE_WRITE`, `FILE_EXISTS` | Use a valid local path and a new filename |
| `SNAPSHOT`, `INCOMPARABLE`, `ORDER` | Check schema, target identity, source and comparison order |
| `INTERNAL` | Unexpected local failure; reproduce with a synthetic fixture |

The public error boundary emits fixed messages only. HTTP and JSON-RPC remote
error bodies are never used as diagnostics. There is no debug flag that bypasses
this boundary.
