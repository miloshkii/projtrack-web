import { createApi } from '../web/localapi.js';
import { createMemoryStore } from '../web/storage.js';

export const PASSWORD = 'correct horse';
export const TEST_ITERATIONS = 10;

export function newApp({ store = createMemoryStore() } = {}) {
  const api = createApi({ store, iterations: TEST_ITERATIONS, failedLoginDelayMs: 0 });
  const call = (method, path, body) => api.request(method, path, body);
  return { api, store, call };
}

export async function unlockedApp(opts) {
  const app = newApp(opts);
  const res = await app.call('POST', '/auth/setup', { password: PASSWORD });
  if (res.status !== 201) throw new Error('setup failed');
  return app;
}

export async function makeProject(app, overrides = {}) {
  const res = await app.call('POST', '/projects', {
    name: 'Alpha', start_date: '2026-01-01', target_date: '2026-06-30', ...overrides,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body;
}

export async function makeMilestone(app, projectId, overrides = {}) {
  const res = await app.call('POST', `/projects/${projectId}/milestones`, {
    title: 'M', due_date: '2026-03-01', ...overrides,
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body;
}

export async function column(app, status) {
  const projects = (await app.call('GET', '/projects')).body;
  return projects.flatMap((p) => p.milestones).filter((m) => m.status === status)
    .sort((a, b) => a.position - b.position).map((m) => m.title);
}
