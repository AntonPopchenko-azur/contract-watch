import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const ADDRESS = '0x1111111111111111111111111111111111111111';
export const IMPLEMENTATION = '0x2222222222222222222222222222222222222222';
export const HASH = `0x${'ab'.repeat(32)}`;
export const EMPTY = `0x${'0'.repeat(64)}`;
export const word = value => `0x${'0'.repeat(24)}${value.slice(2)}`;
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = fileURLToPath(new URL('../../bin/contract-watch.js', import.meta.url));

export function protocolResult(request) {
  switch (request.method) {
    case 'eth_chainId': return '0x1';
    case 'eth_getBlockByNumber': return { number: '0x64', hash: HASH };
    case 'eth_getCode': return '0x60006000';
    case 'eth_getStorageAt': return request.params[1] === '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' ? word(IMPLEMENTATION) : EMPTY;
    default: throw new Error('Unexpected RPC method in test');
  }
}

export async function fakeRpc(t, respond = request => ({ result: protocolResult(request) })) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    const envelope = await respond(body, response, request);
    if (envelope !== undefined) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...envelope }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

export async function temporaryDirectory(t) {
  const path = await mkdtemp(join(tmpdir(), 'contract-watch-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

export function fixture() {
  return {
    schemaVersion: 1, source: 'synthetic', capturedAt: '2026-09-30T10:00:00.000Z',
    chainId: '1', address: ADDRESS, block: { number: '0x64', hash: HASH },
    code: '0x60006000', slots: { implementation: word(IMPLEMENTATION), admin: EMPTY, beacon: EMPTY }
  };
}

const execute = promisify(execFile);
export async function cli(args, environment = {}) {
  const env = { ...process.env, CONTRACT_WATCH_RPC_URL: '', ...environment };
  try {
    const result = await execute(process.execPath, [CLI, ...args], { cwd: ROOT, env, timeout: 10000 });
    return { ...result, code: 0 };
  } catch (error) { return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}
