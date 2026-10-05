import { resolve } from 'node:path';
import { readSnapshot, saveSnapshot, validateSnapshot } from './snapshot.js';
import { fail } from './errors.js';

function targetVersion(value) {
  // Explicit negotiation only: no latest alias, coercion, downgrade or v1-to-v2 fabrication.
  if (value !== '3') fail('MIGRATION_VERSION');
}

export function migrateSnapshot(snapshot, version) {
  targetVersion(version);
  validateSnapshot(snapshot);
  if (snapshot.schemaVersion === 3) fail('MIGRATION_CURRENT');
  const migrated = {
    ...structuredClone(snapshot), schemaVersion: 3,
    implementation: snapshot.schemaVersion === 1
      ? { status: 'not-recorded' } : structuredClone(snapshot.implementation),
    migration: { fromVersion: snapshot.schemaVersion }
  };
  return validateSnapshot(migrated);
}

export async function migrateFile({ input, output, toVersion }) {
  targetVersion(toVersion);
  if (typeof input !== 'string' || !input || typeof output !== 'string' || !output) fail('USAGE');
  if (resolve(input) === resolve(output)) fail('MIGRATION_PATH');
  const migrated = migrateSnapshot(await readSnapshot(input), toVersion);
  // The original is the backup. Atomic hard-link publication refuses all existing
  // destinations, including symlinks/hardlinks to the original and concurrent writers.
  await saveSnapshot(output, migrated);
  return migrated;
}
