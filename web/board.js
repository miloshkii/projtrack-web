// Kanban board: milestones of all projects grouped into global status columns.
import { h, formatYen, priorityMark, priorityNote } from './dom.js';

export const COLUMNS = [
  { status: 'todo', label: 'todo' },
  { status: 'in_progress', label: 'in progress' },
  { status: 'done', label: 'done' },
];

export const statusOf = (m) => m.status || (m.done ? 'done' : 'todo');

// Every milestone with its project attached, grouped by status and sorted by position.
export function groupByStatus(projects, filterProjectId = null, filterTag = null) {
  const groups = Object.fromEntries(COLUMNS.map((c) => [c.status, []]));
  for (const p of projects) {
    if (filterProjectId != null && p.id !== filterProjectId) continue;
    if (filterTag != null && !(p.tags || []).includes(filterTag)) continue;
    for (const m of p.milestones || []) {
      const status = statusOf(m);
      if (groups[status]) groups[status].push({ ...m, status, project: { id: p.id, name: p.name, color: p.color } });
    }
  }
  for (const list of Object.values(groups)) list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  return groups;
}

// Index in the full (unfiltered) column, with the dragged card removed, for dropping at
// `visibleIndex` among the visible cards (also without the dragged card).
export function globalIndex(fullColumn, visibleColumn, visibleIndex, movingId) {
  const full = fullColumn.filter((m) => m.id !== movingId);
  const visible = visibleColumn.filter((m) => m.id !== movingId);
  if (visibleIndex < visible.length) return full.findIndex((m) => m.id === visible[visibleIndex].id);
  if (!visible.length) return full.length;
  return full.findIndex((m) => m.id === visible[visible.length - 1].id) + 1;
}

function cardTooltip(m) {
  const parts = [m.title, m.project.name, `due ${m.due_date}`];
  if (m.cost != null) parts.push(formatYen(m.cost));
  return parts.join(' · ') + priorityNote(m);
}

function renderCard(m, selectedMilestoneId, onSelect) {
  const meta = h('div', { class: 'card-meta' },
    h('span', { class: 'muted', text: m.project.name }),
    h('span', { class: 'muted', text: m.due_date }));
  if (m.cost != null && !m.cost_locked) meta.append(h('span', { class: 'muted', text: formatYen(m.cost) }));
  const card = h('div', {
    class: 'card' + (m.id === selectedMilestoneId ? ' selected' : ''),
    draggable: 'true',
    title: cardTooltip(m),
    style: `border-left-color:${m.project.color}`,
    'data-id': m.id,
  }, h('div', { class: 'card-title' + (m.status === 'done' ? ' done' : ''), text: m.title }), meta);
  const mark = priorityMark(m);
  if (mark) card.querySelector('.card-title').prepend(mark, ' ');
  card.addEventListener('click', () => onSelect(m.id, m.project.id));
  return card;
}

// Insertion index among the column's cards (minus the dragged one) from the cursor's Y.
function insertionIndex(body, clientY) {
  const cards = [...body.querySelectorAll('.card:not(.dragging)')];
  const index = cards.findIndex((c) => {
    const r = c.getBoundingClientRect();
    return clientY < r.top + r.height / 2;
  });
  return { index: index === -1 ? cards.length : index, cards };
}

function wireColumn(column, body, ctx) {
  const { status, full, visible, onMove } = ctx;
  const clear = () => {
    column.classList.remove('drag-over');
    body.querySelector('.drop-indicator')?.remove();
  };
  column.addEventListener('dragover', (e) => {
    if (ctx.dragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    column.classList.add('drag-over');
    const { index, cards } = insertionIndex(body, e.clientY);
    let line = body.querySelector('.drop-indicator');
    if (!line) line = h('div', { class: 'drop-indicator' });
    body.insertBefore(line, cards[index] || null);
  });
  column.addEventListener('dragleave', (e) => {
    if (!column.contains(e.relatedTarget)) clear();
  });
  column.addEventListener('drop', (e) => {
    if (ctx.dragId == null) return;
    e.preventDefault();
    const { index } = insertionIndex(body, e.clientY);
    const id = ctx.dragId;
    clear();
    onMove(id, status, globalIndex(full, visible, index, id));
  });
}

function renderColumn({ status, label }, groups, fullGroups, opts, drag) {
  const visible = groups[status];
  const body = h('div', { class: 'column-body' });
  for (const m of visible) body.append(renderCard(m, opts.selectedMilestoneId, opts.onSelect));
  if (!visible.length) body.append(h('div', { class: 'column-empty muted', text: 'drop here' }));
  const column = h('section', { class: 'column', 'data-status': status },
    h('header', { class: 'column-header' },
      h('span', { text: `[ ${label} ]` }), h('span', { class: 'muted', text: ` ${visible.length}` })),
    body);
  wireColumn(column, body, {
    status, full: fullGroups[status], visible, onMove: opts.onMove,
    get dragId() { return drag.id; },
  });
  return column;
}

export function renderBoard(container, projects, {
  filterProjectId = null, filterTag = null, selectedMilestoneId = null, onSelect = () => {}, onMove = () => {},
} = {}) {
  const groups = groupByStatus(projects, filterProjectId, filterTag);
  const fullGroups = groupByStatus(projects);
  const drag = { id: null };
  const board = h('div', { class: 'board' });
  for (const col of COLUMNS) board.append(renderColumn(col, groups, fullGroups, { selectedMilestoneId, onSelect, onMove }, drag));

  board.addEventListener('dragstart', (e) => {
    const card = e.target.closest?.('.card');
    if (!card) return;
    drag.id = Number(card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', drag.id);
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  board.addEventListener('dragend', () => {
    drag.id = null;
    board.querySelectorAll('.dragging').forEach((c) => c.classList.remove('dragging'));
    board.querySelectorAll('.drag-over').forEach((c) => c.classList.remove('drag-over'));
    board.querySelectorAll('.drop-indicator').forEach((c) => c.remove());
  });
  container.replaceChildren(board);
}
