// 'YYYY-MM' month arithmetic shared by the budget modules.
export function shiftMonth(month, delta) {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + delta;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function monthsBetween(firstMonth, lastMonth) {
  const months = [];
  for (let current = firstMonth; current <= lastMonth; current = shiftMonth(current, 1)) months.push(current);
  return months;
}

export const monthsEndingAt = (month, count) => monthsBetween(shiftMonth(month, -(count - 1)), month);

export const monthOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
