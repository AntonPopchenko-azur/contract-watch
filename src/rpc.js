import http from 'node:http';
import https from 'node:https';
import { WatchError, fail } from './errors.js';
import { rpcUrl, timeout } from './validate.js';

export const MAX_RESPONSE_BYTES = 1024 * 1024;
const READ_METHODS = new Set([
  'eth_chainId', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getCode', 'eth_getStorageAt'
]);

export function createRpc(endpoint, timeoutMs = 10000) {
  const url = rpcUrl(endpoint);
  timeout(String(timeoutMs));
  let nextId = 0;

  return async function rpc(method, params = []) {
    if (!READ_METHODS.has(method)) fail('USAGE');
    const id = ++nextId;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      let settled = false;
      let request;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          request?.destroy();
        } else resolve(result);
      };
      const stop = code => finish(new WatchError(code));
      timer = setTimeout(() => stop('RPC_TIMEOUT'), timeoutMs);
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
          if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES) {
            stop('RPC_SIZE'); response.destroy(); return;
          }
          let size = 0;
          const chunks = [];
          response.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) { stop('RPC_SIZE'); response.destroy(); return; }
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
        request.end(payload);
      } catch { stop('RPC_NETWORK'); }
    });
  };
}
