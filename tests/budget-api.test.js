import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, newApp, unlockedApp } from './helpers.js';

const NOW = () => new Date(2026, 4, 15, 12);
const ecb = (rate) => async (currency, base, when) => ({ rate, as_of: when === 'latest' ? '2026-05-14' : when });

const budgetApp = (opts) => unlockedApp({ now: NOW, ...opts });

async function post(app, path, body, status = 201) {
  const res = await app.call('POST', path, body);
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res.body;
}

const expense = (overrides = {}) => ({
  date: '2026-05-03', category: 'Groceries', amount: 12.5, kind: 'transaction', payee: 'Corner Shop', note: 'milk', ...overrides,
});
const income = (overrides = {}) => ({ date: '2026-05-01', category: 'Salary', amount: 3000, source: 'Acme', note: '', ...overrides });
const subscription = (overrides = {}) => ({
  name: 'Streaming', category: 'Subscriptions', amount: 10, frequency: 'monthly', start_date: '2026-03-10', ...overrides,
});

test('budget routes need an unlocked session', async () => {
  const app = newApp();
  assert.equal((await app.call('GET', '/budget/month/2026-05')).status, 401);
});

test('entries round trip with their decrypted text and a base currency conversion', async () => {
  const app = await budgetApp();
  const created = await post(app, '/budget/expenses', expense());
  assert.deepEqual(
    { payee: created.payee, note: created.note, currency: created.currency, amount_base: created.amount_base, rate: created.rate },
    { payee: 'Corner Shop', note: 'milk', currency: 'JPY', amount_base: 12.5, rate: 1 },
  );
  const list = (await app.call('GET', '/budget/expenses')).body;
  assert.deepEqual(list.map((e) => e.payee), ['Corner Shop']);
});

test('payee, source, name and note are encrypted at rest; amounts and dates are not', async () => {
  const app = await budgetApp();
  await post(app, '/budget/expenses', expense({ payee: 'SecretPayee', note: 'SecretNote' }));
  await post(app, '/budget/income', income({ source: 'SecretSource' }));
  await post(app, '/budget/subscriptions', subscription({ name: 'SecretName', note: 'SecretSubNote' }));
  const raw = JSON.stringify(await app.store.load());
  for (const secret of ['SecretPayee', 'SecretNote', 'SecretSource', 'SecretName', 'SecretSubNote']) {
    assert.ok(!raw.includes(secret), secret);
  }
  const { budget } = await app.store.load();
  assert.equal(budget.expenses[0].date, '2026-05-03');
  assert.equal(budget.expenses[0].amount, 12.5);
  assert.match(budget.expenses[0].payee_enc, /^[A-Za-z0-9+/=]+$/);
});

test('empty text fields stay empty', async () => {
  const app = await budgetApp();
  await post(app, '/budget/income', income({ source: '', note: '' }));
  const { budget } = await app.store.load();
  assert.deepEqual([budget.income[0].source_enc, budget.income[0].note_enc], ['', '']);
});

test('update replaces an entry and delete removes it', async () => {
  const app = await budgetApp();
  const { id } = await post(app, '/budget/expenses', expense());
  const updated = await app.call('PUT', `/budget/expenses/${id}`, expense({ amount: 20, payee: 'Other' }));
  assert.deepEqual([updated.status, updated.body.amount, updated.body.payee], [200, 20, 'Other']);
  assert.equal((await app.call('DELETE', `/budget/expenses/${id}`)).status, 204);
  assert.equal((await app.call('DELETE', `/budget/expenses/${id}`)).status, 404);
  assert.equal((await app.call('PUT', `/budget/expenses/${id}`, expense())).status, 404);
});

test('validation errors are 400 with the standalone app messages', async () => {
  const app = await budgetApp();
  const bad = async (path, body) => (await app.call('POST', path, body)).body.error;
  assert.equal(await bad('/budget/expenses', expense({ amount: 0 })), 'amount must be greater than 0');
  assert.equal(await bad('/budget/expenses', expense({ date: '2026-02-30' })), 'date is not a real date');
  assert.equal(await bad('/budget/expenses', expense({ kind: 'x' })), 'kind must be one of: transaction, lump');
  assert.equal(await bad('/budget/income', income({ currency: 'XXX' })), 'currency must be a supported ISO code, e.g. JPY, USD, EUR');
  assert.equal(await bad('/budget/subscriptions', subscription({ end_date: '2026-01-01' })), 'end_date must not be before start_date');
  assert.equal(await bad('/budget/subscriptions', subscription({ name: ' ' })), 'name is required');
  assert.equal((await app.call('GET', '/budget/month/2026-13')).body.error, 'm must be YYYY-MM');
  assert.equal((await app.call('GET', '/budget/analytics/7/2026-05')).body.error, 'range must be 3, 6, 12 or all');
});

test('the month view lists entries, expands subscriptions and totals them', async () => {
  const app = await budgetApp();
  await post(app, '/budget/income', income());
  await post(app, '/budget/expenses', expense({ amount: 500, date: '2026-05-20' }));
  await post(app, '/budget/expenses', expense({ amount: 99, date: '2026-04-20' }));
  await post(app, '/budget/subscriptions', subscription({ amount: 100 }));
  const view = (await app.call('GET', '/budget/month/2026-05')).body;
  assert.deepEqual(view.recurring.map((r) => [r.date, r.name]), [['2026-05-10', 'Streaming']]);
  assert.equal(view.expenses.length, 1);
  assert.deepEqual(view.totals, { income: 3000, expenses: 500, recurring: 100, spend: 600, net: 2400, savings_rate: 80 });
  assert.equal(view.unconverted_count, 0);
});

test('foreign amounts without a rate are flagged and left out of totals', async () => {
  const app = await budgetApp();
  await post(app, '/budget/income', income());
  const usd = await post(app, '/budget/expenses', expense({ amount: 12, currency: 'USD' }));
  assert.deepEqual([usd.amount_base, usd.rate], [null, null]);
  const view = (await app.call('GET', '/budget/month/2026-05')).body;
  assert.equal(view.unconverted_count, 1);
  assert.equal(view.totals.expenses, 0);
  assert.equal(view.rates_as_of, null);
});

test('a manual rate converts foreign amounts, wins over ECB, and can be removed', async () => {
  const app = await budgetApp({ fetchRate: ecb(150) });
  await post(app, '/budget/expenses', expense({ amount: 10, currency: 'USD' }));
  assert.equal((await app.call('PUT', '/budget/rates', { month: '2026-05', currency: 'JPY', rate: 1 })).status, 400);
  assert.equal((await app.call('PUT', '/budget/rates', { month: '2026-05', currency: 'USD', rate: 155 })).status, 200);
  assert.deepEqual((await app.call('POST', '/budget/rates/refresh')).body, { updated: 1, errors: [] });
  const view = (await app.call('GET', '/budget/month/2026-05')).body;
  assert.deepEqual([view.expenses[0].amount_base, view.expenses[0].rate], [1550, 155]);
  assert.deepEqual((await app.call('GET', '/budget/rates')).body.map((r) => r.source).sort(), ['ecb', 'manual']);
  assert.equal((await app.call('DELETE', '/budget/rates/2026-05/USD')).status, 204);
  assert.equal((await app.call('DELETE', '/budget/rates/2026-05/USD')).status, 404);
  assert.equal((await app.call('GET', '/budget/month/2026-05')).body.expenses[0].rate, 150);
});

test('a failed refresh reports the error and keeps the cache', async () => {
  const { RateNetworkError } = await import('../web/budget/rates.js');
  const app = await budgetApp({ fetchRate: async () => { throw new RateNetworkError('offline'); } });
  await post(app, '/budget/expenses', expense({ currency: 'USD' }));
  const res = await app.call('POST', '/budget/rates/refresh');
  assert.equal(res.body.updated, 0);
  assert.match(res.body.errors[0], /cached rates kept/);
});

test('rates are fetched on view only when auto fetch is on, and not again after a failure', async () => {
  let calls = 0;
  const app = await budgetApp({ fetchRate: async (...args) => { calls += 1; return ecb(150)(...args); } });
  await post(app, '/budget/expenses', expense({ currency: 'USD' }));
  await app.call('GET', '/budget/month/2026-05');
  assert.equal(calls, 0);
  await app.call('PATCH', '/budget/settings', { auto_fetch_rates: true });
  const view = (await app.call('GET', '/budget/month/2026-05')).body;
  assert.equal(calls, 1);
  assert.equal(view.expenses[0].amount_base, 1875);
});

test('analytics windows start at the first entry and honour the range', async () => {
  const app = await budgetApp();
  await post(app, '/budget/income', income({ date: '2026-03-01' }));
  await post(app, '/budget/expenses', expense({ date: '2026-04-02', amount: 100 }));
  const all = (await app.call('GET', '/budget/analytics/all/2026-05')).body;
  assert.deepEqual(all.months.map((m) => m.month), ['2026-03', '2026-04', '2026-05']);
  const two = (await app.call('GET', '/budget/analytics/3/2026-05')).body;
  assert.equal(two.range, '3');
  const recent = (await app.call('GET', '/budget/analytics/6/2026-03')).body;
  assert.deepEqual(recent.months.map((m) => m.month), ['2026-03']);
});

test('settings validate and persist', async () => {
  const app = await budgetApp();
  const defaults = (await app.call('GET', '/budget/settings')).body;
  assert.deepEqual([defaults.base_currency, defaults.autolock_minutes, defaults.auto_fetch_rates], ['JPY', 15, false]);
  const res = await app.call('PATCH', '/budget/settings', { base_currency: 'USD', autolock_minutes: 5, expense_categories: ['A', 'B', 'A'] });
  assert.deepEqual([res.body.base_currency, res.body.autolock_minutes, res.body.expense_categories], ['USD', 5, ['A', 'B']]);
  assert.equal((await app.call('PATCH', '/budget/settings', { autolock_minutes: 0 })).status, 400);
  assert.equal((await app.call('PATCH', '/budget/settings', { expense_categories: [] })).status, 400);
  assert.equal((await app.call('PATCH', '/budget/settings', { income_categories: ['a|b'] })).status, 400);
});

test('CSV export covers the month and defuses formulas', async () => {
  const app = await budgetApp();
  await post(app, '/budget/expenses', expense({ payee: '=SUM(A1)', note: 'a "quoted", note' }));
  const { filename, csv } = (await app.call('GET', '/budget/export/2026-05')).body;
  assert.equal(filename, 'budget-2026-05.csv');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'type,date,category,amount,kind,description,note,currency,rate,amount_base');
  assert.equal(lines[1], `expense,2026-05-03,Groceries,12.50,transaction,'=SUM(A1),"a ""quoted"", note",JPY,1,13`);
});

// ---- password change, reset and backup ----

test('changing the password re-encrypts budget text and keeps it readable', async () => {
  const app = await budgetApp();
  await post(app, '/budget/expenses', expense());
  const before = (await app.store.load()).budget.expenses[0].payee_enc;
  const res = await app.call('POST', '/auth/change-password', { current: PASSWORD, new: 'a brand new one' });
  assert.equal(res.status, 200);
  assert.notEqual((await app.store.load()).budget.expenses[0].payee_enc, before);
  assert.equal((await app.call('GET', '/budget/expenses')).body[0].payee, 'Corner Shop');
  const restarted = newApp({ store: app.store, now: NOW });
  assert.equal((await restarted.call('POST', '/auth/login', { password: 'a brand new one' })).status, 200);
  assert.equal((await restarted.call('GET', '/budget/expenses')).body[0].payee, 'Corner Shop');
});

test('after a forgotten-password reset the text is locked, not deleted', async () => {
  const app = await budgetApp();
  await post(app, '/budget/expenses', expense());
  await app.call('POST', '/auth/reset');
  await app.call('POST', '/auth/setup', { password: 'another password' });
  const [item] = (await app.call('GET', '/budget/expenses')).body;
  assert.deepEqual([item.payee, item.note, item.locked, item.amount], ['', '', true, 12.5]);
});

async function populated() {
  const app = await budgetApp({ fetchRate: ecb(150) });
  await post(app, '/budget/income', income());
  await post(app, '/budget/expenses', expense({ currency: 'USD' }));
  await post(app, '/budget/subscriptions', subscription());
  await app.call('PATCH', '/budget/settings', { base_currency: 'JPY', autolock_minutes: 7 });
  await app.call('POST', '/budget/rates/refresh');
  return app;
}

test('backup contains the budget, encrypted, and restores with the same password', async () => {
  const app = await populated();
  const backup = (await app.call('GET', '/backup/export')).body;
  assert.ok(!JSON.stringify(backup).includes('Corner Shop'));
  assert.equal(backup.data.budget.expenses.length, 1);

  const other = await budgetApp();
  await post(other, '/budget/income', income({ source: 'will be replaced' }));
  assert.equal((await other.call('POST', '/backup/import', JSON.parse(JSON.stringify(backup)))).status, 200);
  await other.call('POST', '/auth/login', { password: PASSWORD });
  assert.equal((await other.call('GET', '/budget/expenses')).body[0].payee, 'Corner Shop');
  assert.equal((await other.call('GET', '/budget/income')).body.length, 1);
  assert.equal((await other.call('GET', '/budget/settings')).body.autolock_minutes, 7);
  assert.equal((await other.call('GET', '/budget/rates')).body.length, 1);
  const next = await post(other, '/budget/expenses', expense());
  assert.equal(next.id, 2);
});

test('a backup made before budgeting existed still imports', async () => {
  const app = await populated();
  const backup = (await app.call('GET', '/backup/export')).body;
  delete backup.data.budget;
  const res = await app.call('POST', '/backup/import', backup);
  assert.equal(res.status, 200);
  await app.call('POST', '/auth/login', { password: PASSWORD });
  assert.deepEqual((await app.call('GET', '/budget/expenses')).body, []);
  assert.equal((await app.call('GET', '/budget/settings')).body.autolock_minutes, 15);
});

test('a database saved before budgeting existed opens with empty budget data', async () => {
  const app = await budgetApp();
  const db = await app.store.load();
  delete db.budget;
  await app.store.save(db);
  assert.deepEqual((await app.call('GET', '/budget/expenses')).body, []);
  await post(app, '/budget/expenses', expense());
  assert.equal((await app.call('GET', '/budget/expenses')).body.length, 1);
});

test('a malformed budget section in a backup is rejected', async () => {
  const app = await populated();
  const backup = (await app.call('GET', '/backup/export')).body;
  backup.data.budget.expenses[0].payee_enc = 5;
  const res = await app.call('POST', '/backup/import', backup);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /^invalid backup/);
});
