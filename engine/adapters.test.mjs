import assert from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  TIERS, CAPABILITIES, can, readT0, readT1, readT2, readT3,
  draftInquiry, askEveryTier, weakestSource
} from './adapters.js';

const NOW = '2026-08-27T12:00:00Z';
const vendor = JSON.parse(readFileSync('data/vendors/green-fork.json', 'utf8'));
const t1 = () => readT1(readFileSync('data/sources/green-fork.t1.jsonld', 'utf8'), 'https://example.invalid/gf', NOW);
const t2 = () => readT2(readFileSync('data/sources/green-fork.t2.html', 'utf8'), 'https://example.invalid/gf/catering', NOW);
const t3 = () => readT3(readFileSync('data/sources/green-fork.t3.txt', 'utf8'), 'https://example.invalid/gf.pdf', NOW);

test('the same business published four ways is read four ways', () => {
  for (const [name, recs] of Object.entries({ T0: readT0(vendor, NOW), T1: t1(), T2: t2(), T3: t3() })) {
    assert.equal(recs.length, 3, `${name} should find all three trays`);
    assert.ok(recs.every(r => r.item), `${name} names every item`);
  }
});

test('every record carries where it came from and when', () => {
  for (const recs of [readT0(vendor, NOW), t1(), t2(), t3()]) {
    for (const r of recs) {
      assert.ok(TIERS[r.source.tier], 'a known tier');
      assert.equal(r.source.fetched_at, NOW, 'dated, so stale data reads as stale');
      assert.ok(r.source.evidence.length > 5, 'and says what it read');
      assert.ok(r.source.confidence >= 0 && r.source.confidence <= 1);
    }
  }
});

test('confidence falls as the source gets worse', () => {
  const c = t => t[0].source.confidence;
  assert.ok(c(readT0(vendor, NOW)) > c(t1()));
  assert.ok(c(t1()) > c(t2()));
  assert.ok(c(t2()) > c(t3()));
});

test('schema.org carries no serving count, and the gap is named not filled', () => {
  for (const r of t1()) {
    assert.equal(r.serves, null, 'schema.org MenuItem has no serving property');
    assert.ok(r.assumed.includes('serving count'), 'so it is listed as assumed');
  }
});

test('schema.org carries the three diets it actually defines', () => {
  const veg = t1().find(r => /vegetable/i.test(r.item));
  assert.deepEqual(veg.dietary.sort(), ['gluten_free', 'vegetarian']);
  assert.equal(veg.dietary_inferred, false, 'these were stated, not guessed');
  assert.match(veg.source.evidence, /suitableForDiet/);
});

test('a price table gives servings but loses the dietary tags', () => {
  const recs = t2();
  assert.deepEqual(recs.map(r => r.serves), [20, 10, 25], 'servings are stated in the table');
  for (const r of recs) {
    assert.ok(r.assumed.includes('dietary tags'));
    assert.equal(r.dietary_inferred, true, 'anything here was guessed from the name');
  }
  // the real cost of dropping a tier: the gluten free guest cannot be served from this
  const chicken = recs.find(r => /chicken/i.test(r.item));
  assert.deepEqual(chicken.dietary, [], 'the gluten free tag is simply gone');
});

test('a price table still yields the lead time printed beside it', () => {
  assert.ok(t2().every(r => r.lead_time_hours === 48));
});

test('a document gives an approximation, and flags itself as one', () => {
  const recs = t3();
  for (const r of recs) {
    assert.equal(r.flagged, true, 'low enough confidence that a human should confirm');
    assert.ok(Array.isArray(r.serves_range), 'the range it actually printed is kept');
    assert.ok(r.serves >= r.serves_range[0] && r.serves <= r.serves_range[1], 'and the midpoint sits inside it');
  }
  const chicken = recs.find(r => /chicken/i.test(r.item));
  assert.deepEqual(chicken.serves_range, [18, 20]);
  assert.ok(chicken.assumed.some(a => /stated as 18-20/.test(a)));
});

test('a document that is a season out of date disagrees with the live source, visibly', () => {
  const live = readT0(vendor, NOW).find(r => /chicken/i.test(r.item));
  const doc = t3().find(r => /chicken/i.test(r.item));
  assert.notEqual(doc.price, live.price, 'the PDF price is stale');
  assert.ok(doc.source.confidence < live.source.confidence, 'and is trusted less because of where it came from');
});

test('broken words in scanned text do not become part of an item name', () => {
  assert.ok(t3().every(r => !/\s{2,}/.test(r.item)), 'double spaces collapsed');
  assert.ok(t3().every(r => !/\.{2,}/.test(r.item)), 'leader dots never land in a name');
});

test('a table header row is not mistaken for a menu item', () => {
  assert.ok(t2().every(r => !/^item$/i.test(r.item)));
});

test('malformed sources return nothing rather than guessing', () => {
  assert.deepEqual(readT1('not json at all', '', NOW), []);
  assert.deepEqual(readT1('{}', '', NOW), []);
  assert.deepEqual(readT2('<p>no table here</p>', '', NOW), []);
  assert.deepEqual(readT3('nothing that looks like a menu line', '', NOW), []);
});

test('requirements exist at no tier below T0', () => {
  assert.equal(can('T0', 'requirements'), 'yes');
  for (const t of ['T1', 'T2', 'T3']) {
    assert.equal(can(t, 'requirements'), 'no', `${t} cannot state what the customer must supply`);
  }
  assert.equal(can('T4', 'requirements'), 'ask', 'below T0 you have to write and wait');
});

test('nothing below T0 can act', () => {
  for (const act of ['hold', 'negotiate']) {
    assert.equal(can('T0', act), 'yes');
    for (const t of ['T1', 'T2', 'T3']) assert.equal(can(t, act), 'no', `${t} cannot ${act}`);
  }
});

test('reading a menu is solved four ways; acting is solved in one', () => {
  const reads = ['T0', 'T1', 'T2', 'T3'].filter(t => can(t, 'menu') !== 'no');
  const acts = ['T0', 'T1', 'T2', 'T3', 'T4'].filter(t => can(t, 'hold') === 'yes');
  assert.equal(reads.length, 4);
  assert.deepEqual(acts, ['T0']);
});

test('a tier with nothing published still produces a next step', () => {
  const d = draftInquiry(
    { headcount: 40, serveAt: '2026-09-12T18:00:00-05:00', dietary: { vegetarian: 6, gluten_free: 2 } },
    { name: 'Green Fork Kitchen' });
  assert.match(d.body, /40 people/);
  assert.match(d.body, /served at 18:00/, 'the stated local time, not a UTC conversion of it');
  assert.match(d.body, /2026-09-12/);
  assert.match(d.body, /6 vegetarian, 2 gluten free/);
  assert.ok(d.asks.includes('requirements'), 'it asks the question nobody publishes');
  assert.equal(d.round_trip, 'days');
  assert.equal(d.status, 'pending until answered');
});

test('the same question put to every tier says who can answer it', () => {
  const rows = askEveryTier('requirements', { T0: readT0(vendor, NOW), T1: t1(), T2: t2(), T3: t3(), T4: [] });
  const by = Object.fromEntries(rows.map(r => [r.tier, r]));
  assert.equal(by.T0.answered, true);
  assert.equal(by.T1.answered, false);
  assert.equal(by.T4.needsHuman, true);
  assert.equal(by.T4.roundTrip, 'days');
  for (const r of rows) assert.ok(r.how.length > 10, 'each says how it would be read');
});

test('a finding is only as good as the weakest thing under it', () => {
  const strong = readT0(vendor, NOW);
  const weak = t3();
  assert.equal(weakestSource(strong), 'T0');
  assert.equal(weakestSource([...strong, ...weak]), 'T3', 'one PDF drags the whole finding down');
  assert.equal(weakestSource([]), null);
});

test('the capability matrix covers every tier it claims to compare', () => {
  for (const row of CAPABILITIES) {
    for (const t of ['T0', 'T1', 'T2', 'T3', 'T4']) {
      assert.ok(row[t] !== undefined, `${row.id} says nothing about ${t}`);
    }
    assert.ok(row.label.length > 3);
  }
});

test('reading a source never mutates it', () => {
  const raw = readFileSync('data/sources/green-fork.t1.jsonld', 'utf8');
  const before = JSON.parse(raw);
  readT1(raw, '', NOW);
  assert.deepEqual(JSON.parse(raw), before);
});
