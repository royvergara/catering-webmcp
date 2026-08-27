// Shared UI helpers so every page uses the same patterns.
const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/plan.html', label: 'Planner' },
  { href: '/gradient.html', label: 'Source gradient' },
  { href: '/harness.html', label: 'Tool harness' },
  { href: '/smoke.html', label: 'Smoke test' }
];

const link = (n, active, mobile) => {
  const on = n.label === active;
  const cur = on ? ' aria-current="page"' : '';
  return mobile
    ? `<a href="${n.href}"${cur}>${n.label}</a>`
    : `<a href="${n.href}" class="navlink"${cur}>${n.label}</a>`;
};

// Open at the top. Browsers restore the scroll offset of a URL you have seen
// before, which drops someone who has never read the page into the middle of it —
// on this site, past the paragraph that says what they are looking at.
//
// One scrollTo when the script runs is not enough. iOS Safari applies its restore
// *after* load, once layout has settled, so it lands after a single early call and
// puts the reader back down the page. Chromium honours the early call, which is why
// this only ever showed up on a phone.
//
// So hold the top for a beat rather than setting it once, and re-arm at each moment
// the page can still move: load, a back-forward restore, the display face swapping
// in. A tick is a no-op unless something moved the page, the hold is bounded, and
// the whole thing stops the instant the reader scrolls — a restore is not a scroll
// anyone asked for, but the next one might be.
function openAtTop() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  if (location.hash) return;                     // a deep link means to land there

  let reader = false;
  const yieldToReader = () => { reader = true; };
  // pointerdown, not touchstart: a mouse click fires neither touch nor wheel, and
  // the planner scrolls its own answer into view when you press Plan it — the hold
  // must not yank that back.
  for (const event of ['pointerdown', 'wheel', 'keydown'])
    addEventListener(event, yieldToReader, { passive: true, once: true });

  const hold = (ms) => {
    const until = performance.now() + ms;
    const tick = () => {
      if (reader) return;
      if (window.scrollY) window.scrollTo(0, 0);
      if (performance.now() < until) requestAnimationFrame(tick);
    };
    tick();
  };

  hold(400);
  addEventListener('load', () => hold(400));
  addEventListener('pageshow', () => hold(400));  // includes a bfcache restore
  document.fonts?.ready.then(() => hold(400));
}

export function mountHeader(active) {
  openAtTop();

  const el = document.getElementById('siteHeader');
  if (!el) return;

  // The mark is set the way the pages set everything else: the name in the display
  // face, the protocol stamped in mono. On a phone the nav collapses, so the space
  // it leaves carries the name of the sheet you are on rather than going blank.
  el.innerHTML = `
    <header class="masthead" id="masthead">
      <div class="masthead-inner">
        <a href="/" class="mark" aria-label="Catering WebMCP, home">
          <span class="mark-name">CATERING</span><span class="mark-dot">·</span><span class="mark-code">WEBMCP</span>
        </a>

        <nav class="ml-auto hidden sm:flex gap-4" aria-label="Sections">
          ${NAV.map(n => link(n, active, false)).join('')}
        </nav>

        <span class="masthead-where sm:hidden">${esc(active || '')}</span>
        <button id="navToggle" class="menu-btn sm:hidden" aria-expanded="false" aria-controls="navPanel">Menu</button>
      </div>

      <div id="navPanel" class="navpanel sm:hidden" hidden>
        <nav aria-label="Sections">${NAV.map(n => link(n, active, true)).join('')}</nav>
      </div>
    </header>`;

  const bar = document.getElementById('masthead');
  const btn = document.getElementById('navToggle');
  const panel = document.getElementById('navPanel');

  const set = open => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Close' : 'Menu';
  };
  btn.addEventListener('click', () => set(panel.hidden));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { set(false); btn.focus(); } });
  window.addEventListener('resize', () => { if (window.innerWidth >= 640 && !panel.hidden) set(false); });

  // Sit flush on the sheet until there is something underneath to lift off.
  const lift = () => bar.classList.toggle('lifted', window.scrollY > 4);
  lift();
  window.addEventListener('scroll', lift, { passive: true });
}

export const badge = (kind, text) => `<span class="badge badge-${kind}">${text}</span>`;
export const tierBadge = tier => `<span class="badge badge-tier ${tier}">${tier}</span>`;
export const money = n => (n < 0 ? '\u2212$' : '$') + Math.abs(n);
export const label = s => String(s).replace(/_/g, ' ');

// Vendor text is third-party input and is rendered as text, never as markup.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
