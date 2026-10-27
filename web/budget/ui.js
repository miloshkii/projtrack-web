// Budget section UI: month view, analytics, subscriptions and settings, on top of the in-browser API.
import { h as makeElement } from '../dom.js';
import { validateNewPassword } from '../auth.js';
import { barChart, savingsChart } from './charts.js';
import { currencyCodes, decimals, formatMoney, symbol } from './currencies.js';
import { monthOf, shiftMonth } from './months.js';

const TABS = ['month', 'analytics', 'subscriptions', 'settings'];
const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'];
const RANGES = ['3', '6', '12', 'all'];
const STATUS_CLEAR_MS = 6000;
const PREF_PREFIX = 'projtrack.budget.';

// Element builder: skips null/false children and props, flattens arrays.
function el(tag, props = {}, ...children) {
  const clean = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== null && v !== undefined && v !== false) clean[k] = v === true ? '' : v;
  }
  return makeElement(tag, clean, ...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const todayIso = () => `${monthOf(new Date())}-${String(new Date().getDate()).padStart(2, '0')}`;
const pct = (v, signed) => (isNum(v) ? `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—');

function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(PREF_PREFIX + key);
    if (raw) return JSON.parse(raw);
  } catch { /* storage unavailable or corrupt */ }
  return fallback;
}

function savePref(key, value) {
  try { localStorage.setItem(PREF_PREFIX + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const textCompare = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'accent' });

// Num and date columns put missing values last in both directions.
function sortRows(rows, cols, sort) {
  const col = cols.find((c) => c.key === sort.key) || cols[0];
  const dir = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const [va, vb] = [col.value(a), col.value(b)];
    if (col.type === 'text') return textCompare(va, vb) * dir;
    const missingA = col.type === 'num' ? !isNum(va) : !va;
    const missingB = col.type === 'num' ? !isNum(vb) : !vb;
    if (missingA || missingB) return missingA === missingB ? 0 : missingA ? 1 : -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
  });
}

const INCOME_COLS = [
  { key: 'date', label: 'date', type: 'date', value: (r) => r.date },
  { key: 'source', label: 'source', type: 'text', value: (r) => r.source },
  { key: 'category', label: 'category', type: 'text', value: (r) => r.category },
  { key: 'amount', label: 'amount', type: 'num', value: (r) => r.amount_base },
];
const EXPENSE_COLS = [
  { key: 'date', label: 'date', type: 'date', value: (r) => r.date },
  { key: 'payee', label: 'payee', type: 'text', value: (r) => (r.kind === 'lump' ? r.note : r.payee) },
  { key: 'category', label: 'category', type: 'text', value: (r) => r.category },
  { key: 'type', label: 'type', type: 'text', value: (r) => r.kind },
  { key: 'amount', label: 'amount', type: 'num', value: (r) => r.amount_base },
];
const RECURRING_COLS = [
  { key: 'date', label: 'date', type: 'date', value: (r) => r.date },
  { key: 'name', label: 'name', type: 'text', value: (r) => r.name },
  { key: 'category', label: 'category', type: 'text', value: (r) => r.category },
  { key: 'amount', label: 'amount', type: 'num', value: (r) => r.amount_base },
];
const SUBSCRIPTION_COLS = [
  { key: 'name', label: 'name', type: 'text', value: (r) => r.name },
  { key: 'category', label: 'category', type: 'text', value: (r) => r.category },
  { key: 'amount', label: 'amount', type: 'num', value: (r) => r.amount_base },
  { key: 'freq', label: 'freq', type: 'text', value: (r) => r.frequency },
  { key: 'start', label: 'start', type: 'date', value: (r) => r.start_date },
  { key: 'end', label: 'end', type: 'date', value: (r) => r.end_date },
  { key: 'active', label: 'active', type: 'num', value: (r) => (r.active ? 1 : 0) },
];
const SORT_DEFAULTS = {
  income: { key: 'date', dir: 'desc' },
  expenses: { key: 'date', dir: 'desc' },
  recurring: { key: 'date', dir: 'asc' },
  subscriptions: { key: 'name', dir: 'asc' },
};

function monthlyEquivalent(sub) {
  const a = sub.amount_base;
  if (sub.frequency === 'weekly') return (a * 52) / 12;
  if (sub.frequency === 'quarterly') return a / 3;
  if (sub.frequency === 'yearly') return a / 12;
  return a;
}

export function createBudgetUi({ api, isUnauthorized, onSettings }) {
  const view = document.getElementById('budget-view');
  const body = document.getElementById('budget-body');
  const dialog = document.getElementById('budget-dlg');
  const statusEl = document.getElementById('budget-status');
  const ratesInfoEl = document.getElementById('budget-rates-info');
  const monthLabelEl = document.getElementById('budget-month-label');
  const tabEls = [...view.querySelectorAll('[data-btab]')];

  const state = {
    tab: 'month', month: monthOf(new Date()), range: '6',
    settings: { base_currency: 'JPY', auto_fetch_rates: false, income_categories: [], expense_categories: [], autolock_minutes: 15 },
  };
  const sortStates = {};
  const filterStates = {};
  let searchView = null;
  let statusTimer = null;
  let renderSeq = 0;

  // ---- formatting ----

  const base = () => state.settings.base_currency;
  const money = (v, code) => formatMoney(v, code || base());
  const defaultDate = () => (state.month === monthOf(new Date()) ? todayIso() : `${state.month}-01`);

  function setStatus(message, kind = '') {
    statusEl.textContent = message || '';
    statusEl.className = kind;
    clearTimeout(statusTimer);
    if (message) statusTimer = setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, STATUS_CLEAR_MS);
  }

  function fail(err) {
    if (!isUnauthorized(err)) setStatus(err.message, 'err');
  }

  const setRatesInfo = (asOf) => { ratesInfoEl.textContent = asOf ? `rates as of ${asOf}` : ''; };

  // Original amount, plus the converted base amount muted beside it for foreign currencies.
  function amountCell(r, cls) {
    const original = el('span', { class: `${cls ? `${cls} ` : ''}nw`, text: money(r.amount, r.currency) });
    if (r.currency === base()) return original;
    const converted = isNum(r.amount_base)
      ? el('span', { class: 'muted nw', title: `rate ${r.rate}`, text: `≈ ${money(r.amount_base)}` })
      : el('span', { class: 'warn nw', title: 'no exchange rate; excluded from totals', text: 'rate?' });
    return [original, ' ', converted];
  }

  function ratesBanner(count) {
    if (!count) return null;
    return el('div', { class: 'banner' },
      `${count} ${count === 1 ? 'item has' : 'items have'} no exchange rate and ${count === 1 ? 'is' : 'are'} excluded from totals. `,
      el('a', { href: '#', text: 'set rates in settings', onclick: (ev) => { ev.preventDefault(); setTab('settings'); } }));
  }

  // ---- building blocks ----

  const button = (label, onclick, cls = '') => el('button', { type: 'button', class: `bbtn ${cls}`.trim(), text: label, onclick });

  function panel(title, actions, ...content) {
    return el('section', { class: 'bpanel' },
      el('h3', {}, el('span', { class: 'ttl', text: title }), actions ? el('span', { class: 'actions' }, actions) : null),
      content);
  }

  function tile(label, value, cls, sub) {
    return el('div', { class: 'bpanel btile' },
      el('h3', { text: label }), el('div', { class: `val ${cls || ''}`, text: value }), sub ? el('div', { class: 'sub muted', text: sub }) : null);
  }

  const emptyMessage = (message) => el('div', { class: 'bempty', text: message });

  // ---- sortable, filterable lists ----

  function sortStateOf(id, cols) {
    if (!sortStates[id]) {
      const saved = loadPref(`sort.${id}`, null);
      const valid = saved && cols.some((c) => c.key === saved.key) && (saved.dir === 'asc' || saved.dir === 'desc');
      sortStates[id] = valid ? { key: saved.key, dir: saved.dir } : { ...SORT_DEFAULTS[id] };
    }
    return sortStates[id];
  }

  function defaultTotal(rows) {
    return { sum: rows.reduce((acc, r) => acc + (isNum(r.amount_base) ? r.amount_base : 0), 0), missing: rows.filter((r) => !isNum(r.amount_base)).length };
  }

  // cfg: id, cols, rows, row(r) -> tr, empty, actions, total(rows), totalSuffix,
  //      filter: { cats, textOf(r), selects: [{key, label, options: [[value, label]], test(r, value)}] }
  function listView(cfg) {
    const sort = sortStateOf(cfg.id, cfg.cols);
    const spec = cfg.filter;
    const selects = spec?.selects ?? [];
    const f = spec ? (filterStates[cfg.id] ??= { open: false, q: '', cat: '', cur: '' }) : null;
    const wrap = el('div', { class: 'btablewrap' });
    const out = { wrap, bar: null, foot: null, toggleBtn: null, titleEl: null, focusSearch: () => {} };
    const footText = el('span', { class: 'muted' });
    if (spec) out.foot = el('div', { class: 'total-line' }, footText);
    let clearBtn = null;

    const isFiltered = () => !!f && !!(f.q.trim() || f.cat || f.cur || selects.some((s) => f[s.key]));
    const matches = (r) => (!f.q.trim() || spec.textOf(r).toLowerCase().includes(f.q.trim().toLowerCase()))
      && (!f.cat || r.category === f.cat) && (!f.cur || r.currency === f.cur)
      && selects.every((s) => !f[s.key] || s.test(r, f[s.key]));

    function sortHeader(col) {
      const active = sort.key === col.key;
      return el('th', { class: col.type === 'num' ? 'num' : null, 'aria-sort': active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : null },
        el('button', { type: 'button', class: `sorth${active ? ' on' : ''}`, title: `sort by ${col.label}`, onclick: () => onSort(col.key) },
          col.label, el('span', { class: 'arrow', text: active ? (sort.dir === 'asc' ? '▲' : '▼') : '' })));
    }

    function draw() {
      const shown = f ? cfg.rows.filter(matches) : cfg.rows;
      const rows = sortRows(shown, cfg.cols, sort);
      if (!cfg.rows.length) wrap.replaceChildren(emptyMessage(cfg.empty));
      else if (!rows.length) wrap.replaceChildren(emptyMessage('no matches'));
      else {
        wrap.replaceChildren(el('table', {},
          el('thead', {}, el('tr', {}, cfg.cols.map(sortHeader), cfg.actions ? el('th') : null)),
          el('tbody', {}, rows.map(cfg.row))));
      }
      if (!spec) return;
      const total = (cfg.total || defaultTotal)(shown);
      footText.textContent = `${shown.length} of ${cfg.rows.length} · ${money(total.sum)}${cfg.totalSuffix || ''}`
        + (total.missing ? ` (${total.missing} unconverted)` : '');
      out.titleEl?.classList.toggle('filtered', isFiltered());
      clearBtn.hidden = !isFiltered();
    }

    function onSort(key) {
      if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
      else { sort.key = key; sort.dir = 'asc'; }
      savePref(`sort.${cfg.id}`, sort);
      draw();
    }

    if (spec) {
      const search = el('input', {
        type: 'text', class: 'fsearch', placeholder: 'search', 'aria-label': `search ${cfg.id}`, autocomplete: 'off',
        oninput: () => { f.q = search.value; draw(); },
        onkeydown: (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); search.blur(); } },
      });
      search.value = f.q;
      const cats = [...new Set([...(spec.cats || []), ...cfg.rows.map((r) => r.category)])];
      const catSel = el('select', { 'aria-label': 'category' }, el('option', { value: '', text: 'all categories' }), cats.map((c) => el('option', { value: c, text: c })));
      const currencies = [...new Set(cfg.rows.map((r) => r.currency))].sort();
      const curSel = el('select', { 'aria-label': 'currency' }, el('option', { value: '', text: 'all currencies' }), currencies.map((c) => el('option', { value: c, text: c })));
      const extras = selects.map((s) => {
        const node = el('select', { 'aria-label': s.label }, el('option', { value: '', text: `all ${s.label}` }), s.options.map(([v, l]) => el('option', { value: v, text: l })));
        node.value = f[s.key] ?? '';
        node.addEventListener('change', () => { f[s.key] = node.value; draw(); });
        return node;
      });
      catSel.value = f.cat;
      curSel.value = f.cur;
      catSel.addEventListener('change', () => { f.cat = catSel.value; draw(); });
      curSel.addEventListener('change', () => { f.cur = curSel.value; draw(); });
      clearBtn = button('clear', () => {
        Object.assign(f, { q: '', cat: '', cur: '' });
        for (const s of selects) f[s.key] = '';
        search.value = '';
        catSel.value = '';
        curSel.value = '';
        extras.forEach((n) => { n.value = ''; });
        draw();
      }, 'small');
      out.bar = el('div', { class: 'filterbar', hidden: !f.open }, search, catSel, curSel, extras, clearBtn);
      const setOpen = (open) => {
        f.open = open;
        out.bar.hidden = !open;
        out.toggleBtn.classList.toggle('on', open);
      };
      out.toggleBtn = button('filter', () => setOpen(!f.open), `small${f.open ? ' on' : ''}`);
      out.focusSearch = () => { setOpen(true); search.focus(); search.select(); };
    }
    out.attach = (panelEl) => { out.titleEl = panelEl.querySelector('.ttl'); draw(); };
    return out;
  }

  function filteredPanel(title, addButton, list) {
    const node = panel(title, [list.toggleBtn, addButton], list.bar, list.wrap, list.foot);
    list.attach(node);
    return node;
  }

  // ---- modal forms ----

  const categoryOptions = (list, current) => (current && !list.includes(current) ? [current, ...list] : list);
  const amountStep = (code) => (decimals(code || base()) === 0 ? '1' : '0.01');

  // fields: {name, label, type: text|number|date|select|checkbox|textarea, value, options, required, only, currency}
  function openForm(title, fields, onSubmit, { toggle = null } = {}) {
    const err = el('div', { class: 'form-error', role: 'alert' });
    const inputs = {};
    const wrappers = {};
    let toggleValue = toggle?.value ?? null;

    const fieldEls = fields.map((f) => {
      let input;
      if (f.type === 'select') {
        input = el('select', { name: f.name }, f.options.map((o) => el('option', { value: o, text: o })));
        input.value = f.value ?? f.options[0];
      } else if (f.type === 'textarea') {
        input = el('textarea', { name: f.name, rows: 2 });
        input.value = f.value || '';
      } else if (f.type === 'checkbox') {
        input = el('input', { type: 'checkbox', name: f.name });
        input.checked = !!f.value;
      } else {
        input = el('input', { type: f.type || 'text', name: f.name, autocomplete: 'off' });
        if (f.type === 'number') { input.step = amountStep(f.currency); input.min = '0'; }
        input.value = f.value ?? '';
      }
      if (f.required) input.required = true;
      inputs[f.name] = input;
      const wrap = el('div', { class: `field${f.type === 'checkbox' ? ' check' : ''}` },
        f.type === 'checkbox' ? [input, el('label', { text: f.label })] : [el('label', { text: f.label }), input]);
      wrappers[f.name] = wrap;
      return wrap;
    });

    if (inputs.currency && inputs.amount) {
      const syncStep = () => { inputs.amount.step = amountStep(inputs.currency.value); };
      inputs.currency.addEventListener('change', syncStep);
      syncStep();
    }

    function applyToggle() {
      for (const f of fields) {
        if (!f.only) continue;
        const visible = f.only === toggleValue;
        wrappers[f.name].hidden = !visible;
        inputs[f.name].disabled = !visible;
      }
    }

    const seg = toggle && el('div', { class: 'seg' }, toggle.options.map((o) => el('button', {
      type: 'button', class: o === toggleValue ? 'active' : '', text: o,
      onclick: () => {
        toggleValue = o;
        [...seg.children].forEach((b) => b.classList.toggle('active', b.textContent === o));
        applyToggle();
      },
    })));

    const form = el('form', {
      method: 'dialog',
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        const values = {};
        for (const f of fields) {
          const node = inputs[f.name];
          if (node.disabled) continue;
          if (f.type === 'checkbox') values[f.name] = node.checked;
          else if (f.type === 'number') values[f.name] = parseFloat(node.value);
          else values[f.name] = node.value.trim();
        }
        try {
          await onSubmit(values, toggleValue);
          dialog.close();
          render();
        } catch (e) {
          if (!isUnauthorized(e)) err.textContent = e.message;
        }
      },
    },
    el('h2', { text: title }), seg, fieldEls, err,
    el('div', { class: 'form-actions' },
      el('button', { type: 'button', text: 'cancel', onclick: () => dialog.close() }),
      el('button', { type: 'submit', text: 'save' })));
    applyToggle();
    dialog.replaceChildren(form);
    dialog.showModal();
    fieldEls.find((w) => !w.hidden)?.querySelector('input,select,textarea')?.focus();
  }

  async function confirmDelete(label, path) {
    if (!window.confirm(`delete ${label}?`)) return;
    try {
      await api('DELETE', path);
      setStatus('deleted', 'ok');
      render();
    } catch (e) { fail(e); }
  }

  const currencyField = (item) => ({
    name: 'currency', label: 'currency', type: 'select', options: currencyCodes(), value: item ? item.currency : base(),
  });

  function incomeForm(item = null) {
    const cats = categoryOptions(state.settings.income_categories, item?.category);
    if (!cats.length) return setStatus('add an income category in settings first', 'err');
    return openForm(item ? 'edit income' : 'add income', [
      { name: 'date', label: 'date', type: 'date', value: item ? item.date : defaultDate(), required: true },
      { name: 'source', label: 'source', value: item ? item.source : '' },
      { name: 'category', label: 'category', type: 'select', options: cats, value: item?.category },
      { name: 'amount', label: 'amount', type: 'number', value: item ? item.amount : '', required: true, currency: item?.currency },
      currencyField(item),
      { name: 'note', label: 'note', type: 'textarea', value: item ? item.note : '' },
    ], async (v) => {
      if (!(v.amount >= 0)) throw new Error('amount is required');
      await (item ? api('PUT', `/budget/income/${item.id}`, v) : api('POST', '/budget/income', v));
      setStatus('income saved', 'ok');
    });
  }

  function expenseForm(item = null) {
    const cats = categoryOptions(state.settings.expense_categories, item?.category);
    if (!cats.length) return setStatus('add an expense category in settings first', 'err');
    return openForm(item ? 'edit expense' : 'add expense', [
      { name: 'date', label: 'date', type: 'date', value: item && item.kind === 'transaction' ? item.date : defaultDate(), required: true, only: 'transaction' },
      { name: 'payee', label: 'payee', value: item ? item.payee : '', only: 'transaction' },
      { name: 'category', label: 'category', type: 'select', options: cats, value: item?.category },
      { name: 'amount', label: 'amount', type: 'number', value: item ? item.amount : '', required: true, currency: item?.currency },
      currencyField(item),
      { name: 'note', label: 'note', type: 'textarea', value: item ? item.note : '' },
    ], async (v, kind) => {
      if (!(v.amount >= 0)) throw new Error('amount is required');
      const payload = { kind, category: v.category, amount: v.amount, currency: v.currency, note: v.note };
      // A lump purchase belongs to the month, not a day.
      Object.assign(payload, kind === 'lump' ? { date: `${state.month}-01`, payee: '' } : { date: v.date, payee: v.payee });
      await (item ? api('PUT', `/budget/expenses/${item.id}`, payload) : api('POST', '/budget/expenses', payload));
      setStatus('expense saved', 'ok');
    }, { toggle: { options: ['transaction', 'lump'], value: item ? item.kind : 'transaction' } });
  }

  function subscriptionForm(item = null) {
    const cats = categoryOptions(state.settings.expense_categories, item?.category);
    if (!cats.length) return setStatus('add an expense category in settings first', 'err');
    return openForm(item ? 'edit subscription' : 'add subscription', [
      { name: 'name', label: 'name', value: item ? item.name : '', required: true },
      { name: 'category', label: 'category', type: 'select', options: cats, value: item?.category },
      { name: 'amount', label: 'amount', type: 'number', value: item ? item.amount : '', required: true, currency: item?.currency },
      currencyField(item),
      { name: 'frequency', label: 'frequency', type: 'select', options: FREQUENCIES, value: item ? item.frequency : 'monthly' },
      { name: 'start_date', label: 'start date', type: 'date', value: item ? item.start_date : defaultDate(), required: true },
      { name: 'end_date', label: 'end date (optional)', type: 'date', value: item?.end_date || '' },
      { name: 'active', label: 'active', type: 'checkbox', value: item ? item.active : true },
      { name: 'note', label: 'note', type: 'textarea', value: item ? item.note : '' },
    ], async (v) => {
      if (!(v.amount >= 0)) throw new Error('amount is required');
      const payload = { ...v, end_date: v.end_date || null };
      await (item ? api('PUT', `/budget/subscriptions/${item.id}`, payload) : api('POST', '/budget/subscriptions', payload));
      setStatus('subscription saved', 'ok');
    });
  }

  const rowActions = (onEdit, onDelete) => el('td', { class: 'act' }, button('edit', onEdit, 'small'), ' ', button('del', onDelete, 'small danger'));
  const textOrLock = (r, text) => (r.locked ? el('span', { class: 'muted', text: 'locked', title: 'the password was reset; this text cannot be decrypted' }) : text || '—');

  // ---- month tab ----

  async function renderMonth() {
    const data = await api('GET', `/budget/month/${state.month}`);
    const t = data.totals || {};
    setRatesInfo(data.rates_as_of);
    const tiles = el('div', { class: 'btiles' },
      tile('income', money(t.income), 'pos'),
      tile('spend', money(t.spend), 'neg', `recurring ${money(t.recurring)}`),
      tile('net', money(t.net), isNum(t.net) ? (t.net >= 0 ? 'pos' : 'neg') : 'muted'),
      tile('savings rate', pct(t.savings_rate), 'acc'));

    const incomeList = listView({
      id: 'income', cols: INCOME_COLS, rows: data.income, empty: 'no income this month', actions: true,
      filter: { cats: state.settings.income_categories, textOf: (r) => `${r.source || ''} ${r.note || ''}` },
      row: (r) => el('tr', {},
        el('td', { class: 'nw', text: r.date }),
        el('td', { class: 'wrap', title: r.note || null }, textOrLock(r, r.source)),
        el('td', { class: 'muted', text: r.category }),
        el('td', { class: 'num fx' }, amountCell(r, 'pos')),
        rowActions(() => incomeForm(r), () => confirmDelete(`income ${r.source || r.category}`, `/budget/income/${r.id}`))),
    });

    const expenseList = listView({
      id: 'expenses', cols: EXPENSE_COLS, rows: data.expenses, empty: 'no expenses this month', actions: true,
      filter: {
        cats: state.settings.expense_categories, textOf: (r) => `${r.payee || ''} ${r.note || ''}`,
        selects: [{ key: 'type', label: 'types', options: [['transaction', 'txn'], ['lump', 'lump']], test: (r, v) => r.kind === v }],
      },
      row: (r) => el('tr', {},
        el('td', { class: 'nw', text: r.kind === 'lump' ? '—' : r.date }),
        el('td', { class: 'wrap', title: r.note || null }, textOrLock(r, r.kind === 'lump' ? r.note : r.payee)),
        el('td', { class: 'muted', text: r.category }),
        el('td', {}, el('span', { class: `chip${r.kind === 'lump' ? ' lump' : ''}`, text: r.kind === 'lump' ? 'lump' : 'txn' })),
        el('td', { class: 'num fx' }, amountCell(r, 'neg')),
        rowActions(() => expenseForm(r), () => confirmDelete(`expense ${r.payee || r.category}`, `/budget/expenses/${r.id}`))),
    });
    searchView = expenseList;

    const recurringList = listView({
      id: 'recurring', cols: RECURRING_COLS, rows: data.recurring, empty: 'no recurring charges',
      row: (r) => el('tr', {},
        el('td', { class: 'nw', text: r.date }),
        el('td', { class: 'wrap' }, textOrLock(r, r.name)),
        el('td', { class: 'muted', text: r.category }),
        el('td', { class: 'num fx' }, amountCell(r, 'rec'))),
    });
    recurringList.attach(el('div'));

    return el('div', { class: 'bstack' },
      ratesBanner(data.unconverted_count),
      tiles,
      el('div', { class: 'bgrid month' },
        filteredPanel('income', button('+ add [i]', () => incomeForm()), incomeList),
        filteredPanel('expenses', button('+ add [e]', () => expenseForm()), expenseList),
        panel('recurring', button('manage →', () => setTab('subscriptions')), recurringList.wrap,
          el('div', { class: 'total-line' }, el('span', { class: 'muted', text: 'total' }), el('span', { class: 'num rec', text: money(t.recurring) })))));
  }

  // ---- subscriptions tab ----

  async function renderSubscriptions() {
    const subs = await api('GET', '/budget/subscriptions');
    setRatesInfo(null);
    const active = subs.filter((s) => s.active);
    const converted = active.filter((s) => isNum(s.amount_base));
    const monthly = converted.reduce((sum, s) => sum + monthlyEquivalent(s), 0);
    const excluded = active.length - converted.length;
    const list = listView({
      id: 'subscriptions', cols: SUBSCRIPTION_COLS, rows: subs, empty: 'no subscriptions yet', actions: true, totalSuffix: '/mo',
      total: (rows) => {
        const live = rows.filter((s) => s.active);
        const ok = live.filter((s) => isNum(s.amount_base));
        return { sum: ok.reduce((acc, s) => acc + monthlyEquivalent(s), 0), missing: live.length - ok.length };
      },
      filter: {
        cats: state.settings.expense_categories, textOf: (r) => `${r.name || ''} ${r.note || ''}`,
        selects: [
          { key: 'freq', label: 'frequencies', options: FREQUENCIES.map((x) => [x, x]), test: (r, v) => r.frequency === v },
          { key: 'state', label: 'states', options: [['active', 'active'], ['inactive', 'inactive']], test: (r, v) => r.active === (v === 'active') },
        ],
      },
      row: (r) => {
        const check = el('input', {
          type: 'checkbox', title: 'toggle active',
          onchange: async () => {
            try {
              await api('PUT', `/budget/subscriptions/${r.id}`, { ...r, active: check.checked });
              render();
            } catch (e) { check.checked = !check.checked; fail(e); }
          },
        });
        check.checked = r.active;
        return el('tr', { class: r.active ? '' : 'muted' },
          el('td', { class: 'wrap', title: r.note || null }, textOrLock(r, r.name)),
          el('td', { class: 'muted', text: r.category }),
          el('td', { class: 'num fx' }, amountCell(r, 'rec')),
          el('td', { text: r.frequency }), el('td', { text: r.start_date }), el('td', { text: r.end_date || '—' }),
          el('td', {}, check),
          rowActions(() => subscriptionForm(r), () => confirmDelete(`subscription ${r.name}`, `/budget/subscriptions/${r.id}`)));
      },
    });
    searchView = list;
    return el('div', { class: 'bstack' },
      ratesBanner(excluded),
      el('div', { class: 'btiles' },
        tile('monthly equivalent', money(monthly), 'rec', `active only${excluded ? `, ${excluded} without rate excluded` : ''}`),
        tile('yearly equivalent', money(monthly * 12), 'rec'),
        tile('active', String(active.length), 'acc', `of ${subs.length}`)),
      filteredPanel('subscriptions', button('+ add [s]', () => subscriptionForm()), list));
  }

  // ---- analytics tab ----

  const vsCell = (v) => (isNum(v)
    ? el('td', { class: `num ${v > 0 ? 'neg' : v < 0 ? 'pos' : ''}`, text: pct(v, true) })
    : el('td', { class: 'num muted', text: '—' }));

  function legendItem(color, label) {
    const swatch = el('i');
    swatch.style.background = color;
    return el('span', {}, swatch, label);
  }

  function categoryTable(cats) {
    if (!cats.length) return emptyMessage('no categories');
    return el('div', { class: 'btablewrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', { text: 'category' }), el('th', { class: 'num', text: 'total' }), el('th', { class: 'num', text: 'avg/mo' }),
        el('th', { text: '% of spend' }), el('th', { class: 'num', text: '% income' }), el('th', { class: 'num', text: 'this month' }),
        el('th', { class: 'num', text: 'vs avg' }))),
      el('tbody', {}, cats.map((c) => {
        const fill = el('span');
        fill.style.width = `${Math.max(0, Math.min(100, isNum(c.pct_of_spend) ? c.pct_of_spend : 0))}%`;
        return el('tr', {},
          el('td', { text: c.category }),
          el('td', { class: 'num', text: money(c.total) }),
          el('td', { class: 'num', text: money(c.avg_monthly) }),
          el('td', { class: 'num' }, el('span', { class: 'bar' }, fill), pct(c.pct_of_spend)),
          el('td', { class: 'num', text: pct(c.pct_of_income) }),
          el('td', { class: 'num', text: money(c.current) }),
          vsCell(c.vs_avg_pct));
      }))));
  }

  function comparison(cur, av) {
    const maxSpend = Math.max(1, isNum(cur.spend) ? cur.spend : 0, isNum(av.spend) ? av.spend : 0);
    const row = (label, value, color) => {
      const fill = el('span');
      fill.style.width = `${isNum(value) ? (value / maxSpend) * 100 : 0}%`;
      fill.style.background = color;
      return el('div', { class: 'row' }, el('span', { class: 'muted', text: label }), el('div', { class: 'track' }, fill), el('span', { class: 'num', text: money(value) }));
    };
    const diff = cur.spend_vs_avg_pct;
    return panel('this month vs average', null, el('div', { class: 'cmp' },
      row(cur.month || state.month, cur.spend, 'var(--today)'),
      row('average', av.spend, 'var(--muted)'),
      el('div', {}, el('span', { class: 'muted', text: 'difference ' }),
        el('span', { class: isNum(diff) ? (diff > 0 ? 'neg' : 'pos') : 'muted', text: pct(diff, true) }))));
  }

  async function renderAnalytics() {
    const a = await api('GET', `/budget/analytics/${state.range}/${state.month}`);
    setRatesInfo(a.rates_as_of);
    const head = el('div', { class: 'bpanel range-head' }, el('h3', { text: 'analytics' }),
      el('div', { class: 'rangesel' }, 'range', RANGES.map((r) => button(r, () => { state.range = r; render(); }, `small${state.range === r ? ' on' : ''}`))));
    const hasData = a.months.some((m) => (isNum(m.income) && m.income !== 0) || (isNum(m.spend) && m.spend !== 0));
    if (!hasData) return el('div', { class: 'bstack' }, head, panel('data', null, emptyMessage('no data in this range yet — add income and expenses on the month tab')));
    const av = a.averages || {};
    const tiles = el('div', { class: 'btiles' },
      tile('avg income', money(av.income), 'pos'),
      tile('avg spend', money(av.spend), 'neg'),
      tile('avg net', money(av.net), isNum(av.net) ? (av.net >= 0 ? 'pos' : 'neg') : 'muted'),
      tile('avg savings rate', pct(av.savings_rate), 'acc'),
      tile('recurring share', pct(a.recurring_share_pct), 'rec', 'of spend'));
    return el('div', { class: 'bstack' }, head, ratesBanner(a.unconverted_count), tiles,
      el('div', { class: 'bgrid wide' },
        panel('income vs spend', null, barChart(a.months, base()),
          el('div', { class: 'legend' }, legendItem('var(--green)', 'income'), legendItem('var(--today)', 'spend'), legendItem('var(--accent)', 'net'))),
        panel('savings rate trend', null, savingsChart(a.months))),
      el('div', { class: 'bgrid cats' }, panel('categories', null, categoryTable(a.categories || [])), comparison(a.current || {}, av)));
  }

  // ---- settings tab ----

  function categoryEditor(title, list) {
    const box = el('div', { class: 'catlist' });
    const move = (row, dir) => {
      const other = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
      if (!other) return;
      box.insertBefore(row, dir < 0 ? other : other.nextElementSibling);
      row.querySelector('.handle').focus();
      setStatus('category order changed; save settings to keep it');
    };
    const addRow = (value) => {
      const input = el('input', { type: 'text', autocomplete: 'off' });
      input.value = value;
      const handle = el('button', {
        type: 'button', class: 'handle', text: '⠿', title: 'alt+up / alt+down to reorder', 'aria-label': 'reorder category; alt+up or alt+down moves it',
        onkeydown: (ev) => {
          if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
          ev.preventDefault();
          move(row, ev.key === 'ArrowUp' ? -1 : 1);
        },
      });
      const row = el('div', { class: 'item' }, handle, input,
        button('▲', () => move(row, -1), 'small'), button('▼', () => move(row, 1), 'small'),
        button('×', () => row.remove(), 'small danger'));
      box.append(row);
      return input;
    };
    list.forEach(addRow);
    return { node: panel(title, button('+ add', () => addRow('').focus(), 'small'), box), values: () => [...box.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean) };
  }

  function passwordPanel() {
    const [current, next, confirm] = ['current-password', 'new-password', 'new-password'].map((autocomplete) => el('input', { type: 'password', autocomplete }));
    const err = el('div', { class: 'form-error', role: 'alert' });
    const form = el('form', {
      class: 'bstack', novalidate: true,
      onsubmit: async (ev) => {
        ev.preventDefault();
        err.textContent = '';
        const problem = validateNewPassword(next.value, confirm.value);
        if (problem) { err.textContent = problem; return; }
        try {
          await api('POST', '/auth/change-password', { current: current.value, new: next.value });
          form.reset();
          setStatus('password changed', 'ok');
        } catch (e) { if (!isUnauthorized(e)) err.textContent = e.message; }
      },
    },
    el('div', { class: 'field' }, el('label', { text: 'current password' }), current),
    el('div', { class: 'field' }, el('label', { text: 'new password' }), next),
    el('div', { class: 'field' }, el('label', { text: 'confirm new password' }), confirm),
    el('div', { class: 'muted small', text: 'one password for projects and budget. Encrypted costs and budget text are re-encrypted with the new one.' }),
    err, el('div', { class: 'form-actions' }, el('button', { type: 'submit', text: 'change password' })));
    return panel('password', null, form);
  }

  async function refreshRates() {
    setStatus('fetching rates…');
    try {
      const res = await api('POST', '/budget/rates/refresh');
      if (res.errors.length) setStatus(res.errors[0], 'err');
      else setStatus(`${res.updated} rate(s) updated`, 'ok');
      render();
    } catch (e) { fail(e); }
  }

  async function saveRate(month, currency, rate) {
    try {
      await api('PUT', '/budget/rates', { month, currency, rate });
      setStatus('manual rate saved', 'ok');
      render();
    } catch (e) { fail(e); }
  }

  function rateRow(r) {
    const rateCell = el('td', { class: 'num', text: String(r.rate) });
    const actions = el('td', { class: 'act' });
    const showActions = () => {
      actions.replaceChildren(button('edit', startEdit, 'small'));
      if (r.source !== 'manual') return;
      actions.append(' ', button('↺ ecb', async () => {
        try {
          await api('DELETE', `/budget/rates/${r.month}/${r.currency}`);
          setStatus('reverted to ecb', 'ok');
          render();
        } catch (e) { fail(e); }
      }, 'small'));
    };
    function startEdit() {
      const input = el('input', { type: 'number', step: 'any', min: '0' });
      input.value = r.rate;
      rateCell.replaceChildren(input);
      actions.replaceChildren(button('save', () => saveRate(r.month, r.currency, parseFloat(input.value)), 'small'), ' ',
        button('cancel', () => { rateCell.textContent = String(r.rate); showActions(); }, 'small'));
      input.focus();
    }
    showActions();
    return el('tr', {}, el('td', { class: 'nw', text: r.month }), el('td', { text: `${r.currency}→${base()}` }), rateCell,
      el('td', { class: r.source === 'manual' ? 'pur' : 'muted', text: r.source }), el('td', { class: 'nw muted', text: r.as_of }), actions);
  }

  function ratesPanel(rates) {
    const month = el('input', { type: 'month' });
    month.value = state.month;
    const currency = el('select', {}, currencyCodes().filter((c) => c !== base()).map((c) => el('option', { value: c, text: c })));
    const rate = el('input', { type: 'number', step: 'any', min: '0', placeholder: `1 unit = ? ${base()}` });
    const table = rates.length
      ? el('div', { class: 'btablewrap scroll' }, el('table', {},
        el('thead', {}, el('tr', {}, ['month', 'pair'].map((t) => el('th', { text: t })), el('th', { class: 'num', text: 'rate' }),
          el('th', { text: 'source' }), el('th', { text: 'as of' }), el('th'))),
        el('tbody', {}, rates.map(rateRow))))
      : emptyMessage('no rates cached yet; refresh, or enter one manually below');
    return panel(`exchange rates (1 unit = rate ${base()})`, button('refresh', refreshRates), table,
      el('div', { class: 'rate-add' }, month, currency, rate, button('set manual', () => saveRate(month.value, currency.value, parseFloat(rate.value)))),
      el('div', { class: 'muted small', text: 'ecb rates are daily reference rates and differ from your bank by roughly 1-3%; enter a manual rate to match your bank. Refreshing sends only currency codes and dates to frankfurter.dev.' }));
  }

  async function exportMonth() {
    try {
      const { filename, csv } = await api('GET', `/budget/export/${state.month}`);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const link = el('a', { href: url, download: filename });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`exported ${state.month}`, 'ok');
    } catch (e) { fail(e); }
  }

  async function renderSettings() {
    const current = await api('GET', '/budget/settings');
    state.settings = current;
    const rates = await api('GET', '/budget/rates');
    setRatesInfo(rates.filter((r) => r.source === 'ecb').map((r) => r.as_of).sort().pop());

    const baseSel = el('select', {}, currencyCodes().map((c) => el('option', { value: c, text: `${c} ${symbol(c)}` })));
    baseSel.value = current.base_currency;
    const autoFetch = el('input', { type: 'checkbox' });
    autoFetch.checked = current.auto_fetch_rates;
    const autolock = el('input', { type: 'number', min: '1', max: '1440', step: '1' });
    autolock.value = current.autolock_minutes;
    const income = categoryEditor('income categories', current.income_categories);
    const expense = categoryEditor('expense categories', current.expense_categories);
    const saveErr = el('div', { class: 'form-error', role: 'alert' });
    const save = button('save settings', async () => {
      saveErr.textContent = '';
      const minutes = parseInt(autolock.value, 10);
      if (!(minutes >= 1 && minutes <= 1440)) { saveErr.textContent = 'autolock must be 1-1440 minutes'; return; }
      try {
        state.settings = await api('PATCH', '/budget/settings', {
          base_currency: baseSel.value, auto_fetch_rates: autoFetch.checked, autolock_minutes: minutes,
          income_categories: income.values(), expense_categories: expense.values(),
        });
        onSettings(state.settings);
        setStatus('settings saved', 'ok');
        render();
      } catch (e) { if (!isUnauthorized(e)) saveErr.textContent = e.message; }
    });

    return el('div', { class: 'bgrid settings' },
      el('div', { class: 'bstack' },
        panel('general', null, el('div', { class: 'bstack' },
          el('div', { class: 'field' }, el('label', { text: 'base currency' }), baseSel),
          el('div', { class: 'field check' }, autoFetch, el('label', { text: 'fetch exchange rates automatically' })),
          el('div', { class: 'muted small', text: 'sends only currency codes and dates to frankfurter.dev; off by default' }),
          el('div', { class: 'field' }, el('label', { text: 'auto-lock after idle (minutes, whole app)' }), autolock))),
        panel('save', null, saveErr, el('div', { class: 'form-actions' }, save)),
        panel('export', null, el('div', { class: 'form-actions' }, button(`export ${state.month}.csv`, exportMonth)))),
      el('div', { class: 'bstack' }, income.node, expense.node),
      el('div', { class: 'bstack' }, ratesPanel(rates), passwordPanel()));
  }

  // ---- navigation and rendering ----

  async function render() {
    const seq = ++renderSeq;
    monthLabelEl.textContent = state.month;
    tabEls.forEach((t) => t.classList.toggle('active', t.dataset.btab === state.tab));
    searchView = null;
    try {
      const node = await { month: renderMonth, analytics: renderAnalytics, subscriptions: renderSubscriptions, settings: renderSettings }[state.tab]();
      if (seq === renderSeq) body.replaceChildren(node);
    } catch (e) { fail(e); }
  }

  function setTab(tab) { state.tab = tab; return render(); }
  function setMonth(month) { state.month = month; return render(); }

  tabEls.forEach((t) => t.addEventListener('click', () => setTab(t.dataset.btab)));
  document.getElementById('budget-prev').addEventListener('click', () => setMonth(shiftMonth(state.month, -1)));
  document.getElementById('budget-next').addEventListener('click', () => setMonth(shiftMonth(state.month, 1)));
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });

  return {
    // Fetches settings, then draws the current tab.
    async open() {
      try { state.settings = await api('GET', '/budget/settings'); } catch (e) { fail(e); return null; }
      await render();
      return state.settings;
    },
    settings: () => state.settings,
    // Back to a clean slate: drop decrypted rows from the DOM and any open form.
    clear() {
      renderSeq += 1;
      if (dialog.open) dialog.close();
      dialog.replaceChildren();
      body.replaceChildren();
      statusEl.textContent = '';
    },
    // Single keys while the budget section is shown; returns true when the key was used.
    handleKey(key) {
      if (dialog.open) return false;
      const tabByDigit = { 1: 'month', 2: 'analytics', 3: 'subscriptions', 4: 'settings' };
      if (key === 'i') incomeForm();
      else if (key === 'e') expenseForm();
      else if (key === 's') subscriptionForm();
      else if (key === '/') { if (!searchView) return false; searchView.focusSearch(); }
      else if (key === 'h') setMonth(shiftMonth(state.month, -1));
      else if (key === 'l') setMonth(shiftMonth(state.month, 1));
      else if (key === 'm') setTab('month');
      else if (key === 'a') setTab('analytics');
      else if (tabByDigit[key]) setTab(tabByDigit[key]);
      else return false;
      return true;
    },
    // Esc closes an open form first (the dialog would also do it natively).
    escape() {
      if (!dialog.open) return false;
      dialog.close();
      return true;
    },
    isFormOpen: () => dialog.open,
  };
}
