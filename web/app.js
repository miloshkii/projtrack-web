// projtrack UI: wires the in-browser API (localapi.js) to the Gantt renderer and the detail pane.
import { renderGantt } from './gantt.js';
import { renderBoard, groupByStatus, statusOf, COLUMNS } from './board.js';
import { bindKeys } from './keys.js';
import { h, todayStr, plusDays, formatYen, PRIORITIES, tagChips, parseTags, MAX_NOTES_LENGTH, NOTES_GLYPH } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { showAuthView, hideAuthView, validateNewPassword } from './auth.js';
import { createApi } from './localapi.js';
import { createIndexedDbStore } from './storage.js';

const PALETTE_VARS = ['--accent', '--cyan', '--green', '--yellow', '--orange', '--purple', '--today'];
const STATUSES = ['planned', 'active', 'paused', 'done'];
const DEFAULT_TARGET_DAYS = 30;
const PASSWORD_SUCCESS_MS = 1500;
const LOCKED_HINT = 'cost cannot be decrypted: the password was reset';

// ---- API ----

class UnauthorizedError extends Error {}
let onUnauthorized = () => {};

const backend = createApi({ store: createIndexedDbStore() });

async function api(method, path, body) {
  const res = await backend.request(method, path, body);
  if (res.status === 204) return null;
  const data = res.body;
  if (res.status === 401 && !path.startsWith('/auth/')) {
    onUnauthorized();
    throw new UnauthorizedError((data && data.error) || 'authentication required');
  }
  if (res.status >= 400) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// ---- state ----

const state = {
  projects: [], selectedId: null, mode: 'view', expandedIds: new Set(),
  view: 'timeline', fullscreen: false, boardFilter: null, selectedMilestoneId: null,
  tags: [], tagFilter: null, editingMilestoneId: null,
  notesOpen: new Set(),
};
const STATUS_CYCLE = { todo: 'in_progress', in_progress: 'done', done: 'todo' };
const MILESTONE_STATUSES = Object.keys(STATUS_CYCLE);
const PILL_LABELS = { todo: 'todo', in_progress: 'doing', done: 'done' };
const authEl = document.getElementById('auth-view');
const tilesEl = document.querySelector('.tiles');
const topbarCtls = document.querySelectorAll('.topbar-ctl');
const totalValueEl = document.getElementById('total-value');
let locked = true;
// Message from the last failed milestone action; shown once by the next detail render.
let actionError = '';
const timelineEl = document.getElementById('timeline');
const timelinePaneEl = document.getElementById('timeline-pane');
const filterEl = document.getElementById('board-filter');
const tagFilterEl = document.getElementById('tag-filter');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const tabEls = document.querySelectorAll('.pane-tabs [data-view]');
const detailEl = document.getElementById('detail');

const selected = () => state.projects.find((p) => p.id === state.selectedId) || null;

function paletteColors() {
  const style = getComputedStyle(document.documentElement);
  return PALETTE_VARS.map((v) => style.getPropertyValue(v).trim());
}

// ---- DOM helpers ----

function button(text, onclick, cls = '', type = 'button') {
  return h('button', { type, class: cls, text, onclick });
}

function field(label, input, ...extra) {
  return h('div', { class: 'field' }, h('label', { text: label }), input, ...extra);
}

// ---- rendering ----

const visibleProjects = () => (state.tagFilter == null
  ? state.projects
  : state.projects.filter((p) => p.tags.includes(state.tagFilter)));

function renderTimeline() {
  renderGantt(timelineEl, visibleProjects(), {
    selectedId: state.selectedId,
    onSelect: selectProject,
    onToggle: toggleExpand,
    expandedIds: state.expandedIds,
    today: new Date(),
  });
}

function renderBoardView() {
  renderBoard(timelineEl, state.projects, {
    filterProjectId: state.boardFilter,
    filterTag: state.tagFilter,
    selectedMilestoneId: state.selectedMilestoneId,
    onSelect: selectMilestone,
    onEdit: editMilestoneFromBoard,
    onMove: moveMilestone,
  });
}

function renderLeftPane() {
  if (state.view === 'board') renderBoardView();
  else renderTimeline();
}

function renderPaneHeader() {
  tabEls.forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
  filterEl.hidden = state.view !== 'board';
  filterEl.replaceChildren(
    h('option', { value: '', text: 'all projects' }),
    ...state.projects.map((p) => h('option', { value: p.id, text: p.name })));
  filterEl.value = state.boardFilter == null ? '' : String(state.boardFilter);
  tagFilterEl.hidden = state.tags.length === 0;
  tagFilterEl.replaceChildren(
    h('option', { value: '', text: 'all tags' }),
    ...state.tags.map((t) => h('option', { value: t, text: t })));
  tagFilterEl.value = state.tagFilter ?? '';
  fullscreenBtn.textContent = state.fullscreen ? '[x]' : '[ ]';
  fullscreenBtn.setAttribute('aria-pressed', String(state.fullscreen));
  tilesEl.classList.toggle('fullscreen', state.fullscreen);
}

function renderDetail() {
  detailEl.replaceChildren();
  const p = selected();
  if (state.mode === 'change-password') return detailEl.append(passwordForm());
  if (state.mode === 'new-project') return detailEl.append(projectForm(null));
  if (!p) return detailEl.append(emptyDetail());
  if (state.mode === 'edit-project') return detailEl.append(projectForm(p));
  detailEl.append(projectView(p));
}

function renderTotal() {
  const total = state.projects.reduce((sum, p) => sum + (p.cost_total || 0), 0);
  totalValueEl.textContent = formatYen(total);
}

function render() {
  renderTotal();
  renderPaneHeader();
  renderLeftPane();
  renderDetail();
}

function emptyDetail() {
  return h('div', { class: 'empty-state', style: 'flex-direction:column;gap:12px' },
    h('div', { text: 'select a project with j / k' }),
    button('+ new project', startNewProject),
    button('load demo data', loadDemoData));
}

function milestoneCount(p) {
  const done = p.milestones.filter((m) => statusOf(m) === 'done').length;
  return `${done}/${p.milestones.length}`;
}

function projectView(p) {
  const root = h('div');
  root.append(
    h('h2', { class: 'detail-title', text: p.name, style: `color:${p.color}` }),
    h('div', { class: 'detail-meta' },
      h('span', { class: `status-${p.status}`, text: p.status }),
      h('span', { class: 'muted', text: `  ${p.start_date} → ${p.target_date}` })),
    h('div', { class: 'detail-cost' }, h('span', { class: 'muted', text: 'cost ' }),
      h('span', { text: formatYen(p.cost_total || 0) })),
  );
  const chips = tagChips(p.tags);
  if (chips) root.append(chips);
  if (p.description) root.append(h('p', { text: p.description }));
  root.append(h('div', { class: 'progress-row' },
    h('div', { class: 'progress' }, h('span', { style: `width:${p.progress}%` })),
    h('span', { text: milestoneCount(p) })));

  if (actionError) root.append(h('div', { class: 'form-error', role: 'alert', text: actionError }));
  actionError = '';

  const list = h('ul', { class: 'milestone-list' });
  for (const m of p.milestones) list.append(milestoneItem(m));
  wireListReorder(list);
  root.append(list);
  if (!p.milestones.length) root.append(h('div', { class: 'muted', text: 'no milestones yet' }));

  const editing = state.mode === 'edit-milestone' && p.milestones.find((m) => m.id === state.editingMilestoneId);
  if (state.mode === 'new-milestone') {
    root.append(milestoneForm(p));
  } else if (editing) {
    root.append(milestoneForm(p, editing));
  } else {
    root.append(h('div', { class: 'detail-actions' },
      button('edit', startEditProject),
      button('+ milestone', startNewMilestone),
      button('delete', deleteSelected, 'btn-danger')));
  }
  return root;
}

function statusPill(m) {
  const status = statusOf(m);
  const pill = button(PILL_LABELS[status], () => setMilestoneStatus(m, STATUS_CYCLE[status]), `status-pill pill-${status}`);
  pill.title = `status: ${status.replace('_', ' ')} (click to change)`;
  return pill;
}

const PRIORITY_CYCLE = { none: 'low', low: 'medium', medium: 'high', high: 'none' };
const PRIORITY_MARKS = { none: '·', low: '!', medium: '!!', high: '!!!' };

function priorityButton(m) {
  const priority = m.priority || 'none';
  const btn = button(PRIORITY_MARKS[priority],
    () => run(() => api('PATCH', `/milestones/${m.id}`, { priority: PRIORITY_CYCLE[priority] })),
    `prio prio-btn prio-${priority}`);
  btn.title = `priority: ${priority} (click to change)`;
  return btn;
}

function editButton(m) {
  const btn = button('✎', () => startEditMilestone(m.id), 'btn-x btn-edit');
  btn.title = 'edit milestone (e)';
  btn.setAttribute('aria-label', `edit ${m.title}`);
  return btn;
}

// Rows are dragged to a new place; the drop index is among the other rows.
function wireListReorder(list) {
  let dragId = null;
  const dropIndex = (clientY) => {
    const rows = [...list.querySelectorAll('li:not(.dragging)')];
    const i = rows.findIndex((r) => {
      const box = r.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return { rows, index: i === -1 ? rows.length : i };
  };
  const clearMarks = () => list.querySelectorAll('.drop-before, .drop-after')
    .forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest?.('li');
    if (!row) return;
    dragId = Number(row.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    requestAnimationFrame(() => row.classList.add('dragging'));
  });
  list.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearMarks();
    const { rows, index } = dropIndex(e.clientY);
    if (index < rows.length) rows[index].classList.add('drop-before');
    else rows.at(-1)?.classList.add('drop-after');
  });
  list.addEventListener('drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    const id = dragId;
    dragId = null;
    clearMarks();
    reorderMilestone(id, dropIndex(e.clientY).index);
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    clearMarks();
    list.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
  });
}

// Selecting a row must not rebuild the detail pane, or a double-click on its title would be lost.
function selectRow(li, id) {
  if (state.selectedMilestoneId === id) return;
  state.selectedMilestoneId = id;
  li.parentElement.querySelectorAll('li.selected').forEach((r) => r.classList.remove('selected'));
  li.classList.add('selected');
  renderLeftPane();
}

function milestoneItem(m) {
  const isDone = statusOf(m) === 'done';
  const li = h('li', { class: m.id === state.selectedMilestoneId ? 'selected' : '', draggable: 'true', 'data-id': m.id },
    statusPill(m),
    priorityButton(m),
    h('span', {
      class: isDone ? 'milestone-title done' : 'milestone-title', text: m.title,
      title: 'double-click to edit', ondblclick: () => startEditMilestone(m.id),
    }),
    h('span', { class: 'muted', text: m.start_date ? `${m.start_date} → ${m.due_date}` : m.due_date }),
    costCell(m),
    editButton(m),
    button('✕', () => run(() => api('DELETE', `/milestones/${m.id}`)), 'btn-x', 'button'));
  if (m.notes) {
    li.querySelector('.milestone-title').after(notesButton(li, m));
    if (state.notesOpen.has(m.id)) li.append(notesPanel(m));
  }
  li.addEventListener('click', (e) => {
    if (e.target.closest('button, input, a')) return;
    selectRow(li, m.id);
    if (m.notes) setNotesOpen(li, m, true);
  });
  return li;
}

function notesPanel(m) {
  const panel = h('div', { class: 'milestone-notes' });
  panel.append(renderMarkdown(m.notes));
  return panel;
}

function setNotesOpen(li, m, open) {
  const panel = li.querySelector(':scope > .milestone-notes');
  if (open) {
    state.notesOpen.add(m.id);
    if (!panel) li.append(notesPanel(m));
  } else {
    state.notesOpen.delete(m.id);
    panel?.remove();
  }
  li.querySelector('.notes-btn')?.setAttribute('aria-expanded', String(open));
}

function notesButton(li, m) {
  const open = state.notesOpen.has(m.id);
  const btn = button(NOTES_GLYPH, null, 'notes-btn', 'button');
  btn.title = 'notes (click to show or hide)';
  btn.setAttribute('aria-expanded', String(open));
  btn.addEventListener('click', () => setNotesOpen(li, m, !state.notesOpen.has(m.id)));
  return btn;
}

// Empty -> null; otherwise a non-negative whole number of yen.
function parseCost(text) {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) throw new Error('cost must be a whole number of yen, 0 or more');
  return n;
}

function costCell(m) {
  if (m.cost_locked) {
    return h('span', { class: 'muted milestone-cost', text: 'locked', title: LOCKED_HINT });
  }
  const label = m.cost == null ? '+ ¥' : formatYen(m.cost);
  const btn = button(label, null, 'milestone-cost cost-btn' + (m.cost == null ? ' empty' : ''));
  btn.title = 'click to edit cost';
  btn.addEventListener('click', () => btn.replaceWith(costEditor(m)));
  return btn;
}

function costEditor(m) {
  const input = h('input', { type: 'number', min: '0', step: '1', class: 'cost-input', 'aria-label': 'cost (¥)' });
  input.value = m.cost == null ? '' : m.cost;
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (!save) return renderDetail();
    run(() => api('PATCH', `/milestones/${m.id}`, { cost: parseCost(input.value) }));
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(false));
  queueMicrotask(() => input.focus());
  return input;
}

function errorBox() {
  return h('div', { class: 'form-error', role: 'alert' });
}

// Wire a form's submit to an async handler; show thrown errors inline.
function onSubmit(form, errEl, handler) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    try {
      await handler();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

function projectForm(p) {
  const colors = paletteColors();
  const isNew = !p;
  const name = h('input', { name: 'name', required: '' });
  const desc = h('textarea', { name: 'description' });
  const start = h('input', { name: 'start_date', type: 'date' });
  const target = h('input', { name: 'target_date', type: 'date' });
  const status = h('select', { name: 'status' }, ...STATUSES.map((s) => h('option', { value: s, text: s })));
  const color = h('input', { name: 'color', type: 'hidden' });
  const tags = h('input', { name: 'tags', list: 'tag-suggestions', autocomplete: 'off', placeholder: 'comma separated' });
  const suggestions = h('datalist', { id: 'tag-suggestions' }, ...state.tags.map((t) => h('option', { value: t })));

  name.value = isNew ? '' : p.name;
  desc.value = isNew ? '' : p.description;
  start.value = isNew ? todayStr() : p.start_date;
  target.value = isNew ? plusDays(DEFAULT_TARGET_DAYS) : p.target_date;
  status.value = isNew ? 'active' : p.status;
  tags.value = isNew ? '' : p.tags.join(', ');
  color.value = isNew ? colors[0] : p.color;

  const swatches = h('div', { class: 'swatches' });
  const syncSwatches = () => swatches.childNodes.forEach((b) =>
    b.classList.toggle('selected', b.dataset.color === color.value));
  for (const c of colors) {
    const b = button('', () => { color.value = c; syncSwatches(); }, 'swatch');
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.setAttribute('aria-label', `color ${c}`);
    swatches.append(b);
  }
  syncSwatches();

  const err = errorBox();
  const form = h('form', { class: 'project-form', novalidate: '' },
    field('name', name), field('description', desc),
    field('start date', start), field('target date', target),
    field('status', status), field('tags', tags), suggestions, field('color', swatches), color, err,
    h('div', { class: 'form-actions' }, button('Save', null, '', 'submit'), button('Cancel', cancelForm)));

  onSubmit(form, err, async () => {
    const body = {
      name: name.value, description: desc.value, start_date: start.value,
      target_date: target.value, status: status.value, color: color.value,
      tags: parseTags(tags.value),
    };
    const saved = isNew ? await api('POST', '/projects', body) : await api('PATCH', `/projects/${p.id}`, body);
    state.selectedId = saved.id;
    state.mode = 'view';
    await refresh();
  });
  queueMicrotask(() => name.focus());
  return form;
}

// Add form when `m` is null; otherwise edits `m` and sends only the changed fields.
function milestoneForm(p, m = null) {
  const isNew = !m;
  const title = h('input', { name: 'title' });
  const start = h('input', { name: 'start_date', type: 'date' });
  const due = h('input', { name: 'due_date', type: 'date' });
  const cost = h('input', { name: 'cost', type: 'number', min: '0', step: '1' });
  const notes = h('textarea', { name: 'notes', maxlength: String(MAX_NOTES_LENGTH), rows: '3' });
  const counter = h('span', { class: 'notes-counter muted' });
  const updateCounter = () => {
    const used = [...notes.value].length;
    counter.textContent = `${used}/${MAX_NOTES_LENGTH}`;
    counter.classList.toggle('over', used > MAX_NOTES_LENGTH);
  };
  notes.addEventListener('input', updateCounter);
  const priority = h('select', { name: 'priority' }, ...PRIORITIES.map((v) => h('option', { value: v, text: v })));
  const status = h('select', { name: 'status' }, ...MILESTONE_STATUSES.map((v) => h('option', { value: v, text: v.replace('_', ' ') })));
  const project = h('select', { name: 'project_id' },
    ...state.projects.map((v) => h('option', { value: v.id, text: v.name })));
  project.value = p.id;
  if (isNew) {
    due.value = p.target_date;
  } else {
    title.value = m.title;
    start.value = m.start_date || '';
    due.value = m.due_date;
    cost.value = m.cost == null ? '' : m.cost;
    priority.value = m.priority || 'none';
    notes.value = m.notes || '';
    status.value = statusOf(m);
    if (m.cost_locked) {
      cost.placeholder = 'locked: enter a value to replace';
      cost.title = LOCKED_HINT;
    }
  }
  updateCounter();
  const err = errorBox();
  const form = h('form', { class: 'milestone-form', novalidate: '' },
    field('milestone', title), field('start date (optional)', start), field('due date', due),
    field('cost (¥, optional)', cost), field('priority', priority),
    field('notes (optional, markdown)', notes, counter));
  if (!isNew) form.append(field('status', status), field('project', project));
  form.append(err,
    h('div', { class: 'form-actions' }, button(isNew ? 'Add' : 'Save', null, '', 'submit'), button('Cancel', cancelForm)));

  onSubmit(form, err, async () => {
    if (isNew) {
      await api('POST', `/projects/${p.id}/milestones`, {
        title: title.value, start_date: start.value || null, due_date: due.value, cost: parseCost(cost.value),
        priority: priority.value, notes: notes.value,
      });
    } else {
      const changes = milestoneChanges(m, {
        title: title.value, start_date: start.value || null, due_date: due.value,
        priority: priority.value, notes: notes.value.trimEnd(), status: status.value, costText: cost.value, project_id: Number(project.value),
      });
      if (Object.keys(changes).length) {
        const saved = await api('PATCH', `/milestones/${m.id}`, changes);
        state.selectedId = saved.project_id;
      }
    }
    state.mode = 'view';
    await refresh();
  });
  queueMicrotask(() => title.focus());
  return form;
}

// Only the fields whose form value differs from the milestone. A locked cost counts as
// changed only when something is typed, so it is never overwritten by accident.
function milestoneChanges(m, values) {
  const changes = {};
  for (const key of ['title', 'start_date', 'due_date', 'priority', 'notes']) {
    if (values[key] !== (m[key] ?? (key === 'start_date' ? null : key === 'notes' ? '' : undefined))) changes[key] = values[key];
  }
  if (values.status !== statusOf(m)) changes.status = values.status;
  if (values.project_id !== m.project_id) changes.project_id = values.project_id;
  const costTouched = m.cost_locked ? values.costText.trim() !== '' : parseCost(values.costText) !== m.cost;
  if (costTouched) changes.cost = parseCost(values.costText);
  return changes;
}

function passwordForm() {
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password' });
  const err = errorBox();
  const ok = h('div', { class: 'form-ok', role: 'status' });
  const form = h('form', { class: 'project-form', novalidate: '' },
    h('h2', { class: 'detail-title', text: 'change password' }),
    field('current password', current), field('new password', next), field('confirm new password', confirm),
    err, ok, h('div', { class: 'form-actions' }, button('Change', null, '', 'submit'), button('Close', cancelForm)));
  onSubmit(form, err, async () => {
    ok.textContent = '';
    const problem = validateNewPassword(next.value, confirm.value);
    if (problem) throw new Error(problem);
    await api('POST', '/auth/change-password', { current: current.value, new: next.value });
    form.reset();
    ok.textContent = 'password changed';
    setTimeout(() => { if (form.isConnected) cancelForm(); }, PASSWORD_SUCCESS_MS);
  });
  queueMicrotask(() => current.focus());
  return form;
}

// ---- auth flow ----

function setLockedUi(isLocked) {
  locked = isLocked;
  tilesEl.hidden = isLocked;
  topbarCtls.forEach((c) => { c.hidden = isLocked; });
}

function showLogin(configured, notice = '') {
  setLockedUi(true);
  showAuthView(authEl, { api, configured, notice, onDone: unlocked });
}

// Session gone (expired, restart or lock): drop decrypted data but keep selection/expansion.
function lockUi(notice, configured = true) {
  if (locked && !authEl.hidden) return;
  state.projects = [];
  state.mode = 'view';
  detailEl.replaceChildren();
  timelineEl.replaceChildren();
  state.fullscreen = false;
  tilesEl.classList.remove('fullscreen');
  showLogin(configured, notice);
}

async function lock() {
  try { await api('POST', '/auth/logout'); } catch { /* still lock the view */ }
  lockUi('');
}

async function unlocked() {
  hideAuthView(authEl);
  setLockedUi(false);
  try {
    await refresh();
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) detailEl.replaceChildren(h('div', { class: 'form-error', text: err.message }));
  }
}

async function boot() {
  const status = await api('GET', '/auth/status');
  if (status.authenticated) return unlocked();
  showLogin(status.configured);
}

function downloadBackup(backup) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = h('a', { href: url, download: `projtrack-backup-${todayStr()}.json` });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportBackup() {
  try { downloadBackup(await api('GET', '/backup/export')); } catch (err) { alert(err.message); }
}

async function importBackup(file) {
  if (!file || !confirm('Replace all current data with this backup? This cannot be undone.')) return;
  let result;
  try {
    result = await api('POST', '/backup/import', JSON.parse(await file.text()));
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) alert(err instanceof SyntaxError ? 'invalid backup: not a JSON file' : err.message);
    return;
  }
  state.selectedId = null;
  state.selectedMilestoneId = null;
  lockUi('backup restored, unlock with its password', result.configured);
}

function startChangePassword() {
  state.mode = 'change-password';
  renderDetail();
}

// ---- actions ----

async function refresh() {
  state.projects = await api('GET', '/projects');
  state.tags = await api('GET', '/tags');
  if (state.tagFilter != null && !state.tags.includes(state.tagFilter)) state.tagFilter = null;
  if (!allMilestones().some((m) => m.id === state.selectedMilestoneId)) state.selectedMilestoneId = null;
  if (state.boardFilter != null && !state.projects.some((p) => p.id === state.boardFilter)) state.boardFilter = null;
  if (!selected()) {
    state.selectedId = null;
    if (state.mode !== 'new-project') state.mode = 'view';
  }
  render();
}

// Run a mutation then refresh; failures are shown inline in the detail pane.
async function run(fn) {
  try {
    await fn();
    await refresh();
  } catch (err) {
    if (err instanceof UnauthorizedError) return;
    actionError = err.message;
    await refresh().catch(() => {});
  }
}

const loadDemoData = () => run(() => api('POST', '/demo'));

const allMilestones = () => state.projects.flatMap((p) => p.milestones || []);

function selectMilestone(milestoneId, projectId) {
  // Keep the DOM when nothing changes so a double-click lands on a live card.
  if (state.selectedMilestoneId === milestoneId && state.selectedId === projectId && state.mode === 'view') return;
  state.selectedMilestoneId = milestoneId;
  state.notesOpen.add(milestoneId);
  state.selectedId = projectId;
  state.mode = 'view';
  render();
}

function setMilestoneStatus(m, status) {
  return run(() => api('PATCH', `/milestones/${m.id}`, { status }));
}

function reorderMilestone(id, order) {
  return run(() => api('POST', `/milestones/${id}/reorder`, { order }));
}

// Shift+J / Shift+K: move the selected milestone down / up in its project's list.
function moveSelectedMilestoneBy(offset) {
  const list = selected()?.milestones ?? [];
  const i = list.findIndex((m) => m.id === state.selectedMilestoneId);
  const target = i + offset;
  if (i === -1 || target < 0 || target >= list.length) return;
  reorderMilestone(list[i].id, target);
}

const moveMilestoneDown = () => moveSelectedMilestoneBy(1);
const moveMilestoneUp = () => moveSelectedMilestoneBy(-1);

function moveMilestone(id, status, position) {
  return run(() => api('POST', `/milestones/${id}/move`, { status, position }));
}

// ---- view switching ----

function setView(view) {
  state.view = view;
  render();
}

function setFullscreen(on) {
  state.fullscreen = on;
  if (on) focusLeftPane();
  render();
}

function focusLeftPane() {
  document.getElementById('detail-pane').classList.remove('focused');
  timelinePaneEl.classList.add('focused');
}

const showTimeline = () => setView('timeline');
const showBoard = () => setView('board');
const toggleFullscreen = () => setFullscreen(!state.fullscreen);
const exitFullscreen = () => { if (state.fullscreen) setFullscreen(false); };

// ---- board keyboard ----

const boardColumns = () => groupByStatus(state.projects, state.boardFilter, state.tagFilter);

function selectCardBy(offset) {
  const groups = boardColumns();
  const current = allMilestones().find((m) => m.id === state.selectedMilestoneId);
  const column = current && groups[statusOf(current)];
  if (!column || !column.some((m) => m.id === current.id)) {
    const first = COLUMNS.map((c) => groups[c.status]).find((list) => list.length);
    if (first) selectMilestone(first[0].id, first[0].project.id);
    return;
  }
  const i = column.findIndex((m) => m.id === current.id);
  const next = column[Math.min(column.length - 1, Math.max(0, i + offset))];
  selectMilestone(next.id, next.project.id);
}

function moveCardBy(offset) {
  const current = allMilestones().find((m) => m.id === state.selectedMilestoneId);
  if (state.view !== 'board' || !current) return;
  const target = COLUMNS[COLUMNS.findIndex((c) => c.status === statusOf(current)) + offset];
  if (!target) return;
  moveMilestone(current.id, target.status, allMilestones().length);
}

const moveCardLeft = () => moveCardBy(-1);
const moveCardRight = () => moveCardBy(1);

function selectProject(id) {
  state.selectedMilestoneId = null;
  state.selectedId = id;
  state.mode = 'view';
  render();
}

function toggleExpand(id = state.selectedId) {
  if (id == null) return;
  if (!state.expandedIds.delete(id)) state.expandedIds.add(id);
  renderTimeline();
}

function selectBy(offset) {
  const ps = visibleProjects();
  if (!ps.length) return;
  const i = ps.findIndex((p) => p.id === state.selectedId);
  const next = i === -1 ? (offset > 0 ? 0 : ps.length - 1) : Math.min(ps.length - 1, Math.max(0, i + offset));
  selectProject(ps[next].id);
}

const selectNext = () => (state.view === 'board' ? selectCardBy(1) : selectBy(1));
const selectPrev = () => (state.view === 'board' ? selectCardBy(-1) : selectBy(-1));

function startNewProject() {
  state.mode = 'new-project';
  renderDetail();
}

function startEditProject() {
  if (!selected()) return;
  state.mode = 'edit-project';
  renderDetail();
}

function startEditMilestone(id) {
  if (!selected()?.milestones.some((m) => m.id === id)) return;
  state.editingMilestoneId = id;
  state.mode = 'edit-milestone';
  renderDetail();
}

// With a milestone selected `e` edits it, otherwise the project.
function startEdit() {
  if (state.selectedMilestoneId != null) startEditMilestone(state.selectedMilestoneId);
  else startEditProject();
}

function editMilestoneFromBoard(milestoneId, projectId) {
  selectMilestone(milestoneId, projectId);
  startEditMilestone(milestoneId);
}

function startNewMilestone() {
  if (!selected()) return;
  state.mode = 'new-milestone';
  renderDetail();
}

function deleteSelected() {
  const p = selected();
  if (!p || !confirm(`Delete project "${p.name}" and its milestones?`)) return;
  run(async () => {
    await api('DELETE', `/projects/${p.id}`);
    state.selectedId = null;
    state.mode = 'view';
  });
}

function cancelForm() {
  state.mode = 'view';
  renderDetail();
}

// Advances the first open milestone one step; with none open, reopens the last one.
function toggleNextMilestone() {
  const milestones = selected()?.milestones ?? [];
  const firstOpen = milestones.find((m) => statusOf(m) !== 'done');
  const target = firstOpen ?? milestones[milestones.length - 1];
  if (!target) return;
  setMilestoneStatus(target, firstOpen ? STATUS_CYCLE[statusOf(target)] : 'in_progress');
}

export const actions = {
  selectNext, selectPrev, startNewProject, startNewMilestone,
  startEditProject, startEdit, moveMilestoneUp, moveMilestoneDown, deleteSelected, toggleExpand, cancelForm, toggleNextMilestone, refresh,
  showTimeline, showBoard, toggleFullscreen, exitFullscreen, moveCardLeft, moveCardRight,
  lock, isLocked: () => locked,
};
export { state };

// ---- init ----

bindKeys(actions);
document.getElementById('today-date').textContent = todayStr();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderLeftPane, 150);
});

onUnauthorized = () => lockUi('session expired, unlock again');
tabEls.forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
filterEl.addEventListener('change', () => {
  state.boardFilter = filterEl.value === '' ? null : Number(filterEl.value);
  render();
});
tagFilterEl.addEventListener('change', () => {
  state.tagFilter = tagFilterEl.value === '' ? null : tagFilterEl.value;
  render();
});
fullscreenBtn.addEventListener('click', toggleFullscreen);
document.getElementById('lock-btn').addEventListener('click', lock);
const importInput = document.getElementById('import-input');
document.getElementById('export-btn').addEventListener('click', exportBackup);
document.getElementById('import-btn').addEventListener('click', () => importInput.click());
importInput.addEventListener('change', () => {
  const [file] = importInput.files;
  importInput.value = '';
  importBackup(file);
});
document.getElementById('password-btn').addEventListener('click', startChangePassword);

boot().catch((err) => {
  authEl.hidden = false;
  authEl.replaceChildren(h('div', { class: 'form-error', text: err.message }));
});
