// Pure, dependency-free. No DOM, no fetch. Everything here is unit-testable.
// The page fetches the bytes; these functions turn bytes into the same record shape.
//
// Almost no real vendor has WebMCP tools today. A solution that only works once they
// do is a solution for a world that does not exist. So WebMCP is treated as the best
// tier of a gradient, not a requirement — and the gradient is honest about what is
// lost at each step down.

export const TIERS = {
  T0: { label: 'WebMCP tools',      how: 'call get_menu and get_requirements', confidence: 0.98 },
  T1: { label: 'Structured markup', how: 'read schema.org Menu from the page',  confidence: 0.90 },
  T2: { label: 'Semi-structured',   how: 'parse the published price table',     confidence: 0.65 },
  T3: { label: 'Documents',         how: 'read text off a PDF or scan',         confidence: 0.45 },
  T4: { label: 'Nothing published', how: 'draft an inquiry for a human to send', confidence: 0 },
  T5: { label: 'Human supplied',    how: 'the customer pastes a quote',          confidence: 0.8 }
};

// The tiers differ in more than effort. They differ in what becomes possible at all.
// Two rows carry the whole argument: requirements exist at no tier below T0, and
// nothing below T0 can act.
export const CAPABILITIES = [
  { id: 'menu',         label: 'Read the menu',       T0: 'yes', T1: 'yes',              T2: 'yes',      T3: 'partial',     T4: 'no' },
  { id: 'servings',     label: 'Serving counts',      T0: 'yes', T1: 'no',               T2: 'yes',      T3: 'approximate', T4: 'no' },
  { id: 'dietary',      label: 'Dietary tags',        T0: 'yes', T1: 'three diets only', T2: 'inferred', T3: 'inferred',    T4: 'no' },
  { id: 'availability', label: 'Live availability',   T0: 'yes', T1: 'no',               T2: 'no',       T3: 'no',          T4: 'ask' },
  { id: 'requirements', label: 'Requirements',        T0: 'yes', T1: 'no',               T2: 'no',       T3: 'no',          T4: 'ask' },
  { id: 'hold',         label: 'Place a hold',        T0: 'yes', T1: 'no',               T2: 'no',       T3: 'no',          T4: 'no' },
  { id: 'negotiate',    label: 'Negotiate a fix',     T0: 'yes', T1: 'no',               T2: 'no',       T3: 'no',          T4: 'ask, slowly' },
  { id: 'roundtrip',    label: 'Round trip',          T0: 'seconds', T1: 'seconds',      T2: 'seconds',  T3: 'seconds',     T4: 'days' }
];

export const can = (tier, capability) =>
  (CAPABILITIES.find(c => c.id === capability) || {})[tier] ?? 'no';

const record = (item, o, tier, url, now, evidence, assumed = []) => ({
  item,
  serves: o.serves ?? null,
  serves_range: o.serves_range ?? null,
  price: o.price ?? null,
  dietary: o.dietary ?? [],
  dietary_inferred: !!o.dietary_inferred,
  minimum: o.minimum ?? null,
  lead_time_hours: o.lead_time_hours ?? null,
  assumed,                                  // what had to be guessed to fill this in
  flagged: TIERS[tier].confidence < 0.5,    // low enough that a human should confirm
  source: { tier, url, fetched_at: now, confidence: TIERS[tier].confidence, evidence }
});

// Nothing on a menu says who may eat it unless someone marked it. Below T1 the only
// signal is the name, and a guess from a name is labelled a guess.
const DIET_HINTS = [
  { re: /\b(vegetable|veggie|garden|salad|grain|falafel|caprese)\b/i, diets: ['vegetarian'] },
  { re: /\b(chicken|beef|pork|carnitas|turkey|lamb|fish|shrimp)\b/i,  diets: [] }
];
function inferDiet(name) {
  for (const h of DIET_HINTS) if (h.re.test(name)) return h.diets;
  return [];
}

// ---------- T0: the vendor's own tools ----------
export function readT0(vendor, now = new Date().toISOString()) {
  return (vendor.menu || []).map(i => record(i.name, {
    serves: i.claimed_serves, price: i.price, dietary: i.dietary || [],
    minimum: i.minimum, lead_time_hours: vendor.lead_time_hours
  }, 'T0', `webmcp://${vendor.slug}/get_menu`, now, 'get_menu returned this item'));
}

// ---------- T1: schema.org markup ----------
// Real and substantial: schema.org Menu appears on a large share of restaurant domains.
// It carries names, prices and three diets. It carries no serving count at all, which
// is the number this whole plan turns on.
const DIET_URLS = {
  GlutenFreeDiet: 'gluten_free', VeganDiet: 'vegan', VegetarianDiet: 'vegetarian',
  HalalDiet: 'halal', KosherDiet: 'kosher'
};

export function readT1(jsonldText, url = '', now = new Date().toISOString()) {
  let doc;
  try { doc = typeof jsonldText === 'string' ? JSON.parse(jsonldText) : jsonldText; }
  catch { return []; }

  const sections = [].concat(doc?.hasMenu?.hasMenuSection || []);
  const items = sections.flatMap(s => [].concat(s.hasMenuItem || []));
  return items.map(i => {
    const diets = [].concat(i.suitableForDiet || [])
      .map(d => DIET_URLS[String(d).split('/').pop()])
      .filter(Boolean);
    const price = Number([].concat(i.offers || [])[0]?.price);
    return record(i.name, {
      serves: null,                                   // schema.org has no such property
      price: Number.isFinite(price) ? price : null,
      dietary: diets
    }, 'T1', url, now,
      diets.length ? `suitableForDiet: ${diets.join(', ')}` : 'MenuItem with an Offer',
      ['serving count']);
  });
}

// ---------- T2: a price table on an ordinary page ----------
export function readT2(html, url = '', now = new Date().toISOString()) {
  const rows = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => c[1].replace(/<[^>]*>/g, '').trim()));

  const out = [];
  for (const cells of rows) {
    if (cells.length < 3) continue;
    const [name, serves, price] = cells;
    const n = Number(String(serves).replace(/[^\d]/g, ''));
    const p = Number(String(price).replace(/[^\d.]/g, ''));
    if (!name || !Number.isFinite(n) || !n || !Number.isFinite(p)) continue;   // skips the header
    const diets = inferDiet(name);
    out.push(record(name, {
      serves: n, price: p, dietary: diets, dietary_inferred: true
    }, 'T2', url, now, `table row: ${name} / ${serves} / ${price}`, ['dietary tags']));
  }
  const lead = String(html).match(/(\d+)\s*hours?\s*notice/i);
  if (lead) for (const r of out) r.lead_time_hours = Number(lead[1]);
  return out;
}

// ---------- T3: text off a document ----------
// Ranges instead of numbers, prices that may be a season out of date, and the odd
// broken word. Everything here is an approximation and is flagged as one.
export function readT3(text, url = '', now = new Date().toISOString()) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const m = raw.match(/^\s*(.+?)\s*\.{2,}\s*serves\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*\.{2,}\s*([\d.]+)\s*$/i);
    if (!m) continue;
    const name = m[1].replace(/\s{2,}/g, ' ').trim();
    const low = Number(m[2]);
    const high = m[3] ? Number(m[3]) : low;
    out.push(record(name, {
      serves: Math.round((low + high) / 2),          // the midpoint, and it says so
      serves_range: [low, high],
      price: Number(m[4]),
      dietary: inferDiet(name), dietary_inferred: true
    }, 'T3', url, now, `document line: "${raw.trim().slice(0, 60)}"`,
      low === high ? ['dietary tags'] : ['dietary tags', `serving count (stated as ${low}-${high})`]));
  }
  return out;
}

// ---------- T4: nothing published ----------
// Not a dead end. The agent composes the inquiry, a human sends it, and the reply
// comes back into this same record shape. Slow, but the plan completes.
export function draftInquiry(need, business = {}) {
  const groups = Object.entries(need.dietary || {})
    .map(([g, n]) => `${n} ${g.replace(/_/g, ' ')}`).join(', ');
  // Read the date and time off the stated string. Converting to UTC moves a 6pm
  // dinner to 23:00 and can roll it onto the next day.
  const when = need.serveAt ? String(need.serveAt).slice(0, 10) : 'the date below';
  const at = need.serveAt ? String(need.serveAt).slice(11, 16) : null;
  const lines = [
    `Subject: Catering enquiry — ${need.headcount} people, ${when}`,
    '',
    `Hello${business.name ? ' ' + business.name : ''},`,
    '',
    `I am arranging food for ${need.headcount} people on ${when}, served at ${at || 'a time to confirm'}.`,
    groups ? `Of those, ${groups}.` : null,
    '',
    'Could you tell me:',
    '  1. whether you have that date open,',
    '  2. what you would suggest and how many each tray serves,',
    '  3. the price,',
    '  4. and what you would need me to supply or do on the day —',
    '     warming equipment, serving utensils, someone on site, collection or delivery.',
    '',
    'Question 4 is the one I most need answered, and the one nobody publishes.',
    '',
    'Thank you.'
  ].filter(l => l !== null);

  return {
    tier: 'T4',
    to: business.name || 'the business',
    body: lines.join('\n'),
    asks: ['availability', 'menu', 'servings', 'price', 'requirements'],
    round_trip: 'days',
    status: 'pending until answered'
  };
}

// ---------- the side by side ----------
// The same question, asked of the same business, at every tier it might be published at.
export function askEveryTier(question, readings) {
  return Object.entries(readings).map(([tier, reading]) => {
    const verdict = can(tier, question);
    const answered = verdict === 'yes' || verdict === 'three diets only' ||
                     verdict === 'inferred' || verdict === 'approximate' || verdict === 'partial';
    return {
      tier,
      label: TIERS[tier].label,
      how: TIERS[tier].how,
      verdict,
      answered,
      needsHuman: verdict === 'ask' || verdict === 'ask, slowly',
      items: Array.isArray(reading) ? reading.length : 0,
      roundTrip: can(tier, 'roundtrip')
    };
  });
}

// A finding is only ever as good as the weakest thing it was built on.
export function weakestSource(records = []) {
  const order = ['T4', 'T3', 'T2', 'T5', 'T1', 'T0'];
  let worst = null;
  for (const r of records) {
    const t = r?.source?.tier;
    if (!t) continue;
    if (worst === null || order.indexOf(t) < order.indexOf(worst)) worst = t;
  }
  return worst;
}
