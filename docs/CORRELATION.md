# Offline event-to-snapshot candidates

Contract for roadmap item 34, 2026-11-28. The explicit offline command is:

```sh
node bin/contract-watch.js history correlate --dir ./history --events ./range.json
```

Both inputs are required; there is no discovery, environment lookup, RPC, config,
output file, history import or background work. Output is a separate JSON v1
`contract-watch-event-correlation` document. Exit 0 means the offline comparison
completed, including missing neighbors and differing values; errors exit 1 with
empty stdout and fixed safe stderr. Ordinary offline signal behavior applies.

## Identity and admission

Require a valid history v1/v2 with RPC snapshot v4 identity and **recorded genesis**,
matching the range report's exact target, chain ID and expected genesis. Unknown
genesis, older snapshot identities and synthetic histories cannot be inferred or
silently upgraded. Existing commands continue accepting their original formats.
Validate all committed and pending history records and bounded staging files.
Only committed records are observations; report pending/stage counts separately.

Accept only complete `events-range` v1 documents, but never trust complete or
coverageVerified alone. Check strict structures, canonical values and bounds;
rebuild the linked header window, deterministic page tree and coverage partition;
recompute transaction membership, ABI decoding, log ordering, counters and block
fingerprint. Compare all decoded/derived fields with independently recomputed
values. Require coherent successful page states, anchor checks and final-check
claims. Reject incomplete, malformed or inconsistent reports before correlation.
All arrays, quantities and counts are bounded. Unknown fields are refused.

These are **internal consistency checks**, not authentication. A caller can forge
an internally consistent file. Request/byte counts, times and claimed RPC checks
cannot be replayed or verified offline. Matching genesis/headers and the local
fingerprint do not prove ancestry, provider honesty or canonicality now.

## Deterministic nearest observations

Retain every committed observation in index order with ordinal, original ordinal
(if known after retention), observation ID, snapshot byte fingerprint/size,
capture time, block number/hash, raw slot details and implementation availability.
Never reorder the history or infer event time from capture time.

Classify each observation against the saved range:

- matched: exact number and hash of a covered header, with no saved contradiction;
- different-hash: covered height but another hash; do not label a confirmed reorg;
- unknown: outside covered headers, or a known hash claiming a different height;
- conflicting: all occurrences of a saved hash with contradictory height, slots,
  code or recorded implementation details. Missing implementation
  evidence is not itself a contradiction.

Only matched observations are eligible neighbors. No ancestry or height-only
extrapolation is made outside the saved window. Emit explicit notices for repeated
heights, decreased heights/capture times, different hashes at one height and
contradictory data at one hash, including nonadjacent peers.

For each event at height E, choose the greatest eligible height strictly **below
E** as before, and the least eligible height **at or above E** as after. Preserve
all ties at the chosen height in ascending index ordinal order. They refer to the
same saved block and have consistent raw slots; no arbitrary winner is chosen.
All height comparisons use BigInt uint256 arithmetic. Either side can be absent.
An end-of-block observation at E is always after events at E, never before them.

Group events with the same selected before/after groups and slot into an interval;
each candidate references its interval, whose ordered ordinal arrays locate the
full observation provenance table. Intervals retain all returned candidate IDs,
including several events in one block, A/B/A sequences and changes whose final
saved endpoints are identical. Events remain in block/global-log order.

## Values and limits of association

Keep each full validated event: number/hash, transaction hash/index, log index,
raw topics/data, optional timestamp and decoded words/arguments. Compare its new
value word independently with the before/after saved slot words: matches, differs
or unavailable. Raw noncanonical slot words remain visible. Report endpoint slot
change separately as changed, unchanged or unavailable. Neither equality nor a
difference establishes that this event caused a saved transition.

For same-block events, include the count of later returned events for that slot
and the last returned candidate ID. An earlier event differing from end-of-block
storage is not automatically inconsistent; later returned events stay visible.
AdminChanged's previous word is retained without pretending it describes the
nearest earlier snapshot when intervening events may exist. BeaconUpgraded refers
only to the proxy beacon slot, not a hidden implementation change in the beacon.

Retention metadata and original ordinals remain intact. An interval's retentionGap
reports omitted source ordinals between its selected references (an index gap,
not an inferred missing time/height range); null means missing endpoints or unknown
post-retention origins. No pending/staged/retained-away observation is reconstructed.
Missing/skipped implementation evidence stays unavailable in the observation
table; this command compares proxy slot words, not implementation bytecode.

Every association is candidate-only. Completeness of returned events, causation,
confirmed upgrades, current canonicality, finality and contract safety are
unverified. Empty event input produces no candidates, not an unchanged-state claim.

## Resources and source preservation

The v1 document contains `identity`, `history` (version, sourceState fingerprint,
committed/pending/staged counts and retention), `eventSource` (exact file SHA-256,
byte length, range, normalized range fingerprint and header metadata), `selection`,
`observations`, `intervals`, `candidates`, `notices`, `limits` and fixed `caveats`.
Top-level mode=offline, inputValidation=internally-consistent, completeness and
causation=unverified distinguish validation from authentication. sourceUnchanged
means the final local comparisons passed, not a permanent lock on the source.
No filesystem paths or imported human caveat strings appear in output.

An interval has id, slot, before/after groups (number/hash/ordinals or null),
bracketing (bounded, before-missing, after-missing, both-missing), candidateIds,
endpointChange (status/beforeWord/afterWord) and retentionGap. A candidate has id,
the validated event, intervalId, association=candidate-only, valueComparison with
before/after status and observed slot details or null, sameBlockAsAfter,
laterReturnedSameSlotEventsInBlock and lastReturnedSameSlotEventInBlock.
All references are one-based. Observation/source fingerprints use SHA-256, not
Ethereum Keccak; matching fingerprints only bind the selected local bytes/data.

Range input is at most 2 MiB of actual bytes, strict UTF-8 JSON with duplicate keys
and nesting deeper than six refused. It retains limits of 32 headers, 63 pages,
512 unique logs, 1024 claimed received entries and 4096 transaction hashes. The
history keeps 128 committed entries, 512 total directory names, 4 KiB per index
file and 768 KiB per v4 snapshot/stage. Readers enforce actual bytes, regular
files, final symlink refusal and stable identity/metadata around reads.

Reuse full history checkpoints before and after processing, including hashes of
pending/staged files. Recheck the event report's bytes and filesystem metadata
before returning. Only compact observation summaries and bounded event data are
retained, not every snapshot bytecode. The serialized output limit is 4 MiB,
checked before a single stdout publication. Bounds are application limits, not
hard process-heap or wall-clock promises. Trusted local directories are required;
checks cannot prevent changes after the final read or guarantee atomic snapshots
against hostile filesystem races. atime may change through ordinary reads.

Two complete history checkpoints each validate the store and fingerprint all
files, with one extra read per committed observation in between; the report is
read twice. At the existing maximum file/count sizes these scans total less than
1.6 GiB of file content, read one bounded file at a time. Large pending stores
therefore take more I/O than the 128-observation output alone suggests. Staging
bytes are bounded/fingerprinted but are not parsed as complete snapshots.

The importer accepts reordered JSON object keys but requires canonical stored
hex/decimal values and exact known field sets. Imported human caveats are five
bounded strings (1–512 characters), ignored as authority and never echoed. Wall
clock verification times must be valid ISO strings; they need not increase because
the original capture uses a separate monotonic deadline. Claimed byte counts are
range-checked only; request/tree/log counters and the block digest are recomputed.

No source bytes, mtime, permissions, index records or stages are written. An error
publishes no partial successful JSON; messages contain no paths, endpoints,
provider text or arbitrary input. Shell redirection and crash/broken-pipe delivery
are external to this read-only operation. Preserve originals; an explicit rerun
revalidates both inputs instead of resuming or combining earlier output.

Snapshot v1–v4, history v1/v2, timeline, revalidation, watch/stability, single-block
events v1/11 requests and events-range v1 remain unchanged. No item 35 behavior,
dependencies, credentials, scheduler, release tag or npm publication is added.
