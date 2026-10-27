// Subscription schedule: the dates a subscription is charged in a given month ('YYYY-MM').
const DAY_MS = 86400000;
const MONTH_STEP = { monthly: 1, quarterly: 3, yearly: 12 };

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const toMs = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

function weeklyDates(startMs, year, month) {
  const first = Date.UTC(year, month - 1, 1);
  const last = Date.UTC(year, month - 1, daysInMonth(year, month));
  if (last < startMs) return [];
  const offsetDays = Math.max(0, Math.round((first - startMs) / DAY_MS));
  const found = [];
  for (let at = startMs + Math.ceil(offsetDays / 7) * 7 * DAY_MS; at <= last; at += 7 * DAY_MS) found.push(toIso(at));
  return found;
}

// Same day of month as the start, clamped to the month's length (the 31st lands on the 28th in February).
function stepDates(startIso, year, month, step) {
  const [startYear, startMonth, startDay] = startIso.split('-').map(Number);
  const sinceStart = (year - startYear) * 12 + (month - startMonth);
  if (sinceStart < 0 || sinceStart % step !== 0) return [];
  const day = Math.min(startDay, daysInMonth(year, month));
  return [`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`];
}

export function occurrencesInMonth(subscription, month) {
  if (subscription.active === false) return [];
  const start = subscription.start_date;
  const [year, monthNumber] = month.split('-').map(Number);
  const found = subscription.frequency === 'weekly'
    ? weeklyDates(toMs(start), year, monthNumber)
    : stepDates(start, year, monthNumber, MONTH_STEP[subscription.frequency]);
  const end = subscription.end_date;
  return found.filter((day) => day >= start && (!end || day <= end));
}
