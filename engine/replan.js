// Pure, dependency-free. No DOM, no fetch. Everything here is unit-testable.
//
// Real plans move. Headcount changes, someone cancels, a vendor calls.
// Most tools answer by showing you a new state. This answers with the delta,
// which is the thing a person actually needs: what just broke, and what did not.

export const CHECKS = {
  quantity: 'total quantity',
  coverage: 'dietary coverage',
  unclaimed: 'jobs with an owner',
  timing: 'timing and safe holding',
  budget: 'budget'
};

// Two findings are the same finding when they are the same complaint about the
// same thing, even if the numbers behind them have moved. "Nobody is bringing
// fuel" and "nobody is bringing fuel or plates" are one complaint that grew, not
// one cleared and one raised.
export const findingKey = f =>
  [f.check, f.group || f.vendor || ''].join(':');

// How bad, in whatever unit this check counts in. Null where it does not count.
function magnitude(f) {
  if (f.needed !== undefined && f.supplied !== undefined) return f.needed - f.supplied;
  if (f.over !== undefined) return f.over;
  // an unclaimed complaint is as big as everything it leaves unowned, pooled and per-vendor
  if (f.resources) return f.resources.length + (f.perVendor ? f.perVendor.length : 0);
  if (f.hours !== undefined) return f.hours;
  if (f.minutes !== undefined) return -f.minutes;   // less time is worse
  return null;
}

export function diffFindings(before = [], after = []) {
  const b = new Map(before.map(f => [findingKey(f), f]));
  const a = new Map(after.map(f => [findingKey(f), f]));

  const broke = [...a.values()].filter(f => !b.has(findingKey(f)));
  const cleared = [...b.values()].filter(f => !a.has(findingKey(f)));

  const persisting = [];
  for (const [k, af] of a) {
    if (!b.has(k)) continue;
    const bf = b.get(k);
    const m0 = magnitude(bf), m1 = magnitude(af);
    const by = m0 === null || m1 === null ? null : m1 - m0;
    persisting.push({ finding: af, was: bf, by, worse: by !== null && by > 0, better: by !== null && by < 0 });
  }

  const touched = new Set([...b.keys(), ...a.keys()].map(k => k.split(':')[0]));
  const stillFine = Object.keys(CHECKS).filter(c => !touched.has(c));

  return { broke, cleared, persisting, stillFine };
}

// One spoken sentence per line. Every finding must be legible read aloud.
export function summarizeDelta(delta) {
  const lines = [];
  if (delta.change) lines.push(delta.change);
  if (delta.cost) lines.push(delta.cost);
  if (delta.stillFine.length) {
    lines.push(`Still fine: ${delta.stillFine.map(c => CHECKS[c]).join(', ')}.`);
  }
  const worse = delta.persisting.filter(p => p.worse);
  if (delta.broke.length || worse.length) {
    lines.push('Now broken: ' + [
      ...delta.broke.map(f => f.message),
      ...worse.map(p => `${p.finding.message} (worse by ${Math.abs(p.by)})`)
    ].join(' '));
  }
  if (delta.cleared.length) lines.push('Cleared: ' + delta.cleared.map(f => f.message).join(' '));
  const better = delta.persisting.filter(p => p.better);
  if (better.length) {
    lines.push('Improved, still open: ' +
      better.map(p => `${p.finding.message} (down ${Math.abs(p.by)} from before)`).join(' '));
  }
  if (!delta.broke.length && !worse.length && !delta.cleared.length && !better.length) {
    lines.push('Nothing broke. Everything that was true before is still true.');
  }
  return lines;
}
