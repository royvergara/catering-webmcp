import assert from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { parseOccasion, assemblePlan, replan } from '../shared/plan.js';
import { diffFindings, summarizeDelta, findingKey, CHECKS, diffOccasion, describeOccasionChange } from './replan.js';
import { checkBudget } from './engine.js';

const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));

const PROMPT = '40 people, Saturday at 6, $600, 6 vegetarians, 2 gluten free, no kitchen at the venue';
const plan = () => assemblePlan(parseOccasion(PROMPT), vendors, 'pickup');

test('the budget is checked, not just parsed and forgotten', () => {
  const occasion = { budget: 600 };
  assert.deepEqual(checkBudget({ subtotal: 500 }, occasion), []);
  const over = checkBudget({ subtotal: 685 }, occasion);
  assert.equal(over[0].over, 85);
  assert.match(over[0].message, /\$85 over the \$600/);
});

test('a check with no finding either side is reported as still fine', () => {
  const d = diffFindings([], []);
  assert.deepEqual(d.stillFine.sort(), Object.keys(CHECKS).sort());
  assert.deepEqual(d.broke, []);
  assert.deepEqual(d.cleared, []);
});

test('a finding present before and after is not reported as new', () => {
  const f = { check: 'timing', severity: 'blocker', hours: 4, message: 'late' };
  const d = diffFindings([f], [{ ...f }]);
  assert.deepEqual(d.broke, []);
  assert.deepEqual(d.cleared, []);
  assert.equal(d.persisting.length, 1);
  assert.equal(d.persisting[0].worse, false);
  assert.equal(d.persisting[0].better, false);
});

test('a finding that got worse is reported as worse, not as new', () => {
  const before = { check: 'coverage', group: 'vegetarian', needed: 6, supplied: 4, message: '4 for 6' };
  const after = { check: 'coverage', group: 'vegetarian', needed: 9, supplied: 4, message: '4 for 9' };
  const d = diffFindings([before], [after]);
  assert.deepEqual(d.broke, []);
  assert.equal(d.persisting[0].worse, true);
  assert.equal(d.persisting[0].by, 3, 'short by three more than before');
});

test('one complaint whose size changed is not two complaints', () => {
  const before = { check: 'unclaimed', resources: ['a', 'b', 'c'], message: 'three jobs' };
  const after = { check: 'unclaimed', resources: ['a', 'b'], message: 'two jobs' };
  assert.equal(findingKey(before), findingKey(after), 'same complaint, different size');
  const d = diffFindings([before], [after]);
  assert.deepEqual(d.broke, [], 'not raised');
  assert.deepEqual(d.cleared, [], 'not cleared');
  assert.equal(d.persisting[0].better, true);
});

test('raising the headcount breaks the budget and nothing else', () => {
  const before = plan();
  const { plan: after, delta } = replan(before, vendors, { assumption: 'occasion.headcount', value: 55 });
  assert.equal(after.occasion.headcount, 55);
  assert.deepEqual(delta.broke.map(f => f.check), ['budget']);
  assert.ok(delta.stillFine.includes('coverage'), 'coverage survived the change');
  assert.ok(delta.stillFine.includes('quantity'), 'the order grew to keep up');
  assert.match(delta.change, /Headcount 40 -> 55/);
  assert.match(delta.cost, /Order up \$\d+/);
});

test('moving to a higher service level takes jobs off the host', () => {
  const before = plan();
  const { delta } = replan(before, vendors, { serviceLevel: 'dropoff_setup' });
  const unclaimed = delta.persisting.find(p => p.finding.check === 'unclaimed');
  assert.ok(unclaimed, 'the jobs complaint is still the same complaint');
  assert.equal(unclaimed.better, true, 'fewer jobs left unowned');
  assert.match(delta.change, /pickup -> dropoff_setup/);
});

test('a change that breaks nothing says so plainly', () => {
  const before = plan();
  const { delta } = replan(before, vendors, { assumption: 'occasion.dietary.vegetarian', value: 20 });
  assert.deepEqual(delta.broke, []);
  assert.ok(delta.lines.some(l => /Nothing broke/.test(l)));
});

test('the delta reports what moved, not the whole plan', () => {
  const before = plan();
  const { delta } = replan(before, vendors, { assumption: 'occasion.headcount', value: 55 });
  const lines = summarizeDelta(delta);
  assert.ok(lines.length <= 6, 'a delta is readable at a glance, not a re-render');
  for (const l of lines) assert.ok(l.length < 200, 'every line is one spoken sentence');
  assert.ok(!lines.some(l => /Herb chicken tray/.test(l)), 'unchanged line items are not repeated back');
});

test('replanning from a new description keeps what the user confirmed', () => {
  const before = plan();
  const { plan: corrected } = replan(before, vendors, { assumption: 'occasion.proteinOzPerPerson', value: 8 });
  const { plan: after } = replan(corrected, vendors, { description: '80 people, $2000, 6 vegetarians' });
  assert.equal(after.occasion.headcount, 80, 'the new description is read');
  assert.equal(after.occasion.proteinOzPerPerson, 8, 'the correction is not undone by a replan');
});

test('replanning does not mutate the plan it was given', () => {
  const before = plan();
  const snapshot = JSON.stringify(before);
  replan(before, vendors, { assumption: 'occasion.headcount', value: 55 });
  assert.equal(JSON.stringify(before), snapshot);
});

test('every replan reports a cost line whenever the order moved', () => {
  const before = plan();
  const { plan: after, delta } = replan(before, vendors, { assumption: 'occasion.headcount', value: 55 });
  const moved = after.basket.subtotal !== before.basket.subtotal;
  assert.equal(Boolean(delta.cost), moved);
  if (moved) assert.match(delta.cost, new RegExp(`now \\$${after.basket.subtotal}`));
});

test('every check the engine runs can be named in a delta', async () => {
  const { runChecks } = await import('./engine.js');
  const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
  const p = assemblePlan(parseOccasion(PROMPT), vendors, 'pickup');
  // anything a finding can be about must have a label, or "still fine" silently omits it
  for (const f of p.findings) {
    assert.ok(CHECKS[f.check], `${f.check} has no label, so a delta cannot report it`);
  }
  const booked = runChecks({
    basket: { items: [], pickups: [], vendorsUsed: ['x'] },
    occasion: { serveAt: '2026-09-12T18:00:00-05:00' },
    vendorsBySlug: { x: { name: 'X', blackout_dates: ['2026-09-12'] } }
  }).findings;
  assert.ok(booked.length, 'availability really can produce a finding');
  for (const f of booked) assert.ok(CHECKS[f.check], `${f.check} has no label`);
});

test('describing what a description changed reads as plain sentences', () => {
  const before = { headcount: 40, budget: 600, dietary: { vegetarian: 6 }, venueHasKitchen: false, durationHours: 3 };
  const after  = { headcount: 80, budget: 600, dietary: { vegetarian: 6 }, venueHasKitchen: false, durationHours: 3 };
  assert.deepEqual(diffOccasion(before, before), [], 'no change is no change');
  assert.equal(describeOccasionChange(diffOccasion(before, before)), 'Nothing in the description changed.');
  assert.match(describeOccasionChange(diffOccasion(before, after)), /^Read again: Headcount 40 -> 80\.$/);
});

test('a dietary group that appears or vanishes is reported', () => {
  const before = { dietary: { vegetarian: 6 } };
  const added = diffOccasion(before, { dietary: { vegetarian: 6, vegan: 3 } });
  assert.deepEqual(added, [{ label: 'vegan guests', from: '0', to: '3' }]);
  const gone = diffOccasion(before, { dietary: {} });
  assert.deepEqual(gone, [{ label: 'vegetarian guests', from: '6', to: '0' }]);
});

test('a budget change is shown as money', () => {
  const c = diffOccasion({ budget: 600 }, { budget: 1200 });
  assert.deepEqual(c, [{ label: 'Budget', from: '$600', to: '$1200' }]);
});
