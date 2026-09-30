# 0.1.0 — baseline

Prepared on 2026-09-30. Source repository:
[AntonPopchenko-azur/contract-watch](https://github.com/AntonPopchenko-azur/contract-watch).
This package is not published to npm.

The baseline supplies a dependency-free CLI for explicit-address EIP-1967
snapshots at a single block hash, with offline code/slot comparisons. It includes
bounded HTTP reads, fixed diagnostic messages, strict snapshot validation,
atomic no-overwrite saving, synthetic examples and the MIT license.

## Verification

Local environment: Node.js v22.22.3, npm 10.9.8, macOS.

- `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund`
  generated the dependency-free lockfile.
- `node --test --test-reporter=spec test/*.test.js`: **62 passed, 0 failed**,
  including nested cases, no skipped tests. A first sandboxed attempt could not
  open loopback ports (`EPERM`); the full suite passed with loopback capability.
- Protocol tests cover hash selectors, exact slots, chain checks, reorgs,
  malformed data/envelopes, timeout across headers/body, response bounds,
  redirection/compression refusal and remote-error redaction.
- File and CLI tests cover atomic races, no overwrite of files/symlinks,
  permission mode, bounded reads, invalid schema/data, diff semantics and no
  snapshot after a failed capture.
- The synthetic CLI demo is exercised as part of the suite without network use.

Publication-preparation recheck on 2026-09-30:

- `npm run check`: syntax check succeeded; **62 tests passed, 0 failed, 0
  skipped, 0 cancelled**, using loopback capability for the fake RPC servers.
- `npm run demo`: exit status **0**, showing the synthetic implementation/admin
  changes without network requests.
- The baseline contains 22 project files. The lockfile has no dependencies and
  the CI example remains inactive.

Real-chain interoperability and GitHub-hosted CI have not been exercised.
The CI example specifies Node 22 and 24; only Node 22 has been tested locally.
Do not infer universal proxy support or contract safety from these checks.

## Publication handoff

The user confirmed the Contract Watch account and author on 2026-09-30:

- GitHub account and local `user.name`: `AntonPopchenko-azur`
- Local `user.email`: `popchenkoanton@gmail.com`
- Local `credential.https://github.com.username`: `AntonPopchenko-azur`
- Local `credential.https://github.com.useHttpPath`: `true`

A separate Git repository uses `main` and these four repository-local settings.
The public GitHub repository was created under the confirmed account on
2026-09-30. The path-scoping setting separates credential lookup by repository
path. Global identity and existing Keychain entries were left intact.

The initial baseline is one coherent commit. Publication verification is tracked
by roadmap item 06; GitHub CI activation and verification is item 07. CI remains
an inactive example in this baseline. Keep npm publication disabled.

The [roadmap](ROADMAP.md) marks the five baseline areas complete and retains 40
unfinished increments. No independent scheduler was installed.
