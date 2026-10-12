import { setImmediate as turn } from 'node:timers/promises';
import { WatchError, fail, publicError } from './errors.js';
import { OwnedOutputs } from './owned-outputs.js';

export function checkCancellation(signal) {
  if (signal?.aborted) fail('CAPTURE_CANCELLED');
}

// One lifetime for a live CLI invocation, including validation and persistence.
// The first handled signal wins; repeated signals cannot bypass draining/cleanup.
export async function runLive(work, host = process) {
  const controller = new AbortController();
  const signal = controller.signal;
  const outputs = new OwnedOutputs(signal);
  let exitCode, committed = false;
  const interrupt = code => {
    if (!committed && exitCode === undefined) {
      exitCode = code;
      controller.abort();
    }
  };
  const onInt = () => interrupt(130), onTerm = () => interrupt(143);
  host.on('SIGINT', onInt); host.on('SIGTERM', onTerm);
  try {
    // Allow pending signals to be handled before env access or first admission.
    await turn();
    checkCancellation(signal);
    const result = await work({ signal, outputs, check: () => checkCancellation(signal) });
    if (!await outputs.close()) fail('FILE_WRITE');
    await turn();
    checkCancellation(signal);
    // Commit point: no await between this marker and the complete stdout write.
    committed = true;
    host.stdout.write(result.stdout);
    host.exitCode = result.exitCode ?? 0;
  } catch (error) {
    // Closing filesystem handles may itself let an interrupt arrive. Preserve
    // handles until rollback when cancellation is already known.
    if (!signal.aborted) await outputs.close();
    if (signal.aborted) {
      const cleaned = await outputs.rollback();
      host.stderr.write(`${publicError(new WatchError(cleaned ? 'CAPTURE_CANCELLED' : 'CANCEL_CLEANUP'))}\n`);
      host.exitCode = exitCode;
    } else {
      host.stderr.write(`${publicError(error)}\n`);
      host.exitCode = 1;
    }
  } finally {
    host.removeListener('SIGINT', onInt); host.removeListener('SIGTERM', onTerm);
  }
}
