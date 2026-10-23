import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../web/localapi.js';
import { PASSWORD, TEST_ITERATIONS, makeMilestone, makeProject, newApp, unlockedApp } from './helpers.js';

const status = async (app) => (await app.call('GET', '/auth/status')).body;
const restart = (app) => newApp({ store: app.store });

test('status before and after setup', async () => {
  const app = newApp();
  assert.deepEqual(await status(app), { configured: false, authenticated: false });
  const res = await app.call('POST', '/auth/setup', { password: PASSWORD });
  assert.deepEqual([res.status, res.body], [201, { configured: true, authenticated: true }]);
  assert.deepEqual(await status(app), { configured: true, authenticated: true });
});

test('setup twice conflicts', async () => {
  const app = await unlockedApp();
  const res = await app.call('POST', '/auth/setup', { password: 'another one' });
  assert.deepEqual([res.status, res.body.error], [409, 'password is already set up']);
});

for (const body of [undefined, {}, { password: 'short' }, { password: 7 }, { password: 'sevench' }]) {
  test(`setup rejects ${JSON.stringify(body)}`, async () => {
    const app = newApp();
    const res = await app.call('POST', '/auth/setup', body);
    assert.deepEqual([res.status, res.body.error], [400, 'password must be at least 8 characters']);
    assert.equal((await status(app)).configured, false);
  });
}

test('every non-auth route requires authentication', async () => {
  const app = newApp();
  for (const [method, path] of [
    ['GET', '/projects'], ['POST', '/projects'], ['GET', '/projects/1'], ['PATCH', '/projects/1'],
    ['DELETE', '/projects/1'], ['POST', '/projects/1/milestones'], ['PATCH', '/milestones/1'],
    ['POST', '/milestones/1/move'], ['DELETE', '/milestones/1'], ['GET', '/backup/export'],
    ['POST', '/backup/import'], ['POST', '/demo'], ['GET', '/anything'],
  ]) {
    const res = await app.call(method, path, {});
    assert.deepEqual([res.status, res.body.error], [401, 'authentication required'], `${method} ${path}`);
  }
});

test('login: wrong password 401, unconfigured 409, right password ok', async () => {
  const fresh = newApp();
  const none = await fresh.call('POST', '/auth/login', { password: PASSWORD });
  assert.deepEqual([none.status, none.body.error], [409, 'password is not set up']);

  const app = await unlockedApp();
  await app.call('POST', '/auth/logout');
  const bad = await app.call('POST', '/auth/login', { password: 'wrong password' });
  assert.deepEqual([bad.status, bad.body.error], [401, 'invalid password']);
  assert.equal((await app.call('POST', '/auth/login')).status, 401);
  assert.equal((await status(app)).authenticated, false);
  const ok = await app.call('POST', '/auth/login', { password: PASSWORD });
  assert.deepEqual([ok.status, ok.body], [200, { configured: true, authenticated: true }]);
});

test('failed logins wait before answering', async () => {
  const waits = [];
  const app = createApi({
    store: newApp().store, iterations: TEST_ITERATIONS, failedLoginDelayMs: 500,
    sleep: async (ms) => { waits.push(ms); },
  });
  await app.request('POST', '/auth/setup', { password: PASSWORD });
  await app.request('POST', '/auth/login', { password: 'nope nope nope' });
  assert.deepEqual(waits, [500]);
});

test('logout then 401', async () => {
  const app = await unlockedApp();
  assert.equal((await app.call('POST', '/auth/logout')).status, 204);
  assert.equal((await app.call('GET', '/projects')).status, 401);
});

test('reloading locks the app but keeps the data', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { cost: 4200 });
  const reloaded = restart(app);
  assert.deepEqual(await status(reloaded), { configured: true, authenticated: false });
  assert.equal((await reloaded.call('GET', '/projects')).status, 401);
  await reloaded.call('POST', '/auth/login', { password: PASSWORD });
  assert.equal((await reloaded.call('GET', '/projects')).body[0].cost_total, 4200);
});

test('password and costs are never stored in plain text', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { cost: 424242 });
  const raw = JSON.stringify(await app.store.load());
  assert.ok(!raw.includes(PASSWORD));
  assert.ok(!raw.includes('424242'));
  assert.match((await app.store.load()).settings.password_hash, /^pbkdf2-sha256\$10\$/);
});

test('same cost encrypts to different tokens (random IV)', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { cost: 100 });
  await makeMilestone(app, p.id, { cost: 100 });
  const [a, b] = (await app.store.load()).milestones.map((m) => m.cost_enc);
  assert.notEqual(a, b);
});

test('change password requires auth, the right current and a long new one', async () => {
  const anon = newApp();
  const res = await anon.call('POST', '/auth/change-password', { current: PASSWORD, new: 'new password' });
  assert.deepEqual([res.status, res.body.error], [401, 'authentication required']);

  const app = await unlockedApp();
  const wrong = await app.call('POST', '/auth/change-password', { current: 'wrong password', new: 'new password' });
  assert.deepEqual([wrong.status, wrong.body.error], [401, 'invalid password']);
  const short = await app.call('POST', '/auth/change-password', { current: PASSWORD, new: 'short' });
  assert.deepEqual([short.status, short.body.error], [400, 'password must be at least 8 characters']);
});

test('change password re-encrypts costs and the old password stops working', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { cost: 900 });
  const res = await app.call('POST', '/auth/change-password', { current: PASSWORD, new: 'brand new pw' });
  assert.deepEqual([res.status, res.body], [200, { configured: true, authenticated: true }]);
  assert.equal((await app.call('GET', '/projects')).body[0].milestones[0].cost, 900);

  const later = restart(app);
  assert.equal((await later.call('POST', '/auth/login', { password: PASSWORD })).status, 401);
  assert.equal((await later.call('POST', '/auth/login', { password: 'brand new pw' })).status, 200);
  const m = (await later.call('GET', '/projects')).body[0].milestones[0];
  assert.deepEqual([m.cost, m.cost_locked], [900, undefined]);
});

test('reset clears the password, locks, and leaves costs locked', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { cost: 900 });
  await makeMilestone(app, p.id);
  const res = await app.call('POST', '/auth/reset');
  assert.deepEqual([res.status, res.body], [200, { configured: false, authenticated: false }]);
  assert.equal((await app.call('GET', '/projects')).status, 401);

  await app.call('POST', '/auth/setup', { password: 'a new password' });
  const [project] = (await app.call('GET', '/projects')).body;
  const [withCost, without] = project.milestones;
  assert.deepEqual([withCost.cost, withCost.cost_locked], [null, true]);
  assert.deepEqual([without.cost, without.cost_locked], [null, undefined]);
  assert.equal(project.cost_total, 0);
  assert.equal(project.milestones.length, 2);

  const created = await makeMilestone(app, project.id, { cost: 5 });
  assert.equal(created.cost, 5);
});

test('reset works without being unlocked', async () => {
  const app = restart(await unlockedApp());
  assert.equal((await app.call('POST', '/auth/reset')).status, 200);
  assert.deepEqual(await status(app), { configured: false, authenticated: false });
});

test('changing password leaves already locked costs untouched', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await makeMilestone(app, p.id, { cost: 1 });
  await app.call('POST', '/auth/reset');
  await app.call('POST', '/auth/setup', { password: 'second password' });
  await makeMilestone(app, p.id, { cost: 2 });
  await app.call('POST', '/auth/change-password', { current: 'second password', new: 'third password' });
  const ms = (await app.call('GET', '/projects')).body[0].milestones;
  assert.deepEqual(ms.map((m) => [m.cost, m.cost_locked === true]), [[null, true], [2, false]]);
});

test('incomplete password store is reported, and reset repairs it', async () => {
  for (const settings of [{ password_hash: 'x' }, { kdf_salt: 'x' }]) {
    const app = newApp();
    await app.store.save({ projects: [], milestones: [], settings, seq: { projects: 0, milestones: 0 } });
    for (const path of ['/auth/setup', '/auth/login']) {
      const res = await app.call('POST', path, { password: PASSWORD });
      assert.equal(res.status, 409);
      assert.match(res.body.error, /password store is incomplete/);
    }
    await app.call('POST', '/auth/reset');
    assert.equal((await app.call('POST', '/auth/setup', { password: PASSWORD })).status, 201);
  }
});

test('requests are serialized: concurrent cost writes all land', async () => {
  const app = await unlockedApp();
  const p = await makeProject(app);
  await Promise.all(Array.from({ length: 10 }, (_, i) => makeMilestone(app, p.id, { title: `m${i}`, cost: i + 1 })));
  const project = (await app.call('GET', `/projects/${p.id}`)).body;
  assert.equal(project.milestones.length, 10);
  assert.equal(project.cost_total, 55);
});
