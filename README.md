# Contract Watch

A small, read-only Node.js CLI for taking EVM contract snapshots and comparing
code and EIP-1967 implementation, admin, and beacon storage words.

**Version 0.1.0 baseline.**
Source repository: [AntonPopchenko-azur/contract-watch](https://github.com/AntonPopchenko-azur/contract-watch).
There are no runtime or development dependencies. Node.js 22+ is required.
The package is deliberately `private` to prevent accidental npm publication.

## Try it offline

Run these commands from this project directory:

```sh
node --version
npm ci --ignore-scripts --offline --no-audit --no-fund
npm test
npm run demo
node bin/contract-watch.js --help
```

The demo compares [two synthetic snapshots](examples/before.json), with an
[updated implementation and admin](examples/after.json). It makes no network
requests and needs no keys. Its significant output is:

```text
Source: synthetic (demonstration only)
Blocks: 100 -> 101
implementation: 0x2222222222222222222222222222222222222222 -> 0x3333333333333333333333333333333333333333
admin: empty -> 0x4444444444444444444444444444444444444444
```

These addresses, block hashes and code are invented demonstration data, not
observations from Ethereum. `capturedAt` in the examples records their generation
time, not a claim that those blocks were observed then.

## Capture a snapshot

Supply the exact target address, expected chain ID, and your chosen HTTP(S) RPC.
No public endpoint is selected automatically. This example uses a local node and
an example address; replace both with your intended target:

```sh
mkdir -p snapshots
export CONTRACT_WATCH_RPC_URL='http://127.0.0.1:8545'
node bin/contract-watch.js snapshot \
  --address 0x1111111111111111111111111111111111111111 \
  --chain-id 1 \
  --block finalized \
  --out snapshots/first.json
```

Repeat later with a **new filename**, such as `snapshots/second.json`, then compare:

```sh
node bin/contract-watch.js diff snapshots/first.json snapshots/second.json
```

For scripts, add `--json` to get one versioned JSON document on stdout:

```sh
node bin/contract-watch.js diff --json examples/before.json examples/after.json
```

The report uses `kind: "contract-watch-diff"` and `schemaVersion: 1`, includes
the target and both blocks, and provides `changed`, structured `changes`, and
machine-readable `notices`. Chain IDs and block numbers stay strings to preserve
large integers. It contains no input paths, RPC endpoint, capture timestamps, or
remote errors. The normal text report is unchanged when `--json` is omitted.
The flag may appear before, between, or after the two filenames; duplicate or
unknown flags are rejected. Prefix a filename starting with `--` with `./`.

Both changed and unchanged comparisons still exit **0**, including a comparison
with a fork/inconsistency notice. On incomparable snapshots, invalid files, or
other errors, stdout is **empty**, stderr contains the existing safe text error,
and the exit status is **1**. No partial report or JSON error document is emitted;
check the exit status before parsing stdout. JSON diff is offline and ignores
`CONTRACT_WATCH_RPC_URL`. See the [JSON format contract](docs/PROTOCOL.md#json-diff-contract-version-1).

`--rpc URL` overrides `CONTRACT_WATCH_RPC_URL`. Prefer the environment variable for
key-bearing URLs so the URL is not in CLI arguments; environment variables still
need to be handled carefully by your shell and process supervisor. The program
does not load `.env` files. HTTP is useful for local nodes; use HTTPS for remote
providers. URL path/query authentication is supported, embedded `user:password`
credentials and fragments are rejected. The CLI never prints or stores the URL.

| Option | Meaning |
| --- | --- |
| `--address ADDRESS` | Required `0x` plus 40 hex digits; normalized to lowercase |
| `--chain-id ID` | Required positive decimal or hex integer, up to 256 bits; checked against RPC |
| `--out FILE` | Required new snapshot path in an existing directory |
| `--rpc URL` | Explicit HTTP(S) RPC, or use `CONTRACT_WATCH_RPC_URL` |
| `--block BLOCK` | `latest` by default; `safe`, `finalized`, decimal or hex block number also accepted |
| `--timeout-ms MS` | 100–60000 ms per whole request; default 10000 |

Address validation checks length and hex syntax, **not the EIP-55 checksum**. Mixed
case is accepted. Chain IDs use exact integer arithmetic. Zero chain IDs, ENS
names, `pending`, duplicate flags, and unknown options are rejected. The zero
address is a valid target and will usually have no code.

Diff takes two files, with the earlier block first. Both must have the same
address, chain ID, and source kind. Exit status is **0 for success, including a
diff with changes**, and **1 for input, RPC, or file errors**. Errors use stable
codes and fixed messages; URLs, paths, remote error text, and stacks are omitted.

## What a snapshot means

The CLI checks the chain, resolves the requested block, and passes the same
`{ blockHash, requireCanonical: true }` selector to every code/storage read.
It then rechecks that block's canonical hash and the chain ID. This requires
**EIP-1898 support**; there is no fallback to unpinned reads. Old state may require
an archive-capable provider. No snapshot is written after an RPC failure.

Snapshots retain full target bytecode, raw 32-byte words, block number/hash,
chain ID, normalized target address, source kind, and the local capture time.
Reports summarize code with a SHA-256 fingerprint (not Ethereum Keccak-256).
Existing files and symlinks are never overwritten. New snapshots are published
atomically on filesystems supporting same-directory hard links and use mode
`0600` on POSIX. Use a local directory you control.

Limits are 1 MiB per HTTP response, 16 KiB of HTTP headers, 128 KiB of target code,
and 512 KiB per snapshot input. Redirects and compressed responses are rejected.
There are eight sequential read requests on a successful capture, no retries,
and no background loop. A capture can therefore take up to eight request timeouts.
The RPC allowlist contains only chain, block, code, and storage reads; no wallet,
signing, transaction submission, or `eth_call` is used in this version.

## Interpretation and limits

- A zero word means an empty slot and is displayed as `empty`.
- Nonzero high 12 bytes are preserved and labeled noncanonical instead of being
  silently truncated into an address.
- A populated implementation slot is evidence about storage, not proof of proxy
  behavior. Populated implementation and beacon slots together are ambiguous.
- With no code, the report says there is no code **at that block**. With empty
  target slots it says no EIP-1967 target was found, including ordinary contracts.
  Other proxy patterns may still exist; the tool does not identify every proxy.
- A beacon address is recorded but its `implementation()` is not called. An
  upgrade behind an unchanged beacon is invisible in this release. Implementation
  contract bytecode is also outside this release's scope.
- Snapshots compare endpoints in time, so intermediate upgrades can be missed.
  A changed slot does not by itself prove that an upgrade transaction occurred.
  Same-height fork comparisons and inconsistent same-hash data receive notices.
- This is not a security audit, a safety rating, or an independent proof of chain
  state. Results depend on the chosen RPC and the integrity of local files.
  Finality can change after capture, and chains may reuse chain IDs.

See [protocol and snapshot format](docs/PROTOCOL.md) for the field contract and
[roadmap](docs/ROADMAP.md) for deliberately deferred features.

## Development and publication

`npm test` runs Node's built-in test runner, temporary files, child CLI processes,
and loopback-only fake HTTP servers. It never contacts a real chain and does not
need credentials. Environments that block listening on `127.0.0.1` must grant
that local test capability. Do not substitute production RPC calls for tests.

The active [CI workflow](.github/workflows/ci.yml) checks Node.js 22 and 24 on
pushes to `main` and pull requests. It runs the offline install, `npm run check`,
and the synthetic demo with no RPC secrets and only read access to repository
contents. Actions are pinned to verified official release commits, and checkout
does not persist credentials. [CI results](https://github.com/AntonPopchenko-azur/contract-watch/actions/workflows/ci.yml)
show each run and its commit.

The initial source baseline is published. Version `v0.1.0` is an annotated Git
tag, created only after both CI jobs succeed for its target commit; its annotation
records the verification run. [Release notes](docs/RELEASE.md) document this
process and baseline limits. This package is not published to npm.

## Sources

Protocol decisions were checked against
[EIP-1967](https://eips.ethereum.org/EIPS/eip-1967),
[EIP-1898](https://eips.ethereum.org/EIPS/eip-1898), the official
[Ethereum JSON-RPC documentation](https://ethereum.org/en/developers/docs/apis/json-rpc/),
and the [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification).

MIT licensed; see [LICENSE](LICENSE).
