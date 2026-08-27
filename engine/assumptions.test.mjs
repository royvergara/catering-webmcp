import assert from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { parseOccasion, assemblePlan, revisePlan } from '../shared/plan.js';
import {
  deriveAssumptions, applyAssumptions, reviseAssumption, carryConfirmed, assumptionById, contested
} from './assumptions.js';

const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));

const PROMPT = '40 people, Saturday at 6, $600, 6 vegetarians, 2 gluten free, no kitchen at the venue';
const plan = () => assemblePlan(parseOccasion(PROMPT), vendors, 'pickup');

test('every assumption says where its value came from', () => {
  const p = plan();
  assert.ok(p.assumptions.length > 5, 'the plan rests on more than a handful');
  for (const a of p.assumptions) {
    assert.ok(a.basis.length > 10, `${a.id} needs a stated basis`);
    assert.ok(['default', 'parsed', 'vendor', 'user'].includes(a.source), `${a.id} source`);
    assert.ok(a.confidence > 0 && a.confidence <= 1, `${a.id} confidence`);
  }
});

test('a serving count nobody explained is exposed as editable, not silently trusted', () => {
  const p = plan();
  const unstated = p.basket.items.find(i => !i.basis_stated);
  assert.ok(unstated, 'the demo basket contains an item with an unstated basis');
  const a = assumptionById(p.assumptions, `item.${unstated.id}.basis_mains`);
  assert.ok(a, 'its basis is an assumption');
  assert.equal(a.source, 'vendor');
  assert.match(a.basis, /does not say/);
});

test('correcting the headcount recomputes demand downstream', () => {
  const before = plan();
  const after = revisePlan(before, vendors, 'occasion.headcount', 55);
  assert.equal(after.occasion.headcount, 55);
  assert.ok(after.basket.demand.proteinOz > before.basket.demand.proteinOz,
    'more guests must mean more food');
});

test('correcting how much each person eats recomputes demand downstream', () => {
  const before = plan();
  const after = revisePlan(before, vendors, 'occasion.proteinOzPerPerson', 9);
  assert.ok(after.basket.demand.proteinOz > before.basket.demand.proteinOz);
  assert.ok(after.basket.subtotal >= before.basket.subtotal, 'and a basket that reflects it');
});

test('a corrected value is marked confirmed by the user', () => {
  const p = revisePlan(plan(), vendors, 'occasion.headcount', 55);
  const a = assumptionById(p.assumptions, 'occasion.headcount');
  assert.equal(a.confirmed, true);
  assert.equal(a.source, 'user');
  assert.equal(a.confidence, 1);
  assert.match(a.basis, /confirmed by you/);
});

test('a re-run does not overwrite a confirmed value', () => {
  const corrected = revisePlan(plan(), vendors, 'occasion.headcount', 55);
  // the same description parsed again: it still says 40 people
  const rerun = assemblePlan(parseOccasion(PROMPT), vendors, 'pickup', { assumptions: corrected.assumptions });
  const a = assumptionById(rerun.assumptions, 'occasion.headcount');
  assert.equal(a.value, 55, 'the correction stands');
  assert.equal(a.confirmed, true);
  assert.equal(rerun.occasion.headcount, 55, 'and the plan is built on it');
});

test('a re-run records the disagreement rather than resolving it', () => {
  const corrected = revisePlan(plan(), vendors, 'occasion.headcount', 55);
  const rerun = assemblePlan(parseOccasion(PROMPT), vendors, 'pickup', { assumptions: corrected.assumptions });
  const a = assumptionById(rerun.assumptions, 'occasion.headcount');
  assert.equal(a.contested, 40, 'the description still says 40, and the plan says so');
  assert.ok(contested(rerun.assumptions).some(x => x.id === 'occasion.headcount'));
});

test('an unconfirmed assumption is refreshed by a re-run', () => {
  const first = plan();
  const rerun = assemblePlan(parseOccasion('55 people, $600, 6 vegetarians'), vendors, 'pickup',
    { assumptions: first.assumptions });
  const a = assumptionById(rerun.assumptions, 'occasion.headcount');
  assert.equal(a.value, 55, 'nobody confirmed 40, so the new description wins');
  assert.equal(a.confirmed, false);
  assert.equal(a.contested, undefined);
});

test('confirming a tray basis promotes it from assumed to confirmed', () => {
  const before = plan();
  const item = before.basket.items.find(i => !i.basis_stated);
  const after = revisePlan(before, vendors, `item.${item.id}.basis_mains`, 3);
  const corrected = after.basket.items.find(i => i.id === item.id);
  assert.ok(corrected, 'the item survives the recompute');
  assert.equal(corrected.basis_mains, 3);
  assert.equal(corrected.confidence, 1, 'a basis you checked outranks one merely stated');
  assert.ok(corrected.oz > item.oz, 'and the normalized quantity moves with it');
});

test('applying assumptions never mutates the occasion or the vendor data', () => {
  const occasion = parseOccasion(PROMPT);
  const snapshot = JSON.stringify({ occasion, vendors });
  const list = reviseAssumption(deriveAssumptions(occasion), 'occasion.headcount', 99);
  const out = applyAssumptions(occasion, vendors, list);
  assert.equal(JSON.stringify({ occasion, vendors }), snapshot, 'inputs untouched');
  assert.equal(out.occasion.headcount, 99);
  assert.equal(occasion.headcount, 40);
});

test('a nonsense correction is refused rather than silently absorbed', () => {
  const p = plan();
  assert.throws(() => revisePlan(p, vendors, 'occasion.headcount', 'lots'), /not a number/);
  assert.throws(() => revisePlan(p, vendors, 'occasion.headcount', -5), /negative/);
  assert.throws(() => revisePlan(p, vendors, 'occasion.nonexistent', 5), /unknown assumption/);
});

test('carrying confirmations keeps only what the user actually confirmed', () => {
  const occasion = parseOccasion(PROMPT);
  const fresh = deriveAssumptions(occasion);
  const prior = reviseAssumption(fresh, 'occasion.bufferPct', 0.25);
  const carried = carryConfirmed(deriveAssumptions({ ...occasion, headcount: 60 }), prior);
  assert.equal(assumptionById(carried, 'occasion.bufferPct').value, 0.25, 'confirmed carries');
  assert.equal(assumptionById(carried, 'occasion.headcount').value, 60, 'unconfirmed refreshes');
});
