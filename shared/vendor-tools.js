// Pure tool definitions. No DOM, no fetch, no browser.
// vendor.html registers these with document.modelContext.
// Node tests import these directly, so tool behaviour is testable without a browser.

export function buildVendorTools(v) {
  return [
    {
      name: 'check_availability',
      description: `Check whether ${v.name} can take an order for a date and headcount.`,
      inputSchema: {
        type: 'object',
        properties: { date: { type: 'string' }, headcount: { type: 'number' } },
        required: ['date']
      },
      run: ({ date }) => ({
        vendor: v.slug,
        status: (v.blackout_dates || []).includes(date) ? 'booked' : 'open',
        lead_time_hours: v.lead_time_hours,
        service_levels: v.service_levels,
        source: { tier: v.tier, as_of: new Date().toISOString() }
      })
    },
    {
      name: 'get_menu',
      description: `Menu items with serving counts, the basis those counts assume, dietary tags and minimums.`,
      inputSchema: {
        type: 'object',
        properties: { dietary: { type: 'array', items: { type: 'string' } } }
      },
      run: ({ dietary } = {}) => ({
        vendor: v.slug,
        items: dietary?.length
          ? v.menu.filter(i => dietary.some(d => (i.dietary || []).includes(d)))
          : v.menu,
        source: { tier: v.tier }
      })
    },
    {
      name: 'get_requirements',
      description: `What ${v.name} needs the customer to supply or do, at a given service level.`,
      inputSchema: {
        type: 'object',
        properties: { service_level: { type: 'string', enum: v.service_levels } },
        required: ['service_level']
      },
      run: ({ service_level }) => {
        const r = v.requirements?.[service_level];
        if (!r) return { vendor: v.slug, service_level, error: 'service level not offered' };
        return { vendor: v.slug, service_level, ...r, stated: true, source: { tier: v.tier } };
      }
    },
    {
      name: 'propose_accommodation',
      description: `What ${v.name} can do about a stated problem, and what it costs.`,
      inputSchema: {
        type: 'object',
        properties: { constraint: { type: 'string' } },
        required: ['constraint']
      },
      run: ({ constraint }) => ({
        vendor: v.slug,
        options: (v.accommodations || []).filter(
          a => !constraint || a.for === constraint || String(constraint).includes(a.for)
        )
      })
    },
    {
      name: 'hold',
      description: `Place a soft, non-binding hold with ${v.name}. Expires.`,
      inputSchema: {
        type: 'object',
        properties: { items: { type: 'array', items: { type: 'string' } }, date: { type: 'string' } },
        required: ['date']
      },
      run: ({ items = [], date }) => ({
        vendor: v.slug,
        hold_id: `${v.slug}-${Date.now()}`,
        items, date,
        expires_at: new Date(Date.now() + 864e5).toISOString(),
        binding: false
      })
    }
  ];
}
