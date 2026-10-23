// Shared DOM, date and money helpers for the projtrack UI.
const SVG_NS = 'http://www.w3.org/2000/svg';
const yenNumber = new Intl.NumberFormat('ja-JP');

// HTML element: props `class`, `text`, `onX` (event listener); anything else is an attribute.
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

export function svgEl(name, attrs = {}, className) {
  const node = document.createElementNS(SVG_NS, name);
  if (className) node.setAttribute('class', className);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function svgTitle(node, text) {
  const t = document.createElementNS(SVG_NS, 'title');
  t.textContent = text;
  node.appendChild(t);
}

// Dates are local calendar dates ('YYYY-MM-DD'), never parsed via UTC.
const pad = (n) => String(n).padStart(2, '0');

export const formatDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export const todayStr = () => formatDate(new Date());
export const plusDays = (n) => formatDate(addDays(new Date(), n));

export const formatYen = (amount) => `¥${yenNumber.format(amount)}`;

export const PRIORITIES = ['none', 'low', 'medium', 'high'];
const PRIORITY_MARKS = { low: '!', medium: '!!', high: '!!!' };

// Small marker for a milestone's priority; null when there is none.
export function priorityMark(m) {
  const mark = PRIORITY_MARKS[m.priority];
  return mark ? h('span', { class: `prio prio-${m.priority}`, text: mark, title: `priority: ${m.priority}` }) : null;
}

export const priorityNote = (m) => (m.priority && m.priority !== 'none' ? ` · ${m.priority} priority` : '');
