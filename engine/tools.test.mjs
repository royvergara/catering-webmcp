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

// ---------- reachability ----------
// A tool nobody can call is a tool nobody can judge. These guard the thing that fails
// silently in a browser: a page that registers nothing unless the browser happens to
// have WebMCP, which is almost no browser, and a harness that then shows an empty list.

const PAGES_WITH_TOOLS = ['vendor.html', 'plan.html', 'gradient.html', 'smoke.html'];
const page = f => readFileSync(f, 'utf8');

test('every page registers its tools whether or not the browser has WebMCP', () => {
  for (const f of PAGES_WITH_TOOLS) {
    const src = page(f);
    assert.match(src, /import \{ toolHost \} from '\/shared\/webmcp\.js'/, `${f} does not import toolHost`);
    assert.match(src, /toolHost\(\)/, `${f} never calls toolHost`);
    // the old shape: register only if the browser already provides a modelContext
    assert.doesNotMatch(src, /if \([^)]*document\.modelContext\?\.registerTool\)/,
      `${f} still registers only when WebMCP is present, so /harness.html sees nothing`);
  }
});

test('the harness offers every page that registers tools', () => {
  const h = page('harness.html');
  for (const f of PAGES_WITH_TOOLS) {
    assert.ok(h.includes(`/${f}`), `harness.html never loads ${f}`);
  }
  // and every vendor, since each publishes its own data through the same five tools
  for (const v of vendors) {
    assert.ok(h.includes(v.slug) || /SLUGS/.test(h), `harness.html cannot reach ${v.slug}`);
  }
});

test('the harness reads the registry rather than rebuilding the tools', () => {
  const h = page('harness.html');
  // rebuilding meant it exercised a copy: five vendor tools, and never the other seventeen
  assert.doesNotMatch(h, /buildVendorTools/,
    'harness.html rebuilds vendor tools instead of reading what the page registered');
  assert.match(h, /document\.modelContext/, 'harness.html never reads a page registry');
});

test('toolHost stands in only when there is nothing to stand in for', async () => {
  const src = readFileSync('shared/webmcp.js', 'utf8');
  // the shim must be marked, because "no registry at all" and "a real one" are
  // different states and the harness reports them differently
  assert.match(src, /shimmed: true/);
  assert.match(src, /document\.modelContext\?\.registerTool/);
});

test('plan_meal takes the fields an agent already understood, not only prose', () => {
  const src = page('plan.html');
  const tool = src.slice(src.indexOf("reg('plan_meal'"), src.indexOf("reg('build_basket'"));
  for (const f of ['headcount', 'budget', 'dietary', 'venue_has_kitchen', 'service_level']) {
    assert.ok(tool.includes(`${f}:{`), `plan_meal's schema has no ${f}`);
  }
  // and prose must not be mandatory, or the structured path cannot be used alone
  assert.doesNotMatch(tool, /required:\s*\['description'\]/);
});

test('the harness renders every type plan_meal declares', () => {
  const h = page('harness.html');
  // a boolean sent as the string "false" is truthy, and an object sent as a string is
  // iterated character by character; both looked fine on screen
  for (const t of ['boolean', 'object', 'array', 'number', 'enum']) {
    assert.ok(h.includes(`'${t}'`), `harness.html renders no control for ${t}`);
  }
  assert.match(h, /JSON\.parse\(raw\)/, 'harness.html never parses an object input');
});

test('the harness opens as a list, not a page of form', () => {
  const h = page('harness.html');
  // every tool is a closed row; the inputs are behind it. Rendering all of them at
  // once made eleven tools read as a wall nobody would fill in.
  assert.match(h, /<details data-tool=/, 'tool rows are not collapsible');
  assert.doesNotMatch(h, /<details data-tool="\$\{esc\(t\.name\)\}" open/, 'tool rows start open');
  // and Run must not toggle the row it sits in
  assert.match(h, /e\.stopPropagation\(\)/, 'the Run button would toggle its own row');
});

test('every harness control is labelled, and only required ones are marked', () => {
  const h = page('harness.html');
  assert.match(h, /<label for="in-\$\{tool\}-\$\{esc\(f\.name\)\}"/, 'controls are not labelled');
  // on plan_meal every field is optional, so marking each one said nothing and read
  // as a demand; the exception is what carries information
  assert.match(h, /f\.required \? ' <span class="required">required<\/span>' : ''/);
});

test('a prose argument gets room to be read', () => {
  const h = page('harness.html');
  assert.match(h, /<textarea/, 'a long string argument is still a one-line input');
});
