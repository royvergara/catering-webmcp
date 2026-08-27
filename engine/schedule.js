// Pure, dependency-free. No DOM, no fetch. Everything here is unit-testable.
//
// A plan you can hand to another person needs three columns, not two: the job, who
// owns it, and when it has to happen. The third is the one a receipt never shows and
// the one that decides whether the day works.

// Minutes either side of the moment food is served. Negative is before.
export const JOB_TIMING = {
  food:                        { at: -600, style: 'morning', label: 'cook and pack' },
  transport:                   { at: -180, style: 'at',      label: 'collect' },
  warming_trays:               { at: -60,  style: 'by' },
  fuel:                        { at: -60,  style: 'by' },
  serving_utensils:            { at: -45,  style: 'by' },
  plates:                      { at: 0,    style: 'by' },
  setup:                       { at: -45,  style: 'at' },
  someone_on_site_at_delivery: { at: -45,  style: 'at' },
  access_30min_before:         { at: -30,  style: 'at' },
  parking:                     { at: -30,  style: 'at' },
  refills:                     { at: 0,    style: 'during' },
  fuel_monitoring:             { at: 0,    style: 'during' },
  hold_temperature:            { at: 0,    style: 'during' },
  cleanup:                     { at: 1,    style: 'after' },
  return_by_monday:            { at: 0,    style: 'later',   label: 'return the hire' }
};

const DEFAULT_TIMING = { at: -45, style: 'by' };

// Read the clock off the stated time. Converting to UTC first moves a 6pm dinner to
// 23:00 and can roll it onto the next day.
function wallClock(iso) {
  const t = String(iso).slice(11, 16);
  const [h, m] = t.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

export function formatClock(minutes) {
  let total = minutes, day = 0;
  while (total < 0) { total += 1440; day--; }
  while (total >= 1440) { total -= 1440; day++; }
  const h24 = Math.floor(total / 60), m = total % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? 'am' : 'pm';
  const clock = m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`;
  return day === 0 ? clock : day < 0 ? `${clock} the day before` : `${clock} the next day`;
}

// When one job has to happen, phrased the way a person would say it.
export function scheduleJob(job, { serveAt, durationHours = 3 } = {}) {
  const serve = wallClock(serveAt);
  const timing = JOB_TIMING[job] || DEFAULT_TIMING;
  if (serve === null) return { job, when: 'time not set', sort: timing.at };

  const end = serve + Math.round(durationHours * 60);
  const at = serve + timing.at;

  let when;
  switch (timing.style) {
    case 'morning': when = 'that morning'; break;
    case 'by':      when = `by ${formatClock(at)}`; break;
    case 'during':  when = `${formatClock(serve)}–${formatClock(end)}`; break;
    case 'after':   when = `after ${formatClock(end)}`; break;
    case 'later':   when = 'the next business day'; break;
    default:        when = formatClock(at);
  }
  return { job, when, sort: timing.style === 'after' ? end : at, label: timing.label || null };
}

// The whole day in order. Jobs that happen at the same moment keep a stable order.
export function timeline(rows, ctx) {
  return rows
    .map((r, i) => ({ ...r, ...scheduleJob(r.job, ctx), index: i }))
    .sort((a, b) => a.sort - b.sort || a.index - b.index)
    .map(({ index, ...r }) => r);
}

// Holding hot food above a safe temperature is work, and at pickup or delivery it is
// the customer's work. No vendor lists it because no vendor is doing it.
export const HOLD_TEMPERATURE_JOB = 'hold_temperature';

export function addHostHoldingJob(rows, { serviceLevel, hasHotFood }) {
  if (!hasHotFood) return rows;
  const vendorHolds = serviceLevel === 'staffed' || serviceLevel === 'full_service';
  if (vendorHolds) return rows;
  if (rows.some(r => r.job === HOLD_TEMPERATURE_JOB)) return rows;
  return [...rows, { job: HOLD_TEMPERATURE_JOB, who: 'You', source: 'left to you' }];
}
