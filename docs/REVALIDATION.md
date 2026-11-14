# Source-relative history revalidation

`history revalidate` is a finite, explicit live read. It labels saved observations
against a parent-linked range asserted by one selected RPC source and rebuilds
comparisons among the observations matching that range. It preserves every
history file and every indexed observation. Ordinary offline `history timeline`
JSON v1/v2, snapshots v1–v4, history headers and immutable index records are unchanged.

```sh
# MY_RPC is an existing caller-provided environment variable. ANCHOR is an
# explicitly chosen nonzero 32-byte block hash; there is no latest discovery.
node bin/contract-watch.js history revalidate --dir ./history \
  --rpc-env MY_RPC --anchor "$ANCHOR" --max-blocks 64
```

Use exactly one `--rpc URL` or `--rpc-env ENV`. Environment references match
`[A-Z_][A-Z0-9_]{0,63}`. Only that own environment property is read, once, after
local options and the complete history are validated. There is no implicit
`CONTRACT_WATCH_RPC_URL`, configuration, endpoint fallback, interpolation or
`.env` loading. Endpoint URLs must satisfy the existing HTTP(S) restrictions.
URLs, environment names and credentials are absent from reports and errors.

The directory must contain valid history v1/v2 with identity **source rpc,
snapshotVersion 4, observed nonzero genesis**. Older versions, synthetic data
and not-recorded genesis are refused before environment access or RPC, including
empty and single-observation histories. Migration cannot invent genesis; use
the original offline timeline when this evidence is unavailable. Stored target,
chain, version, source and genesis must match exactly across all snapshots,
including pending snapshots. Pending files and stages remain counted but excluded
from classifications, comparisons and saved-data contradiction checks.

`--anchor` and `--max-blocks` are required. The latter is a canonical decimal
integer 1–128; it counts the anchor itself. Optional `--timeout-ms` is a canonical
100–60000 (default 10000) and `--deadline-ms` is a canonical 100–600000 (default
30000). No retries, output file, replay, watch, event or automatic pruning option
is supported. The report is always JSON.

## Verification protocol and bounds

One invocation resolves one endpoint and makes these sequential reads:

1. `eth_chainId`, matching the history's exact uint256 chain ID.
2. `eth_getBlockByNumber("0x0", false)`, matching observed genesis.
3. `eth_getBlockByHash(anchor, false)`, matching the requested hash.
4. `eth_getBlockByNumber(anchor.number, false)`, matching that header.
5. Follow each `parentHash` using `eth_getBlockByHash(hash, false)` until
   `--max-blocks` headers or genesis. Each hash must match its requested hash,
   each number must decrease by exactly one using BigInt, and hashes must not
   repeat. If reached, genesis must equal the initial genesis header.
   Known cycles or inconsistent references to the separately checked genesis
   are refused even at the requested range boundary, without extra reads.
6. Recheck the anchor by number, genesis by number, then chain ID. All must equal
   their initial values, including anchor/genesis parentHash.

Every consumed header must have a canonical uint256 number, a nonzero 32-byte
hash and a 32-byte parentHash (zero only at block 0). Unknown extra block fields
are ignored, never emitted. A successful K-header check uses exactly **K + 6
requests, at most 134**, with zero retries, state reads or latest lookups. An
anchor at genesis uses seven requests. A growing head above the unchanged anchor
does not invalidate the check. Missing/pruned/null headers within the requested
range, malformed data, mismatched hashes/heights, RPC failures or observed anchor/
identity changes fail the entire operation; there is no partial success report
or weaker numeric/latest fallback. Outside this range the report says unknown.

The existing transport limits apply: **1 MiB response body, 16 KiB HTTP headers**,
per-request timeout, closed transports before error return and no redirects.
One monotonic deadline covers the RPC sequence, including its final checks.
History validation and comparison/file work are outside that deadline; it is
not a hard process wall limit. Signals are checked around file work; started
file operations drain. No filesystem latency deadline is promised.

The official [Execution API block schema](https://github.com/ethereum/execution-apis/blob/main/src/schemas/block.yaml)
defines the block number, hash and parentHash fields used here. The classification,
resource limits and report contract below are application policy.

## Labels and rebuilt comparisons

All indexed observations appear in original ordinal order, with compact code
fingerprints, complete raw slot words and implementation details as in timeline.
Original bytecode and complete source evidence remain in the history files.
Neither heights nor timestamps reorder the view. Each observation has exactly
one `status` and `reason`:

| Status | Reason | Meaning |
| --- | --- | --- |
| on-branch | MATCHED_CHECKED_HEADER | Recorded height and hash match a checked header |
| displaced | DIFFERENT_CHECKED_HASH | The source's checked branch has another hash at this covered height |
| unknown | OUTSIDE_CHECKED_RANGE | The height is outside the checked linked range |
| unknown | CONTRADICTORY_SAVED_DATA | This saved hash has conflicting saved height, raw slots or recorded code/implementation details |
| unknown | SAVED_NUMBER_MISMATCH | This saved hash is known at another height in the checked range or the separately checked genesis |

Contradictory saved data takes precedence, then a saved-number mismatch, then
covered-height classification. All occurrences of a contradictory hash become
unknown; index order never selects a winner. Missing/not-recorded implementation
alone is not a contradiction. `checkedHeader` is a zero-based evidence header
index for this recorded height, or null; it is not an assertion of agreement
when the status is unknown or displaced.

`displaced` means **relative to this source's checked branch at this invocation**.
It does not prove the observation was once canonical, when a reorg happened,
which provider is honest, or that either contract state is safe. Same-height
different hashes, repeats, timestamps and index order alone never establish a
canonical branch. The source may lie consistently; the tool neither hashes full
headers nor verifies consensus, finality, state proofs or ancestry outside the
covered range. Genesis binds the asserted network identity but does not prove
that an untraversed range reaches it. An anchor can change and return between
checks, or change after the last check; these finite reads are not a chain lock.

Only `on-branch` entries enter `visibleOrdinals`. Unknown and displaced entries
remain in `observations` and in raw history, but are excluded from the rebuilt
view. Every adjacent visible pair is **recomputed from its two validated saved
snapshots**, using strict version, genesis, raw-word and implementation provenance
rules. No old transition is simply relabeled or reused. Missing/skipped or changed
implementation provenance remains unavailable; it never means unchanged or empty
code. Decreasing heights retain index order and produce an unavailable pair with
`ORDER`. Repeats remain repetitions, not independent confirmations. Empty and
one-entry visible views have no transitions.

`omittedOrdinals` lists current-history observations filtered between the pair.
For ordinary history, `originalOrdinal` equals the current ordinal. For history
v2 retained prefixes, it is the stored source ordinal; additions after that
prefix have null original ordinals. Transitions carry `fromOriginal`,
`toOriginal`, and `retentionGap`: true for a known intervening source gap, false
when known absent, null when a later original ordinal is unavailable. The complete
validated retention provenance is included; filters never erase retention gaps.
No omitted observation, intermediate state or event is reconstructed.

## JSON evidence and delivery

Success returns one `contract-watch-history-branch` **schemaVersion 1** with:

- `order: "index"`, `identity`, `historyVersion`, committed/pending/staged counts,
  `retention` (object or null), and `sourceUnchanged: true`.
- `observations`, `visibleOrdinals`, and recomputed `transitions` described above.
- `evidence`: `contract-watch-branch-evidence` **schemaVersion 1** with a fresh
  random `verificationId`, `source: "single-explicit-rpc"`, `historyState`, actual
  UTC `startedAt`/`completedAt`, exact chainId/genesisHash, normalized anchor,
  `headers` in anchor-to-parent order, `maxBlocks`, `requests`, and before/after
  chain/genesis/anchor `checks`. `evidenceId` is lowercase SHA-256 of canonical
  sorted-key JSON of this entire evidence object excluding evidenceId itself.
- `caveats` stating source, coverage, omission and delivery limits.

`historyState` binds verified file bytes and local filesystem identity/metadata
using the retention checkpoint contract: SHA-256 over canonical sorted-key JSON
of root metadata and sorted file records (name, metadata, byte count and SHA-256).
Metadata includes dev/ino/mode/nlink/size/mtimeNs/ctimeNs as decimal strings, excluding
access time. It covers committed and pending files, stages and the immutable
header/index. The same checkpoint must match after RPC and rebuilt comparisons;
each snapshot reread must also match its original record bytes and SHA-256.
Source changes produce an error and no stdout. Separate syscalls do not provide
a lock or protection from hostile swaps/forged metadata; use trusted paths and
stop other writers. Reading may change filesystem access times.

The verification ID binds the checks to one execution using one endpoint, not to
an authenticated provider identity. The endpoint is deliberately not included;
retain that association separately if needed. Evidence hashes detect accidental
changes only when compared with a trusted copy; anyone can edit and rehash a JSON
report. This tool does not import or replay reports, write evidence files, modify
history, create a journal, or maintain a global canonical-history marker. A later
explicit invocation may label an observation differently if the branch returns.
Old saved reports remain records of their own checks and times.

Exit **0** means the requested bounded check completed, including a view with
unknown or displaced observations. It does not mean every observation is covered
or any change was absent. Errors exit **1** with empty stdout and fixed safe
stderr; no provider text, URL, arbitrary disk data or stack is emitted. History,
RPC, chain, genesis and canonical-check errors retain their established codes.
New codes are BRANCH_LIMIT, BRANCH_IDENTITY and BRANCH_HEADERS. The live
[cancellation lifecycle](CANCELLATION.md) applies with no owned output files:
first SIGINT/SIGTERM wins (130/143), active HTTP is aborted, started work drains,
handles close, stdout remains empty, and CAPTURE_CANCELLED is emitted. Cancellation
after the final in-process commit point does not retract stdout. SIGKILL, crashes
or broken output delivery may leave an absent or partial externally redirected
report; the history remains intact. There is no automatic resume or durable
stdout transaction. Keep reports outside the history in a new caller-managed
file if needed; ordinary shell redirection can overwrite existing files.

Existing history limits remain **128 entries, 512 names, 4 KiB index records,
512/768 KiB snapshots and 128 KiB per code blob**. Two full source checkpoints
plus bounded snapshot rereads consume conservatively less than **2 GiB** of file
reads; buffers are per file, not the whole history's bytecode. Reports retain at
most 128 compact observations, 128 headers and 127 transitions. Contradiction
scanning is bounded by the 128-entry limit. No capacity expansion, history deletion,
background monitor or persistent chain cache is added.
