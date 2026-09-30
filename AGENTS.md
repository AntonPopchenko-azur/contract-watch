# Contract Watch worker instructions

Read this file, README.md, and docs/ROADMAP.md before work. The parent workspace
AGENTS.md also applies. Work only in this project directory; set it explicitly
for package commands, tests, and any future Git commands. Preserve user changes.
Do not edit parent coordination state or sibling projects.

## Confirmed identity and publication handoff

The user confirmed this project's identity on 2026-09-30:

- GitHub account: `AntonPopchenko-azur`
- Commit author: `AntonPopchenko-azur <popchenkoanton@gmail.com>`
- Local Git branch: `main`
- Repository-local `credential.https://github.com.username`: `AntonPopchenko-azur`
- Repository-local `credential.https://github.com.useHttpPath`: `true`

The public repository is `https://github.com/AntonPopchenko-azur/contract-watch`.
The coordinator is completing the initial commit and Git authentication.
Until publication is verified and the coordinator dispatches development work,
do not create commits or tags, push, or start the next item. After that handoff,
each authorized dispatch may commit and push one coherent roadmap increment
to this repository using the identity above. Do not create or change credentials.
A username hint does not establish authenticated access.
Do not borrow Tojen-dev or another project's identity. Do not change global Git
identity or credential settings, and do not remove existing Keychain entries.
Keep the package private; npm publication is not authorized. Roadmap item 06
remains incomplete and item 07 has not started.

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
  detected. Beacon resolution remains a separately planned feature.
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
pending access/publication setup, or completion of the roadmap. GitHub Actions
stays an inactive example until the coordinator dispatches item 07.
