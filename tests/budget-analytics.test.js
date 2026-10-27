import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnalytics, monthViewTotals, monthsBetween, shiftMonth } from '../web/budget/analytics.js';
import { monthsEndingAt } from '../web/budget/months.js';
import { formatMoney, roundHalfUp } from '../web/budget/currencies.js';

const MONTHS = ['2026-01', '2026-02', '2026-03'];
const row = (month, amount, category) => ({ month, amount, category });

function sample() {
  const income = [row('2026-01', 1000, 'Salary'), row('2026-03', 2000, 'Salary')];
  const expenses = [row('2026-01', 300, 'Groceries'), row('2026-01', 100, 'Eating Out'), row('2026-03', 500, 'Groceries')];
  const recurring = [row('2026-01', 50, 'Subscriptions'), row('2026-02', 50, 'Subscriptions'), row('2026-03', 50, 'Subscriptions')];
  return computeAnalytics(MONTHS, income, expenses, recurring, '2026-03', '3');
}

test('month view totals compute spend, net and savings rate', () => {
  const totals = monthViewTotals([row('2026-03', 2000, 'Salary')], [row('2026-03', 500, 'Groceries')], [row('2026-03', 50, 'Subscriptions')]);
  assert.equal(totals.spend, 550);
  assert.equal(totals.net, 1450);
  assert.equal(totals.savings_rate, 72.5);
});

test('savings rate is null when income is zero', () => {
  assert.equal(monthViewTotals([], [row('2026-03', 20, 'Other')], []).savings_rate, null);
});

test('month helpers cross year boundaries', () => {
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2025-12', 1), '2026-01');
  assert.deepEqual(monthsEndingAt('2026-01', 3), ['2025-11', '2025-12', '2026-01']);
  assert.deepEqual(monthsBetween('2025-11', '2026-01'), ['2025-11', '2025-12', '2026-01']);
});

test('monthly totals are zero filled; savings rate is null without income', () => {
  const result = sample();
  assert.deepEqual(result.months.map((m) => m.month), MONTHS);
  const [january, february] = result.months;
  assert.deepEqual([february.income, february.expenses, february.spend, february.savings_rate], [0, 0, 50, null]);
  assert.deepEqual([january.spend, january.net, january.savings_rate], [450, 550, 55]);
});

test('averages cover all months and skip null savings rates', () => {
  assert.deepEqual(sample().averages, { income: 1000, spend: 350, recurring: 50, net: 650, savings_rate: 63.75 });
});

test('category shares and comparison to average', () => {
  const categories = Object.fromEntries(sample().categories.map((c) => [c.category, c]));
  assert.deepEqual(Object.keys(categories), ['Groceries', 'Subscriptions', 'Eating Out']);
  assert.deepEqual(categories.Groceries, {
    category: 'Groceries', total: 800, avg_monthly: 266.67, pct_of_spend: 76.19, pct_of_income: 26.67, current: 500, vs_avg_pct: 87.5,
  });
  assert.equal(categories.Subscriptions.pct_of_spend, 14.29);
  assert.equal(categories.Subscriptions.pct_of_income, 5);
  assert.equal(categories.Subscriptions.vs_avg_pct, 0);
  assert.equal(categories['Eating Out'].current, 0);
  assert.equal(categories['Eating Out'].vs_avg_pct, -100);
});

test('recurring share and current month summary', () => {
  const result = sample();
  assert.equal(result.recurring_share_pct, 14.29);
  assert.deepEqual(result.current, {
    month: '2026-03', income: 2000, spend: 550, net: 1450, savings_rate: 72.5, spend_vs_avg_pct: 57.14,
  });
});

test('rounding is half up and ignores binary noise', () => {
  assert.equal(roundHalfUp(1.005, 2), 1.01);
  assert.equal(roundHalfUp(2.675, 2), 2.68);
  assert.equal(roundHalfUp(1795.495, 0), 1795);
});

test('money formatting uses the currency symbol and decimals', () => {
  assert.equal(formatMoney(1898, 'JPY'), '¥1,898');
  assert.equal(formatMoney(-12, 'USD'), '-$12.00');
  assert.equal(formatMoney(null, 'USD'), '—');
});
