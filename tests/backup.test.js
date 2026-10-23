import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, makeMilestone, makeProject, newApp, unlockedApp } from './helpers.js';

async function populated() {
  const app = await unlockedApp();
  const p = await makeProject(app, { name: 'Alpha' });
  const q = await makeProject(app, { name: 'Beta', color: '#9ece6a' });
  await makeMilestone(app, p.id, { title: 'one', cost: 1500 });
  await makeMilestone(app, q.id, { title: 'two', status: 'in_progress', start_date: '2026-01-05' });
  return app;
}

test('export contains encrypted costs, salts and no plain amounts', async () => {
  const app = await populated();
  const res = await app.call('GET', '/backup/export');
  assert.equal(res.status, 200);
  assert.equal(res.body.format, 'projtrack-backup');
  assert.equal(res.body.data.projects.length, 2);
  assert.ok(res.body.data.settings.password_hash && res.body.data.settings.kdf_salt);
  assert.ok(!JSON.stringify(res.body).includes('1500'));
});

test('round trip restores everything and the same password unlocks the costs', async () => {
  const app = await populated();
  const before = (await app.call('GET', '/projects')).body;
  const backup = (await app.call('GET', '/backup/export')).body;

  const other = await unlockedApp();
  await makeProject(other, { name: 'Will be replaced' });
  const imported = await other.call('POST', '/backup/import', JSON.parse(JSON.stringify(backup)));
  assert.deepEqual([imported.status, imported.body], [200, { configured: true, authenticated: false }]);
  assert.equal((await other.call('GET', '/projects')).status, 401);

  assert.equal((await other.call('POST', '/auth/login', { password: PASSWORD })).status, 200);
  assert.deepEqual((await other.call('GET', '/projects')).body, before);
});

test('ids keep counting after an import', async () => {
  const app = await populated();
  const backup = (await app.call('GET', '/backup/export')).body;
  const fresh = newApp();
  await fresh.call('POST', '/auth/setup', { password: PASSWORD });
  await fresh.call('POST', '/backup/import', backup);
  await fresh.call('POST', '/auth/login', { password: PASSWORD });
  const p = await makeProject(fresh);
  assert.equal(p.id, 3);
});

test('importing a backup with no password leaves the app unconfigured', async () => {
  const app = await populated();
  const backup = (await app.call('GET', '/backup/export')).body;
  delete backup.data.settings.password_hash;
  delete backup.data.settings.kdf_salt;
  const res = await app.call('POST', '/backup/import', backup);
  assert.deepEqual(res.body, { configured: false, authenticated: false });
  assert.equal((await app.call('POST', '/auth/setup', { password: PASSWORD })).status, 201);
  const m = (await app.call('GET', '/projects')).body[0].milestones[0];
  assert.equal(m.cost_locked, true);
});

test('invalid backups are rejected and change nothing', async () => {
  const app = await populated();
  const good = (await app.call('GET', '/backup/export')).body;
  const mutate = (fn) => { const copy = structuredClone(good); fn(copy); return copy; };
  const cases = [
    [null, /not a projtrack backup/],
    [{ foo: 1 }, /not a projtrack backup/],
    [mutate((b) => { b.version = 9; }), /unsupported version/],
    [mutate((b) => { b.data.projects = 'x'; }), /must be lists/],
    [mutate((b) => { b.data.projects[0].color = 'blue'; }), /color must be a hex string/],
    [mutate((b) => { b.data.projects[1].id = b.data.projects[0].id; }), /duplicate project id/],
    [mutate((b) => { b.data.milestones[0].project_id = 99; }), /missing project/],
    [mutate((b) => { b.data.milestones[0].status = 'wat'; }), /status must be one of/],
    [mutate((b) => { b.data.milestones[0].position = -2; }), /position must be/],
    [mutate((b) => { b.data.milestones[0].cost_enc = 12; }), /cost_enc/],
    [mutate((b) => { delete b.data.settings.kdf_salt; }), /both be present/],
    [mutate((b) => { b.data.settings.password_hash = 'plain'; }), /password_hash is not valid/],
  ];
  for (const [file, pattern] of cases) {
    const res = await app.call('POST', '/backup/import', file);
    assert.equal(res.status, 400, String(pattern));
    assert.match(res.body.error, pattern);
  }
  assert.equal((await app.call('GET', '/projects')).body.length, 2);
});

test('demo data loads once and skips existing projects', async () => {
  const app = await unlockedApp();
  const first = await app.call('POST', '/demo');
  assert.deepEqual([first.status, first.body], [200, { projects: 4, milestones: 13 }]);
  const projects = (await app.call('GET', '/projects')).body;
  assert.equal(projects.length, 4);
  const aws = projects.find((p) => p.name.startsWith('AWS'));
  assert.equal(aws.cost_total, 23300);
  const again = await app.call('POST', '/demo');
  assert.deepEqual(again.body, { projects: 0, milestones: 0 });
});

test('priority survives an export and import round trip', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { title: 'hot', priority: 'high' });
  const backup = (await app.call('GET', '/backup/export')).body;
  assert.equal(backup.data.milestones[0].priority, 'high');
  const other = await unlockedApp();
  assert.equal((await other.call('POST', '/backup/import', backup)).status, 200);
  await other.call('POST', '/auth/login', { password: PASSWORD });
  assert.equal((await other.call('GET', '/projects')).body[0].milestones[0].priority, 'high');
});

test('a backup without priority imports as none and a bad priority is rejected', async () => {
  const app = await populated();
  const backup = (await app.call('GET', '/backup/export')).body;
  for (const m of backup.data.milestones) delete m.priority;
  assert.equal((await app.call('POST', '/backup/import', structuredClone(backup))).status, 200);
  await app.call('POST', '/auth/login', { password: PASSWORD });
  const priorities = (await app.call('GET', '/projects')).body.flatMap((x) => x.milestones.map((m) => m.priority));
  assert.deepEqual(priorities, ['none', 'none']);
  backup.data.milestones[0].priority = 'urgent';
  const res = await app.call('POST', '/backup/import', backup);
  assert.equal(res.status, 400);
  assert.match(res.body.error, /priority must be one of/);
});

test('older stored rows without priority read as none and export as none', async () => {
  const app = await populated();
  const stored = await app.store.load();
  for (const m of stored.milestones) delete m.priority;
  await app.store.save(stored);
  const m = (await app.call('GET', '/projects')).body[0].milestones[0];
  assert.equal(m.priority, 'none');
  assert.equal((await app.call('GET', '/backup/export')).body.data.milestones[0].priority, 'none');
});
