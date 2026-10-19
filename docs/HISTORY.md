# Explicit local history (version 1)

Added 2026-10-15. History is an offline store of explicitly selected saved
snapshots, separate from live capture. It does not read RPC/config environment
variables, connect to a provider, migrate a snapshot, discover target folders,
import neighboring files or infer missing observations. Read-only timeline was
added 2026-10-19. Pruning, watching, stability and reorg analysis remain separate
roadmap items.

## Commands and identity

Choose one directory for one compatible target identity:

```sh
mkdir -p snapshots/history
node bin/contract-watch.js history init examples/before.json --dir snapshots/history/demo-v1
node bin/contract-watch.js history add examples/before.json --dir snapshots/history/demo-v1
node bin/contract-watch.js history add examples/after.json --dir snapshots/history/demo-v1
node bin/contract-watch.js history verify --dir snapshots/history/demo-v1
```

These files are synthetic. For real data, explicitly capture to a normal new
snapshot file first, then select it for `history add`. `init SOURCE --dir NEW`
exclusively creates a private directory in an existing parent and binds its
identity from SOURCE. **Init creates an empty index; it does not add SOURCE.**
Existing directories, files and symlinks are refused. `add SOURCE --dir DIR`
adds exactly that observation. `verify --dir DIR` is read-only. Each command
requires exactly one `--dir`. Verify and timeline omit SOURCE; only timeline
accepts the optional valueless `--json` flag. Other flags, duplicate flags and
positional arguments to verify/timeline are rejected. Prefix paths beginning
with `-` with `./`.

Identity consists of the exact normalized **address, decimal chain ID, source
kind, snapshot version and genesis state/hash**. Each component must match the
header. Strict snapshot v1, v2, v3 and v4 are accepted, including migrated v3/v4,
but different versions or synthetic/RPC sources never mix in one directory.
V1–v3 bind genesis as `not-recorded`; v4 retains its observed hash or explicit
`not-recorded`. Unknown and observed genesis never match. No hash is inferred
from chain ID, block number or another entry. Two unknown genesis observations
share only their recorded identity; this does not prove network equivalence.
Matching observed genesis also does not prove uniqueness, ancestry or honesty.
Migration provenance remains in the snapshot and is not changed by history.

Source bytes, permissions and filesystem mtime remain unchanged. The history
copy preserves the first accepted source's exact bytes, including embedded
`capturedAt`, migration provenance and raw observations. New copy filesystem
timestamps record local file creation; they are not substituted for capturedAt.
Reads may affect access time. Files are mode 0600 and the new directory 0700 on
POSIX, subject to the process umask. Use local directories you control.

## Immutable index and filenames

A directory contains three types of published files:

- `index.json`: immutable history header, at most **4096 bytes**.
- `entry-0001.json` through `entry-0128.json`: contiguous, immutable index entries,
  each at most **4096 bytes**, in publication order.
- `snapshot-<observationId>.json`: ordinary strict snapshot v1–v4 files. IDs are
  exactly 64 lowercase hexadecimal characters; no input name enters a filename.

This collection of immutable entry files is the index; the header is never
rewritten as the history grows. At most **128 indexed observations** are allowed.
The header plus all entry files occupy at most **516 KiB** under the read limits.
The directory reader collects at most **512 names**, including pending snapshots,
stages and foreign files, and rejects the 513th. No recursive scan occurs.

The closed header schema is:

```json
{
  "kind": "contract-watch-history",
  "schemaVersion": 1,
  "identity": {
    "address": "0x1111111111111111111111111111111111111111",
    "chainId": "1",
    "source": "synthetic",
    "snapshotVersion": 1,
    "genesis": { "status": "not-recorded" }
  }
}
```

With observed v4 genesis, `genesis` instead has exactly `status: "observed"` and
`hash`, a normalized nonzero 32-byte hash. No unknown keys are accepted.

Each entry has exactly these fields:

| Field | Meaning |
| --- | --- |
| `kind`, `schemaVersion` | `contract-watch-history-entry`, integer `1` |
| `ordinal` | Integer 1–128, matching its four-digit filename with no gaps |
| `previous` | SHA-256 of the previous entry's exact bytes; for ordinal 1, of the header's exact bytes |
| `observationId` | SHA-256 of the snapshot's canonical JSON, described below |
| `snapshot` | The exact generated snapshot basename for that ID |
| `sha256`, `bytes` | SHA-256 and integer byte length of the stored snapshot's exact bytes |
| `capturedAt`, `block` | Exact saved timestamp and `{number, hash}` copied from the validated snapshot |

Canonical JSON recursively sorts object keys using JavaScript string sort and
uses JSON.stringify for keys/primitives, with no whitespace; array order is
preserved. Schema values here use ASCII field names and bounded canonical data.
The digest includes the complete snapshot, including capturedAt and provenance.
Re-adding the same logical snapshot with different whitespace/key order returns
`already-present`, retaining the first stored bytes and ordinal. A different
capture timestamp is a new observation even if all observed state matches.
Same-height/different-state observations can be stored; no reorg conclusion or
chronological sorting is made. Index order is append order, not block/time order.

An existing snapshot filename is reused only after strict validation, matching
identity and canonical content. A conflicting/invalid file is an error, never
an overwrite. Every operation validates all published snapshots, including
pending ones, and every index record: byte digests/lengths, IDs, metadata,
identity, unique membership and the contiguous previous-digest chain. Gaps,
unknown fields, missing files, modified snapshot bytes and mismatched entries
fail safely. These are consistency checks, not authenticated evidence. Removing
an entire valid tail, or rewriting all files consistently, cannot be detected
without an external trusted copy. Equivalent JSON encoding of the last index
record is not itself corruption; its fields still must exactly match.

## Publication, concurrency and recovery

Each file is written to a new `.cw-stage-<UUIDv4>.tmp` in the target directory,
flushed with file fsync, and its write handle closed before a same-directory
hard link publishes the final name without replacement. A retained read handle
pins the inode while the current writer checks/removes only its own stage name.
A write, sync, close, publication or cleanup failure returns a fixed error.
Never delete a published snapshot or entry to compensate for another failure.

For an add, publish the complete snapshot **first**, then its complete index
entry. **The entry's successful hard link is the observation commit point.**
An observation without that entry is pending and is never counted as committed.
A report is constructed only after revalidating the resulting store. A failure
or signal after the commit point can prevent delivery of stdout; verify before
assuming that nothing was added.

Concurrent writers compete for the next ordinal through no-overwrite links.
An identical entry can be reused after validation. Different contenders cannot
overwrite or skip each other's ordinals: the loser receives HISTORY_CHANGED and
its snapshot can remain pending. There is no persistent lock, stale lock
breaking, PID trust or automatic retry loop. Directory changes during validation
also yield HISTORY_CHANGED; explicitly retry after other writers finish.
The ordinal namespace enforces the 128-entry bound even with contenders. The
512-file read/admission bound is not an OS disk quota: concurrent processes or
external writers can exceed it, after which inspection is refused until the
user has inspected/relocated excess files manually. No automatic deletion occurs.

Explicit recovery uses the selected source again:

```sh
node bin/contract-watch.js history verify --dir snapshots/history/demo-v1
node bin/contract-watch.js history recover snapshots/selected.json --dir snapshots/history/demo-v1
```

Recovery is limited to that exact validated observation and identity:

| Interrupted state | Action |
| --- | --- |
| No published header and only staging files/empty directory | `recover SOURCE --dir DIR` publishes the identity header and returns `initialized`; then use add |
| Snapshot never published (possibly a partial stage remains) | Repeat `add SOURCE`; recover reports HISTORY_RECOVERY |
| Complete snapshot published, entry absent | `recover SOURCE` appends its entry; explicitly repeating add is also safe |
| Entry already published, report lost | Add/recover returns `already-present` with its existing ordinal |
| Missing header with published snapshots/entries, invalid snapshot/index, foreign name or symlink | Refuse mutation; preserve everything for manual inspection/backup |

If the original source is unavailable, the user may explicitly name the pending
snapshot file as SOURCE. That is still a strict validation and explicit selection;
no orphan is imported just because it was found in the directory. Other pending
observations stay pending. Recovery does not discard committed observations,
replace a header, fill arbitrary gaps, change identity or fabricate timestamps.

Abandoned stages are **never imported, promoted or swept**. Their names are
recognized only for counting and regular-file/size checks, and their partial
contents are not observations. A stopped writer's stages can remain after
successful recovery. Inspect them manually with all writers stopped before any
manual deletion. Unknown names, directories, symlinks and special files are
refused and preserved. No recursive deletion, pruning or deletion based solely
on a filename pattern is implemented.

## Read-only timeline

```sh
node bin/contract-watch.js history timeline --dir snapshots/history/demo-v1
node bin/contract-watch.js history timeline --json --dir snapshots/history/demo-v1
```

The caller selects one existing initialized history directory. No config/env,
RPC, discovery, migration, imports, recovery or filesystem writes occur. All
committed and pending snapshots and the entire index must validate. A malformed
pending file, missing committed file, mixed identity, foreign name or broken
chain fails the report; invalid records are never silently skipped. Stages are
checked for type/size and counted, but their partial contents are never parsed
as observations. Pending and stages are excluded from comparisons.

Timeline returns observations in **index ordinal order** (publication order).
It never sorts, reverses, merges, fills gaps or infers events. CapturedAt stays
the recorded UTC string; block numbers stay canonical hexadecimal strings in
JSON and use exact BigInt decimal rendering in text. Equal heights, equal times,
repeated states and distinct later captures of the same block remain visible.
An identical logical capture already deduplicated by add has only one ordinal.
Zero observations produce an empty observation/pair list; one produces no pairs.

Each adjacent pair uses the existing strict diff comparison, including snapshot
version, chain, target, source and v4 genesis requirements. Target code compares
full decoded-equivalent hex bytes; all three raw slot words compare exactly.
Implementation address/code changes are separate, and compare only available
observations of the same provenance. `no-code` is a recorded empty-code endpoint;
`skipped` and `not-recorded` are unavailable, never empty or unchanged code.
Changed provenance is explicit and produces no implementation changes. V1 has
no saved implementation observation. No recursion or beacon resolution occurs.

The policies for irregular order and identity are:

| Condition | Timeline behavior |
| --- | --- |
| Later ordinal has a lower height | Retain both observations; that adjacent pair is `unavailable` with fixed `ORDER` reason, without `changed`, `changes` or `implementation` fields. Continue with subsequent adjacent pairs; never reverse the pair. |
| Equal height or equal capture time | Compare in index order; no inferred elapsed time, ancestry or missing event. |
| Capture time decreases | Retain and compare in index order, subject to the height/identity rules; emit `CAPTURE_TIME_DECREASED`. |
| Same height, different hash | Retain observations and emit `SAME_HEIGHT_DIFFERENT_HASH`; do not select a canonical branch or label a reorg. |
| Same hash, conflicting recorded state/height | Emit `INCONSISTENT_BLOCK_DATA`; missing implementation history alone is not a contradiction. |
| V4 unknown genesis, 0 or 1 committed observations | Display the recorded identity/observation; no comparison is performed. |
| V4 unknown genesis, 2 or more committed observations | Fail the entire report with `GENESIS_UNAVAILABLE`, including a decreasing-height pair. No partial stdout or successful unavailable-genesis report. |
| Different version, target, chain, source or genesis within the store | Fail strict history validation; no mixed-identity comparison. |

Height/time decrease notices refer to the preceding ordinal. Hash notices scan
the entire earlier prefix and identify the earliest conflicting peer per category
for each current observation, including nonadjacent peers. Cross-observation code
consistency notices use bounded SHA-256 summaries, raw slots, number and recorded
implementation details; adjacent diffs still compare full code bytes. Notices
are not an exhaustive list of every conflicting pair, nor does their absence
prove consistency, provider honesty or authenticity. No reorg reconstruction,
stability policy, upgrade detection, finality or canonical-chain claim is made.
Unchanged endpoints cannot rule out intermediate changes; changed endpoints do
not identify the number, cause, block or time of events between them.

### Timeline JSON v1 and exit policy

The report is independently versioned from snapshots and history storage:

| Field | Meaning |
| --- | --- |
| `kind`, `schemaVersion`, `order` | `contract-watch-history-timeline`, integer `1`, `index` |
| `identity` | Exact history header identity, including snapshotVersion and genesis |
| `committed`, `pending`, `staged` | Counts; only committed observations enter the timeline |
| `observations` | Ordered `{ordinal, observationId, capturedAt, block, code, slots, implementation}` summaries |
| `transitions` | Adjacent `{from, to, status}` pairs, with the fields described below |
| `notices` | Ordered `{code, beforeOrdinal, afterOrdinal}` records |
| `caveats` | Fixed explanatory strings about endpoint-only evidence and excluded data |

`code` is `{bytes, sha256}`. Each slot is `{raw, status, address}`, with status
`empty`, `address` or `noncanonical`, and null address unless canonical/nonzero.
Implementation is null for v1; otherwise it retains `status`, skip `reason` or
available `via`, `address`, code fingerprint, and beacon `beacon`/`raw` when
recorded. Raw bytecode, paths, filenames, config/env references and arbitrary
on-disk text never enter the report.

A `compared` transition has `changed`, target `changes`, and `implementation`
(null for v1). Change entries and implementation comparison fields have exactly
the existing diff semantics: target fields are `code`, `implementation`, `admin`,
`beacon`; implementation fields are `address` and `code`. Implementation carries
`comparison` (`comparable`, `unavailable` or `provenance-changed`), both summarized
endpoints and `changes`. `changed` means either comparable change list is nonempty;
false does not mean missing/uncompared implementation state stayed unchanged.
An `unavailable` transition has only `from`, `to`, `status` and fixed
`reason: {code: "ORDER", message: ...}`. Notices for each observation appear in
height-decrease, time-decrease, height-conflict, hash-conflict order when applicable.
See [independent synthetic JSON](../test/fixtures/timeline/expected.json) and
[text](../test/fixtures/timeline/expected.txt).

A valid text/JSON timeline exits **0**, including nonzero pending/stage counts,
notices and unavailable decreasing-height comparisons. Errors exit **1**, with
empty stdout and fixed safe stderr, and there is no exit 2 or `--exit-code`.
No output is emitted until every read, consistency recheck and close succeeds.
An interrupt before output uses normal offline process behavior and makes no
history changes; output delivery itself is not a filesystem transaction.

Timeline performs two complete validation passes and up to 128 committed
snapshot rereads, comparing store metadata/digests and root identity/mtime/ctime
across the operation. It retains summaries plus adjacent raw snapshots, rather
than all historical bytecode. At most 128 observations, 127 pairs and 508 notices
are produced. Existing file/nesting/count limits are unchanged; a conservative
read budget is below 865 MiB including index files at every maximum, with no
filesystem latency deadline. Stable changes during traversal fail safely with
HISTORY_CHANGED or HISTORY_CORRUPT; callers can retry explicitly after writers
finish. These checks are not a lock or atomic filesystem snapshot. Trusted path
and hostile-race limits below still apply.

## Other history reports, resource bounds and limits

Init/add/verify/recover success stdout is one JSON object with exactly `kind: "contract-watch-history-result"`,
`schemaVersion: 1`, `operation`, `status`, `committed`, `pending` and `staged`.
Add/recover of an observation also includes `observationId`, `ordinal` and the
safe generated `snapshot` basename. Initialization has no observation fields.
Statuses are `initialized`, `added`, `recovered`, `already-present`, `verified`
or `pending`. Verify returns `pending` and **exit 1** when unindexed snapshots
exist; its JSON distinguishes them from committed data and stderr is empty.
Other successful operations exit **0**; their pending/staged counts can describe
other unfinished work. Stages are never counted as committed or pending snapshots.
A verified store can therefore still report nonzero staged files.

Validation, identity, capacity, conflict and I/O errors exit **1**, with empty
stdout and a fixed safe stderr code/message. No source/directory path, input
filename, RPC/env/config name, credential, raw exception or arbitrary on-disk
string enters a report or error. Generated snapshot basenames are schema data.
HISTORY_WRITE can mean publication succeeded but cleanup/verification failed;
always verify and retry/recover explicitly. There is no JSON error envelope.

History reads use lstat, nonblocking/no-follow open, fstat and pathname checks;
nonregular files and final symlinks are refused. Regular hard links may be read
but never modified; source copying creates an independent inode. Reads recheck
inode/mode, size and nanosecond mtime to detect concurrent substitution/change.
Each buffer is fixed at its byte limit plus one, and reading stops there even
if stat lies or the file grows. UTF-8 is fatal, BOM and duplicate decoded keys
are rejected, and nesting is limited to six before JSON.parse. Source/snapshot
reads are capped at **768 KiB + 1 detection byte**, with v1 additionally rejected
above **512 KiB**. Snapshot schemas and per-code 128 KiB bounds remain unchanged.
Index reads are capped at **4096 + 1 bytes**. Files are processed sequentially;
only metadata for the bounded directory is retained, not all snapshot bytecode.
One complete validation pass can read roughly 384 MiB in a maximally populated pending directory;
there is no filesystem latency deadline or large-history optimization here.

Use a local filesystem supporting hard links and trusted parent paths. Parent
symlinks in explicitly supplied paths can be resolved by the OS (for example
macOS temporary roots); final history/source symlinks are refused. Stored paths
cannot escape the target directory: only validated generated basenames are used.
Directory identity is rechecked before filesystem work and publication. These
checks are separate syscalls, not atomic conditional unlink/open-by-directory-FD
operations. They detect stable replacements but do not promise safety against
hostile path swaps, inode reuse or forged metadata during race windows.

History commands use normal offline process signal behavior; they do not install
live capture's cancellation handlers or rollback already published history.
SIGINT/SIGTERM/SIGKILL/crashes may leave stages, pending snapshots or a committed
entry without its report. Recovery above is designed for these process-stop
states. File fsync plus hard links does **not** provide power-loss atomicity or
directory durability: no directory fsync/durable transaction journal is promised.
Power loss may lose names; validation detects inconsistent remaining data but
cannot reconstruct missing bytes or detect a wholly lost tail. Preserve source
files and independent backups. Live snapshot/snapshot-many cancellation, retry,
deadline, pinning and formats, and offline inspect/diff/migrate, are unchanged.

The implementation uses the documented Node.js
[bounded file reads](https://nodejs.org/docs/latest-v22.x/api/fs.html#filehandlereadbuffer-offset-length-position),
[directory iteration](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesopendirpath-options)
and [hard-link publication](https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromiseslinkexistingpath-newpath).
The history schema, consistency checks and recovery choices are application policy.
