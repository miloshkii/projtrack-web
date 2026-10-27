import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RateFormatError, RateHttpError, RateNetworkError, RateTable, fetchRate, lastBusinessDay, monthEnd, refreshRates,
} from '../web/budget/rates.js';
import { emptyBudget } from '../web/budget/store.js';

const rateRow = (month, currency, rate, source = 'ecb', asOf = `${month}-28`, base = 'JPY') => ({
  month, currency, base, rate, source, as_of: asOf,
});

test('same currency converts at one', () => {
  assert.deepEqual(new RateTable([], 'JPY').convert(100, 'JPY', '2026-03'), { amount: 100, rate: 1 });
});

test('the exact month beats its neighbours', () => {
  const table = new RateTable([rateRow('2026-02', 'USD', 140), rateRow('2026-03', 'USD', 150), rateRow('2026-04', 'USD', 160)], 'JPY');
  assert.deepEqual(table.convert(10, 'USD', '2026-03'), { amount: 1500, rate: 150 });
});

test('falls back to the nearest earlier month, then the nearest later one', () => {
  const table = new RateTable([rateRow('2026-01', 'USD', 140), rateRow('2026-02', 'USD', 145), rateRow('2026-06', 'USD', 160)], 'JPY');
  assert.equal(table.lookup('2026-04', 'USD').rate, 145);
  assert.equal(table.lookup('2025-12', 'USD').rate, 140);
  assert.equal(new RateTable([rateRow('2026-06', 'USD', 160)], 'JPY').lookup('2026-01', 'USD').rate, 160);
});

test('a manual rate beats the ECB rate of the same month; an exact ECB month beats an earlier manual one', () => {
  const same = new RateTable([rateRow('2026-03', 'USD', 150), rateRow('2026-03', 'USD', 155, 'manual')], 'JPY');
  assert.deepEqual([same.lookup('2026-03', 'USD').source, same.lookup('2026-03', 'USD').rate], ['manual', 155]);
  const earlier = new RateTable([rateRow('2026-02', 'USD', 155, 'manual'), rateRow('2026-03', 'USD', 150)], 'JPY');
  assert.equal(earlier.lookup('2026-03', 'USD').rate, 150);
});

test('an unknown currency is unconverted and other bases are ignored', () => {
  assert.deepEqual(new RateTable([rateRow('2026-03', 'USD', 150)], 'JPY').convert(5, 'GBP', '2026-03'), { amount: null, rate: null });
  assert.equal(new RateTable([rateRow('2026-03', 'USD', 0.9, 'ecb', '2026-03-28', 'EUR')], 'JPY').lookup('2026-03', 'USD'), null);
});

test('conversion rounds to the base currency decimals', () => {
  assert.equal(new RateTable([rateRow('2026-03', 'USD', 149.5)], 'JPY').convert(12.01, 'USD', '2026-03').amount, 1795);
  const toDollars = new RateTable([rateRow('2026-03', 'JPY', 0.0067, 'ecb', '2026-03-28', 'USD')], 'USD');
  assert.equal(toDollars.convert(1000, 'JPY', '2026-03').amount, 6.7);
});

test('month end and last business day', () => {
  assert.equal(monthEnd('2026-02'), '2026-02-28');
  assert.equal(lastBusinessDay('2026-01'), '2026-01-30'); // the 31st is a Saturday
  assert.equal(lastBusinessDay('2026-03'), '2026-03-31');
});

// ---- refresh ----

const TODAY = '2026-05-15';

function budgetWith({ expenses = [], subscriptions = [], rates = [] } = {}) {
  const budget = emptyBudget();
  budget.expenses = expenses.map(([month, currency], i) => ({ id: i + 1, date: `${month}-02`, month, currency, kind: 'transaction' }));
  budget.subscriptions = subscriptions;
  budget.rates = rates;
  return budget;
}

function recorder(fn = async (currency, base, when) => ({ rate: 150, as_of: when === 'latest' ? '2026-05-14' : when })) {
  const calls = [];
  return { calls, fetchRate: async (...args) => { calls.push(args); return fn(...args); } };
}

const stored = (budget) => Object.fromEntries(budget.rates.map((r) => [`${r.month}|${r.currency}|${r.source}`, r]));

test('fetches each month and currency in use once', async () => {
  const budget = budgetWith({ expenses: [['2026-03', 'USD'], ['2026-03', 'USD'], ['2026-05', 'GBP'], ['2026-04', 'JPY']] });
  const { calls, fetchRate: f } = recorder();
  const result = await refreshRates(budget, 'JPY', TODAY, { fetchRate: f });
  assert.deepEqual(result, { updated: 2, errors: [] });
  assert.deepEqual(calls.map((c) => c.join(' ')).sort(), ['GBP JPY latest', 'USD JPY 2026-03-31']);
  assert.equal(stored(budget)['2026-05|GBP|ecb'].as_of, '2026-05-14');
});

test('subscription occurrences cover the months through the current one', async () => {
  const sub = { id: 1, currency: 'USD', frequency: 'monthly', start_date: '2026-03-10', end_date: null, active: true };
  const { calls, fetchRate: f } = recorder();
  const result = await refreshRates(budgetWith({ subscriptions: [sub] }), 'JPY', TODAY, { fetchRate: f });
  assert.equal(result.updated, 3);
  assert.deepEqual(calls.map((c) => c[2]).sort(), ['2026-03-31', '2026-04-30', 'latest']);
});

test('the current month is refetched on every forced refresh but not when unforced', async () => {
  const budget = budgetWith({ expenses: [['2026-05', 'USD']] });
  await refreshRates(budget, 'JPY', TODAY, { fetchRate: recorder().fetchRate });
  const forced = recorder();
  assert.equal((await refreshRates(budget, 'JPY', TODAY, { fetchRate: forced.fetchRate })).updated, 1);
  const unforced = recorder();
  const result = await refreshRates(budget, 'JPY', TODAY, { forceCurrent: false, fetchRate: unforced.fetchRate });
  assert.deepEqual([result.updated, unforced.calls.length], [0, 0]);
});

test('a complete past month is not refetched, an early one is', async () => {
  const complete = budgetWith({ expenses: [['2026-03', 'USD']] });
  await refreshRates(complete, 'JPY', TODAY, { fetchRate: recorder().fetchRate });
  const again = recorder();
  assert.equal((await refreshRates(complete, 'JPY', TODAY, { fetchRate: again.fetchRate })).updated, 0);
  assert.equal(again.calls.length, 0);

  const early = budgetWith({ expenses: [['2026-04', 'USD']], rates: [rateRow('2026-04', 'USD', 148, 'ecb', '2026-04-20')] });
  assert.equal((await refreshRates(early, 'JPY', TODAY, { fetchRate: recorder().fetchRate })).updated, 1);
  assert.equal(stored(early)['2026-04|USD|ecb'].as_of, '2026-04-30');
});

test('a month ending on a weekend counts as complete once the last business day is stored', async () => {
  const budget = budgetWith({ expenses: [['2026-01', 'USD']], rates: [rateRow('2026-01', 'USD', 148, 'ecb', '2026-01-30')] });
  const { calls, fetchRate: f } = recorder();
  assert.equal((await refreshRates(budget, 'JPY', TODAY, { fetchRate: f })).updated, 0);
  assert.equal(calls.length, 0);
});

test('manual rows are never overwritten', async () => {
  const budget = budgetWith({ expenses: [['2026-04', 'USD']], rates: [rateRow('2026-04', 'USD', 155, 'manual', '2026-04-02')] });
  assert.equal((await refreshRates(budget, 'JPY', TODAY, { fetchRate: recorder().fetchRate })).updated, 1);
  assert.equal(stored(budget)['2026-04|USD|manual'].rate, 155);
  assert.equal(stored(budget)['2026-04|USD|ecb'].rate, 150);
});

test('a network error keeps the cache, reports once and stops', async () => {
  const budget = budgetWith({
    expenses: [['2026-04', 'USD'], ['2026-05', 'USD']], rates: [rateRow('2026-04', 'USD', 148, 'ecb', '2026-04-30')],
  });
  const { calls, fetchRate: f } = recorder(async () => { throw new RateNetworkError('offline'); });
  const result = await refreshRates(budget, 'JPY', TODAY, { fetchRate: f });
  assert.equal(result.updated, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /cached rates kept/);
  assert.equal(calls.length, 1);
  assert.equal(stored(budget)['2026-04|USD|ecb'].rate, 148);
});

test('an HTTP error skips that pair and continues', async () => {
  const budget = budgetWith({ expenses: [['2026-03', 'USD'], ['2026-03', 'GBP']] });
  const { fetchRate: f } = recorder(async (currency, base, when) => {
    if (currency === 'GBP') throw new RateHttpError(404);
    return { rate: 150, as_of: when };
  });
  const result = await refreshRates(budget, 'JPY', TODAY, { fetchRate: f });
  assert.equal(result.updated, 1);
  assert.equal(result.errors.length, 1);
});

test('nothing foreign means no requests', async () => {
  const { calls, fetchRate: f } = recorder();
  const result = await refreshRates(budgetWith({ expenses: [['2026-03', 'JPY']] }), 'JPY', TODAY, { fetchRate: f });
  assert.deepEqual([result, calls.length], [{ updated: 0, errors: [] }, 0]);
});

// ---- Frankfurter client ----

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('fetchRate asks for one currency pair and reads the rate and date', async () => {
  let url;
  const fetchImpl = async (u) => { url = u; return jsonResponse({ amount: 1, base: 'USD', date: '2026-03-31', rates: { JPY: 150.25 } }); };
  assert.deepEqual(await fetchRate('USD', 'JPY', '2026-03-31', { fetchImpl }), { rate: 150.25, as_of: '2026-03-31' });
  assert.equal(url, 'https://api.frankfurter.dev/v1/2026-03-31?base=USD&symbols=JPY');
});

test('fetchRate maps failures to typed errors', async () => {
  const get = (fetchImpl) => fetchRate('USD', 'JPY', 'latest', { fetchImpl });
  await assert.rejects(get(async () => { throw new TypeError('Failed to fetch'); }), RateNetworkError);
  await assert.rejects(get(async () => jsonResponse({}, 404)), RateHttpError);
  await assert.rejects(get(async () => jsonResponse({ date: '2026-03-31', rates: { JPY: -1 } })), RateFormatError);
  await assert.rejects(get(async () => jsonResponse({ rates: { JPY: 150 } })), RateFormatError);
});
