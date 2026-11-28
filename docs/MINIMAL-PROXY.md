# Exact EIP-1167 runtime evidence

Added 2026-11-28 for roadmap item 35:

```sh
node bin/contract-watch.js minimal-proxy ./snapshot.json
```

The command accepts exactly one explicit strict snapshot v1–v4 file and no flags.
For a filename starting with `-`, use `./-snapshot.json`. It reads saved **target
code**, field `code`, and emits separate `contract-watch-minimal-proxy` JSON v1.
It does not alter snapshot schemas or the existing inspect/diff output.

## Supported form

The [EIP-1167 specification](https://eips.ethereum.org/EIPS/eip-1167#specification)
and its deployed-runtime disassembly were checked on 2026-11-28. The supported
shape is exactly 45 bytes:

```text
363d3d373d3d3d363d73 <20-byte target> 5af43d82803e903d91602b57fd5bf3
```

Require all ten prefix bytes, all fifteen suffix bytes and the exact total length.
The target occupies zero-based byte indices **10–29 inclusive**, without the hex
`0x` prefix. Preserve all twenty bytes, including leading zeros; no integer
conversion, substring search or partial-prefix recognition is used.

The EIP also describes a [vanity PUSHn optimization](https://eips.ethereum.org/EIPS/eip-1167#vanity-address-optimization):
shortening a leading-zero target changes the PUSH instruction, byte length and
jump destination. This command deliberately excludes that variant. It also
excludes PUSH0/other runtimes, creation/init code, appended data, suffixes,
truncation and changed fixed opcodes/jump bytes. The EIP does not prescribe
deployment bytecode; the fixture creation wrapper is only a negative example.
No broad heuristic detector or claim that these variants are invalid is added.

## Outcomes and target meaning

| status | Meaning | delegateTarget |
| --- | --- | --- |
| empty-code | The saved target code is exactly `0x` | null |
| matched | The entire saved code matches the supported 45-byte form | Exact extracted address and provenance |
| no-supported-match | Nonempty saved code does not match this one form | null |

All three outcomes exit **0** with one JSON report and empty stderr. A nonmatch
does **not** mean “not a proxy.” Empty code is a saved observation, not a claim
about the current account. Zero and self delegate targets are still exact byte
matches, with independent `zeroAddress` and `selfReference` booleans (both can
be true). Neither becomes a fabricated available implementation or safety result.
Every extracted target has availability=unverified and behavior=unverified.

Only `code` is analyzed. The separately recorded `implementation` object is
validated as part of the original snapshot schema but is **not** the proxy's
code and does not establish availability of the extracted target, even if an
address happens to match. Raw EIP-1967 slots are not used to select or override
the embedded target. No implementation resolution, target-code read, generic
call, execution, migration or recursive path traversal occurs.

## Report v1

- kind/schemaVersion identify this report, independently of snapshot versions.
- mode=offline and source retain `rpc` or `synthetic` explicitly.
- snapshot records the input schemaVersion, capturedAt, exact file SHA-256 and
  byte length, plus original migration provenance or null. No filename is emitted.
- address, decimal chainId and block number/hash retain the saved exact values;
  uint256 values stay strings. genesis preserves v4's observed/not-recorded state;
  v1–v3 receive only not-recorded, never an inferred hash, including at block 0.
- pattern names the exact supported runtime, its 45-byte length and target offsets.
- evidence identifies field=code, its decoded byte length and SHA-256 fingerprint.
  matchedRuntime contains the entire 45-byte hex code only for a match, else null.
- status and delegateTarget describe the outcome. A target includes address,
  zeroAddress, selfReference, field/byte-offset provenance, availability and behavior.
- implementationObservation=not-analyzed and traversal=not-performed describe scope.
- Fixed caveats keep unsupported forms and the limits of saved evidence visible.

SHA-256 binds local bytes; it is not an Ethereum code hash or authentication.
Byte agreement does not verify a target's existence, code or behavior, source
honesty, history, ancestry, current canonicality, finality, upgrade or safety.
Synthetic source labels remain synthetic; missing genesis remains unknown.

## Strict reads, limits and preservation

Reuse bounded regular-file reads, strict UTF-8/duplicate-key/depth checks and the
existing full snapshot validator. Input is at most **512 KiB for v1**, **768 KiB
for v2/v3/v4**, including whitespace. Target and separate implementation code
retain their **128 KiB each** limits. Unknown fields, malformed hex, incompatible
implementation/migration/genesis structures, BOM, malformed JSON/UTF-8, duplicate
decoded keys and nesting deeper than six fail. Object-key order and JSON whitespace
are immaterial; stored hex/quantity normalization remains the snapshot contract.

The reader never allocates from an untrusted file size. It reads at most the
global 768 KiB limit plus one detecting byte, then enforces the parsed version's
limit. Special files and final symlinks are refused; reads are nonblocking and
check inode/type/mode/size/mtime around the read and close before reporting.
Only one file is read. Output is capped at **8 KiB** before its single stdout write;
unmatched large code is represented by length/fingerprint, not copied into output.
These are application bounds, not hard heap or elapsed-time promises.

Input bytes, mtime and permissions remain unchanged. Ordinary reads may update
atime. Use a trusted local directory: these checks do not lock parent directories,
prevent changes after reading or guarantee an atomic view under hostile filesystem
races. Ordinary offline signal behavior and existing broken-pipe handling apply;
shell redirection can create an external partial file on interrupted delivery.

Errors exit **1**, with empty stdout and fixed safe MINIMAL_PROXY_INPUT,
MINIMAL_PROXY_REPORT or USAGE stderr. Paths, RPC URLs, arbitrary input text and
underlying stacks are not exposed. No RPC/env discovery, `.env` loading, filesystem
writes, automatic migration or background process occurs. All previous snapshot,
history/timeline/revalidation, events/range, watch/stability and correlation
contracts remain unchanged. Proxy-path traversal remains roadmap item 36.

See the [independent bytecode fixtures](../test/fixtures/minimal-proxy/README.md)
for standard, boundary-address and unsupported examples. Tests mutate every
fixed byte, exercise all target-byte positions, validate file/provenance limits
and forbid network/environment access.
