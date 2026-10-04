import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { captureWithImplementation, readSnapshot, saveSnapshot, validateSnapshot, SLOTS,
  MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_V2_BYTES } from '../src/snapshot.js';
import { MAX_CODE_BYTES } from '../src/validate.js';
import { MAX_RESPONSE_BYTES } from '../src/rpc.js';
import { snapshotReport, diffDocument } from '../src/report.js';
import { fakeRpc, cli, fixture, temporaryDirectory, protocolResult, ADDRESS, IMPLEMENTATION, HASH, EMPTY, word } from './helpers/fake-rpc.js';

const BEACON = `0x${'bb'.repeat(20)}`;
const CODE = '0x60016002';
const options = url => ({ rpcUrl: url, address: ADDRESS, chainId: '1' });
const args = (url, path) => ['snapshot', '--implementation-code', '--address', ADDRESS, '--chain-id', '1',
  '--rpc', `${url}/SENSITIVE_TEST_KEY`, '--out', path];
const slotsFor = via => ({ ...fixture().slots, ...(via === 'beacon' ? { implementation: EMPTY, beacon: word(BEACON) } : {}) });
function result(request, via = 'implementation-slot', code = CODE, slots = slotsFor(via)) {
  if (request.method === 'eth_getStorageAt') return slots[Object.keys(SLOTS).find(name => SLOTS[name] === request.params[1])];
  if (request.method === 'eth_call') return word(IMPLEMENTATION);
  if (request.method === 'eth_getCode' && request.params[0] !== ADDRESS) return code;
  return protocolResult(request);
}
function v2(via = 'implementation-slot', code = CODE) {
  return { ...fixture(), schemaVersion: 2, slots: slotsFor(via), implementation: {
    status: code === '0x' ? 'no-code' : 'observed', via, address: IMPLEMENTATION, code,
    ...(via === 'beacon' ? { beacon: BEACON, raw: word(IMPLEMENTATION) } : {})
  } };
}
function failure(actual, code) {
  assert.equal(actual.code, 1);
  assert.equal(actual.stdout, '');
  assert.ok(actual.stderr.startsWith(`Error [${code}]: `), actual.stderr);
  assert.doesNotMatch(actual.stderr, /SENSITIVE_TEST_|https?:|0x[0-9a-fA-F]{40}|at .*\.js/);
}

for (const via of ['implementation-slot', 'beacon']) {
  test(`${via}: code read is separate, pinned and before final checks in every block mode`, async t => {
    for (const selection of [{}, { block: 'latest' }, { block: 'safe' }, { block: 'finalized' },
      { block: '100' }, { block: '0x64' }, { blockHash: HASH }, { depth: '0' }, { depth: '1' }]) {
      await t.test(JSON.stringify(selection), async t => {
        const fake = await fakeRpc(t, request => ({ result: selection.depth === '1' &&
          request.method === 'eth_getBlockByNumber' && request.params[0] === 'latest'
          ? { number: '0x65', hash: `0x${'cd'.repeat(32)}` } : result(request, via) }));
        const captured = await captureWithImplementation({ ...options(fake.url), ...selection });
        assert.equal(validateSnapshot(captured), captured);
        assert.equal(captured.schemaVersion, 2);
        assert.equal(captured.code, '0x60006000');
        assert.deepEqual(captured.implementation, v2(via).implementation);
        assert.deepEqual(captured.slots, slotsFor(via));
        const methods = ['eth_chainId', selection.blockHash ? 'eth_getBlockByHash' : 'eth_getBlockByNumber',
          ...(selection.blockHash || selection.depth === '1' ? ['eth_getBlockByNumber'] : []),
          'eth_getCode', 'eth_getStorageAt', 'eth_getStorageAt', 'eth_getStorageAt',
          ...(via === 'beacon' ? ['eth_call'] : []), 'eth_getCode', 'eth_getBlockByNumber', 'eth_chainId'];
        assert.deepEqual(fake.calls.map(r => r.method), methods);
        assert.deepEqual(fake.calls.map(r => r.id), methods.map((_, index) => index + 1));
        assert.deepEqual(fake.calls.filter(r => r.method === 'eth_getCode').map(r => r.params[0]), [ADDRESS, IMPLEMENTATION]);
        for (const r of fake.calls.filter(r => ['eth_getCode', 'eth_getStorageAt', 'eth_call'].includes(r.method))) {
          assert.deepEqual(r.params.at(-1), { blockHash: HASH, requireCanonical: true });
        }
        if (via === 'beacon') assert.deepEqual(fake.calls.find(r => r.method === 'eth_call').params[0],
          { from: ADDRESS, to: BEACON, gas: '0x186a0', value: '0x0', input: '0x5c60da1b' });
        const report = snapshotReport(captured);
        assert.match(report, /Target code: 4 bytes/);
        assert.match(report, /Implementation code: 4 bytes/);
        assert.ok(report.includes(`via ${via}`));
        assert.doesNotMatch(report, /implementation is not resolved|not saved in snapshot v1/);
      });
    }
  });

  test(`${via}: no-code is an explicit saved observation, not a skip or successful-code claim`, async t => {
    const dir = await temporaryDirectory(t);
    const fake = await fakeRpc(t, request => ({ result: result(request, via, '0x') }));
    const path = join(dir, 'empty.json');
    const output = await cli(args(fake.url, path));
    assert.equal(output.code, 0, output.stderr);
    assert.match(output.stdout, /No code at the observed implementation address/);
    assert.deepEqual((await readSnapshot(path)).implementation, v2(via, '0x').implementation);
  });
}

test('skip reasons are deterministic and preserve raw words without implementation reads', async t => {
  const noncanonical = `0x01${'00'.repeat(31)}`;
  for (const [name, code, slots, reason] of [
    ['no target code has priority', '0x', { ...slotsFor('beacon'), admin: noncanonical }, 'NO_TARGET_CODE'],
    ['both populated', '0x60', { ...slotsFor('beacon'), implementation: word(IMPLEMENTATION) }, 'AMBIGUOUS_SLOTS'],
    ['empty slots', '0x60', { implementation: EMPTY, admin: EMPTY, beacon: EMPTY }, 'EMPTY_SLOTS'],
    ['admin only', '0x60', { implementation: EMPTY, admin: word(IMPLEMENTATION), beacon: EMPTY }, 'EMPTY_SLOTS'],
    ...['implementation', 'admin', 'beacon'].map(key => [`noncanonical ${key}`, '0x60', { ...slotsFor('beacon'), [key]: noncanonical }, 'NONCANONICAL_SLOT'])
  ]) await t.test(name, async t => {
    const fake = await fakeRpc(t, r => ({ result: r.method === 'eth_getCode' ? code : result(r, 'beacon', CODE, slots) }));
    const snapshot = await captureWithImplementation(options(fake.url));
    assert.deepEqual(snapshot.implementation, { status: 'skipped', reason });
    assert.deepEqual(snapshot.slots, slots);
    assert.equal(fake.calls.length, 8);
    assert.equal(fake.calls.filter(r => r.method === 'eth_getCode').length, 1);
    assert.ok(fake.calls.every(r => r.method !== 'eth_call'));
    assert.equal(validateSnapshot(snapshot), snapshot);
    assert.ok(snapshotReport(snapshot).includes(reason));
  });
});

test('a self-referencing slot gets one code observation without recursive traversal', async t => {
  const fake = await fakeRpc(t, r => ({ result: result(r, 'implementation-slot', CODE, { ...fixture().slots, implementation: word(ADDRESS) }) }));
  const snapshot = await captureWithImplementation(options(fake.url));
  assert.equal(snapshot.implementation.address, ADDRESS);
  assert.equal(fake.calls.length, 9);
  assert.equal(fake.calls.filter(r => r.method === 'eth_getStorageAt').length, 3);
});

test('both bytecode blobs accept exactly 128 KiB and reject one byte over independently', async t => {
  const maximum = `0x${'ab'.repeat(MAX_CODE_BYTES)}`;
  const fake = await fakeRpc(t, r => ({ result: r.method === 'eth_getCode' ? maximum : result(r, 'beacon') }));
  const snapshot = await captureWithImplementation(options(fake.url));
  const dir = await temporaryDirectory(t);
  const path = join(dir, 'maximum.json');
  await saveSnapshot(path, snapshot);
  assert.ok((await stat(path)).size > MAX_SNAPSHOT_BYTES);
  assert.ok((await stat(path)).size < MAX_SNAPSHOT_V2_BYTES);
  assert.deepEqual(await readSnapshot(path), snapshot);
  for (const target of [ADDRESS, IMPLEMENTATION]) {
    const oversized = await fakeRpc(t, r => ({ result: r.method === 'eth_getCode' && r.params[0] === target
      ? `${maximum}ab` : result(r, 'beacon') }));
    const output = await cli(args(oversized.url, join(dir, 'must-not-exist.json')));
    failure(output, 'RPC_DATA');
    assert.equal(oversized.calls.at(-1).method, 'eth_getCode');
    assert.deepEqual(await readdir(dir), ['maximum.json']);
  }
});

test('implementation failures, final reorgs and chain changes do not publish or print partial success', async t => {
  for (const via of ['implementation-slot', 'beacon']) {
    const codeStep = via === 'beacon' ? 8 : 7;
    const remote = { error: { code: -32000, message: 'SENSITIVE_TEST_REMOTE', data: 'https://secret.invalid' } };
    for (const [name, step, code, envelope] of [
      ...[null, 1, {}, '0x0', '0X60', 'SENSITIVE_TEST_CODE', '0xgg'].map(value => ['bad code', codeStep, 'RPC_DATA', { result: value }]),
      ['rejected pinned code', codeStep, 'RPC_REMOTE', remote],
      ['wrong envelope', codeStep, 'RPC_ENVELOPE', { id: 999, result: CODE }],
      ['final reorg', codeStep + 1, 'BLOCK_CHANGED', { result: { number: '0x64', hash: `0x${'ff'.repeat(32)}` } }],
      ['final block missing', codeStep + 1, 'BLOCK_UNAVAILABLE', { result: null }],
      ['chain switched', codeStep + 2, 'CHAIN_MISMATCH', { result: '0x2' }],
      ...(via === 'beacon' ? [['invalid ABI', 7, 'BEACON_RESULT', { result: EMPTY }], ['beacon reverted', 7, 'RPC_REMOTE', remote]] : [])
    ]) await t.test(`${via}: ${name} ${JSON.stringify(envelope)}`, async t => {
      const dir = await temporaryDirectory(t);
      let count = 0;
      const fake = await fakeRpc(t, r => ++count === step ? envelope : { result: result(r, via) });
      failure(await cli(args(fake.url, join(dir, 'SENSITIVE_TEST_PATH.json'))), code);
      assert.equal(fake.calls.length, step); // No retries or fallback after failure.
      assert.deepEqual(await readdir(dir), []);
    });
  }
});

test('extra code HTTP reads enforce whole-request deadlines and declared/streamed body bounds', async t => {
  for (const mode of ['declared overflow', 'streamed overflow', 'no headers', 'slow body', 'exact body']) {
    await t.test(mode, async t => {
      const dir = await temporaryDirectory(t);
      const fake = await fakeRpc(t, (r, response) => {
        if (r.method !== 'eth_getCode' || r.params[0] !== IMPLEMENTATION) return { result: result(r) };
        if (mode === 'no headers') return;
        if (mode === 'slow body') {
          response.writeHead(200);
          const timer = setInterval(() => response.write(' '), 10);
          response.on('close', () => clearInterval(timer));
          return;
        }
        const body = JSON.stringify({ jsonrpc: '2.0', id: r.id, result: CODE }).padEnd(MAX_RESPONSE_BYTES + (mode === 'exact body' ? 0 : 1), ' ');
        response.writeHead(200, mode === 'streamed overflow' ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(body) });
        response.end(body);
      });
      const output = await cli([...args(fake.url, join(dir, 'out.json')), '--timeout-ms', mode.includes('body') && mode !== 'slow body' ? '1000' : '100']);
      if (mode === 'exact body') {
        assert.equal(output.code, 0, output.stderr);
        assert.equal((await readSnapshot(join(dir, 'out.json'))).implementation.code, CODE);
      } else {
        failure(output, mode.includes('overflow') ? 'RPC_SIZE' : 'RPC_TIMEOUT');
        assert.equal(fake.calls.length, 7);
        assert.deepEqual(await readdir(dir), []);
      }
    });
  }
});

test('v2 uses the existing bounded beacon path without relaxing its HTTP or timeout budget', async t => {
  for (const mode of ['declared', 'streamed', 'timeout']) await t.test(mode, async t => {
    const dir = await temporaryDirectory(t);
    const fake = await fakeRpc(t, (r, response) => {
      if (r.method !== 'eth_call') return { result: result(r, 'beacon') };
      if (mode === 'timeout') return;
      response.writeHead(200, mode === 'declared' ? { 'content-length': 4097 } : { 'transfer-encoding': 'chunked' });
      response.end(' '.repeat(4097));
    });
    failure(await cli([...args(fake.url, join(dir, 'out.json')), '--timeout-ms', '100']), mode === 'timeout' ? 'RPC_TIMEOUT' : 'BEACON_SIZE');
    assert.equal(fake.calls.length, 7);
    assert.deepEqual(await readdir(dir), []);
  });
});

test('strict v2 validation checks provenance, status, canonical fields and selection consistency', () => {
  const mutations = [
    s => { delete s.implementation; }, s => { s.schemaVersion = 3; },
    s => { s.implementation.rpcUrl = 'SENSITIVE_TEST_SECRET'; }, s => { s.extra = true; },
    s => { s.implementation.status = 'safe'; }, s => { s.implementation.via = 'unknown'; },
    s => { s.implementation.address = ADDRESS; }, s => { s.implementation.address = IMPLEMENTATION.toUpperCase(); },
    s => { s.implementation.code = '0x'; }, s => { s.implementation.code = '0xGG'; },
    s => { s.implementation.code = `0x${'ab'.repeat(MAX_CODE_BYTES + 1)}`; },
    s => { s.implementation.code = '0xAB'; }, s => { s.code = '0x'; },
    s => { s.slots.implementation = word(ADDRESS); }, s => { s.slots.admin = `0x01${'00'.repeat(31)}`; },
    s => { s.implementation = { status: 'skipped', reason: 'EMPTY_SLOTS' }; }
  ];
  for (const via of ['implementation-slot', 'beacon']) {
    for (const mutate of mutations) {
      const s = v2(via); mutate(s);
      assert.throws(() => validateSnapshot(s), { code: 'SNAPSHOT' });
    }
  }
  for (const mutate of [s => { delete s.implementation.raw; }, s => { s.implementation.raw = EMPTY; },
    s => { s.implementation.raw = word(ADDRESS); }, s => { s.implementation.beacon = ADDRESS; },
    s => { s.implementation.raw = `0x${'AB'.repeat(32)}`; }]) {
    const s = v2('beacon'); mutate(s);
    assert.throws(() => validateSnapshot(s), { code: 'SNAPSHOT' });
  }
  const skipped = { ...v2(), code: '0x', implementation: { status: 'skipped', reason: 'NO_TARGET_CODE' } };
  assert.equal(validateSnapshot(skipped), skipped);
  for (const mutate of [s => { s.implementation.reason = 'EMPTY_SLOTS'; }, s => { s.implementation.address = ADDRESS; },
    s => { s.implementation.status = 'no-code'; }]) {
    const s = structuredClone(skipped); mutate(s);
    assert.throws(() => validateSnapshot(s), { code: 'SNAPSHOT' });
  }
  assert.throws(() => validateSnapshot({ ...fixture(), implementation: v2().implementation }), { code: 'SNAPSHOT' });
});

test('per-version file bounds accept the exact limit, including whitespace, and reject overflow', async t => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, 'bounded.json');
  for (const [snapshot, limit] of [[fixture(), MAX_SNAPSHOT_BYTES], [v2('beacon'), MAX_SNAPSHOT_V2_BYTES]]) {
    const text = JSON.stringify(snapshot);
    await writeFile(path, text.padEnd(limit, ' '));
    assert.deepEqual(await readSnapshot(path), snapshot);
    await writeFile(path, text.padEnd(limit + 1, ' '));
    await assert.rejects(readSnapshot(path), { code: 'FILE_READ' });
  }
});

test('CLI v2 capture and offline inspect preserve private, atomic, no-overwrite behavior', async t => {
  const dir = await temporaryDirectory(t);
  const path = join(dir, 'v2.json');
  const fake = await fakeRpc(t, r => ({ result: result(r, 'beacon') }));
  const ignored = await fakeRpc(t);
  const env = { CONTRACT_WATCH_RPC_URL: `${ignored.url}/SENSITIVE_TEST_ENV` };
  const output = await cli([...args(fake.url, path), '--strict-checksum', '--depth', '0'], env);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.stderr, '');
  assert.doesNotMatch(output.stdout, /SENSITIVE_TEST_|https?:/);
  const original = await readFile(path, 'utf8');
  assert.deepEqual((await readSnapshot(path)).implementation, v2('beacon').implementation);
  assert.doesNotMatch(original, /SENSITIVE_TEST_|https?:/);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const inspected = await cli(['inspect', path], env);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(inspected.stdout, output.stdout.replace('Snapshot saved.\n', ''));
  assert.equal(fake.calls.length, 10);
  assert.equal(ignored.calls.length, 0);
  failure(await cli(args(fake.url, path)), 'FILE_EXISTS');
  const alias = join(dir, 'alias.json');
  await symlink(path, alias);
  await assert.rejects(saveSnapshot(alias, v2()), { code: 'FILE_EXISTS' });
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual((await readdir(dir)).sort(), ['alias.json', 'v2.json']);
  const race = join(dir, 'race.json');
  const results = await Promise.allSettled([saveSnapshot(race, v2()), saveSnapshot(race, v2('beacon'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'FILE_EXISTS');
  validateSnapshot(await readSnapshot(race));
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('new flag rejects invalid options before network or file creation', async t => {
  const fake = await fakeRpc(t);
  const dir = await temporaryDirectory(t);
  const path = join(dir, 'out.json');
  const base = args(fake.url, path);
  for (const command of [[...base, '--implementation-code'], [...base, 'false'], [...base, 'true'],
    [...base, '--implementation-code=true'], [...base, '--resolve-beacon'],
    ['inspect', '--implementation-code', path], ['diff', '--implementation-code', path, path],
    [...base, '--block', 'latest', '--depth', '0']]) failure(await cli(command), 'USAGE');
  for (const [flag, value, code] of [['--block-hash', 'SENSITIVE_TEST_HASH', 'BLOCK_HASH'], ['--depth', '-1', 'DEPTH'],
    ['--timeout-ms', '0', 'TIMEOUT_OPTION']]) failure(await cli([...base, flag, value]), code);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(await readdir(dir), []);
});

test('committed format fixtures read offline; mixed comparisons never invent observations', async t => {
  const dir = await temporaryDirectory(t);
  const paths = [];
  for (const name of ['v1', 'direct-v2', 'beacon-v2', 'no-code-v2', 'skipped-v2']) {
    const snapshot = await readSnapshot(new URL(`./fixtures/implementation/${name}.json`, import.meta.url));
    const path = join(dir, `${name}.json`);
    paths.push(path);
    await saveSnapshot(path, snapshot);
    assert.equal((await cli(['inspect', path])).code, 0);
  }
  for (const [before, after] of [[paths[0], paths[1]], [paths[1], paths[0]]]) {
    for (const flags of [[], ['--json'], ['--exit-code'], ['--json', '--exit-code']]) {
      failure(await cli(['diff', ...flags, before, after]), 'DIFF_VERSION');
    }
  }
  assert.equal(diffDocument(v2(), v2()).changed, false);
  assert.equal(diffDocument(v2(), v2()).schemaVersion, 2);
  const good = v2(); good.implementation.code = 'SENSITIVE_TEST_BAD';
  await writeFile(paths[1], JSON.stringify(good));
  failure(await cli(['inspect', paths[1]]), 'SNAPSHOT');
  failure(await cli(['diff', '--json', paths[1], paths[1]]), 'SNAPSHOT');
});
