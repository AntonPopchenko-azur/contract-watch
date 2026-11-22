# EIP-1967 event cross-check (report v1)

Added 2026-11-22. `events` performs a finite live read of **one explicitly
selected block** and compares the last returned event for each EIP-1967 slot
with that slot's hash-pinned end-of-block value. It reads no saved snapshots,
history, configuration or neighboring blocks and creates no files. Snapshot
v1–v4, diff, timeline v1/v2, revalidation, watch and stored history are unchanged.

```sh
# Existing caller-provided values: an explicit target, expected chain ID,
# expected genesis hash, selected block hash and an RPC environment variable.
node bin/contract-watch.js events --address "$TARGET" --chain-id "$CHAIN_ID" \
  --genesis-hash "$GENESIS_HASH" --block-hash "$BLOCK_HASH" --rpc-env MY_RPC
```

Both hashes must be nonzero 32-byte hex; the caller supplies the expected genesis,
which is checked rather than inferred from a legacy snapshot. Choose exactly one
`--rpc URL` or `--rpc-env ENV`. The environment name matches `[A-Z_][A-Z0-9_]{0,63}`;
only that own property is resolved once after all local input validation. There
is no default environment variable, config, `.env`, interpolation, latest lookup,
numeric state fallback or alternative endpoint. Target addresses use the existing
20-byte hex syntax and normalize to lowercase; checksum verification is not an
option here. Chain IDs use exact positive uint256 arithmetic.

Optional `--timeout-ms` is canonical decimal 100–60000 (default 10000);
`--deadline-ms` is canonical 100–600000 (default 30000). This command always has
zero retries. Range flags, pagination, receipt recovery, filters/subscriptions,
arbitrary RPC methods/topics, historical correlation and output-path flags are
unsupported. A separate invocation is an explicit new observation, not a resume.

## ABI and comparison scope

The [EIP-1967 definitions](https://eips.ethereum.org/EIPS/eip-1967) map the events
to the proxy's three storage slots. Their layout follows the
[Solidity event ABI](https://docs.soliditylang.org/en/latest/abi-spec.html#events):

| Event signature | Topics | Data | Compared value |
| --- | --- | --- | --- |
| Upgraded(address) | signature, indexed implementation word | empty | implementation slot |
| AdminChanged(address,address) | signature only | previousAdmin then newAdmin, two words | admin slot against newAdmin |
| BeaconUpgraded(address) | signature, indexed beacon word | empty | beacon slot of this proxy |

The fixed signature topics are, respectively:

```text
0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b
0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f
0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e
```

ABI address words must have twelve zero high bytes; neither malformed padding
nor extra data is truncated. Zero addresses are valid encoded values and may
match an empty raw word, without establishing conformance or code presence.
BeaconUpgraded does **not** mean an implementation changed inside a beacon. No
beacon call, code read, proxy-type decision or implementation-address resolution
is performed. Each slot is checked independently even if both implementation
and beacon slots are populated; agreement does not resolve that ambiguity.

All accepted logs are retained in deterministic ascending **global logIndex**
order using BigInt. RPC arrival order does not select a winner. Per slot, only
the last returned event's value is compared with final storage. Earlier values
are listed as earlier evidence, not independently compared to end-of-block
storage. Multiple events can change a value and return it; they are all retained.
No pre-block storage or intermediate transaction state is reconstructed.

| Status | Reason | Meaning |
| --- | --- | --- |
| agreement | LAST_RETURNED_VALUE_MATCHES | Last returned encoded value equals the entire canonical raw slot word |
| disagreement | LAST_RETURNED_VALUE_DIFFERS | Last returned encoded value differs from the canonical raw word |
| unavailable | NO_RETURNED_EVENT | No event for this slot was returned |
| unavailable | NONCANONICAL_SLOT | High raw slot bytes prevent interpreting it as an ABI address |
| unavailable | ADMIN_SEQUENCE_GAP | A later returned AdminChanged.previousAdmin differs from the preceding returned newAdmin |

For an existing event, an admin sequence gap takes precedence over a
noncanonical slot. The first previousAdmin is preserved but not verified against
prior storage. A gap can mean missing events, an unlogged change or misleading
data; it suppresses admin agreement rather than choosing an explanation. Other
slots still receive their own results. Structural/provenance contradictions
instead fail the operation as described below.

These are **source-relative value comparisons**, not claims that every event or
change was observed. `completeness` is always `unverified`. Empty responses and
missing events never prove absence of changes, standards compliance or safety.
Silent provider truncation and nonstandard/unlogged changes cannot be ruled out,
even below the count limit. A nonstandard indexed layout using a selected
signature is refused; a different signature is outside the query's scope.
The last returned event is not independently proven to be the actual last event.
A disagreement does not identify its cause. A consistently dishonest provider
can fabricate matching logs, headers, transaction lists and storage.

## Exact protocol and validation

All reads use one resolved endpoint and execute sequentially, with exactly
**11 requests on success**, including empty-log, unavailable and genesis-block
reports:

1. `eth_chainId`: match the explicit chain ID.
2. `eth_getBlockByNumber("0x0", false)`: mined nonzero hash and number 0 must
   match the caller's expected genesis hash.
3. `eth_getBlockByHash(BLOCK_HASH, false)`: match the requested nonzero hash;
   validate number, timestamp and the complete bounded transaction-hash list.
   The selected hash equals genesis if and only if its number is zero.
4. `eth_getBlockByNumber(selected.number, false)`: match the selected number,
   hash, timestamp and ordered transaction list before state/log reads.
5. Three `eth_getStorageAt` reads, in implementation/admin/beacon order, at the
   standard slot positions with `{blockHash: selected.hash, requireCanonical: true}`.
6. One `eth_getLogs` with exactly `{address: target, blockHash: selected.hash,
   topics: [[UpgradedTopic, AdminChangedTopic, BeaconUpgradedTopic]]}`. There are
   no range bounds or broad/unfiltered queries. Validate the whole result.
7. Recheck the selected block by number, then genesis by number, then chain ID.
   Their consumed metadata must match the initial observations.

Hash-based log selection is specified by the
[Execution API filter schema](https://github.com/ethereum/execution-apis/blob/main/src/schemas/filter.yaml).
Unlike EIP-1898 storage, this filter has no requireCanonical field; the surrounding
block checks bind it to the source's asserted canonical block. Unsupported
hash filters or historical storage fail, with no fallback. Block selection
permits an advancing head above this unchanged block. A change and return between
checks, or a reorg after the last check, may be undetected. Matching chain/genesis
does not prove ancestry, uniqueness or provider honesty; these are not consensus,
finality, receipt/state proofs or independently hashed headers.

This command requires a strict mined subset of the
[Execution API log fields](https://github.com/ethereum/execution-apis/blob/main/src/schemas/receipt.yaml):
address, blockHash, blockNumber, transactionHash, transactionIndex, logIndex,
removed, topics and data. Only blockTimestamp is additionally accepted; if
present it must equal the selected block's timestamp. Hashes, addresses, topics
and data use exact widths; quantities are canonical hex uint256. Hex letter case
normalizes. Removed must be false. Missing/null pending fields, wrong emitters,
unknown keys, wrong signatures/counts/ABI, out-of-block logs and malformed values
fail the complete operation, without a partial report.

Each transaction index must be within the selected block's at-most-4096 unique
nonzero transaction hashes, with exactly the claimed hash at that index. Duplicate
global log indices (even identical logs) and decreasing transaction indices in
sorted log order are contradictory and refused. Global log index gaps are valid:
this query excludes unrelated logs. No receipt is fetched, so the claimed log
index itself is not independently reconstructed. Transaction hashes and block
metadata beyond the consumed subset are not cryptographically verified.

## Resource, output and failure contract

Hard application limits are **one block, 11 requests, zero retries, 256 returned
logs, 4096 block transaction hashes, 256 KiB log response, 1 MiB other response
bodies, 16 KiB HTTP headers per response and 1 MiB serialized stdout**. A provider
limit error or excessive count/body fails; the tool never splits a range or
accepts a partial result. Maximum successful aggregate response-body allowance
is 10.25 MiB. Only one request is active. Retained data comprises at most three
4096-hash block lists, 256 normalized logs and three slot words/comparisons, plus
bounded response/serialization buffers. No all-history cache accumulates.
These bounds limit application data, not the JavaScript runtime's total heap.

The new command uses fatal UTF-8, rejects BOM, duplicate decoded JSON keys and
nesting beyond six in all its RPC envelopes. Existing RPC parsing behavior stays
unchanged for old commands. Responses/requests are closed on errors before work
returns. One monotonic deadline includes environment resolution, all reads and
validation; each request is bounded by the smaller of timeout and remaining time.
The existing CAPTURE_DEADLINE precedence applies. Event-loop/transport cleanup
and stdout delivery are not a hard wall-time guarantee.

The independently versioned JSON object is `kind: "contract-watch-event-cross-check"`,
`schemaVersion: 1`. It includes source/address/chainId/genesis, the selected
block number/hash/timestamp, `storageState: "end-of-block"`, raw `slots` with the
existing raw/status/address interpretation, and the ordered `transactions` list.
`logs` retain normalized provenance, topics/data, event/slot, decoded `arguments`,
`valueWord` and `previousWord` (null except AdminChanged). `comparisons` contain
slot/event/status/reason, eventCount, selectedLogIndex/selectedValueWord (or null),
earlierLogIndexes and adminSequenceGaps. `selection` states last-returned-event-per-slot.

`verification` records actual UTC startedAt/completedAt, requests=11, and
before/after chainId, genesis number/hash, and block number/hash/timestamp with
transactionsSha256 (SHA-256 of compact JSON of the normalized ordered hash array).
`limits` records the fixed caps and selected timeout/deadline. `caveats` and
`completeness: "unverified"` accompany every report. The endpoint and environment
name are never included. Reports are not authenticated, persisted or accepted
as snapshot files; a caller storing stdout manages its destination separately.

Exit **0** means a completed bounded check, including disagreement/unavailable.
Inspect each comparison; there is no whole-contract success/safety verdict or
change-triggered exit code. Validation/RPC/limit/identity errors exit **1** with
empty stdout and fixed safe stderr. Established RPC/chain/block/deadline codes
remain. New codes are EVENT_GENESIS, EVENT_BLOCK, EVENT_LOG, EVENT_LIMIT,
EVENT_SIZE and EVENT_REPORT_SIZE. No URL, environment name, provider message,
arbitrary unvalidated value or stack appears in errors.

The existing [live cancellation lifecycle](CANCELLATION.md) applies with no owned
files: first SIGINT/SIGTERM wins (130/143), abort/drain active HTTP, no later reads,
empty stdout and CAPTURE_CANCELLED. The report is emitted only after all checks
and the final cancellation boundary. After the in-process stdout commit point,
delivery cannot be retracted. SIGKILL/crashes/broken pipes or external shell
redirection may leave an absent/partial externally saved report; there is no
durable output transaction, overwrite guard for shell redirection or automatic
resume. Source snapshots, histories and user files are never opened or rewritten.
