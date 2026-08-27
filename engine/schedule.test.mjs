import assert from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { parseOccasion, assemblePlan, ownershipTable } from '../shared/plan.js';
import { scheduleJob, timeline, formatClock, addHostHoldingJob, JOB_TIMING } from './schedule.js';

const vendors = readdirSync('data/vendors').filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));
const PROMPT = '40 people, Saturday at 6, $600, 6 vegetarians, 2 gluten free, no kitchen at the venue';
const ctx = { serveAt: '2026-09-12T18:00:00-05:00', durationHours: 3 };
const table = (lvl = 'pickup') => ownershipTable(assemblePlan(parseOccasion(PROMPT), vendors, lvl), vendors);

test('the clock reads the way a person says it', () => {
  assert.equal(formatClock(18 * 60), '6pm');
  assert.equal(formatClock(17 * 60 + 15), '5:15pm');
  assert.equal(formatClock(9 * 60), '9am');
  assert.equal(formatClock(12 * 60), '12pm');
  assert.equal(formatClock(0), '12am');
});

test('a time either side of midnight says which day it landed on', () => {
  assert.match(formatClock(-30), /the day before$/);
  assert.match(formatClock(1440 + 60), /the next day$/);
});

test('the schedule is read off the stated time, not a UTC conversion of it', () => {
  // 18:00-05:00 is 23:00 UTC. A job an hour before service is 5pm, never 10pm.
  assert.equal(scheduleJob('warming_trays', ctx).when, 'by 5pm');
  assert.equal(scheduleJob('setup', ctx).when, '5:15pm');
});

test('each kind of job is phrased the way that job actually happens', () => {
  assert.equal(scheduleJob('food', ctx).when, 'that morning');
  assert.equal(scheduleJob('warming_trays', ctx).when, 'by 5pm');
  assert.equal(scheduleJob('refills', ctx).when, '6pm–9pm', 'work that runs through service');
  assert.equal(scheduleJob('cleanup', ctx).when, 'after 9pm', 'work that starts when service ends');
  assert.equal(scheduleJob('return_by_monday', ctx).when, 'the next business day');
});

test('a longer event pushes the end of the day back', () => {
  assert.equal(scheduleJob('cleanup', { ...ctx, durationHours: 5 }).when, 'after 11pm');
  assert.equal(scheduleJob('refills', { ...ctx, durationHours: 5 }).when, '6pm–11pm');
});

test('a job nobody scheduled still gets a time rather than a blank', () => {
  const s = scheduleJob('something_nobody_listed', ctx);
  assert.ok(s.when.length, 'never blank');
  assert.match(s.when, /^by /);
});

test('with no service time set, the table says so instead of inventing one', () => {
  assert.equal(scheduleJob('cleanup', {}).when, 'time not set');
});

test('the day runs in order', () => {
  const rows = timeline([
    { job: 'cleanup' }, { job: 'food' }, { job: 'refills' }, { job: 'warming_trays' }
  ], ctx);
  assert.deepEqual(rows.map(r => r.job), ['food', 'warming_trays', 'refills', 'cleanup']);
});

test('two jobs at the same moment keep a stable order', () => {
  const rows = [{ job: 'warming_trays', who: 'a' }, { job: 'fuel', who: 'b' }];
  assert.deepEqual(timeline(rows, ctx).map(r => r.who), timeline(rows, ctx).map(r => r.who));
});

test('holding hot food is the customer\'s job, and nobody publishes it', () => {
  const rows = addHostHoldingJob([], { serviceLevel: 'pickup', hasHotFood: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].who, 'You');
  assert.equal(rows[0].job, 'hold_temperature');
  assert.ok(!JOB_TIMING.hold_temperature.label, 'it is named by the job itself');
});

test('a staffed order takes the holding off you', () => {
  for (const lvl of ['staffed', 'full_service']) {
    assert.deepEqual(addHostHoldingJob([], { serviceLevel: lvl, hasHotFood: true }), []);
  }
});

test('an order with nothing hot in it needs no holding', () => {
  assert.deepEqual(addHostHoldingJob([], { serviceLevel: 'pickup', hasHotFood: false }), []);
});

test('holding is never added twice', () => {
  const once = addHostHoldingJob([], { serviceLevel: 'pickup', hasHotFood: true });
  assert.deepEqual(addHostHoldingJob(once, { serviceLevel: 'pickup', hasHotFood: true }), once);
});

test('the plan you hand someone has three columns, not two', () => {
  const rows = table();
  assert.ok(rows.length > 3);
  for (const r of rows) {
    assert.ok(r.job, 'a job');
    assert.ok(r.who, 'an owner');
    assert.ok(r.when, 'and when it has to happen');
  }
});

test('the table runs in the order the day does', () => {
  const sorts = table().map(r => r.sort);
  assert.deepEqual(sorts, [...sorts].sort((a, b) => a - b));
});

test('a pickup order leaves you holding the temperature', () => {
  const rows = table('pickup');
  const hold = rows.find(r => r.job === 'hold_temperature');
  assert.ok(hold, 'hot food collected and held is work somebody has to do');
  assert.equal(hold.who, 'You');
  assert.equal(hold.when, '6pm–9pm');
});

test('the ownership table does not mutate the plan it describes', () => {
  const plan = assemblePlan(parseOccasion(PROMPT), vendors, 'pickup');
  const snapshot = JSON.stringify(plan);
  ownershipTable(plan, vendors);
  assert.equal(JSON.stringify(plan), snapshot);
});
