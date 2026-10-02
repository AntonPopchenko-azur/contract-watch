import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { keccak256 } from '../src/keccak.js';
import { address } from '../src/validate.js';
import { capture } from '../src/snapshot.js';
import { cli, fakeRpc, temporaryDirectory, HASH } from './helpers/fake-rpc.js';

// All eight official cases, including canonical single-case addresses:
// https://eips.ethereum.org/EIPS/eip-55#test-cases
const OFFICIAL = [
  '0x52908400098527886E0F7030069857D2E4169EE7',
  '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
  '0xde709f2102306220921060314715629080e2fb77',
  '0x27b1fdb04752bbc536007a920d24acb045561c26',
  '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'
];
const STRICT = { strictChecksum: true };
const ZERO = `0x${'0'.repeat(40)}`;
const upper = value => `0x${value.slice(2).toUpperCase()}`;
const wrongMixed = OFFICIAL[4].replace('a', 'A');
const errorCode = code => error => error.code === code;
const checksumError = 'Error [ADDRESS_CHECKSUM]: Address must use its exact EIP-55 checksum casing.\n';

test('Keccak-256 matches independent reference results across padding boundaries', async t => {
  // Generated with XKCP's CC0 CompactFIPS202.py, Keccak(1088, 512, input, 0x01, 32).
  // Pinned source blob, read/reviewed and executed separately from this implementation:
  // https://api.github.com/repos/XKCP/XKCP/git/blobs/0b9608fc01852ea94182139890beca21b61b677a
  // The abc result also matches Go's TestKeccak at:
  // https://go.googlesource.com/crypto/+/c757c9851f77c470645455f548046ae0ce87ef8d/sha3/sha3_test.go
  const vectors = [
    [Buffer.alloc(0), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    [Buffer.from('abc'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    // Numeric inputs denote bytes [0, 1, ..., (length-1) % 256].
    [1, 'bc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a'],
    [40, 'da227097c39b25f51ebbb255c17b0ee624bc34f0cea142cd9a811b96d3d41f32'],
    [135, 'cbdfd9dee5faad3818d6b06f95a219fd290b0e1706f6a82e5a595b9ce9faca62'],
    [136, '7ce759f1ab7f9ce437719970c26b0a66ff11fe3e38e17df89cf5d29c7d7f807e'],
    [137, 'ac73d4fae68b8453f764007c1a20ce95994187861f0c3227a3a8e99a73a3b1db'],
    [200, 'bfb0aa97863e797943cf7c33bb7e880bb4543f3d2703c0923c6901c2af57b890'],
    [272, 'fdf2ec49e749960d3c8521a0219af8d03e30e2b3bf19bd16150ee0eaf133d66e'],
    [273, '4f707289a9c3ccd0c4a51f2f17339f5dd171d371c04ff7783b735b5b22682eaf']
  ];
  for (const [input, expected] of vectors) {
    const bytes = typeof input === 'number' ? Uint8Array.from({ length: input }, (_, i) => i % 256) : input;
    await t.test(`${bytes.length} bytes`, () => {
      assert.equal(keccak256(bytes), expected);
      assert.notEqual(keccak256(bytes), createHash('sha3-256').update(bytes).digest('hex'));
    });
  }
});

test('strict validation accepts all official EIP-55 vectors and returns v1 lowercase', async t => {
  for (const value of OFFICIAL) {
    await t.test(value, () => assert.equal(address(value, STRICT), value.toLowerCase()));
  }
  assert.equal(address(ZERO, STRICT), ZERO);
});

test('strict validation rejects every one-letter case flip and incorrect single-case variants', () => {
  for (const value of OFFICIAL) {
    const variants = new Set([value.toLowerCase(), upper(value)]);
    for (let i = 2; i < value.length; i++) {
      if (!/[a-fA-F]/.test(value[i])) continue;
      const flipped = value[i] === value[i].toLowerCase() ? value[i].toUpperCase() : value[i].toLowerCase();
      variants.add(value.slice(0, i) + flipped + value.slice(i + 1));
    }
    variants.delete(value);
    for (const invalid of variants) {
      assert.throws(() => address(invalid, STRICT), errorCode('ADDRESS_CHECKSUM'), invalid);
      assert.equal(address(invalid), value.toLowerCase());
    }
  }
});

test('strict mode keeps syntax validation ahead of checksum and RPC validation', async () => {
  for (const value of [undefined, null, 1, '', 'alice.eth', '0x1234', `0x${'g'.repeat(40)}`,
    OFFICIAL[0].slice(2), OFFICIAL[0].replace('0x', '0X'), `${ZERO}0`,
    ` ${ZERO}`, `${ZERO}\n`, ZERO.replace('0', '０')]) {
    assert.throws(() => address(value, STRICT), errorCode('ADDRESS'));
    assert.throws(() => address(value), errorCode('ADDRESS'));
  }
  await assert.rejects(capture({ address: wrongMixed, strictChecksum: true, rpcUrl: 'invalid', chainId: '1' }),
    errorCode('ADDRESS_CHECKSUM'));
});

test('CLI strict capture accepts official cases, normalizes RPC/files and keeps offline formats compatible', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t);
  for (const [index, value] of [...OFFICIAL, ZERO].entries()) {
    const path = join(dir, `${index}.json`);
    const args = ['snapshot', '--address', value, '--chain-id', '0x1', '--block', 'finalized',
      '--timeout-ms', '1000', '--out', path];
    // Beginning, middle and end of options, with both RPC selection mechanisms.
    args.splice([1, 3, args.length][index % 3], 0, '--strict-checksum');
    if (index % 2 === 0) args.push('--rpc', `${fake.url}/TEST_KEY`);
    const result = await cli(args, { CONTRACT_WATCH_RPC_URL: `${fake.url}/TEST_KEY` });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const saved = await readFile(path, 'utf8');
    assert.doesNotMatch(saved + result.stdout, /TEST_KEY|http:/);
    assert.equal(JSON.parse(saved).address, value.toLowerCase());
    assert.equal(JSON.parse(saved).schemaVersion, 1);
    assert.equal(fake.calls.length, (index + 1) * 8);
    assert.deepEqual(fake.calls.at(-7).params, ['finalized', false]);
    for (const call of fake.calls.slice(-6, -2)) {
      assert.equal(call.params[0], value.toLowerCase());
      assert.deepEqual(call.params.at(-1), { blockHash: HASH, requireCanonical: true });
    }
  }
  // A mixed-case checksum has been stored lowercase, as required by snapshot v1.
  const path = join(dir, '4.json');
  const original = await readFile(path, 'utf8');
  const calls = fake.calls.length;
  const env = { CONTRACT_WATCH_RPC_URL: fake.url };
  const inspect = await cli(['inspect', path], env);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.match(inspect.stdout, new RegExp(OFFICIAL[4].toLowerCase()));
  const diff = await cli(['diff', '--json', path, '--exit-code', path], env);
  assert.equal(diff.code, 0, diff.stderr);
  assert.equal(JSON.parse(diff.stdout).schemaVersion, 1);
  assert.equal(JSON.parse(diff.stdout).changed, false);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.equal(fake.calls.length, calls);
});

test('CLI without strict flag still accepts incorrect EIP-55 casing', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t);
  for (const [index, value] of [OFFICIAL[0].toLowerCase(), upper(OFFICIAL[2]), wrongMixed].entries()) {
    const path = join(dir, `${index}.json`);
    const result = await cli(['snapshot', '--address', value, '--chain-id', '1', '--out', path, '--rpc', fake.url]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).address, value.toLowerCase());
  }
});

test('CLI checksum, syntax and flag failures produce safe errors without RPC or any files', async t => {
  const dir = await temporaryDirectory(t);
  const fake = await fakeRpc(t);
  const base = value => ['snapshot', '--address', value, '--chain-id', '1',
    '--out', join(dir, 'TEST_PATH.json'), '--rpc', `${fake.url}/TEST_KEY`];
  const cases = [
    ...[OFFICIAL[0].toLowerCase(), upper(OFFICIAL[2]), OFFICIAL[4].toLowerCase(), upper(OFFICIAL[4]), wrongMixed]
      .map(value => [[...base(value), '--strict-checksum'], 'ADDRESS_CHECKSUM']),
    ...['SENSITIVE_ADDRESS', `${ZERO}\n`, `0x${'z'.repeat(40)}`, '0x1234', ZERO.replace('0x', '0X')]
      .map(value => [[...base(value), '--strict-checksum'], 'ADDRESS']),
    ...[
      ['--strict-checksum', '--strict-checksum'], ['--strict-checksum=true'],
      ['--strict-checksum', 'true'], ['--strict-checksum', 'false'],
      ['--strict-checksum', '--unknown'], ['--strict-checksum', '--address', ZERO],
      ['--strict-checksum', '--block'], ['--block', '--strict-checksum']
    ].map(flags => [[...base(ZERO), ...flags], 'USAGE']),
    [['inspect', '--strict-checksum', 'TEST_PATH'], 'USAGE'],
    [['diff', '--json', '--exit-code', 'TEST_PATH', 'TEST_PATH', '--strict-checksum'], 'USAGE']
  ];
  for (const [args, code] of cases) {
    const result = await cli(args, { CONTRACT_WATCH_RPC_URL: `${fake.url}/TEST_KEY` });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.startsWith(`Error [${code}]: `), result.stderr);
    if (code === 'ADDRESS_CHECKSUM') assert.equal(result.stderr, checksumError);
    assert.doesNotMatch(result.stderr, /0x[0-9a-fA-F]{40}|SENSITIVE_ADDRESS|TEST_PATH|TEST_KEY|http:|at .*\.js/);
    assert.equal(fake.calls.length, 0);
    assert.deepEqual(await readdir(dir), []);
  }
});
