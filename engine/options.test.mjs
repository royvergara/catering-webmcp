import assert from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { parseOccasion, buildOptions } from '../shared/plan.js';
import { virtues, costs, describeOption, rankOptions, distinct, justifySplit, count, SPLIT_REASONS } from './options.js';

const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));

const PROMPT = '40 people, Saturday at 6, $600, 6 vegetarians, 2 gluten free, no kitchen at the venue';
const options = () => buildOptions(parseOccasion(PROMPT), vendors, 'pickup');

const fake = (o = {}) => ({
  id: 'x', subtotal: 500, vendorCount: 1, itemCount: 3, itemIds: ['a', 'b'],
  uncovered: [], shortOz: 0, collections: 1, blockers: 0, overBudget: 0, ...o
});

test('the planner offers more than one real order', () => {
  const opts = options();
  assert.ok(opts.length >= 2, 'a choice needs at least two things to choose between');
  assert.ok(opts.length <= 3, 'three is the most a person will actually weigh');
});

test('no two options are the same order wearing different labels', () => {
  const sigs = options().map(o => [...o.itemIds].sort().join('|'));
  assert.equal(new Set(sigs).size, sigs.length, 'options must differ in what you buy');
});

test('every option says what it is good at or what it costs you', () => {
  for (const o of options()) {
    assert.ok(o.virtues.length + o.costs.length > 0, `${o.id} states nothing`);
    assert.ok(o.summary.length > 15, `${o.id} has no readable summary`);
    assert.match(o.summary, /^\w+ vendors?, \$\d+/, 'summary leads with vendors and price');
  }
});

test('an order that feeds nobody is never offered', () => {
  // sweet-bench is a bakery: alone it composes an empty basket
  assert.ok(options().every(o => o.itemCount > 0));
});

test('the recommended option is the one that covers the people', () => {
  const opts = options();
  const anyCovers = opts.some(o => !o.uncovered.length);
  const top = opts.find(o => o.recommended);
  assert.equal(top.rank, 1);
  if (anyCovers) assert.deepEqual(top.uncovered, [], 'never recommend leaving guests out');
});

test('a split is justified out loud by one of the six reasons', () => {
  for (const o of options().filter(x => x.vendorCount > 1)) {
    assert.ok(o.split, 'a split must carry a justification');
    assert.ok(SPLIT_REASONS.includes(o.split.reason), `${o.split.reason} is not one of the six`);
    assert.ok(o.split.says.length > 20, 'and must say it in words');
  }
});

test('a single-vendor order needs no justification', () => {
  for (const o of options().filter(x => x.vendorCount === 1)) assert.equal(o.split, null);
});

test('a split nothing justifies is reported as unjustified, not excused', () => {
  const chosen = fake({ id: 'split', vendorCount: 2, subtotal: 500 });
  const single = fake({ id: 'single', vendorCount: 1, subtotal: 500 });
  const j = justifySplit(chosen, [chosen, single]);
  assert.equal(j.reason, null);
  assert.match(j.says, /nothing here justifies a split/);
});

test('coverage justifies a split ahead of anything else', () => {
  const chosen = fake({ id: 'split', vendorCount: 2 });
  const single = fake({ id: 'single', vendorCount: 1, uncovered: [{ group: 'gluten_free', needed: 2, served: 0, short: 2 }] });
  const j = justifySplit(chosen, [chosen, single]);
  assert.equal(j.reason, 'coverage');
  assert.match(j.says, /two gluten free guests/);
});

test('a burden every option shares is not offered as a difference between them', () => {
  const all = [fake({ id: 'a', blockers: 2 }), fake({ id: 'b', blockers: 2 })];
  for (const o of all) assert.ok(!costs(o, all).some(c => /blocker/.test(c)), 'shared blockers are not a tradeoff');

  const differing = [fake({ id: 'a', blockers: 2 }), fake({ id: 'b', blockers: 4 })];
  assert.ok(costs(differing[1], differing).some(c => /blocker/.test(c)), 'differing blockers are');
});

test('what an option leaves undone is counted, not hinted at', () => {
  const o = fake({ uncovered: [{ group: 'gluten_free', needed: 2, served: 0, short: 2 }], shortOz: 85, overBudget: 40 });
  const c = costs(o);
  assert.ok(c.some(x => x === 'leaves two gluten free guests uncovered'));
  assert.ok(c.some(x => x === '85 oz short of the volume target'));
  assert.ok(c.some(x => x === '$40 over your budget'));
});

test('the vendor count is never said twice in one summary', () => {
  const all = [fake({ id: 'a', vendorCount: 1 }), fake({ id: 'b', vendorCount: 2 })];
  const d = describeOption(all[0], all);
  assert.equal((d.summary.match(/one vendor/g) || []).length, 1);
});

test('ranking is deterministic whatever order the options arrive in', () => {
  const set = [fake({ id: 'a', subtotal: 400 }), fake({ id: 'b', subtotal: 300 }), fake({ id: 'c', blockers: 1 })];
  assert.deepEqual(rankOptions(set).map(o => o.id), rankOptions([...set].reverse()).map(o => o.id));
});

test('covering the people outranks being cheap', () => {
  const cheap = fake({ id: 'cheap', subtotal: 100, uncovered: [{ group: 'vegan', needed: 4, served: 0, short: 4 }] });
  const sound = fake({ id: 'sound', subtotal: 900 });
  assert.equal(rankOptions([cheap, sound])[0].id, 'sound');
});

test('duplicate orders collapse to one', () => {
  const a = fake({ id: 'a', itemIds: ['x', 'y'] });
  const b = fake({ id: 'b', itemIds: ['y', 'x'] });
  assert.equal(distinct([a, b]).length, 1, 'same items in a different order is the same order');
});

test('small numbers read as words, the way a person would say them', () => {
  assert.equal(count(0), 'no');
  assert.equal(count(2), 'two');
  assert.equal(count(11), '11');
});

test('building options does not mutate the occasion or the vendors', () => {
  const occasion = parseOccasion(PROMPT);
  const snapshot = JSON.stringify({ occasion, vendors });
  buildOptions(occasion, vendors, 'pickup');
  assert.equal(JSON.stringify({ occasion, vendors }), snapshot);
});

test('each option is a whole plan, carrying its own findings and ownership', () => {
  for (const o of options()) {
    assert.ok(Array.isArray(o.plan.findings), `${o.id} has findings`);
    assert.ok(o.plan.basket.items.length, `${o.id} has a basket`);
    assert.ok(o.plan.assumptions.length, `${o.id} carries its assumptions`);
  }
});

test('the option you picked survives a correction', async () => {
  const { assemblePlan, revisePlan, replan } = await import('../shared/plan.js');
  const occasion = parseOccasion(PROMPT);
  const single = buildOptions(occasion, vendors, 'pickup').find(o => o.vendorCount === 1);
  assert.ok(single, 'there is a single-vendor option to pick');

  const corrected = revisePlan(single.plan, vendors, 'occasion.headcount', 45);
  assert.deepEqual(corrected.compose, single.plan.compose, 'the strategy is remembered');
  assert.equal(corrected.basket.vendorsUsed.length, 1, 'still the one vendor you chose');

  const later = replan(corrected, vendors, { serviceLevel: 'delivery' }).plan;
  assert.equal(later.basket.vendorsUsed.length, 1, 'and through a replan too');
});
