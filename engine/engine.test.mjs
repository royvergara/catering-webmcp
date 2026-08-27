import assert from 'node:assert';
import test from 'node:test';
import { deriveDemand, normalizeItem, runChecks, unmetObligations, checkUnclaimed } from './engine.js';

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

// ---------- obligations are scoped ----------
test('an obligation that pools is met once, by whoever covers it', () => {
  const reqs = {
    a: { requires: ['warming_trays', 'fuel'], provides: ['food'] },
    b: { requires: [], provides: ['warming_trays'] }
  };
  const { pooled, perVendor } = unmetObligations(reqs, {});
  assert.deepEqual(pooled, ['fuel'], 'b brought the chafers, so they are not still missing');
  assert.deepEqual(perVendor, []);
});

test('collecting from one vendor is not covered by another vendor delivering', () => {
  const reqs = {
    drives_itself: { requires: [], provides: ['food', 'transport'] },
    you_collect:   { requires: ['transport'], provides: ['food'] }
  };
  const { pooled, perVendor } = unmetObligations(reqs, {});
  assert.deepEqual(pooled, [], 'nothing pooled is missing');
  assert.deepEqual(perVendor, [{ resource: 'transport', vendor: 'you_collect' }],
    'you still have to drive to the one that does not deliver');
});

test('a vendor that delivers its own food owes nobody a lift', () => {
  const reqs = { solo: { requires: ['transport'], provides: ['transport'] } };
  assert.deepEqual(unmetObligations(reqs, {}).perVendor, []);
});

test('what the host already has covers the obligation, pooled or not', () => {
  const reqs = { a: { requires: ['transport', 'warming_trays'], provides: [] } };
  const covered = unmetObligations(reqs, { hostProvides: ['transport', 'warming_trays'] });
  assert.deepEqual(covered.pooled, []);
  assert.deepEqual(covered.perVendor, []);
});

test('the unclaimed finding names the vendor a per-vendor gap belongs to', () => {
  const reqs = { masa: { requires: ['transport'], provides: ['food'] } };
  const [f] = checkUnclaimed({ items: [] }, reqs, {});
  assert.match(f.message, /transport for masa/);
  assert.equal(f.perVendor.length, 1);
});

test('the ownership table and the unclaimed check never disagree about who owes what', async () => {
  const { parseOccasion, assemblePlan, ownershipTable } = await import('../shared/plan.js');
  const { readdirSync, readFileSync } = await import('node:fs');
  const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
  const o = parseOccasion('40 people, $600, 6 vegetarians, 2 gluten free');

  for (const lvl of ['pickup', 'delivery', 'dropoff_setup']) {
    const plan = assemblePlan(o, vendors, lvl);
    const rows = ownershipTable(plan, vendors);
    const finding = plan.findings.find(f => f.check === 'unclaimed');
    const yoursPooled = new Set(rows.filter(r => r.who === 'You' && !r.for).map(r => r.job));

    for (const r of (finding?.resources || [])) {
      assert.ok(yoursPooled.has(r), `${lvl}: ${r} is unclaimed but the table does not give it to you`);
    }
    // and nothing is both somebody's job and yours at the same scope
    for (const row of rows.filter(r => r.who !== 'You')) {
      assert.ok(!yoursPooled.has(row.job),
        `${lvl}: ${row.job} is listed as both ${row.who}'s and yours`);
    }
  }
});
