# Bounded EIP-1967 log recovery

Implemented 2026-11-25 as roadmap item 33. `events-range` collects the three proxy
EIP-1967 event types over a finite inclusive range on one source's checked branch.
Its separate JSON v1 report has kind `contract-watch-event-range`. It does not
read storage, code, receipts, snapshots or history, correlate events to saved
observations, write files, or run in the background. The existing [`events`
command](EVENTS.md) retains its single-block report, 11-request protocol and errors.

## Explicit inputs

```sh
node bin/contract-watch.js events-range --address "$TARGET" --chain-id "$CHAIN_ID" \
  --genesis-hash "$GENESIS_HASH" --from-block 100 --to-block 103 \
  --to-hash "$BLOCK_103_HASH" --rpc-env MY_RPC --max-pages 7
```

Supply the address, canonical decimal uint256 chain ID, nonzero expected genesis
hash, both canonical decimal uint256 heights, nonzero upper block hash and exactly
one of `--rpc URL` / `--rpc-env ENV`. The inclusive range must contain **1–32
blocks**. Genesis and uint256 boundary heights are supported without rounding.
There is no head discovery, default endpoint/env variable, `.env` read, config,
fallback, arbitrary topic, address list or implicit height.

`--max-pages` is canonical decimal **1–63**, default 63, counting every log-query
attempt including provider rejections; it is not a page width. `--timeout-ms`
is 100–60000, default 10000; `--deadline-ms` is 100–600000, default 30000. Validate
all options before reading the selected own environment property once. Duplicate,
missing, unknown and unsupported flags fail. There is no retries/out/json/resume flag.

## Binding and sequential protocol

1. Check chain ID, then block 0 by number against expected genesis. Require number
   zero, nonzero hash and zero parent.
2. Fetch the upper block by explicit hash and require its exact supplied height.
   Fetch it by number and compare all consumed metadata.
3. Walk parents **by hash** down to the lower height. Require exact requested
   hashes, adjacent descending numbers, no repeated headers/cycles and coherent
   genesis/zero-parent relationships. The lower parent cannot point back into
   the range. A range above genesis does not establish full ancestry to genesis.
4. For each page, yield a cancellation boundary, recheck the upper block by number,
   then issue one `eth_getLogs` with exactly this target, inclusive numeric
   fromBlock/toBlock and the OR-list of the three fixed signature topics. No
   blockHash is combined with range selectors. Validate logs, then recheck the
   upper block. A recognized limit error also requires this post-query anchor
   check before splitting. Malformed results abort immediately.
5. After all leaves succeed, recheck **every covered block by number**, ascending,
   then genesis and chain ID. Only then mark coverage verified and publish logs.

Consumed block metadata is number, hash, timestamp, full transaction-hash list
and parentHash. Require mined nonzero hashes, canonical quantities, unique
nonzero transactions and membership. At most 4096 transaction hashes are accepted
across the range; the same transaction in two blocks fails. Unconsumed standard
header fields are allowed and are not claimed as evidence. Both genesis checks
compare number/hash/parentHash; a covered block 0 also receives full block checks.
Any consumed metadata change fails, including timestamp or transaction-list changes.

These repeated observations are not an atomic server snapshot or independent
chain proof. A source can lie consistently or silently truncate logs; the branch
can change between or after checks. Success proves neither log completeness,
consensus, finality, provider honesty nor contract safety.

## Subdivision and validation

Only a well-formed JSON-RPC error with integer code **-32005** on the dedicated
range log query permits subdivision. Require integer code and string message,
with only optional data. Discard raw provider text/data and never parse messages
such as “too many results” to infer permission.

[EIP-1474](https://eips.ethereum.org/EIPS/eip-1474), a stagnant proposal, describes
-32005 as a defined limit exceeded. This narrow application policy is neither a
universal provider convention nor proof that the limit is range size rather than
quota. Incompatible providers fail explicitly; repeated coded limits reach a
bounded failure.

Begin with the whole input interval `[lo, hi]`. Compute integer
`mid = lo + (hi - lo) / 2`; visit `[lo, mid]`, then `[mid + 1, hi]`, depth-first.
Leaves partition the original interval without overlap, gaps, clamping, extension
or changing its upper hash. A rejected single-block page fails
`RANGE_UNSPLITTABLE`. Even single-block leaves retain numeric selectors.

HTTP 429/503 and other HTTP errors, timeouts, transport failures, unsupported or
pruned data, malformed envelopes, ordinary RPC errors, local count/byte limits
and branch/identity races never trigger splitting or retries. No Retry-After
wait, automatic restart or provider scheduler is added. Successful empty pages
remain explicit. Filtered global log-index gaps are legal and never cause splitting.

Every record first passes the strict [event ABI/mined provenance rules](EVENTS.md):
exact allowed fields, target, signature, topic/data sizes, zero address padding,
removed=false, block hash/number, transaction hash/index membership and optional
matching blockTimestamp. Pending/null/removed/unknown/malformed records fail.
Each record must belong to its **own page**, even if already seen elsewhere.

Within an admissible page, identity is `(blockHash, logIndex)`. Normalize hex
casing and field order, then deduplicate identical records and count repeats.
Different evidence at the same identity, including optional timestamp presence,
fails `RANGE_DUPLICATE`. Disjoint leaves cannot legitimately repeat a record:
out-of-page repeats fail instead of being hidden. Sort by numeric block number
then global log index, requiring nondecreasing transaction indices within each
block. Received-entry limits include duplicates. Single-block `events` still
rejects all repeats.

Preserve normalized topics/data, decoded words/arguments and mined provenance.
Upgraded/BeaconUpgraded each have one indexed address; AdminChanged has two
non-indexed addresses. BeaconUpgraded concerns this proxy's beacon slot, not an
implementation change inside the beacon. No storage comparison occurs here.

## Report and coverage journal

Top-level fields include kind/schemaVersion, source=rpc, address, decimal chainId,
expectedGenesisHash and hexadecimal range fromBlock/toBlock plus toHash.
**completeness is always unverified**, including successful pagination.

| Outcome | Exit | Output |
| --- | --- | --- |
| All pages/final checks pass | 0 | status=complete, coverageVerified=true, ordered blocks/logs, failure=null |
| Protocol/RPC/deadline/budget failure after endpoint setup | 1 | status=incomplete, coverageVerified=false, blocks=null, logs=null, fixed failure code/message/phase |
| Invalid input/environment or serialization limit | 1 | Empty stdout, fixed safe stderr |
| Handled SIGINT / SIGTERM before output commit | 130 / 143 | Empty stdout, existing fixed cancellation stderr |

Ordinary complete/incomplete reports have empty stderr. No partial log array,
verified branch or successful-empty claim appears on failure. No endpoint,
environment reference, credential, raw provider error/data or stack is emitted.

`pages` is the bounded tree in creation order: id, parentId, depth (root zero),
hexadecimal bounds, status, one-based log attempt or null, returnedLogs/duplicates
or null, anchorBefore/anchorAfter booleans and fixed error or null. Allocation IDs
need not match attempt order. Split nodes record the recognized limit and their
children cover the original interval; a split node is not a successful read.

`coverage` has exactly one ascending entry per requested block: number, status,
pageId and uniqueLogs. A page may cover several entries:

- unread: no successful read, not evidence of an empty block.
- read-unverified: validated, post-anchor-checked leaf returned, but final checks
  have not completed. Zero counts remain provisional.
- failed: active page failed, including budget refusal before its request; count
  is null. Earlier leaves stay unverified; queued leaves remain unread.
- read / read-empty: only on complete reports after final checks. Empty means no
  matching records returned, not absence of changes or complete evidence.

Binding failure leaves all coverage unread. Final-check failure leaves previously
covered entries read-unverified. Incomplete reports never retain verified labels.

Successful `blocks` is ascending consumed metadata including transaction hashes;
`logs` is ordered normalized evidence. `verification` contains wall-clock
startedAt/completedAt, phase, request/log-attempt/response-byte counts,
receivedLogs/duplicateLogs and chainGenesisRechecked. Success-only rangeSha256 is
SHA-256 of JSON.stringify of the ascending normalized block array, with block
fields number/hash/timestamp/transactions/parentHash in that order. It is a local
fingerprint, not an Ethereum hash or proof. Failure has null digest and false
chainGenesisRechecked. Duplicate counts include accepted leaves only. `limits`
records bounds and selected maxPages/timeout/deadline; `caveats` retains evidence
and recovery limitations. No importer or history schema is added. Snapshot v1–v4,
diff, history, revalidation, watch and single-block event formats are unchanged.

## Bounds and delivery

| Resource | Bound |
| --- | --- |
| Blocks / tree nodes / depth | 32 / 63 / 5 (root zero) |
| Log attempts | selected maxPages, default 63, including limit errors |
| All sequential RPC requests | 258 |
| Aggregate response bodies | 16 MiB |
| Log response / ordinary response / HTTP headers | 256 KiB / 1 MiB / 16 KiB |
| Per-response / received total / unique logs | 256 / 1024 / 512 |
| Aggregate transaction hashes | 4096 |
| Serialized report | 2 MiB |
| Request timeout / monotonic deadline | default 10 s / 30 s; maxima 60 s / 600 s |

With N blocks and P log attempts, success makes exactly **2*N + 5 + 3*P requests**:
N+3 binding, three per attempt and N+2 final checks. One unsplit block takes 10;
four unsplit blocks 16; four fully split blocks 34; 32 fully split blocks 258.
The old `events` remains 11 because it additionally reads three storage slots.

The body meter counts received data chunks, including recognized limit errors.
Early HTTP/header/content-length/encoding refusal can close without consuming a
body. The detecting chunk can exceed the aggregate limit in the reported count;
it is not retained. This is an application budget, not a hard TCP/runtime heap
cap. Buffers, parsed objects, metadata and output also occupy memory. Similarly,
received counts may include a rejected oversized array. There is no oversized
successful result. Failed/aborted transports close before proceeding. Strict
UTF-8 JSON rejects duplicate keys/excessive nesting; compression/redirects fail.
The deadline includes decoding/page boundaries/final checks; each request uses
remaining time. It is not a hard process wall limit: serialization, stdout and
runtime stalls can extend elapsed time. Output size is checked before writing.

The [existing cancellation lifecycle](CANCELLATION.md) applies: first handled
signal wins, stops new pages, aborts/drains RPC and suppresses even an incomplete
journal. Explicit event-loop turns occur between pages and before final stdout.
No files are owned, so snapshots/history/source bytes and metadata stay untouched.

The stdout journal is not a durable checkpoint. After incomplete output or an
interrupt, retain any report externally for diagnosis and explicitly rerun the
original inputs after addressing the cause. Every rerun rebinds and starts at
the root; earlier reports are never imported or combined. Missing stdout does
not prove no requests occurred. SIGKILL, crashes and broken-pipe delivery cannot
be rolled back; shell redirection may leave an external partial file. There is
no automatic resume, endpoint substitution or storage correlation.

## Primary sources and fixtures

- [EIP-1967](https://eips.ethereum.org/EIPS/eip-1967): event ABI and proxy slot semantics.
- [Execution filters](https://github.com/ethereum/execution-apis/blob/main/src/eth/filter.yaml): inclusive bounds, no silent clamping or partial ranges.
- [Filter schema](https://github.com/ethereum/execution-apis/blob/main/src/schemas/filter.yaml): separate range/blockHash selectors.
- [Log schema](https://github.com/ethereum/execution-apis/blob/main/src/schemas/receipt.yaml) and [block schema](https://github.com/ethereum/execution-apis/blob/main/src/schemas/block.yaml): mined provenance, optional timestamp and transaction metadata.
- [EIP-1474](https://eips.ethereum.org/EIPS/eip-1474): narrow coded-limit policy above.

The independent [synthetic fixture](../test/fixtures/event-range/README.md) and
unit/loopback/CLI tests cover exact traces/bounds, malformed/contradictory logs,
duplicates, empty/gapped results, branch/identity races, caps, explicit restart,
redaction, source preservation and cancellation. Tests use no live provider.
