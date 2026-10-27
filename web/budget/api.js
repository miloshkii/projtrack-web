// Budget routes for the in-browser API (see ../localapi.js). Same JSON shapes the standalone Budget app served.
import { computeAnalytics, monthViewTotals, shiftMonth, monthsBetween } from './analytics.js';
import { monthCsv } from './csv.js';
import { monthOf } from './months.js';
import { RateTable, fetchRate, refreshRates } from './rates.js';
import { occurrencesInMonth } from './schedule.js';
import { SPECS, baseCurrency, fromRow, toRow } from './store.js';
import {
  RANGES, ValidationError, requireObject, validCurrency, validMonth, validRate, validateSettings,
} from './validate.js';

const RATES_RETRY_MS = 5 * 60 * 1000;
const localIso = (d) => `${monthOf(d)}-${String(d.getDate()).padStart(2, '0')}`;
const reply = (status, body = null) => ({ status, body });
const notFound = () => reply(404, { error: 'Not found' });
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const decimalRows = (items) => items.filter((i) => i.amount_base !== null)
  .map((i) => ({ amount: i.amount_base, category: i.category, month: i.date.slice(0, 7) }));
const unconvertedCount = (items) => items.filter((i) => i.amount_base === null).length;

export function createBudgetRoutes({ getKey, now = () => new Date(), fetchRate: fetchOne = fetchRate }) {
  let ratesRetryAt = 0;
  const todayIso = () => localIso(now());
  const rateTable = (budget) => new RateTable(budget.rates, baseCurrency(budget));

  function convertItem(item, month, table) {
    const { amount, rate } = table.convert(item.amount, item.currency, month);
    return { ...item, amount_base: amount, rate };
  }

  async function listEntities(budget, name, { month = null, table = rateTable(budget) } = {}) {
    const spec = SPECS[name];
    const rows = month && name !== 'subscriptions' ? budget[name].filter((r) => r.month === month) : budget[name];
    const items = [];
    for (const row of rows) items.push(await fromRow(spec, row, getKey()));
    if (name !== 'subscriptions') items.sort((a, b) => compare(a.date, b.date) || a.id - b.id);
    const conversionMonth = name === 'subscriptions' ? monthOf(now()) : null;
    return items.map((i) => convertItem(i, conversionMonth ?? i.date.slice(0, 7), table));
  }

  async function recurringForMonth(month, table, subscriptions) {
    const found = [];
    for (const sub of subscriptions) {
      for (const day of occurrencesInMonth(sub, month)) {
        const item = {
          subscription_id: sub.id, name: sub.name, category: sub.category, amount: sub.amount,
          currency: sub.currency, date: day,
        };
        if (sub.locked) item.locked = true;
        found.push(convertItem(item, month, table));
      }
    }
    return found.sort((a, b) => compare(a.date, b.date) || compare(a.name, b.name));
  }

  // Fetch on the user's behalf only when auto_fetch_rates is on; back off after a failure.
  async function autoRefresh(ctx, forceCurrent) {
    const { budget } = ctx.db;
    if (!budget.settings.auto_fetch_rates || now().getTime() < ratesRetryAt) return;
    const result = await refreshRates(budget, baseCurrency(budget), todayIso(), { forceCurrent, fetchRate: fetchOne });
    if (result.updated) ctx.dirty = true;
    if (result.errors.length) ratesRetryAt = now().getTime() + RATES_RETRY_MS;
  }

  // ---- entries ----

  const entityRoutes = (name, path) => {
    const spec = SPECS[name];
    const present = async (budget, row) => {
      const table = rateTable(budget);
      const item = await fromRow(spec, row, getKey());
      return convertItem(item, name === 'subscriptions' ? monthOf(now()) : item.date.slice(0, 7), table);
    };
    const find = (budget, id) => budget[name].findIndex((r) => r.id === id);
    return [
      ['GET', new RegExp(`^/budget/${path}$`), async (ctx) => reply(200, await listEntities(ctx.db.budget, name))],
      ['POST', new RegExp(`^/budget/${path}$`), async (ctx) => {
        const { budget } = ctx.db;
        const item = spec.validate(ctx.body, baseCurrency(budget));
        const row = await toRow(spec, item, getKey(), ++budget.seq[name]);
        budget[name].push(row);
        ctx.dirty = true;
        return reply(201, await present(budget, row));
      }],
      ['PUT', new RegExp(`^/budget/${path}/(\\d+)$`), async (ctx, id) => {
        const { budget } = ctx.db;
        const index = find(budget, id);
        if (index === -1) return notFound();
        const item = spec.validate(ctx.body, baseCurrency(budget));
        budget[name][index] = await toRow(spec, item, getKey(), id);
        ctx.dirty = true;
        return reply(200, await present(budget, budget[name][index]));
      }],
      ['DELETE', new RegExp(`^/budget/${path}/(\\d+)$`), async (ctx, id) => {
        const { budget } = ctx.db;
        const index = find(budget, id);
        if (index === -1) return notFound();
        budget[name].splice(index, 1);
        ctx.dirty = true;
        return reply(204);
      }],
    ];
  };

  // ---- views ----

  async function monthView(ctx, month) {
    validMonth(month);
    await autoRefresh(ctx, false);
    const { budget } = ctx.db;
    const table = rateTable(budget);
    const income = await listEntities(budget, 'income', { month, table });
    const expenses = await listEntities(budget, 'expenses', { month, table });
    const recurring = await recurringForMonth(month, table, await listEntities(budget, 'subscriptions', { table }));
    return {
      month, income, expenses, recurring,
      totals: monthViewTotals(decimalRows(income), decimalRows(expenses), decimalRows(recurring)),
      unconverted_count: unconvertedCount([...income, ...expenses, ...recurring]),
      rates_as_of: table.latestAsOf(),
    };
  }

  function windowMonths(rangeName, month, income, expenses, subscriptions) {
    const count = RANGES[rangeName];
    const candidates = [...income, ...expenses].map((i) => i.date.slice(0, 7));
    candidates.push(...subscriptions.filter((s) => s.active).map((s) => s.start_date.slice(0, 7)));
    let first = candidates.filter((c) => c <= month).sort()[0] ?? month;
    if (count) first = first > shiftMonth(month, -(count - 1)) ? first : shiftMonth(month, -(count - 1));
    return monthsBetween(first, month);
  }

  async function analyticsView(ctx, rangeName, month) {
    rangeName = String(rangeName);
    if (!Object.hasOwn(RANGES, rangeName)) throw new ValidationError('range must be 3, 6, 12 or all');
    validMonth(month);
    await autoRefresh(ctx, false);
    const { budget } = ctx.db;
    const table = rateTable(budget);
    const income = await listEntities(budget, 'income', { table });
    const expenses = await listEntities(budget, 'expenses', { table });
    const subscriptions = await listEntities(budget, 'subscriptions', { table });
    const months = windowMonths(rangeName, month, income, expenses, subscriptions);
    const recurring = [];
    for (const m of months) recurring.push(...await recurringForMonth(m, table, subscriptions));
    const result = computeAnalytics(months, decimalRows(income), decimalRows(expenses), decimalRows(recurring), month, rangeName);
    const window = new Set(months);
    result.unconverted_count = unconvertedCount([...income, ...expenses, ...recurring].filter((r) => window.has(r.date.slice(0, 7))));
    result.rates_as_of = table.latestAsOf();
    return result;
  }

  // ---- rates ----

  function listRates(budget) {
    const base = baseCurrency(budget);
    return budget.rates.filter((r) => r.base === base)
      .sort((a, b) => compare(a.currency, b.currency) || (a.source !== 'manual') - (b.source !== 'manual'))
      .sort((a, b) => compare(b.month, a.month));
  }

  const isManual = (r, month, currency, base) => r.source === 'manual' && r.month === month && r.currency === currency && r.base === base;

  function setManualRate(ctx) {
    const data = requireObject(ctx.body);
    const { budget } = ctx.db;
    const base = baseCurrency(budget);
    const month = validMonth(data.month);
    const currency = validCurrency(data.currency);
    if (currency === base) throw new ValidationError('currency must differ from the base currency');
    const row = { month, currency, base, rate: validRate(data.rate), source: 'manual', as_of: todayIso() };
    budget.rates = [...budget.rates.filter((r) => !isManual(r, month, currency, base)), row];
    ctx.dirty = true;
    return reply(200, row);
  }

  function deleteManualRate(ctx, month, currency) {
    const { budget } = ctx.db;
    const base = baseCurrency(budget);
    validMonth(month);
    validCurrency(currency);
    const kept = budget.rates.filter((r) => !isManual(r, month, currency, base));
    if (kept.length === budget.rates.length) return notFound();
    budget.rates = kept;
    ctx.dirty = true;
    return reply(204);
  }

  async function refresh(ctx) {
    const { budget } = ctx.db;
    const result = await refreshRates(budget, baseCurrency(budget), todayIso(), { forceCurrent: true, fetchRate: fetchOne });
    if (result.updated) ctx.dirty = true;
    return reply(200, result);
  }

  // ---- settings ----

  const settingsJson = (budget) => ({ ...budget.settings, base_currency: baseCurrency(budget) });

  return [
    ...entityRoutes('income', 'income'),
    ...entityRoutes('expenses', 'expenses'),
    ...entityRoutes('subscriptions', 'subscriptions'),
    ['GET', /^\/budget\/month\/([^/]+)$/, async (ctx, month) => reply(200, await monthView(ctx, month))],
    ['GET', /^\/budget\/analytics\/([^/]+)\/([^/]+)$/, async (ctx, range, month) => reply(200, await analyticsView(ctx, range, month))],
    ['GET', /^\/budget\/export\/([^/]+)$/, async (ctx, month) => {
      const view = await monthView(ctx, month);
      return reply(200, { filename: `budget-${month}.csv`, csv: monthCsv(view, baseCurrency(ctx.db.budget)) });
    }],
    ['GET', /^\/budget\/rates$/, async (ctx) => reply(200, listRates(ctx.db.budget))],
    ['PUT', /^\/budget\/rates$/, async (ctx) => setManualRate(ctx)],
    ['DELETE', /^\/budget\/rates\/([^/]+)\/([^/]+)$/, async (ctx, month, currency) => deleteManualRate(ctx, month, currency)],
    ['POST', /^\/budget\/rates\/refresh$/, refresh],
    ['GET', /^\/budget\/settings$/, async (ctx) => reply(200, settingsJson(ctx.db.budget))],
    ['PATCH', /^\/budget\/settings$/, async (ctx) => {
      Object.assign(ctx.db.budget.settings, validateSettings(ctx.body));
      ctx.dirty = true;
      return reply(200, settingsJson(ctx.db.budget));
    }],
  ];
}
