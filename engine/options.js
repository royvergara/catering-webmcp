// Pure, dependency-free. No DOM, no fetch. Everything here is unit-testable.
//
// Every resolution trades money against effort against risk. The agent gathers and
// reasons; the person decides. So the job here is not to pick — it is to make the
// difference between two orders legible enough that picking is possible.

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export const count = n => (n >= 0 && n < WORDS.length ? WORDS[n] : String(n));
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
const label = s => String(s).replace(/_/g, ' ');

// What this option is good at. An option with no virtue is not worth showing.
export function virtues(o, all = [o]) {
  const out = [];
  const cheapest = Math.min(...all.map(x => x.subtotal));
  const fewest = Math.min(...all.map(x => x.vendorCount));
  if (!o.uncovered.length) out.push('covers everyone');
  // the head already says how many vendors; don't say it twice
  if (o.vendorCount === fewest && all.length > 1) out.push(o.vendorCount === 1 ? 'simplest' : 'fewest vendors');
  if (o.subtotal === cheapest) out.push('cheapest');
  if (!o.overBudget && all.some(x => x.overBudget)) out.push('within budget');
  return out;
}

// What it costs you, stated in the units you will feel it in. A burden every option
// carries equally is not a tradeoff between them, so it is left out of the comparison.
export function costs(o, all = [o]) {
  const shared = f => all.length > 1 && all.every(x => f(x) === f(o));
  const out = [];
  for (const u of o.uncovered) {
    out.push(`leaves ${plural(u.short, `${label(u.group)} guest`)} uncovered`);
  }
  if (o.shortOz > 0) out.push(`${o.shortOz} oz short of the volume target`);
  if (o.overBudget > 0) out.push(`$${o.overBudget} over your budget`);
  if (o.collections > 1 && !shared(x => x.collections)) {
    out.push(`${plural(o.collections, 'collection')} to make`);
  }
  if (o.blockers && !shared(x => x.blockers)) {
    out.push(`${plural(o.blockers, 'blocker')} to resolve`);
  }
  return out;
}

export function describeOption(o, all = [o]) {
  const v = virtues(o, all);
  const c = costs(o, all);
  const head = `${plural(o.vendorCount, 'vendor')}, $${o.subtotal}`;
  const summary = [head, v[0], c[0] && `but ${c[0]}`].filter(Boolean).join(', ');
  return { ...o, virtues: v, costs: c, summary };
}

// Deterministic and explainable, in this order: cover the people, then clear the
// blockers, then keep it simple, then keep it cheap. Never anything a vendor said.
export function rankOptions(options) {
  const shortfall = o => o.uncovered.reduce((n, u) => n + u.short, 0);
  return [...options].sort((a, b) =>
    shortfall(a) - shortfall(b) ||
    a.blockers - b.blockers ||
    a.vendorCount - b.vendorCount ||
    a.subtotal - b.subtotal ||
    a.id.localeCompare(b.id));
}

// Two options that order the same things are one option.
export const signature = o => [...o.itemIds].sort().join('|');

// Keep options that differ in what they cost you, not merely in how they were built.
export function distinct(options) {
  const seen = new Set();
  return options.filter(o => {
    const k = signature(o);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// A split has to be justified out loud, by one of the six reasons that can justify it:
// coverage, minimums, budget, availability, capacity, or category. If none of them
// fires against the best single-vendor alternative, one vendor should have won.
export const SPLIT_REASONS = ['coverage', 'minimums', 'budget', 'availability', 'capacity', 'category'];

export function justifySplit(chosen, all = []) {
  if (chosen.vendorCount <= 1) return null;
  const singles = all.filter(o => o.vendorCount === 1);
  if (!singles.length) {
    return { reason: 'category', says: 'no single vendor offers everything this order needs' };
  }
  // the best one vendor could do, judged the same way everything else is
  const best = rankOptions(singles)[0];

  if (best.uncovered.length) {
    const g = best.uncovered.map(u => `${plural(u.short, `${label(u.group)} guest`)}`).join(' and ');
    return { reason: 'coverage', says: `the best single vendor leaves ${g} uncovered`, alternative: best.id };
  }
  if (best.shortOz > chosen.shortOz) {
    return { reason: 'capacity', says: `the best single vendor lands ${best.shortOz} oz short of the volume target`, alternative: best.id };
  }
  if (chosen.overBudget < best.overBudget) {
    return { reason: 'budget', says: `the best single vendor costs $${best.subtotal - chosen.subtotal} more`, alternative: best.id };
  }
  // Nothing justified it. Say so plainly rather than inventing a reason.
  return { reason: null, says: 'nothing here justifies a split; one vendor would do', alternative: best.id };
}
