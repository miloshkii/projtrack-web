// CSV export of one month, as the month view shows it.
import { decimals } from './currencies.js';

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

// Cells that a spreadsheet would run as a formula get a leading quote.
export const safeCell = (cell) => (typeof cell === 'string' && FORMULA_PREFIXES.some((p) => cell.startsWith(p)) ? `'${cell}` : cell);

const quote = (cell) => {
  const text = String(cell ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const trimRate = (rate) => (rate === null ? '' : rate.toFixed(8).replace(/0+$/, '').replace(/\.$/, ''));

export function monthCsv(view, base) {
  const places = decimals(base);
  const conversion = (item) => [
    item.currency, trimRate(item.rate), item.amount_base === null ? '' : item.amount_base.toFixed(places),
  ];
  const rows = [['type', 'date', 'category', 'amount', 'kind', 'description', 'note', 'currency', 'rate', 'amount_base']];
  for (const i of view.income) {
    rows.push(['income', i.date, i.category, i.amount.toFixed(2), '', i.source, i.note, ...conversion(i)]);
  }
  for (const e of view.expenses) {
    rows.push(['expense', e.date, e.category, e.amount.toFixed(2), e.kind, e.payee, e.note, ...conversion(e)]);
  }
  for (const r of view.recurring) {
    rows.push(['recurring', r.date, r.category, r.amount.toFixed(2), 'recurring', r.name, '', ...conversion(r)]);
  }
  return `${rows.map((row) => row.map((c) => quote(safeCell(c))).join(',')).join('\r\n')}\r\n`;
}
