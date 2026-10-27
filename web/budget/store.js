// Budget records inside the projtrack database (`db.budget`). Free-text fields are stored encrypted
// (`*_enc`, the same AES-GCM token format as milestone costs); everything else is readable.
import { InvalidToken, decryptText, encryptText } from '../cryptoutil.js';
import { DEFAULT_BASE, isCurrency } from './currencies.js';
import {
  ValidationError, isObject, validCurrency, validDate, validMonth, validRate, validateExpense, validateIncome,
  validateSettings, validateSubscription,
} from './validate.js';

export const DEFAULT_SETTINGS = {
  base_currency: DEFAULT_BASE,
  auto_fetch_rates: false,
  income_categories: ['Salary', 'Freelance', 'Interest', 'Gifts', 'Other'],
  expense_categories: ['Housing', 'Utilities', 'Groceries', 'Transport', 'Eating Out', 'Entertainment', 'Health',
    'Shopping', 'Subscriptions', 'Savings', 'Other'],
  autolock_minutes: 15,
};

export const TABLES = ['income', 'expenses', 'subscriptions'];

export const SPECS = {
  income: {
    validate: validateIncome, plain: ['date', 'month', 'category', 'amount', 'currency'], enc: ['source', 'note'],
    blank: { source: '', note: '' },
  },
  expenses: {
    validate: validateExpense, plain: ['date', 'month', 'category', 'amount', 'currency', 'kind'], enc: ['payee', 'note'],
    blank: { payee: '', note: '' },
  },
  subscriptions: {
    validate: validateSubscription,
    plain: ['category', 'amount', 'currency', 'frequency', 'start_date', 'end_date', 'active'], enc: ['name', 'note'],
    blank: { name: 'x', note: '' },
  },
};

export function emptyBudget() {
  return {
    income: [], expenses: [], subscriptions: [], rates: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    seq: { income: 0, expenses: 0, subscriptions: 0 },
  };
}

// Databases saved before budgeting existed have no `budget`; fill in whatever is missing.
export function ensureBudget(db) {
  const fresh = emptyBudget();
  db.budget ??= fresh;
  for (const key of ['income', 'expenses', 'subscriptions', 'rates']) db.budget[key] ??= fresh[key];
  db.budget.settings = { ...fresh.settings, ...db.budget.settings };
  db.budget.seq = { ...fresh.seq, ...db.budget.seq };
  return db.budget;
}

export const baseCurrency = (budget) => (isCurrency(budget.settings.base_currency) ? budget.settings.base_currency : DEFAULT_BASE);

export async function toRow(spec, item, key, id) {
  const row = { id };
  for (const field of spec.plain) row[field] = item[field];
  for (const field of spec.enc) row[`${field}_enc`] = await encryptText(key, item[field]);
  return row;
}

// Decrypted item; fields that cannot be read (password was reset) come back empty with `locked: true`.
export async function fromRow(spec, row, key) {
  const item = { id: row.id };
  for (const field of spec.plain) if (field !== 'month') item[field] = row[field];
  for (const field of spec.enc) {
    try {
      item[field] = await decryptText(key, row[`${field}_enc`]);
    } catch (err) {
      if (!(err instanceof InvalidToken)) throw err;
      item[field] = '';
      item.locked = true;
    }
  }
  return item;
}

// Re-encrypt every readable text field; unreadable ones are left as they are.
export async function reencryptBudget(budget, oldKey, newKey) {
  for (const table of TABLES) {
    for (const row of budget[table]) {
      for (const field of SPECS[table].enc) {
        const name = `${field}_enc`;
        try {
          row[name] = await encryptText(newKey, await decryptText(oldKey, row[name]));
        } catch (err) {
          if (!(err instanceof InvalidToken)) throw err;
        }
      }
    }
  }
}

// ---- backup ----

const backupError = (message) => new ValidationError(`invalid backup: ${message}`);

function cleanRow(table, raw, ids) {
  if (!isObject(raw)) throw backupError(`${table} row must be an object`);
  if (!Number.isInteger(raw.id) || raw.id < 1) throw backupError(`${table} id must be a positive integer`);
  if (ids.has(raw.id)) throw backupError(`duplicate ${table} id ${raw.id}`);
  ids.add(raw.id);
  const spec = SPECS[table];
  const item = spec.validate({ ...raw, ...spec.blank }, DEFAULT_BASE);
  for (const field of spec.enc) {
    if (typeof raw[`${field}_enc`] !== 'string') throw backupError(`${table} ${field}_enc must be text`);
  }
  const row = { id: raw.id };
  for (const field of spec.plain) row[field] = item[field];
  for (const field of spec.enc) row[`${field}_enc`] = raw[`${field}_enc`];
  return row;
}

function cleanRate(raw) {
  if (!isObject(raw)) throw backupError('rate must be an object');
  if (!isCurrency(raw.base) || raw.source !== 'ecb' && raw.source !== 'manual') throw backupError('rate has a bad base or source');
  return {
    month: validMonth(raw.month), currency: validCurrency(raw.currency), base: raw.base, rate: validRate(raw.rate),
    source: raw.source, as_of: validDate(raw.as_of, 'as_of'),
  };
}

// Clean `budget` section of a backup file; absent (older backups) means empty.
export function validateBudgetBackup(raw) {
  const budget = emptyBudget();
  if (raw === undefined || raw === null) return budget;
  if (!isObject(raw)) throw backupError('budget must be an object');
  for (const table of TABLES) {
    const rows = raw[table] ?? [];
    if (!Array.isArray(rows)) throw backupError(`budget ${table} must be a list`);
    const ids = new Set();
    budget[table] = rows.map((r) => cleanRow(table, r, ids));
    budget.seq[table] = Math.max(Number.isInteger(raw.seq?.[table]) ? raw.seq[table] : 0, ...ids);
  }
  if (!Array.isArray(raw.rates ?? [])) throw backupError('budget rates must be a list');
  budget.rates = (raw.rates ?? []).map(cleanRate);
  budget.settings = { ...budget.settings, ...validateSettings(raw.settings ?? {}) };
  return budget;
}
