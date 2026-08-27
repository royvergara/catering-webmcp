import assert from 'node:assert';
import test from 'node:test';
import { deriveDemand, normalizeItem, runChecks } from './engine.js';

const occasion = {
  headcount: 40,
  format: 'buffet',
  serveAt: '2026-09-12T18:00:00-05:00',
  dietary: { vegetarian: 6, gluten_free: 2 },
  hostProvides: []
};

test('demand scales past headcount for buffer and seconds', () => {
  const d = deriveDemand(occasion);
  assert.ok(d.effectiveHeadcount > 40, 'effective headcount exceeds 40');
  assert.ok(d.proteinOz > 40 * 6, 'protein exceeds naive 6oz per head');
  assert.equal(d.mainsTarget, 2);
});

test('normalize converts a serves-N claim to a common basis', () => {
  const n = normalizeItem({ claimed_serves: 20, basis_mains: 1, portion_oz: 6 });
  assert.equal(n.normalized.protein_oz, 120);
  assert.equal(n.normalized.confidence, 0.7, 'unstated basis is lower confidence');
});

test('quantity: two trays read as enough and land short', () => {
  const basket = {
    items: [
      { name: 'Chicken tray', category: 'main', claimed_serves: 20, portion_oz: 6, dietary: [] },
      { name: 'Chicken tray', category: 'main', claimed_serves: 20, portion_oz: 6, dietary: [] }
    ],
    pickups: []
  };
  const { findings } = runChecks({ basket, occasion });
  const q = findings.find(f => f.check === 'quantity');
  assert.ok(q, 'quantity finding fires');
  assert.equal(q.severity, 'blocker');
});

test('coverage counts per dietary group, not the crowd', () => {
  const basket = {
    items: [
      { name: 'Veg tray', category: 'main', claimed_serves: 4, portion_oz: 6, dietary: ['vegetarian'] }
    ],
    pickups: []
  };
  const { findings } = runChecks({ basket, occasion });
  const c = findings.find(f => f.check === 'coverage' && f.group === 'vegetarian');
  assert.ok(c, 'vegetarian shortfall fires');
  assert.match(c.message, /4 vegetarian servings for 6/);
});

test('unclaimed finds a resource nobody provides', () => {
  const basket = { items: [], pickups: [] };
  const reqs = {
    green_fork: { requires: ['warming_trays', 'serving_utensils'], provides: ['serving_utensils'] }
  };
  const { findings } = runChecks({ basket, occasion, requirementsByVendor: reqs });
  const u = findings.find(f => f.check === 'unclaimed');
  assert.ok(u, 'unclaimed fires');
  assert.deepEqual(u.resources, ['warming_trays']);
  assert.match(u.message, /warming trays/);
});

test('timing catches a hot pickup outside the safe hold window', () => {
  const basket = {
    items: [],
    pickups: [{ vendor: 'green_fork', at: '2026-09-12T14:00:00-05:00', hot: true, selfCollect: true }]
  };
  const { findings } = runChecks({ basket, occasion });
  const t = findings.find(f => f.check === 'timing');
  assert.ok(t, 'timing fires');
  assert.match(t.message, /4\.0h before service/);
});

test('timing catches one person, two pickups, twenty minutes apart', () => {
  const basket = {
    items: [],
    pickups: [
      { vendor: 'a', at: '2026-09-12T17:00:00-05:00', hot: false, selfCollect: true },
      { vendor: 'b', at: '2026-09-12T17:20:00-05:00', hot: false, selfCollect: true }
    ]
  };
  const { findings } = runChecks({ basket, occasion });
  assert.ok(findings.some(f => /One person, one car/.test(f.message)));
});

test('blockers sort ahead of risks', () => {
  const basket = {
    items: [{ name: 'Veg', category: 'main', claimed_serves: 4, portion_oz: 6, dietary: ['vegetarian'] }],
    pickups: [
      { vendor: 'a', at: '2026-09-12T17:00:00-05:00', hot: false, selfCollect: true },
      { vendor: 'b', at: '2026-09-12T17:20:00-05:00', hot: false, selfCollect: true }
    ]
  };
  const { findings } = runChecks({ basket, occasion });
  assert.equal(findings[0].severity, 'blocker');
});

// ---------- availability ----------
const bookedVendor = {
  slug: 'busy', name: 'Fully Booked Co', lead_time_hours: 48,
  blackout_dates: ['2026-09-12']
};
const freeVendor = { slug: 'free', name: 'Open Kitchen', lead_time_hours: 24, blackout_dates: [] };

test('a vendor booked on the date is caught, because their own tool says so', () => {
  const basket = { items: [], pickups: [], vendorsUsed: ['busy'] };
  const { findings } = runChecks({ basket, occasion, vendorsBySlug: { busy: bookedVendor } });
  const a = findings.find(f => f.check === 'availability');
  assert.ok(a, 'availability fires');
  assert.equal(a.severity, 'blocker');
  assert.match(a.message, /booked on 2026-09-12/);
});

test('a vendor who is free on the date raises nothing', () => {
  const basket = { items: [], pickups: [], vendorsUsed: ['free'] };
  const { findings } = runChecks({ basket, occasion, vendorsBySlug: { free: freeVendor } });
  assert.ok(!findings.some(f => f.check === 'availability'));
});

test('too little notice for the vendor lead time is caught, once we know when it was placed', () => {
  const basket = { items: [], pickups: [], vendorsUsed: ['free'] };
  const rushed = { ...occasion, placedAt: '2026-09-12T06:00:00-05:00' };   // 12h before
  const { findings } = runChecks({ basket, occasion: rushed, vendorsBySlug: { free: freeVendor } });
  const a = findings.find(f => f.check === 'availability');
  assert.ok(a, 'lead time fires');
  assert.match(a.message, /needs 24h notice and this order gives 12h/);
});

test('without an order date, lead time is not guessed at', () => {
  const basket = { items: [], pickups: [], vendorsUsed: ['free'] };
  const { findings } = runChecks({ basket, occasion, vendorsBySlug: { free: freeVendor } });
  assert.ok(!findings.some(f => f.check === 'availability'), 'no placedAt, no claim');
});

test('a vendor the planner knows nothing about is not accused of anything', () => {
  const basket = { items: [], pickups: [], vendorsUsed: ['stranger'] };
  const { findings } = runChecks({ basket, occasion, vendorsBySlug: {} });
  assert.ok(!findings.some(f => f.check === 'availability'));
});
