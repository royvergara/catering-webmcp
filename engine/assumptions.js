// Pure, dependency-free. No DOM, no fetch. Everything here is unit-testable.
//
// Every number the plan rests on that was inferred rather than stated by a vendor.
// The agent proposes, the person corrects, the plan improves. A corrected value is
// marked confirmed and is never silently overwritten by a later run.

export const ASSUMPTION_DEFAULTS = {
  proteinOzPerPerson: 6,
  bufferPct: 0.15,
  secondsRate: 0.35,
  durationHours: 3
};

// How much to trust a value by where it came from.
// `given` outranks `parsed`: a field the caller passed was understood before it got
// here, rather than recovered from prose by a deliberately shallow reader. It still
// sits below `user`, which is a person saying so on the page.
export const CONFIDENCE = { default: 0.6, vendor: 0.7, parsed: 0.8, given: 0.9, user: 1 };

// ---------- immutable path helpers ----------
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const [head, ...rest] = path.split('.');
  if (!rest.length) return { ...obj, [head]: value };
  return { ...obj, [head]: setPath(obj[head] || {}, rest.join('.'), value) };
}

function coerce(assumption, value) {
  if (assumption.type === 'boolean') return Boolean(value);
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${assumption.id}: ${value} is not a number`);
  if (n < 0) throw new Error(`${assumption.id}: cannot be negative`);
  return n;
}

const record = (id, label, value, o = {}) => ({
  id,
  label,
  value,
  unit: o.unit || '',
  type: typeof value === 'boolean' ? 'boolean' : 'number',
  scope: o.scope || 'occasion',
  field: o.field,
  target: o.target || null,
  basis: o.basis || '',
  source: o.source || 'default',
  confidence: CONFIDENCE[o.source || 'default'],
  confirmed: false
});

// ---------- derive ----------
// Read the current plan back out as a list of editable assumptions.
export function deriveAssumptions(occasion, basket = { items: [] }) {
  const d = ASSUMPTION_DEFAULTS;
  // A value the parser did not actually find is a default wearing a parsed value's
  // clothes. Say which it is, so the person can see what was never really stated.
  const read = field => occasion.found?.[field] !== false;
  const gave = field => (occasion.given || []).includes(field);
  const from = (field, stated, assumed) => (gave(field)
    ? { source: 'given', basis: 'supplied by the caller, not read from the description' }
    : { source: read(field) ? 'parsed' : 'default', basis: read(field) ? stated : assumed });

  const out = [
    record('occasion.headcount', 'Headcount', occasion.headcount, {
      unit: 'guests', field: 'headcount',
      ...from('headcount', 'read from your description', 'nobody said how many people; assumed')
    }),
    record('occasion.budget', 'Budget', occasion.budget, {
      unit: '$', field: 'budget',
      ...from('budget', 'read from your description', 'no budget stated; assumed')
    }),
    record('occasion.proteinOzPerPerson', 'Main per person', occasion.proteinOzPerPerson ?? d.proteinOzPerPerson, {
      unit: 'oz', field: 'proteinOzPerPerson', source: 'default',
      basis: 'standard buffet portion, not stated by anyone'
    }),
    record('occasion.bufferPct', 'Buffer over headcount', occasion.bufferPct ?? d.bufferPct, {
      unit: 'share', field: 'bufferPct', source: 'default',
      basis: '10-15% is the usual margin'
    }),
    record('occasion.secondsRate', 'Guests taking seconds', occasion.secondsRate ?? d.secondsRate, {
      unit: 'share', field: 'secondsRate', source: 'default',
      basis: '30-40% go back for more at a buffet'
    }),
    record('occasion.durationHours', 'Hours of service', occasion.durationHours ?? d.durationHours, {
      unit: 'hours', field: 'durationHours', source: 'default',
      basis: 'assumed from the occasion, rarely stated'
    })
  ];

  for (const [group, count] of Object.entries(occasion.dietary || {})) {
    out.push(record(`occasion.dietary.${group}`, `${group.replace(/_/g, ' ')} guests`, count, {
      unit: 'guests', field: `dietary.${group}`, source: gave('dietary') ? 'given' : 'parsed',
      basis: 'counted from your description'
    }));
  }

  out.push(record('occasion.venueHasKitchen', 'Kitchen at the venue', !!occasion.venueHasKitchen, {
    field: 'venueHasKitchen', source: gave('venueHasKitchen') ? 'given' : 'parsed',
    basis: 'inferred from your description'
  }));

  // Item-level: a serving count nobody explained, and an approximate one read off a PDF.
  const seen = new Set();
  for (const item of basket.items || []) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    const from = item.vendorName || item.vendor || 'the vendor';
    // Report what the vendor claims, even where the person has already corrected it,
    // so a correction can be shown against the claim it overrode.
    const claimed = f => item.vendor_stated?.[f] ?? item[f];
    if (!item.basis_stated) {
      out.push(record(`item.${item.id}.basis_mains`, `${item.name}: dishes that count assumes`, claimed('basis_mains') ?? 1, {
        unit: 'mains', scope: 'item', field: 'basis_mains', target: item.id, source: 'vendor',
        basis: `${from} does not say what "serves ${item.claimed_serves}" assumes`
      }));
    }
    if (item.tier === 'T3' || (item.confidence !== undefined && item.confidence < 0.7)) {
      out.push(record(`item.${item.id}.claimed_serves`, `${item.name}: servings claimed`, claimed('claimed_serves'), {
        unit: 'servings', scope: 'item', field: 'claimed_serves', target: item.id, source: 'vendor',
        basis: `read off ${from}'s PDF menu, approximate`
      }));
    }
  }

  return out;
}

// ---------- apply ----------
// Push assumption values back onto the occasion and the vendor menus, so everything
// downstream recomputes from the corrected numbers. Never mutates its inputs.
export function applyAssumptions(occasion, vendors = [], list = []) {
  let o = occasion;
  const patches = new Map();

  for (const a of list) {
    if (!a || a.value === undefined || a.value === null) continue;
    // Only what the person confirmed is sticky. An unconfirmed assumption is just a
    // reading of the current plan, and pinning it would freeze a stale number.
    if (!a.confirmed) continue;
    if (a.scope === 'item') {
      const p = patches.get(a.target) || {};
      p[a.field] = a.value;
      p.basis_confirmed = true;   // promoted from assumed to confirmed
      patches.set(a.target, p);
    } else {
      o = setPath(o, a.field, a.value);
    }
  }

  const v = patches.size
    ? vendors.map(vd => ({
        ...vd,
        menu: (vd.menu || []).map(i => {
          if (!patches.has(i.id)) return i;
          const p = patches.get(i.id);
          // keep what the vendor originally claimed, so the plan can show both
          const stated = {};
          for (const k of Object.keys(p)) {
            if (k !== 'basis_confirmed' && i[k] !== undefined && i[k] !== p[k]) stated[k] = i[k];
          }
          return { ...i, ...p, vendor_stated: { ...(i.vendor_stated || {}), ...stated } };
        })
      }))
    : vendors;

  return { occasion: o, vendors: v };
}

// ---------- revise ----------
export function reviseAssumption(list, id, value) {
  const target = list.find(a => a.id === id);
  if (!target) throw new Error(`unknown assumption: ${id}`);
  const next = coerce(target, value);
  return list.map(a => (a.id === id
    ? { ...a, value: next, source: 'user', confidence: CONFIDENCE.user, confirmed: true, contested: undefined, basis: 'confirmed by you' }
    : a));
}

// ---------- carry ----------
// A re-run re-derives every assumption. Anything the person confirmed keeps their
// value. Where the fresh derivation disagrees, the disagreement is recorded rather
// than resolved: their number stands, and the plan says what it would otherwise be.
export function carryConfirmed(fresh, prior = []) {
  const held = new Map(prior.filter(a => a.confirmed).map(a => [a.id, a]));
  return fresh.map(f => {
    const k = held.get(f.id);
    if (!k) return f;
    // A default has no competing claim behind it, so it can never contest a correction.
    if (f.source === 'default' || k.value === f.value) return { ...k, contested: undefined };
    return { ...k, contested: f.value };
  });
}

export const assumptionById = (list, id) => list.find(a => a.id === id);
export const contested = list => list.filter(a => a.contested !== undefined);
export { getPath as _getPath };
