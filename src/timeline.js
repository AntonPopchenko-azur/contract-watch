import { visitCommittedHistory, canonicalHistoryJson } from './history.js';
import { codeDetails, slotDetails, implementationDetails, diffDocument } from './report.js';
import { SLOTS } from './snapshot.js';
import { WatchError, errorDetails } from './errors.js';

const CAVEATS = [
  'Only recorded endpoints are compared; intermediate events and their timing are unknown.',
  'Index order, timestamps and matching hashes do not establish ancestry, upgrades, reorgs, finality or a canonical chain.',
  'Missing or skipped implementation observations are unavailable, not empty code or evidence of unchanged state.',
  'Pending snapshots and staging files are excluded from observations and comparisons.',
  'Observations and code fingerprints are not a safety assessment or independent verification of a provider.'
];
const NOTICE_TEXT = {
  BLOCK_HEIGHT_DECREASED: 'Block height decreased in index order; this adjacent pair is not compared.',
  CAPTURE_TIME_DECREASED: 'Capture time decreased in index order; timestamps are retained without sorting.',
  SAME_HEIGHT_DIFFERENT_HASH: 'The same recorded height has different block hashes.',
  INCONSISTENT_BLOCK_DATA: 'The same recorded block hash has conflicting height, raw slots or recorded code/implementation details.'
};

function conflicting(a, b) {
  return a.block.number !== b.block.number || canonicalHistoryJson(a.code) !== canonicalHistoryJson(b.code) ||
    Object.keys(SLOTS).some(name => a.slots[name].raw !== b.slots[name].raw) ||
    (a.implementation && b.implementation && a.implementation.status !== 'not-recorded' &&
      b.implementation.status !== 'not-recorded' &&
      canonicalHistoryJson(a.implementation) !== canonicalHistoryJson(b.implementation));
}

export async function historyTimeline(directory) {
  const observations = [], transitions = [], notices = [];
  let previous;
  const metadata = await visitCommittedHistory(directory, (value, record) => {
    const current = { ordinal: record.ordinal, observationId: record.observationId,
      capturedAt: value.capturedAt, block: value.block, code: codeDetails(value.code),
      slots: Object.fromEntries(Object.keys(SLOTS).map(name => [name, slotDetails(value.slots[name])])),
      implementation: value.schemaVersion === 1 ? null : implementationDetails(value.implementation) };
    const notice = (code, before) => notices.push({ code, beforeOrdinal: before.ordinal, afterOrdinal: current.ordinal });
    if (previous) {
      const pair = { from: current.ordinal - 1, to: current.ordinal };
      try {
        // Retain the strict version/identity/genesis/provenance policy. In
        // particular GENESIS_UNAVAILABLE is fatal, even for decreasing heights.
        const diff = diffDocument(previous, value);
        transitions.push({ ...pair, status: 'compared', changed: diff.changed,
          changes: diff.changes, implementation: diff.implementation ?? null });
      } catch (error) {
        if (!(error instanceof WatchError) || error.code !== 'ORDER') throw error;
        transitions.push({ ...pair, status: 'unavailable', reason: errorDetails(error) });
        notice('BLOCK_HEIGHT_DECREASED', observations.at(-1));
      }
      if (Date.parse(value.capturedAt) < Date.parse(previous.capturedAt)) notice('CAPTURE_TIME_DECREASED', observations.at(-1));
    }
    // Across the entire retained prefix, report the earliest conflicting peer
    // per category. Summary fingerprints bound memory; adjacent byte comparisons
    // above still use full code. No absence-of-notice consistency claim is made.
    const heightPeer = observations.find(prior => prior.block.number === current.block.number && prior.block.hash !== current.block.hash);
    if (heightPeer) notice('SAME_HEIGHT_DIFFERENT_HASH', heightPeer);
    const hashPeer = observations.find(prior => prior.block.hash === current.block.hash && conflicting(prior, current));
    if (hashPeer) notice('INCONSISTENT_BLOCK_DATA', hashPeer);
    observations.push(current);
    previous = value;
  });
  return { kind: 'contract-watch-history-timeline', schemaVersion: metadata.retention ? 2 : 1, order: 'index',
    ...metadata, observations, transitions, notices, caveats: [...CAVEATS, ...(metadata.retention ? [
      'Retention selected a subset of source observations; excluded observations may contain changes absent from this timeline.'
    ] : [])] };
}

const codeText = value => `${value.bytes} bytes, SHA-256 ${value.sha256}`;
const slotText = value => `${value.raw} (${value.status}${value.address ? `: ${value.address}` : ''})`;
function implementationText(value) {
  if (!value) return 'not recorded by snapshot v1; address and code unavailable';
  if (value.status === 'not-recorded') return 'not-recorded; address and code unavailable';
  if (value.status === 'skipped') return `skipped (${value.reason}); address and code unavailable`;
  return `${value.status} | ${value.address} via ${value.via}${value.via === 'beacon' ? ` ${value.beacon}, raw ${value.raw}` : ''} | ${codeText(value.code)}`;
}

export function timelineReport(document) {
  const { identity, observations, transitions, notices } = document;
  const lines = [
    `Contract Watch history timeline | chain ${identity.chainId} | ${identity.address}`,
    `Source: ${identity.source}${identity.source === 'synthetic' ? ' (demonstration only)' : ''} | snapshot v${identity.snapshotVersion}`,
    `Genesis: ${identity.genesis.status === 'observed' ? identity.genesis.hash : 'not-recorded'}`,
    'Order: index ordinal (publication order; no sorting by height or capture time)',
    `Committed: ${document.committed} | Pending excluded: ${document.pending} | Stages excluded: ${document.staged}`
  ];
  if (document.retention) {
    const r = document.retention;
    lines.push(`Retention: baseline and last ${r.keepLast}; ${r.sourceCommitted - r.ordinals.length} source observations excluded from this copy.`,
      `Source state: ${r.sourceState}`,
      `Original ordinals for retained prefix: ${r.ordinals.join(', ') || '(empty)'}; subsequent observations were added after retention.`);
  }
  if (!observations.length) lines.push('No committed observations.');
  for (const value of observations) {
    lines.push('', `Observation ${value.ordinal} | ${value.capturedAt} | ID ${value.observationId}`,
      `Block: ${BigInt(value.block.number)} (${value.block.hash})`, `Target code: ${codeText(value.code)}`,
      ...Object.keys(SLOTS).map(name => `${name}: ${slotText(value.slots[name])}`),
      `Implementation observation: ${implementationText(value.implementation)}`);
  }
  if (!transitions.length) lines.push('', 'No adjacent pairs to compare.');
  for (const pair of transitions) {
    lines.push('', `Adjacent observations ${pair.from} -> ${pair.to}`);
    if (pair.status === 'unavailable') {
      lines.push(`Comparison unavailable [${pair.reason.code}]: ${pair.reason.message}`);
      continue;
    }
    if (!pair.changes.length) lines.push('No target code/raw slot differences between these endpoints.');
    for (const change of pair.changes) {
      const format = change.field === 'code' ? codeText : slotText;
      lines.push(`Target ${change.field}: ${format(change.before)} -> ${format(change.after)}`);
    }
    if (!pair.implementation) lines.push('Implementation comparison unavailable: snapshot v1 did not record it.');
    else {
      const value = pair.implementation;
      lines.push(`Implementation comparison: ${value.comparison}`);
      if (value.comparison === 'comparable' && !value.changes.length) lines.push('No implementation address/code differences between these endpoints.');
      for (const change of value.changes) {
        const format = change.field === 'code' ? codeText : v => v;
        lines.push(`Implementation ${change.field}: ${format(change.before)} -> ${format(change.after)}`);
      }
    }
  }
  for (const notice of notices) lines.push(`Notice [${notice.code}] ${notice.beforeOrdinal} -> ${notice.afterOrdinal}: ${NOTICE_TEXT[notice.code]}`);
  lines.push('', ...document.caveats.map(value => `Limit: ${value}`));
  return lines.join('\n');
}
