// SVG charts for the budget analytics tab. Drawn in a fixed viewBox and scaled by CSS.
import { svgEl, svgTitle } from '../dom.js';
import { formatMoney } from './currencies.js';

const W = 720;
const H = 260;
const PAD = { left: 52, right: 12, top: 12, bottom: 28 };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function shortNum(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}

export function niceTicks(lo, hi, target = 4) {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((c) => c >= raw);
  const bottom = Math.floor(lo / step) * step;
  const top = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = bottom; v <= top + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, bottom, top };
}

function frame(label) {
  return svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid meet' }, 'chart');
}

function text(content, attrs) {
  const node = svgEl('text', attrs);
  node.textContent = content;
  return node;
}

function scaleOf(lo, hi) {
  const { ticks, bottom, top } = niceTicks(lo, hi);
  const plotH = H - PAD.top - PAD.bottom;
  return { ticks, y: (v) => PAD.top + plotH - ((v - bottom) / (top - bottom)) * plotH, bottom };
}

function monthLabels(svg, months, slot) {
  months.forEach((m, i) => {
    if (months.length > 12 && i % Math.ceil(months.length / 12) !== 0) return;
    svg.append(text(m.month.slice(2), { x: PAD.left + slot * (i + 0.5), y: H - PAD.bottom + 16, 'text-anchor': 'middle' }));
  });
}

function gridLines(svg, scale, label) {
  for (const v of scale.ticks) {
    svg.append(svgEl('line', { x1: PAD.left, x2: W - PAD.right, y1: scale.y(v), y2: scale.y(v) }, 'grid-line'));
    svg.append(text(label(v), { x: PAD.left - 6, y: scale.y(v) + 4, 'text-anchor': 'end' }));
  }
}

function bar(cls, x, width, value, y0, y, title) {
  const rect = svgEl('rect', { x, y: Math.min(y(value), y0), width, height: Math.abs(y0 - y(value)) }, cls);
  svgTitle(rect, title);
  return rect;
}

export function barChart(months, base) {
  const values = months.flatMap((m) => [m.income, m.spend, m.net].filter(isNum));
  const scale = scaleOf(Math.min(0, ...values), Math.max(0, ...values));
  const svg = frame('income vs spend per month');
  gridLines(svg, scale, shortNum);
  const y0 = scale.y(0);
  svg.append(svgEl('line', { x1: PAD.left, x2: W - PAD.right, y1: y0, y2: y0 }, 'axis'));
  const slot = (W - PAD.left - PAD.right) / months.length;
  const width = Math.min(30, slot * 0.35);
  const points = [];
  months.forEach((m, i) => {
    const cx = PAD.left + slot * (i + 0.5);
    const hit = svgEl('rect', { x: PAD.left + slot * i, y: PAD.top, width: slot, height: H - PAD.top - PAD.bottom }, 'hit');
    svgTitle(hit, `${m.month}\nincome ${formatMoney(m.income, base)}\nspend ${formatMoney(m.spend, base)}\nnet ${formatMoney(m.net, base)}`);
    svg.append(hit);
    if (isNum(m.income)) svg.append(bar('b-inc', cx - width - 1, width, m.income, y0, scale.y, `${m.month} income ${formatMoney(m.income, base)}`));
    if (isNum(m.spend)) svg.append(bar('b-sp', cx + 1, width, m.spend, y0, scale.y, `${m.month} spend ${formatMoney(m.spend, base)}`));
    if (isNum(m.net)) points.push([cx, scale.y(m.net), m]);
  });
  monthLabels(svg, months, slot);
  if (points.length > 1) svg.append(svgEl('polyline', { points: points.map((p) => `${p[0]},${p[1]}`).join(' ') }, 'l-net'));
  for (const [x, y, m] of points) {
    const dot = svgEl('circle', { cx: x, cy: y, r: 3.5 }, 'd-net');
    svgTitle(dot, `${m.month} net ${formatMoney(m.net, base)}`);
    svg.append(dot);
  }
  return svg;
}

export function savingsChart(months) {
  const values = months.map((m) => m.savings_rate).filter(isNum);
  const scale = scaleOf(Math.min(0, ...values), Math.max(10, ...values));
  const svg = frame('savings rate trend');
  gridLines(svg, scale, (v) => `${v}%`);
  if (scale.bottom < 0) svg.append(svgEl('line', { x1: PAD.left, x2: W - PAD.right, y1: scale.y(0), y2: scale.y(0) }, 'axis'));
  const slot = (W - PAD.left - PAD.right) / months.length;
  monthLabels(svg, months, slot);
  let run = [];
  const flush = () => {
    if (run.length > 1) svg.append(svgEl('polyline', { points: run.map((p) => p.join(',')).join(' ') }, 'l-sr'));
    run = [];
  };
  months.forEach((m, i) => {
    if (isNum(m.savings_rate)) run.push([PAD.left + slot * (i + 0.5), scale.y(m.savings_rate)]);
    else flush(); // a month without income breaks the line
  });
  flush();
  months.forEach((m, i) => {
    if (!isNum(m.savings_rate)) return;
    const dot = svgEl('circle', { cx: PAD.left + slot * (i + 0.5), cy: scale.y(m.savings_rate), r: 3.5 }, 'd-sr');
    svgTitle(dot, `${m.month} savings rate ${m.savings_rate.toFixed(1)}%`);
    svg.append(dot);
  });
  return svg;
}
