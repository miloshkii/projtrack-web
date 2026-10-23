// Login / first-run setup view. Talks to /auth through the injected `api` function.
import { h as node } from './dom.js';

const MIN_PASSWORD_LENGTH = 8;
const RESET_CONFIRM = 'Forgot the password? This clears it so you can set a new one. '
  + 'Existing costs stay stored but can no longer be read: they show as "locked". Continue?';
const RESET_NOTICE = 'password cleared. Set a new one; old costs stay locked.';
const SETUP_NOTE = 'Costs are encrypted with this password. If you forget it, costs cannot be recovered.';

function passwordField(label, name, autocomplete) {
  const input = node('input', { type: 'password', name, autocomplete, required: '' });
  return { input, row: node('div', { class: 'field' }, node('label', { text: label }), input) };
}

// Returns an error message for a setup attempt, or '' when it is fine.
export function validateNewPassword(password, confirm) {
  if (password.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password !== confirm) return 'passwords do not match';
  return '';
}

function buildForm({ configured, notice, onSubmit, onReset }) {
  const pw = passwordField('password', 'password', configured ? 'current-password' : 'new-password');
  const confirm = configured ? null : passwordField('confirm password', 'confirm', 'new-password');
  const err = node('div', { class: 'form-error', role: 'alert', text: notice || '' });
  const submit = node('button', { type: 'submit', text: configured ? 'Unlock' : 'Set password' });
  const form = node('form', { class: 'auth-form', novalidate: '' }, pw.row);
  if (confirm) form.append(confirm.row, node('p', { class: 'muted auth-note', text: SETUP_NOTE }));
  const actions = node('div', { class: 'form-actions' }, submit);
  if (configured) {
    actions.append(node('button', {
      type: 'button', text: 'forgot password',
      onclick: async () => {
        if (!window.confirm(RESET_CONFIRM)) return;
        try { await onReset(); } catch (ex) { err.textContent = ex.message; }
      },
    }));
  }
  form.append(err, actions);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (confirm) {
      err.textContent = validateNewPassword(pw.input.value, confirm.input.value);
      if (err.textContent) return;
    }
    submit.disabled = true;
    try {
      await onSubmit(pw.input.value);
    } catch (ex) {
      err.textContent = ex.message;
      pw.input.select();
    } finally {
      submit.disabled = false;
    }
  });
  queueMicrotask(() => pw.input.focus());
  return form;
}

// Render the view into `container`; calls onDone() once logged in or set up.
export function showAuthView(container, { api, configured, notice = '', onDone }) {
  const path = configured ? '/auth/login' : '/auth/setup';
  const onSubmit = async (password) => {
    await api('POST', path, { password });
    onDone();
  };
  const onReset = async () => {
    await api('POST', '/auth/reset');
    showAuthView(container, { api, configured: false, notice: RESET_NOTICE, onDone });
  };
  container.replaceChildren(node('section', { class: 'pane auth-panel' },
    node('header', { class: 'pane-header', text: configured ? '[ unlock ]' : '[ set password ]' }),
    node('div', { class: 'pane-body' }, buildForm({ configured, notice, onSubmit, onReset }))));
  container.hidden = false;
}

export function hideAuthView(container) {
  container.hidden = true;
  container.replaceChildren();
}
