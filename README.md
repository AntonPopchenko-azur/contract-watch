# Contract Watch

A small, read-only Node.js CLI for taking EVM contract snapshots and comparing
code, EIP-1967 storage words, and optional saved implementation observations.

**Version 0.1.0 baseline.**
Source repository: [AntonPopchenko-azur/contract-watch](https://github.com/AntonPopchenko-azur/contract-watch).
There are no runtime or development dependencies. Node.js 22+ is required.
The package is deliberately `private` to prevent accidental npm publication.

## Try it offline

Run these commands from this project directory:

```sh
node --version
npm ci --ignore-scripts --offline --no-audit --no-fund
npm test
npm run demo
node bin/contract-watch.js --help
```

The demo compares [two synthetic snapshots](examples/before.json), with an
[updated implementation and admin](examples/after.json). It makes no network
requests and needs no keys. Its significant output is:

```text
Source: synthetic (demonstration only)
Blocks: 100 -> 101
implementation: 0x2222222222222222222222222222222222222222 -> 0x3333333333333333333333333333333333333333
admin: empty -> 0x4444444444444444444444444444444444444444
```

These addresses, block hashes and code are invented demonstration data, not
observations from Ethereum. `capturedAt` in the examples records their generation
time, not a claim that those blocks were observed then.

## Inspect a saved snapshot

Display one existing snapshot without connecting to a chain:

```sh
node bin/contract-watch.js inspect examples/before.json
```

`inspect FILE` accepts exactly one snapshot v1, v2, v3 or v4 file and no options. It uses the
same strict reader and text formatter as capture, displaying source, chain ID,
address, block number/hash, code size/fingerprint and the three EIP-1967 slots.
Synthetic inputs are marked `synthetic (demonstration only)`. Large chain IDs
and block numbers are displayed exactly. Empty slots appear as `empty`, nonzero
high address bytes as `noncanonical word`, and empty code is explicitly noted.

This describes the saved state; it does not refresh data, prove proxy behavior
or an upgrade, resolve beacons, or assess safety. `source: rpc` is a file label,
not an independent verification of its contents. The command ignores
`CONTRACT_WATCH_RPC_URL` and does not write or modify the input file.

Success exits **0**, with the report on stdout and empty stderr. Invalid JSON,
unsupported versions, unknown/missing fields, unreadable/non-regular files, and
files over their version's limit (512 KiB for v1, 768 KiB for v2/v3/v4) fail with exit
**1**, empty stdout and a fixed safe stderr message. No automatic migration or permissive
parsing is performed. Snapshot/diff options
such as `--rpc`, `--json` and `--exit-code` are rejected; for a filename starting
with `-`, use a path such as `./-snapshot.json`.

## Capture a snapshot

Supply the exact target address, expected chain ID, and your chosen HTTP(S) RPC.
No public endpoint is selected automatically. This example uses a local node and
an example address; replace both with your intended target:

```sh
mkdir -p snapshots
export CONTRACT_WATCH_RPC_URL='http://127.0.0.1:8545'
node bin/contract-watch.js snapshot \
  --address 0x1111111111111111111111111111111111111111 \
  --chain-id 1 \
  --block finalized \
  --out snapshots/first.json
```

Repeat later with a **new filename**, such as `snapshots/second.json`, then compare:

```sh
node bin/contract-watch.js diff snapshots/first.json snapshots/second.json
```

For scripts, add `--json` to get one versioned JSON document on stdout:

```sh
node bin/contract-watch.js diff --json examples/before.json examples/after.json
```

For two v1 snapshots the report uses `kind: "contract-watch-diff"` and
`schemaVersion: 1`, includes the target and both blocks, and provides `changed`, structured `changes`, and
machine-readable `notices`. Chain IDs and block numbers stay strings to preserve
large integers. It contains no input paths, RPC endpoint, capture timestamps, or
remote errors. The normal text report is unchanged when `--json` is omitted.
The flag may appear before, between, or after the two filenames; duplicate or
unknown flags are rejected. Prefix a filename starting with `--` with `./`.
Two v2 snapshots produce JSON diff v2 with separate implementation observations
and changes, as described [below](#compare-saved-implementation-observations).
Two v3 snapshots produce JSON diff v3, with explicit missing historical data.
Two v4 snapshots use JSON diff v4 and require matching recorded genesis hashes.
Mixed-version inputs fail with `DIFF_VERSION`; no historical data is inferred.

By default, changed and unchanged comparisons exit **0**, including a comparison
with a fork/inconsistency notice. On incomparable snapshots, invalid files, or
other errors, stdout is **empty**, stderr contains the existing safe text error,
and the exit status is **1**. No partial report or JSON error document is emitted;
check the exit status before parsing stdout. JSON diff is offline and ignores
`CONTRACT_WATCH_RPC_URL`. See the [JSON format contract](docs/PROTOCOL.md#json-diff-contract-version-1).

For automation, `diff --exit-code` distinguishes observed state changes from an
unchanged comparison. It works with text output and with `--json`; neither
report changes. The status is based only on `changed`: target code or raw slot
changes, plus comparable implementation address/code changes for v2/v3/v4 pairs.
Notices without state changes, such as different hashes at the same height,
do not produce status 2. Status 2 indicates a completed comparison, not an error
or proof of an upgrade.

| Diff result | Default | With `--exit-code` |
| --- | --- | --- |
| `changed: false`, with or without notices | `0` | `0` |
| `changed: true`, with or without notices | `0` | `2` |
| Argument, read, validation, ordering, or compatibility error | `1` | `1` |

`--exit-code` is a valueless flag accepted only by `diff`, at most once. Like
`--json`, it can appear before, between, or after the two filenames. Snapshot
options such as `--rpc` cannot be used with `diff`; `snapshot --exit-code`,
`--exit-code=2`, and repeated flags are usage errors. Snapshot exit codes remain
0 for success and 1 for errors.

This v1 shell example captures the status immediately in an `if`/`else`, so it works
under `set -e`. The complete report goes to `diff.json`; parse it only after a
status of 0 or 2. Avoid `if ! command; then diff_status=$?`, which captures the
negated status, and avoid a pipeline, whose status may belong to another command.

```sh
set -e
if node bin/contract-watch.js diff --json --exit-code \
  snapshots/first.json snapshots/second.json > diff.json; then
  diff_status=0
else
  diff_status=$?
fi

case "$diff_status" in
  0) printf '%s\n' 'No code or slot changes; report saved to diff.json.' >&2 ;;
  2) printf '%s\n' 'Code or slot changes detected; inspect diff.json.' >&2 ;;
  1) printf '%s\n' 'Comparison failed; do not parse diff.json.' >&2; exit 1 ;;
  *) exit "$diff_status" ;;
esac
```

Without config, `--rpc URL` overrides `CONTRACT_WATCH_RPC_URL`. Prefer the environment variable for
key-bearing URLs so the URL is not in CLI arguments; environment variables still
need to be handled carefully by your shell and process supervisor. The program
does not load `.env` files. HTTP is useful for local nodes; use HTTPS for remote
providers. URL path/query authentication is supported, embedded `user:password`
credentials and fragments are rejected. The CLI never prints or stores the URL.

| Option | Meaning |
| --- | --- |
| `--address ADDRESS` | Required without config: `0x` plus 40 hex digits; normalized to lowercase |
| `--chain-id ID` | Required without config: positive decimal or hex integer, up to 256 bits; checked against RPC |
| `--out FILE` | Required new snapshot path in an existing directory |
| `--config FILE` | Explicit bounded local JSON config; requires `--target`, forbids address/chain/rpc overrides |
| `--target NAME` | Select exactly one config definition; no implicit first target |
| `--rpc URL` | Explicit HTTP(S) RPC, or use `CONTRACT_WATCH_RPC_URL` |
| `--block BLOCK` | `latest` by default; `safe`, `finalized`, decimal or hex block number also accepted |
| `--block-hash HASH` | Exact `0x` plus 64 hex digits; canonical block only |
| `--depth N` | Blocks behind the initial `latest` height; canonical decimal `0..2^256-1`, at most 78 digits |
| `--timeout-ms MS` | 100–60000 ms per whole request; default 10000 |
| `--strict-checksum` | Opt-in exact EIP-55 casing for the target address; no value |
| `--resolve-beacon` | Opt-in bounded beacon `implementation()` read; result in live text report only |
| `--implementation-code` | Opt-in snapshot v2 with separately saved implementation code and address provenance; includes eligible beacon resolution |

To select a particular block by hash, replace `--block finalized` in the capture
example with `--block-hash HASH`, using the intended block's full hash. The
`0x` prefix must be lowercase; hex letters may use any case and are normalized
to lowercase. Validation happens before RPC or file creation. The option takes
one value and may appear anywhere among snapshot options, at most once.
Combining it with `--depth` or any explicit `--block`, including `--block latest`,
is a usage error. `--block-hash=HASH`, missing values and duplicates are also usage errors;
invalid hash syntax gives `BLOCK_HASH`. Errors exit 1 with empty stdout and fixed
safe stderr messages. The option is not accepted by `inspect` or `diff`.

Hash lookup requests block metadata without full transaction objects and verifies
that the returned hash matches the requested one. Before reading contract state,
the CLI checks that the block at the returned number has that same hash. Missing
blocks, malformed/mismatched metadata and noncanonical hashes abort capture.
Code/storage reads still require EIP-1898 with `requireCanonical: true`, followed
by the existing canonical-block and chain rechecks. There is no fallback to
another block if the hash, canonical state or historical data is unavailable.
An explicit hash does not establish finality or independently verify RPC data.

Without a block selector, capture still uses `latest`. `--block` retains its tag
and integer semantics: even a 64-digit hexadecimal value is a **block number**,
never inferred to be a hash. Hash selection works with `--strict-checksum`,
`--rpc`/the RPC environment variable and the request timeout. Snapshot v1 and
JSON diff v1 remain unchanged: the saved block has lowercase `number` and `hash`,
with no extra selection fields. See the [block selection contract](docs/PROTOCOL.md#block-selection).

Use `--depth N` instead of `--block`/`--block-hash` to choose a height relative
to the first mined `latest` header observed after the expected-chain check.
The target is **initial latest height minus N**, using exact `BigInt` arithmetic.
For a head at height 100, depth 0 selects 100, depth 1 selects 99, and depth 100
selects genesis (0). Depth is a block distance, not an inclusive count of
confirmations. The target is fixed even if the head advances during capture.

`N` must be `0` or decimal digits beginning with `1`–`9`, with no sign, whitespace,
leading zeros, exponent, fraction or hex prefix. Its maximum is `2^256-1` and its
length is at most 78 digits. Invalid values give `DEPTH`. Repeated/missing values,
`--depth=1`, and any combination with an explicit `--block` or `--block-hash`
give `USAGE`, before RPC or file creation. These errors use the same safe stderr
and exit-1 policy. The option is accepted by `snapshot` and `snapshot-many`.

If the depth exceeds the observed head height, capture fails with
`DEPTH_UNDERFLOW`; it does not clamp to genesis or wait for more blocks. Depth 0
reuses the first head's hash. Positive depth fetches the exact computed height
once. State reads then use that target hash with `requireCanonical: true`, and
the final block/chain checks still apply. No retry or replacement target is
selected after an error or reorg. Depth does not prove finality, block ancestry,
or honesty of the RPC. Old state can be pruned or require an archive provider.
Depth selection preserves snapshot/diff v1 and works with the existing RPC,
timeout and strict-checksum options.

By default, address validation checks length and hex syntax; any letter casing
is accepted. Add `--strict-checksum` to `snapshot` to require the exact
[EIP-55](https://eips.ethereum.org/EIPS/eip-55) casing before any RPC request or
file creation. For example, this official test address has canonical uppercase
letters (replace it with your intended target):

```sh
node bin/contract-watch.js snapshot --strict-checksum \
  --address 0x52908400098527886E0F7030069857D2E4169EE7 \
  --chain-id 1 --out snapshots/checksummed.json
```

This uses the explicit RPC environment variable from the capture example above.
The lowercase spelling of that address fails in strict mode. Canonical EIP-55
can also be entirely lowercase, such as
`0xde709f2102306220921060314715629080e2fb77`; single-case input is accepted only
when it exactly matches the checksum. The zero address remains valid.

The flag may appear anywhere among snapshot options, at most once and without a
value. `--strict-checksum=false`, a separate `true`/`false` value, duplicates and
use with `inspect` or `diff` are usage errors. A casing mismatch gives exit **1**,
empty stdout and the fixed `ADDRESS_CHECKSUM` stderr message; invalid hex syntax
still gives `ADDRESS`. No input address or endpoint is echoed in these errors.
RPC requests, saved snapshots and reports still use lowercase addresses; snapshot
v1 and JSON diff v1 are unchanged. Inspect/diff continue reading existing files
offline without applying a checksum to their stored lowercase addresses.

EIP-55 uses Ethereum **Keccak-256**, not NIST SHA3-256. A small local BigInt
implementation keeps this checksum-only feature dependency-free on Node.js 22+.
It is checked against all eight official EIP-55 cases and independent Keccak
reference results, including padding boundaries; see the
[checksum contract and reference provenance](docs/PROTOCOL.md#address-checksum).
The existing SHA-256 bytecode fingerprint is unchanged.

Chain IDs use exact integer arithmetic. Zero chain IDs, ENS
names, `pending`, duplicate flags, and unknown options are rejected. The zero
address is a valid target and will usually have no code.

Diff takes two files, with the earlier block first. Both must have the same
address, chain ID, and source kind. Without `--exit-code`, status is **0 for
success, including a diff with changes**. Errors use status **1** and stable
codes and fixed messages; URLs, paths, remote error text, and stacks are omitted.

## Select one local target

For repeated captures, keep public target definitions in an explicit local JSON
file and select exactly one name:

```sh
node bin/contract-watch.js snapshot --config examples/targets.json \
  --target demo-main --out snapshots/configured.json --block finalized
```

Set `CONTRACT_WATCH_DEMO_RPC` in your process environment to your chosen endpoint
first, and create the output directory. The [example config](examples/targets.json)
contains two invented definitions; only `demo-main` is captured. Its format is:

```json
{
  "schemaVersion": 1,
  "targets": [
    {
      "name": "demo-main",
      "address": "0x1111111111111111111111111111111111111111",
      "chainId": "1",
      "rpcEnv": "CONTRACT_WATCH_DEMO_RPC"
    }
  ]
}
```

Config and target flags are required together. They reject **all** address,
chain-ID and RPC CLI overrides. There is no implicit first target, config search,
`.env` loading, interpolation or fallback endpoint. In config mode only the
selected `rpcEnv` value is read; the default `CONTRACT_WATCH_RPC_URL` has no
special precedence. Missing/invalid selected values fail with `CONFIG_ENV` and
empty stdout; unused variables are not read. Never put URLs or tokens in this file.

The strict config allows 1–32 targets and at most 16 KiB of UTF-8 without BOM.
All entries, including unused ones, must have exactly `name`, `address`,
`chainId`, `rpcEnv`. Names are unique lowercase ASCII letters/digits/hyphens,
starting with a letter, at most 64 characters. Environment names use uppercase
ASCII letters/digits/underscores, starting with a letter or underscore, at most
64 characters. Chain IDs must be exact strings, not JSON numbers. Unknown fields,
duplicate JSON keys, malformed encoding and deep nesting are rejected.

The config and selected capture options are validated before the selected RPC
variable is read. `--strict-checksum` checks the selected address's **original
casing**. Block/hash/depth, genesis and implementation/live-beacon modes keep
all existing conflicts, read budgets and final checks. Config adds no requests
or snapshot fields, and successful reports match direct capture. The file is
read-only; bytes, mtime and permissions stay unchanged. Existing output files,
including the config itself, cannot be overwritten.

Offline commands reject these flags and never read config/env/network. Without
config, existing CLI behavior remains. See the [complete config contract](docs/CONFIGURATION.md)
for file/race limits, validation order, errors and examples.

## Capture an explicit batch

Use the same config to select 1–32 unique targets in a chosen order. Set only the
selected environment references to your intended RPC endpoints, then choose a
**new directory** in an existing parent:

```sh
node bin/contract-watch.js snapshot-many --config examples/targets.json \
  --target demo-secondary --target demo-main --out-dir snapshots/run-001
node bin/contract-watch.js inspect snapshots/run-001/target-01.json
```

This example contains no endpoint or secret and uses the existing invented
[definitions](examples/targets.json). `target-01.json` belongs to the first
selection, `target-02.json` to the second. No config names enter filenames,
snapshots or reports. Duplicate/unknown selections, invalid unused definitions,
invalid capture input and option conflicts stop the whole run before RPC or
output creation. Existing output directories/files/links are refused before RPC.

`--target` alone is repeatable. `--config` and `--out-dir` are mandatory;
address/chain/RPC overrides, `--out`, implicit all-target selection, `--json`
and `--exit-code` are rejected. Common block/hash/depth, timeout, checksum,
genesis and implementation/live-beacon options retain their existing meanings.
All selected inputs are validated before any selected RPC variable is read.
Unused variables are never read; each selected variable is resolved at its turn.
Missing/invalid env, RPC/recheck and file-write errors are per-target outcomes.

By default, targets run sequentially and independently. Each resolves its own
block and runs all existing state reads/rechecks; even two targets on the same chain can
capture different heads. No common block/time, concurrency or retries are implied.
Per-target request budgets are unchanged; the run's budget is their sum.

Without `--shared-block`, final stdout is a version 1 JSON **batch report** when
target attempts finish: `kind: "contract-watch-batch"`, `schemaVersion: 1`, selected/saved/failed
counts and ordered `outcomes`. Each outcome has ordinal, normalized address,
exact expected chain ID and status. Saved outcomes include the fixed filename,
snapshot version and block; failed outcomes contain a fixed safe code/message.
Live beacon observations appear only in successful report entries, never files.
No path, config name, environment reference, RPC URL or raw provider error is
included. See the [exact report contract](docs/CONFIGURATION.md#batch-report-v1-and-exit-policy).

Exit **0** means all selected files were saved; **1** means a global failure or
at least one failed target. Per-target failures still produce the JSON report
with empty stderr; global failures produce empty stdout and safe stderr. Batch
never uses diff's exit 2. Check stdout and status before parsing.

The set is **not atomic**: successful files remain after later failures, failed
ordinals leave gaps, and later targets continue. Even an all-failure run keeps
its empty directory. Individual files retain private atomic no-overwrite writes;
a repeat needs another explicit new directory. A crash/interruption can leave
partial results without a final report. Each saved file remains ordinary
snapshot v1/v2/v4, usable with the existing offline inspect/diff/migrate commands.
The single `snapshot` command remains unchanged. See [batch guarantees and limits](docs/CONFIGURATION.md#sequential-one-shot-batch-capture).

## Share one block per chain in a batch

Add the valueless `--shared-block` flag only to `snapshot-many`:

```sh
node bin/contract-watch.js snapshot-many --config examples/targets.json \
  --target demo-secondary --target demo-main --out-dir snapshots/shared-001 \
  --shared-block --block finalized --genesis
```

Provide the selected RPC environment values and an existing parent as above.
Targets with equal normalized expected chain IDs form one group (`1` and `0x01`
are equal). The first explicitly selected member resolves the group's block at
its turn; later members use that exact number/hash, even if latest advances.
Different chains get separate anchors; selection order stays unchanged.

Every target, including the leader, checks its own RPC's chain ID, anchor lookup
by hash and canonical header by number before state reads, then keeps all final
block/chain checks. All state reads use the anchor hash with `requireCanonical`.
With `--genesis`, each target also checks genesis twice and must agree with the
leader's initial observed genesis. No known/public genesis is substituted.

Leader env/resolution failure marks its group unavailable. Later members get
`SHARED_BLOCK_UNAVAILABLE` without env/RPC access; other groups continue. After
an anchor is resolved, any target's env/capture/save failure leaves it unchanged.
There is no re-resolution, alternate source, fallback, retry or rollback.
Successful files remain ordinary snapshots and survive subsequent failures.

This flag emits **batch report v2** with `mode: "shared-block"` and ordered
`groups` describing resolved anchors or safe failure reasons. Default batch
retains v1 exactly. Outcome fields, private filenames and exit 0/1 semantics
are unchanged. A resolved group means an anchor was obtained, not that every
capture succeeded or that the entire set was canonical at one instant.

Without optional reads, tag/number/depth-0 shared capture uses `2*G + 9*N`
requests for G groups and N targets; hash/positive-depth selection uses
`3*G + 9*N`. Genesis adds `G + 2*N`, and implementation/live-beacon reads add
only their existing per-target costs. See the [shared-block contract](docs/CONFIGURATION.md#shared-block-mode)
for exact deadlines, failure prefixes, v2 fields and examples.

Chain ID, genesis and matching hashes are RPC observations. They do not prove
network uniqueness, ancestry, provider honesty, simultaneous observation or
permanent canonicality. A later reorg/provider mismatch fails that target while
retaining earlier files; the set remains non-atomic.

## Observe a beacon implementation

Add the valueless `--resolve-beacon` flag to a snapshot command to observe the
address returned by an eligible beacon's `implementation()` at the selected
block. It works with the existing block, hash, depth, checksum, timeout and RPC
options. Repeating the flag, adding a value or using it with `inspect`/`diff`
gives `USAGE` before RPC. Default capture never makes this call; the separate
`--implementation-code` mode below also uses it for eligible beacons.

**The result is live text only and is not saved in the snapshot.** Without
`--genesis`, the file remains strict snapshot v1, with the original raw storage words and no additional
fields. `inspect` and `diff` still work offline on old and new v1 files; they
cannot replay this observation or detect a changed implementation behind an
unchanged beacon. Without `--genesis`, this live-only option continues to produce v1; with
`--genesis` it produces v4, still without saving the live beacon response.

The CLI makes at most one call, after reading target code and all three slots.
It requires nonempty target code, canonical address padding in every slot, an
empty implementation slot and a nonzero beacon address. Otherwise it reports
`Beacon resolution skipped` with the reason and saves the ordinary snapshot.
Both implementation and beacon slots populated remain ambiguous evidence and
are not resolved. Noncanonical admin data also causes a conservative skip.

The fixed call uses the target as `from`, the observed beacon as `to`, zero
value, `implementation()` input `0x5c60da1b`, and 100000 gas. Its EIP-1898 selector
uses the same block hash and `requireCanonical: true` as all state reads.
Timeout is the smaller of `--timeout-ms` and 5000 ms; the entire response is
limited to 4 KiB. Gas is never estimated or increased. A contract needing more
gas/time fails; there is no retry or fallback.

Only one ABI-encoded, nonzero address is accepted: exactly 32 bytes of hex with
12 leading zero bytes, normalized to lowercase. Zero, empty, malformed,
noncanonical or trailing return data fails with `BEACON_RESULT`. Reverts and
unsupported selectors give `RPC_REMOTE`, timeouts `RPC_TIMEOUT`, and responses
over 4 KiB `BEACON_SIZE`. These failures and failed final block/chain rechecks
produce exit 1, empty stdout and no new snapshot. No partial live result is
printed; provider messages are discarded.

An accepted response is an observation, not proof of proxy behavior, a valid
implementation contract or safety. The call simulates execution without sending
a transaction. Caller independence is required by the beacon specification but
is not tested here. See the [beacon protocol contract](docs/PROTOCOL.md#beacon-resolution-live-only).

## Save implementation code

Add the valueless `--implementation-code` flag to capture a **snapshot v2**:

```sh
node bin/contract-watch.js snapshot --implementation-code \
  --address 0x1111111111111111111111111111111111111111 \
  --chain-id 1 --block finalized --out snapshots/with-implementation.json
node bin/contract-watch.js inspect snapshots/with-implementation.json
```

Use your explicit RPC environment variable as above. The flag works with all
block selectors, checksum and timeout options. It cannot be combined with
`--resolve-beacon`; duplicates, values and use with `inspect`/`diff` give `USAGE`
before RPC. Without `--genesis`, default capture and `--resolve-beacon` still save strict v1.
Combining `--implementation-code` with `--genesis` saves its observation in v4.

V2 keeps `code` as the **target's** bytecode and preserves all raw slots. Its
separate `implementation` object records an address, provenance and bytecode.
With canonical slots, a nonzero implementation slot and empty beacon select the
direct address. An empty implementation slot and nonzero beacon select the
strict address returned by the same bounded beacon call described above; v2
also saves that beacon address and raw ABI return word.

Selection is conservative: no target code, any noncanonical slot (including
admin), both target slots populated, or both target slots empty produce an
explicit `skipped` reason and no extra RPC. An eligible address gets exactly one
additional hash-pinned `eth_getCode` before the final block/chain checks.
Empty code is saved as `status: "no-code"`, `code: "0x"`; nonempty code is
`status: "observed"`. No recursive proxy traversal takes place, even for a
self-reference. Code presence does not establish proxy behavior or safety.

Offline `inspect` displays target and implementation code separately, including
provenance, skips and no-code observations. Diff accepts two files of the same
version (v1, v2, v3 or v4); mixed versions fail with `DIFF_VERSION`, exit 1 and empty
stdout in text/JSON modes. See the [v2 contract](docs/PROTOCOL.md#file-contract-v2)
and [migration contract](docs/MIGRATION.md) before changing a saved
history or a consumer. Old files need no conversion.

## Compare saved implementation observations

These offline examples compare two synthetic v2 snapshots with unchanged target
code and raw slots, including the same beacon, but different observed implementation
addresses and code. Both commands complete with **exit 2**:

```sh
node bin/contract-watch.js diff --exit-code \
  examples/beacon-before-v2.json examples/beacon-after-v2.json
node bin/contract-watch.js diff --json --exit-code \
  examples/beacon-before-v2.json examples/beacon-after-v2.json
```

The text shows no target code/slot changes, then the two implementation
observations and address/code differences. JSON uses `schemaVersion: 2`:
top-level `changes` still contains only target code/raw slots, while
`implementation.changes` contains comparable implementation `address` and `code`
differences. `changed` is true when **either** array is nonempty. Consumers must
check the output version and use `changed`, rather than only the top-level array.

Implementation addresses and bytes are compared only when both observations
are available (`observed` or `no-code`) and have the same provenance: both direct
slot, or both beacon with the same beacon address. A different selected address
can have different code; this compares the selected implementations, without
claiming that code at one account mutated. The same address with different code
is also reported. `no-code` is an actual empty-code observation and can be
compared with nonempty code. Equal addresses and code produce no implementation
change; capture timestamps do not affect this comparison.

If either side was skipped, `implementation.comparison` is `unavailable`; if
both are available but provenance differs, it is `provenance-changed`. Both
endpoints remain visible, including status, skip reason, source and available
code fingerprints. These cases yield no implementation change entries and do
not themselves set `changed`. Target code and raw slot differences still count
normally; valid availability/provenance transitions often require such changes.
Two identical skips mean there was no implementation comparison, not that the
unobserved implementation was unchanged. Missing data is never treated as empty
code, and a provenance change is not reported as an implementation upgrade.

No RPC requests occur, even when the RPC environment variable is configured.
Files remain unchanged. Fork and same-hash inconsistency notices also cover v2
observations; notices alone do not set `changed` or exit 2. A comparison describes
saved observations, not proof of an upgrade transaction, intermediate history,
provider honesty or safety. See the [JSON diff v2 contract](docs/PROTOCOL.md#json-diff-contract-version-2).

## Migrate a saved snapshot offline

Choose the source file, target version and a **new** output path explicitly:

```sh
node bin/contract-watch.js migrate examples/before.json \
  --to-version 3 --out snapshots/migrated-v3.json
node bin/contract-watch.js inspect snapshots/migrated-v3.json
node bin/contract-watch.js diff --json --exit-code \
  snapshots/migrated-v3.json snapshots/migrated-v3.json
```

Create the `snapshots` directory first. Migration supports **v1 → v3 and v2 → v3**
with target `3`, and **v1/v2/v3 → v4** with target `4`. It never reads RPC
configuration, makes a request or performs a new capture.
All existing target code, raw slots, chain/block values, source and `capturedAt`
are retained. V1 gains only `implementation: {"status":"not-recorded"}`; no
historical address, code or skip reason is inferred. V2 implementation observations
are preserved in full. V3 records `migration.fromVersion` as 1 or 2; no migration
timestamp replaces the capture time. Capture writes v1/v2 by default, or v4 with `--genesis`.

The original file is the backup: its bytes, modification time and permissions
remain unchanged. No separate backup file is created. Output is private and
published atomically through the existing no-overwrite writer. Existing files,
symlinks, hardlinks, in-place paths and concurrent losers are rejected; no partial
output is published on failure. Use an existing destination directory you control.

Migration exits 0 only after saving, with a fixed confirmation and empty stderr.
Errors exit 1 with empty stdout and safe stderr. Only exact targets `3` and `4`
are accepted; downgrades, v1-to-v2, aliases and unknown versions are rejected.
An input already at its target version gives `MIGRATION_CURRENT` without output. Repeating
an old source with the same destination gives `FILE_EXISTS`; explicitly choosing
another new destination produces the same deterministic migrated content.
Flags may surround the single source argument; duplicates, missing values and
capture/diff options are usage errors. Use `./` for a source name starting with `-`.

Inspect v3 identifies missing historical observations. Two v3 files use JSON
diff v3: any `not-recorded` endpoint makes implementation comparison `unavailable`,
never empty code or evidence of unchanged implementation. Target/slot changes
still count normally; available observations use the v2 comparison rules. A
missing record versus a recorded observation at the same hash is not itself
inconsistent block data. Mixed versions are still rejected; migrate both inputs
explicitly to v3 to compare their available data. Older v1/v2 readers reject v3.

Migration to v4 adds exactly `genesis: {"status":"not-recorded"}`. It cannot
recover genesis from chain ID, source label or selected block, even block 0.
V3→v4 retains the original `migration.fromVersion` (1 or 2); direct v1/v2→v4
and the path through v3 yield the same data. Implementation observations and
capture timestamps stay intact. Inspect works, but v4 diff refuses an unknown
genesis on either side with `GENESIS_UNAVAILABLE`, even for a file compared
with itself. Keep legacy files for comparisons under their legacy chain-ID-only
contract, or make new explicit genesis captures. No override or automatic RPC
backfill is provided. See [migration and backup guarantees](docs/MIGRATION.md).

## Record genesis identity

Add the valueless `--genesis` flag to save **snapshot v4** with the RPC's observed
block-0 hash alongside the exact chain ID:

```sh
node bin/contract-watch.js snapshot --genesis --implementation-code \
  --address 0x1111111111111111111111111111111111111111 \
  --chain-id 1 --block finalized --out snapshots/with-genesis.json
```

Use your chosen RPC as in the capture example. Nothing enables this option
implicitly, and no public hash is substituted. The flag does not accept an
expected hash or any value. Duplicates, `--genesis=true`, and use on offline
commands are `USAGE` errors before RPC. It composes with every block selector,
checksum/timeout option, and either implementation mode; the existing mutually
exclusive flags remain mutually exclusive.

After the initial chain check, `eth_getBlockByNumber` with `['0x0', false]`
reads a mined header whose number must be exactly zero and hash must be a nonzero
32-byte value. After state reads and the final selected-block check, it reads
block 0 again and requires the same hash, then rechecks the chain ID. This detects
observed switching between networks sharing a chain ID. Selecting block 0 also
requires its hash to match the initial genesis before reading state. Null headers,
malformed/zero hashes, errors or changed identity abort with empty stdout and no
new file. There are no retries; ordinary response limits and deadlines apply.

V4 saves `genesis: {"status":"observed","hash":"0x…"}`. Without
`--implementation-code`, its implementation field is exactly `{"status":"not-recorded"}`;
with that flag, the complete v2 observation or skip is retained. A live
`--resolve-beacon` result remains transient, even in v4.

V4 diff requires both recorded genesis hashes to match. Different hashes yield
`GENESIS_MISMATCH` (exit 1, empty stdout), never a contract change or fork notice.
Missing historical genesis yields `GENESIS_UNAVAILABLE`. Matching observations
permit the usual target/slot and implementation comparisons, with JSON diff v4
including the shared genesis object and the same exit 0/2 policy. Mixed snapshot
versions still fail; v1/v2/v3 comparisons retain their older identity limitations.

One RPC can lie, and forks can share both chain ID and genesis. These checks do
not prove selected-block ancestry, authenticity, finality, uniqueness or safety.
See the [v4 format and identity contract](docs/PROTOCOL.md#file-contract-v4).

## What a snapshot means

The CLI checks the chain, resolves the requested block, and passes the same
`{ blockHash, requireCanonical: true }` selector to every code/storage read.
It then rechecks that block's canonical hash and the chain ID. This requires
**EIP-1898 support**; there is no fallback to unpinned reads. Old state may require
an archive-capable provider. No snapshot is written after an RPC failure.

Snapshots retain full target bytecode, raw 32-byte words, block number/hash,
chain ID, normalized target address, source kind, and the local capture time.
Reports summarize code with a SHA-256 fingerprint (not Ethereum Keccak-256).
Existing files and symlinks are never overwritten. New snapshots are published
atomically on filesystems supporting same-directory hard links and use mode
`0600` on POSIX. Use a local directory you control.

Limits are 1 MiB per ordinary HTTP response, 16 KiB of HTTP headers, and 128 KiB
of decoded bytes **per** target/implementation code blob. Files are bounded at
512 KiB for v1 and 768 KiB for v2/v3/v4, including whitespace; v2/v3/v4 can hold both maximum
code blobs. Redirects and compressed responses are rejected.
For single capture and default independent batch members, before opt-in reads,
successful captures have these bounded sequential RPC budgets, where `T` is
`--timeout-ms` (10 seconds by default):

| Selection | Requests | Maximum sum of request timeouts |
| --- | --- | --- |
| Default / `--block` tag or number | 8 | `8 × T` |
| `--block-hash` | 9 | `9 × T` |
| `--depth 0` | 8 | `8 × T` |
| `--depth N` with `N > 0` | 9 | `9 × T` |

An eligible `--resolve-beacon` adds one request and at most `min(T, 5000 ms)`:
9 requests for tag/number or depth 0, 10 for hash or positive depth. Skips add
no requests. The beacon response limit is 4 KiB instead of the normal 1 MiB.

With `--implementation-code`, a direct address adds one request / `T`; a beacon
adds two requests / `T + min(T, 5000 ms)`; a skip adds none. Without genesis, the largest
successful capture (hash or positive depth plus beacon and code) makes 11
requests, with sum of request deadlines `10*T + min(T, 5000 ms)`. An oversize
or invalid implementation result aborts capture with no file or partial stdout.

`--genesis` adds exactly two ordinary requests / `2*T` in every successful
mode, including when the selected block is 0. Base totals become 10 or 11;
the maximum with beacon code is 13 requests / `12*T + min(T,5000 ms)`.
There are no retries or background loop. Depth underflow stops after the chain
check and initial head lookup (two requests, or three with genesis). Local file work is outside this
RPC timeout budget. Block lookups request transaction hashes only,
not full transaction objects; the same 1 MiB response limit applies to them.
The generic RPC allowlist contains only chain, block, code, and storage reads.
A dedicated operation permits only the fixed beacon call above. No arbitrary
calls, wallet, signing or transaction submission are exposed.

## Interpretation and limits

- A zero word means an empty slot and is displayed as `empty`.
- Nonzero high 12 bytes are preserved and labeled noncanonical instead of being
  silently truncated into an address.
- A populated implementation slot is evidence about storage, not proof of proxy
  behavior. Populated implementation and beacon slots together are ambiguous.
- With no code, the report says there is no code **at that block**. With empty
  target slots it says no EIP-1967 target was found, including ordinary contracts.
  Other proxy patterns may still exist; the tool does not identify every proxy.
- Beacon resolution and implementation code are opt-in observations. Saved v1
  comparisons cannot detect an implementation change behind an unchanged beacon;
  v2 compares available observations with the same provenance. Skips and changed
  provenance are reported explicitly without invented implementation changes.
- Snapshots compare endpoints in time, so intermediate upgrades can be missed.
  A changed slot does not by itself prove that an upgrade transaction occurred.
  Same-height fork comparisons and inconsistent same-hash data receive notices.
- This is not a security audit, a safety rating, or an independent proof of chain
  state. Results depend on the chosen RPC and the integrity of local files.
  Finality can change after capture, and chains may reuse chain IDs.

See [protocol and snapshot format](docs/PROTOCOL.md) for the field contract and
[roadmap](docs/ROADMAP.md) for deliberately deferred features.

## Development and publication

`npm test` runs Node's built-in test runner, temporary files, child CLI processes,
and loopback-only fake HTTP servers. It never contacts a real chain and does not
need credentials. Environments that block listening on `127.0.0.1` must grant
that local test capability. Do not substitute production RPC calls for tests.

The active [CI workflow](.github/workflows/ci.yml) checks Node.js 22 and 24 on
pushes to `main` and pull requests. It runs the offline install, `npm run check`,
and the synthetic demo with no RPC secrets and only read access to repository
contents. Actions are pinned to verified official release commits, and checkout
does not persist credentials. [CI results](https://github.com/AntonPopchenko-azur/contract-watch/actions/workflows/ci.yml)
show each run and its commit.

The initial source baseline is published. Version `v0.1.0` is an annotated Git
tag, created only after both CI jobs succeed for its target commit; its annotation
records the verification run. [Release notes](docs/RELEASE.md) document this
process and baseline limits. This package is not published to npm.

## Sources

Protocol decisions were checked against
[EIP-1967](https://eips.ethereum.org/EIPS/eip-1967),
[EIP-1898](https://eips.ethereum.org/EIPS/eip-1898), the official
[Ethereum JSON-RPC documentation](https://ethereum.org/en/developers/docs/apis/json-rpc/),
and the [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification).

MIT licensed; see [LICENSE](LICENSE).
