import { test } from 'node:test';
import assert from 'node:assert/strict';
import { column, makeMilestone, makeProject, unlockedApp } from './helpers.js';

async function board() {
  const app = await unlockedApp();
  const p = await makeProject(app);
  const q = await makeProject(app, { name: 'Beta' });
  const ids = {};
  for (const [name, project] of [['a', p], ['b', q], ['c', p], ['d', q]]) {
    ids[name] = (await makeMilestone(app, project.id, { title: name })).id;
  }
  return { app, ids };
}

const move = (app, id, status, position) => app.call('POST', `/milestones/${id}/move`, { status, position });

test('new milestones are appended to their column across projects', async () => {
  const { app } = await board();
  assert.deepEqual(await column(app, 'todo'), ['a', 'b', 'c', 'd']);
});

test('move within a column reorders', async () => {
  const { app, ids } = await board();
  const res = await move(app, ids.d, 'todo', 0);
  assert.equal(res.status, 200);
  assert.equal(res.body.position, 0);
  assert.deepEqual(await column(app, 'todo'), ['d', 'a', 'b', 'c']);
  await move(app, ids.d, 'todo', 2);
  assert.deepEqual(await column(app, 'todo'), ['a', 'b', 'd', 'c']);
});

test('move to another column renumbers both and clamps the position', async () => {
  const { app, ids } = await board();
  await move(app, ids.a, 'in_progress', 5);
  await move(app, ids.b, 'in_progress', 0);
  assert.deepEqual(await column(app, 'todo'), ['c', 'd']);
  assert.deepEqual(await column(app, 'in_progress'), ['b', 'a']);
  const projects = (await app.call('GET', '/projects')).body;
  const todo = projects.flatMap((p) => p.milestones).filter((m) => m.status === 'todo').map((m) => m.position).sort();
  assert.deepEqual(todo, [0, 1]);
});

test('moving to done sets the done flag', async () => {
  const { app, ids } = await board();
  assert.equal((await move(app, ids.a, 'done', 0)).body.done, true);
  assert.equal((await move(app, ids.a, 'todo', 0)).body.done, false);
});

test('move validation', async () => {
  const { app, ids } = await board();
  for (const [body, message] of [
    [{ status: 'x', position: 0 }, 'status must be one of: todo, in_progress, done'],
    [{ status: 'todo', position: -1 }, 'position must be a non-negative integer'],
    [{ status: 'todo', position: 1.5 }, 'position must be a non-negative integer'],
    [{ status: 'todo', position: true }, 'position must be a non-negative integer'],
    [{ status: 'todo' }, 'position must be a non-negative integer'],
  ]) {
    const res = await app.call('POST', `/milestones/${ids.a}/move`, body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, message);
  }
  assert.equal((await app.call('POST', `/milestones/${ids.a}/move`, [])).status, 400);
});

test('patching status appends to the end of the new column', async () => {
  const { app, ids } = await board();
  await move(app, ids.c, 'done', 0);
  const res = await app.call('PATCH', `/milestones/${ids.a}`, { status: 'done' });
  assert.deepEqual([res.body.status, res.body.position], ['done', 1]);
  assert.deepEqual(await column(app, 'done'), ['c', 'a']);
  assert.deepEqual(await column(app, 'todo'), ['b', 'd']);
});

test('patching with the same status does not reorder', async () => {
  const { app, ids } = await board();
  await app.call('PATCH', `/milestones/${ids.a}`, { status: 'todo', title: 'a' });
  assert.deepEqual(await column(app, 'todo'), ['a', 'b', 'c', 'd']);
});

test('deleting a milestone renumbers its column', async () => {
  const { app, ids } = await board();
  assert.equal((await app.call('DELETE', `/milestones/${ids.b}`)).status, 204);
  const positions = (await app.call('GET', '/projects')).body
    .flatMap((p) => p.milestones).map((m) => [m.title, m.position]).sort();
  assert.deepEqual(positions, [['a', 0], ['c', 1], ['d', 2]]);
});

test('ties in position fall back to id order', async () => {
  const { app, ids } = await board();
  const data = await app.store.load();
  data.milestones.forEach((m) => { m.position = 0; });
  await app.store.save(data);
  await move(app, ids.d, 'todo', 1);
  assert.deepEqual(await column(app, 'todo'), ['a', 'd', 'b', 'c']);
});
