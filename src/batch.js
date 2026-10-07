import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_CONFIG_TARGETS, readConfig, prepareConfiguredCapture, configuredEndpoint } from './config.js';
import { capture, captureWithBeacon, captureWithImplementation, saveSnapshot,
  resolveCaptureAnchor, captureAtAnchor } from './snapshot.js';
import { address, chainId } from './validate.js';
import { errorDetails, fail } from './errors.js';

export async function captureMany({ configPath, names, outputDir, options = {},
  includeBeacon = false, includeImplementation = false, sharedBlock = false }, environment = process.env) {
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_CONFIG_TARGETS ||
      new Set(names).size !== names.length) fail('BATCH_TARGETS');
  if (typeof sharedBlock !== 'boolean' || typeof includeBeacon !== 'boolean' || typeof includeImplementation !== 'boolean' ||
      (includeBeacon && includeImplementation)) fail('USAGE');
  const config = await readConfig(configPath);
  // Finish all selection/checksum/options validation before any env read or output.
  const prepared = names.map(name => prepareConfiguredCapture(config, name, options));
  const groups = new Map();
  if (sharedBlock) for (const [index, selected] of prepared.entries()) {
    const id = chainId(selected.capture.chainId);
    if (!groups.has(id)) groups.set(id, { chainId: id, leaderOrdinal: index + 1 });
  }
  let directory;
  try {
    if (typeof outputDir !== 'string' || !outputDir) fail('BATCH_DIRECTORY');
    directory = resolve(outputDir);
    // Exclusive, nonrecursive creation: one winner, existing files/links refused.
    await mkdir(directory, { mode: 0o700 });
  } catch (error) { fail(error.code === 'EEXIST' ? 'BATCH_EXISTS' : 'BATCH_DIRECTORY'); }

  const outcomes = [];
  for (const [index, selected] of prepared.entries()) {
    const identity = { ordinal: index + 1, address: address(selected.capture.address), chainId: chainId(selected.capture.chainId) };
    const group = groups.get(identity.chainId);
    try {
      // A failed leader is never replaced. Blocked members need no env/RPC access.
      if (group?.status === 'unavailable') fail('SHARED_BLOCK_UNAVAILABLE');
      let input;
      try {
        input = { ...selected.capture, rpcUrl: configuredEndpoint(selected.rpcEnv, environment) };
        if (group && !group.status) {
          group.anchor = await resolveCaptureAnchor(input);
          group.status = 'resolved';
        }
      } catch (error) {
        if (group && !group.status) { group.status = 'unavailable'; group.error = errorDetails(error); }
        throw error;
      }
      // Leader capture reuses the resolved endpoint, never a second env lookup.
      const { snapshot, beaconResolution } = group
        ? await captureAtAnchor(input, group.anchor, { includeBeacon, includeImplementation })
        : includeImplementation
        ? { snapshot: await captureWithImplementation(input) }
        : includeBeacon ? await captureWithBeacon(input) : { snapshot: await capture(input) };
      const file = `target-${String(index + 1).padStart(2, '0')}.json`;
      await saveSnapshot(join(directory, file), snapshot);
      outcomes.push({ ...identity, status: 'saved', file, snapshotVersion: snapshot.schemaVersion,
        block: snapshot.block, ...(beaconResolution ? { beaconResolution } : {}) });
    } catch (error) {
      outcomes.push({ ...identity, status: 'failed', error: errorDetails(error) });
    }
  }
  const saved = outcomes.filter(outcome => outcome.status === 'saved').length;
  return { kind: 'contract-watch-batch', schemaVersion: sharedBlock ? 2 : 1,
    ...(sharedBlock ? { mode: 'shared-block', groups: [...groups.values()].map(group => ({
      chainId: group.chainId, leaderOrdinal: group.leaderOrdinal, status: group.status,
      ...(group.anchor ? { block: group.anchor.block,
        ...(group.anchor.genesis ? { genesis: { status: 'observed', hash: group.anchor.genesis } } : {}) }
        : { error: group.error })
    })) } : {}), selected: prepared.length,
    saved, failed: prepared.length - saved, outcomes };
}
