// The design system. Single source of truth for every colour, face, radius and
// shadow the site uses.
//
// Direction: kitchen operations — order chits, prep tickets, service tape.
//
// This is NOT part of running the site. The site loads one plain stylesheet,
// shared/tailwind.css, which is committed. This file exists only to regenerate
// that stylesheet when a token changes:
//
//   npx tailwindcss@3 -c tailwind.config.js -i shared/tailwind.in.css \
//     -o shared/tailwind.css --minify
//
// Nothing here is installed, and `npm test` and `npm run dev` do not touch it.
//
// The tokens below are consumed twice, mechanically, from these same literals:
// once as tailwind utilities (`text-ink-mute`, `bg-paper-card`) for the markup,
// and once as CSS custom properties (`--ink-mute`, `--paper-card`) emitted into
// the generated stylesheet for shared/ui.css to use. Nothing is written down in
// two places — the palette used to live here *and* in ui.css, they drifted, and
// darkening a colour for contrast silently fixed the components while leaving
// every utility on the old value.

const palette = {
  ink: {
    DEFAULT: '#10131A',
    soft:    '#3A424F',
    // The most-used secondary colour, and it sits on five different backgrounds.
    // At #6B7480 it measured 3.93:1 on paper-sunk and 4.30:1 on paper — both under
    // the 4.5:1 AA threshold for text at these sizes. This is the nearest value
    // that clears it everywhere; worst case 4.68:1, on paper-sunk.
    mute:    '#5F6874',
    press:   '#000000'                                    // .btn:hover
  },
  paper: {
    DEFAULT: '#F2F4F7',
    card:    '#FFFFFF',
    sunk:    '#E7EAEF',
    head:    '#FAFBFC'                                    // the low stop of .chit-head
  },
  rule:    { DEFAULT: '#D9DEE5', strong: '#B9C1CC', faint: 'rgba(185,193,204,.16)' },
  carbon:  { DEFAULT: '#1F3FD4', soft: '#E8ECFC', line: '#CBD5F7' },   // carbon-copy blue: the brand
  tape:    { DEFAULT: '#FFD94A', soft: '#FFF6D1' },       // canary chit tape: "this one is yours"
  short:   { DEFAULT: '#B8271F', soft: '#FBE9E8', line: '#F0CFCC' },   // blocker
  watch:   { DEFAULT: '#8A5B00', soft: '#FBF0DA', line: '#EFDDB4' },   // risk
  covered: { DEFAULT: '#0F6B4F', soft: '#E2F2EC', line: '#C6E3D8' },   // ok
  readout: { DEFAULT: '#0C0F15', ink: '#D8DEE9' }         // the dark tool-call log
};

const fontFamily = {
  // No `display` family on purpose. The serif title face is set once, by
  // .sheethead h1 in ui.css, via --font-title. Exposing it as font-display is how
  // it ended up on card names, a button and a status line, all at once.
  sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
  mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace']
};

// Set once, on the h1, and deliberately not reachable from the markup.
const titleFace = ['Fraunces', 'Georgia', 'serif'];

const borderRadius = { chit: '2px' };

const boxShadow = {
  chit: '0 1px 0 #D9DEE5, 0 6px 18px -14px rgba(16,19,26,.4)',
  lift: '0 1px 0 #D9DEE5, 0 10px 20px -18px rgba(16,19,26,.5)'
};

// ink.DEFAULT -> --ink, ink.soft -> --ink-soft
const flatten = (group, values) =>
  Object.fromEntries(Object.entries(values).map(([k, v]) =>
    [k === 'DEFAULT' ? `--${group}` : `--${group}-${k}`, v]));

module.exports = {
  content: ['./*.html', './shared/*.js'],
  theme: {
    extend: {
      colors: palette,
      fontFamily,
      letterSpacing: { tightest: '-0.035em' },
      borderRadius,
      boxShadow
    }
  },
  plugins: [
    // Emit the same tokens as custom properties, so the component layer in
    // shared/ui.css can reach them without restating a single value. A bare
    // function rather than tailwindcss/plugin: nothing is installed in this repo,
    // so the config cannot require() anything.
    function ({ addBase }) {
      addBase({
        ':root': {
          ...Object.entries(palette).reduce(
            (all, [group, values]) => ({ ...all, ...flatten(group, values) }), {}),
          '--font-sans':  fontFamily.sans.join(', '),
          '--font-mono':  fontFamily.mono.join(', '),
          '--font-title': titleFace.join(', '),
          '--radius-chit': borderRadius.chit,
          '--shadow-chit': boxShadow.chit,
          '--shadow-lift': boxShadow.lift
        }
      });
    }
  ]
};
