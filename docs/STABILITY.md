# Consecutive observation policy

Added 2026-10-20. This is an opt-in, local policy on the existing finite
single-target [`watch`](WATCH.md) session:

```sh
node bin/contract-watch.js watch --config examples/targets.json --target demo-main \
  --out-dir snapshots/policy-001 --interval-ms 1000 --count 32 \
  --genesis --implementation-code --stable-count 3
```

Supply the selected endpoint environment variable and existing parent as in
WATCH.md. `--stable-count N` takes one canonical ASCII decimal integer **1–16**.
No signs, whitespace, leading zeros, hex, exponents, fractions or Unicode digits.
Duplicates, missing values, equals syntax and use on another command are usage
errors. An invalid value gives fixed `STABILITY_OPTION` before config/env/RPC/
output. It does not supply the mandatory watch interval or count/duration limit.
There is no config schema field or implicit default threshold.

Without this option, session JSON **v1**, snapshots, RPC traces/budgets, output
ownership, timers, exit codes and finite stopping rules are unchanged; no policy
state is retained. With it, session JSON is explicitly **v2**, adding only the
`stability` object below. Config, history, diff and snapshot v1–v4 are unchanged.

## What matches, and what does not

Only a snapshot **after its observation commit point** feeds this policy.
Captures that fail RPC, validation, publication, cleanup or the stop boundary
never become matching observations merely because a final filename was visible.
The policy uses validated committed snapshot values, not progress reports,
transient live-only beacon results, config names or provider messages.

The report declares its scope:

| Scope | Matching observed state |
| --- | --- |
| `target` (without `--implementation-code`) | Exact target code bytes and all three complete raw EIP-1967 words, including noncanonical high bytes |
| `target-and-implementation` (with `--implementation-code`) | The target fields above, plus available implementation status, address, complete code, `via`, and beacon address/raw return word when present |

Comparison uses exact validated state values, excluding block height/hash,
`capturedAt`, file metadata and ordinal. No code or slot normalization discards
data. `no-code` is an available observation of empty implementation code.
`skipped`, absent and `not-recorded` implementation values are **unavailable**,
never equal implementation state or empty code. In full scope they clear the
reference and candidate. When data becomes available again, start a new baseline.
Target-only scope explicitly excludes implementation equality claims, including
with `--resolve-beacon`: its transient result is not in the saved snapshot.

Available implementation values are comparable only under the same provenance:
the same `via`, and the same beacon address for `via:"beacon"`. A changed selected
implementation address/code under the same provenance is a candidate state.
A changed provenance establishes a new baseline without a transition, even when
target slots also changed. This conservative whole-state policy does not invent
an implementation transition across incompatible or missing data.

## Reference, candidate and threshold

The first eligible committed observation is the **baseline reference**, counted
as neither a matching candidate nor a stable transition. The baseline is an
endpoint for comparison; its creation does not satisfy the threshold.

For each eligible later observation:

1. Matching the baseline clears any candidate and records `baseline-match`.
2. A different state starts a candidate at one match.
3. Matching that candidate increases its count; another different state replaces
   it with a new one-match candidate.
4. At N matches, record a `stable` transition from the baseline, through the
   candidate's first ordinal, to the confirming ordinal. The confirming snapshot
   becomes the new baseline and the candidate clears.

For N=2, **A/B/A** cancels B without a transition; **A/B/B** records one.
**A/B/B/C/C/A/A** records B, then C, then a return to A. Continued readings of the
current baseline create no repeated transitions. N=1 labels the first eligible
different state immediately; there is still an initial baseline and all block/
identity/provenance checks. N=16 needs at least 17 eligible committed observations
for the first transition. Failure/repetition can require more attempts.
The [hand-written flapping fixture](../test/fixtures/stability/flapping.json)
pins a complete decision sequence.

## Block order, breaks and invalidation

The policy requires **adjacent increasing heights** for distinct counted blocks.
It uses exact BigInt arithmetic for all heights and uint256 identities. It does
not fetch parents, prove adjacency by hash ancestry, or inspect a chain fork.
The high-water height is the largest committed height seen under the initial
identity, including observations with unavailable implementation data.

| Observation / interruption | Policy effect |
| --- | --- |
| Identical repeat of the high-water block | `repeated`; preserve candidate but add **zero** matches. Repeated reads of a fixed block never qualify a new transition. |
| Height below high-water | `interrupted / NONMONOTONIC_BLOCK`; clear baseline/candidate, exclude this observation. The next eligible new higher block must establish a baseline. |
| Height jumps by more than one above high-water | Current observation becomes `baseline / BLOCK_GAP`; clear candidate, no transition across the gap. |
| Failed attempt | `interrupted / ATTEMPT_FAILED`; clear candidate, retain baseline and high-water. The next saved height still must pass the block rules. |
| Duration-stopped attempt | `interrupted / ATTEMPT_STOPPED`; clear candidate. No subsequent attempt is admitted. |
| Normal limit reached between attempts | Preserve the incomplete candidate in the final report; do not label it stable or extend the session. |
| Unavailable implementation in full scope | `unavailable / IMPLEMENTATION_UNAVAILABLE`; clear baseline/candidate, retain block evidence/high-water. |
| Different implementation provenance | Current observation becomes `baseline / PROVENANCE_CHANGED`; no transition across incomparable provenance. |
| V4 genesis not recorded | `unavailable / GENESIS_UNAVAILABLE`; no baseline or matches, even in target scope. Never infer missing genesis. |
| Incompatible saved identity | Invalidate the session policy, as described below. |
| Contradictory recorded block data | Invalidate the session policy, as described below. |

After an unavailable observation, a repeat of its block still adds no match and
cannot establish a new baseline; wait for an eligible new height within the
existing finite limits. Repeats are not new confirmations of chain history.
CapturedAt can decrease without changing this sequence; real timestamps remain
unchanged in the snapshots.

The first saved snapshot fixes policy identity: exact address, decimal chain ID,
source, snapshot version and genesis status/hash. A later incompatible saved
identity gives `IDENTITY_CHANGED`. V1/v2 have no genesis observation: matching
address/chain does not establish network equivalence. With v4, equal recorded
genesis still does not prove uniqueness, ancestry or provider honesty.

Check the entire bounded prefix of committed block evidence, not just the
previous observation. The same hash with a conflicting height, target code,
raw words or recorded implementation data gives `INCONSISTENT_BLOCK_DATA`.
Missing implementation data alone is not a contradiction with recorded data.
Different hashes at the same observed height give `HEIGHT_CONFLICT`.
Compact SHA-256 summaries bound memory for these prefix checks; exact state
comparison is used for baseline/candidate matches. Hash collision resistance is
a limitation of the contradiction checks, not a provider authenticity guarantee.

Any of these three conflicts **latches invalidation** for the rest of the session:
clear baseline/candidate, mark all previously recorded transitions `invalidated`,
record the invalidating ordinal/reason, and label subsequent outcomes `inactive`.
Earlier per-observation decisions remain the historical trace of what the policy
decided then; they must not override the final invalidated status. A later return
to an earlier identity/state does not restore validity. This is a refusal to
continue a local comparison, **not reorg detection or branch reconstruction**.
All snapshots remain; normal finite capture continues with its existing limits.

## Session report v2

V2 retains every v1 field and outcome unchanged, sets `schemaVersion:2`, and
appends `stability`. Its closed fields are:

| Field | Meaning |
| --- | --- |
| `kind`, `threshold`, `scope` | `consecutive-observations`, N, scope from above |
| `status` | `active` or `invalidated`; active does not promise a stable transition |
| `invalidatedAt`, `reason` | First conflicting ordinal/fixed reason, otherwise null |
| `baselineOrdinal` | Current reference ordinal, or null after a break/invalidation |
| `candidate` | Null or `{firstOrdinal,lastOrdinal,matches}` for the unmet candidate |
| `observations` | One decision per admitted outcome, in ordinal order |
| `transitions` | Ordered threshold decisions with final validity status |
| `caveats` | Fixed strings limiting the meaning of stable and unavailable data |

Each decision is exactly `{ordinal,status,reason,referenceOrdinal,
candidateOrdinal,matches}`. Status is `baseline`, `baseline-match`, `candidate`,
`stable`, `repeated`, `interrupted`, `unavailable`, `invalidated` or `inactive`.
Reason is the fixed token from the table, `BASELINE` for an ordinary new reference,
or null for a normal match/candidate/stable decision.

`referenceOrdinal` points to the reference used by that decision, or null.
`candidateOrdinal` and `matches` show the current candidate (null/0 if absent).
On a `stable` row they describe the just-completed run and its **old** reference;
later rows use the new reference at the confirming ordinal. A repeat preserves
the prior candidate's values but never updates its last counted ordinal.

Each transition is exactly `{status,fromOrdinal,firstOrdinal,confirmedOrdinal,
matches}`. Status is `stable` unless subsequently invalidated, then `invalidated`.
Ordinals refer to the ordinary v1-shaped session outcomes and their saved files.
No raw code, paths, config/env names, endpoint, arbitrary exception text, new
timestamps or snapshot fields enter the policy report.

Exit codes remain **capture outcomes**, not a policy verdict: 0 for saved
observations with no failed/stopped attempts, 1 for ordinary failed/stopped or
global errors, 130/143 for the first handled signal. A pending candidate,
unavailable policy or invalidated comparison can coexist with exit 0. Consumers
must inspect `stability.status`, `transitions[].status` and scope before using
these labels. No exit 2, extra stdout, progress JSON or threshold-triggered exit.

## Limits, cancellation and interpretation

The existing count/duration/128-attempt cap always ends the session, even when
the threshold has never been met. No extra RPC, timer, retry, provider fallback,
background scheduler or automatic import/prune occurs. Hash pins and final
checks remain independent per capture. The policy adds only bounded local work
after each observation commits; ordinary monotonic fixed delay follows it.

Retain at most two exact state projections (baseline/candidate), plus the current
bounded snapshot; never retain all raw code blobs. At most 128 compact hash/height
records, 128 decision rows and 127 transitions are stored. The pretty-printed
policy object stays below 64 KiB under these fixed field/token/count bounds.
Original file/code/response bounds and safe errors remain unchanged.

SIGINT/SIGTERM and duration preserve the watch commit/drain/cleanup contract.
An interrupted/global-error invocation has empty stdout, even if earlier
snapshots committed or the in-memory policy already met its threshold. No policy
sidecar or durable resume state is written. Crash/SIGKILL/cleanup failure may
leave unconfirmed output as described in WATCH.md; retry with a new directory.

**Stable means only that this local rule observed N matching eligible saved
states.** It does not assert continuous state between observations, safety, a
transaction/upgrade/event, block ancestry, canonical-chain reconstruction,
reorg detection or finality. A matching provider can repeat false information;
availability and comparable provenance are not independent verification.
