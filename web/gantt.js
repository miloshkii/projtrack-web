// Dependency-free SVG Gantt chart. Dates are parsed as local dates, never via UTC.
import { svgEl as el, svgTitle as withTitle, parseDate, addDays, formatYen } from './dom.js';

const DAY_MS = 86400000;
const LABEL_W = 176;
const LABEL_X = 20;
const SUB_INDENT = 30;
const AXIS_H = 22;
const ROW_H = 26;
const SUB_ROW_H = 22;
const BAR_H = 14;
const SUB_BAR_H = 10;
const MIN_SUB_BAR_W = 4;
const TODAY_LABEL_CLEARANCE = 30;
const PAD_RIGHT = 16;
const PAD_DAYS = 7;
const WEEKLY_MAX_DAYS = 120;
const MIN_WIDTH = 600;
const MILESTONE_R = 5;
const DIMMED_STATUSES = ['paused', 'done'];

const statusOf = (m) => m.status || (m.done ? 'done' : 'todo');
const stateClass = (m) => ({ done: ' done', in_progress: ' in-progress' }[statusOf(m)] || '');

const costNote = (cost) => (typeof cost === 'number' ? ` · ${formatYen(cost)}` : '');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysBetween(a, b) {
  return Math.round((b - a) / DAY_MS);
}

export function computeRange(projects, today) {
  const dates = [today];
  for (const p of projects) {
    dates.push(parseDate(p.start_date), parseDate(p.target_date));
    for (const m of p.milestones || []) {
      dates.push(parseDate(m.due_date));
      if (m.start_date) dates.push(parseDate(m.start_date));
    }
  }
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  return { start: addDays(new Date(min), -PAD_DAYS), end: addDays(new Date(max), PAD_DAYS) };
}

export function buildScale(range, width) {
  const totalDays = Math.max(1, daysBetween(range.start, range.end));
  const plotW = width - LABEL_W - PAD_RIGHT;
  const x = (date) => LABEL_W + (daysBetween(range.start, date) / totalDays) * plotW;
  return { x, totalDays, plotW };
}

function weeklyTicks(range) {
  const ticks = [];
  const d = new Date(range.start);
  // advance to the first Monday
  let t = addDays(d, (8 - d.getDay()) % 7);
  for (; t <= range.end; t = addDays(t, 7)) {
    ticks.push({ date: t, label: `${t.getDate()} ${MONTHS[t.getMonth()]}` });
  }
  return ticks;
}

function monthlyTicks(range) {
  const ticks = [];
  let t = new Date(range.start.getFullYear(), range.start.getMonth() + 1, 1);
  for (; t <= range.end; t = new Date(t.getFullYear(), t.getMonth() + 1, 1)) {
    ticks.push({ date: t, label: `${MONTHS[t.getMonth()]} ${String(t.getFullYear()).slice(2)}` });
  }
  return ticks;
}

function renderAxis(svg, range, scale, height, todayX) {
  const ticks = scale.totalDays <= WEEKLY_MAX_DAYS ? weeklyTicks(range) : monthlyTicks(range);
  const axis = el('g', {}, 'gantt-axis');
  for (const { date, label } of ticks) {
    const x = scale.x(date);
    const nearToday = Math.abs(x - todayX) < TODAY_LABEL_CLEARANCE;
    svg.appendChild(el('line', { x1: x, x2: x, y1: AXIS_H, y2: height, 'stroke-width': 1 }, 'gantt-grid'));
    const text = el('text', { x, y: AXIS_H - 6, 'text-anchor': 'middle' });
    text.textContent = label;
    if (!nearToday) axis.appendChild(text);
  }
  svg.appendChild(axis);
}

function truncate(name, max = 20) {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

function renderMilestones(group, project, scale, cy, onSelect) {
  for (const m of project.milestones || []) {
    const cx = scale.x(parseDate(m.due_date));
    const r = MILESTONE_R;
    const d = `M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`;
    const node = el('path', { d }, 'gantt-milestone' + stateClass(m));
    withTitle(node, `${m.title} · ${m.due_date}${costNote(m.cost)}`);
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect(project.id);
    });
    group.appendChild(node);
  }
}

// Milestones ordered by start (falling back to due), then due, then id.
// A missing start chains from the previous milestone's due date, else the project start.
export function milestoneSpans(project) {
  const sorted = [...(project.milestones || [])].sort((a, b) =>
    (a.start_date || a.due_date).localeCompare(b.start_date || b.due_date) ||
    a.due_date.localeCompare(b.due_date) || (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
  let prevDue = project.start_date;
  return sorted.map((m) => {
    let start = m.start_date || prevDue;
    if (start > m.due_date) start = m.due_date;
    prevDue = m.due_date;
    return { milestone: m, start, due: m.due_date };
  });
}

function rowBackground(group, top, height, index, scale) {
  const bg = el('rect', { x: 0, y: top, width: scale.plotW + LABEL_W + PAD_RIGHT, height });
  bg.setAttribute('fill', index % 2 ? 'transparent' : 'rgba(128,128,128,0.06)');
  group.appendChild(bg);
}

function renderSubRow(svg, project, span, top, index, scale, onSelect) {
  const { milestone: m } = span;
  const cy = top + SUB_ROW_H / 2;
  const x1 = scale.x(parseDate(span.start));
  const x2 = scale.x(parseDate(span.due));
  const w = Math.max(MIN_SUB_BAR_W, x2 - x1);
  const group = el('g', { 'data-id': project.id, 'data-milestone-id': m.id }, 'gantt-subrow');
  group.style.cursor = 'pointer';
  withTitle(group, `${m.title} · ${span.start} → ${span.due}${statusOf(m) === 'todo' ? '' : ` · ${statusOf(m).replace('_', ' ')}`}${costNote(m.cost)}`);
  rowBackground(group, top, SUB_ROW_H, index, scale);

  const label = el('text', { x: SUB_INDENT, y: cy, 'dominant-baseline': 'middle' },
    'gantt-sub-label' + (statusOf(m) === 'done' ? ' done' : ''));
  label.textContent = truncate(m.title, 20);
  group.appendChild(label);

  const bar = el('rect', {
    x: Math.min(x1, x2 - w) + 0.5, y: cy - SUB_BAR_H / 2 + 0.5, width: w - 1, height: SUB_BAR_H - 1, rx: 1,
  }, 'gantt-subbar' + stateClass(m));
  if (statusOf(m) !== 'done') {
    bar.style.fill = project.color;
    if (statusOf(m) === 'todo') bar.style.stroke = project.color;
  }
  group.appendChild(bar);
  group.addEventListener('click', () => onSelect(project.id));
  svg.appendChild(group);
}

function renderRow(svg, project, top, index, scale, { selectedId, onSelect, onToggle, expanded }) {
  const cy = top + ROW_H / 2;
  const x1 = scale.x(parseDate(project.start_date));
  const x2 = scale.x(parseDate(project.target_date));
  const barW = Math.max(3, x2 - x1);
  const progress = Math.min(100, Math.max(0, project.progress || 0));
  const hasMilestones = (project.milestones || []).length > 0;

  const group = el('g', { 'data-id': project.id }, `gantt-row status-${project.status}`);
  group.style.cursor = 'pointer';
  withTitle(group, `${project.name} · ${project.start_date} → ${project.target_date} · ${progress}%${project.cost_total ? costNote(project.cost_total) : ''}`);
  rowBackground(group, top, ROW_H, index, scale);

  // dimmed content only; the toggle and background stay at full strength
  const content = el('g', {});
  if (DIMMED_STATUSES.includes(project.status)) content.setAttribute('opacity', '0.55');

  const label = el('text', { x: LABEL_X, y: cy, 'dominant-baseline': 'middle' }, 'gantt-row-label');
  label.textContent = truncate(project.name);
  content.appendChild(label);

  const by = cy - BAR_H / 2;
  const selected = project.id === selectedId;
  const bar = el('rect', { x: x1 + 0.5, y: by + 0.5, width: barW - 1, height: BAR_H - 1, rx: 2 },
    selected ? 'gantt-bar selected' : 'gantt-bar');
  bar.style.fill = project.color;
  if (!selected) bar.style.stroke = project.color;
  const pw = Math.max(0, ((barW - 2) * progress) / 100);
  const prog = el('rect', { x: x1 + 1, y: by + 1, width: pw, height: BAR_H - 2, rx: 1 }, 'gantt-progress');
  prog.style.fill = project.color;
  content.append(bar, prog);

  if (!expanded) renderMilestones(content, project, scale, cy, onSelect);
  group.appendChild(content);

  if (hasMilestones) {
    const toggle = el('g', { 'data-toggle': project.id, role: 'button',
      'aria-expanded': String(expanded), 'aria-label': `${expanded ? 'collapse' : 'expand'} ${project.name}` },
      'gantt-toggle');
    toggle.appendChild(el('rect', { x: 0, y: top, width: LABEL_X - 2, height: ROW_H, fill: 'transparent' }));
    const chev = el('text', { x: 9, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    chev.textContent = expanded ? '▾' : '▸';
    toggle.appendChild(chev);
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      onToggle(project.id);
    });
    group.appendChild(toggle);
  }

  group.addEventListener('click', () => onSelect(project.id));
  svg.appendChild(group);
}

function renderTodayLine(svg, scale, today, height) {
  const x = scale.x(today);
  svg.appendChild(el('line', { x1: x, x2: x, y1: AXIS_H - 3, y2: height, 'stroke-width': 1.5 }, 'gantt-today'));
  const label = el('text', { x, y: 9, 'text-anchor': 'middle', 'font-size': '10' }, 'gantt-today-label');
  label.style.fill = 'currentColor';
  label.textContent = 'today';
  svg.appendChild(label);
}

export function renderGantt(container, projects, {
  selectedId = null, onSelect = () => {}, onToggle = () => {}, expandedIds = new Set(), today = new Date(),
} = {}) {
  container.replaceChildren();
  if (!projects.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No projects yet — press n to create one';
    container.appendChild(empty);
    return;
  }

  const day = startOfDay(today);
  const width = Math.max(MIN_WIDTH, container.clientWidth);
  const isOpen = (p) => expandedIds.has(p.id) && (p.milestones || []).length > 0;
  const height = AXIS_H + projects.reduce(
    (h, p) => h + ROW_H + (isOpen(p) ? p.milestones.length * SUB_ROW_H : 0), 0) + 4;
  const range = computeRange(projects, day);
  const scale = buildScale(range, width);

  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}` }, 'gantt');
  renderAxis(svg, range, scale, height, scale.x(day));
  let top = AXIS_H;
  projects.forEach((p, i) => {
    const expanded = isOpen(p);
    renderRow(svg, p, top, i, scale, { selectedId, onSelect, onToggle, expanded });
    top += ROW_H;
    if (expanded) {
      for (const span of milestoneSpans(p)) {
        renderSubRow(svg, p, span, top, i, scale, onSelect);
        top += SUB_ROW_H;
      }
    }
  });
  renderTodayLine(svg, scale, day, height);
  container.appendChild(svg);
}
