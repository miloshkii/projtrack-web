import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMilestone, makeProject, unlockedApp } from './helpers.js';

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

test('milestones sort by due_date then id inside a project', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { title: 'b', due_date: '2026-04-01' });
  await makeMilestone(app, p.id, { title: 'a', due_date: '2026-02-01' });
  await makeMilestone(app, p.id, { title: 'c', due_date: '2026-02-01' });
  const titles = (await app.call('GET', `/projects/${p.id}`)).body.milestones.map((m) => m.title);
  assert.deepEqual(titles, ['a', 'c', 'b']);
});

test('progress fills to the latest done milestone on the timeline', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app, { start_date: '2026-01-01', target_date: '2026-01-11' });
  const progress = async () => (await app.call('GET', `/projects/${p.id}`)).body.progress;
  const early = await makeMilestone(app, p.id, { due_date: '2026-01-03' });
  const late = await makeMilestone(app, p.id, { due_date: '2026-01-09' });
  await makeMilestone(app, p.id, { due_date: '2026-01-11' });
  assert.equal(await progress(), 0);
  await app.call('PATCH', `/milestones/${late.id}`, { status: 'done' });
  assert.equal(await progress(), 80);
  await app.call('PATCH', `/milestones/${early.id}`, { status: 'done' });
  assert.equal(await progress(), 80);
});

test('progress stays at the last milestone even when every milestone is done', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app, { start_date: '2026-01-01', target_date: '2026-01-11' });
  await makeMilestone(app, p.id, { status: 'done', due_date: '2026-01-06' });
  assert.equal((await app.call('GET', `/projects/${p.id}`)).body.progress, 50);
});

test('progress clamps milestones outside the project dates', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { status: 'done', due_date: '2025-12-01' });
  await makeMilestone(app, p.id);
  assert.equal((await app.call('GET', `/projects/${p.id}`)).body.progress, 0);
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
