# Independent correlation fixtures

These are invented bytes for offline tests, not captured network evidence.
No production capture, decoder, importer or correlation function generated them.

- `range.json`: five linked synthetic headers, literal EIP-1967 ABI bytes and a
  manually assembled complete unsplit report. An implementation B/A sequence
  occurs in block 101 between equal A endpoints; admin and beacon events follow.
- `split-range.json`: the same evidence with an explicitly specified nine-node,
  left-first page tree, including successful empty leaves. IDs are allocation
  order; attempt ordinals describe depth-first processing.
- `observations.json`: five strict RPC-labeled v4 synthetic observations with
  recorded matching genesis and implementation observations explicitly not recorded.
- `expected.json`: hand-specified neighbor ordinal groups, endpoint changes and
  candidate value comparisons, independent of production report construction.

Literal signature topics and address words derive from the earlier independent
event fixture. The range fingerprint is independently computed SHA-256 of the
documented normalized block JSON using Python. RPC counters/flags are synthetic
claims; the fixture does not authenticate a provider or prove those calls happened.
Tests additionally construct adversarial variants, retention copies, bounded
maximum inputs and an actual loopback-generated v1 report for compatibility.
