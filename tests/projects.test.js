import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject, unlockedApp } from './helpers.js';

test('create applies defaults and returns computed fields', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app, { name: '  Alpha  ' });
  assert.equal(p.name, 'Alpha');
  assert.equal(p.status, 'active');
  assert.equal(p.color, '#7aa2f7');
  assert.equal(p.description, '');
  assert.deepEqual([p.milestones, p.cost_total, p.progress], [[], 0, 0]);
  assert.match(p.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
});

test('list orders by start_date then id', async () => {
  const app = await unlockedApp();
  await makeProject(app, { name: 'late', start_date: '2026-03-01' });
  await makeProject(app, { name: 'early', start_date: '2026-01-01' });
  await makeProject(app, { name: 'early2', start_date: '2026-01-01' });
  const names = (await app.call('GET', '/projects')).body.map((p) => p.name);
  assert.deepEqual(names, ['early', 'early2', 'late']);
});

const invalid = [
  [{ name: '   ' }, 'name is required and must be a non-empty string'],
  [{ name: 5 }, 'name is required and must be a non-empty string'],
  [{ start_date: '2026-02-30' }, 'start_date must be a valid date in YYYY-MM-DD format'],
  [{ start_date: '2026-1-01' }, 'start_date must be a valid date in YYYY-MM-DD format'],
  [{ target_date: null }, 'target_date must be a valid date in YYYY-MM-DD format'],
  [{ target_date: '2025-12-31' }, 'target_date must not be before start_date'],
  [{ status: 'nope' }, 'status must be one of: active, done, paused, planned'],
  [{ color: 'red' }, 'color must be a hex string like #aabbcc'],
  [{ color: '#abc' }, 'color must be a hex string like #aabbcc'],
  [{ description: 4 }, 'description must be a string'],
];
for (const [override, message] of invalid) {
  test(`create rejects ${JSON.stringify(override)}`, async () => {
    const app = await unlockedApp();
    const res = await app.call('POST', '/projects', {
      name: 'A', start_date: '2026-01-01', target_date: '2026-06-30', ...override,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, message);
  });
}

test('body must be a JSON object', async () => {
  const app = await unlockedApp();
  for (const body of [undefined, null, [], 'x', 3]) {
    const res = await app.call('POST', '/projects', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Request body must be a JSON object');
  }
});

test('leap day is a valid date, year 0000 is not', async () => {
  const app = await unlockedApp();
  await makeProject(app, { start_date: '2024-02-29', target_date: '2024-03-01' });
  const res = await app.call('POST', '/projects', { name: 'A', start_date: '0000-01-01', target_date: '2026-01-01' });
  assert.equal(res.status, 400);
});

test('get, patch and delete', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  assert.equal((await app.call('GET', `/projects/${p.id}`)).body.name, 'Alpha');
  const patched = await app.call('PATCH', `/projects/${p.id}`, { name: 'Beta', status: 'paused' });
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.body.name, patched.body.status, patched.body.color], ['Beta', 'paused', '#7aa2f7']);
  assert.equal((await app.call('DELETE', `/projects/${p.id}`)).status, 204);
  assert.equal((await app.call('GET', `/projects/${p.id}`)).status, 404);
});

test('patch validates the merged result', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const res = await app.call('PATCH', `/projects/${p.id}`, { target_date: '2025-01-01' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'target_date must not be before start_date');
  assert.equal((await app.call('GET', `/projects/${p.id}`)).body.target_date, '2026-06-30');
});

test('unknown ids return 404 with the entity name', async () => {
  const app = await unlockedApp();
  for (const [method, path, what] of [
    ['GET', '/projects/99', 'Project'], ['PATCH', '/projects/99', 'Project'], ['DELETE', '/projects/99', 'Project'],
    ['POST', '/projects/99/milestones', 'Project'], ['PATCH', '/milestones/99', 'Milestone'],
    ['DELETE', '/milestones/99', 'Milestone'],
  ]) {
    const res = await app.call(method, path, {});
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.error, `${what} not found`);
  }
  const move = await app.call('POST', '/milestones/99/move', { status: 'todo', position: 0 });
  assert.equal(move.status, 404);
});

test('unknown routes are 404 and wrong methods are 405', async () => {
  const app = await unlockedApp();
  assert.equal((await app.call('GET', '/nope')).status, 404);
  assert.equal((await app.call('PUT', '/projects')).status, 405);
});

test('ids are never reused after delete', async () => {
  const app = await unlockedApp();
  const a = await makeProject(app);
  await app.call('DELETE', `/projects/${a.id}`);
  const b = await makeProject(app);
  assert.ok(b.id > a.id);
});
