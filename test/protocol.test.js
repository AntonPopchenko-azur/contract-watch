import test from 'node:test';
import assert from 'node:assert/strict';
import { capture, SLOTS } from '../src/snapshot.js';
import { createRpc, MAX_RESPONSE_BYTES } from '../src/rpc.js';
import { address, chainId, blockTag, rpcUrl, timeout, MAX_CODE_BYTES } from '../src/validate.js';
import { publicError } from '../src/errors.js';
import { fakeRpc, ADDRESS, IMPLEMENTATION, HASH, EMPTY, word, protocolResult } from './helpers/fake-rpc.js';

const options = url => ({ rpcUrl: url, address: ADDRESS, chainId: '1' });
const errorCode = code => error => error.code === code;

test('validates address syntax, exact integers, endpoint, block and timeout before networking', async () => {
  assert.equal(address(`0x${'AB'.repeat(20)}`), `0x${'ab'.repeat(20)}`);
  assert.equal(chainId('0x20000000000001'), '9007199254740993');
  assert.equal(chainId(((1n << 256n) - 1n).toString()), ((1n << 256n) - 1n).toString());
  assert.equal(blockTag('100'), '0x64');
  assert.equal(blockTag('0x00'), '0x0');
  for (const value of ['0x1234', 'alice.eth', `${ADDRESS}\n`, `0x${'z'.repeat(40)}`, null]) {
    assert.throws(() => address(value), errorCode('ADDRESS'));
  }
  for (const value of ['0', '-1', '1.1', '01', '1e3', '', '0x', (1n << 256n).toString(), 1]) {
    assert.throws(() => chainId(value), errorCode('CHAIN_ID'));
  }
  for (const value of ['pending', 'earliest', '-1', '1.5']) assert.throws(() => blockTag(value), errorCode('BLOCK'));
  for (const value of ['file:///tmp/x', 'http://user:secret@localhost', 'https://host/#x', 'https://host/#', 'not a URL']) {
    assert.throws(() => rpcUrl(value), errorCode('RPC_URL'));
  }
  for (const value of ['99', '60001', '1e3']) assert.throws(() => timeout(value), errorCode('TIMEOUT_OPTION'));
  await assert.rejects(capture({ ...options('bad-url'), address: 'bad' }), errorCode('ADDRESS'));
});

test('pins every state read to one block hash, uses exact EIP-1967 positions, and checks chain again', async t => {
  const fake = await fakeRpc(t);
  const snapshot = await capture({ ...options(fake.url), address: `0x${'AA'.repeat(20)}`, chainId: '0x1' });
  assert.equal(snapshot.address, `0x${'aa'.repeat(20)}`);
  assert.equal(snapshot.chainId, '1');
  assert.equal(snapshot.source, 'rpc');
  assert.equal(snapshot.slots.implementation, word(IMPLEMENTATION));
  assert.equal(snapshot.slots.admin, EMPTY);
  assert.equal(snapshot.slots.beacon, EMPTY);
  assert.equal(new Date(snapshot.capturedAt).toISOString(), snapshot.capturedAt);
  assert.deepEqual(fake.calls.map(call => call.method), [
    'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode',
    'eth_getStorageAt', 'eth_getStorageAt', 'eth_getStorageAt',
    'eth_getBlockByNumber', 'eth_chainId'
  ]);
  assert.deepEqual(fake.calls[1].params, ['latest', false]);
  assert.deepEqual(fake.calls[6].params, ['0x64', false]);
  for (const call of fake.calls.slice(2, 6)) {
    assert.deepEqual(call.params.at(-1), { blockHash: HASH, requireCanonical: true });
  }
  assert.deepEqual(fake.calls.slice(3, 6).map(call => call.params[1]), [
    '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
    '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
    '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50'
  ]);
  assert.equal(new Set(fake.calls.map(call => call.id)).size, 8);
});

test('supports explicit historical block and safe/finalized tags', async t => {
  for (const [input, expected] of [['100', '0x64'], ['0x64', '0x64'], ['safe', 'safe'], ['finalized', 'finalized']]) {
    await t.test(input, async t => {
      const fake = await fakeRpc(t);
      await capture({ ...options(fake.url), block: input });
      assert.equal(fake.calls[1].params[0], expected);
    });
  }
});

test('rejects wrong chain before contract reads and detects a late chain switch', async t => {
  for (const late of [false, true]) {
    await t.test(late ? 'late switch' : 'wrong chain', async t => {
      let chains = 0;
      const fake = await fakeRpc(t, request => ({ result: request.method === 'eth_chainId'
        ? (++chains === 1 && late ? '0x1' : '0x2') : protocolResult(request) }));
      await assert.rejects(capture(options(fake.url)), errorCode('CHAIN_MISMATCH'));
      assert.equal(fake.calls.length, late ? 8 : 1);
    });
  }
});

test('detects a reorg and rejects a missing or wrongly numbered block', async t => {
  for (const [name, result, code, block] of [
    ['missing', null, 'BLOCK_UNAVAILABLE', 'latest'],
    ['wrong number', { number: '0x65', hash: HASH }, 'RPC_DATA', '100'],
    ['pending-shaped', { number: null, hash: null }, 'RPC_DATA', 'latest']
  ]) {
    await t.test(name, async t => {
      const fake = await fakeRpc(t, request => ({ result: request.method === 'eth_getBlockByNumber' ? result : protocolResult(request) }));
      await assert.rejects(capture({ ...options(fake.url), block }), errorCode(code));
    });
  }
  await t.test('late reorg', async t => {
    let blocks = 0;
    const fake = await fakeRpc(t, request => ({ result: request.method === 'eth_getBlockByNumber' && ++blocks === 2
      ? { number: '0x64', hash: `0x${'cd'.repeat(32)}` } : protocolResult(request) }));
    await assert.rejects(capture(options(fake.url)), errorCode('BLOCK_CHANGED'));
  });
});

test('empty account, all-zero slots, and noncanonical high bytes are preserved without false decoding', async t => {
  const unusual = `0x01${'0'.repeat(62)}`;
  const fake = await fakeRpc(t, request => ({ result: request.method === 'eth_getCode' ? '0x'
    : request.method === 'eth_getStorageAt' ? (request.params[1] === SLOTS.admin ? unusual : EMPTY)
      : protocolResult(request) }));
  const snapshot = await capture(options(fake.url));
  assert.equal(snapshot.code, '0x');
  assert.equal(snapshot.slots.admin, unusual);
  assert.equal(snapshot.slots.implementation, EMPTY);
});

test('rejects malformed RPC quantities, storage words, code and block hashes', async t => {
  for (const [method, bad] of [
    ['eth_chainId', '0x01'], ['eth_chainId', 1], ['eth_chainId', '0xzz'],
    ['eth_getCode', '0x0'], ['eth_getCode', '0xgg'], ['eth_getCode', `0x${'ff'.repeat(MAX_CODE_BYTES + 1)}`],
    ['eth_getStorageAt', '0x0'], ['eth_getStorageAt', `0x${'0'.repeat(62)}`],
    ['eth_getBlockByNumber', { number: '0x64', hash: '0xab' }]
  ]) {
    await t.test(`${method} invalid data`, async t => {
      const fake = await fakeRpc(t, request => ({ result: request.method === method ? bad : protocolResult(request) }));
      await assert.rejects(capture(options(fake.url)), errorCode('RPC_DATA'));
    });
  }
});

test('strict JSON-RPC envelopes and remote errors never expose provider content', async t => {
  const secret = 'secret-api-key-with-remote-stack';
  for (const [envelope, code] of [
    [{ id: 99, result: '0x1' }, 'RPC_ENVELOPE'],
    [{ jsonrpc: '1.0', result: '0x1' }, 'RPC_ENVELOPE'],
    [{}, 'RPC_ENVELOPE'],
    [{ result: '0x1', error: { message: secret } }, 'RPC_ENVELOPE'],
    [{ error: { code: -32602, message: secret, data: secret } }, 'RPC_REMOTE']
  ]) {
    await t.test(code, async t => {
      const fake = await fakeRpc(t, () => envelope);
      await assert.rejects(createRpc(`${fake.url}/${secret}`)('eth_chainId'), error => {
        assert.equal(error.code, code);
        assert.ok(!publicError(error).includes(secret));
        return true;
      });
    });
  }
  await t.test('invalid JSON', async t => {
    const fake = await fakeRpc(t, (_request, response) => { response.end(secret); });
    await assert.rejects(createRpc(fake.url)('eth_chainId'), errorCode('RPC_ENVELOPE'));
  });
});

test('does not fall back to latest or block number when EIP-1898 is unsupported', async t => {
  const fake = await fakeRpc(t, request => request.method === 'eth_getCode'
    ? { error: { code: -32602, message: 'blockHash unsupported' } }
    : { result: protocolResult(request) });
  await assert.rejects(capture(options(fake.url)), errorCode('RPC_REMOTE'));
  assert.equal(fake.calls.length, 3);
});

test('refuses transaction methods without a network call', async t => {
  const fake = await fakeRpc(t);
  await assert.rejects(createRpc(fake.url)('eth_sendTransaction', []), errorCode('USAGE'));
  assert.equal(fake.calls.length, 0);
});

test('HTTP failures, redirects and compressed content are rejected', async t => {
  for (const [status, headers, code] of [
    [401, {}, 'RPC_HTTP'], [500, {}, 'RPC_HTTP'],
    [302, { location: 'http://127.0.0.1:1/secret' }, 'RPC_HTTP'],
    [200, { 'content-encoding': 'gzip' }, 'RPC_ENCODING']
  ]) {
    await t.test(String(status), async t => {
      const fake = await fakeRpc(t, (_request, response) => { response.writeHead(status, headers); response.end('secret'); });
      await assert.rejects(createRpc(fake.url)('eth_chainId'), errorCode(code));
      assert.equal(fake.calls.length, 1);
    });
  }
});

test('enforces response limits on declared and streamed bodies', async t => {
  for (const declared of [true, false]) {
    await t.test(declared ? 'content length' : 'chunked', async t => {
      const fake = await fakeRpc(t, (_request, response) => {
        if (declared) response.writeHead(200, { 'content-length': MAX_RESPONSE_BYTES + 1 });
        else response.writeHead(200, { 'transfer-encoding': 'chunked' });
        response.write('x'.repeat(MAX_RESPONSE_BYTES + 1));
        response.end();
      });
      await assert.rejects(createRpc(fake.url)('eth_chainId'), errorCode('RPC_SIZE'));
    });
  }
});

test('wall-clock timeout covers missing headers and a never-ending response body', async t => {
  for (const stream of [false, true]) {
    await t.test(stream ? 'slow body' : 'no headers', async t => {
      const fake = await fakeRpc(t, (_request, response) => {
        if (stream) {
          response.writeHead(200);
          const timer = setInterval(() => response.write(' '), 10);
          response.on('close', () => clearInterval(timer));
        }
      });
      const started = Date.now();
      await assert.rejects(createRpc(fake.url, 100)('eth_chainId'), errorCode('RPC_TIMEOUT'));
      assert.ok(Date.now() - started < 2000);
    });
  }
});

test('abruptly closed responses yield a sanitized connection error', async t => {
  const fake = await fakeRpc(t, (_request, response) => { response.destroy(); });
  await assert.rejects(createRpc(fake.url)('eth_chainId'), errorCode('RPC_NETWORK'));
});
