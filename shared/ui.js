// Shared UI helpers so every page uses the same patterns.
const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/plan.html', label: 'Planner' },
  { href: '/harness.html', label: 'Tool harness' },
  { href: '/smoke.html', label: 'Smoke test' }
];

const link = (n, active, mobile) => {
  const on = n.label === active;
  return mobile
    ? `<a href="${n.href}" class="block py-2.5 px-1 no-underline border-b border-rule ${
        on ? 'text-ink font-semibold' : 'text-ink-soft'}">${n.label}${on ? ' <span class="text-carbon">·</span>' : ''}</a>`
    : `<a href="${n.href}" class="no-underline whitespace-nowrap ${
        on ? 'text-ink font-semibold border-b-2 border-carbon pb-0.5' : 'text-ink-mute hover:text-ink'}">${n.label}</a>`;
};

export function mountHeader(active) {
  const el = document.getElementById('siteHeader');
  if (!el) return;

  el.innerHTML = `
    <header class="border-b border-rule bg-paper-card sticky top-0 z-20">
      <div class="mx-auto max-w-3xl px-5 h-14 flex items-center gap-4">
        <a href="/" class="font-display font-extrabold tracking-tightest text-[15px] text-ink no-underline">
          CATERING<span class="text-carbon">·</span>WEBMCP
        </a>

        <nav class="ml-auto hidden sm:flex gap-4 text-[13px]">
          ${NAV.map(n => link(n, active, false)).join('')}
        </nav>

        <button id="navToggle" class="ml-auto sm:hidden -mr-2 p-2 rounded-chit"
                aria-label="Open menu" aria-expanded="false" aria-controls="navPanel">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <g stroke="currentColor" stroke-width="1.75" stroke-linecap="round">
              <path id="navBar1" d="M3 6.5h16"/><path id="navBar2" d="M3 11h16"/><path id="navBar3" d="M3 15.5h16"/>
            </g>
          </svg>
        </button>
      </div>

      <div id="navPanel" class="sm:hidden border-t border-rule bg-paper-card px-5 pb-2" hidden>
        <nav class="text-[15px]">${NAV.map(n => link(n, active, true)).join('')}</nav>
      </div>
    </header>`;

  const btn = document.getElementById('navToggle');
  const panel = document.getElementById('navPanel');
  const set = open => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    document.getElementById('navBar1').setAttribute('d', open ? 'M5 5l12 12' : 'M3 6.5h16');
    document.getElementById('navBar2').style.opacity = open ? '0' : '1';
    document.getElementById('navBar3').setAttribute('d', open ? 'M17 5L5 17' : 'M3 15.5h16');
  };
  btn.addEventListener('click', () => set(panel.hidden));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { set(false); btn.focus(); } });
  window.addEventListener('resize', () => { if (window.innerWidth >= 640 && !panel.hidden) set(false); });
}

export const badge = (kind, text) => `<span class="badge badge-${kind}">${text}</span>`;
export const tierBadge = tier => `<span class="badge badge-tier ${tier}">${tier}</span>`;
export const money = n => (n < 0 ? '\u2212$' : '$') + Math.abs(n);
export const label = s => String(s).replace(/_/g, ' ');
