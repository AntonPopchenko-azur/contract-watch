# Contract Watch worker instructions

Read this file, README.md, and docs/ROADMAP.md before work. The parent workspace
AGENTS.md also applies. Work only in this project directory; set it explicitly
for package commands, tests, and any future Git commands. Preserve user changes.
Do not edit parent coordination state or sibling projects.

## Confirmed identity and published repository

The user confirmed this project's identity on 2026-09-30:

- GitHub account: `AntonPopchenko-azur`
- Commit author: `AntonPopchenko-azur <popchenkoanton@gmail.com>`
- Local Git branch: `main`
- Repository-local `credential.https://github.com.username`: `AntonPopchenko-azur`
- Repository-local `credential.https://github.com.useHttpPath`: `true`

The public repository is `https://github.com/AntonPopchenko-azur/contract-watch`.
The coordinator verified baseline commit
`e52c75a85d36b7331578337ed9ed21a06134f84c` on local and GitHub `main` and confirmed
authenticated access as `AntonPopchenko-azur`. Publication preparation is complete.
Each authorized coordinator dispatch may implement, test, commit, and push one
coherent roadmap increment to this repository using the identity above. Check
the working tree and origin before writing; preserve unrelated changes.
Use the existing repository-scoped authentication. Do not create or change
credentials or permissions; report access failures to the coordinator.
Do not borrow Tojen-dev or another project's identity. Do not change global Git
identity or credential settings, and do not remove existing Keychain entries.
Keep the package private; npm publication is not authorized. CI now runs from
`.github/workflows/ci.yml` on Node.js 22 and 24. Release tags require an explicit
release dispatch and successful CI for the exact target commit. The initial
`v0.1.0` dispatch authorizes an annotated tag after both jobs succeed, without a
GitHub release page. Never replace an existing published tag.

## Development contract

- Use Node.js 22+ and built-in modules. Keep the CLI small and dependency-free.
- Read RPC only: explicit endpoint, target and expected chain ID; validate all
  inputs/results. Never add signing, transaction submission, wallet keys, or
  production RPC requests to tests.
- Preserve hash-pinned state reads and fail clearly when EIP-1898 is unsupported.
  Do not silently fall back to latest or numeric selectors.
- Bound time, HTTP headers/body, code, and file sizes. Never print RPC URLs, API
  keys, raw provider errors, arbitrary input strings, or underlying error stacks.
- Preserve raw words. Empty slots, noncanonical data and ordinary contracts must
  not be converted into claims that a contract is safe or that all proxies are
  detected. `--resolve-beacon` remains live-only and writes strict v1 unless genesis is enabled.
  `--implementation-code` explicitly writes v2 with separate implementation code
  and validated address provenance; preserve raw words and strict unknown-field
  checks for every version. Its dedicated beacon
  implementation() call is hash-pinned, limited to 100000 gas, 4 KiB and at most
  5 seconds, with no generic eth_call access. Both code blobs are bounded at
  128 KiB each; files at 512 KiB for v1 and 768 KiB for v2/v3/v4. Diff requires matching
  snapshot versions: preserve v1 output; v2 uses JSON diff v2 and separately
  compares available implementation observations with the same provenance.
  Skips/provenance changes must not fabricate address/code changes. Mixed versions
  remain DIFF_VERSION errors. Offline migration converts v1/v2 to v3, or v1/v2/v3 to v4, at a new
  path, retaining the original as backup. V1 gains only not-recorded; v2 retains
  its complete observation. Strict v3 migration provenance binds those states.
  V3 diff uses JSON diff v3; missing observations are unavailable, not unchanged,
  empty code or same-hash contradictions. Explicit --genesis writes strict v4:
  observe nonzero block-0 hash before state reads and recheck before the final
  chain check; selected block 0 must agree. All existing canonical/hash-pinned
  reads remain. V4 migration only adds not-recorded genesis; preserve v3's original
  fromVersion. V4 diff requires matching observed genesis, rejecting unknown or
  different hashes as identity errors. Matching genesis is not proof of ancestry,
  uniqueness or honesty. Follow docs/MIGRATION.md; no RPC in migration.
- Single snapshot config selects exactly one target using --config/--target together;
  never add implicit discovery, .env loading, interpolation, override precedence
  or RPC fallback. Follow docs/CONFIGURATION.md: bounded strict read, validate all
  entries and selected capture input before reading only its rpcEnv. Preserve
  original address casing for checksum validation. No name/config/env reference
  or endpoint enters snapshots/reports. snapshot-many explicitly selects 1–32
  unique names in order, validates all before env/output, and exclusively creates
  a new private directory. Capture/save sequentially with independent block and
  final checks; no shared block, concurrency, retries or rollback. Missing env,
  RPC and write failures are per-target safe JSON outcomes; preserve successes,
  ordinal filenames and old snapshot formats. Batch exit 0 only for all saved,
  otherwise 1. Global errors precede RPC and have empty stdout. Follow the batch
  contract in docs/CONFIGURATION.md; later roadmap features remain separate.
- For each functional change, add meaningful regression/protocol/file tests and
  document user-visible behavior. Run `npm test` and `npm run demo` as appropriate.
  Tests use local fake RPC and temporary directories, without keys or external
  services. Request loopback test capability if the sandbox blocks local servers.
- Keep version 1 snapshot compatibility explicit. Unknown fields are rejected;
  incompatible format changes need a migration plan and fixtures.

## Scheduled work

This is a separate long-lived worker managed by the coordinating task. One
dispatch means one useful unfinished roadmap item, with tests and documentation.
Do not create agents, tasks, schedulers, automations, or endless work loops.
Schedule and durable state belong to the coordinator. Its authorized Contract
Watch slots are 11:00/19:00 Europe/Kyiv, with up to 30 minutes of daily variation;
this worker does not interpret or schedule them independently.

When commit work is dispatched, use coherent commits with actual timestamps. The
roadmap is a planning tool, not a demand for 45 commits. Never make empty commits,
manufacture contribution activity, backdate work, fake reviews/stars, rewrite
published history, force-push, expand token access, or message third parties.

Successful routine scheduled work is quiet. Report failures that need attention,
access or CI failures, or completion of the roadmap. Do not start the next item
until the coordinator dispatches it.
