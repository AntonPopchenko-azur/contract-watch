# Snapshot migration and compatibility

`contract-watch migrate SOURCE.json --to-version 3 --out NEW.json` is an explicit
offline conversion. Only v1 → v3 and v2 → v3 are supported. The source, target
version and new output path are required; there is no automatic conversion in
inspect/diff, version alias, downgrade or lossy v1-to-v2 path. Flags may precede
or follow the single source. Duplicate, valued-as-equals, missing or unknown
options are `USAGE`; capture/diff flags are not accepted. Prefix a source name
beginning with `-` with `./`.

## Data preservation

Snapshot v3 keeps the v2 field set and adds exactly
`migration: {"fromVersion": 1}` or `migration: {"fromVersion": 2}`. Common fields
retain their exact values: target `code`, all raw `slots`, `chainId`, `address`,
`block`, `source`, and `capturedAt`. Large integers remain strings. The new file
uses pretty-printed JSON; the original file's layout is untouched. Migration
adds no timestamp and never substitutes migration time for capture time.

For v1 input, the only implementation field is
`implementation: {"status":"not-recorded"}`. This applies even when raw slots
contain a direct address, a beacon, ambiguous or noncanonical words, or target
code is empty. V1 did not record implementation observations. Its absence cannot
be converted into empty implementation code, a failed read, an observed address
or a v2 skip. A past live-only beacon report supplies no saved code observation.
Migration never reads RPC environment variables or calls a provider to fill gaps.

For v2 input, the entire implementation object is copied without semantic
changes: direct/beacon provenance, address, code, raw return, no-code and skip
states. V3 binds the missing marker to `fromVersion: 1`; `fromVersion: 2`
requires a valid v2 implementation observation, with all existing eligibility
and raw-slot/ABI consistency checks. V1/v2 validators remain strict, and neither
accepts v3 fields or its missing marker. Migration metadata is a file assertion,
not independent authentication of its history or provider.

## Original as backup; atomic output

The **source itself is the retained backup**. Migration opens it read-only and
does not rename, truncate, reformat, chmod or replace it. Original bytes, mtime
and permissions are unchanged; access time may change through normal reading.
No secondary backup is needed because there is no in-place update.

The output must use a new path in an existing directory. Equal normalized paths
are rejected as `MIGRATION_PATH` before reading. Other aliases (symlinked parents,
symlinks or hardlinks) are protected by the writer's atomic no-overwrite publish:
any existing destination produces `FILE_EXISTS`. This also rejects directories,
FIFOs and dangling symlinks without following or modifying them. A source symlink
to a regular file is accepted; its target remains unchanged. Source directories,
FIFOs, missing paths, broken links and unreadable files give `FILE_READ`.

Output is serialized and bounded before opening a same-directory private
temporary file (`0600` on POSIX), written, synced and closed, then published with
an atomic hard link. Concurrent writers have exactly one winner; losers fail
without replacing the complete winner or changing the source. Normal failure
cleans up temporary files. A process crash can leave a dot-prefixed temporary
file; directory durability across power loss and hostile concurrent replacement
of source/parent paths are not guaranteed. Use a local directory you control.
The tool neither locks nor independently authenticates externally edited files.

Input limits remain 512 KiB for v1 and 768 KiB for v2/v3, including whitespace
and actual bytes read. Code remains capped at 128 KiB per target/implementation
blob. V3 output is capped at 768 KiB; both maximum code blobs plus metadata fit.
Oversize/invalid input or write failure produces no new successful output or
partial stdout. On success, stdout is the fixed line
`Snapshot migrated to version 3. Original preserved as backup.` and stderr is
empty (exit 0). Errors are fixed safe stderr only (exit 1), without paths,
input values, RPC/provider text or stack traces.

## Negotiation and repeat behavior

| Condition | Result |
| --- | --- |
| Valid v1/v2, target exactly `3`, unused path | New validated v3, original retained |
| Target `1`, `2`, unknown version, `03`, `3.0`, `latest` | `MIGRATION_VERSION` before file I/O |
| Valid v3 input, target `3` | `MIGRATION_CURRENT`; no output or rewrite |
| Same normalized input/output path | `MIGRATION_PATH`; no in-place operation |
| Repeat old source and existing output | `FILE_EXISTS`; no overwrite |
| Repeat old source with another explicit new name | Deterministic identical migrated data |
| Malformed/unknown source format or fields | `SNAPSHOT` (or `FILE_READ` for size/read failures) |

Parsing and target validation precede path validation, source read/validation,
the already-current check, and writing. No permissions or credentials are changed.
Programmatic `migrateSnapshot(snapshot, '3')` returns an independent validated
object; `migrateFile({input, output, toVersion: '3'})` uses the same conversion
and bounded atomic persistence. These functions do not query the environment.

## Reader and comparison compatibility

| Operation | v1 | v2 | v3 |
| --- | --- | --- | --- |
| Default capture / live-only beacon | Writes v1 | — | — |
| Capture `--implementation-code` | — | Writes v2 | — |
| Current inspect | Supported | Supported | Supported, including not-recorded |
| Current diff with matching inputs | JSON diff v1 | JSON diff v2 | JSON diff v3 |
| Current migrate to 3 | Supported | Supported | Explicit already-current error |
| Older v1/v2 readers | Supported per reader version | Supported by v2 readers | Reject unsupported version |

All **mixed snapshot-version pairs** still fail with `DIFF_VERSION`, including
v1/v3 and v2/v3. Explicitly migrating both inputs to v3 lets a recorded v2
observation coexist with a missing v1 observation without inventing data. V3/v3
diff uses `schemaVersion: 3`; consumers must check `kind` and version. Its shape
matches JSON diff v2 except for the additional `not-recorded` endpoint state.
Available observations retain the v2 comparability rules; any missing/skipped
endpoint yields `comparison: "unavailable"` and no implementation change entries.
`changed` still counts target/slot changes and comparable implementation address/
code changes only. Two missing records do not mean unchanged implementation.
Absence of a record versus a recorded observation at one hash is not itself an
inconsistency; actual target differences and contradictions between recorded
observations still produce existing notices. Migration metadata is not chain
state and does not enter diff. See the [v3 contract](PROTOCOL.md#json-diff-contract-version-3).

V1/v2 snapshot semantics and successful inspect/diff output, notice codes and
exit policies remain unchanged. Only the fixed `SNAPSHOT`/`FILE_READ` diagnostic
text is expanded to name v3; their codes and safe-output policy remain. Earlier
[v1](../test/fixtures/json-diff/) and [v2](../test/fixtures/json-diff-v2/) golden
diff fixtures remain unchanged. [Migration fixtures](../test/fixtures/migration/)
are synthetic, generated on 2026-10-05, with v1 raw-slot variants/large integers,
all v2 observation states and expected v3 files. Their timestamps record source
fixture generation and are retained in expected migration outputs.
