// In-browser backend: the same paths, JSON shapes, messages and status codes as the former
// Flask routes, on top of a storage object and Web Crypto. Nothing here touches the DOM.
import {
  DEFAULT_ITERATIONS, InvalidToken, checkPassword, decryptInt, deriveKey, encryptInt, hashPassword, newSalt, parseHash,
} from './cryptoutil.js';
import { SAMPLE_COSTS, SAMPLE_PROJECTS } from './demo.js';
import { emptyDatabase } from './storage.js';

const STATUSES = new Set(['planned', 'active', 'paused', 'done']);
const MILESTONE_STATUSES = ['todo', 'in_progress', 'done'];
const MAX_COST = 10 ** 12;
const MIN_PASSWORD_LENGTH = 8;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INCOMPLETE_STORE_ERROR = 'password store is incomplete; use "forgot password" to reset it';
export const BACKUP_FORMAT = 'projtrack-backup';
export const BACKUP_VERSION = 1;

class ValidationError extends Error {}

const reply = (status, body = null) => ({ status, body });
const notFound = (what) => reply(404, { error: `${what} not found` });

// ---- validation helpers ----

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => Object.hasOwn(obj, key);
const codePoints = (s) => [...s].length;

function jsonObject(body) {
  if (!isObject(body)) throw new ValidationError('Request body must be a JSON object');
  return body;
}

function validText(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function validDate(value, field) {
  const m = typeof value === 'string' && DATE_RE.exec(value);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const d = new Date(Date.UTC(2000, month - 1, day));
    d.setUTCFullYear(year);
    if (year >= 1 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day) return value;
  }
  throw new ValidationError(`${field} must be a valid date in YYYY-MM-DD format`);
}

const validOptionalDate = (value, field) => (value == null || value === '' ? null : validDate(value, field));

function validStatus(value) {
  if (!STATUSES.has(value)) throw new ValidationError('status must be one of: ' + [...STATUSES].sort().join(', '));
  return value;
}

function validMilestoneStatus(value) {
  if (typeof value !== 'string' || !MILESTONE_STATUSES.includes(value)) {
    throw new ValidationError('status must be one of: ' + MILESTONE_STATUSES.join(', '));
  }
  return value;
}

function validBool(value, field) {
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean`);
  return value;
}

// `status` wins over the legacy boolean `done`; absent both, keep `fallback`.
function milestoneStatusFrom(data, fallback) {
  if (has(data, 'status')) return validMilestoneStatus(data.status);
  if (has(data, 'done')) return validBool(data.done, 'done') ? 'done' : 'todo';
  return fallback;
}

function validPosition(value) {
  if (!Number.isInteger(value) || value < 0) throw new ValidationError('position must be a non-negative integer');
  return value;
}

function validColor(value) {
  if (typeof value !== 'string' || !COLOR_RE.test(value)) throw new ValidationError('color must be a hex string like #aabbcc');
  return value;
}

function validateProject(fields) {
  const clean = {
    name: validText(fields.name, 'name'),
    description: has(fields, 'description') ? fields.description : '',
    start_date: validDate(fields.start_date, 'start_date'),
    target_date: validDate(fields.target_date, 'target_date'),
    status: validStatus(has(fields, 'status') ? fields.status : 'active'),
    color: validColor(has(fields, 'color') ? fields.color : '#7aa2f7'),
  };
  if (typeof clean.description !== 'string') throw new ValidationError('description must be a string');
  if (clean.target_date < clean.start_date) throw new ValidationError('target_date must not be before start_date');
  return clean;
}

// Whole yen in 0..MAX_COST, or null to clear.
function validCost(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || value > MAX_COST) {
    throw new ValidationError(`cost must be an integer (JPY) from 0 to ${MAX_COST} or null`);
  }
  return value;
}

function validateMilestoneDates(start, due) {
  if (start !== null && start > due) throw new ValidationError('start_date must not be after due_date');
}

// ---- settings and password store ----

const STORE_EMPTY = 'empty';
const STORE_READY = 'ready';
const STORE_INCOMPLETE = 'incomplete';

function storeState(db) {
  const hasHash = has(db.settings, 'password_hash');
  const hasSalt = has(db.settings, 'kdf_salt');
  if (hasHash && hasSalt) return STORE_READY;
  return hasHash || hasSalt ? STORE_INCOMPLETE : STORE_EMPTY;
}

const dayNumber = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;

// Progress is how far along the project's timeline the latest done milestone sits.
function timelineProgress(project, milestones) {
  const done = milestones.filter((m) => m.status === 'done');
  if (!done.length) return 0;
  if (done.length === milestones.length) return 100;
  const reached = dayNumber(done.map((m) => m.due_date).sort().at(-1));
  const start = dayNumber(project.start_date);
  const span = dayNumber(project.target_date) - start;
  if (span <= 0) return reached >= start ? 100 : 0;
  return roundHalfEven(Math.min(100, Math.max(0, (100 * (reached - start)) / span)));
}

function roundHalfEven(x) {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

const sqlTimestamp = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const byPositionThenId = (a, b) => a.position - b.position || a.id - b.id;
const byDueThenId = (a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.id - b.id);
const byStartThenId = (a, b) => (a.start_date < b.start_date ? -1 : a.start_date > b.start_date ? 1 : a.id - b.id);

// ---- board columns (global across projects) ----

const columnRows = (db, status, excludingId = null) =>
  db.milestones.filter((m) => m.status === status && m.id !== excludingId).sort(byPositionThenId);

function renumberColumn(db, status) {
  columnRows(db, status).forEach((m, index) => { m.position = index; });
}

function nextPosition(db, status) {
  const positions = db.milestones.filter((m) => m.status === status).map((m) => m.position);
  return positions.length ? Math.max(...positions) + 1 : 0;
}

// Insert the card at `position` (clamped) in newStatus, then renumber both columns.
function placeInColumn(db, milestone, newStatus, position) {
  const oldStatus = milestone.status;
  const rows = columnRows(db, newStatus, milestone.id);
  rows.splice(Math.min(position, rows.length), 0, milestone);
  milestone.status = newStatus;
  rows.forEach((m, index) => { m.position = index; });
  if (oldStatus !== newStatus) renumberColumn(db, oldStatus);
}

// ---- the api ----

export function createApi({
  store, iterations = DEFAULT_ITERATIONS, failedLoginDelayMs = 500, now = () => new Date(), sleep,
}) {
  let key = null; // AES-GCM key; only ever in memory, so a reload locks the app
  let queue = Promise.resolve();
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function loadDb() {
    const stored = await store.load();
    return stored ?? emptyDatabase();
  }

  function isAuthenticated(db) {
    if (key === null) return false;
    if (storeState(db) !== STORE_READY) { // e.g. the password was reset meanwhile
      key = null;
      return false;
    }
    return true;
  }

  async function milestoneJson(row) {
    const { cost_enc: token, ...rest } = row;
    const out = { ...rest, done: row.status === 'done', cost: null };
    if (token !== null) {
      try {
        out.cost = await decryptInt(key, token);
      } catch (err) {
        if (!(err instanceof InvalidToken)) throw err;
        out.cost_locked = true;
      }
    }
    return out;
  }

  async function projectJson(db, row, milestoneRows) {
    const milestones = [];
    for (const m of [...milestoneRows].sort(byDueThenId)) milestones.push(await milestoneJson(m));
    return {
      ...row,
      milestones,
      cost_total: milestones.reduce((sum, m) => sum + (m.cost || 0), 0),
      progress: timelineProgress(row, milestones),
    };
  }

  const fetchProject = (db, id) => {
    const row = db.projects.find((p) => p.id === id);
    return row ? projectJson(db, row, db.milestones.filter((m) => m.project_id === id)) : null;
  };

  async function fetchProjects(db) {
    const rows = [...db.projects].sort(byStartThenId);
    return Promise.all(rows.map((p) => projectJson(db, p, db.milestones.filter((m) => m.project_id === p.id))));
  }

  const encryptCost = (value) => (value === null ? null : encryptInt(key, value));

  // ---- projects ----

  const listProjects = async (ctx) => reply(200, await fetchProjects(ctx.db));

  async function createProject(ctx) {
    const p = validateProject(jsonObject(ctx.body));
    const { db } = ctx;
    const row = { id: ++db.seq.projects, ...p, created_at: sqlTimestamp(now()) };
    db.projects.push(row);
    ctx.dirty = true;
    return reply(201, await fetchProject(db, row.id));
  }

  async function getProject(ctx, id) {
    const project = await fetchProject(ctx.db, id);
    return project ? reply(200, project) : notFound('Project');
  }

  async function updateProject(ctx, id) {
    const row = ctx.db.projects.find((p) => p.id === id);
    if (!row) return notFound('Project');
    const data = jsonObject(ctx.body);
    const editable = ['name', 'description', 'start_date', 'target_date', 'status', 'color'];
    const merged = Object.fromEntries(editable.map((k) => [k, has(data, k) ? data[k] : row[k]]));
    Object.assign(row, validateProject(merged));
    ctx.dirty = true;
    return reply(200, await fetchProject(ctx.db, id));
  }

  async function deleteProject(ctx, id) {
    const { db } = ctx;
    if (!db.projects.some((p) => p.id === id)) return notFound('Project');
    db.projects = db.projects.filter((p) => p.id !== id);
    db.milestones = db.milestones.filter((m) => m.project_id !== id);
    ctx.dirty = true;
    return reply(204);
  }

  // ---- milestones ----

  async function createMilestone(ctx, projectId) {
    const { db } = ctx;
    if (!db.projects.some((p) => p.id === projectId)) return notFound('Project');
    const data = jsonObject(ctx.body);
    const title = validText(data.title, 'title');
    const due = validDate(data.due_date, 'due_date');
    const start = validOptionalDate(data.start_date, 'start_date');
    validateMilestoneDates(start, due);
    const status = milestoneStatusFrom(data, 'todo');
    const cost = validCost(data.cost);
    const row = {
      id: ++db.seq.milestones, project_id: projectId, title, start_date: start, due_date: due,
      status, position: nextPosition(db, status), cost_enc: await encryptCost(cost),
    };
    db.milestones.push(row);
    ctx.dirty = true;
    return reply(201, await milestoneJson(row));
  }

  async function updateMilestone(ctx, id) {
    const { db } = ctx;
    const row = db.milestones.find((m) => m.id === id);
    if (!row) return notFound('Milestone');
    const data = jsonObject(ctx.body);
    const title = has(data, 'title') ? validText(data.title, 'title') : row.title;
    const due = has(data, 'due_date') ? validDate(data.due_date, 'due_date') : row.due_date;
    const start = has(data, 'start_date') ? validOptionalDate(data.start_date, 'start_date') : row.start_date;
    validateMilestoneDates(start, due);
    const status = milestoneStatusFrom(data, row.status);
    const cost = has(data, 'cost') ? validCost(data.cost) : null;
    const costToken = has(data, 'cost') ? await encryptCost(cost) : undefined;
    if (status !== row.status) placeInColumn(db, row, status, Infinity);
    if (costToken !== undefined) row.cost_enc = costToken;
    Object.assign(row, { title, start_date: start, due_date: due });
    ctx.dirty = true;
    return reply(200, await milestoneJson(row));
  }

  async function moveMilestone(ctx, id) {
    const data = jsonObject(ctx.body);
    const status = validMilestoneStatus(data.status);
    const position = validPosition(data.position);
    const row = ctx.db.milestones.find((m) => m.id === id);
    if (!row) return notFound('Milestone');
    placeInColumn(ctx.db, row, status, position);
    ctx.dirty = true;
    return reply(200, await milestoneJson(row));
  }

  async function deleteMilestone(ctx, id) {
    const { db } = ctx;
    const row = db.milestones.find((m) => m.id === id);
    if (!row) return notFound('Milestone');
    db.milestones = db.milestones.filter((m) => m.id !== id);
    renumberColumn(db, row.status);
    ctx.dirty = true;
    return reply(204);
  }

  // ---- auth ----

  const passwordFrom = (body, field) => (isObject(body) && typeof body[field] === 'string' ? body[field] : null);
  const shortPassword = () => reply(400, { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  const incompleteStore = () => reply(409, { error: INCOMPLETE_STORE_ERROR });
  const tooShort = (password) => password === null || codePoints(password) < MIN_PASSWORD_LENGTH;

  async function failedLogin() {
    if (failedLoginDelayMs > 0) await wait(failedLoginDelayMs);
    return reply(401, { error: 'invalid password' });
  }

  async function installPassword(db, password) {
    const kdfSalt = newSalt();
    db.settings.password_hash = await hashPassword(password, iterations);
    db.settings.kdf_salt = kdfSalt;
    return deriveKey(password, kdfSalt, iterations);
  }

  async function authStatus(ctx) {
    return reply(200, { configured: storeState(ctx.db) !== STORE_EMPTY, authenticated: isAuthenticated(ctx.db) });
  }

  async function setup(ctx) {
    const { db } = ctx;
    const state = storeState(db);
    if (state === STORE_INCOMPLETE) return incompleteStore();
    if (state === STORE_READY) return reply(409, { error: 'password is already set up' });
    const password = passwordFrom(ctx.body, 'password');
    if (tooShort(password)) return shortPassword();
    key = null;
    key = await installPassword(db, password);
    ctx.dirty = true;
    return reply(201, { configured: true, authenticated: true });
  }

  async function login(ctx) {
    const { db } = ctx;
    const state = storeState(db);
    if (state === STORE_INCOMPLETE) return incompleteStore();
    if (state === STORE_EMPTY) return reply(409, { error: 'password is not set up' });
    const password = passwordFrom(ctx.body, 'password');
    if (password === null || !(await checkPassword(db.settings.password_hash, password))) return failedLogin();
    const { iterations: count } = parseHash(db.settings.password_hash);
    key = null;
    key = await deriveKey(password, db.settings.kdf_salt, count);
    return reply(200, { configured: true, authenticated: true });
  }

  async function logout() {
    key = null;
    return reply(204);
  }

  // Re-encrypt readable costs; unreadable ones are left as they are.
  async function reencryptCosts(db, oldKey, newKey) {
    for (const m of db.milestones) {
      if (m.cost_enc === null) continue;
      try {
        m.cost_enc = await encryptInt(newKey, await decryptInt(oldKey, m.cost_enc));
      } catch (err) {
        if (!(err instanceof InvalidToken)) throw err;
      }
    }
  }

  async function changePassword(ctx) {
    const { db } = ctx;
    const current = passwordFrom(ctx.body, 'current');
    const next = passwordFrom(ctx.body, 'new');
    if (!isAuthenticated(db)) return reply(401, { error: 'authentication required' });
    if (current === null || !(await checkPassword(db.settings.password_hash, current))) return failedLogin();
    if (tooShort(next)) return shortPassword();
    const newKey = await installPassword(db, next);
    await reencryptCosts(db, key, newKey);
    key = newKey;
    ctx.dirty = true;
    return reply(200, { configured: true, authenticated: true });
  }

  // Forgot password: drop the verifier and salt. Costs stay stored but become unreadable ("locked").
  async function resetPassword(ctx) {
    delete ctx.db.settings.password_hash;
    delete ctx.db.settings.kdf_salt;
    key = null;
    ctx.dirty = true;
    return reply(200, { configured: false, authenticated: false });
  }

  // ---- backup ----

  async function exportBackup(ctx) {
    const { projects, milestones, settings, seq } = ctx.db;
    return reply(200, {
      format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: now().toISOString(),
      data: { projects, milestones, settings, seq },
    });
  }

  async function importBackup(ctx) {
    ctx.db = validateBackup(ctx.body);
    key = null;
    ctx.dirty = true;
    return reply(200, { configured: storeState(ctx.db) !== STORE_EMPTY, authenticated: false });
  }

  // ---- demo data ----

  const offsetDate = (days) => {
    const d = now();
    const utc = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + days);
    return new Date(utc).toISOString().slice(0, 10);
  };

  async function loadDemo() {
    const existing = new Set((await execute('GET', '/projects')).body.map((p) => p.name));
    let projects = 0;
    let milestones = 0;
    for (const spec of SAMPLE_PROJECTS) {
      if (existing.has(spec.name)) continue;
      const created = await execute('POST', '/projects', {
        name: spec.name, description: spec.description, status: spec.status,
        start_date: offsetDate(spec.start), target_date: offsetDate(spec.target), color: spec.color,
      });
      projects += 1;
      for (const [title, start, due, status] of spec.milestones) {
        const body = { title, start_date: start === null ? null : offsetDate(start), due_date: offsetDate(due), status };
        const cost = SAMPLE_COSTS[`${spec.name}|${title}`];
        if (cost !== undefined) body.cost = cost;
        await execute('POST', `/projects/${created.body.id}/milestones`, body);
        milestones += 1;
      }
    }
    return reply(200, { projects, milestones });
  }

  // ---- routing ----

  const ROUTES = [
    ['GET', /^\/projects$/, listProjects],
    ['POST', /^\/projects$/, createProject],
    ['GET', /^\/projects\/(\d+)$/, getProject],
    ['PATCH', /^\/projects\/(\d+)$/, updateProject],
    ['DELETE', /^\/projects\/(\d+)$/, deleteProject],
    ['POST', /^\/projects\/(\d+)\/milestones$/, createMilestone],
    ['PATCH', /^\/milestones\/(\d+)$/, updateMilestone],
    ['POST', /^\/milestones\/(\d+)\/move$/, moveMilestone],
    ['DELETE', /^\/milestones\/(\d+)$/, deleteMilestone],
    ['GET', /^\/backup\/export$/, exportBackup],
    ['POST', /^\/backup\/import$/, importBackup],
    ['GET', /^\/auth\/status$/, authStatus],
    ['POST', /^\/auth\/setup$/, setup],
    ['POST', /^\/auth\/login$/, login],
    ['POST', /^\/auth\/logout$/, logout],
    ['POST', /^\/auth\/change-password$/, changePassword],
    ['POST', /^\/auth\/reset$/, resetPassword],
  ];

  async function execute(method, path, body) {
    const db = await loadDb();
    if (!path.startsWith('/auth/') && !isAuthenticated(db)) return reply(401, { error: 'authentication required' });
    if (method === 'POST' && path === '/demo') return loadDemo();
    let allowed = false;
    for (const [routeMethod, pattern, handler] of ROUTES) {
      const match = pattern.exec(path);
      if (!match) continue;
      allowed = true;
      if (routeMethod !== method) continue;
      const ctx = { db, body, dirty: false };
      try {
        const response = await handler(ctx, ...match.slice(1).map(Number));
        if (ctx.dirty) await store.save(ctx.db);
        return response;
      } catch (err) {
        if (err instanceof ValidationError) return reply(400, { error: err.message });
        throw err;
      }
    }
    return allowed ? reply(405, { error: 'Method not allowed' }) : reply(404, { error: 'Not found' });
  }

  // Requests run one at a time and bodies cross a JSON boundary, like the old HTTP calls.
  function request(method, path, body) {
    const wire = body === undefined ? undefined : JSON.parse(JSON.stringify(body));
    const run = queue.then(() => execute(method, path, wire));
    queue = run.catch(() => {});
    return run;
  }

  return { request };
}

// ---- backup validation ----

function backupError(message) {
  return new ValidationError(`invalid backup: ${message}`);
}

function positiveId(value, what) {
  if (!Number.isInteger(value) || value < 1) throw backupError(`${what} id must be a positive integer`);
  return value;
}

function wrapBackup(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValidationError && !err.message.startsWith('invalid backup')) throw backupError(err.message);
    throw err;
  }
}

// Returns a clean database object, or throws a ValidationError describing the first problem.
export function validateBackup(file) {
  return wrapBackup(() => {
    if (!isObject(file) || file.format !== BACKUP_FORMAT) throw backupError('not a projtrack backup file');
    if (file.version !== BACKUP_VERSION) throw backupError(`unsupported version ${JSON.stringify(file.version)}`);
    const { data } = file;
    if (!isObject(data) || !Array.isArray(data.projects) || !Array.isArray(data.milestones)) {
      throw backupError('projects and milestones must be lists');
    }
    const db = emptyDatabase();
    const projectIds = new Set();
    for (const raw of data.projects) {
      if (!isObject(raw)) throw backupError('project must be an object');
      const id = positiveId(raw.id, 'project');
      if (projectIds.has(id)) throw backupError(`duplicate project id ${id}`);
      projectIds.add(id);
      const created = typeof raw.created_at === 'string' ? raw.created_at : '';
      db.projects.push({ id, ...validateProject(raw), created_at: created });
    }
    const milestoneIds = new Set();
    for (const raw of data.milestones) {
      if (!isObject(raw)) throw backupError('milestone must be an object');
      const id = positiveId(raw.id, 'milestone');
      if (milestoneIds.has(id)) throw backupError(`duplicate milestone id ${id}`);
      milestoneIds.add(id);
      if (!projectIds.has(raw.project_id)) throw backupError(`milestone ${id} refers to a missing project`);
      const start = validOptionalDate(raw.start_date, 'start_date');
      const due = validDate(raw.due_date, 'due_date');
      validateMilestoneDates(start, due);
      if (raw.cost_enc !== null && typeof raw.cost_enc !== 'string') throw backupError('cost_enc must be text or null');
      db.milestones.push({
        id, project_id: raw.project_id, title: validText(raw.title, 'title'), start_date: start, due_date: due,
        status: validMilestoneStatus(raw.status), position: validPosition(raw.position), cost_enc: raw.cost_enc,
      });
    }
    const settings = data.settings ?? {};
    if (!isObject(settings)) throw backupError('settings must be an object');
    const hasHash = has(settings, 'password_hash');
    const hasSalt = has(settings, 'kdf_salt');
    if (hasHash !== hasSalt) throw backupError('password_hash and kdf_salt must both be present or both absent');
    if (hasHash) {
      if (!parseHash(settings.password_hash)) throw backupError('password_hash is not valid');
      if (typeof settings.kdf_salt !== 'string' || !settings.kdf_salt) throw backupError('kdf_salt is not valid');
      db.settings = { password_hash: settings.password_hash, kdf_salt: settings.kdf_salt };
    }
    const seq = isObject(data.seq) ? data.seq : {};
    const top = (rows, given) => Math.max(Number.isInteger(given) ? given : 0, ...rows.map((r) => r.id));
    db.seq = { projects: top(db.projects, seq.projects), milestones: top(db.milestones, seq.milestones) };
    return db;
  });
}
