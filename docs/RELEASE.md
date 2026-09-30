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
- The original baseline contains 22 project files and a dependency-free lockfile.
  The CI example is now promoted to `.github/workflows/ci.yml`.

Real-chain interoperability has not been exercised. Local verification uses
Node.js 22; the active GitHub workflow supplies the Node.js 22/24 matrix.
Do not infer universal proxy support or contract safety from these checks.

## CI and release verification

The [active workflow](../.github/workflows/ci.yml) runs on `main` pushes and pull
requests, with separate Node.js 22 and 24 jobs and a five-minute limit per job.
Each job runs the dependency-free offline install, `npm run check` (syntax plus
the full offline test suite), and `npm run demo`. Matrix failure does not cancel
the other job.
No chain access or RPC secrets are needed. Permissions are `contents: read`,
checkout credential persistence is disabled, and package-manager caching is off.

Official action release refs and action metadata were checked on 2026-09-30:

| Action | Release | Immutable commit |
| --- | --- | --- |
| `actions/checkout` | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | [v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) | `820762786026740c76f36085b0efc47a31fe5020` |

Both pinned actions use the Node.js 24 action runtime on GitHub-hosted runners;
the tested application versions are selected separately by the job matrix.
See [workflow runs](https://github.com/AntonPopchenko-azur/contract-watch/actions/workflows/ci.yml)
for commit-specific results. A configured workflow alone does not prove a pass.

The authorized release procedure is to push the single CI/handoff commit, wait
for both matrix jobs to succeed for that exact SHA, then create and push the
annotated `v0.1.0` tag if absent. Its annotation records the commit, successful
Node.js results, and immutable CI run URL. Existing tags are never replaced.
The workflow filters pushes to `main`, so publishing the tag does not launch a
duplicate run. No npm package or GitHub release page is created by this procedure.

## Published identity and ongoing work

The user confirmed the Contract Watch account and author on 2026-09-30:

- GitHub account and local `user.name`: `AntonPopchenko-azur`
- Local `user.email`: `popchenkoanton@gmail.com`
- Local `credential.https://github.com.username`: `AntonPopchenko-azur`
- Local `credential.https://github.com.useHttpPath`: `true`

A separate Git repository uses `main` and these four repository-local settings.
The public GitHub repository was created under the confirmed account on
2026-09-30. The path-scoping setting separates credential lookup by repository
path. Global identity and existing Keychain entries were left intact.

The coordinator verified initial baseline commit
`e52c75a85d36b7331578337ed9ed21a06134f84c` on local and GitHub `main`, and the
authenticated API identity `AntonPopchenko-azur`. Item 06's publication blocker is
resolved. Item 07 activates CI and the verification/tag procedure above.
Subsequent coordinator dispatches may make useful tested commits and push to the
confirmed origin with this identity. Access failures are reported instead of
changing credentials or expanding permissions. Keep npm publication disabled.

The [roadmap](ROADMAP.md) covers subsequent development separately from this
tagged baseline. No independent scheduler was installed.
