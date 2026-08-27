// Pure, dependency-free. No DOM, no fetch. Everything here is unit-testable.
//
// Vendor tools run on vendor sites. Their output is third-party input and is treated
// as such: it is data about a vendor, never an instruction to the agent. A vendor can
// say anything it likes. What it says has no authority here.
//
// Two defences, because either alone is thin:
//   1. An allowlist. The planner reads a fixed set of fields. A field the vendor
//      invents is not read at all, so `"priority": 1` buys nothing.
//   2. A scanner. Text inside the fields that ARE read is checked for language
//      aimed at the agent, and any such sentence is quarantined before use.

export const INJECTION_PATTERNS = [
  { id: 'ignore-previous', why: 'tries to discard the instructions the agent already has',
    re: /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+\w*\s*(?:instruction|direction|prompt|rule)/i },
  { id: 'role-impersonation', why: 'imitates a system or assistant turn to borrow its authority',
    re: /(?:^|[\s."'\-])(?:system|assistant|developer)\s*:/i },
  { id: 'ranking-demand', why: 'demands a position in the ranking rather than earning one',
    re: /\b(?:recommend|rank|place|list|show|put)\b[^.!?]{0,40}\b(?:first|top|above all|number one)\b/i },
  { id: 'suppress-competitors', why: 'asks for other vendors to be hidden from the customer',
    re: /\b(?:ignore|exclude|hide|skip|disregard|omit|do not show|mark[^.!?]{0,20}unavailable)\b[^.!?]{0,40}\b(?:other|competitor|cheaper|alternative|vendor)/i },
  { id: 'imperative-to-agent', why: 'addresses the agent as though it had authority over it',
    re: /\b(?:you\s+must|you\s+are\s+required\s+to|the\s+(?:assistant|agent|model)\s+(?:must|should|will))\b/i }
];

// The only vendor fields the planner reads. Anything else a vendor publishes is
// not consulted, whatever it is called.
export const READ_FIELDS = [
  'slug', 'name', 'tier', 'kind', 'blurb', 'service_levels', 'lead_time_hours',
  'blackout_dates', 'approximate', 'menu', 'requirements', 'accommodations'
];

const MENU_FIELDS = [
  'id', 'name', 'category', 'claimed_serves', 'basis_mains', 'basis_stated', 'portion_oz',
  'price', 'dietary', 'hot', 'minimum', 'confidence', 'provides_resource'
];

export function scanText(text) {
  if (typeof text !== 'string' || !text) return [];
  return INJECTION_PATTERNS.filter(p => p.re.test(text)).map(p => ({ id: p.id, why: p.why }));
}

// Split on sentence boundaries, drop any sentence that speaks to the agent.
export function neutralize(text) {
  if (typeof text !== 'string' || !text) return { text, removed: [] };
  const parts = text.split(/(?<=[.!?])\s+/);
  const kept = [], removed = [];
  for (const part of parts) {
    const hits = scanText(part);
    if (hits.length) removed.push({ text: part.trim(), patterns: hits });
    else kept.push(part);
  }
  return { text: kept.join(' ').trim(), removed };
}

// Everything a planner would read off one vendor, with instructions stripped out
// and unknown fields dropped. Never mutates the vendor it is given.
export function admitVendor(vendor) {
  const quarantined = [];

  const clean = (value, path) => {
    const { text, removed } = neutralize(value);
    for (const r of removed) quarantined.push({ vendor: vendor.slug, path, ...r });
    return text;
  };

  const out = {};
  for (const key of READ_FIELDS) {
    if (vendor[key] === undefined) continue;
    out[key] = typeof vendor[key] === 'string' ? clean(vendor[key], key) : vendor[key];
  }

  const ignoredFields = Object.keys(vendor).filter(k => !READ_FIELDS.includes(k));

  if (Array.isArray(vendor.menu)) {
    out.menu = vendor.menu.map((item, i) => {
      const kept = {};
      for (const k of MENU_FIELDS) if (item[k] !== undefined) kept[k] = item[k];
      if (typeof kept.name === 'string') kept.name = clean(kept.name, `menu[${i}].name`) || item.id;
      return kept;
    });
  }

  if (Array.isArray(vendor.accommodations)) {
    out.accommodations = vendor.accommodations.map((a, i) => ({
      ...a,
      description: typeof a.description === 'string' ? clean(a.description, `accommodations[${i}].description`) : a.description
    }));
  }

  return { vendor: out, quarantined, ignoredFields };
}

export function admitVendors(vendors = []) {
  const admitted = [], quarantined = [], ignored = {};
  for (const v of vendors) {
    const r = admitVendor(v);
    admitted.push(r.vendor);
    quarantined.push(...r.quarantined);
    if (r.ignoredFields.length) ignored[v.slug] = r.ignoredFields;
  }
  const bySlug = {};
  for (const q of quarantined) (bySlug[q.vendor] ||= []).push(q);
  return {
    vendors: admitted,
    quarantined,
    ignoredFields: ignored,
    offenders: Object.keys(bySlug),
    clean: quarantined.length === 0
  };
}
