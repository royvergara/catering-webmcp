import assert from 'node:assert';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

// shared/tailwind.css is generated and committed, so it can fall out of step with the
// markup: add a utility class to a page, forget to regenerate, and the class silently
// does nothing. That is how the option buttons ended up centred — `text-left` was in
// the markup and not in the stylesheet, so the browser's own button default won.
//
// This lives under engine/ because that is where `npm test` looks. It needs no tailwind
// install: it only checks that every class the pages use resolves to something we ship.

const pages = readdirSync('.').filter(f => f.endsWith('.html'));
const tailwind = readFileSync('shared/tailwind.css', 'utf8');
const components = readFileSync('shared/ui.css', 'utf8');

// Class names our own stylesheet defines: .chit, .btn, .row-name, .tape …
const OWN = new Set([...components.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));

// Tailwind escapes anything outside [A-Za-z0-9-] in a selector, and uses the CSS
// numeric escape for a comma: text-[clamp(1rem,2vw,3rem)] becomes
// .text-\[clamp\(1rem\2c 2vw\2c 3rem\)\], and hover:x becomes .hover\:x:hover.
const selectorFor = token =>
  '.' + token.replace(/[^\w-]/g, ch => (ch === ',' ? '\\2c ' : '\\' + ch));

// Remove ${ … } expressions, matching braces so a nested template literal does not
// end the scan early. What is left is the literal class text.
function stripExpressions(value) {
  let out = '', depth = 0;
  for (let i = 0; i < value.length; i++) {
    if (!depth && value[i] === '$' && value[i + 1] === '{') { depth = 1; i++; continue; }
    if (depth) {
      if (value[i] === '{') depth++;
      else if (value[i] === '}') depth--;
      continue;
    }
    out += value[i];
  }
  return out;
}

// Inside a class attribute, a ternary picks between quoted sets of classes. Those are
// real classes too, so read them — but only tokens shaped like a utility, to avoid
// mistaking a piece of copy such as 'You' for one.
function classesInExpressions(value) {
  const out = [];
  for (const expr of value.match(/\$\{[\s\S]*?\}/g) || []) {
    for (const quoted of expr.match(/'([^']*)'|"([^"]*)"/g) || []) {
      for (const token of quoted.slice(1, -1).split(/\s+/)) {
        if (/^[a-z][a-z0-9]*[-:][\w:./[\]-]*$/.test(token)) out.push(token);
      }
    }
  }
  return out;
}

function classesUsedIn(html) {
  const found = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of stripExpressions(m[1]).split(/\s+/)) if (token) found.add(token);
    for (const token of classesInExpressions(m[1])) found.add(token);
  }
  return found;
}

test('every class the pages use exists in a stylesheet we ship', () => {
  const missing = [];
  for (const page of pages) {
    for (const token of classesUsedIn(readFileSync(page, 'utf8'))) {
      if (OWN.has(token)) continue;
      if (token.startsWith('js-')) continue;   // a hook for querySelector, not a style
      if (tailwind.includes(selectorFor(token))) continue;
      missing.push(`${page}: ${token}`);
    }
  }
  assert.deepEqual(missing, [],
    'these classes do nothing — regenerate shared/tailwind.css (see tailwind.config.js)');
});

test('the guard would actually catch a stale stylesheet', () => {
  // a class nobody uses is absent from the generated CSS, which is what staleness
  // looks like; if this ever passes, the check above has stopped checking anything
  assert.ok(!tailwind.includes(selectorFor('text-right')), 'unused classes are not generated');
  assert.ok(tailwind.includes(selectorFor('text-left')), 'used ones are');
});

test('the generated stylesheet carries the design tokens, not just stock utilities', () => {
  // if the config were ignored these would silently fall back to nothing. One per
  // category the config extends — colours, radius, shadow, family — and every one has
  // to be a class the pages still use, because tailwind only generates what it finds.
  for (const token of ['text-ink-mute', 'bg-paper-card', 'bg-paper-sunk', 'border-rule',
                       'text-carbon', 'rounded-chit', 'hover:shadow-chit', 'font-display']) {
    assert.ok(tailwind.includes(selectorFor(token)), `${token} is missing from the stylesheet`);
  }
});

test('the pages ask for nothing from a third party', () => {
  // the whole point of vendoring: a conference network cannot break the demo
  for (const page of pages) {
    const external = [...readFileSync(page, 'utf8').matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)];
    assert.deepEqual(external.map(m => m[1]), [], `${page} loads something from off-origin`);
  }
});

test('the stylesheet the pages link to is the one that is committed', () => {
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    assert.ok(html.includes('/shared/tailwind.css'), `${page} does not link the generated stylesheet`);
    assert.ok(!html.includes('cdn.tailwindcss.com'), `${page} still loads Tailwind from a CDN`);
  }
});

test('every vendored font file the stylesheet asks for is actually committed', () => {
  // the fonts are served from this origin so a conference network cannot break the
  // demo. A @font-face pointing at a file we deleted fails silently — the browser
  // just falls back — so check the paths resolve, and that none of them is remote.
  const fonts = readFileSync('shared/fonts.css', 'utf8');
  const urls = [...fonts.matchAll(/url\(([^)]+)\)/g)].map(m => m[1].replace(/['"]/g, ''));
  assert.ok(urls.length > 0, 'no @font-face src found at all');
  for (const url of urls) {
    assert.ok(!/^https?:/.test(url), `${url} is loaded from a third party`);
    assert.ok(existsSync('.' + url), `${url} is referenced but not committed`);
  }
});

test('no page still asks for a face we no longer ship', () => {
  // the display face is declared in one place; a stale family name anywhere else
  // renders in the system serif and looks like a bug nobody can explain
  const declared = new Set([...readFileSync('shared/fonts.css', 'utf8')
    .matchAll(/font-family:\s*'([^']+)'/g)].map(m => m[1]));
  const used = new Set([...components.matchAll(/font-family:\s*([A-Za-z][\w -]*)/g)]
    .map(m => m[1].trim()).filter(f => !/^(inherit|monospace|serif|sans-serif|system-ui)$/.test(f)));
  for (const family of used) {
    assert.ok(declared.has(family), `ui.css sets ${family}, which fonts.css does not ship`);
  }
});
