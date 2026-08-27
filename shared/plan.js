// Pure planning logic. No DOM, no fetch. Composes a basket and explains the arithmetic.
import { deriveDemand, normalizeItem, runChecks } from '../engine/engine.js';

const WORDS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10,
  eleven:11, twelve:12, fifteen:15, twenty:20, thirty:30, forty:40, fifty:50, sixty:60, hundred:100 };

export function parseOccasion(text) {
  let t = String(text).toLowerCase();
  // people write "six vegetarians", not "6 vegetarians"
  for (const [w, n] of Object.entries(WORDS)) t = t.replace(new RegExp(`\\b${w}\\b`, 'g'), String(n));

  const num = re => { const m = t.match(re); return m ? Number(m[1]) : undefined; };

  const dietary = {};
  const veg = num(/(\d+)\s*veg(etarian)?/); if (veg) dietary.vegetarian = veg;
  const gf = num(/(\d+)\s*(gluten[\s-]?free|gf)/); if (gf) dietary.gluten_free = gf;
  const vegan = num(/(\d+)\s*vegan/); if (vegan) dietary.vegan = vegan;

  return {
    headcount: num(/(\d+)\s*(people|guests|pax|heads)/) || num(/^(\d+)\b/) || 40,
    budget: num(/\$?\s?(\d{3,5})/) || 600,
    serveAt: '2026-09-12T18:00:00-05:00',
    format: 'buffet',
    durationHours: 3,
    mealReplaces: true,
    dietary,
    venueHasKitchen: !/no kitchen/.test(t),
    hostProvides: [],
    normalized: t,
    raw: text
  };
}

// Choose items to satisfy demand and per-group coverage, cheapest first, fewest vendors.
export function composeBasket(occasion, vendors, { maxVendors = 2 } = {}) {
  const demand = deriveDemand(occasion);
  const caterers = vendors.filter(v => v.kind === 'caterer' || v.kind === 'bakery');

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

  // 1. cover each dietary group first, cheapest qualifying item per group
  for (const [group, count] of Object.entries(need)) {
    let covered = 0;
    const candidates = pool
      .filter(i => (i.dietary || []).includes(group) && i.category === 'main')
      .sort((a, b) => b.ozPerDollar - a.ozPerDollar);
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
  const mains = pool.filter(i => i.category === 'main').sort((a, b) => b.ozPerDollar - a.ozPerDollar);
  let guard = 0;
  while (totalOz() < demand.proteinOz && guard++ < 20) {
    const pick = mains.find(m => countOf(m.id) < MAX_SAME);
    if (!pick) break;
    chosen.push({ ...pick });
    why.push(`${pick.name} from ${pick.vendorName}: brings main volume to ${totalOz()} oz of the ${demand.proteinOz} needed.`);
  }

  const subtotal = chosen.reduce((n, i) => n + i.price, 0);
  const vendorsUsed = [...new Set(chosen.map(i => i.vendor))];

  return {
    items: chosen,
    why,
    subtotal,
    vendorsUsed,
    demand,
    splitReason: vendorsUsed.length > 1
      ? 'coverage: no single vendor covered every dietary group within budget'
      : null
  };
}

export function explainQuantity(item, occasion, demand) {
  const share = demand.mainSplit[0];
  const eaters = Math.round(occasion.headcount * share);
  const needOz = Math.ceil(eaters * 6 * 1.15);
  const trays = Math.ceil(needOz / (item.oz || 1));
  return [
    `${occasion.headcount} guests, buffet, ${demand.mainsTarget} mains`,
    `${Math.round(share * 100)}/${Math.round((1 - share) * 100)} split -> about ${eaters} people on this dish`,
    `6 oz each with a 15% buffer -> ${needOz} oz`,
    `this vendor's item is ${item.oz} oz${item.basis_stated ? ' (basis stated)' : ' (basis assumed)'}`,
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

export function assemblePlan(occasion, vendors, serviceLevel = 'pickup') {
  const basket = composeBasket(occasion, vendors);
  basket.pickups = planPickups(basket, occasion);

  const requirementsByVendor = {};
  for (const slug of basket.vendorsUsed) {
    const v = vendors.find(x => x.slug === slug);
    const lvl = v.service_levels.includes(serviceLevel) ? serviceLevel : v.service_levels[0];
    requirementsByVendor[slug] = { ...(v.requirements[lvl] || {}), service_level: lvl, assumed: !!v.requirements[lvl]?.assumed };
  }

  const { findings } = runChecks({ basket, occasion, requirementsByVendor });
  return { occasion, basket, requirementsByVendor, findings, serviceLevel };
}

export function ownershipTable(plan, vendors) {
  const rows = [];
  for (const [slug, r] of Object.entries(plan.requirementsByVendor)) {
    const v = vendors.find(x => x.slug === slug);
    for (const p of r.provides || []) rows.push({ job: p, who: v.name, source: 'vendor' });
    for (const q of r.requires || []) rows.push({ job: q, who: 'You', source: 'left to you' });
  }
  const seen = new Set();
  return rows.filter(r => { const k = r.job + r.who; if (seen.has(k)) return false; seen.add(k); return true; });
}


// What a person would plausibly order alone: one vendor, sized by headcount, no per-group math.
export function naiveBasket(occasion, vendors) {
  const demand = deriveDemand(occasion);
  const caterers = vendors.filter(v => v.kind === 'caterer');
  const v = caterers[0];
  const main = v.menu.find(i => i.category === 'main');
  const n = Math.ceil(occasion.headcount / main.claimed_serves);
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
