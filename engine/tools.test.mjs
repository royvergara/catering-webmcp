import assert from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { buildVendorTools } from '../shared/vendor-tools.js';

const files = readdirSync('data/vendors').filter(f => f.endsWith('.json'));
const vendors = files.map(f => JSON.parse(readFileSync(`data/vendors/${f}`, 'utf8')));

test('every vendor file loads and has the required shape', () => {
  assert.ok(vendors.length >= 2);
  for (const v of vendors) {
    for (const k of ['slug', 'name', 'tier', 'service_levels', 'menu', 'requirements']) {
      assert.ok(v[k] !== undefined, `${v.slug || '?'} missing ${k}`);
    }
  }
});

test('tool contracts: names, descriptions, schemas', () => {
  for (const v of vendors) {
    const tools = buildVendorTools(v);
    assert.equal(tools.length, 5, `${v.slug} should expose 5 tools`);
    for (const t of tools) {
      assert.match(t.name, /^[a-z_]+$/, 'snake_case name');
      assert.ok(t.description.length > 20, `${t.name} needs a real description`);
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(typeof t.run, 'function');
    }
  }
});

test('get_requirements returns requires[] for every offered service level', () => {
  for (const v of vendors) {
    const t = buildVendorTools(v).find(x => x.name === 'get_requirements');
    for (const lvl of v.service_levels) {
      const out = t.run({ service_level: lvl });
      assert.ok(Array.isArray(out.requires), `${v.slug}/${lvl} requires[]`);
      assert.ok(Array.isArray(out.provides), `${v.slug}/${lvl} provides[]`);
    }
  }
});

test('where a vendor offers several service levels, they differ in what the customer holds', () => {
  for (const v of vendors.filter(x => x.service_levels.length > 1)) {
    const t = buildVendorTools(v).find(x => x.name === 'get_requirements');
    const seen = new Set(v.service_levels.map(l => JSON.stringify(t.run({ service_level: l }).requires)));
    assert.ok(seen.size > 1, `${v.slug}: service level must change what the customer holds`);
  }
});

test('every resource required by a caterer is providable by someone in the set', () => {
  const provided = new Set();
  for (const v of vendors) {
    for (const r of Object.values(v.requirements)) {
      for (const p of r.provides || []) provided.add(p);
    }
  }
  const unresolvable = [];
  for (const v of vendors.filter(x => x.kind === 'caterer')) {
    for (const r of Object.values(v.requirements)) {
      for (const need of r.requires || []) {
        if (['transport', 'cleanup'].includes(need)) continue;
        if (!provided.has(need)) unresolvable.push(`${v.slug}: ${need}`);
      }
    }
  }
  assert.deepEqual(unresolvable, [], 'a caterer requires something no vendor provides');
});

test('availability respects blackout dates', () => {
  const v = vendors.find(x => (x.blackout_dates || []).length);
  if (!v) return;
  const t = buildVendorTools(v).find(x => x.name === 'check_availability');
  assert.equal(t.run({ date: v.blackout_dates[0] }).status, 'booked');
  assert.equal(t.run({ date: '2026-01-01' }).status, 'open');
});

test('every tool output is JSON-serialisable', () => {
  for (const v of vendors) {
    for (const t of buildVendorTools(v)) {
      const sample = {
        check_availability: { date: '2026-09-12' },
        get_menu: {},
        get_requirements: { service_level: v.service_levels[0] },
        propose_accommodation: { constraint: 'timing' },
        hold: { date: '2026-09-12' }
      }[t.name];
      assert.doesNotThrow(() => JSON.parse(JSON.stringify(t.run(sample))));
    }
  }
});

test('holds are never binding', () => {
  for (const v of vendors) {
    const t = buildVendorTools(v).find(x => x.name === 'hold');
    assert.equal(t.run({ date: '2026-09-12' }).binding, false);
  }
});
