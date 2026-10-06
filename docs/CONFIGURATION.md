# Local target configuration

`snapshot --config FILE --target NAME --out NEW.json [capture options]` selects
exactly one named target from an explicit local file. Multiple definitions are
allowed; multiple captures, implicit first-target selection, discovery, includes,
`.env` loading and interpolation are not. No public provider is selected.
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

## CLI conflicts and validation order

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

All errors exit **1** with empty stdout and a fixed safe stderr message. No
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
