import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, makeProject, unlockedApp } from './helpers.js';

test('tags default to an empty list', async () => {
  const app = await unlockedApp();
  assert.deepEqual((await makeProject(app)).tags, []);
  assert.deepEqual((await app.call('GET', '/tags')).body, []);
});

test('tags are trimmed, collapsed, lowercased, deduplicated and keep their order', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app, { tags: ['  Work ', 'deep   Focus', 'WORK', '', '   ', 'home'] });
  assert.deepEqual(p.tags, ['work', 'deep focus', 'home']);
});

const invalid = [
  ['a string', 'tags must be a list of strings'],
  [null, 'tags must be a list of strings'],
  [['ok', 5], 'tags must be a list of strings'],
  [[{}], 'tags must be a list of strings'],
  [['x'.repeat(31)], 'each tag must be at most 30 characters'],
  [Array.from({ length: 11 }, (_, i) => `t${i}`), 'a project can have at most 10 tags'],
];
for (const [bad, message] of invalid) {
  test(`tags ${JSON.stringify(bad).slice(0, 40)} are rejected on create and patch`, async () => {
    const app = await unlockedApp();
    const res = await app.call('POST', '/projects', { name: 'A', start_date: '2026-01-01', target_date: '2026-02-01', tags: bad });
    assert.deepEqual([res.status, res.body.error], [400, message]);
    const p = await makeProject(app);
    const patched = await app.call('PATCH', `/projects/${p.id}`, { tags: bad });
    assert.deepEqual([patched.status, patched.body.error], [400, message]);
  });
}

test('limits are inclusive and duplicates do not count toward them', async () => {
  const app = await unlockedApp();
  const ten = Array.from({ length: 10 }, (_, i) => `t${i}`);
  assert.equal((await makeProject(app, { tags: ['x'.repeat(30)] })).tags.length, 1);
  assert.equal((await makeProject(app, { tags: ten })).tags.length, 10);
  assert.equal((await makeProject(app, { tags: [...ten, 'T0'] })).tags.length, 10);
});

test('patch keeps tags when not sent, replaces them, and clears them', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app, { tags: ['a', 'b'] });
  assert.deepEqual((await app.call('PATCH', `/projects/${p.id}`, { name: 'Renamed' })).body.tags, ['a', 'b']);
  assert.deepEqual((await app.call('PATCH', `/projects/${p.id}`, { tags: ['C'] })).body.tags, ['c']);
  assert.deepEqual((await app.call('PATCH', `/projects/${p.id}`, { tags: [] })).body.tags, []);
  assert.deepEqual((await app.call('GET', `/projects/${p.id}`)).body.tags, []);
});

test('GET /tags lists tags in use, sorted and unique, and drops unused ones', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app, { tags: ['work', 'alpha'] });
  const q = await makeProject(app, { tags: ['home', 'work'] });
  assert.deepEqual((await app.call('GET', '/tags')).body, ['alpha', 'home', 'work']);
  await app.call('DELETE', `/projects/${p.id}`);
  assert.deepEqual((await app.call('GET', '/tags')).body, ['home', 'work']);
  await app.call('PATCH', `/projects/${q.id}`, { tags: [] });
  assert.deepEqual((await app.call('GET', '/tags')).body, []);
});

test('GET /tags requires authentication', async () => {
  const app = await unlockedApp();
  await app.call('POST', '/auth/logout');
  assert.equal((await app.call('GET', '/tags')).status, 401);
});

test('tags survive an export and import round trip', async () => {
  const app = await unlockedApp();
  await makeProject(app, { tags: ['work', 'deep focus'] });
  const backup = (await app.call('GET', '/backup/export')).body;
  assert.deepEqual(backup.data.projects[0].tags, ['work', 'deep focus']);
  const other = await unlockedApp();
  assert.equal((await other.call('POST', '/backup/import', backup)).status, 200);
  await other.call('POST', '/auth/login', { password: PASSWORD });
  assert.deepEqual((await other.call('GET', '/projects')).body[0].tags, ['work', 'deep focus']);
});

test('a backup without tags imports as none and bad tags are rejected', async () => {
  const app = await unlockedApp();
  await makeProject(app, { tags: ['work'] });
  const backup = (await app.call('GET', '/backup/export')).body;
  for (const p of backup.data.projects) delete p.tags;
  assert.equal((await app.call('POST', '/backup/import', structuredClone(backup))).status, 200);
  await app.call('POST', '/auth/login', { password: PASSWORD });
  assert.deepEqual((await app.call('GET', '/projects')).body[0].tags, []);
  backup.data.projects[0].tags = 'work';
  const res = await app.call('POST', '/backup/import', backup);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /tags must be a list of strings/);
});

test('older stored rows without tags read as none and export as none', async () => {
  const app = await unlockedApp();
  await makeProject(app);
  const stored = await app.store.load();
  for (const p of stored.projects) delete p.tags;
  await app.store.save(stored);
  assert.deepEqual((await app.call('GET', '/projects')).body[0].tags, []);
  assert.deepEqual((await app.call('GET', '/backup/export')).body.data.projects[0].tags, []);
});
