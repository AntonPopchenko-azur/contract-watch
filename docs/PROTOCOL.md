# Protocol and snapshot formats

## Address checksum

`snapshot --strict-checksum` opts into exact
[EIP-55 address casing](https://eips.ethereum.org/EIPS/eip-55). First validate
`0x` plus exactly 40 ASCII hexadecimal digits. Hash the 40 lowercase hex
characters, encoded as ASCII **without `0x`**, using Ethereum Keccak-256. At each
letter position, uppercase the letter if the corresponding hash nibble is at
least 8, otherwise lowercase it. The original input must match the entire
canonical result. No blanket exception is made for all-lowercase or all-uppercase
input; either can be canonical. The all-zero address passes.

Syntax errors give `ADDRESS`; a well-formed address with wrong casing gives
`ADDRESS_CHECKSUM`. Both fail before RPC construction or file creation. The CLI
returns status 1 with empty stdout and fixed safe stderr, without the input or a
suggested address. Without the flag, the existing syntax-only validation accepts
any casing. The flag is valueless, allowed once only on `snapshot`; duplicates,
values and other commands give `USAGE`.

Checksum validation applies only to the input target. After validation it is
normalized to lowercase for RPC and snapshot v1. Stored addresses, raw slots,
inspect output, JSON diff v1 and existing exit policies retain their contracts.
The chain ID is not part of EIP-55 hashing; this option does not add EIP-1191.
A matching checksum does not establish ownership, chain identity or safety.

### Dependency decision and verification

The project retains Node.js 22+ and no runtime/development dependencies. The
local `src/keccak.js` implements byte-aligned Keccak-256 with 64-bit BigInt lanes,
24 Keccak-f[1600] rounds, a 136-byte rate, 512-bit capacity and little-endian lane
encoding. It uses legacy `0x01` padding and the final `0x80` bit, including a new
padding block for exact-rate inputs. SHA3-256 uses a different suffix (`0x06`)
and cannot substitute for this checksum. This avoids dependence on a native
addon or the host's available OpenSSL hash names. Production use is limited to
the validated 40-byte public address text; there is no signing or secret input.
Bytecode reports continue using Node's built-in SHA-256.

The [Keccak specification](https://keccak.team/keccak_specs_summary.html) supplies
the permutation, rotation offsets and round constants. `test/checksum.test.js`
contains all eight official EIP-55 vectors, single-letter case mutations and
independent hash results for empty input, `abc`, and byte sequences of lengths
1, 40, 135, 136, 137, 200, 272 and 273. For each sequence, byte `i` is `i % 256`.
These cover lane endianness, both padding edge cases and multiple blocks.

Expected digests were generated independently with the Keccak designers' CC0
`CompactFIPS202.py` reference using `Keccak(1088, 512, input, 0x01, 32)`. Its
[pinned source blob](https://api.github.com/repos/XKCP/XKCP/git/blobs/0b9608fc01852ea94182139890beca21b61b677a)
is stored in the XKCP repository under `Standalone/CompactFIPS202/Python/`.
The `abc` digest also matches the
[Go crypto TestKeccak vector](https://go.googlesource.com/crypto/+/c757c9851f77c470645455f548046ae0ce87ef8d/sha3/sha3_test.go).
Tests use the fixed results offline; they do not download or run another
implementation, and Python is not a project dependency. Local fake-RPC CLI
tests verify pre-network failure, no files after rejected input, lowercase
requests/persistence, default compatibility and offline inspect/diff behavior.

## Block selection

`snapshot --block-hash HASH` selects a block explicitly by its 32-byte hash.
The input must be `0x` followed by exactly 64 ASCII hex digits; uppercase/mixed
hex letters are accepted and normalized to lowercase. Syntax failures give
`BLOCK_HASH` before RPC construction or file creation. The prefix remains `0x`.
The flag takes exactly one value and cannot be repeated or combined with
`--depth` or any explicit `--block`, even `latest`. Conflicts, missing values,
equals-style arguments and use on `inspect`/`diff` give `USAGE`, with no RPC/file
side effects.

Without a hash or depth, the existing `--block` behavior is preserved: latest
by default, safe/finalized tags, or decimal/hex numbers up to 256 bits. A 64-digit hex value
passed via `--block` is still a number. No selector is inferred from string
length. Hash selection composes with the existing target checksum and RPC options.

The hash lookup follows
[eth_getBlockByHash](https://ethereum.org/developers/docs/apis/json-rpc/#eth_getblockbyhash)
with parameters `[normalizedHash, false]`. The boolean requests transaction
hashes instead of full objects; the response can still contain other block data.
Only the validated block number and hash are retained. All block lookup
responses remain subject to the existing 1 MiB cap. Snapshot v1 stores the same
lowercase `block.number` and `block.hash`; no schema or offline report changes
are needed.

### Depth selection

`snapshot --depth N` fixes a target at `initialLatestHeight - N`. The reference
height comes from the first `eth_getBlockByNumber` call with `['latest', false]`
after checking the expected chain ID. Depth 0 means that same observed head,
depth 1 means the preceding height, and depth equal to the head height means
genesis. This is a distance in blocks, not an inclusive confirmation count.

Before RPC construction, validate `N` as a string of at most 78 ASCII decimal
digits, matching `0` or a nonzero digit followed by digits, with value at most
`2^256-1`. Leading zeros, signs, whitespace, decimal points, exponents and hex
input are rejected with `DEPTH`. Parsing and subtraction use `BigInt` only.
Depth cannot be combined with any explicit `--block` or `--block-hash`.
Duplicates, conflicts, missing/empty values, equals-style options and other
commands give `USAGE`. Invalid inputs cause no RPC or file operations.

The initial head must contain a valid mined number and 32-byte hash. If N exceeds
its height, fail with `DEPTH_UNDERFLOW` after two RPC calls; do not clamp, retry
or wait. At depth 0 reuse this header. At positive depth fetch the target once
using its exact minimal hex number and `false`, and require the returned number
to match. Null latest/target headers give `BLOCK_UNAVAILABLE`; malformed headers
or a mismatched target number give `RPC_DATA`.

All state reads use the selected target's hash and `requireCanonical: true`.
The existing final canonical-block and chain checks apply. Never fetch another
`latest`, recompute the target, change selectors or fall back after an error.
The snapshot stores only its existing v1 block number/hash, without depth/head
metadata. This does not prove finality, ancestry back to the initial head, or
RPC honesty. A provider may have pruned the selected state.

## RPC sequence

1. Validate CLI input before opening a connection; normalize address and expected
   chain ID. Chain IDs and block numbers use `BigInt`, not floating point.
2. `eth_chainId` must match the requested positive chain ID.
3. `eth_getBlockByNumber` resolves a tag/number, or `eth_getBlockByHash` resolves
   an explicit hash, always with the second parameter `false`. A null block
   gives `BLOCK_UNAVAILABLE`. The returned number must be a valid minimal hex
   quantity (at most 256 bits) and the hash must be 32 bytes. Malformed or
   pending-shaped data gives `RPC_DATA`. For a numeric request the number must
   match; for a hash request the normalized returned hash must match.
   In hash mode only, an additional `eth_getBlockByNumber` with the returned
   number and `false` checks canonicality **before state reads**. A missing
   canonical header gives `BLOCK_UNAVAILABLE`, malformed data/wrong number gives
   `RPC_DATA`, and a different valid hash gives `BLOCK_NOT_CANONICAL`.
   In depth mode, first resolve `latest`, check underflow, then resolve the
   computed number for positive depth as described above; depth 0 reuses latest.
4. `eth_getCode` reads target code using the resolved hash selector.
5. Three `eth_getStorageAt` calls read implementation, admin, and beacon using
   that identical selector: `{ "blockHash": "0x…", "requireCanonical": true }`.
   With `--resolve-beacon`, eligible slot data triggers one bounded `eth_call`
   at this same hash, with strict ABI validation as specified below.
   With `--implementation-code`, the v2 selection policy below may instead add
   that call and one `eth_getCode`, or just the direct implementation code read.
6. `eth_getBlockByNumber` at the resolved number verifies the same hash is still
   canonical in every selection mode, and `eth_chainId` is checked again.
   A different number/hash on this final check gives `BLOCK_CHANGED`; missing
   or malformed metadata still fails. A changed chain gives `CHAIN_MISMATCH`.
7. Only after all checks succeed, save a complete snapshot.

The hash selector follows [EIP-1898](https://eips.ethereum.org/EIPS/eip-1898).
It makes the state reads refer to the same block even across a head change.
The final recheck detects a reorg at that point, not permanent finality. An
unsupported selector, unavailable historical state, or provider error aborts
capture. No fallback, retry, batch, or write method is used.

Before opt-in observations, successful tag/number captures and depth 0 make eight
sequential requests; hash selection and positive depth make nine. Their sum of request timeouts is
bounded by eight or nine times the configured per-request timeout, respectively.
An eligible beacon adds one request with timeout `min(timeoutMs, 5000)`: at most
9 requests / `8*T + min(T,5000)` ms for tags, numbers and depth 0, or 10 requests /
`9*T + min(T,5000)` ms for hash and positive depth, where T is the configured
timeout in ms. Skipped resolution adds zero requests.
This excludes local file work. Depth underflow stops after two requests; invalid
options make none. The generic allowlist remains chain, block-by-number/hash,
code and storage reads; only a dedicated beacon operation can use `eth_call`.
Provider errors (including
unsupported hash lookups, pruned state, noncanonical state or rejected EIP-1898 selectors) remain
fixed `RPC_REMOTE` errors without raw provider content. Any failure aborts
without saving a snapshot. Checking canonicality twice does not establish
permanent finality or independently authenticate a provider's block data.

The [EIP-1967](https://eips.ethereum.org/EIPS/eip-1967) positions are:

| Field | Position |
| --- | --- |
| implementation | `0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc` |
| admin | `0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103` |
| beacon | `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50` |

The standard gives the implementation slot precedence over the beacon slot.
Contract Watch retains both and labels simultaneous population as ambiguous.
Opt-in live resolution is described below. An admin slot may be absent; it is
not a general authority map.

RPC quantities must be minimally encoded hex strings. Byte data must have a `0x`
prefix and even hex length. Storage words and block hashes must have exactly
32 bytes. Nonzero high bytes in an address slot are retained as anomalous data.
Response IDs must exactly match their requests, `jsonrpc` must be `2.0`, and
exactly one of `result` or `error` must be present. Provider error payloads are
discarded. See [Ethereum JSON-RPC](https://ethereum.org/en/developers/docs/apis/json-rpc/)
and [JSON-RPC 2.0](https://www.jsonrpc.org/specification) for method/envelope details.

## Beacon resolution (live only)

`snapshot --resolve-beacon` is a valueless, snapshot-only opt-in. Unknown,
repeated or valued flags are `USAGE` errors before RPC. The default capture
returns the same v1 snapshot and performs no beacon call. Internally,
`captureWithBeacon` returns a separate `{ snapshot, beaconResolution }` result;
only `snapshot` may be passed to the existing file writer. The transient
resolution is printed only after all validation/rechecks and a successful save.

Eligibility is evaluated after reading target code and all raw storage words,
in this order. Ineligible cases are successful snapshots with an explicit skip:

| Condition | Result / additional requests |
| --- | --- |
| Empty target code | Skip `NO_TARGET_CODE` / 0 |
| Any slot has nonzero high 12 bytes, including admin | Skip `NONCANONICAL_SLOT` / 0 |
| Nonzero implementation slot (even with a nonzero beacon) | Skip `IMPLEMENTATION_SLOT_POPULATED` / 0 |
| Empty beacon slot | Skip `EMPTY_BEACON` / 0 |
| Otherwise | One fixed beacon call |

This follows [EIP-1967's beacon selection rule](https://eips.ethereum.org/EIPS/eip-1967#beacon-contract-address),
with additional conservative code/padding checks. Raw slots are never rewritten.
Both populated slots remain ambiguous; the program does not choose a proxy type.

The request uses [eth_call](https://ethereum.org/developers/docs/apis/json-rpc/#eth_call)
with exactly two parameters:

```text
{ from: TARGET, to: BEACON, gas: "0x186a0", value: "0x0", input: "0x5c60da1b" }
{ blockHash: PINNED_HASH, requireCanonical: true }
```

TARGET and BEACON are normalized addresses; BEACON comes from the observed
canonical slot. The caller is the target, the gas limit is fixed at 100000,
and input is the four-byte selector for `implementation()` with no arguments.
The [Solidity ABI](https://docs.soliditylang.org/en/latest/abi-spec.html) defines
the selector as the first four bytes of Keccak-256 of that signature and the
address return as a 32-byte word with 12 zero high bytes. Exactly one nonzero
address is required by this tool. Case-insensitive hex digits are normalized;
the prefix must be `0x`. Zero, wrong length, nonhex, nonzero padding and trailing
data give `BEACON_RESULT`. Synthetic ABI fixtures cover these cases.

The call's full HTTP response body is capped at 4096 bytes, including its JSON
envelope and any error data; declared and streamed excess gives `BEACON_SIZE`.
The normal 16 KiB header cap and no-redirect/no-compression policy still apply.
Its timeout, including headers/body, is `min(timeoutMs, 5000)` milliseconds.
Revert, out-of-gas, pruned state and unsupported EIP-1898 selectors are fixed
`RPC_REMOTE` errors; timeout is `RPC_TIMEOUT`. Invalid envelopes keep their
existing safe error. No provider payload or bad ABI input is echoed.

All state reads, including this call, use the identical EIP-1898 hash selector.
The final canonical-block and chain checks run after the call. Any fatal error
aborts capture without a snapshot or partial stdout. There is no gas estimation,
retry, selector fallback, caller sweep, recursion, additional bytecode lookup,
state override, signing or transaction submission. The generic RPC function
still rejects `eth_call`; the dedicated operation constructs its fixed payload.

The transient result has `status: resolved`, a beacon address, the normalized
raw return word and decoded implementation address, or `status: skipped` with
one of the reasons above. Resolved means that a valid response was observed;
it does not establish implementation code, proxy behavior, safety, finality or
caller independence. EIP-1967 says the response should not depend on the caller;
that property is not tested by one call.

No resolution field is added under snapshot schemaVersion 1. Existing strict
unknown-field checks, private atomic writes and offline v1 inspect/diff stay
unchanged. Offline reports have no live response to reproduce; JSON diff v1
continues comparing only code and raw slots. It cannot detect an implementation
change behind an unchanged beacon. The separate v2 mode below persists these
observations; beacon upgrade diffs and migration tooling remain deferred.

## File contract v1

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

## File contract v2

Only `snapshot --implementation-code` writes v2. The flag is valueless, accepted
once, snapshot-only, and mutually exclusive with `--resolve-beacon`. Violations
give `USAGE` before RPC or file work. The programmatic entry point is
`captureWithImplementation(options)` returning the snapshot itself. Existing
`capture` and `captureWithBeacon` retain their v1 contracts.

V2 has exactly the v1 top-level keys plus `implementation`, and `schemaVersion`
is the JSON number `2`. All common fields retain their representations and
meaning: `code` always belongs to `address`, never to the implementation.
Target and implementation bytecode each allow at most 131072 decoded bytes.
Unknown/missing fields, including on the observation object, are rejected.

After target code and all slots are read, apply these conditions in order:

| Condition | Observation / additional RPC |
| --- | --- |
| Target code is `0x` | `skipped`, `NO_TARGET_CODE` / 0 |
| Any slot has nonzero high 12 bytes, including admin | `skipped`, `NONCANONICAL_SLOT` / 0 |
| Both implementation and beacon slots are nonzero | `skipped`, `AMBIGUOUS_SLOTS` / 0 |
| Only implementation slot is nonzero | Direct implementation address / 1 code read |
| Only beacon slot is nonzero | Beacon return address / 1 bounded call + 1 code read |
| Both target slots empty, including admin-only evidence | `skipped`, `EMPTY_SLOTS` / 0 |

This policy is deliberately stricter than merely taking slot precedence in
[EIP-1967](https://eips.ethereum.org/EIPS/eip-1967#beacon-contract-address).
Every raw slot remains unchanged. Canonical nonzero addresses are only candidate
implementation observations, not confirmation of delegation behavior.

`implementation` is exactly one of the following shapes:

| Shape | Exact keys and values |
| --- | --- |
| Skipped | `status: "skipped"`, `reason`: the matching fixed reason above |
| Direct | `status`, `via: "implementation-slot"`, `address`, `code` |
| Beacon | `status`, `via: "beacon"`, `address`, `code`, `beacon`, `raw` |

For direct/beacon observations, `code` is lowercase even-length hex data;
`status` must be `"no-code"` exactly when code is `"0x"`, otherwise `"observed"`.
Direct `address` must equal the low 20 bytes of the canonical nonzero
implementation slot. Beacon `beacon` must match its canonical nonzero slot;
`raw` must be a lowercase, exactly 32-byte ABI word with zero high 12 bytes and
a nonzero address; `address` must equal its low 20 bytes. The direct slot must
be empty for this shape. All addresses use lowercase `0x` plus 40 hex digits.
Offline validation recomputes eligibility, skip reasons and address consistency
from the retained raw words; it cannot verify the provider or prove code is real.
Fingerprints are derived for display, never trusted as saved fields.

The beacon request is identical to the live-only operation above: fixed
`implementation()` input, target as `from`, zero value, 100000 gas, 4 KiB body
and deadline `min(T,5000 ms)`. Strict decoding errors remain fatal; a zero ABI
address is not a no-code observation. Only a valid address with an empty
`eth_getCode` result gets `no-code`.

The extra code request uses `[observedAddress, {blockHash, requireCanonical:true}]`
with the original hash, as specified for `eth_getCode` by
[EIP-1898](https://eips.ethereum.org/EIPS/eip-1898). Its ordinary 1 MiB HTTP body,
16 KiB header and `T` deadline limits remain. There is no arbitrary call, retry,
selector fallback, recursion or implementation storage lookup. A self-reference
still receives exactly one additional code read. All additional reads precede
the final canonical-block and chain checks; failures produce no new file and
no partial success output.

Starting from the base 8 requests (tag/number/depth 0) or 9 (hash/positive depth),
direct code adds 1 request / `T`, beacon code adds 2 / `T + min(T,5000)`, and
skips add none. Maximum successful capture: 11 requests and a sum of deadlines
`10*T + min(T,5000)` ms, excluding local work. Tests use loopback RPC only.

V1 files remain capped at 512 KiB; v2 files at 768 KiB, counting actual UTF-8
bytes including whitespace. Both maximum-size code blobs fit in a normal v2
serialization. The reader first caps allocation/actual reads at 768 KiB plus
one sentinel byte, then enforces the parsed version's limit (unknown versions
use the v1 limit). Invalid JSON exceeding 512 KiB gives `FILE_READ`; smaller
invalid JSON gives `SNAPSHOT`. Writers validate and check serialized byte length
before creating a temporary file. Atomic/private/no-overwrite behavior applies
to both versions.

V2 supports offline inspection and comparisons against another valid v2 file.
Mixed v1/v2 comparisons fail with `DIFF_VERSION`, exit 1, empty stdout and a
fixed safe stderr message, with or without `--json`/`--exit-code`. V1/v1 diff
and the independent JSON diff v1 schema are unchanged; v2/v2 produces JSON diff
v2 as specified below. See the [migration plan](MIGRATION.md) and its synthetic
compatibility fixtures. Migration tooling remains separate item 17.

## Offline inspection

`contract-watch inspect FILE` passes one file through the existing bounded
snapshot reader and strict version 1/2 validator, then prints the same text report
used by capture (without the save confirmation). It makes no RPC calls, ignores
`CONTRACT_WATCH_RPC_URL`, and does not write, migrate, or modify snapshot data.
Reading can update filesystem access metadata according to the operating system.

Only regular files up to 512 KiB (v1) or 768 KiB (v2) are accepted, including a
symlink resolving to a regular file. Directories, FIFOs, missing paths and broken
links give `FILE_READ`; corrupt JSON within the applicable limits, unsupported
versions, unknown/missing fields and invalid data give
`SNAPSHOT`. Existing code/word/quantity size and canonical-format checks apply.
No flags are accepted. Missing/extra/empty filenames or flag-like arguments give
`USAGE`; prefix filenames beginning with `-` with `./`.

Success is exit 0 with a complete report on stdout and no stderr. Failures are
exit 1 with empty stdout and a fixed safe error on stderr: no path, raw input,
endpoint or stack trace. The report identifies source, chain, address and pinned
block, including exact large integers. Empty slots/code and noncanonical words
retain their existing interpretations. A saved source label is not proof of
authenticity, and slot values do not prove proxy behavior, upgrades or safety.
Snapshot v1, JSON diff v1 and the existing diff exit policy are unchanged.
V2 reports label target and implementation bytecode separately and show address
provenance, the beacon raw result if present, or an explicit skip/no-code state.

## Persistence and comparison

Saving writes a new, private temporary file in the destination directory, syncs
and closes it, and then creates a hard link at the requested destination.
This publishes complete content with no overwrite window. An existing file,
directory or symlink causes failure; temporary files are cleaned up on normal
success/failure. A crash can leave a dot-prefixed temporary file. This mechanism
requires filesystem hard-link support; it does not promise directory durability
after sudden power loss. Readers accept regular files and cap actual bytes read,
including when a file grows after opening.

Diff first requires two strictly valid snapshots of the same version, then
checks identity/source compatibility and nondecreasing block height. It compares
full bytecode and all three raw words.
Code is rendered as byte length
and SHA-256 of decoded bytes; this fingerprint is not an EVM code hash. Local
capture time and a later block alone are not contract changes. Equal heights with
different hashes receive a possible-reorg notice. Equal hashes with different
content or heights receive an inconsistent-data notice. Neither notice proves
an upgrade or provides a safety judgment.
For v2 pairs, implementation observations are compared separately with the
availability/provenance policy below. Diff reads only local files, ignores RPC
configuration and does not modify inputs or fetch missing historical data.

## JSON diff contract, version 1

`contract-watch diff [--json] [--exit-code] BEFORE.json AFTER.json` reads only local files.
On success, `--json` writes one UTF-8 JSON object, indented by two spaces and
terminated by a newline, to stdout. Stderr is empty. It has no text preamble,
timestamps, filenames/paths, endpoint, remote errors, or raw bytecode. The flag
may also follow or appear between the filenames; repeated/unknown options are
usage errors. Use `./` for filenames starting with `--`.

This output schema is independent of the input snapshot schema and package
version. Two v1 snapshots select JSON diff v1; two v2 snapshots select JSON diff
v2. Consumers must check `kind` and `schemaVersion` before processing. All
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
envelope or partial result; input validation happens before output. By default,
success, including changes and notices, exits **0**. With `--exit-code`, a
successful comparison exits **2** exactly when `changed` is true, otherwise **0**.
Notices alone never trigger 2. Errors still exit **1**, even with this flag.

`--exit-code` is accepted once, only by `diff`, with no value, and can be combined
with `--json` in any position among the filenames. Duplicate or incompatible
flags give `USAGE` before reading files. Both text and JSON reports are identical
with and without this option. This JSON diff version accepts only v1 snapshots.
See the
[README shell example](../README.md) for handling status 2 safely under `set -e`.

## JSON diff contract, version 2

Two valid v2 snapshots produce `kind: "contract-watch-diff"`, `schemaVersion: 2`.
Both still need the same chain ID, target address and source kind, with the
earlier or equal-height block first. Validation precedes reporting, so unsupported
fields/versions and malformed provenance fail with `SNAPSHOT`; mixed valid v1/v2
fails with `DIFF_VERSION`; identity/source mismatch gives `INCOMPARABLE` and
decreasing height gives `ORDER`. These remain exit 1, empty stdout and fixed safe
stderr, even with both flags. There is no network access, input rewrite, schema
coercion or partial JSON. Existing file/code bounds and snapshot schemas remain.

V2 has all the top-level v1 diff keys plus `implementation`. `chainId`, `address`,
`source`, `blocks` and top-level `changes` retain their v1 representations.
Top-level `changes` contains target code and raw slot changes only, in the same
order (`code`, `implementation`, `admin`, `beacon`); the `implementation` change
field here means the raw **slot**, not the separate observation object.

The required top-level `implementation` object has exactly these current fields:

| Field | Meaning |
| --- | --- |
| `comparison` | `comparable`, `unavailable`, or `provenance-changed` |
| `before`, `after` | The sanitized saved observations described below, always present |
| `changes` | Comparable changes only, ordered `address`, then `code`; otherwise empty |

An endpoint with `status: "skipped"` has only `status` and its validated `reason`.
It has no address/code field, including no invented `null` or zero-byte code.
Other endpoints have `status` (`observed`/`no-code`), `via`, `address`, and `code`.
Beacon endpoints additionally have `beacon` and `raw`, retaining the validated
canonical ABI return word. These fields retain snapshot v2 meanings, except
`code` is a `{bytes, sha256}` summary with the same decoded-byte SHA-256 contract
as diff v1. The empty code summary is zero bytes and SHA-256 of empty bytes;
only `no-code` endpoints carry it. No raw bytecode, timestamps, paths, endpoint
URLs, provider messages or arbitrary input fields are emitted.

Determine comparison eligibility in this order:

1. Either endpoint is skipped: `unavailable`, with an empty implementation
   changes array, even when skip reasons differ or one endpoint is available.
2. Both are available, but `via` differs or their beacon addresses differ:
   `provenance-changed`, also with no implementation changes.
3. Otherwise: `comparable`. Direct observations share the direct slot provenance;
   beacon observations must have the same beacon address. Compare addresses and
   full code bytes exactly, independent of their lengths or fingerprints.

An address difference produces `{field: "address", before: ADDRESS, after: ADDRESS}`.
A byte difference produces `{field: "code", before: SUMMARY, after: SUMMARY}`.
When selected addresses differ but provenance is stable, code differences
describe the two selected implementations, not mutation of one account's code.
The same address with different code is comparable. Empty/nonempty transitions
are real code differences (`no-code` ↔ `observed`). An address can change while
code remains equal, including two observed empty code results. The retained raw
beacon word is fully determined by its validated address, not an independent
third implementation change.

**`changed` is true exactly when top-level `changes` or `implementation.changes`
is nonempty.** Status, skip reason and provenance transitions are visible through
the endpoints and `comparison`; they do not independently set `changed`. Strict
snapshot validation derives skips/provenance from target code and slots, so a
valid transition may necessarily include target changes, which still count.
Same skips do not establish unchanged implementation state. Skipped data is not
empty code, and switching direct/beacon or beacon addresses cannot by itself
establish an implementation upgrade. A `no-code` status transition does entail
a compared code change when provenance remains comparable.

V2 retains the two existing notice codes:

- `SAME_HEIGHT_DIFFERENT_HASH`: same height and different hashes, irrespective of
  target/implementation differences. Possible reorg; not proof of an upgrade.
- `INCONSISTENT_BLOCK_DATA`: same hash with different heights, target code/raw
  slots, or any saved implementation observation field (status, reason, via,
  address, full code, beacon, raw). Object key order and capture timestamps do
  not count. This also covers observation availability/provenance contradictions.

These conditions are mutually exclusive; notice order and meanings for v1 are
unchanged. Notices never directly change `changed`. Default successful exit is
0, while `--exit-code` returns 2 iff `changed` is true, otherwise 0. Both flags
preserve these semantics and do not alter the report. Error exit is always 1.

Text output separately labels target/slot changes and displays both implementation
endpoints. It reports compared address/code differences or why comparison was
unavailable. It does not claim that saved differences prove an upgrade transaction
or safety. The [synthetic before](../examples/beacon-before-v2.json) and
[after](../examples/beacon-after-v2.json) keep target code and beacon-slot fixed
while changing the returned address and implementation code. Independent
[JSON](../test/fixtures/json-diff-v2/beacon-change.json) and
[text](../test/fixtures/json-diff-v2/beacon-change.txt) fixtures pin the expected
output. Fixture capture timestamps are their actual generation times.

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
| `DIFF_VERSION` | Use two snapshots of the same version; missing v1 observations cannot be inferred |
| `INTERNAL` | Unexpected local failure; reproduce with a synthetic fixture |

The public error boundary emits fixed messages only. HTTP and JSON-RPC remote
error bodies are never used as diagnostics. There is no debug flag that bypasses
this boundary.
