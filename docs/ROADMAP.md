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
Item 16 adds offline v2 implementation comparisons on 2026-10-04.
Item 17 adds explicit offline snapshot migration to v3 on 2026-10-05.
Item 18 adds opt-in genesis identity and strict v4 snapshots on 2026-10-05.
Item 19 adds explicit single-target local configuration on 2026-10-06.
Item 20 adds explicit sequential multi-target capture on 2026-10-06.
Item 21 adds opt-in shared blocks per expected-chain group on 2026-10-07.
Item 22 adds bounded concurrent batch admission on 2026-10-10.
Item 23 adds opt-in transient retries and active capture deadlines on 2026-10-11.
Item 24 adds bounded opt-in HTTP 429 waits and testable wait cancellation on 2026-10-12.
Item 25 adds explicit live interruption, drain and owned-output rollback on 2026-10-12.
Item 26 adds explicit offline history, immutable indexing and interrupted-write recovery on 2026-10-15.
Item 27 adds a read-only timeline of indexed observations on 2026-10-19.
Item 28 adds deterministic retention previews and explicit copies with source backups on 2026-10-19.
Items 29–45 have not started.
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
- [x] **16 — Beacon upgrade comparisons.** Compare two saved v2 observations
  offline, including changed implementation address/code behind an unchanged
  beacon. JSON diff v2 keeps target/slot changes separate from implementation
  changes and reports unavailable or changed-provenance observations explicitly.
  Tests cover no-code/skips, source transitions, fork/inconsistency notices,
  exact integers, safe errors, no network/input writes and text/JSON exit policy.
  V1 output remains unchanged; mixed versions still fail with DIFF_VERSION.
  Synthetic examples and independent expected reports document the contract;
  migration tooling remains item 17. Completed 2026-10-04.
- [x] **17 — Snapshot migration tooling.** Add `migrate SOURCE --to-version 3
  --out NEW` for offline v1/v2-to-v3 conversion, retaining original bytes/mtime/
  permissions as backup and publishing only private atomic new files. V1 gains
  a not-recorded marker; v2 observations and all common capture fields remain
  intact. Strict v3 validation and JSON diff v3 distinguish missing history from
  no-code/skips and comparable observations; old formats and mixed-version
  refusals remain. Fixtures/tests cover provenance, bounds, links/races/failures,
  offline env/network spies, repeat policy, redaction and inspect/diff. Completed
  2026-10-05.
- [x] **18 — Chain genesis identity.** Add explicit `--genesis` capture to v4,
  with two exact block-0 reads, nonzero mined-header validation, final identity
  recheck and consistency when the selected block is genesis. Preserve all
  hash-pinned state/canonical/chain checks and default v1/v2 budgets. Strict v4
  inspect/diff distinguish matching, colliding and unrecorded genesis; unknown
  or different identity fails without claiming an ordinary contract change.
  Offline v1/v2/v3-to-v4 migration preserves original observations/timestamps
  and backup files, adding only not-recorded genesis. Tests cover all selectors,
  implementation/live beacon modes, bounds, failures, redaction, schema, golden
  reports, exit policy, migration and atomic output. Document provider/fork trust
  limits and exact request budgets. Completed 2026-10-05.

- [x] **19 — Local target configuration.** Add explicit --config/--target
  selection of one named address/chain/environment reference, with no overrides,
  discovery, interpolation or fallback. Strict bounded UTF-8 JSON validates all
  1–32 entries, unique names/keys, depth and byte limits before reading only the
  selected RPC variable. Preserve original checksum casing, all capture modes,
  exact request traces, snapshot formats and offline behavior. Tests cover
  malformed/unused entries, env ordering, special files/races/cleanup, uint256
  IDs, redaction, unchanged config and capture failures. Document the contract
  and provide a secret-free example. Completed 2026-10-06.

- [x] **20 — Multi-target one-shot capture.** Add `snapshot-many` for 1–32
  unique explicit config selections in order, with all input validation before
  env/output and an exclusive new directory. Capture and save independently and
  sequentially through the existing engine; preserve v1/v2/v4 files and all
  canonical/chain/genesis checks. JSON batch report v1 records safe ordinal
  outcomes; env/RPC/write failures continue and retain successful files, with
  exit 0 only for all saved, otherwise 1. Tests cover limits, modes, exact request
  budgets, advancing heads, partial/all failures, env ordering, directory races,
  write cleanup, redaction and offline reuse. Document non-atomic set/crash limits;
  shared blocks, concurrency, retries and history remain separate. Completed
  2026-10-06.

- [x] **21 — Shared block across targets.** Add explicit `snapshot-many
  --shared-block`, grouping exact decimal/hex chain-ID aliases and resolving
  once from each group's first selected member. Every RPC independently checks
  chain, anchor hash/height/canonicality and final checks; optional genesis must
  agree with the group's initial observation. Resolution failures block only
  that group without fallback; later capture/save failures preserve anchors and
  successful files. Opt-in batch report v2 records safe resolved/unavailable
  groups; default v1 and strict snapshots remain unchanged. Tests cover moving
  heads, interleaved groups, all selectors/features, uint256 values, boundaries,
  partial failures, reorgs, genesis, env ordering, exact traces and offline reuse.
  Document additional request/deadline budgets and non-atomic provider trust
  limits. Completed 2026-10-07.

- [x] **22 — Bounded concurrency.** Add CLI-only `snapshot-many --concurrency`
  with strict 1–8 input and default 1 preserving sequential traces. Bound whole
  target jobs so all resolver/capture/beacon RPCs share the same limit. Shared
  followers wait outside workers until their fixed leader resolves; admit the
  earliest ready target and preserve input outcome/group/filename order. Close
  failed transport resources before releasing capacity, and drain started work
  before reporting. Tests cover measured active requests, 1/32 targets, reversed
  completion, interleaved/failed groups, selectors/features, timeouts/aborts,
  queue stop/drain, partial writes and unchanged v1/v2 fixtures. Preserve strict
  snapshots, request/deadline budgets and offline behavior; document memory and
  cancellation/partial-output limits. No CLI interrupt workflow or retries.
  Completed 2026-10-10.

- [x] **23 — Transient-failure retry policy.** Add CLI-only --retries 0–3 and
  --deadline-ms 100–600000, requiring a deadline for positive retries. Retry only
  transport/timeouts and HTTP 502/503/504 with bounded 100/200/400 ms delays,
  unchanged method/params and fresh IDs; preserve the original pin and every
  identity/canonical/final check. One monotonic budget spans an active capture,
  including shared leader resolution; followers exclude queue/anchor wait.
  Close transports before retries/release, keep retry delays in their worker,
  and use fixed CAPTURE_DEADLINE on exhaustion. Defaults/explicit zero preserve
  old traces and errors; config/snapshot/report formats stay unchanged. Tests
  cover fake time, real transport closure/concurrency, permanent failures,
  selector/feature combinations, shared failure phases, partial files, early
  validation and offline reuse. Document exact attempt/backoff budgets and
  capture-versus-filesystem/process limits. No 429 or signal/rollback workflow.
  Completed 2026-10-11.

- [x] **24 — Provider rate-limit handling.** Extend positive retries to HTTP
  429 with bounded Retry-After integer seconds and all three HTTP-date formats.
  Cap accepted minimums at 30000 ms; refuse excessive/deadline-incompatible,
  duplicated, oversized or ambiguous values without an early retry. Document
  missing/invalid-value backoff and preserve default/zero RPC_HTTP behavior,
  other transient backoff, 1+N attempts, pins, fresh IDs and strict formats.
  Convert wall-clock dates once to monotonic minimums; re-wait early wakes and
  support internal cancellable sleeps without adding CLI signal handling.
  Deterministic fake-clock tests cover date/number boundaries, malformed fields,
  mixed failures, exhaustion, early wakes, deadline and abort cleanup. Loopback
  tests cover transport closure, single/batch/shared/concurrency, private partial
  files and offline reuse. Full test/check suites and demo pass. No provider-wide
  queue, new config, rollback or item-25 lifecycle. Completed 2026-10-12.

- [x] **25 — Explicit cancellation.** Add one live SIGINT/SIGTERM lifecycle:
  first signal wins (130/143), abort active HTTP and retry/Retry-After waits,
  stop queued env/RPC admission and drain every started capture/writer. Before
  the documented completion point, remove only this run's owned files and
  empty batch directory, including earlier saved members. Verify parent and
  inode/metadata identity, preserve substituted/modified/user-added files and
  report incomplete cleanup safely without partial stdout. Preserve ordinary
  per-target failure outcomes, successful files, all pins/budgets and strict
  snapshot/report formats. Deterministic and real child-signal tests cover
  request/wait/file boundaries, shared leaders/followers, concurrency 1/2/8,
  repeated signals, deadline races, cleanup failures, completion and offline
  reuse. All 1340 tests, check, demo and changed-JS syntax checks pass. Document
  trusted-directory, crash/SIGKILL, visibility and hung-I/O limits in
  CANCELLATION.md. No history/watch/config/provider queue. Completed 2026-10-12.

- [x] **26 — Local history directory.** Add explicit offline history
  init/add/verify/recover commands for one selected source and target directory.
  Preserve strict v1–v4 source bytes/timestamps and bind exact target, chain,
  source, version and observed/unknown genesis identity. Use an immutable header
  and up to 128 contiguous, hash-linked index records: publish each complete
  snapshot first, then its no-overwrite entry as the commit point. Bound actual
  reads, index bytes, nesting and directory entries; validate committed/pending
  snapshots and index integrity without treating partial publication as success.
  Same logical observations are idempotent; competing writers cannot overwrite
  ordinals. Explicit recovery confirms only the selected pending observation
  or interrupted initialization, preserving earlier files and abandoned stages.
  File/CLI tests cover identities, formats, corruption, limits, collisions,
  links/special files/substitution, I/O failures, concurrent writers, real
  SIGINT/SIGTERM/SIGKILL boundaries, offline spies and reuse. All 1442 tests,
  check, demo and changed-JS syntax checks pass. Document schemas, commit points,
  trusted-directory and crash/power-loss limits in HISTORY.md; live capture and
  cancellation remain unchanged. No timeline, pruning, watch or reorg analysis.
  Completed 2026-10-15.

- [x] **27 — History timeline view.** Add explicit offline history timeline
  with text and independently versioned JSON v1. Fully validate the selected
  store, show only committed observations in index order, and count excluded
  pending snapshots/stages. Compare adjacent target code/raw slots and separate
  implementation observations under existing provenance/availability rules.
  Preserve strict v1–v4 identity and refusal to compare unknown v4 genesis;
  decreasing-height pairs are explicitly unavailable without reversing them.
  Retain equal/decreasing heights/times and report repeated-hash conflicts,
  including nonadjacent observations, without inferring upgrades, intermediate
  events, ancestry, reorgs or finality. Independent text/JSON fixtures and tests
  cover versions, uint256 precision, ordering, missing data, corruption, bounds,
  links/special files/races, offline spies and unchanged file metadata/bytes.
  Document schema, ordering, exit policy and read/consistency limits in HISTORY.md.
  All 1527 tests, check, demo and changed-JS syntax checks pass. No pruning,
  watching or event correlation. Completed 2026-10-19.

- [x] **28 — History pruning preview.** Add offline history prune with a
  deterministic baseline-plus-last-N JSON preview and explicit plan-bound apply
  to a new directory. Bind plans to verified bytes and filesystem metadata;
  reject stale/substituted plans without overwriting existing destinations.
  Preserve the entire source, including excluded records, pending/stages and
  exact selected snapshot bytes, identity, genesis and provenance. New private
  copies use a strict v2 history header with original ordinals and a retained
  prefix digest; entry v1 and snapshots stay unchanged. Publish the header last
  as the whole-copy commit point, preserve partial results and support explicit
  fresh-destination retry. Timeline v2 exposes retention gaps without inferring
  intermediate events; original v1 histories/reports remain compatible. Tests
  cover independent plans, policies, versions, limits, stale state, links/races,
  failures, real interruption boundaries and offline/source preservation.
  Document schema/compatibility, recovery and the fact that no disk space is
  reclaimed. All 1685 tests, check, demo and changed-JS syntax checks pass.
  No in-place deletion, watch or stability policy. Completed 2026-10-19.

- [x] **29 — Finite watch sessions.** Add one explicit direct/configured target,
  canonical interval/count/duration limits and a 128-attempt hard cap including
  failures. Use monotonic fixed-delay admission with no overlap/catch-up and
  unchanged strict capture/retry/pinning/format budgets. Cancel active RPC/waits
  at duration or first SIGINT/SIGTERM, drain writers and clean only the current
  uncommitted observation; retain earlier commits in a new private directory.
  Fixed ordinal no-overwrite snapshots and session JSON v1 distinguish saved,
  failed and duration-stopped attempts; signals retain 130/143 and empty stdout.
  Tests cover fake clocks, boundaries, traces, modes, failures, real signals,
  publication/cleanup races, foreign files, resource drain and offline reuse.
  Document precise commit/stop/report and crash/partial-output limits in WATCH.md.
  All 1900 tests, check, demo and changed-JS syntax checks pass.
  No scheduler, history import/prune, stability or reorg policy. Completed
  2026-10-20.

## Planned increments

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
