// Exchange rates: lookup with month fallback, staleness rules and fetching from Frankfurter (ECB data).
// Only currency codes and dates are ever sent over the network.
import { decimals, isCurrency, roundHalfUp } from './currencies.js';
import { occurrencesInMonth } from './schedule.js';
import { monthsBetween } from './months.js';

export const API_ROOT = 'https://api.frankfurter.dev/v1/';
export const API_HOST = 'api.frankfurter.dev';
const TIMEOUT_MS = 10000;

export class RateHttpError extends Error {
  constructor(status) {
    super(`Frankfurter answered HTTP ${status}`);
    this.status = status;
  }
}
export class RateNetworkError extends Error {}
export class RateFormatError extends Error {}

const pad2 = (n) => String(n).padStart(2, '0');

export function monthEnd(month) {
  const [year, number] = month.split('-').map(Number);
  return `${month}-${pad2(new Date(Date.UTC(year, number, 0)).getUTCDate())}`;
}

// The ECB publishes on weekdays, so a month is complete once its last Mon-Fri day has a rate.
export function lastBusinessDay(month) {
  const [year, number] = month.split('-').map(Number);
  const day = new Date(Date.UTC(year, number, 0));
  while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

// 1 unit of `currency` in `base` on `when` (YYYY-MM-DD or "latest"): {rate, as_of}.
export async function fetchRate(currency, base, when, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = `${API_ROOT}${when}?${new URLSearchParams({ base: currency, symbols: base })}`;
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new RateNetworkError(err?.message || 'network error');
  }
  if (!response.ok) throw new RateHttpError(response.status);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new RateFormatError('unexpected response from Frankfurter');
  }
  const rate = payload?.rates?.[base];
  const asOf = payload?.date;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(asOf ?? '')) {
    throw new RateFormatError('unexpected response from Frankfurter');
  }
  return { rate, as_of: asOf };
}

// Resolves (month, currency) to a rate for one base currency. Rows: {month, currency, base, rate, source, as_of}.
export class RateTable {
  constructor(rows, base) {
    this.base = base;
    this.byCurrency = new Map();
    // Manual rows go last so they replace an ECB row of the same month.
    const ordered = [...rows].sort((a, b) => (a.source === 'manual') - (b.source === 'manual'));
    for (const row of ordered) {
      if (row.base !== base || !(Number(row.rate) > 0) || !Number.isFinite(Number(row.rate))) continue;
      if (!this.byCurrency.has(row.currency)) this.byCurrency.set(row.currency, new Map());
      this.byCurrency.get(row.currency).set(row.month, { rate: Number(row.rate), source: row.source, as_of: row.as_of });
    }
  }

  // Same month, else the nearest earlier month, else the nearest later one; null when nothing is known.
  lookup(month, currency) {
    if (currency === this.base) return { rate: 1, source: 'base', as_of: null };
    const byMonth = this.byCurrency.get(currency);
    if (!byMonth) return null;
    if (byMonth.has(month)) return byMonth.get(month);
    const months = [...byMonth.keys()];
    const earlier = months.filter((m) => m < month);
    if (earlier.length) return byMonth.get(earlier.reduce((a, b) => (a > b ? a : b)));
    const later = months.filter((m) => m > month);
    return later.length ? byMonth.get(later.reduce((a, b) => (a < b ? a : b))) : null;
  }

  // {amount, rate} with the amount in the base currency, or nulls when no rate is known.
  convert(amount, currency, month) {
    const found = this.lookup(month, currency);
    if (!found) return { amount: null, rate: null };
    if (currency === this.base) return { amount, rate: found.rate };
    return { amount: roundHalfUp(amount * found.rate, decimals(this.base)), rate: found.rate };
  }

  latestAsOf() {
    const dates = [];
    for (const byMonth of this.byCurrency.values()) {
      for (const entry of byMonth.values()) if (entry.source === 'ecb') dates.push(entry.as_of);
    }
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }
}

// Every (month, currency) used by entries and subscription occurrences up to the current month.
export function neededPairs(budget, base, currentMonth) {
  const pairs = new Map();
  const add = (month, currency) => {
    if (currency !== base && isCurrency(currency) && month <= currentMonth) pairs.set(`${month}|${currency}`, [month, currency]);
  };
  for (const row of [...budget.income, ...budget.expenses]) add(row.month, row.currency || base);
  for (const sub of budget.subscriptions) {
    const last = sub.end_date && sub.end_date.slice(0, 7) < currentMonth ? sub.end_date.slice(0, 7) : currentMonth;
    if (sub.start_date.slice(0, 7) > last) continue;
    for (const month of monthsBetween(sub.start_date.slice(0, 7), last)) {
      if (occurrencesInMonth(sub, month).length) add(month, sub.currency || base);
    }
  }
  return [...pairs.values()].sort(([m1, c1], [m2, c2]) => (m1 < m2 ? -1 : m1 > m2 ? 1 : c1 < c2 ? -1 : c1 > c2 ? 1 : 0));
}

export function needsFetch(existing, month, currentMonth, forceCurrent) {
  if (!existing) return true;
  if (month === currentMonth) return forceCurrent;
  return existing.as_of < lastBusinessDay(month);
}

// Fetch missing or stale ECB rates into budget.rates. Manual rows are never touched; failures keep the cache.
// `today` is 'YYYY-MM-DD'. Returns {updated, errors}.
export async function refreshRates(budget, base, today, { forceCurrent = true, fetchRate: fetchOne = fetchRate } = {}) {
  const currentMonth = today.slice(0, 7);
  const index = new Map(budget.rates.map((r) => [`${r.month}|${r.currency}|${r.base}|${r.source}`, r]));
  let updated = 0;
  const errors = [];
  for (const [month, currency] of neededPairs(budget, base, currentMonth)) {
    const key = `${month}|${currency}|${base}|ecb`;
    if (!needsFetch(index.get(key), month, currentMonth, forceCurrent)) continue;
    try {
      const { rate, as_of: asOf } = await fetchOne(currency, base, month === currentMonth ? 'latest' : monthEnd(month));
      index.set(key, { month, currency, base, rate, source: 'ecb', as_of: asOf });
      updated += 1;
    } catch (err) {
      if (err instanceof RateNetworkError) {
        errors.push(`could not reach ${API_HOST} (${err.message}); cached rates kept`);
        break;
      }
      if (err instanceof RateHttpError) errors.push(`${currency} ${month}: ${err.message}`);
      else if (err instanceof RateFormatError) errors.push(`${currency} ${month}: ${err.message}`);
      else throw err;
    }
  }
  if (updated) budget.rates = [...index.values()];
  return { updated, errors };
}
