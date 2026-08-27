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

// Most obligations pool across the event: one chafer order covers every tray on the
// table, and cleanup is cleanup. A few do not. Collecting from a vendor is owed to
// that vendor specifically — one caterer delivering its own food does nothing about
// the other caterer you still have to drive to.
export const PER_VENDOR_RESOURCES = new Set(['transport', 'someone_on_site_at_delivery']);

const labelResource = g => String(g).replace(/_/g, ' ');

// Who owes what, scoped correctly. Returns pooled gaps and per-vendor gaps separately,
// so the same answer can drive both the finding and the ownership table.
export function unmetObligations(requirementsByVendor = {}, occasion = {}) {
  const pooled = new Set(occasion.hostProvides || []);
  for (const reqs of Object.values(requirementsByVendor)) {
    for (const r of reqs.provides || []) if (!PER_VENDOR_RESOURCES.has(r)) pooled.add(r);
  }

  const pooledGaps = new Set();
  const perVendorGaps = [];
  for (const [slug, reqs] of Object.entries(requirementsByVendor)) {
    for (const r of reqs.requires || []) {
      if (PER_VENDOR_RESOURCES.has(r)) {
        const selfCovers = (reqs.provides || []).includes(r);
        const hostCovers = (occasion.hostProvides || []).includes(r);
        if (!selfCovers && !hostCovers) perVendorGaps.push({ resource: r, vendor: slug });
      } else if (!pooled.has(r)) {
        pooledGaps.add(r);
      }
    }
  }
  return { pooled: [...pooledGaps], perVendor: perVendorGaps, provided: pooled };
}

export function checkUnclaimed(basket, requirementsByVendor, occasion) {
  const { pooled, perVendor } = unmetObligations(requirementsByVendor, occasion);
  if (!pooled.length && !perVendor.length) return [];

  const list = pooled.map(labelResource);
  const parts = [];
  if (list.length) {
    parts.push(list.length === 1
      ? `Nobody is bringing ${list[0]}.`
      : `Nobody is bringing ${list.slice(0, -1).join(', ')} or ${list.at(-1)}.`);
  }
  if (perVendor.length) {
    const byResource = {};
    for (const g of perVendor) (byResource[g.resource] ||= []).push(g.vendor);
    for (const [resource, vendors] of Object.entries(byResource)) {
      parts.push(`Nobody is covering ${labelResource(resource)} for ${vendors.join(' or ')}.`);
    }
  }

  return [{
    check: 'unclaimed', severity: 'blocker',
    resources: pooled, perVendor,
    message: parts.join(' ')
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

// A vendor can publish a menu and still not be able to take the order. Their own
// availability tool knows; nothing was asking it.
export function checkAvailability(basket, occasion, vendorsBySlug = {}) {
  const out = [];
  const date = String(occasion.serveAt || '').slice(0, 10);
  if (!date) return out;

  for (const slug of basket.vendorsUsed || []) {
    const v = vendorsBySlug[slug];
    if (!v) continue;
    if ((v.blackout_dates || []).includes(date)) {
      out.push({
        check: 'availability', severity: 'blocker', vendor: slug,
        message: `${v.name} is booked on ${date}. Their own availability says so.`
      });
      continue;
    }
    // Only checkable when we know when the order is being placed.
    if (occasion.placedAt && v.lead_time_hours) {
      const hours = (new Date(occasion.serveAt) - new Date(occasion.placedAt)) / 3.6e6;
      if (Number.isFinite(hours) && hours < v.lead_time_hours) {
        out.push({
          check: 'availability', severity: 'blocker', vendor: slug, hours: Math.round(hours),
          message: `${v.name} needs ${v.lead_time_hours}h notice and this order gives ${Math.round(hours)}h.`
        });
      }
    }
  }
  return out;
}

// The budget is stated up front and then quietly exceeded. Say so.
export function checkBudget(basket, occasion) {
  if (!occasion.budget || basket.subtotal === undefined) return [];
  const over = basket.subtotal - occasion.budget;
  if (over <= 0) return [];
  return [{
    check: 'budget', severity: 'risk', over, budget: occasion.budget, spent: basket.subtotal,
    message: `$${over} over the $${occasion.budget} you set.`
  }];
}

export function runChecks({ basket, occasion, requirementsByVendor = {}, vendorsBySlug = {} }) {
  const demand = deriveDemand(occasion);
  const findings = [
    ...checkQuantity(basket, demand),
    ...checkCoverage(basket, occasion),
    ...checkUnclaimed(basket, requirementsByVendor, occasion),
    ...checkTiming(basket, occasion),
    ...checkAvailability(basket, occasion, vendorsBySlug),
    ...checkBudget(basket, occasion)
  ];
  const rank = { blocker: 0, risk: 1, note: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { demand, findings };
}
