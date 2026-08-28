// Design tokens. Single source of truth for every page.
// Direction: kitchen operations — order chits, prep tickets, service tape.
//
// This is NOT part of running the site. The site loads one plain stylesheet,
// shared/tailwind.css, which is committed. This file exists only to regenerate
// that stylesheet when a token or a utility class changes:
//
//   npx tailwindcss@3 -c tailwind.config.js -i shared/tailwind.in.css \
//     -o shared/tailwind.css --minify
//
// Nothing here is installed, and `npm test` and `npm run dev` do not touch it.
module.exports = {
  content: ['./*.html', './shared/*.js'],
  theme: {
    extend: {
      colors: {
        ink:    { DEFAULT: '#10131A', soft: '#3A424F', mute: '#5F6874' },
        paper:  { DEFAULT: '#F2F4F7', card: '#FFFFFF', sunk: '#E7EAEF' },
        rule:   { DEFAULT: '#D9DEE5', strong: '#B9C1CC' },
        carbon: { DEFAULT: '#1F3FD4', soft: '#E8ECFC' },   // carbon-copy blue: the brand
        tape:   { DEFAULT: '#FFD94A', soft: '#FFF6D1' },   // canary chit tape: "this one is yours"
        short:  { DEFAULT: '#B8271F', soft: '#FBE9E8' },   // blocker
        watch:  { DEFAULT: '#8A5B00', soft: '#FBF0DA' },   // risk
        covered:{ DEFAULT: '#0F6B4F', soft: '#E2F2EC' }    // ok
      },
      fontFamily: {
        // No `display` family on purpose. The serif title face is set once, by
        // .sheethead h1 in ui.css. Exposing it as font-display is how it ended up
        // on card names, a button and a status line, all at once.
        sans:    ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono:    ['"IBM Plex Mono"', 'ui-monospace', 'monospace']
      },
      letterSpacing: { tightest: '-0.035em' },
      borderRadius: { chit: '2px' },
      boxShadow: { chit: '0 1px 0 #D9DEE5, 0 6px 18px -12px rgba(16,19,26,.35)' }
    }
  }
};
