# Local target configuration

`snapshot --config FILE --target NAME --out NEW.json [capture options]` selects
exactly one named target from an explicit local file. Multiple definitions are
allowed; this command captures only one. For several explicit targets, use the
separate batch command below. Implicit first-target selection, discovery,
includes, `.env` loading and interpolation are not supported. No public provider is selected.
The [example](../examples/targets.json) contains invented targets and environment
reference names only; it contains no endpoint, key or observed chain state.

## Strict format and limits

The root is exactly `{ "schemaVersion": 1, "targets": [...] }`. Config schema
version 1 is independent of snapshot and JSON diff versions. `targets` must be
an array of **1–32** entries, each with exactly these four required fields:

| Field | Contract |
| --- | --- |
| `name` | ASCII string matching `[a-z][a-z0-9-]*`, 1–64 characters; unique, case sensitive |
| `address` | Existing target validator: `0x` plus exactly 40 hex digits, any letter casing; zero address allowed |
| `chainId` | Exact string accepted by the existing chain-ID validator: positive decimal or `0x` hexadecimal uint256; JSON numbers are rejected |
| `rpcEnv` | ASCII environment variable name matching `[A-Z_][A-Z0-9_]*`, 1–64 characters |

Names cannot have spaces, uppercase letters, underscores or a leading hyphen.
Environment references contain neither `$` nor braces and cannot be URLs.
Repeated target names fail even if their other fields match. Reusing an address,
chain ID or environment reference under different names is allowed: distinct
names need not imply distinct networks. No additional keys, labels, comments,
provider URL fields or capture defaults are accepted at any level.

The file must be UTF-8 without a BOM and at most **16384 actual bytes**, including
whitespace. Invalid encoding, malformed JSON, trailing content/commas, duplicate
object keys (including escaped aliases and identical repeated values) and
nesting deeper than **three containers** fail. The permitted depth is root
object → targets array → entry object. Strings are scanned as JSON strings,
so quoted braces do not count as containers. A bounded lexical pass rejects
duplicates/deep nesting before JSON.parse; schema validation does not recurse.
The reader allocates only the byte limit plus one overflow sentinel.

Every entry is validated, including unused targets. Address syntax uses the
existing validator, and chain IDs retain exact integer parsing and the existing
input-length bound. Original address casing is retained until selection;
`--strict-checksum` applies to the original selected address, before lowercase
normalization for RPC and saved snapshots. Unselected addresses require syntax,
not the checksum requested for another target. The file is never rewritten or
normalized in place. No schema or target name is copied into the snapshot.

## Single-capture CLI conflicts and validation order

Both `--config FILE` and `--target NAME` are required together; `--out` remains
mandatory. Each takes one nonempty value, at most once. Equals-style options,
missing values, duplicates and unknown flags give `USAGE`. Use `./` when a file
value starts with `--`. Target names follow the grammar above.

With config, **any** `--address`, `--chain-id` or `--rpc` is `USAGE`, even if it
matches the selected target. There is no override precedence to guess. All
other existing capture options work: block/tag, block-hash, depth, checksum,
timeout, genesis, implementation-code or live-only resolve-beacon. Existing
mutual exclusions and valueless-flag rules remain. The config cannot supply
those options; they are explicit CLI choices.

The order is:

1. Parse required CLI flags, duplicates/conflicts and request timeout.
2. Open/read/decode the bounded config, rejecting unstable reads and validating
   its full structure and every target.
3. Validate the selected name and find exactly one entry.
4. Validate the selected original address/checksum, exact chain ID, block/hash/
   depth selection and genesis option with the capture engine's shared validator.
5. Read exactly the selected `rpcEnv` own property **once**, validate it as an
   HTTP(S) URL, then pass it to the unchanged RPC capture engine.
6. Run the same reads/rechecks, format and privately publish a new snapshot.

No environment value is read before steps 1–4 succeed. The unused entries'
references are never resolved, and a missing unused variable is acceptable.
Missing, empty, whitespace, non-string, overlong or otherwise invalid selected
values give `CONFIG_ENV`. URL validation is unchanged: at most 8192 characters,
HTTP(S), hostname required, no whitespace, embedded credentials or fragment.
Path/query authentication is permitted but never printed or saved. Getter
failures are also sanitized. No selected value is interpolated or trimmed.

There is **no fallback** to another target or `CONTRACT_WATCH_RPC_URL`; that
variable is read in config mode only if the selected entry names it explicitly.
Without config, the existing direct CLI still requires address/chain ID and
uses explicit `--rpc` ahead of `CONTRACT_WATCH_RPC_URL` as before.

## File behavior and failure contract

Only an open regular file is accepted, including a symlink resolving to one.
Nonblocking open prevents a FIFO from hanging the CLI; directories, FIFOs,
broken links, unreadable and missing files fail with `CONFIG_READ`. The reader
checks file size before reading, caps actual reads, then checks size/mtime/ctime
again through the same descriptor. Observed truncation, growth or metadata
changes fail. The descriptor closes on success and on read/parse failure.

The config is opened read-only. Its bytes, mtime, mode and identity are not
changed by the tool; reading may update access time. No temporary config,
cache, backup or normalized copy is created. Use a local directory you control.
This is not a lock or authenticity check: hostile concurrent replacement or
metadata-preserving edits are not fully preventable. Reading follows the opened
file descriptor; replacement of the path can yield the original opened file or
a detected change error, not a promise to read the newest path contents.

Single-capture errors exit **1** with empty stdout and a fixed safe stderr message. No
path, name, environment key/value, arbitrary JSON key, provider message or stack
is included. No new snapshot is created on validation, env, RPC or recheck
failure. The existing writer still refuses every existing output, including the
config itself or an alias, and cleans temporary output on normal failure.
Config content is not copied into success reports or saved files either.

| Code | Meaning |
| --- | --- |
| `USAGE` | Required flags, option syntax or conflicts are invalid |
| `CONFIG_READ` | File unavailable, nonregular, unstable or larger than 16 KiB |
| `CONFIG` | Invalid encoding/JSON/schema or any invalid target definition |
| `CONFIG_TARGET` | Selected name has invalid syntax or is not defined |
| `CONFIG_ENV` | Selected environment value absent or invalid |
| Existing address/checksum/block/depth/timeout codes | Selected capture options are invalid |
| Existing RPC/block/chain/genesis/file codes | The unchanged capture or output operation failed |

## Compatibility and verification

Config changes only how address, expected chain ID and endpoint are supplied.
It adds **zero RPC requests** and no new request deadlines; all existing base,
genesis and implementation/beacon budgets in [PROTOCOL.md](PROTOCOL.md) apply.
State reads remain pinned to one hash with requireCanonical, and the same final
block/chain/genesis checks run. Snapshot v1/v2/v4 selection, formats, private
atomic persistence, reports and stdout/exit policy remain unchanged. No config
version, path, selected name, rpcEnv, URL or secret enters a snapshot. Live beacon
results stay transient. Config names are not a network identity or safety claim.

`inspect`, `diff` and `migrate` reject `--config`/`--target` and never read a config
or its environment references, including when valid variables exist. Help and
version need no config, environment lookup or connection. Offline formats and
migration contracts are unchanged; automatic config discovery never runs.

Tests cover strict field/name/count/byte/depth/encoding boundaries, decoded-key
duplicates, unused invalid entries, symlinks/special files, injected growth,
truncation and descriptor cleanup, missing/invalid environment values and
validation ordering. Loopback tests compare direct and selected capture bytes,
stdout and complete RPC traces at the same test clock over all existing selector
and feature combinations. They cover uint256 chain IDs, original checksum
casing, anomalous slots, provider failures, noncanonical blocks, reorgs and final
chain changes. Child spies check selected-only environment access, offline paths
and error redaction. All targets, credentials and chain responses are synthetic;
no external RPC or secret is needed.

## Sequential one-shot batch capture

`snapshot-many --config FILE --target NAME [--target NAME ...] --out-dir NEW`
is a separate command. Reuse the unchanged config schema above. Explicitly
select **1–32 unique names**, in input order; no implicit all/first target,
selection glob, config discovery or address/chain/RPC override is accepted.
Different names may identify the same address and chain; each requested name
still gets an independent capture. Repeating a name is an error, not a retry.

Exactly one `--config` and `--out-dir` are required. Only `--target` is repeatable.
`--out`, `--address`, `--chain-id`, `--rpc`, `--all`, `--json`, `--exit-code`,
equals-style flags, extra arguments, missing/empty values and repeated ordinary
flags are `USAGE` errors. More than 32 selections or duplicate names give
`BATCH_TARGETS`; unknown/invalid names give `CONFIG_TARGET`. Missing selection
is CLI `USAGE` (the programmatic API uses `BATCH_TARGETS` for an empty list).

All common capture flags work with the previous meanings: block/tag or block
hash or depth, timeout, strict-checksum, genesis, implementation-code or live
resolve-beacon. Existing conflicts remain. The batch validates the entire config
once, including unused entries, and **all selected** original addresses/checksums,
chain IDs and capture inputs before reading any environment value or creating
the output directory. An invalid second selection prevents the first capture.

In default independent mode, after validation, create the new output directory
exclusively and nonrecursively inside an existing parent. Only then resolve each selected `rpcEnv` at that
target's turn, once per target; shared references are read again for each selected
entry. Unused references are never read. A missing, empty, non-string, invalid
or throwing selected value produces that ordinal's `CONFIG_ENV` outcome with
zero RPC for it; subsequent targets continue. No fallback applies.

With default concurrency 1, each independent target runs **sequentially** through the
existing capture engine and writer, finishing its publication or error before the next target starts. It resolves
its own block selector and executes every hash-pinned read and final canonical,
chain and optional genesis check. Even targets sharing a chain ID, genesis or
endpoint can select different latest/depth blocks as the head advances. A numeric
or hash selector is checked independently on every selected network. There is
no shared block, simultaneous observation, connection/batch-call pooling,
concurrency, retry, history or watch loop.

For this default mode, all old per-target limits and deadlines apply. Total
requests are at most the sum of individual budgets: at most `13*N` requests for N targets, and sum of
request deadlines at most `N*(12*T + min(T,5000 ms))` with all optional reads.
Ordinary default capture uses `8*N` requests. Failures can stop a target earlier;
no failed request is retried. Local config/file work is outside the RPC budget;
there is no overall batch wall-clock timeout beyond the sum of request deadlines.
At default concurrency 1, only one snapshot/code pair is processed at a time. At most 32 ordinary bounded
snapshot files are published (up to 24 MiB at the v2/v4 file cap), plus the current
writer's temporary file; the in-memory outcome list is bounded at 32 entries.

### Directory, filenames and partial results

The new directory uses mode `0700` on POSIX, subject to the process umask. Existing
files, directories, leaf symlinks (including dangling ones), aliases and concurrent
creation losers give `BATCH_EXISTS`; missing/unwritable/non-directory parents
or other creation failures give `BATCH_DIRECTORY`. These global failures occur
before env access/RPC and produce exit 1 with empty stdout and fixed safe stderr.
Parent directories are not created recursively or chmodded. Use a local parent
you control; symlinks in parent components follow normal filesystem resolution.

Target ordinal 1 maps to `target-01.json`, through `target-32.json`, based solely
on the requested order, never on a config name/path/URL. Failed ordinals leave
gaps; later files are not renumbered. Each successful snapshot remains strict
v1/v2/v4 and is saved by the unchanged validated private (`0600`) atomic
no-overwrite writer only after that target's checks succeed. No set manifest,
config copy or new snapshot wrapper is written. Inspect/diff/migrate read the
individual files exactly as before. Live beacon results stay out of the files.

A target's env, RPC/recheck or save error is a **per-target failure**. Continue
with later targets and retain earlier successful files. Existing file/link
collisions introduced inside the directory are never overwritten; failed normal
writes remove their temporary files. The batch directory is retained even if
all targets fail. A retry requires an explicitly new directory; there is no
resume, merging or cleanup of earlier results.

The set is **not an atomic transaction**. Interruptions/crashes can leave a
partial directory and no final report; a crash may leave a writer temporary
file. The CLI has no batch cancellation/rollback protocol. Directory durability
across power loss and protection from hostile concurrent replacement of parent
or output directory paths are not guaranteed. Normal per-file atomicity and
no-overwrite guarantees do not make the whole set atomic.

### Batch report v1 and exit policy

Without `--shared-block`, after all target attempts, stdout receives one
two-space-indented JSON object and a newline. Stderr is empty for per-target outcomes, including all-failure.
This is a **report**, not a snapshot format. Consumers must check `kind` and
`schemaVersion`. The exact root fields are:

| Field | Meaning |
| --- | --- |
| `kind` | Literal `contract-watch-batch` |
| `schemaVersion` | JSON number `1`, independently versioned |
| `selected`, `saved`, `failed` | Integer counts; selected = saved + failed |
| `outcomes` | One entry per selection, in CLI order, including failures |

Every outcome has `ordinal` (1-based), `address` (normalized public target),
`chainId` (exact canonical decimal expected ID) and `status` (`saved` or `failed`).
These identity fields come from validated configuration; a failure does not
claim they were observed at the provider.

- `saved` adds `file` (the fixed ordinal basename), `snapshotVersion` (1/2/4),
  and `block: {number, hash}` from that snapshot. It is emitted only after the
  writer successfully publishes the file. With `--resolve-beacon`, it also has
  the transient `beaconResolution` object from the existing live operation:
  resolved (`status`, `beacon`, `raw`, `implementation`) or skipped (`status`,
  `reason`). This observation is not replayable from a v1 snapshot.
- `failed` adds only `error: {code, message}` from the existing safe fixed error
  catalog. It has no `file`, `block`, `snapshotVersion` or partial live result.
  Unexpected exceptions become `INTERNAL`; provider messages/stacks are discarded.

No timestamps, config names/paths, environment names/values, endpoints, headers,
raw exceptions or raw bytecode are printed. The ordinal basename is the only
file reference. Output ordering and shape are deterministic for given outcomes;
real block observations can differ between runs. No success preamble or partial
per-target report is printed while the run is underway.

Exit **0 only if every selected target was saved**; exit **1 if any failed**.
This is independent of diff's opt-in exit 2; batch never uses 2. Global argument,
config, selection, input or directory failures have no batch report, empty stdout
and fixed safe stderr with exit 1. Scripts must distinguish a per-target failure
report on stdout from a global failure before parsing.

[The independent mixed-outcome fixture](../test/fixtures/batch/mixed.json) pins
the JSON contract. Fake-RPC tests cover minimum/maximum selections, independent
chains and advancing heads, sequential request order/budgets, all success,
partial/all failure, all capture modes, env ordering, private files, directory
races, symlink/write failures and cleanup. Existing single capture and offline
command suites remain the compatibility checks. No external RPC is used.

## Shared-block mode

`--shared-block` is an explicit, valueless, once-only option on `snapshot-many`.
It is not a config field or a new snapshot format. Duplicates, values,
`--shared-block=true`, and use on single snapshot or offline commands are
`USAGE` errors before env/output/RPC. Omitting it preserves independent batch
selection, traces and JSON v1 exactly. All existing flag conflicts and bounds
still apply. Default concurrency 1 remains sequential in original CLI order;
[larger limits](#bounded-concurrency) run ready targets concurrently.

### Grouping, resolution and failure phases

After validating the complete config and every selected capture input, group
selected targets by **normalized expected chain ID** using exact `BigInt`
arithmetic and canonical decimal strings, never `Number`. Decimal/hex aliases
are equal. The first selected member of each group is its fixed leader; groups
are reported in first-selection order, even when members are interleaved.
Address, config name, endpoint and genesis do not change group membership.
There are at most 32 groups, each containing at least one selected target.

Create the exclusive private output directory before any env/RPC access. At a
leader's turn, read its selected endpoint once. Resolve its anchor by checking
observed chain ID, reading initial genesis if requested, and resolving the
original tag/number/hash/depth through the existing selector logic. Hash mode
includes its existing initial canonical lookup; positive depth computes the
height once. Selecting block 0 with genesis requires agreement. No target state
is read during resolution. Only the normalized chain ID, number/hash and optional
observed genesis survive as the anchor; endpoints/clients are not cached.

The anchor is fixed immediately after that resolution succeeds, **before the
leader's capture**. The leader reuses the endpoint already read, while a fresh
capture performs the full shared sequence described in [PROTOCOL.md](PROTOCOL.md#shared-block-protocol).
Every later member reads only its own endpoint at its turn and uses the same
anchor. It never resolves latest/safe/finalized/depth again. Repeated by-hash and
by-number lookups verify the fixed anchor; they cannot select a replacement.
Shared environment references are still read once per attempted target.

If the leader's env or resolution fails, its outcome and group retain the
original fixed safe error. The group has status `unavailable` and no partial
block/genesis fields. Later members of that group get `SHARED_BLOCK_UNAVAILABLE`
with **zero env reads and zero RPC**. They do not become substitute leaders.
Other groups continue in original order. If all groups are unavailable, the
new empty directory remains and the final report has exit 1.

After successful resolution, a member's env, RPC, anchor verification, genesis,
state, final check or save failure is local to that member. The anchor stays
`resolved`, even if the leader fails or no member saves a file. The next member
uses the original anchor; it may independently pass or fail its own checks.
Earlier successful files remain. No retries, anchor replacement, fallback,
CLI cancellation protocol, resume or set rollback are added. Concurrency is
separately opt-in through `--concurrency`.

### Batch report v2

Only this opt-in changes the closed JSON report contract. Root fields, in output
order, are `kind`, `schemaVersion`, `mode`, `groups`, `selected`, `saved`, `failed`,
`outcomes`. Kind remains `contract-watch-batch`; version is **2** and mode is
literal **`shared-block`**. Counts and outcome fields are exactly as in v1.
Outcomes refer to their group by the existing normalized `chainId`; ordinal
filenames still reflect CLI order, with gaps for failures. Successful file/block
metadata is printed only after publication. Live beacon results remain confined
to successful outcomes; files remain strict v1/v2/v4 with no new fields.

`groups` has one entry per expected-chain group, in first-selection order:

| Fields | Contract |
| --- | --- |
| `chainId`, `leaderOrdinal`, `status` | Canonical decimal expected ID, first member's 1-based ordinal, `resolved` or `unavailable` |
| Resolved: `block` | Exact `{number, hash}` selected by the leader |
| Resolved with `--genesis`: `genesis` | `{status: "observed", hash}` from initial leader resolution |
| Unavailable: `error` | Only `{code, message}` from the fixed safe error catalog |

An unavailable group omits block/genesis; a resolved group omits error. No pending
state is emitted. A resolved anchor does not claim a saved leader, successful
members, finality or whole-set canonicality. No endpoints, config names/paths,
env references/values, raw exceptions, raw bytecode or timestamps enter the
report. No progress/partial report is emitted. The independent
[v2 mixed-outcome fixture](../test/fixtures/batch/shared-mixed.json) pins the format.

Exit policy is unchanged: 0 only when all selected files are saved, otherwise
1, never 2. Global validation/directory failures have empty stdout and safe
stderr; completed per-target attempts have the single JSON report and empty
stderr. Interruption can leave files without a final report. Private output,
no-overwrite publication, cleanup and trusted-parent limits are unchanged.

### Request and deadline budgets

Let N be selected targets, G distinct normalized expected-chain groups, g = 1
with genesis (otherwise 0), and s = 1 for hash or positive-depth selection
(otherwise 0). All targets use the same CLI selector/features/timeout T. Let C
be the number of eligible implementation-code reads and B eligible beacon calls:
each is at most N. Direct implementation adds C=1 per eligible target; beacon
implementation adds C=1 and B=1; live resolution adds B=1 only; skips add neither.

For successful resolution/capture, exact counts are:

- Per group resolution: `2 + g + s` ordinary requests.
- Per target capture (including leader): `9 + 2*g` ordinary requests, plus its
  eligible code read and/or beacon call.
- Total: `G*(2+g+s) + N*(9+2*g) + C + B` requests.
- Sum of request deadlines: `[G*(2+g+s) + N*(9+2*g) + C]*T + B*min(T,5000 ms)`.

The maximum is `4*G + 13*N` requests and `(4*G + 12*N)*T + N*min(T,5000 ms)`
with genesis, hash/positive depth and beacon implementation. No optional reads:
`2*G + 9*N` for tag/number/depth 0, `3*G + 9*N` for hash/positive depth. One
ordinary shared target therefore makes 11 requests, versus 8 in default mode.
Genesis adds `G + 2*N`, including when the chosen anchor is block 0.

On failure, count only each attempted phase's prefix through the failing request,
never a retry: bad env uses 0, initial chain failure 1, depth underflow `2+g`,
initial genesis mismatch against a resolved group 2. Unavailable-group followers
use 0. Later env failures use 0; save failures follow a full valid capture but
add no RPC. These counts never exceed the corresponding successful-phase bound;
C/B count only eligible requests reached. Unattempted phases add no deadlines.
All ordinary limits (1 MiB response, 16 KiB headers, T), beacon limits (4 KiB,
100000 gas, min(T,5000)), code/file bounds and disk caps remain. There is no extra
batch wall-clock timeout; local file/config work lies outside the RPC budget.

Matching chain IDs are not a network identity proof. Even matching genesis and
anchor hashes remain provider observations, not proof of ancestry, uniqueness,
honesty, simultaneous observations or absence of future reorgs. A reorg or
provider disagreement between members can leave an earlier valid file beside
a later failure; no final all-provider/set-wide recheck or atomicity is claimed.

## Bounded concurrency

`snapshot-many --concurrency N` accepts exactly one ASCII digit **1–8**. The
flag takes one value, at most once, and has no config/schema counterpart. Default
and explicit 1 execute sequentially with the same request traces and v1/v2 JSON
bytes for the same observations. Single `snapshot`, inspect/diff/migrate reject
it. Missing/empty values, duplicates, equals syntax and wrong commands give
`USAGE`; a supplied invalid number gives `CONCURRENCY`. Whitespace, leading
zeros, signs, hexadecimal, decimal points/exponents, Unicode digits, 0 and 9+
are rejected. Validation precedes config/env/RPC/output; all existing options
and every selected target are still validated before creating the directory.

### Admission and dependencies

The limit covers **whole target jobs**, from selected env lookup through anchor
resolution (leader only), sequential capture/rechecks and publication or failure.
At most N such jobs are active; every job awaits each RPC before starting another.
Consequently there are at most N active client RPC requests across the entire
batch, including short beacon calls and requests from different or shared URLs.
There is no separate per-endpoint allowance, extra resolver pool or hidden RPC
fan-out. Idle file work may leave fewer than N network requests active.

The ready queue is bounded by the existing 32-selection cap. When capacity is
available it scans in input order and starts the earliest ready target. An
independent target or a group's fixed first member is ready immediately. A
shared follower waits in the queue until its own leader's resolution completes;
it occupies **no worker or unresolved follower promise** and does not read env.
Other groups can use free workers, even when earlier followers are waiting.
Resolution success wakes followers immediately, without waiting for the leader's
capture/save to finish. They use only the immutable original anchor. Resolution
failure wakes them to their existing `SHARED_BLOCK_UNAVAILABLE` outcomes, with
zero env/RPC, and never makes another member leader.

Each actually attempted target reads its selected endpoint once, at admission.
The leader reuses that same value for resolution plus capture; shared references
are read separately per admitted target, not cached. Unselected definitions'
env values are never read. A member's env/capture/save failure after resolution
is local to that member and does not cancel the group, replace the anchor or
undo another file. The finite queue is rescanned on resolution and completion;
there are no polling timers or waits that can occupy every worker while their
leader remains queued.

### Reports, files and stopping

No new report version/fields are needed: concurrency changes scheduling only.
Independent output remains closed batch v1; shared output remains closed v2.
Counts/outcomes, group order and ordinal basenames follow original selections,
regardless of admission/completion order. Success is recorded only after the
same private atomic no-overwrite writer finishes. Final stdout waits for every
started capture/write and every queued outcome; no partial progress JSON is
printed. Exit 0/1 semantics, fixed error catalog and redaction are unchanged.
The independent v1/v2 fixtures remain byte-compatible. Real timestamps and
observations need not match a sequential run, particularly independent latest.

On request timeout or HTTP/body/connection error, destroy the failed request
and wait for its close before settling that RPC; no subsequent request or
replacement target starts using that job's capacity before transport cleanup.
A body abort/error remains a safe failure, not a retry. Ordinary target errors
continue scheduling remaining ready work. Internal scheduler/work exceptions
stop new dispatch and drain already-started work before a safe `INTERNAL` error;
there is no final batch report in that exceptional path, and saved files remain.
No pending follower promises or per-queue timers need cancellation.

This is **not** a CLI signal/cancellation protocol. SIGINT/SIGTERM, crashes and
power loss can leave partial files (including temporary files), without a final
report or a promise to drain. No rollback, resume, target restart, retries or
rate-limit handling is added. The trusted-parent, exclusive-directory and
per-file no-overwrite guarantees stay unchanged. A concurrent set is not atomic,
not necessarily observed at one instant, and not guaranteed jointly canonical.

### Resource and time bounds

All per-target and group request counts/deadlines above are unchanged. For M
selected targets, G groups, genesis g and selector cost s, independent total is
`M*(8+s+2*g)+C+B`; shared total is `G*(2+g+s)+M*(9+2*g)+C+B`. Here C counts eligible
implementation code requests and B eligible beacon calls. Their deadline sums
replace every ordinary request by T and every beacon call by min(T,5000 ms), as
before. Failures consume only attempted prefixes; blocked followers add zero.
Concurrency adds no requests and does not multiply any allowance by N.

A request timer starts when that request is constructed, not while its target
waits for a worker or anchor. Each timer still covers connection, headers and
body and is cleared at completion/failure; transport close follows cleanup.
The unchanged sum of RPC deadlines is a conservative bound on RPC work, not
sum/N wall time. Admission dependencies, filesystem work, event-loop scheduling
and transport cleanup prevent an exact N-fold bound; no overall wall timeout
is introduced. At most N requests' response bodies, target/implementation pairs and
writer temporary files are active (N ≤ 8). Published files remain capped at 32
and 24 MiB total; temporary files add at most N times the 768 KiB cap. Each code
blob, response and file retains its existing individual cap.
