# Snapshot compatibility and migration plan

Item 15 introduces opt-in snapshot v2, not an in-place change to v1. Default
capture and `--resolve-beacon` continue writing v1. `--implementation-code`
writes v2, including explicit skip/no-code states when applicable. Both formats
have strict required/unknown-field validation. Package version and JSON diff
schema version are independent of snapshot versions.
`SNAPSHOT` and `FILE_READ` keep their error codes and safe-output policy; their
fixed diagnostic text now names both supported versions and their size limits.

| Producer / consumer | Snapshot v1 | Snapshot v2 |
| --- | --- | --- |
| Existing v1 capture modes | Writes v1 | Never writes v2 |
| `--implementation-code` | Never silently substitutes v1 | Writes v2 |
| Current `inspect` | Supported, existing report | Supported, separate code/provenance |
| Current `diff`, text or JSON | Two v1 inputs supported | Any v2 input gives `DIFF_VERSION` |
| Earlier v1-only readers | Supported | Reject as unsupported |

Keep existing history as v1 and retain originals. No automatic conversion,
fallback parser, data removal or migration command is introduced here. Adding
v2 fields to v1, merely changing its version number, or removing implementation
observations for comparison is not a supported migration. The absence of saved
implementation code in v1 does not mean empty code, a failed read or a v2 skip.
Even a prior live beacon report cannot supply a missing historical code read.

To obtain a new v2 observation, explicitly recapture with
`--implementation-code`, the original chain/address and `--block-hash` using
the original hash, a chosen archive-capable endpoint and a **new filename**.
The block must still be canonical and available. The tool rechecks all state;
this is a new RPC observation with a fresh `capturedAt`, not a conversion of the
old file. Do not copy the old timestamp, invent missing results, merge data from
different blocks/providers or silently replace the old snapshot. If recapture
fails, retain v1; there is no fallback to latest or to an invented v2 observation.

Future item 16 must explicitly define implementation-aware comparisons,
including provenance, skips, no-code and mixed-version policy before accepting
v2 in diff. Item 17 must define an explicit offline migration operation with
backup/no-overwrite behavior, output version negotiation, fixtures and handling
of unavailable observations. V2 currently has no `unknown historical data`
state, so a universal offline v1-to-v2 conversion is not defined. That work may
need another format version rather than fabricating observations or weakening
v2 validation. Neither item is implemented or marked complete by item 15.

Compatibility specimens under [test/fixtures/implementation](../test/fixtures/implementation/)
are synthetic, created for these tests; their addresses, hashes and code are
invented and their timestamps record fixture generation. They include unchanged
[v1](../test/fixtures/implementation/v1.json),
[direct v2](../test/fixtures/implementation/direct-v2.json),
[beacon v2](../test/fixtures/implementation/beacon-v2.json),
[no-code v2](../test/fixtures/implementation/no-code-v2.json) and
[skipped v2](../test/fixtures/implementation/skipped-v2.json). Tests verify strict
read/inspect, invalid provenance, mixed/v2 diff rejection, independent code
limits, per-version file limits and private atomic no-overwrite persistence.
Existing v1 examples and golden diff output remain unchanged.
