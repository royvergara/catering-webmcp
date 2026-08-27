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

// Open at the top. The real work is done by the inline script in every page's
// <head>: scroll restoration has to be switched off before the browser decides to
// restore, and a module script is deferred, so doing it from here was always too
// late — Chromium happened to forgive it and iOS Safari did not. This is only the
// belt: if a page still arrives scrolled, put it back once. A fragment in the URL
// means the reader asked to land somewhere, so leave it alone.
function openAtTop() {
  if (!location.hash && window.scrollY) window.scrollTo(0, 0);
}

export function mountHeader(active) {
  openAtTop();

  const el = document.getElementById('siteHeader');
  if (!el) return;

  // The mark is set the way the pages set everything else: the name in the display
  // face, the protocol stamped in mono. On a phone the nav collapses, so the space
  // it leaves carries the name of the sheet you are on rather than going blank.
  el.innerHTML = `
    <header class="masthead">
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

  // Sit flush on the sheet until there is something underneath to lift off. The
  // shadow goes on the wrapper, which is the element that actually sticks.
  const lift = () => el.classList.toggle('lifted', window.scrollY > 4);
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
