import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, makeMilestone, makeProject, unlockedApp } from './helpers.js';

test('create defaults and project aggregates', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const m = await makeMilestone(app, p.id, { title: ' Exam ', cost: 1200 });
  assert.deepEqual(
    [m.title, m.status, m.done, m.position, m.cost, m.start_date, m.project_id],
    ['Exam', 'todo', false, 0, 1200, null, p.id]);
  assert.ok(!('cost_enc' in m));
  const again = (await app.call('GET', `/projects/${p.id}`)).body;
  assert.equal(again.cost_total, 1200);
});

test('milestones are listed in creation order inside a project (appended at the end)', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { title: 'b', due_date: '2026-04-01' });
  await makeMilestone(app, p.id, { title: 'a', due_date: '2026-02-01' });
  await makeMilestone(app, p.id, { title: 'c', due_date: '2026-02-01' });
  const titles = (await app.call('GET', `/projects/${p.id}`)).body.milestones.map((m) => m.title);
  assert.deepEqual(titles, ['b', 'a', 'c']);
});

test('progress is the share of milestones done, rounding half to even', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { status: 'done' });
  for (let i = 0; i < 7; i++) await makeMilestone(app, p.id);
  assert.equal((await app.call('GET', `/projects/${p.id}`)).body.progress, 12);
  await makeMilestone(app, p.id, { status: 'done' });
  assert.equal((await app.call('GET', `/projects/${p.id}`)).body.progress, 22);
});

const invalid = [
  [{ title: ' ' }, 'title is required and must be a non-empty string'],
  [{ due_date: 'soon' }, 'due_date must be a valid date in YYYY-MM-DD format'],
  [{ start_date: '2026-13-01' }, 'start_date must be a valid date in YYYY-MM-DD format'],
  [{ start_date: '2026-04-01' }, 'start_date must not be after due_date'],
  [{ status: 'later' }, 'status must be one of: todo, in_progress, done'],
  [{ done: 'yes' }, 'done must be a boolean'],
  [{ cost: -1 }, 'cost must be an integer (JPY) from 0 to 1000000000000 or null'],
  [{ cost: 1.5 }, 'cost must be an integer (JPY) from 0 to 1000000000000 or null'],
  [{ cost: '5' }, 'cost must be an integer (JPY) from 0 to 1000000000000 or null'],
  [{ cost: true }, 'cost must be an integer (JPY) from 0 to 1000000000000 or null'],
  [{ cost: 10 ** 12 + 1 }, 'cost must be an integer (JPY) from 0 to 1000000000000 or null'],
];
for (const [override, message] of invalid) {
  test(`create rejects ${JSON.stringify(override)}`, async () => {
    const app = await unlockedApp();
    const p = await makeProject(app);
    const res = await app.call('POST', `/projects/${p.id}/milestones`, { title: 'M', due_date: '2026-03-01', ...override });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, message);
  });
}

test('cost accepts 0 and the maximum, empty start_date means none', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  assert.equal((await makeMilestone(app, p.id, { cost: 0 })).cost, 0);
  assert.equal((await makeMilestone(app, p.id, { cost: 10 ** 12, start_date: '' })).start_date, null);
});

test('status wins over legacy done', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  assert.equal((await makeMilestone(app, p.id, { done: true })).status, 'done');
  assert.equal((await makeMilestone(app, p.id, { done: true, status: 'in_progress' })).status, 'in_progress');
});

test('patch updates fields and keeps the cost unless sent', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const m = await makeMilestone(app, p.id, { cost: 500 });
  const res = await app.call('PATCH', `/milestones/${m.id}`, { title: 'New', start_date: '2026-02-01' });
  assert.deepEqual([res.status, res.body.title, res.body.start_date, res.body.cost], [200, 'New', '2026-02-01', 500]);
  const cleared = await app.call('PATCH', `/milestones/${m.id}`, { cost: null });
  assert.equal(cleared.body.cost, null);
});

test('patch validates dates against the stored ones', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const m = await makeMilestone(app, p.id, { start_date: '2026-02-01' });
  const res = await app.call('PATCH', `/milestones/${m.id}`, { due_date: '2026-01-01' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'start_date must not be after due_date');
});

test('deleting a project removes its milestones', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const m = await makeMilestone(app, p.id);
  await app.call('DELETE', `/projects/${p.id}`);
  assert.equal((await app.call('PATCH', `/milestones/${m.id}`, { title: 'x' })).status, 404);
});

test('costs are stored encrypted and sum per project', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const q = await makeProject(app, { name: 'Beta' });
  await makeMilestone(app, p.id, { cost: 1000 });
  await makeMilestone(app, p.id, { cost: 2500 });
  await makeMilestone(app, q.id, { cost: 7 });
  await makeMilestone(app, q.id);
  const stored = await app.store.load();
  assert.ok(stored.milestones.every((m) => m.cost_enc === null || !/^\d+$/.test(m.cost_enc)));
  const totals = (await app.call('GET', '/projects')).body.map((x) => x.cost_total);
  assert.deepEqual(totals, [3500, 7]);
});

test('priority defaults to none and accepts each level', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  assert.equal((await makeMilestone(app, p.id)).priority, 'none');
  for (const level of ['none', 'low', 'medium', 'high']) {
    assert.equal((await makeMilestone(app, p.id, { priority: level })).priority, level);
  }
});

for (const bad of ['urgent', 'HIGH', 3, null, true]) {
  test(`priority ${JSON.stringify(bad)} is rejected on create and patch`, async () => {
    const app = await unlockedApp();
    const p = await makeProject(app);
    const res = await app.call('POST', `/projects/${p.id}/milestones`, { title: 'M', due_date: '2026-03-01', priority: bad });
    assert.deepEqual([res.status, res.body.error], [400, 'priority must be one of: none, low, medium, high']);
    const m = await makeMilestone(app, p.id);
    const patched = await app.call('PATCH', `/milestones/${m.id}`, { priority: bad });
    assert.deepEqual([patched.status, patched.body.error], [400, 'priority must be one of: none, low, medium, high']);
  });
}

test('patch changes priority and keeps it when not sent', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const m = await makeMilestone(app, p.id, { priority: 'low' });
  assert.equal((await app.call('PATCH', `/milestones/${m.id}`, { title: 'Renamed' })).body.priority, 'low');
  assert.equal((await app.call('PATCH', `/milestones/${m.id}`, { priority: 'high' })).body.priority, 'high');
  const listed = (await app.call('GET', `/projects/${p.id}`)).body.milestones[0];
  assert.equal(listed.priority, 'high');
});

// ---- editing: PATCH validation ----

test('patch rejects bad titles and dates and leaves the milestone unchanged', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const m = await makeMilestone(app, p.id, { title: 'Keep', start_date: '2026-02-01', due_date: '2026-03-01' });
  for (const body of [{ title: '   ' }, { title: 5 }, { due_date: 'soon' }, { due_date: null }, { start_date: '2026-13-01' }]) {
    assert.equal((await app.call('PATCH', `/milestones/${m.id}`, body)).status, 400, JSON.stringify(body));
  }
  const bad = await app.call('PATCH', `/milestones/${m.id}`, { start_date: '2026-04-01' });
  assert.deepEqual([bad.status, bad.body.error], [400, 'start_date must not be after due_date']);
  const both = await app.call('PATCH', `/milestones/${m.id}`, { start_date: '2026-05-01', due_date: '2026-04-01' });
  assert.equal(both.status, 400);
  const after = (await app.call('GET', `/projects/${p.id}`)).body.milestones[0];
  assert.deepEqual([after.title, after.start_date, after.due_date], ['Keep', '2026-02-01', '2026-03-01']);
});

test('patch can change dates together, trim the title and clear the start date', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const m = await makeMilestone(app, p.id, { start_date: '2026-02-01' });
  const res = await app.call('PATCH', `/milestones/${m.id}`, { title: ' Renamed ', start_date: null, due_date: '2026-01-15' });
  assert.deepEqual([res.status, res.body.title, res.body.start_date, res.body.due_date], [200, 'Renamed', null, '2026-01-15']);
});

// ---- manual order and moving between projects ----

const titlesOf = async (app, projectId) =>
  (await app.call('GET', `/projects/${projectId}`)).body.milestones.map((m) => m.title);

test('order is assigned 0..n-1 on create and reorder renumbers', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const ids = {};
  for (const t of ['a', 'b', 'c']) ids[t] = (await makeMilestone(app, p.id, { title: t })).id;
  const orders = (await app.call('GET', `/projects/${p.id}`)).body.milestones.map((m) => m.order);
  assert.deepEqual(orders, [0, 1, 2]);
  const res = await app.call('POST', `/milestones/${ids.c}/reorder`, { order: 0 });
  assert.deepEqual([res.status, res.body.order], [200, 0]);
  assert.deepEqual(await titlesOf(app, p.id), ['c', 'a', 'b']);
  await app.call('POST', `/milestones/${ids.c}/reorder`, { order: 99 });
  assert.deepEqual(await titlesOf(app, p.id), ['a', 'b', 'c']);
  const viaPatch = await app.call('PATCH', `/milestones/${ids.a}`, { order: 1 });
  assert.equal(viaPatch.status, 200);
  assert.deepEqual(await titlesOf(app, p.id), ['b', 'a', 'c']);
  assert.deepEqual((await app.call('GET', `/projects/${p.id}`)).body.milestones.map((m) => m.order), [0, 1, 2]);
});

test('reorder validates like position and does not touch board positions', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const a = await makeMilestone(app, p.id, { title: 'a' });
  const b = await makeMilestone(app, p.id, { title: 'b' });
  for (const order of [-1, 1.5, '1', null, undefined]) {
    assert.equal((await app.call('POST', `/milestones/${a.id}/reorder`, { order })).status, 400, String(order));
  }
  assert.equal((await app.call('POST', '/milestones/99/reorder', { order: 0 })).status, 404);
  await app.call('POST', `/milestones/${b.id}/reorder`, { order: 0 });
  const rows = (await app.call('GET', `/projects/${p.id}`)).body.milestones;
  assert.deepEqual(rows.map((m) => [m.title, m.position]), [['b', 1], ['a', 0]]);
});

test('deleting renumbers the project order', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const a = await makeMilestone(app, p.id, { title: 'a' });
  await makeMilestone(app, p.id, { title: 'b' });
  await app.call('DELETE', `/milestones/${a.id}`);
  const rows = (await app.call('GET', `/projects/${p.id}`)).body.milestones;
  assert.deepEqual(rows.map((m) => [m.title, m.order]), [['b', 0]]);
});

test('patch moves a milestone to another project, appended at the end', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app, { name: 'P' });
  const q = await makeProject(app, { name: 'Q' });
  const a = await makeMilestone(app, p.id, { title: 'a' });
  await makeMilestone(app, p.id, { title: 'b' });
  await makeMilestone(app, q.id, { title: 'x' });
  await makeMilestone(app, q.id, { title: 'y' });
  const res = await app.call('PATCH', `/milestones/${a.id}`, { project_id: q.id });
  assert.deepEqual([res.status, res.body.project_id, res.body.order], [200, q.id, 2]);
  assert.deepEqual(await titlesOf(app, q.id), ['x', 'y', 'a']);
  const old = (await app.call('GET', `/projects/${p.id}`)).body.milestones;
  assert.deepEqual(old.map((m) => [m.title, m.order]), [['b', 0]]);
});

test('patch rejects an unknown or malformed project_id without changes', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const m = await makeMilestone(app, p.id);
  for (const project_id of [99, '1', null, 1.5]) {
    const res = await app.call('PATCH', `/milestones/${m.id}`, { title: 'changed', project_id });
    assert.equal(res.status, 400, String(project_id));
  }
  const row = (await app.call('GET', `/projects/${p.id}`)).body.milestones[0];
  assert.deepEqual([row.title, row.project_id], ['M', p.id]);
});

test('old data without order falls back to due date then id, stably', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  for (const [title, due] of [['b', '2026-04-01'], ['a', '2026-02-01'], ['c', '2026-02-01']]) {
    await makeMilestone(app, p.id, { title, due_date: due });
  }
  const backup = (await app.call('GET', '/backup/export')).body;
  for (const m of backup.data.milestones) delete m.order;
  assert.equal((await app.call('POST', '/backup/import', backup)).status, 200);
  await app.call('POST', '/auth/login', { password: PASSWORD });
  const rows = (await app.call('GET', `/projects/${p.id}`)).body.milestones;
  assert.deepEqual(rows.map((m) => [m.title, m.order]), [['a', 0], ['c', 1], ['b', 2]]);
});

test('order survives a backup round trip', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { title: 'a' });
  const b = await makeMilestone(app, p.id, { title: 'b' });
  await app.call('POST', `/milestones/${b.id}/reorder`, { order: 0 });
  const backup = JSON.parse(JSON.stringify((await app.call('GET', '/backup/export')).body));
  const other = await unlockedApp();
  await other.call('POST', '/backup/import', backup);
  await other.call('POST', '/auth/login', { password: PASSWORD });
  assert.deepEqual(await titlesOf(other, p.id), ['b', 'a']);
});

test('backup import rejects a bad order', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id);
  const backup = (await app.call('GET', '/backup/export')).body;
  backup.data.milestones[0].order = -2;
  assert.equal((await app.call('POST', '/backup/import', backup)).status, 400);
});
