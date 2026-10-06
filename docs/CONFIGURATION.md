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
select **1–32 unique names**, in execution order; no implicit all/first target,
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

After validation, create the new output directory exclusively and nonrecursively
inside an existing parent. Only then resolve each selected `rpcEnv` at that
target's turn, once per target; shared references are read again for each selected
entry. Unused references are never read. A missing, empty, non-string, invalid
or throwing selected value produces that ordinal's `CONFIG_ENV` outcome with
zero RPC for it; subsequent targets continue. No fallback applies.

Each target runs **sequentially** through the existing capture engine and writer,
finishing its publication or error before the next target starts. It resolves
its own block selector and executes every hash-pinned read and final canonical,
chain and optional genesis check. Even targets sharing a chain ID, genesis or
endpoint can select different latest/depth blocks as the head advances. A numeric
or hash selector is checked independently on every selected network. There is
no shared block, simultaneous observation, connection/batch-call pooling,
concurrency, retry, history or watch loop.

All old per-target limits and deadlines apply. Total requests are at most the
sum of individual budgets: at most `13*N` requests for N targets, and sum of
request deadlines at most `N*(12*T + min(T,5000 ms))` with all optional reads.
Ordinary default capture uses `8*N` requests. Failures can stop a target earlier;
no failed request is retried. Local config/file work is outside the RPC budget;
there is no overall batch wall-clock timeout beyond the sum of request deadlines.
Only one snapshot/code pair is processed at a time. At most 32 ordinary bounded
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

After all target attempts, stdout receives one two-space-indented JSON object
and a newline. Stderr is empty for per-target outcomes, including all-failure.
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
