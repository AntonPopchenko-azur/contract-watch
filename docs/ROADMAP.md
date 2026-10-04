# Contract Watch roadmap

This is a finite plan of 45 useful increments, not a commit quota. Items 01–05
describe the single locally prepared 0.1.0 baseline on 2026-09-30; they do not
represent five commits or five published releases. Item 06 is confirmed by the
published baseline; item 07 activates pinned CI and makes both Node.js jobs the
release gate. The annotated `v0.1.0` tag records the successful verification run.
Item 08 adds the versioned offline JSON diff on 2026-09-30.
Item 09 adds an opt-in change exit status on 2026-10-01.
Item 10 adds offline inspection of saved snapshots on 2026-10-01.
Item 11 adds opt-in strict EIP-55 target validation on 2026-10-02.
Item 12 adds explicit canonical block-hash selection on 2026-10-02.
Item 13 adds capture at a fixed depth behind the initial latest head on 2026-10-03.
Item 14 adds opt-in live beacon implementation observations on 2026-10-03.
Item 15 adds separate implementation code observations in opt-in v2 on 2026-10-04.
Items 16–45 have not started.
Adjust priorities using real user needs and protocol evidence.

One coordinator dispatch selects one unfinished item. A completed functional
item includes relevant tests and documentation. Keep changes coherent, preserve
the previous format unless a migration is supplied, and record actual work dates.
There is no worker-owned scheduler or automatic endless backlog.

## Completed increments

- [x] **01 — Explicit CLI and input validation.** Node.js 22+, no dependencies,
  exact chain ID arithmetic, address syntax, bounded options and useful help.
- [x] **02 — Coherent EIP-1967 capture.** Hash-pinned code and three storage reads,
  chain checks, canonical-block recheck, empty/anomalous data interpretation.
- [x] **03 — Snapshot persistence and diff.** Validated versioned files, private
  atomic no-overwrite writes, target compatibility, meaningful code/slot changes.
- [x] **04 — Adversarial offline verification.** Loopback fake RPC, HTTP/body
  timeouts and limits, protocol errors, redaction, file races and CLI integration.
- [x] **05 — Local release materials.** Synthetic demo, README, protocol contract,
  MIT, lockfile, worker guidance, roadmap and the original CI example.
- [x] **06 — Confirm ownership and publish baseline.** Account
  `AntonPopchenko-azur` and author `AntonPopchenko-azur <popchenkoanton@gmail.com>`
  are confirmed. Baseline `e52c75a85d36b7331578337ed9ed21a06134f84c` is published on
  `main` in `AntonPopchenko-azur/contract-watch`; authenticated account access was
  verified by the coordinator. No identity borrowing or token expansion.
- [x] **07 — Activate reproducible CI.** Promote the example to the active
  workflow with verified official checkout/setup-node SHA pins, independent
  Node.js 22/24 jobs, read-only permissions, offline tests and demo. Require both
  jobs to succeed for the target commit before publishing `v0.1.0`, and record
  the run URL in its annotation; see [release verification](RELEASE.md).
- [x] **08 — Machine-readable diff.** Add `diff --json` with the independently
  versioned document format, structured changes and notice codes. Changed,
  unchanged, forked and incomparable fixtures verify JSON output, safe failure,
  exact large integers and unchanged human output. Success/error exit codes stay
  0/1; snapshot version 1 is unchanged. Completed 2026-09-30.
- [x] **09 — Automation exit policy.** Add `diff --exit-code`: 2 for state
  changes, 0 without changes, and 1 for errors in both text and JSON modes.
  Default success remains 0; notices alone do not trigger 2. CLI tests cover
  compatibility, errors and flags, including the README shell example under
  `set -e`. Reports and schema versions are unchanged. Completed 2026-10-01.
- [x] **10 — Inspect existing snapshots.** Add `inspect FILE` using the strict
  bounded v1 reader and existing text report. CLI/fixture tests cover source
  labels, exact integers, empty/noncanonical state, corrupt and unsupported
  files, size limits, unusual files, rejected flags, no RPC and unchanged input.
  Existing commands and schemas are preserved. Completed 2026-10-01.
- [x] **11 — Strict checksum option.** Add snapshot-only `--strict-checksum`
  with exact EIP-55 casing and dependency-free Ethereum Keccak-256. All eight
  official address vectors, independent hash/padding vectors, wrong casing,
  syntax and CLI flags are tested. Validation precedes RPC/file creation;
  default syntax-only behavior, lowercase v1 persistence and offline commands
  remain compatible. Completed 2026-10-02.
- [x] **12 — Block hash input.** Add `snapshot --block-hash` with exact hash
  validation, metadata lookup and canonical checks before/after hash-pinned
  state reads. Fake-RPC/CLI tests cover exact selectors, large numbers, rejected
  headers, missing/noncanonical state, reorgs, chain changes, redaction and no
  file after failure. Existing number/tag semantics, checksum mode and v1
  formats are preserved. Completed 2026-10-02.
- [x] **13 — Confirmation-depth capture.** Add `snapshot --depth N`, selecting
  initial latest height minus a canonical decimal uint256 distance with BigInt.
  Tests cover depth 0/1, genesis, short chains, 256-bit boundaries, a changing
  head, exact RPC sequences and safe failures without snapshots. Existing
  selectors, checksum mode, v1 formats and final block/chain checks remain;
  request budgets and finality limits are documented. Completed 2026-10-03.
- [x] **14 — Beacon implementation resolution.** Add `snapshot --resolve-beacon`
  with one eligible hash-pinned implementation() call, fixed gas/time/body
  limits, strict ABI address fixtures and explicit skip reasons. Live results
  remain separate from strict v1 files; offline inspect/diff are unchanged.
  Loopback/CLI tests cover selectors, budgets, malformed/zero returns, provider
  failures, reorg/chain checks, redaction and atomic persistence. Completed
  2026-10-03.
- [x] **15 — Resolved implementation code.** Add `--implementation-code` with
  separate target/implementation bytecode, direct-slot or bounded-beacon address
  provenance, explicit skip/no-code states and strict snapshot v2 validation.
  Hash-pinned reads precede final rechecks; tests cover all block modes, code/
  HTTP/file limits, safe failures, fixtures and private atomic persistence.
  V1 remains supported; inspect reads v2 and diff explicitly rejects v2 until
  item 16. Document the compatibility/migration plan without inventing missing
  historical data or adding migration tooling. Completed 2026-10-04.

## Planned increments

- [ ] **16 — Beacon upgrade comparisons.** Report implementation changes behind
  an unchanged beacon using upgraded fixtures and honest observation labels.
- [ ] **17 — Snapshot migration tooling.** Supply explicit offline migration for
  new schema versions, backup behavior and old-version compatibility fixtures.
- [ ] **18 — Chain genesis identity.** Optionally bind snapshots to genesis hash
  to distinguish networks that reuse chain IDs; test collisions and migrations.
- [ ] **19 — Local target configuration.** Validate named address/chain entries;
  resolve RPC through environment references without persisting secrets.
- [ ] **20 — Multi-target one-shot capture.** Add bounded target counts and
  explicit per-target outcomes; test partial failures and deterministic output.
- [ ] **21 — Shared block across targets.** Resolve one block per chain for a
  multi-target run and verify all reads and saved metadata use that hash.
- [ ] **22 — Bounded concurrency.** Add a small configurable request limit with
  ordering/cancellation tests; retain deterministic offline fixtures.
- [ ] **23 — Transient-failure retry policy.** Add opt-in limited retries and
  overall deadlines, preserving the same block and redacted errors.
- [ ] **24 — Provider rate-limit handling.** Respect bounded retry delays for
  429 responses and verify delay cancellation without real timers in tests.
- [ ] **25 — Explicit cancellation.** Handle user interrupts with prompt request
  cancellation and no partially published snapshot set.
- [ ] **26 — Local history directory.** Store indexed observations under explicit
  target directories with collision and interrupted-write recovery tests.
- [ ] **27 — History timeline view.** Present recorded slot/code transitions
  across many files without implying unobserved intermediate events.
- [ ] **28 — History pruning preview.** Offer a dry-run retention plan and an
  explicit apply operation that preserves baselines and unrelated files.
- [ ] **29 — Finite watch sessions.** Add opt-in interval/count/duration limits
  and graceful stop; do not create a system scheduler or endless loop.
- [ ] **30 — Consecutive observation policy.** Allow a configured number of
  matching observations before marking a transition stable; test flapping.
- [ ] **31 — Reorg-aware history.** Label displaced block observations and rebuild
  the visible timeline without deleting historical evidence.
- [ ] **32 — EIP-1967 event cross-check.** Add bounded upgrade/admin/beacon log
  reads and label agreement or disagreement with storage observations.
- [ ] **33 — Paginated log recovery.** Split bounded block ranges for providers
  with log limits and test gaps, duplicates and interrupted pagination.
- [ ] **34 — Event-to-snapshot correlation.** Link candidate events to nearby
  observations while retaining transaction/block provenance and caveats.
- [ ] **35 — EIP-1167 minimal proxy evidence.** Add narrowly specified bytecode
  pattern fixtures, target extraction and explicit unsupported variants.
- [ ] **36 — Proxy-path traversal.** Follow a bounded number of observed targets
  with cycle detection and consistent block selectors.
- [ ] **37 — Provider capability check.** Diagnose required read support using
  fixed safe output, avoiding endpoint disclosure or silent feature fallback.
- [ ] **38 — Optional second-provider comparison.** Compare observations at the
  same chain/block hash and label disagreement without choosing a truth source.
- [ ] **39 — Local comparison rules.** Configure which observed fields matter
  for a local report, without adding contract safety scores.
- [ ] **40 — Local report exports.** Generate escaped Markdown/HTML reports from
  snapshots, testing hostile input and keeping reports usable offline.
- [ ] **41 — Large-history performance.** Measure and bound memory/time for
  history analysis using generated fixtures and documented operating limits.
- [ ] **42 — Protocol fuzz corpus.** Add deterministic malformed-data generation
  around parsers and snapshot validation, minimizing any discovered regressions.
- [ ] **43 — Supported-platform verification.** Run file/cancellation behavior on
  Linux and macOS, document filesystem differences and reproducible failures.
- [ ] **44 — Packaging rehearsal.** Verify a local source archive includes the
  CLI, license and docs without snapshots/secrets; no npm publication.
- [ ] **45 — Stable release review.** Recheck source specifications, user-facing
  limits, migration guarantees and full offline suite; publish only with the
  confirmed account and authorization, then report roadmap completion.
