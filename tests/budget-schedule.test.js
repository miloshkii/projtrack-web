import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrencesInMonth } from '../web/budget/schedule.js';

const sub = (overrides) => ({
  frequency: 'monthly', start_date: '2026-01-31', end_date: null, active: true, ...overrides,
});

test('monthly from the 31st clamps to the end of short months', () => {
  const s = sub({ start_date: '2026-01-31' });
  assert.deepEqual(occurrencesInMonth(s, '2026-02'), ['2026-02-28']);
  assert.deepEqual(occurrencesInMonth(s, '2026-03'), ['2026-03-31']);
  assert.deepEqual(occurrencesInMonth(s, '2026-04'), ['2026-04-30']);
});

test('monthly from the 31st uses the leap day in a leap year', () => {
  assert.deepEqual(occurrencesInMonth(sub({ start_date: '2024-01-31' }), '2024-02'), ['2024-02-29']);
});

test('quarterly repeats every three months', () => {
  const s = sub({ frequency: 'quarterly', start_date: '2026-01-15' });
  assert.deepEqual(occurrencesInMonth(s, '2026-01'), ['2026-01-15']);
  assert.deepEqual(occurrencesInMonth(s, '2026-02'), []);
  assert.deepEqual(occurrencesInMonth(s, '2026-04'), ['2026-04-15']);
  assert.deepEqual(occurrencesInMonth(s, '2026-07'), ['2026-07-15']);
});

test('yearly from Feb 29 falls back in non-leap years', () => {
  const s = sub({ frequency: 'yearly', start_date: '2024-02-29' });
  assert.deepEqual(occurrencesInMonth(s, '2024-02'), ['2024-02-29']);
  assert.deepEqual(occurrencesInMonth(s, '2025-02'), ['2025-02-28']);
  assert.deepEqual(occurrencesInMonth(s, '2028-02'), ['2028-02-29']);
  assert.deepEqual(occurrencesInMonth(s, '2026-03'), []);
});

test('weekly from the first of the month has five hits in October 2026', () => {
  const s = sub({ frequency: 'weekly', start_date: '2026-10-01' });
  assert.deepEqual(occurrencesInMonth(s, '2026-10'),
    ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22', '2026-10-29']);
});

test('weekly counts only days on or after the start, and stops at the end date', () => {
  const late = sub({ frequency: 'weekly', start_date: '2026-10-15' });
  assert.deepEqual(occurrencesInMonth(late, '2026-10'), ['2026-10-15', '2026-10-22', '2026-10-29']);
  const ended = sub({ frequency: 'weekly', start_date: '2026-10-01', end_date: '2026-10-15' });
  assert.deepEqual(occurrencesInMonth(ended, '2026-10'), ['2026-10-01', '2026-10-08', '2026-10-15']);
});

test('weekly continues across a month boundary on the same weekday', () => {
  const s = sub({ frequency: 'weekly', start_date: '2026-10-01' });
  assert.deepEqual(occurrencesInMonth(s, '2026-11'), ['2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26']);
});

test('end date cuts off monthly occurrences', () => {
  const s = sub({ start_date: '2026-01-15', end_date: '2026-02-10' });
  assert.deepEqual(occurrencesInMonth(s, '2026-01'), ['2026-01-15']);
  assert.deepEqual(occurrencesInMonth(s, '2026-02'), []);
});

test('inactive subscriptions and months before the start have no occurrences', () => {
  assert.deepEqual(occurrencesInMonth(sub({ start_date: '2026-01-15', active: false }), '2026-01'), []);
  for (const frequency of ['weekly', 'monthly', 'quarterly', 'yearly']) {
    assert.deepEqual(occurrencesInMonth(sub({ frequency, start_date: '2026-03-10' }), '2026-02'), [], frequency);
  }
});
