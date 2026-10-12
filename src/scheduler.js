import { checkCancellation } from './cancellation.js';
import { WatchError } from './errors.js';

// A bounded ready queue: dependencies consume no worker, promise or RPC slot.
// Work can wake the queue when a dependency becomes ready, before it completes.
export function runReady(count, limit, ready, work, signal) {
  return new Promise((resolve, reject) => {
    const pending = Array.from({ length: count }, (_, index) => index);
    let active = 0, failure;
    const done = () => { active--; pump(); };
    const stop = () => { failure ??= new WatchError('INTERNAL'); };
    const cancel = () => { failure = new WatchError('CAPTURE_CANCELLED'); pump(); };
    signal?.addEventListener('abort', cancel, { once: true });
    function pump() {
      if (signal?.aborted) failure = new WatchError('CAPTURE_CANCELLED');
      if (!failure) try {
        while (active < limit && pending.length) {
          const next = pending.findIndex(ready);
          if (next === -1) break;
          const [index] = pending.splice(next, 1);
          active++;
          Promise.resolve().then(() => { checkCancellation(signal); return work(index, pump); }).then(done, () => { stop(); done(); });
        }
      } catch { stop(); }
      // Unexpected scheduler/work errors stop queued dispatch and drain started
      // work. Ordinary per-target failures are handled by the batch itself.
      if (active === 0) {
        signal?.removeEventListener('abort', cancel);
        if (failure || pending.length) reject(failure ?? new WatchError('INTERNAL'));
        else resolve();
      }
    }
    pump();
  });
}
