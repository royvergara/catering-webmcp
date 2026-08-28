// Pure planning logic. No DOM, no fetch. Composes a basket and explains the arithmetic.
import { deriveDemand, normalizeItem, runChecks, unmetObligations } from '../engine/engine.js';
import { deriveAssumptions, applyAssumptions, reviseAssumption, carryConfirmed } from '../engine/assumptions.js';
import { diffFindings, summarizeDelta, diffOccasion, describeOccasionChange } from '../engine/replan.js';
import { admitVendors } from '../engine/trust.js';
import { describeOption, rankOptions, distinct, justifySplit } from '../engine/options.js';
import { timeline, addHostHoldingJob } from '../engine/schedule.js';

const WORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, fifteen:15, twenty:20, thirty:30, forty:40, fifty:50, sixty:60, hundred:100 };

// The nouns that mean "people". Written once: the headcount matcher looks for them,
// and the "for N" fallbacks use them to tell "for 40 people" from "for 12 dogs".
const PEOPLE = String.raw`people|guests|pax|heads|persons?|attendees`;

// Words that can follow a bare headcount without being the thing it counts:
// function words and calendar words. Both are closed classes, which is what makes
// this list finite — the nouns on the other side ("dogs", "cats", "trays") are not.
const UNCOUNTED = String.raw`on|at|in|of|for|with|and|or|to|from|by|this|next|last|` +
  String.raw`plus|about|around|under|over|near|before|after|during|` +
  String.raw`today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday`;

// A number is a headcount unless a noun follows that it is plainly counting.
// "dinner for 12" and "party for 60 on Friday" are headcounts; "dinner for 12 dogs"
// is not, and used to plan dinner for twelve people.
const COUNTS_PEOPLE = String.raw`(?!\s+(?!(?:${PEOPLE}|${UNCOUNTED})\b)[a-z])`;

// A number with a noun attached is a quantity of something. A bare number is
// usually the clock ("Saturday at 6"), and `found.serveAt` already says the clock
// is not read, so reporting it again would only be noise.
const TIME_WORD = /^(?:pm|am|oclock|noon|ish|hrs?)$/;

// `given` is what the caller already knows: an agent calling plan_meal has done the
// language work before this function ever runs, and a field it passes is better
// evidence than anything a regex can recover from prose. Given values win, and are
// recorded as their own kind of source so the plan can say which is which.
export function parseOccasion(text, given = {}) {
  let t = String(text).toLowerCase();
  // people write "six vegetarians", not "6 vegetarians"
  for (const [w, n] of Object.entries(WORDS)) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n));

  // Every match records the span it consumed, so whatever is left can be reported
  // instead of dropped. "feed 5 dogs too" used to vanish here and the page then
  // said nothing in the description had changed, which was not true.
  const claimed = [];
  const num = re => {
    const m = t.match(re);
    if (!m) return undefined;
    claimed.push([m.index, m.index + m[0].length]);
    return Number(m[1].replace(/,/g, ''));
  };

  const dietary = {};
  const veg = num(/(\d+)\s*veg(etarian)?/); if (veg) dietary.vegetarian = veg;
  const gf = num(/(\d+)\s*(gluten[\s-]?free|gf)/); if (gf) dietary.gluten_free = gf;
  const vegan = num(/(\d+)\s*vegan/); if (vegan) dietary.vegan = vegan;

  // How many people, written the several ways people actually write it.
  const headcount =
    num(new RegExp(String.raw`(\d+)\s*(?:${PEOPLE}|of us)`)) ??
    num(new RegExp(String.raw`\b(?:party|group|dinner|lunch|table|catering)\s+(?:of|for)\s+(\d+)\b${COUNTS_PEOPLE}`)) ??
    num(new RegExp(String.raw`\bfor\s+(\d+)\b(?!\s*(?:pm|am|o'clock))${COUNTS_PEOPLE}`)) ??
    num(/^(\d+)\b/);

  // Only a figure actually marked as money, or named as a budget. Matching any
  // three-digit number read "100 people" as a $100 budget.
  const budget =
    num(/\$\s?(\d[\d,]*)/) ??
    num(/\b(?:budget|spend|under|around|about|up to|max(?:imum)?)\D{0,12}(\d[\d,]{1,6})\b/);

  // What no field claimed. Reported rather than discarded: the planner cannot act
  // on "5 dogs", but saying so is the difference between a limit and a lie.
  const inClaimed = i => claimed.some(([a, b]) => i >= a && i < b);
  const unread = [];
  for (const m of t.matchAll(/(\d[\d,]*)\s*([a-z][a-z'-]+)/g)) {
    if (inClaimed(m.index) || TIME_WORD.test(m[2])) continue;
    const phrase = `${m[1]} ${m[2]}`;
    if (!unread.includes(phrase)) unread.push(phrase);
  }

  const supplied = [];
  const take = (field, value) => {
    if (value === undefined || value === null) return undefined;
    supplied.push(field);
    return value;
  };
  const gHead = take('headcount', given.headcount);
  const gBudget = take('budget', given.budget);
  const gDiet = take('dietary', given.dietary);
  const gKitchen = take('venueHasKitchen', given.venueHasKitchen);
  const gHours = take('durationHours', given.durationHours);
  const gServeAt = take('serveAt', given.serveAt);

  // What is known, as opposed to what was assumed in its absence — whether it was
  // handed over or recovered from the text. Which of those two it was is `given`.
  // This stays boolean because deriveAssumptions reads it to tell a real value from
  // a default wearing one's clothes.
  const found = {
    headcount: gHead !== undefined || headcount !== undefined,
    budget: gBudget !== undefined || budget !== undefined,
    dietary: gDiet !== undefined || Object.keys(dietary).length > 0,
    serveAt: gServeAt !== undefined   // no date parsing; the demo time is a fixture, and says so
  };

  return {
    found,
    given: supplied,
    unread,
    headcount: gHead ?? headcount ?? 40,
    budget: gBudget ?? budget ?? 600,
    serveAt: gServeAt ?? '2026-09-12T18:00:00-05:00',
    format: 'buffet',
    durationHours: gHours ?? 3,
    mealReplaces: true,
    dietary: gDiet ?? dietary,
    venueHasKitchen: gKitchen ?? !/no kitchen/.test(t),
    hostProvides: [],
    normalized: t,
    raw: text
  };
}

// Choose items to satisfy demand and per-group coverage, cheapest first, fewest vendors.
//
// `only` restricts the pool to named vendors, so a single-vendor basket can be composed
// and compared honestly against a split. `prefer` decides what "best" means when topping
// up volume: the most food per dollar, or the smallest line item. Different answers to
// those two questions are what makes one option genuinely different from another.
export function composeBasket(occasion, vendors, { only = null, prefer = 'value' } = {}) {
  const demand = deriveDemand(occasion);
  let caterers = vendors.filter(v => v.kind === 'caterer' || v.kind === 'bakery');
  if (only) caterers = caterers.filter(v => only.includes(v.slug));

  // A vendor who cannot take the date is not a candidate. Excluded rather than
  // silently ordered from, and named, so the exclusion is visible.
  const date = String(occasion.serveAt || '').slice(0, 10);
  const excluded = [];
  if (date) {
    caterers = caterers.filter(v => {
      if (!(v.blackout_dates || []).includes(date)) return true;
      excluded.push({ vendor: v.slug, name: v.name, reason: `booked on ${date}` });
      return false;
    });
  }

  const pool = [];
  for (const v of caterers) {
    for (const item of v.menu) {
      const n = normalizeItem(item);
      pool.push({
        ...item, vendor: v.slug, vendorName: v.name, tier: v.tier,
        oz: n.normalized.protein_oz, confidence: n.normalized.confidence,
        ozPerDollar: item.price ? n.normalized.protein_oz / item.price : 0
      });
    }
  }

  const chosen = [];
  const why = [];
  const need = { ...(occasion.dietary || {}) };
  const countOf = id => chosen.filter(c => c.id === id).length;
  const MAX_SAME = 2; // variety beats volume: four good options beat two giant trays
  const best = (a, b) => (prefer === 'price' ? a.price - b.price : b.ozPerDollar - a.ozPerDollar);

  // 1. cover each dietary group first, cheapest qualifying item per group
  for (const [group, count] of Object.entries(need)) {
    let covered = 0;
    const candidates = pool
      .filter(i => (i.dietary || []).includes(group) && i.category === 'main')
      .sort(best);
    for (const c of candidates) {
      while (covered < count && countOf(c.id) < MAX_SAME) {
        chosen.push({ ...c });
        covered += c.claimed_serves;
        why.push(`${c.name} from ${c.vendorName}: covers ${group} (${covered} of ${count} servings needed).`);
      }
      if (covered >= count) break;
    }
  }

  // 2. top up total main volume, best value first
  const totalOz = () => chosen.filter(i => i.category === 'main').reduce((n, i) => n + i.oz, 0);
  const mains = pool.filter(i => i.category === 'main').sort(best);
  let guard = 0;
  while (totalOz() < demand.proteinOz && guard++ < 20) {
    const pick = mains.find(m => countOf(m.id) < MAX_SAME);
    if (!pick) break;
    chosen.push({ ...pick });
    why.push(`${pick.name} from ${pick.vendorName}: brings main volume to ${totalOz()} oz of the ${demand.proteinOz} needed.`);
  }

  const subtotal = chosen.reduce((n, i) => n + i.price, 0);
  const vendorsUsed = [...new Set(chosen.map(i => i.vendor))];

  // Which dietary groups this basket leaves short, per group, as counts not vibes.
  const uncovered = [];
  for (const [group, count] of Object.entries(occasion.dietary || {})) {
    const served = chosen.filter(i => (i.dietary || []).includes(group))
      .reduce((n, i) => n + i.claimed_serves, 0);
    if (served < count) uncovered.push({ group, needed: count, served, short: count - served });
  }

  return {
    items: chosen,
    why,
    subtotal,
    vendorsUsed,
    demand,
    uncovered,
    excluded,
    shortOz: Math.max(0, demand.proteinOz - chosen.filter(i => i.category === 'main').reduce((n, i) => n + i.oz, 0)),
    splitReason: vendorsUsed.length > 1
      ? 'coverage: no single vendor covered every dietary group within budget'
      : null
  };
}

export function explainQuantity(item, occasion, demand) {
  const share = demand.mainSplit[0];
  const eaters = Math.round(occasion.headcount * share);
  const per = occasion.proteinOzPerPerson ?? 6;
  const buffer = occasion.bufferPct ?? 0.15;
  const needOz = Math.ceil(eaters * per * (1 + buffer));
  const trays = Math.ceil(needOz / (item.oz || 1));
  const basis = item.basis_confirmed ? ' (basis confirmed by you)'
    : item.basis_stated ? ' (basis stated)' : ' (basis assumed)';
  return [
    `${occasion.headcount} guests, buffet, ${demand.mainsTarget} mains`,
    `${Math.round(share * 100)}/${Math.round((1 - share) * 100)} split -> about ${eaters} people on this dish`,
    `${per} oz each with a ${Math.round(buffer * 100)}% buffer -> ${needOz} oz`,
    `this vendor's item is ${item.oz} oz${basis}`,
    `${trays} needed. ${trays - 1} would leave you ${needOz - (trays - 1) * item.oz} oz short.`
  ];
}

export function planPickups(basket, occasion) {
  const byVendor = {};
  for (const i of basket.items) (byVendor[i.vendor] ||= []).push(i);
  const serve = new Date(occasion.serveAt);
  return Object.keys(byVendor).map((v, idx) => ({
    vendor: v,
    at: new Date(serve.getTime() - (4 - idx * 0.33) * 3.6e6).toISOString(),
    hot: byVendor[v].some(i => i.hot),
    selfCollect: true
  }));
}

export function assemblePlan(occasion, vendors, serviceLevel = 'pickup', opts = {}) {
  const prior = opts.assumptions || [];
  // Vendor data is third-party input. Admit it as data before anything reads it:
  // unknown fields dropped, agent-directed sentences quarantined.
  const trust = admitVendors(vendors);
  vendors = trust.vendors;
  // Corrections land on the inputs first, so everything below recomputes from them.
  const applied = applyAssumptions(occasion, vendors, prior);
  const useOccasion = applied.occasion;
  const useVendors = applied.vendors;

  const basket = composeBasket(useOccasion, useVendors, opts.compose || {});
  basket.pickups = planPickups(basket, useOccasion);

  const requirementsByVendor = {};
  for (const slug of basket.vendorsUsed) {
    const v = useVendors.find(x => x.slug === slug);
    const lvl = v.service_levels.includes(serviceLevel) ? serviceLevel : v.service_levels[0];
    requirementsByVendor[slug] = { ...(v.requirements[lvl] || {}), service_level: lvl, assumed: !!v.requirements[lvl]?.assumed };
  }

  const vendorsBySlug = Object.fromEntries(useVendors.map(v => [v.slug, v]));
  const { findings } = runChecks({ basket, occasion: useOccasion, requirementsByVendor, vendorsBySlug });
  // Derive from the occasion as given, not as corrected: that is what lets a confirmed
  // value be reported as standing against a description that still says otherwise.
  const assumptions = carryConfirmed(deriveAssumptions(occasion, basket), prior);

  return {
    occasion: useOccasion,
    baseOccasion: opts.baseOccasion || occasion,  // the raw parse, so a re-run starts clean
    basket, requirementsByVendor, findings, serviceLevel, assumptions,
    compose: opts.compose || {},   // the option you picked survives a correction
    trust, ranking: rankVendors(useVendors, useOccasion)
  };
}

// Deterministic and explainable: coverage of the stated dietary groups, then value,
// then name. Nothing a vendor says about itself is an input. There is no paid
// position here because there is no marketplace here.
export function rankVendors(vendors, occasion) {
  const groups = Object.keys(occasion.dietary || {});
  const rows = vendors
    .filter(v => v.kind === 'caterer' || v.kind === 'bakery')
    .map(v => {
      const mains = (v.menu || []).filter(i => i.category === 'main');
      const covers = groups.filter(g => mains.some(i => (i.dietary || []).includes(g)));
      const best = mains.reduce((n, i) => {
        const oz = normalizeItem(i).normalized.protein_oz;
        return i.price ? Math.max(n, oz / i.price) : n;
      }, 0);
      return { slug: v.slug, name: v.name, tier: v.tier, covers: covers.length, ozPerDollar: Number(best.toFixed(2)) };
    });

  rows.sort((a, b) =>
    b.covers - a.covers ||
    b.ozPerDollar - a.ozPerDollar ||
    a.slug.localeCompare(b.slug));

  return rows.map((r, i) => ({
    ...r, rank: i + 1,
    why: `covers ${r.covers} of ${groups.length} stated group${groups.length === 1 ? '' : 's'}, ${r.ozPerDollar} oz per dollar`
  }));
}

// Two or three real orders with the tradeoffs stated, rather than one answer presented
// as the answer. Each is a full plan, so each carries its own findings and ownership.
//
// The candidates are not cosmetic variants: one vendor at a time says what you give up
// for simplicity, and value-first against price-first say what you give up for money.
export function buildOptions(occasion, vendors, serviceLevel = 'pickup', opts = {}) {
  const caterers = vendors.filter(v => v.kind === 'caterer' || v.kind === 'bakery');
  const strategies = [
    { id: 'covers', compose: {} },
    { id: 'thrift', compose: { prefer: 'price' } },
    ...caterers.map(v => ({ id: `alone-${v.slug}`, compose: { only: [v.slug] } }))
  ];

  const built = [];
  for (const s of strategies) {
    const plan = assemblePlan(occasion, vendors, serviceLevel, { ...opts, compose: s.compose });
    const b = plan.basket;
    if (!b.items.length) continue;                       // a bakery alone cannot feed anyone
    built.push({
      id: s.id,
      plan,
      itemIds: b.items.map(i => i.id),
      subtotal: b.subtotal,
      vendorCount: b.vendorsUsed.length,
      itemCount: b.items.length,
      uncovered: b.uncovered,
      shortOz: b.shortOz,
      collections: (b.pickups || []).filter(p => p.selfCollect).length,
      blockers: plan.findings.filter(f => f.severity === 'blocker').length,
      overBudget: Math.max(0, b.subtotal - (occasion.budget || 0))
    });
  }

  const pool = rankOptions(distinct(built));
  if (!pool.length) return [];

  // Show at most three, and only ones that differ on an axis a person cares about:
  // the best overall, the simplest, and the cheapest.
  const picked = [pool[0]];
  const add = o => { if (o && !picked.includes(o)) picked.push(o); };
  add([...pool].sort((a, b) => a.vendorCount - b.vendorCount || a.subtotal - b.subtotal)[0]);
  add([...pool].filter(o => !o.uncovered.length).sort((a, b) => a.subtotal - b.subtotal)[0]);
  add([...pool].sort((a, b) => a.subtotal - b.subtotal)[0]);

  const chosen = picked.slice(0, 3);
  return chosen.map((o, i) => ({
    ...describeOption(o, chosen),
    rank: i + 1,
    recommended: i === 0,
    split: justifySplit(o, pool)
  }));
}

// Correct one assumption and rebuild everything that depended on it.
export function revisePlan(plan, vendors, id, value) {
  const next = reviseAssumption(plan.assumptions, id, value);
  return assemblePlan(plan.baseOccasion || plan.occasion, vendors, plan.serviceLevel,
    { assumptions: next, baseOccasion: plan.baseOccasion || plan.occasion, compose: plan.compose });
}

// Change one input and report what moved. The plan is rebuilt in full; what comes
// back is the difference, because that is what a person needs to read.
export function replan(plan, vendors, change) {
  const base = plan.baseOccasion || plan.occasion;
  let after, what, delta0 = {};

  if (change.serviceLevel) {
    after = assemblePlan(base, vendors, change.serviceLevel,
      { assumptions: plan.assumptions, baseOccasion: base, compose: plan.compose });
    what = `Service level ${plan.serviceLevel} -> ${change.serviceLevel}.`;
  } else if (change.description !== undefined) {
    const reparsed = parseOccasion(change.description);
    after = assemblePlan(reparsed, vendors, plan.serviceLevel,
      { assumptions: plan.assumptions, baseOccasion: reparsed, compose: plan.compose });
    // say what the description said differently, not merely that it was read again
    const inputChanges = diffOccasion(base, reparsed);
    what = describeOccasionChange(inputChanges, reparsed.unread);
    delta0 = { inputChanges, unread: reparsed.unread };
  } else {
    const was = plan.assumptions.find(a => a.id === change.assumption);
    after = revisePlan(plan, vendors, change.assumption, change.value);
    const now = after.assumptions.find(a => a.id === change.assumption);
    what = `${was ? was.label : change.assumption} ${was ? was.value : '?'} -> ${now.value}.`;
  }

  const delta = diffFindings(plan.findings, after.findings);
  Object.assign(delta, delta0);
  delta.change = what;
  const spent = after.basket.subtotal - plan.basket.subtotal;
  delta.cost = spent === 0
    ? null
    : `Order ${spent > 0 ? 'up' : 'down'} $${Math.abs(spent)}, now $${after.basket.subtotal}.`;
  delta.lines = summarizeDelta(delta);

  return { plan: after, delta };
}

export function ownershipTable(plan, vendors) {
  const byVendor = plan.requirementsByVendor || {};
  const occasion = plan.occasion || {};
  // The same scoped answer the unclaimed check uses, so the table and the finding can
  // never disagree about who owes what.
  const { pooled, perVendor } = unmetObligations(byVendor, occasion);
  const nameOf = slug => (vendors.find(v => v.slug === slug) || {}).name || slug;

  const rows = [];
  const seen = new Set();
  const add = (job, who, extra = {}) => {
    const key = `${job}|${who}|${extra.for || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ job, who, ...extra });
  };

  // What a vendor actually provides is that vendor's job, and is not also yours.
  for (const [slug, r] of Object.entries(byVendor)) {
    for (const p of r.provides || []) add(p, nameOf(slug), { source: 'vendor' });
  }
  // Pooled obligations nobody covers: one chafer order covers the whole table.
  for (const r of pooled) add(r, 'You', { source: 'left to you' });
  // Owed to one vendor in particular, so named: another caterer delivering its own
  // food does nothing about the one you still have to drive to.
  for (const g of perVendor) add(g.resource, 'You', { source: 'left to you', for: nameOf(g.vendor) });

  const withHolding = addHostHoldingJob(rows, {
    serviceLevel: plan.serviceLevel,
    hasHotFood: (plan.basket?.items || []).some(i => i.hot)
  });

  // job, when, who: the middle column is the one a receipt never shows
  return timeline(withHolding, occasion);
}


// What a person would plausibly order alone: one vendor, sized by headcount, no per-group math.
export function naiveBasket(occasion, vendors) {
  const demand = deriveDemand(occasion);
  const caterers = vendors.filter(v => v.kind === 'caterer');
  const v = caterers[0];
  const main = v && v.menu.find(i => i.category === 'main');
  const n = main ? Math.ceil((occasion.headcount || 0) / main.claimed_serves) : 0;
  // nobody to order from, or nobody to feed: an empty baseline, not a crash
  if (!n) {
    return { items: [], why: [], subtotal: 0, vendorsUsed: [], demand, splitReason: null, pickups: [] };
  }
  const items = Array.from({ length: n }, () => ({
    ...main, vendor: v.slug, vendorName: v.name, tier: v.tier,
    oz: normalizeItem(main).normalized.protein_oz
  }));
  return {
    items, why: [`${n} x ${main.name}: ${occasion.headcount} guests divided by ${main.claimed_serves} per tray.`],
    subtotal: items.reduce((s, i) => s + i.price, 0),
    vendorsUsed: [v.slug], demand, splitReason: null, pickups: []
  };
}
