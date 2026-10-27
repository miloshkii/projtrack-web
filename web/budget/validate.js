// Input validation for budget requests. Messages match the standalone Budget app's.
import { isCurrency, roundHalfUp } from './currencies.js';

export class ValidationError extends Error {}

export const MAX_TEXT = 200;
export const MAX_CATEGORY = 50;
export const MAX_RATE = 1e9;
export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
export const KINDS = ['transaction', 'lump'];
export const RANGES = { 3: 3, 6: 6, 12: 12, all: null };
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const codePoints = (s) => [...s].length;
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function requireObject(body) {
  if (!isObject(body)) throw new ValidationError('Request body must be a JSON object');
  return body;
}

export function validDate(value, field = 'date') {
  const m = typeof value === 'string' && DATE_RE.exec(value);
  if (!m) throw new ValidationError(`${field} must be YYYY-MM-DD`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(2000, month - 1, day));
  d.setUTCFullYear(year);
  if (year < 1 || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    throw new ValidationError(`${field} is not a real date`);
  }
  return value;
}

export function validMonth(value) {
  if (typeof value !== 'string' || !MONTH_RE.test(value)) throw new ValidationError('m must be YYYY-MM');
  return value;
}

function finiteNumber(value, field) {
  if (typeof value !== 'number') throw new ValidationError(`${field} must be a number`);
  if (!Number.isFinite(value)) throw new ValidationError(`${field} must be finite`);
  return value;
}

export function validAmount(value) {
  const amount = roundHalfUp(finiteNumber(value, 'amount'), 2);
  if (amount <= 0) throw new ValidationError('amount must be greater than 0');
  return amount;
}

export function validCurrency(value, fallback = null) {
  if ((value === null || value === undefined || value === '') && fallback !== null) return fallback;
  if (!isCurrency(value)) throw new ValidationError('currency must be a supported ISO code, e.g. JPY, USD, EUR');
  return value;
}

export function validRate(value) {
  const rate = finiteNumber(value, 'rate');
  if (rate <= 0 || rate > MAX_RATE) throw new ValidationError('rate must be greater than 0');
  const rounded = roundHalfUp(rate, 8);
  if (rounded <= 0) throw new ValidationError('rate is too small');
  return rounded;
}

export function validCategory(value) {
  if (typeof value !== 'string' || !value.trim() || codePoints(value) > MAX_CATEGORY) {
    throw new ValidationError(`category must be a non-empty string up to ${MAX_CATEGORY} characters`);
  }
  return value.trim();
}

export function validText(body, field, required = false) {
  const value = body[field] ?? '';
  if (typeof value !== 'string' || codePoints(value) > MAX_TEXT) {
    throw new ValidationError(`${field} must be text up to ${MAX_TEXT} characters`);
  }
  if (required && !value.trim()) throw new ValidationError(`${field} is required`);
  return value;
}

export function validChoice(body, field, choices) {
  if (!choices.includes(body[field])) throw new ValidationError(`${field} must be one of: ${choices.join(', ')}`);
  return body[field];
}

export function validateIncome(body, base) {
  const data = requireObject(body);
  const date = validDate(data.date);
  return {
    date, month: date.slice(0, 7), category: validCategory(data.category), amount: validAmount(data.amount),
    currency: validCurrency(data.currency, base), source: validText(data, 'source'), note: validText(data, 'note'),
  };
}

export function validateExpense(body, base) {
  const data = requireObject(body);
  const date = validDate(data.date);
  return {
    date, month: date.slice(0, 7), category: validCategory(data.category), amount: validAmount(data.amount),
    currency: validCurrency(data.currency, base), kind: validChoice(data, 'kind', KINDS),
    payee: validText(data, 'payee'), note: validText(data, 'note'),
  };
}

export function validateSubscription(body, base) {
  const data = requireObject(body);
  const start = validDate(data.start_date, 'start_date');
  let end = data.end_date;
  if (end === null || end === undefined || end === '') {
    end = null;
  } else {
    end = validDate(end, 'end_date');
    if (end < start) throw new ValidationError('end_date must not be before start_date');
  }
  const active = data.active ?? true;
  if (typeof active !== 'boolean') throw new ValidationError('active must be true or false');
  return {
    name: validText(data, 'name', true), category: validCategory(data.category), amount: validAmount(data.amount),
    currency: validCurrency(data.currency, base), frequency: validChoice(data, 'frequency', FREQUENCIES),
    start_date: start, end_date: end, active, note: validText(data, 'note'),
  };
}

function validCategoryList(value, field) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new ValidationError(`${field} must be a non-empty list`);
  const cleaned = [];
  for (const item of value) {
    const name = validCategory(item);
    if (name.includes('|')) throw new ValidationError(`${field} entries must not contain '|'`);
    if (!cleaned.includes(name)) cleaned.push(name);
  }
  return cleaned;
}

// Returns only the settings present in the body, validated.
export function validateSettings(body) {
  const data = requireObject(body);
  const changes = {};
  if ('base_currency' in data) changes.base_currency = validCurrency(data.base_currency);
  if ('auto_fetch_rates' in data) {
    if (typeof data.auto_fetch_rates !== 'boolean') throw new ValidationError('auto_fetch_rates must be true or false');
    changes.auto_fetch_rates = data.auto_fetch_rates;
  }
  for (const field of ['income_categories', 'expense_categories']) {
    if (field in data) changes[field] = validCategoryList(data[field], field);
  }
  if ('autolock_minutes' in data) {
    const minutes = data.autolock_minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new ValidationError('autolock_minutes must be an integer from 1 to 1440');
    }
    changes.autolock_minutes = minutes;
  }
  return changes;
}
