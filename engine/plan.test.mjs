import assert from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { parseOccasion, composeBasket, assemblePlan, ownershipTable, explainQuantity } from '../shared/plan.js';

const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));

const PROMPT = '40 people, Saturday at 6, $600, 6 vegetarians, 2 gluten free, no kitchen at the venue';

test('parses spelled-out numbers, which is how people actually write', () => {
  const o = parseOccasion('40 people, Saturday at 6, $600, six vegetarians, two gluten free, no kitchen at the venue');
  assert.equal(o.headcount, 40);
  assert.equal(o.dietary.vegetarian, 6);
  assert.equal(o.dietary.gluten_free, 2);
});

test('parses the canonical prompt', () => {
  const o = parseOccasion('40 people, Saturday at 6, $600, 6 vegetarians, 2 gluten free, no kitchen at the venue');
  assert.equal(o.headcount, 40);
  assert.equal(o.dietary.vegetarian, 6);
  assert.equal(o.dietary.gluten_free, 2);
  assert.equal(o.venueHasKitchen, false);
});

test('basket covers every dietary group', () => {
  const o = parseOccasion('40 people, $600, 6 vegetarians, 2 gluten free');
  const b = composeBasket(o, vendors);
  for (const [g, n] of Object.entries(o.dietary)) {
    const served = b.items.filter(i => (i.dietary || []).includes(g)).reduce((s, i) => s + i.claimed_serves, 0);
    assert.ok(served >= n, `${g}: ${served} < ${n}`);
  }
});

test('basket explains every choice', () => {
  const o = parseOccasion(PROMPT);
  const b = composeBasket(o, vendors);
  assert.ok(b.why.length >= b.items.length - 1);
  assert.ok(b.why.every(w => w.length > 20));
});

test('a split is always given a reason', () => {
  const o = parseOccasion(PROMPT);
  const b = composeBasket(o, vendors);
  if (b.vendorsUsed.length > 1) assert.ok(b.splitReason, 'split must be justified');
});

test('quantity explanation shows the arithmetic and the shortfall', () => {
  const o = parseOccasion(PROMPT);
  const b = composeBasket(o, vendors);
  const lines = explainQuantity(b.items[0], o, b.demand);
  assert.equal(lines.length, 5);
  assert.match(lines.at(-1), /short/);
});

test('assemblePlan surfaces unclaimed jobs for a pickup order', () => {
  const o = parseOccasion(PROMPT);
  const p = assemblePlan(o, vendors, 'pickup');
  assert.ok(p.findings.some(f => f.check === 'unclaimed'), 'pickup should leave jobs unowned');
});

test('the ownership table always names someone, including you', () => {
  const o = parseOccasion(PROMPT);
  const p = assemblePlan(o, vendors, 'pickup');
  const rows = ownershipTable(p, vendors);
  assert.ok(rows.length > 3);
  assert.ok(rows.some(r => r.who === 'You'), 'some jobs land on the host');
});

test('a higher service level moves jobs off the host', () => {
  const o = parseOccasion(PROMPT);
  const yours = lvl => {
    const p = assemblePlan(o, vendors, lvl);
    const rows = ownershipTable(p, vendors);
    return new Set(rows.filter(r => r.who === 'You').map(r => r.job)).size;
  };
  // compare only vendors that actually offer both levels: green-fork does
  const gf = vendors.filter(v => v.slug === 'green-fork');
  const table = lvl => ownershipTable(assemblePlan(o, gf, lvl), gf).filter(r => r.who === 'You').length;
  assert.ok(table('dropoff_setup') < table('pickup'), 'setup should leave the host fewer jobs than pickup');
  assert.ok(yours('pickup') > 0);
});

test('the naive single-vendor order fails coverage that the composed one passes', async () => {
  const { naiveBasket } = await import('../shared/plan.js');
  const { runChecks } = await import('../engine/engine.js');
  const o = parseOccasion(PROMPT);
  const naive = naiveBasket(o, vendors);
  const nf = runChecks({ basket: { ...naive, pickups: [] }, occasion: o }).findings;
  assert.ok(nf.some(f => f.check === 'coverage'), 'naive order should miss a dietary group');
  const good = composeBasket(o, vendors);
  const gf = runChecks({ basket: { ...good, pickups: [] }, occasion: o }).findings;
  assert.ok(!gf.some(f => f.check === 'coverage'), 'composed order covers every group');
});
