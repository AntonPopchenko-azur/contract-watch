import http from 'node:http';
import https from 'node:https';
import { WatchError, fail } from './errors.js';
import { rpcUrl, timeout, address, blockHash } from './validate.js';
import { BEACON_SELECTOR, BEACON_GAS, MAX_BEACON_RESPONSE_BYTES, MAX_BEACON_TIMEOUT_MS } from './beacon.js';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_METHODS = new Set([
  'eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt'
]);

export function createRpc(endpoint, timeoutMs = 10000) {
  const url = rpcUrl(endpoint);
  timeout(String(timeoutMs));
  let nextId = 0;

  async function requestRpc(method, params, maxBytes = MAX_RESPONSE_BYTES, requestTimeout = timeoutMs) {
    const sizeCode = method === 'eth_call' ? 'BEACON_SIZE' : 'RPC_SIZE';
    const id = ++nextId;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      let timer;
      let outcome;
      const publish = () => outcome?.error ? reject(outcome.error) : resolve(outcome?.result);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome = { error, result };
        // Do not release a capture/worker while its failed request still owns a
        // transport. The close handler settles both successful and failed reads.
        if (!request || request.closed) publish();
        else if (error) request.destroy();
      };
      const stop = code => finish(new WatchError(code));
      timer = setTimeout(() => stop('RPC_TIMEOUT'), requestTimeout);
      try {
        request = (url.protocol === 'https:' ? https : http).request(url, {
          method: 'POST',
          agent: false,
          maxHeaderSize: 16 * 1024,
          headers: {
            'content-type': 'application/json',
            'accept': 'application/json',
            'accept-encoding': 'identity',
            'content-length': Buffer.byteLength(payload)
          }
        }, response => {
          if (response.statusCode !== 200) { stop('RPC_HTTP'); response.destroy(); return; }
          const encoding = response.headers['content-encoding'];
          if (encoding && encoding !== 'identity') { stop('RPC_ENCODING'); response.destroy(); return; }
          if (Number(response.headers['content-length']) > maxBytes) {
            stop(sizeCode); response.destroy(); return;
          }
          let size = 0;
          const chunks = [];
          response.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) { stop(sizeCode); response.destroy(); return; }
            chunks.push(chunk);
          });
          response.on('aborted', () => stop('RPC_NETWORK'));
          response.on('error', () => stop('RPC_NETWORK'));
          response.on('end', () => {
            if (settled) return;
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!body || typeof body !== 'object' || Array.isArray(body) ||
                  body.jsonrpc !== '2.0' || body.id !== id ||
                  Object.hasOwn(body, 'result') === Object.hasOwn(body, 'error')) {
                stop('RPC_ENVELOPE'); return;
              }
              if (Object.hasOwn(body, 'error')) { stop('RPC_REMOTE'); return; }
              finish(null, body.result);
            } catch { stop('RPC_ENVELOPE'); }
          });
        });
        request.on('error', () => stop('RPC_NETWORK'));
        request.on('close', () => {
          if (!settled) stop('RPC_NETWORK');
          else publish();
        });
        request.end(payload);
      } catch { stop('RPC_NETWORK'); }
    });
  }

  const rpc = async (method, params = []) => {
    if (!READ_METHODS.has(method)) fail('USAGE');
    return requestRpc(method, params);
  };
  // eth_call is not in the generic allowlist. This fixed operation is the only call path.
  rpc.beaconImplementation = async (target, beacon, hash) => requestRpc('eth_call', [
    { from: address(target), to: address(beacon), gas: BEACON_GAS, value: '0x0', input: BEACON_SELECTOR },
    { blockHash: blockHash(hash), requireCanonical: true }
  ], MAX_BEACON_RESPONSE_BYTES, Math.min(timeoutMs, MAX_BEACON_TIMEOUT_MS));
  return rpc;
}
