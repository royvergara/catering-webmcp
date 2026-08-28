import assert from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { parseOccasion, composeBasket, assemblePlan, ownershipTable, explainQuantity, naiveBasket, replan } from '../shared/plan.js';
import { deriveAssumptions, CONFIDENCE } from '../engine/assumptions.js';

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

test('two vendors means two trips, and the rows say which is which', () => {
  // An order split across two vendors is two pickups. Both rows are `transport`,
  // `3pm`, `You` — only `for` tells them apart, and share_plan hands these rows to
  // an agent. Drop the attribution and the rows collapse into one, so the host is
  // told they are making a single trip when they are making two.
  const o = parseOccasion(PROMPT);
  const p = assemblePlan(o, vendors, 'pickup');
  assert.ok(p.basket.vendorsUsed.length > 1, 'this fixture is meant to split across vendors');

  const rows = ownershipTable(p, vendors);
  const trips = rows.filter(r => r.job === 'transport' && r.who === 'You');
  assert.equal(trips.length, p.basket.vendorsUsed.length, 'one trip per vendor, not one trip total');
  assert.equal(new Set(trips.map(r => r.for)).size, trips.length, 'each trip names its vendor');
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

test('a headcount is not read as a budget', () => {
  // "$?\s?(\d{3,5})" matched the first three-digit number, so 100 people cost $100
  const o = parseOccasion('100 people, $1200, ten vegetarians');
  assert.equal(o.headcount, 100);
  assert.equal(o.budget, 1200, 'the figure marked as money is the budget');
});

test('a headcount written any of the usual ways is read, not defaulted', () => {
  const cases = {
    '40 people, $600': 40,
    'party for 60 on Friday night, $900': 60,
    'lunch for 12': 12,
    'group of 200, budget 3,500': 200,
    '25 guests, budget around $400': 25
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.equal(parseOccasion(text).headcount, expected, `headcount in: ${text}`);
  }
});

test('thousands separators survive parsing', () => {
  assert.equal(parseOccasion('group of 200, budget 3,500').budget, 3500);
});

test('a time of day is never mistaken for a headcount', () => {
  const o = parseOccasion('40 people, Saturday at 6, $600');
  assert.equal(o.headcount, 40);
});

test('what the description did not say is marked assumed, not read', () => {
  const stated = parseOccasion('40 people, $600');
  assert.equal(stated.found.headcount, true);
  assert.equal(stated.found.budget, true);

  const vague = parseOccasion('feed the team, 8 vegetarians');
  assert.equal(vague.found.headcount, false, 'nobody said how many people');
  assert.equal(vague.found.budget, false, 'nobody said a budget');
  assert.equal(vague.headcount, 40, 'a default is still used so the plan can run');
  assert.equal(vague.found.serveAt, false, 'the demo service time is a fixture, and says so');
});

test('a defaulted input is presented as an assumption, not as something you said', () => {
  const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
  const plan = assemblePlan(parseOccasion('feed the team, 8 vegetarians'), vendors, 'pickup');
  const hc = plan.assumptions.find(a => a.id === 'occasion.headcount');
  assert.equal(hc.source, 'default');
  assert.match(hc.basis, /nobody said how many/);

  const stated = assemblePlan(parseOccasion('40 people, $600'), vendors, 'pickup');
  assert.equal(stated.assumptions.find(a => a.id === 'occasion.headcount').source, 'parsed');
});

test('the budget is an editable assumption like everything else it drives', () => {
  const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
  const plan = assemblePlan(parseOccasion(PROMPT), vendors, 'pickup');
  const b = plan.assumptions.find(a => a.id === 'occasion.budget');
  assert.ok(b, 'the budget is listed');
  assert.equal(b.value, 600);
});

test('a vendor who cannot take the date is never ordered from', () => {
  const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
  const o = parseOccasion(PROMPT);
  const date = o.serveAt.slice(0, 10);
  const booked = vendors.filter(v => (v.blackout_dates || []).includes(date));
  assert.ok(booked.length, 'the demo set contains a vendor booked on the service date');

  const plan = assemblePlan(o, vendors, 'pickup');
  for (const v of booked) {
    assert.ok(!plan.basket.vendorsUsed.includes(v.slug), `${v.slug} is booked and must not be in the order`);
  }
});

test('a vendor left out for being booked is named, not silently dropped', () => {
  const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
  const plan = assemblePlan(parseOccasion(PROMPT), vendors, 'pickup');
  assert.ok(plan.basket.excluded.length, 'the exclusion is recorded');
  for (const e of plan.basket.excluded) {
    assert.ok(e.name, 'named');
    assert.match(e.reason, /booked on \d{4}-\d{2}-\d{2}/, 'with the reason and the date');
  }
});

test('no option anywhere orders from a vendor who is booked', async () => {
  const { buildOptions } = await import('../shared/plan.js');
  const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
  const o = parseOccasion(PROMPT);
  const date = o.serveAt.slice(0, 10);
  const bookedSlugs = vendors.filter(v => (v.blackout_dates || []).includes(date)).map(v => v.slug);
  for (const opt of buildOptions(o, vendors, 'pickup')) {
    for (const slug of opt.plan.basket.vendorsUsed) {
      assert.ok(!bookedSlugs.includes(slug), `${opt.id} orders from booked ${slug}`);
    }
  }
});

test('an occasion with nobody to feed produces an empty baseline, not a crash', () => {
  const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
  const empty = naiveBasket(parseOccasion('0 people'), vendors);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.subtotal, 0);
  assert.deepEqual(empty.vendorsUsed, []);
});

test('with no vendors at all, nothing throws', () => {
  const o = parseOccasion(PROMPT);
  assert.doesNotThrow(() => naiveBasket(o, []));
  assert.deepEqual(naiveBasket(o, []).items, []);
  assert.doesNotThrow(() => composeBasket(o, []));
  assert.deepEqual(composeBasket(o, []).items, []);
});

// The parser is deliberately shallow — an agent calling plan_meal has already done
// the language work — but a shallow reader that drops a clause in silence is
// indistinguishable from a wrong one. These guard the saying-so.

test('a quantity no field claimed is reported, not dropped', () => {
  const o = parseOccasion(PROMPT + ' feed 5 dogs too');
  assert.deepEqual(o.unread, ['5 dogs']);
  // and it changed nothing it should not have
  const base = parseOccasion(PROMPT);
  for (const k of ['headcount', 'budget', 'venueHasKitchen']) assert.equal(o[k], base[k]);
  assert.deepEqual(o.dietary, base.dietary);
});

test('the demo prompt has no residue, so the report stays quiet when it should', () => {
  assert.deepEqual(parseOccasion(PROMPT).unread, []);
  assert.deepEqual(parseOccasion('100 guests, budget 2,500, 6 vegetarians').unread, []);
});

test('the clock is not reported as unread — found.serveAt already says it was not read', () => {
  const o = parseOccasion('40 people at 6pm');
  assert.deepEqual(o.unread, []);
  assert.equal(o.found.serveAt, false);
});

test('every unclaimed quantity is named, in the order written', () => {
  assert.deepEqual(parseOccasion('40 people, plus food for 5 dogs and 3 cats').unread,
    ['5 dogs', '3 cats']);
});

test('"for N <not-people>" is not a headcount', () => {
  // this used to plan dinner for twelve people
  const dogs = parseOccasion('dinner for 12 dogs');
  assert.equal(dogs.found.headcount, false);
  assert.deepEqual(dogs.unread, ['12 dogs']);

  // while the readings that were right stay right
  assert.equal(parseOccasion('dinner for 12').headcount, 12);
  assert.equal(parseOccasion('party of 30').headcount, 30);
  assert.equal(parseOccasion('party of 30 guests').headcount, 30);
  assert.equal(parseOccasion('catering for 40 people').headcount, 40);
});

test('a description that gained an unreadable clause does not report "nothing changed"', () => {
  const before = assemblePlan(parseOccasion(PROMPT), vendors, 'pickup');
  const { delta } = replan(before, vendors, { description: PROMPT + ' feed 5 dogs too' });
  assert.match(delta.change, /Not read: 5 dogs\./);
  assert.doesNotMatch(delta.change, /Nothing in the description changed/);
  assert.deepEqual(delta.unread, ['5 dogs']);
});

test('residue is reported alongside the fields that did move, not instead of them', () => {
  const before = assemblePlan(parseOccasion(PROMPT), vendors, 'pickup');
  const { delta } = replan(before, vendors,
    { description: '60 people, $600, 6 vegetarians, 2 gluten free, no kitchen, feed 5 dogs' });
  assert.match(delta.change, /Headcount 40 -> 60/);
  assert.match(delta.change, /Not read: 5 dogs\./);
});

test('residue can never carry markup, whatever was typed', () => {
  // The reported phrase is rebuilt from two narrow captures — digits and commas,
  // then letters, apostrophe, hyphen — so nothing HTML-significant can reach a page
  // through it. plan.html escapes it as well, but this is the guarantee. Widening
  // the residue scanner to catch more clauses would give that up, which is the
  // trade: `5 "trays"` is reported as nothing rather than reported unsafely.
  const hostile = [
    '40 people, feed 5 <img src=x onerror=alert(1)> too',
    '40 people, feed 5 dogs<script>alert(1)</script>',
    '40 people, 5 "trays" of ice',
    "40 people, feed 5 dog's dinner"
  ];
  for (const text of hostile) {
    for (const phrase of parseOccasion(text).unread) {
      assert.match(phrase, /^[\d,]+ [a-z][a-z'-]*$/, `unsafe residue from: ${text}`);
    }
  }
});

// ---------- what the caller already knew ----------
// plan_meal's reader is shallow on purpose: an agent calling it has done the language
// work before the call. These guard the fields it can pass instead.

test('a supplied field is taken as stated and outranks the description', () => {
  const o = parseOccasion('40 people, $600, 6 vegetarians', { headcount: 60, budget: 900 });
  assert.equal(o.headcount, 60);
  assert.equal(o.budget, 900);
  assert.deepEqual(o.dietary, { vegetarian: 6 }, 'what was not supplied is still read');
  assert.deepEqual(o.given.sort(), ['budget', 'headcount']);
});

test('a supplied field counts as known, not assumed', () => {
  // "feed 12 dogs" says nothing about people, so the parser defaults — unless told
  const parsed = parseOccasion('feed 12 dogs');
  assert.equal(parsed.found.headcount, false);

  const told = parseOccasion('feed 12 dogs', { headcount: 30 });
  assert.equal(told.found.headcount, true);
  assert.equal(told.headcount, 30);
});

test('the assumptions panel says a value was given, not parsed or defaulted', () => {
  const head = o => deriveAssumptions(o, { items: [] }).find(a => a.id === 'occasion.headcount');

  assert.equal(head(parseOccasion('40 people')).source, 'parsed');
  assert.equal(head(parseOccasion('a party')).source, 'default');
  assert.equal(head(parseOccasion('a party', { headcount: 30 })).source, 'given');

  // and it is trusted above a parse but below a person confirming it on the page
  assert.ok(CONFIDENCE.given > CONFIDENCE.parsed);
  assert.ok(CONFIDENCE.given < CONFIDENCE.user);
});

test('supplying nothing changes nothing', () => {
  const bare = parseOccasion(PROMPT);
  const empty = parseOccasion(PROMPT, {});
  const undef = parseOccasion(PROMPT, { headcount: undefined, budget: null });
  for (const o of [empty, undef]) {
    assert.deepEqual(o.given, []);
    for (const k of ['headcount', 'budget', 'durationHours', 'venueHasKitchen']) {
      assert.equal(o[k], bare[k], `${k} moved without being supplied`);
    }
    assert.deepEqual(o.dietary, bare.dietary);
  }
});

test('a supplied dietary count and kitchen flag reach the plan', () => {
  const o = parseOccasion('a party', { dietary: { vegan: 4 }, venueHasKitchen: true, durationHours: 5 });
  assert.deepEqual(o.dietary, { vegan: 4 });
  assert.equal(o.venueHasKitchen, true);
  assert.equal(o.durationHours, 5);
  const plan = assemblePlan(o, vendors, 'pickup');
  const vegan = plan.assumptions.find(a => a.id === 'occasion.dietary.vegan');
  assert.equal(vegan.source, 'given');
  assert.equal(vegan.value, 4);
});
