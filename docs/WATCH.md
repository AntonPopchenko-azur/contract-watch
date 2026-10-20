# Finite watch sessions

Added 2026-10-20. `watch` observes **one explicitly selected target** repeatedly
through the existing strict capture engine. It runs in the foreground, with no
system scheduler, background daemon, startup recovery, automatic history import,
migration or pruning. It does not compare observations, mark them stable, label
upgrades/reorgs, or infer intermediate events.

```sh
# Choose your endpoint explicitly; this example is a local node.
export CONTRACT_WATCH_RPC_URL='http://127.0.0.1:8545'
mkdir -p snapshots
node bin/contract-watch.js watch \
  --address 0x1111111111111111111111111111111111111111 --chain-id 1 \
  --out-dir snapshots/session-001 --interval-ms 1000 --count 10 --duration-ms 60000

# Or select exactly one definition from an explicit config:
node bin/contract-watch.js watch --config examples/targets.json --target demo-main \
  --out-dir snapshots/session-002 --interval-ms 5000 --count 12 --genesis
```

Set the selected config entry's environment variable before the second command.
There is no default provider. A session always needs a **new** directory in an
existing trusted parent. It cannot append to or reuse a history/session directory.

## Input and resource bounds

| Option | Required / limits |
| --- | --- |
| `--interval-ms MS` | Required, canonical decimal 100–60000 milliseconds |
| `--count N` | Optional, canonical decimal 1–128 observation **attempts** |
| `--duration-ms MS` | Optional, canonical decimal 100–600000 milliseconds |
| `--out-dir NEW` | Required exclusive new private directory |

At least one of count or duration is required. With both, the first reached
limit stops the session. Even duration-only sessions have a **128-attempt hard
cap**, including every failed attempt. Count does not promise N successful files.
Missing finite limits fail with `WATCH_LIMIT` before config, env, RPC or output.
Signs, whitespace, leading zeros, fractions, exponents, hexadecimal, Unicode
digits and oversized values are rejected for these three options. There are no
defaults for interval or a user stop limit.

Common single-capture options keep their semantics: direct address/chain/RPC,
block/tag/hash/depth, checksum, timeout, retries/deadline, genesis and either
implementation-code or live beacon resolution. Watch additionally rejects
leading zeros in `--timeout-ms`; timeout remains 100–60000. Retry/deadline/depth
retain their canonical decimal validators, while chain IDs and block numbers
retain their documented exact decimal/hex uint256 forms. No numeric conversion
through floating point is used for chain IDs, block numbers or depth.

`--config` and `--target` must occur together, exactly once, and prohibit any
address/chain/RPC override. Validate the entire config, including unused entries,
and the selected capture input before reading only its selected endpoint **once
per session**. Reuse that endpoint without rereading env or falling back. Direct
mode validates input before reading `CONTRACT_WATCH_RPC_URL`; explicit `--rpc`
has the existing precedence. Invalid/missing endpoint is a global error before
directory creation. Config bytes/metadata are unchanged. No name, config path,
environment reference or endpoint is copied into a snapshot/report.

Unknown/duplicate/missing flags, equals syntax, positional arguments, repeated
targets, `--out`, `--shared-block`, `--concurrency`, `--json` and `--exit-code`
are refused. Other commands reject watch-only options. No config schema changes.

## Time, attempt admission and stopping

After validation, endpoint resolution and exclusive directory creation, start
the monotonic duration clock and attempt 1 immediately. There is no initial
interval delay. Each attempt owns the complete capture, publication, cleanup and
handle-close sequence. **No overlap** is allowed, including filesystem work.

Use **fixed delay**: after an attempt fully finishes, wait at least interval MS
before admitting the next attempt. Long captures/writes shift subsequent starts;
late wakes start at most one attempt. Never catch up missed ticks in a burst.
Early wakes re-wait the remaining monotonic interval. Duration wakes also recheck
monotonic time. Local wall-clock changes do not alter interval/duration, while
`capturedAt` remains the capture engine's real UTC wall-clock observation time.
Retry-After HTTP dates retain their existing one-time wall-clock conversion.

The duration timer aborts active HTTP requests, capture retry/backoff/Retry-After
waits and interval waits. Every capture-policy check also checks the monotonic
session boundary synchronously, so a late timer callback cannot authorize a new
RPC/retry. Never start another observation after count, duration, hard cap or a
handled signal. At a coincident boundary, an expired duration wins over count/cap;
an already handled SIGINT/SIGTERM wins over duration and ordinary capture errors.

Per-capture `--deadline-ms` starts afresh at admission and includes that capture's
reads and retries. Its exhaustion is an ordinary failed observation; later
observations may proceed within session limits. It excludes file work, as before.
Session duration includes interval and file work but is **not a hard filesystem
or process wall-time deadline**: already submitted syscalls and transport-close
cleanup must finish. Event-loop delays can postpone handling. Signals/duration
never abandon a writer and report completion while cleanup is still running.

If duration expires during an active capture or before that observation's commit,
cancel/drain it and remove only its verified owned unfinished output. Its ordinal
is `stopped`, with no saved filename or block claim. If duration expires between
attempts, no new ordinal is allocated. If duration expires after an observation's
commit, that observation stays saved. Cleanup/close failure is global and stops
further admission even when the original cause was duration or an ordinary error.

## Capture and request contract

Each attempt independently resolves the chosen selector. Advancing `latest`
heads can produce different blocks; an explicit hash stays that same requested
hash. All existing EIP-1898 pins, canonical/hash/number, initial/final chain and
optional genesis rechecks remain. There is no selector, endpoint, expected-chain
or unsupported-method fallback. Observations are independent: no additional
cross-attempt ancestry/genesis/stability rule is inferred. Offline v4 diff still
refuses different or unrecorded genesis.

All response/header/code/snapshot caps and bounded beacon gas/call/time rules
are unchanged. Per logical read, positive retries allow at most 1+R attempts
for existing transient errors only, with unchanged parameters and fresh IDs.
Nonretryable identity/protocol errors end that observation; the next **scheduled
observation**, if limits permit, starts a fresh capture rather than retrying or
repairing the old pin. Refused/excessive Retry-After never causes an early retry.
An accepted minimum longer than remaining session time is interrupted by duration.

For A admitted observations (A≤128), R retries (0–3), g=1 with genesis, s=1 for
hash/positive-depth, and per-observation eligible C code read/B beacon call
(each 0 or 1), the logical maximum is `A*(8+s+2*g+C+B)`. Maximum wire attempts
are `(1+R)` times that bound: at most **6656** in the largest mode (128×13×4).
Failure/stopping truncates the trace. Config and filesystem operations add no
RPC. At most one client request is active; the previous transport closes before
retry or later admission. Existing per-request and per-capture budgets apply.

## Publication, ownership and commit points

Directory mode is 0700; files are 0600 on POSIX, subject to umask. Filenames are
fixed `observation-001.json` through `observation-128.json`, with **gaps for failed
or stopped attempts**. They contain ordinary strict snapshot v1, v2 or v4, without
watch fields. Inspect/diff/migrate and explicit history init/add can reuse them.
No history index, summary file, lock file or manifest is created.

The current observation uses the existing exclusive temporary file, bounded
serialization, file fsync, pre-publication write-handle close and atomic
no-overwrite hard link. A pinned inode and checked parent/file metadata protect
normal cleanup. A final link is visible before cleanup completes; visibility
alone is **not** confirmation of the observation.

The **observation commit point** is the synchronous clearing of its rollback
journal in `WatchOutput.commit`, after temporary-name cleanup, final parent/file
identity/size/mtime verification, all handle closes, one event-loop turn and
signal/duration checks. There is no await between the final check and this
marker. Only then may the outcome become `saved`. Later attempts, ordinary
failures, duration or SIGINT/SIGTERM cannot roll back earlier committed records.
Single snapshot and batch retain their original whole-invocation rollback rules.

Before that point, ordinary errors, duration and handled signals roll back only
the current journal, including a just-linked final name. Verify inode/mode,
size/mtime and parent before unlink; preserve missing/replaced/modified or
uncertain paths. Never delete recursively, sweep by filename pattern or remove
a foreign collision. Retain the session directory even when empty or interrupted
during creation. It is not retried/reused automatically.

Only the current observation's journal/handles are retained: at most two file
handles, at most 128 published snapshots and one current temporary name
(at most **129 owned directory names** during the last hard-link cleanup).
The temporary and final name refer to the same inode after publication.
Snapshot content is at most 64 MiB total for 128 maximum v1 files, or 96 MiB for
v2/v4, excluding filesystem overhead. Foreign writers are not subject to a disk
quota. Cleanup failure stops immediately, preventing accumulation across retries.

## Session JSON v1 and exit policy

Normal count/duration/cap completion writes exactly one final JSON document to
stdout, after all started work and timers have drained. Root fields:

| Field | Meaning |
| --- | --- |
| `kind`, `schemaVersion` | `contract-watch-session`, integer 1 |
| `address`, `chainId` | Normalized target and exact decimal expected chain ID |
| `limits` | `{intervalMs, count, durationMs, maxAttempts:128}`; omitted user limits are null |
| `stopReason` | `count`, `duration` or `attempt-limit` |
| `attempted`, `saved`, `failed`, `stopped` | Integer counts; attempted=saved+failed+stopped |
| `outcomes` | Ordinal-ordered observations, including failures/stops |

Each outcome has `ordinal` and `status`. `saved` additionally has `file`,
`snapshotVersion`, exact `block:{number,hash}`, and only for live resolution the
existing `beaconResolution` result. `failed` has only fixed safe
`error:{code,message}`. `stopped` has only `reason:"duration"`; at most one is
possible and it is last. No unconfirmed filename/block appears as success.
Reports do not include timestamps, config/env names, endpoint, raw provider
errors/headers, stacks or bytecode. Nothing is printed per attempt.

| Result | Exit / stdout / stderr |
| --- | --- |
| Normal limit, ≥1 saved and no failed/stopped attempts | 0 / session JSON / empty |
| Normal limit, any failed/stopped attempts or no saved files | 1 / session JSON / empty |
| Global validation/directory/cleanup/internal error | 1 / empty / fixed safe error |
| First handled SIGINT | 130 / empty / `WATCH_CANCELLED` or `WATCH_CLEANUP` |
| First handled SIGTERM | 143 / empty / `WATCH_CANCELLED` or `WATCH_CLEANUP` |

First signal wins; later signals cannot bypass drain/cleanup or change its code.
No partial JSON is emitted on error/interruption. `WATCH_CANCELLED` confirms
cleanup of the current owned unfinished output, **not removal of earlier saved
files**. `WATCH_CLEANUP` means uncertain leftovers/close failure and requires
inspection; it retains 130/143 if interrupted. Both are fixed safe messages.
Global errors may leave earlier committed snapshots without a final report.

Session output has a separate completion marker after report construction, timer
closure, a final event-loop turn and signal check, immediately before stdout.
A signal before it suppresses JSON but cannot undo individual commits. Signals
before handlers are installed or after removal use normal process behavior.
Output submission is not a guarantee that a pipe consumer receives every byte.
Existing broken-pipe handling remains unchanged.

## Partial output, recovery and limits

Use trusted local directories supporting hard links. Identity checks and unlink
are separate syscalls; they cannot defeat hostile concurrent swaps, inode reuse
or forged metadata. A stable substituted directory is refused, with uncertain
files preserved. Do not mutate a live destination. Added/user/substituted files
are never swept; their presence can prevent safe cleanup.

After any interruption or error, keep the directory for inspection and **retry
with a new directory**. No resume, cleanup command or durable watch journal
exists. Fully completed snapshots remain usable offline, but absence of stdout
does not prove no commits occurred. SIGKILL, native crashes, machine shutdown,
power loss or hung I/O can leave temporary names and a complete-looking current
snapshot whose in-memory commit was never confirmed. Do not infer confirmation
from its filename alone. No directory-fsync or crash/power-loss atomicity promise
is added; preserve backups and inspect explicitly. Never auto-import such files
into history or infer missing observations.

Tests use independently expected traces/reports, fake monotonic time, loopback
RPC, disposable directories and real child signals/IPC barriers. Existing
snapshot/batch cancellation and offline suites remain compatibility checks.
