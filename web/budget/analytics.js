// Month totals and multi-month analytics over rows already converted to the base currency.
import { roundHalfUp } from './currencies.js';
import { monthsBetween, shiftMonth } from './months.js';

export { shiftMonth, monthsBetween };

export const money = (value) => (value == null ? null : roundHalfUp(value, 2));

export function percent(numerator, denominator) {
  return denominator === 0 ? null : money((numerator / denominator) * 100);
}

const sum = (values) => values.reduce((total, v) => total + v, 0);
const mean = (values) => (values.length ? sum(values) / values.length : null);

function sumBy(rows, keyOf) {
  const totals = new Map();
  for (const row of rows) totals.set(keyOf(row), (totals.get(keyOf(row)) ?? 0) + row.amount);
  return totals;
}

export function monthTotals(income, expenses, recurring) {
  const spend = expenses + recurring;
  const net = income - spend;
  return { income, expenses, recurring, spend, net, savings_rate: income === 0 ? null : (net / income) * 100 };
}

function roundedTotals(totals) {
  const result = {};
  for (const [key, value] of Object.entries(totals)) result[key] = money(value);
  return result;
}

// Rows are {amount, category, month} in the base currency.
export function monthViewTotals(incomeRows, expenseRows, recurringRows) {
  const total = (rows) => sum(rows.map((r) => r.amount));
  return roundedTotals(monthTotals(total(incomeRows), total(expenseRows), total(recurringRows)));
}

function averages(summaries) {
  const items = [...summaries.values()];
  const rates = items.map((s) => s.savings_rate).filter((r) => r !== null);
  return {
    income: money(mean(items.map((s) => s.income))),
    spend: money(mean(items.map((s) => s.spend))),
    recurring: money(mean(items.map((s) => s.recurring))),
    net: money(mean(items.map((s) => s.net))),
    savings_rate: money(mean(rates)),
  };
}

function categories(months, summaries, spendRows, currentMonth) {
  const window = new Set(months);
  const inWindow = spendRows.filter((r) => window.has(r.month));
  const totals = sumBy(inWindow, (r) => r.category);
  const currentTotals = sumBy(inWindow.filter((r) => r.month === currentMonth), (r) => r.category);
  const totalSpend = sum([...summaries.values()].map((s) => s.spend));
  const totalIncome = sum([...summaries.values()].map((s) => s.income));
  const byTotalThenName = ([nameA, a], [nameB, b]) => b - a || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0);
  return [...totals.entries()].sort(byTotalThenName).map(([category, total]) => {
    const average = total / months.length;
    const current = currentTotals.get(category) ?? 0;
    return {
      category,
      total: money(total),
      avg_monthly: money(average),
      pct_of_spend: percent(total, totalSpend),
      pct_of_income: percent(total, totalIncome),
      current: money(current),
      vs_avg_pct: percent(current - average, average),
    };
  });
}

function currentSummary(summaries, currentMonth) {
  const current = summaries.get(currentMonth);
  const averageSpend = mean([...summaries.values()].map((s) => s.spend));
  const rounded = roundedTotals(current);
  return {
    month: currentMonth,
    income: rounded.income,
    spend: rounded.spend,
    net: rounded.net,
    savings_rate: rounded.savings_rate,
    spend_vs_avg_pct: percent(current.spend - averageSpend, averageSpend),
  };
}

export function computeAnalytics(months, incomeRows, expenseRows, recurringRows, currentMonth, rangeLabel) {
  const income = sumBy(incomeRows, (r) => r.month);
  const expenses = sumBy(expenseRows, (r) => r.month);
  const recurring = sumBy(recurringRows, (r) => r.month);
  const summaries = new Map(months.map((m) => [m, monthTotals(income.get(m) ?? 0, expenses.get(m) ?? 0, recurring.get(m) ?? 0)]));
  const all = [...summaries.values()];
  return {
    range: rangeLabel,
    months: months.map((m) => ({ month: m, ...roundedTotals(summaries.get(m)) })),
    averages: averages(summaries),
    categories: categories(months, summaries, [...expenseRows, ...recurringRows], currentMonth),
    current: currentSummary(summaries, currentMonth),
    recurring_share_pct: percent(sum(all.map((s) => s.recurring)), sum(all.map((s) => s.spend))),
  };
}
