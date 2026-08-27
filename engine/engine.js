// Pure, dependency-free. No DOM, no fetch. Everything here is unit-testable.
// Four checks: quantity, coverage, unclaimed, timing.

export const SERVICE_LEVELS = ['pickup', 'delivery', 'dropoff_setup', 'staffed', 'full_service'];

// ---------- demand ----------
// Derive per-person demand from the situation, not just headcount.
export function deriveDemand(occasion) {
  const { headcount, format = 'buffet', durationHours = 3, mealReplaces = true } = occasion;
  // Each of these is an editable assumption; a corrected value arrives on the occasion.
  const buffer = occasion.bufferPct ?? 0.15;               // 10-15% above headcount
  const secondsRate = occasion.secondsRate ?? (format === 'buffet' ? 0.35 : 0);  // 30-40% take seconds at a buffet
  const proteinOzPP = occasion.proteinOzPerPerson ?? (mealReplaces ? 6 : 0);
  const bites = mealReplaces ? 0 : Math.round(7 + Math.max(0, durationHours - 2) * 3.5);

  return {
    effectiveHeadcount: Math.ceil(headcount * (1 + buffer) * (1 + secondsRate)),
    proteinOz: Math.ceil(headcount * proteinOzPP * (1 + buffer) * (1 + secondsRate)),
    bites: bites ? Math.ceil(headcount * bites) : 0,
    mainsTarget: headcount >= 25 ? 2 : 1,     // 2-3 mains for a large gathering
    mainSplit: [0.6, 0.4]                     // guests split ~60/40 across two proteins
  };
}

// ---------- normalize ----------
// "serves 10" is not a unit. Convert a vendor claim to a common basis.
export function normalizeItem(item) {
  const { claimed_serves, basis_mains = 1, portion_oz = 6 } = item;
  // A tray "serving N" usually assumes it is one of several dishes.
  const totalOz = claimed_serves * portion_oz * basis_mains;
  // A basis the user checked outranks one the vendor merely stated.
  const confidence = item.basis_confirmed ? 1 : (item.basis_stated ? 0.95 : 0.7);
  return { ...item, normalized: { protein_oz: totalOz, confidence } };
}

// ---------- checks ----------
export function checkQuantity(basket, demand) {
  const supplied = basket.items
    .filter(i => i.category === 'main')
    .reduce((n, i) => n + normalizeItem(i).normalized.protein_oz, 0);
  if (supplied >= demand.proteinOz) return [];
  return [{
    check: 'quantity',
    severity: 'blocker',
    message: `Short by ${demand.proteinOz - supplied} oz of main. Reads as enough, lands short.`,
    needed: demand.proteinOz, supplied
  }];
}

export function checkCoverage(basket, occasion) {
  const out = [];
  for (const [group, count] of Object.entries(occasion.dietary || {})) {
    const servings = basket.items
      .filter(i => (i.dietary || []).includes(group))
      .reduce((n, i) => n + i.claimed_serves, 0);
    if (servings < count) {
      out.push({
        check: 'coverage', severity: 'blocker', group,
        message: `${servings} ${group} servings for ${count} ${group} guests.`,
        needed: count, supplied: servings
      });
    }
  }
  return out;
}

export function checkUnclaimed(basket, requirementsByVendor, occasion) {
  const owned = new Set();
  for (const reqs of Object.values(requirementsByVendor)) {
    for (const r of reqs.provides || []) owned.add(r);
  }
  for (const r of occasion.hostProvides || []) owned.add(r);

  const needed = new Set();
  for (const reqs of Object.values(requirementsByVendor)) {
    for (const r of reqs.requires || []) needed.add(r);
  }

  const gaps = [...needed].filter(r => !owned.has(r));
  if (!gaps.length) return [];
  const label = g => g.replace(/_/g, ' ');
  return [{
    check: 'unclaimed', severity: 'blocker', resources: gaps,
    message: gaps.length === 1
      ? `Nobody is bringing ${label(gaps[0])}.`
      : `Nobody is bringing ${gaps.slice(0, -1).map(label).join(', ')} or ${label(gaps.at(-1))}.`
  }];
}

const SAFE_HOLD_HOURS = 2; // FDA danger zone: 2 hours max

export function checkTiming(basket, occasion) {
  const out = [];
  const serve = new Date(occasion.serveAt).getTime();

  const late = (basket.pickups || [])
    .filter(p => p.hot)
    .map(p => ({ ...p, hrs: (serve - new Date(p.at).getTime()) / 3.6e6 }))
    .filter(p => p.hrs > SAFE_HOLD_HOURS)
    .sort((a, b) => b.hrs - a.hrs);
  if (late.length) {
    const w = late[0];
    out.push({
      check: 'timing', severity: 'blocker', vendor: w.vendor, hours: Number(w.hrs.toFixed(1)),
      message: `Hot food collected ${w.hrs.toFixed(1)}h before service. Safe holding is ${SAFE_HOLD_HOURS}h without heated holding.`
        + (late.length > 1 ? ` (${late.length} pickups affected.)` : '')
    });
  }

  // one person cannot be in two places
  const byTime = (basket.pickups || []).filter(p => p.selfCollect)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  let tightest = null;
  for (let i = 1; i < byTime.length; i++) {
    const gap = (new Date(byTime[i].at) - new Date(byTime[i - 1].at)) / 60000;
    if (gap < 45 && (tightest === null || gap < tightest)) tightest = gap;
  }
  if (tightest !== null) {
    const n = byTime.length;
    out.push({
      check: 'timing', severity: 'risk', minutes: Math.round(tightest),
      message: `${n} collections to make, the tightest ${Math.round(tightest)} minutes apart. One person, one car.`
    });
  }
  return out;
}

export function runChecks({ basket, occasion, requirementsByVendor = {} }) {
  const demand = deriveDemand(occasion);
  const findings = [
    ...checkQuantity(basket, demand),
    ...checkCoverage(basket, occasion),
    ...checkUnclaimed(basket, requirementsByVendor, occasion),
    ...checkTiming(basket, occasion)
  ];
  const rank = { blocker: 0, risk: 1, note: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { demand, findings };
}
