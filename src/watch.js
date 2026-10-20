import { join, resolve } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { OwnedOutputs } from './owned-outputs.js';
import { checkCancellation } from './cancellation.js';
import { watchLimits, watchLoop, MAX_WATCH_ATTEMPTS } from './watch-policy.js';
import { configuredCapture } from './config.js';
import { captureInput, timeout, rpcUrl } from './validate.js';
import { capture, captureWithBeacon, captureWithImplementation, saveSnapshot } from './snapshot.js';
import { startCapture, capturePolicy } from './capture-policy.js';
import { fail, errorDetails, publicError, WatchError } from './errors.js';

// Only the current observation is owned. The session directory is retained,
// including when empty, and is used solely as a verified publication boundary.
export class WatchOutput extends OwnedOutputs {
  constructor(clock, directory) {
    super(clock.signal);
    this.clock = clock;
    this.directories = [directory];
  }
  check() { this.clock.check(); }
  async commit() {
    if (this.uncertain || this.files.some(file => file.path.endsWith('.tmp') && !file.removed)) fail('WATCH_CLEANUP');
    const final = this.files.find(file => !file.path.endsWith('.tmp'));
    if (!final) fail('FILE_WRITE');
    await this.verify(final.parent);
    const identity = await this.verify(final);
    if (identity.size !== final.identity.size || identity.mtimeNs !== final.identity.mtimeNs) fail('FILE_WRITE');
    if (!await this.close()) fail('WATCH_CLEANUP');
    await turn();
    this.check();
    // Per-observation commit point: no await before forgetting rollback rights.
    this.files = [];
  }
  async rollback() {
    const directories = this.directories;
    this.directories = [];
    try { return await super.rollback(); }
    finally { this.directories = directories; }
  }
}

export async function watchSession(settings, environment, signal, runtime = {}) {
  // Validate finite limits before config, env or any output access.
  const limits = watchLimits(settings);
  const { configPath, name, outputDir, options = {}, includeBeacon = false, includeImplementation = false } = settings;
  if (typeof includeBeacon !== 'boolean' || typeof includeImplementation !== 'boolean' ||
      (includeBeacon && includeImplementation)) fail('USAGE');
  const check = () => checkCancellation(signal);
  check();
  if (!configPath) captureInput(options);
  timeout(String(options.timeoutMs ?? 10000));
  const input = configPath
    ? await configuredCapture(configPath, name, options, environment, check)
    : { ...options, rpcUrl: options.rpcUrl ?? environment.CONTRACT_WATCH_RPC_URL };
  check();
  rpcUrl(input.rpcUrl);
  if (typeof outputDir !== 'string' || !outputDir) fail('WATCH_DIRECTORY');
  const directoryOwner = new OwnedOutputs(signal);
  let directory;
  try { directory = await directoryOwner.mkdir(resolve(outputDir)); }
  catch (error) {
    check();
    fail(error.code === 'BATCH_EXISTS' ? 'WATCH_EXISTS' : 'WATCH_DIRECTORY');
  }
  const entry = directoryOwner.directories[0];
  const identity = captureInput(input);
  const { stopReason, outcomes } = await watchLoop(limits, async (ordinal, clock) => {
    const outputs = new WatchOutput(clock, entry);
    try {
      clock.check();
      await outputs.verify(entry.parent);
      await outputs.verify(entry);
      clock.check();
      const captureOptions = startCapture(input, { ...runtime, signal: clock.signal, check: clock.check });
      const { snapshot, beaconResolution } = includeImplementation
        ? { snapshot: await captureWithImplementation(captureOptions) }
        : includeBeacon ? await captureWithBeacon(captureOptions) : { snapshot: await capture(captureOptions) };
      capturePolicy(captureOptions).check();
      const file = `observation-${String(ordinal).padStart(3, '0')}.json`;
      await saveSnapshot(join(directory, file), snapshot, outputs);
      await outputs.commit();
      return { ordinal, status: 'saved', file, snapshotVersion: snapshot.schemaVersion, block: snapshot.block,
        ...(beaconResolution ? { beaconResolution } : {}) };
    } catch (error) {
      if (!await outputs.rollback()) fail('WATCH_CLEANUP');
      if (error.code === 'WATCH_CLEANUP') throw error;
      clock.check();
      return { ordinal, status: 'failed', error: errorDetails(error) };
    }
  }, { ...runtime, signal });
  const saved = outcomes.filter(outcome => outcome.status === 'saved').length;
  const failed = outcomes.filter(outcome => outcome.status === 'failed').length;
  return { kind: 'contract-watch-session', schemaVersion: 1, address: identity.target, chainId: identity.expected,
    limits: { ...limits, maxAttempts: MAX_WATCH_ATTEMPTS }, stopReason,
    attempted: outcomes.length, saved, failed, stopped: outcomes.length - saved - failed, outcomes };
}

export async function runWatch(settings, environment = process.env, host = process, runtime = {}) {
  const controller = new AbortController();
  let exitCode, complete = false;
  const interrupt = code => {
    if (!complete && exitCode === undefined) { exitCode = code; controller.abort(); }
  };
  const onInt = () => interrupt(130), onTerm = () => interrupt(143);
  host.on('SIGINT', onInt); host.on('SIGTERM', onTerm);
  try {
    await turn();
    checkCancellation(controller.signal);
    const report = await watchSession(settings, environment, controller.signal, runtime);
    const stdout = `${JSON.stringify(report, null, 2)}\n`;
    await turn();
    checkCancellation(controller.signal);
    complete = true;
    host.stdout.write(stdout);
    host.exitCode = !report.saved || report.failed || report.stopped ? 1 : 0;
  } catch (error) {
    const code = controller.signal.aborted
      ? error.code === 'WATCH_CLEANUP' ? 'WATCH_CLEANUP' : 'WATCH_CANCELLED' : undefined;
    host.stderr.write(`${publicError(code ? new WatchError(code) : error)}\n`);
    host.exitCode = exitCode ?? 1;
  } finally {
    host.removeListener('SIGINT', onInt); host.removeListener('SIGTERM', onTerm);
  }
}
