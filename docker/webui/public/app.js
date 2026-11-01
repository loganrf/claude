// Claude Code sandbox web UI: plain DOM, no build step, no dependencies.
// The server is docker/webui/server.mjs.

const app = document.getElementById('app');

const PAGES = [
  { id: 'overview', title: 'Overview' },
  { id: 'claude', title: 'Claude' },
  { id: 'github', title: 'GitHub' },
  { id: 'remote-control', title: 'Remote Control' },
  { id: 'help', title: 'Help' },
  { id: 'security', title: 'Security' },
];

const state = {
  session: null,
  status: null,
  settings: null,
  page: 'overview',
  githubTest: null,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (typeof v === 'boolean' || (k in el && typeof v !== 'string')) el[k] = v;
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const ext = (href, ...children) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, children.length ? children : href);
const code = (text) => h('code', null, text);
const pill = (kind, text, busy = false) => h('span', { class: `pill ${kind}${busy ? ' busy' : ''}` }, text);
const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));
const alertBox = (kind, ...children) => h('div', { class: `alert ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, children);

function card(title, opts, ...body) {
  const { side, wide, id } = opts || {};
  return h('section', { class: `card${wide ? ' wide' : ''}`, id }, h('div', { class: 'card-head' }, h('h2', null, title), side), body);
}

// Live regions re-render only when what they show changes, so polling never
// wipes out something you're typing elsewhere on the page.
let liveRegions = [];
function live(keyFn, renderFn) {
  const el = h('div', { class: 'live' });
  const region = { el, keyFn, renderFn, key: undefined };
  liveRegions.push(region);
  refreshRegion(region);
  return el;
}
function refreshRegion(region) {
  let key;
  try {
    key = JSON.stringify(region.keyFn());
  } catch {
    key = String(Math.random());
  }
  if (key === region.key) return;
  region.key = key;
  region.el.replaceChildren(...[region.renderFn()].flat(Infinity).filter((c) => c != null && c !== false));
}
function refreshLive() {
  for (const r of liveRegions) if (r.el.isConnected) refreshRegion(r);
}

function toast(kind, message) {
  let box = document.querySelector('.toasts');
  if (!box) {
    box = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const t = alertBox(kind, message);
  t.classList.add('toast');
  box.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 8000 : 4000);
}

// A button that runs an async action, disables itself meanwhile and reports errors.
function actionButton(label, action, { kind = '', busyLabel, disabled, title, type = 'button', small } = {}) {
  const btn = h('button', { type, class: `btn ${kind}${small ? ' small' : ''}`, disabled: Boolean(disabled), title }, label);
  btn.addEventListener('click', async (ev) => {
    ev.preventDefault();
    btn.disabled = true;
    const old = btn.textContent;
    if (busyLabel) btn.textContent = busyLabel;
    try {
      await action(btn);
    } catch (err) {
      if (err.status !== 401 && !err.shown) toast('err', err.message);
    } finally {
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = old;
      }
    }
  });
  return btn;
}

function relTime(ms) {
  const s = Math.round((ms - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const a = Math.abs(s);
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} min`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs} h ${m % 60} min`;
  return `${Math.floor(hrs / 24)} days`;
}

function bytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(method, url, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw Object.assign(new Error('Cannot reach the container. Is it running?'), { status: 0 });
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  if (res.status === 401 && !['/api/login', '/api/password'].includes(url)) {
    if (state.session?.authenticated) {
      state.session.authenticated = false;
      render();
    }
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

let pollTimer = null;
let polling = false;
async function poll() {
  clearTimeout(pollTimer);
  if (!state.session?.authenticated) return;
  if (polling) return;
  polling = true;
  try {
    state.status = await api('GET', `/api/status${state.page === 'remote-control' ? '?screen=1' : ''}`);
    document.body.classList.remove('offline');
    refreshLive();
  } catch (err) {
    if (err.status === 0) toastOnce('Lost connection to the container; retrying…');
  } finally {
    polling = false;
  }
  if (state.session?.authenticated) pollTimer = setTimeout(poll, document.hidden ? 20000 : 4000);
}
let lastOfflineToast = 0;
function toastOnce(msg) {
  if (Date.now() - lastOfflineToast > 30000) {
    lastOfflineToast = Date.now();
    toast('warn', msg);
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});

async function loadSettings() {
  state.settings = (await api('GET', '/api/settings')).settings;
}

// ---------------------------------------------------------------------------
// Boot, routing
// ---------------------------------------------------------------------------
function pageFromHash() {
  const id = location.hash.replace(/^#\/?/, '');
  return PAGES.some((p) => p.id === id) ? id : 'overview';
}

window.addEventListener('hashchange', () => {
  state.page = pageFromHash();
  if (state.session?.authenticated) {
    renderShell();
    poll();
  }
});

async function boot() {
  try {
    state.session = await api('GET', '/api/session');
  } catch (err) {
    app.replaceChildren(h('div', { class: 'auth-wrap' }, alertBox('err', err.message)));
    return;
  }
  render();
}

async function render() {
  liveRegions = [];
  clearTimeout(pollTimer);
  if (state.session.setupRequired) return app.replaceChildren(setupScreen());
  if (!state.session.authenticated) return app.replaceChildren(loginScreen());
  state.page = pageFromHash();
  // Forms are drawn once with the current values, so have them first.
  try {
    await Promise.all([loadSettings(), poll()]);
  } catch {
    // shown by poll(), or the 401 handler re-renders
  }
  if (state.session.authenticated) {
    renderShell();
    poll();
  }
}

function renderShell() {
  liveRegions = [];
  const page = PAGES.find((p) => p.id === state.page);
  document.title = `${page.title} · Claude Code sandbox`;
  const header = h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-inner' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Claude Code sandbox', h('span', { class: 'host' }, state.session.hostname)),
      h('div', { class: 'topbar-actions' }, actionButton('Sign out', signOutWebUi, { kind: 'link', small: true })),
      h(
        'nav',
        { class: 'tabs', 'aria-label': 'Sections' },
        PAGES.map((p) => h('a', { href: `#${p.id}`, 'aria-current': p.id === state.page ? 'page' : null }, p.title)),
      ),
    ),
  );
  const main = h('main', null, PAGE_RENDERERS[state.page]());
  app.replaceChildren(header, main);
  window.scrollTo(0, 0);
}

async function signOutWebUi() {
  await api('POST', '/api/logout');
  state.session.authenticated = false;
  render();
}

// ---------------------------------------------------------------------------
// First visit: create the password
// ---------------------------------------------------------------------------
function strength(pw, min) {
  if (pw.length < min) return 1;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const bits = pw.length * Math.log2(Math.max(pool, 2));
  return bits >= 75 ? 3 : 2;
}

function passwordFields(min, { label = 'New password' } = {}) {
  const pw = h('input', { type: 'password', id: 'pw', autocomplete: 'new-password', minlength: String(min), required: true });
  const pw2 = h('input', { type: 'password', id: 'pw2', autocomplete: 'new-password', required: true });
  const meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('span'));
  const meterText = h('span', { class: 'hint' }, `At least ${min} characters. A few unrelated words make a strong, memorable password.`);
  pw.addEventListener('input', () => {
    const s = pw.value ? strength(pw.value, min) : 0;
    meter.className = `meter${s ? ` s${s}` : ''}`;
    meterText.textContent = !pw.value
      ? `At least ${min} characters. A few unrelated words make a strong, memorable password.`
      : s === 1
        ? `Too short: ${min - pw.value.length} more characters`
        : s === 2
          ? 'OK. Longer is stronger.'
          : 'Strong';
  });
  const fields = [
    h('div', { class: 'field' }, h('label', { for: 'pw' }, label), pw, meter, meterText),
    h('div', { class: 'field' }, h('label', { for: 'pw2' }, 'Repeat it'), pw2),
  ];
  const validate = () => {
    if (pw.value.length < min) return `Use at least ${min} characters`;
    if (pw.value !== pw2.value) return 'The two passwords are different';
    return null;
  };
  return { fields, pw, validate };
}

function setupScreen() {
  const min = state.session.minPassword;
  const codeInput = h('input', {
    type: 'text',
    id: 'setup-code',
    class: 'mono-input',
    autocomplete: 'one-time-code',
    autocapitalize: 'characters',
    spellcheck: 'false',
    placeholder: 'XXXX-XXXX-XXXX',
    required: true,
  });
  const { fields, pw, validate } = passwordFields(min);
  const msg = h('div', { class: 'form-msg' });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Create password');
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        msg.replaceChildren();
        const problem = validate();
        if (problem) return msg.replaceChildren(alertBox('err', problem));
        submit.disabled = true;
        try {
          await api('POST', '/api/setup', { setupCode: codeInput.value, password: pw.value });
          state.session = await api('GET', '/api/session');
          history.replaceState(null, '', '#claude');
          render();
        } catch (err) {
          msg.replaceChildren(alertBox('err', err.message));
          submit.disabled = false;
        }
      },
    },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'setup-code' }, 'Setup code'),
      codeInput,
      h(
        'span',
        { class: 'hint' },
        'Printed in the container log. Run ',
        code('docker compose logs claude'),
        ' and look for “setup code”. It changes each time the container restarts until a password is set.',
      ),
    ),
    fields,
    msg,
    h('div', { class: 'row' }, submit),
  );
  return h(
    'div',
    { class: 'auth-wrap' },
    h(
      'section',
      { class: 'card auth-card' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Claude Code sandbox', h('span', { class: 'host' }, state.session.hostname)),
      h('h1', null, 'Create a password'),
      h(
        'p',
        { class: 'muted' },
        'Anyone who can open this page can sign in to Claude, change tokens and start Remote Control in this container, so protect it first.',
      ),
      form,
      h('p', { class: 'hint' }, 'Prefer to set it in advance? Put ', code('CLAUDE_WEBUI_PASSWORD'), ' in your .env file and restart the container.'),
    ),
  );
}

function loginScreen() {
  const pw = h('input', { type: 'password', id: 'login-pw', autocomplete: 'current-password', required: true, autofocus: true });
  const msg = h('div', { class: 'form-msg' });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Sign in');
  const form = h(
    'form',
    {
      onsubmit: async (ev) => {
        ev.preventDefault();
        msg.replaceChildren();
        submit.disabled = true;
        try {
          await api('POST', '/api/login', { password: pw.value });
          state.session = await api('GET', '/api/session');
          render();
        } catch (err) {
          msg.replaceChildren(alertBox('err', err.message));
          submit.disabled = false;
          pw.select();
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'login-pw' }, 'Password'), pw),
    msg,
    h('div', { class: 'row' }, submit),
  );
  setTimeout(() => pw.focus(), 0);
  return h(
    'div',
    { class: 'auth-wrap' },
    h(
      'section',
      { class: 'card auth-card' },
      h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Claude Code sandbox', h('span', { class: 'host' }, state.session.hostname)),
      h('h1', null, 'Sign in'),
      form,
      state.session.passwordSource === 'environment'
        ? h('p', { class: 'hint' }, 'The password is set by ', code('CLAUDE_WEBUI_PASSWORD'), ' in the container environment.')
        : h('p', { class: 'hint' }, 'Forgot it? See “Reset the web UI password” in the README.'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Settings forms
// ---------------------------------------------------------------------------
const s = (key) => state.settings?.[key];

function sourceBadge(item) {
  if (!item) return null;
  if (item.source === 'environment') return h('span', { class: 'badge env', title: 'Set in the container environment, for example in .env' }, 'from environment');
  if (item.source === 'saved') return h('span', { class: 'badge saved' }, 'saved here');
  return null;
}

function lockedHint(key) {
  const item = s(key);
  return h('span', { class: 'hint' }, 'Set by ', code(item.envName || key), ' in the container environment. Change it there (for example in .env) and recreate the container.');
}

// fields: [{ key, label, type: 'text'|'secret'|'select'|'number'|'email', hint, placeholder, options }]
function settingsForm(fields, { submitLabel = 'Save', onSaved, note } = {}) {
  const inputs = {};
  const rows = fields.map((f) => {
    const item = s(f.key);
    const id = `f-${f.key}`;
    let input;
    if (f.type === 'select') {
      input = h(
        'select',
        { id, disabled: item?.locked },
        f.options.map(([value, text]) => h('option', { value, selected: (item?.value || '') === value }, text)),
      );
    } else {
      input = h('input', {
        id,
        type: f.type === 'secret' ? 'password' : f.type || 'text',
        class: f.type === 'secret' || f.mono ? 'mono-input' : null,
        value: f.type === 'secret' ? '' : item?.value || '',
        placeholder: f.type === 'secret' ? (item?.set ? `${item.hint} — paste a new one to replace it` : f.placeholder || 'Paste it here') : f.placeholder || '',
        autocomplete: 'off',
        spellcheck: 'false',
        disabled: item?.locked,
        min: f.min,
        max: f.max,
      });
    }
    inputs[f.key] = input;
    let current = null;
    if (f.type === 'secret' && item?.set) {
      current = h('span', { class: 'hint' }, 'Current: ', h('span', { class: 'mono' }, item.hint));
    }
    return h(
      'div',
      { class: 'field' },
      h('label', { for: id }, f.label, sourceBadge(item)),
      input,
      item?.locked ? lockedHint(f.key) : [current, f.hint && h('span', { class: 'hint' }, f.hint)],
    );
  });
  const editable = fields.filter((f) => !s(f.key)?.locked);
  const msg = h('div', { class: 'form-msg' });
  const save = async () => {
    const values = {};
    for (const f of editable) {
      const v = inputs[f.key].value.trim();
      if (f.type === 'secret') {
        if (v) values[f.key] = v;
      } else values[f.key] = v || null;
    }
    if (!Object.keys(values).length) return toast('info', 'Nothing to save');
    await saveValues(values, msg);
    onSaved?.();
  };
  const secretsToRemove = fields.filter((f) => f.type === 'secret' && s(f.key)?.source === 'saved');
  const buttons = h(
    'div',
    { class: 'row' },
    editable.length ? actionButton(submitLabel, save, { kind: 'primary', busyLabel: 'Saving…', type: 'submit' }) : null,
    secretsToRemove.map((f) =>
      actionButton(
        `Remove ${fields.length > 1 ? f.label.toLowerCase() : ''}`.trim(),
        async () => {
          if (!confirm(`Remove the saved ${f.label.toLowerCase()}?`)) return;
          await saveValues({ [f.key]: null }, msg);
          onSaved?.();
        },
        { kind: 'danger' },
      ),
    ),
  );
  return h('form', { onsubmit: (ev) => ev.preventDefault() }, rows, note, msg, buttons);
}

async function saveValues(values, msgEl) {
  msgEl?.replaceChildren();
  try {
    const res = await api('POST', '/api/settings', { values });
    state.settings = res.settings;
    toast('ok', res.changed.length ? 'Saved' : 'No changes');
    await poll();
    renderShell();
  } catch (err) {
    msgEl?.replaceChildren(alertBox('err', err.message));
    throw Object.assign(err, { shown: Boolean(msgEl) });
  }
}

// ---------------------------------------------------------------------------
// Shared status pieces
// ---------------------------------------------------------------------------
const st = () => state.status;
const rc = () => st()?.remoteControl;
const ct = () => st()?.container;

const RC_STATES = {
  running: ['ok', 'Running'],
  starting: ['warn', 'Starting', true],
  stopping: ['warn', 'Stopping', true],
  retrying: ['warn', 'Restarting soon', true],
  blocked: ['err', 'Can’t start'],
  failed: ['err', 'Stopped after errors'],
  off: ['off', 'Off'],
  stopped: ['off', 'Stopped'],
};

function rcPill() {
  const [kind, text, busy] = RC_STATES[rc()?.state] || ['off', '…'];
  return pill(kind, text, busy);
}

async function rcAction(action) {
  const res = await api('POST', '/api/remote-control', { action });
  res.remoteControl.screen ??= state.status?.remoteControl?.screen;
  state.status = { ...state.status, ...res };
  await loadSettings();
  refreshLive();
  setTimeout(poll, 1500);
}

function rcButtons() {
  const r = rc();
  if (!r) return null;
  const lockedOn = r.locked && r.enabled;
  const lockedOff = r.locked && !r.enabled;
  const lockTitle = r.locked ? 'CLAUDE_REMOTE_CONTROL is set in the container environment' : undefined;
  const start = (label = 'Start') =>
    actionButton(label, () => rcAction('start'), { kind: 'primary', busyLabel: 'Starting…', disabled: lockedOff, title: lockTitle });
  const stop = (label = 'Stop') =>
    actionButton(
      label,
      async () => {
        if (r.sessions?.length && !confirm('Stop Remote Control? Sessions running in it stop too.')) return;
        await rcAction('stop');
      },
      { busyLabel: 'Stopping…', disabled: lockedOn, title: lockTitle },
    );
  const restart = (label = 'Restart') => actionButton(label, () => rcAction('restart'), { busyLabel: 'Restarting…' });
  switch (r.state) {
    case 'running':
    case 'starting':
      return [stop(), restart()];
    case 'retrying':
      return [restart('Start now'), stop()];
    case 'failed':
      return [start('Try again'), stop('Turn off')];
    case 'blocked':
      return [stop('Turn off')];
    case 'stopping':
      return [];
    default:
      return [start()];
  }
}

function rcDetails({ full = false } = {}) {
  const r = rc();
  if (!r) return h('p', { class: 'muted' }, 'Loading…');
  const parts = [];
  if (r.state === 'running' && r.url) {
    parts.push(
      h('p', null, 'Open ', ext(r.url, 'claude.ai/code'), ' or the Claude app: this container is listed with a computer icon. Sessions you start there run here, in ', code(ct()?.workspace || '/workspace'), '.'),
    );
  } else if (r.state === 'starting') {
    parts.push(h('p', { class: 'muted' }, 'Connecting to claude.ai…'));
  } else if (r.state === 'off') {
    parts.push(h('p', { class: 'muted' }, 'Turned off. Start it to reach this container from claude.ai/code and the Claude app.'));
  } else if (r.state === 'stopped') {
    parts.push(h('p', { class: 'muted' }, 'Not running.'));
  }
  if (r.state === 'blocked') {
    parts.push(
      alertBox(
        'err',
        h('strong', null, 'Remote Control can’t start:'),
        h('ul', null, r.blockers.map((b) => h('li', null, b))),
        !ct()?.claudeaiLogin && h('div', { class: 'row' }, h('a', { class: 'btn small', href: '#claude' }, 'Sign in to Claude')),
      ),
    );
  }
  if (r.state === 'retrying' && r.retryAt) {
    parts.push(alertBox('warn', `Remote Control exited${exitText(r.lastExit)}. Restarting ${relTime(r.retryAt)}.`));
  }
  if (r.state === 'failed') {
    parts.push(
      alertBox(
        'err',
        `Remote Control kept exiting${exitText(r.lastExit)}, so it isn’t being restarted. `,
        full ? 'The output below shows why.' : h('a', { href: '#remote-control' }, 'See its output'),
      ),
    );
  }
  if (r.restartPending) {
    parts.push(alertBox('info', 'Settings changed since Remote Control started. Restart it to apply them; sessions running now keep the old ones.'));
  }
  if (r.sessions?.length) {
    parts.push(
      h('div', null, h('strong', { class: 'small' }, 'Sessions'), h('ul', { class: 'sessions' }, r.sessions.map((x) => h('li', null, ext(x.url, x.title))))),
    );
  }
  if (r.startedAt) parts.push(h('p', { class: 'hint' }, `Up ${duration(Date.now() - r.startedAt)} · pid ${r.pid}`));
  if (r.locked) parts.push(h('p', { class: 'hint' }, code('CLAUDE_REMOTE_CONTROL'), ' is set in the container environment, so it can’t be turned ', r.enabled ? 'off' : 'on', ' here.'));
  return parts;
}

function exitText(e) {
  if (!e) return '';
  return e.signal ? ` (${e.signal})` : ` (exit code ${e.code})`;
}

const rcKey = () => {
  const r = rc();
  return r && { ...r, screen: undefined, startedAt: r.startedAt && Math.floor((Date.now() - r.startedAt) / 60000), claudeai: ct()?.claudeaiLogin };
};

function rcCard({ full = false } = {}) {
  return card(
    'Remote Control',
    { side: rcPill() },
    h('p', { class: 'muted small' }, 'Drive this container from claude.ai/code and the Claude app.'),
    rcDetails({ full }),
    h('div', { class: 'card-foot' }, rcButtons(), !full && h('a', { class: 'btn link', href: '#remote-control' }, 'Settings and output')),
  );
}

const AUTH_LABELS = {
  'claude.ai': 'Claude account',
  api_key: 'API key',
  oauth_token: 'Long-lived token',
  none: 'Not signed in',
};

function accountLine(c) {
  const a = c?.account;
  if (!a) return null;
  return [h('strong', null, a.email || 'Signed in'), [a.subscriptionType && ` · ${planName(a.subscriptionType)}`, a.orgName && ` · ${a.orgName}`]];
}

function planName(p) {
  return { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', ultra: 'Ultra' }[p] || p;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------
function overviewAlerts() {
  const c = ct();
  const p = st()?.prepare;
  const out = [];
  if (!c) return out;
  if (p?.state === 'failed') {
    out.push(alertBox('err', h('strong', null, 'Applying settings failed'), h('pre', { class: 'output' }, p.output || `exit code ${p.code}`)));
  }
  if (p?.state === 'running') out.push(alertBox('info', 'Applying settings…'));
  if (!c.githubToken) {
    out.push(
      alertBox('info', 'No GitHub token: Claude can’t push branches or open pull requests. ', h('a', { href: '#github' }, 'Add one')),
    );
  }
  if (location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && !httpWarningDismissed()) {
    const box = alertBox(
      'warn',
      h('span', null, 'This page is served over plain HTTP, so your password and tokens cross the network unencrypted. Use it on a private network or VPN, or put HTTPS in front (see ', h('a', { href: '#security' }, 'Security'), ').'),
      h(
        'div',
        { class: 'row' },
        h('button', {
          type: 'button',
          class: 'btn small',
          onclick: () => {
            try {
              localStorage.setItem('claude-sandbox:http-ok', '1');
            } catch {
              // storage unavailable; hide it for this page view only
            }
            box.remove();
          },
        }, 'I’m on a private network, don’t show again'),
      ),
    );
    out.push(box);
  }
  return out;
}

function httpWarningDismissed() {
  try {
    return localStorage.getItem('claude-sandbox:http-ok') === '1';
  } catch {
    return false;
  }
}

function claudeSummary() {
  const c = ct();
  if (!c) return card('Claude', null, h('p', { class: 'muted' }, 'Loading…'));
  const method = c.authMethod;
  const kind = method === 'none' ? 'err' : 'ok';
  return card(
    'Claude',
    { side: pill(kind, AUTH_LABELS[method] || method) },
    kv([
      ['In use', AUTH_LABELS[method] || method],
      c.claudeaiLogin && ['Account', accountLine(c)],
      !c.claudeaiLogin && ['claude.ai login', 'none (needed for Remote Control)'],
      c.apiKey && ['API key', 'set (billed per use; blocks Remote Control)'],
      c.oauthToken && ['Long-lived token', 'set'],
    ]),
    h('div', { class: 'card-foot' }, h('a', { class: 'btn', href: '#claude' }, c.claudeaiLogin || method !== 'none' ? 'Manage sign-in' : 'Sign in')),
  );
}

function githubSummary() {
  const c = ct();
  if (!c) return card('GitHub', null, h('p', { class: 'muted' }, 'Loading…'));
  const tok = s('GH_TOKEN');
  const g = c.git || {};
  return card(
    'GitHub',
    { side: c.githubToken ? pill('ok', 'Token set') : pill('off', 'No token') },
    kv([
      ['Token', c.githubToken ? [h('span', { class: 'mono' }, tok?.hint || 'set'), ' ', sourceBadge(tok)] : 'none'],
      ['Commits as', c.gitIdentity?.name || c.gitIdentity?.email ? `${c.gitIdentity.name || '?'} <${c.gitIdentity.email || '?'}>` : 'not set'],
      ['Workspace', g.repo ? [h('span', { class: 'mono' }, g.branch || '(detached)'), g.remote && [' · ', h('span', { class: 'mono' }, g.remote)]] : 'not a git repository'],
      g.repo && g.commit && ['Last commit', h('span', { class: 'mono' }, g.commit)],
    ]),
    h('div', { class: 'card-foot' }, h('a', { class: 'btn', href: '#github' }, 'Manage GitHub'), h('a', { class: 'btn link', href: '#help' }, 'Token permissions')),
  );
}

function containerCard() {
  const c = ct();
  const w = st()?.webui;
  if (!c || !w) return card('Container', null, h('p', { class: 'muted' }, 'Loading…'));
  const disk = w.disk ? `${bytes(w.disk.free)} free of ${bytes(w.disk.total)}` : null;
  return card(
    'Container',
    { side: pill('ok', 'Up') },
    kv([
      ['Claude Code', c.claudeCode.replace(/\s*\(Claude Code\)/, '')],
      ['Hostname', h('span', { class: 'mono' }, c.hostname)],
      ['User', `${c.user} (uid ${c.uid}, gid ${c.gid})`],
      ['Workspace', [h('span', { class: 'mono' }, c.workspace), disk && h('span', { class: 'muted' }, ` · ${disk}`)]],
      ['Config', h('span', { class: 'mono' }, c.configDir)],
      ['Permission mode', c.permissionMode || 'Claude Code’s default'],
      ['Workspace trust', c.trustWorkspace ? 'pre-trusted' : 'asks'],
      ['sudo', c.sudo ? 'yes (CLAUDE_SUDO)' : 'no'],
      ['Docker', c.docker?.version ? `Docker ${c.docker.version}` : c.docker?.enabled ? 'not running (see /var/log/dockerd.log)' : 'off (compose.docker.yaml turns it on)'],
      ['System', w.os || '—'],
      ['Node.js', w.node],
      ['Web UI', `up ${duration(Date.now() - w.startedAt)} · ${w.tls ? 'HTTPS' : 'HTTP'} · port ${w.port}`],
    ]),
  );
}

const SETTING_PAGES = {
  ANTHROPIC_API_KEY: 'claude',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude',
  GH_TOKEN: 'github',
  GIT_USER_NAME: 'github',
  GIT_USER_EMAIL: 'github',
  GIT_REPO_URL: 'github',
  GIT_REPO_BRANCH: 'github',
};

function settingsTable() {
  if (!state.settings) return null;
  const rows = Object.entries(state.settings).map(([key, item]) => {
    let value;
    if (item.secret) value = item.set ? h('span', { class: 'mono' }, item.hint) : h('span', { class: 'muted' }, 'not set');
    else if (key === 'CLAUDE_REMOTE_CONTROL') value = (item.value || item.default) === '0' ? 'off' : 'on';
    else value = item.value ? h('span', { class: 'mono' }, item.value) : h('span', { class: 'muted' }, item.default ? `${item.default} (default)` : 'not set');
    return h(
      'tr',
      null,
      h('td', null, h('a', { href: `#${SETTING_PAGES[key] || 'remote-control'}` }, item.label)),
      h('td', { class: 'mono small' }, key),
      h('td', null, value),
      h('td', null, sourceBadge(item) || h('span', { class: 'badge' }, 'default')),
    );
  });
  return card(
    'Settings',
    { wide: true },
    h('p', { class: 'muted small' }, 'Variables from the container environment (.env) win over values saved here.'),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Setting', 'Variable', 'Value', 'Source'].map((t) => h('th', null, t)))), h('tbody', null, rows))),
  );
}

function overviewPage() {
  return [
    h('div', { class: 'page-intro' }, h('h1', null, 'Overview')),
    h('div', { class: 'alerts' }, live(() => [st()?.prepare, ct()?.githubToken, st()?.webui?.tls], overviewAlerts)),
    h(
      'div',
      { class: 'grid' },
      live(rcKey, () => rcCard()),
      live(() => [ct()?.authMethod, ct()?.account, ct()?.apiKey, ct()?.oauthToken], claudeSummary),
      live(() => [ct()?.githubToken, ct()?.git, ct()?.gitIdentity, s('GH_TOKEN')], githubSummary),
      live(() => [ct(), st()?.webui && Math.floor((Date.now() - st().webui.startedAt) / 60000), st()?.webui?.disk?.free >> 26], containerCard),
      live(() => state.settings, settingsTable),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
async function loginAction(body) {
  const res = await api('POST', '/api/claude/login', body);
  state.status = { ...state.status, login: res.login };
  refreshLive();
  setTimeout(poll, 800);
}

function loginCard() {
  const c = ct();
  const l = st()?.login || { state: 'idle' };
  const busy = ['starting', 'waiting', 'verifying'].includes(l.state);
  let body;
  if (l.state === 'starting') {
    body = h('p', null, pill('warn', 'Starting sign-in', true));
  } else if (l.state === 'waiting') {
    const codeInput = h('input', { type: 'text', id: 'login-code', class: 'mono-input', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the code here' });
    const finish = actionButton(
      'Finish sign-in',
      async () => {
        if (!codeInput.value.trim()) return codeInput.focus();
        await loginAction({ action: 'code', code: codeInput.value });
      },
      { kind: 'primary', busyLabel: 'Checking…', type: 'submit' },
    );
    body = h(
      'form',
      { onsubmit: (ev) => ev.preventDefault() },
      h(
        'ol',
        { class: 'steps' },
        h(
          'li',
          null,
          h('strong', null, 'Open the sign-in page and approve access'),
          h('div', { class: 'row' }, h('a', { class: 'btn primary', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open claude.com sign-in ↗'), copyButton(l.url, 'Copy link')),
          h('span', { class: 'hint' }, 'Any device works: open the link on your phone if this browser isn’t signed in to Claude.'),
        ),
        h(
          'li',
          null,
          h('label', { for: 'login-code' }, h('strong', null, 'Paste the code it shows')),
          codeInput,
          h('div', { class: 'row' }, finish, actionButton('Cancel', () => loginAction({ action: 'cancel' }), { kind: 'link' })),
        ),
      ),
    );
  } else if (l.state === 'verifying') {
    body = h('p', null, pill('warn', 'Checking the code', true));
  } else {
    const sso = h('input', { type: 'checkbox', id: 'login-sso' });
    const signedIn = c?.claudeaiLogin;
    body = [
      l.state === 'succeeded' && l.finishedAt && Date.now() - l.finishedAt < 120000 && alertBox('ok', 'Signed in.'),
      l.state === 'failed' &&
        alertBox(
          'err',
          h('strong', null, 'Sign-in failed: ', l.error || 'unknown error'),
          l.output && h('details', null, h('summary', null, 'Details'), h('pre', { class: 'output' }, l.output)),
        ),
      signedIn
        ? kv([
            ['Account', accountLine(c)],
            ['Stored in', h('span', { class: 'mono' }, `${c.configDir}/.credentials.json`)],
          ])
        : h('p', null, 'Not signed in. Sign in with a Claude Pro, Max, Ultra, Team or Enterprise account to use your plan and Remote Control.'),
      h('label', { class: 'check' }, sso, 'Use single sign-on (SSO)'),
      h(
        'div',
        { class: 'row' },
        actionButton(signedIn ? 'Sign in again' : 'Sign in with Claude', () => loginAction({ action: 'start', sso: sso.checked }), {
          kind: signedIn ? '' : 'primary',
          busyLabel: 'Starting…',
        }),
        signedIn &&
          actionButton(
            'Sign out',
            async () => {
              if (!confirm('Sign out of Claude in this container? Remote Control stops.')) return;
              await api('POST', '/api/claude/logout');
              toast('ok', 'Signed out');
              await poll();
            },
            { kind: 'danger', busyLabel: 'Signing out…' },
          ),
      ),
    ];
  }
  return card(
    'Claude account',
    { side: busy ? pill('warn', 'Signing in', true) : c?.claudeaiLogin ? pill('ok', 'Signed in') : pill('off', 'Signed out') },
    h('p', { class: 'muted small' }, 'Recommended. Uses your Claude plan, and is the only option that can run Remote Control.'),
    body,
  );
}

function copyButton(text, label = 'Copy') {
  if (!navigator.clipboard) return null; // needs HTTPS or localhost
  return actionButton(label, async () => {
    await navigator.clipboard.writeText(text);
    toast('ok', 'Copied');
  });
}

function claudeInUse() {
  const c = ct();
  if (!c) return null;
  const notes = [];
  if (c.apiKey) notes.push('An API key outranks the Claude account sign-in, and Remote Control can’t start while one is set.');
  if (c.authToken) notes.push('ANTHROPIC_AUTH_TOKEN is set in the container environment and outranks everything here.');
  return alertBox(
    c.authMethod === 'none' ? 'warn' : 'info',
    h('span', null, 'Claude Code in this container uses: ', h('strong', null, AUTH_LABELS[c.authMethod] || c.authMethod), c.claudeaiLogin && c.authMethod === 'claude.ai' ? [' (', accountLine(c), ')'] : null),
    notes.map((n) => h('span', null, n)),
  );
}

function claudePage() {
  return [
    h(
      'div',
      { class: 'page-intro' },
      h('h1', null, 'Claude'),
      h('p', null, 'Choose how Claude Code in this container signs in. You need one of these; the Claude account is the usual choice.'),
    ),
    h('div', { class: 'alerts' }, live(() => [ct()?.authMethod, ct()?.account, ct()?.apiKey, ct()?.authToken], claudeInUse)),
    h(
      'div',
      { class: 'grid' },
      live(() => [st()?.login, ct()?.claudeaiLogin, ct()?.account, st()?.login?.state === 'succeeded' && Date.now() - st().login.finishedAt < 120000], loginCard),
      card(
        'Long-lived token',
        { side: sourceBadge(s('CLAUDE_CODE_OAUTH_TOKEN')) },
        h('p', { class: 'muted small' }, 'Uses your Claude plan for model requests only: no Remote Control. Create one on any machine with ', code('claude setup-token'), '.'),
        settingsForm([{ key: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Token', type: 'secret', placeholder: 'sk-ant-oat01-…' }]),
      ),
      card(
        'API key',
        { side: sourceBadge(s('ANTHROPIC_API_KEY')) },
        h('p', { class: 'muted small' }, 'A Claude Console key, billed per use. While one is set, Remote Control can’t start. Create one at ', ext('https://platform.claude.com/settings/keys', 'platform.claude.com'), '.'),
        settingsForm([{ key: 'ANTHROPIC_API_KEY', label: 'API key', type: 'secret', placeholder: 'sk-ant-api03-…' }]),
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------
function githubTestResult() {
  const t = state.githubTest;
  if (!t) return null;
  if (t.error && !t.kind) return alertBox('err', t.error);
  if (!t.ok) return alertBox('err', h('strong', null, t.error), h('span', null, `Token type: ${t.kind}`));
  const expires = t.expires && new Date(t.expires.replace(' UTC', 'Z').replace(' ', 'T'));
  const rows = [
    ['Signed in as', [h('strong', null, t.login), t.name && ` (${t.name})`]],
    ['Token type', t.kind],
    ['Expires', !t.expires ? 'never' : Number.isNaN(expires.getTime()) ? t.expires : expires.toLocaleDateString(undefined, { dateStyle: 'medium' })],
    t.scopes != null && ['Scopes', t.scopes || 'none'],
  ];
  const items = [alertBox('ok', h('strong', null, 'GitHub accepted the token.'), kv(rows))];
  if (t.repo) {
    items.push(
      t.repo.accessible
        ? alertBox('ok', 'The token can read ', code(t.repo.fullName), t.repo.private ? ' (private).' : '.', t.repo.push === false ? ' It has no push access there.' : '')
        : alertBox(
            'warn',
            'The token can’t see ',
            code(t.repo.fullName),
            '. For a fine-grained token, add that repository under “Repository access” and check the resource owner.',
          ),
    );
  }
  if (t.kind === 'classic' && t.scopes != null && !/\brepo\b/.test(t.scopes)) {
    items.push(alertBox('warn', 'This classic token has no ', code('repo'), ' scope, so it can’t push to private repositories.'));
  }
  return items;
}

function githubPage() {
  const testOut = h('div', { class: 'stack' }, githubTestResult());
  const tokenSet = s('GH_TOKEN')?.set;
  return [
    h(
      'div',
      { class: 'page-intro' },
      h('h1', null, 'GitHub'),
      h(
        'p',
        null,
        'A token lets Claude clone private repositories, push branches and open pull requests with ',
        code('gh'),
        '. Not sure what to grant? ',
        h('a', { href: '#help' }, 'See which permissions to configure'),
        '.',
      ),
    ),
    h(
      'div',
      { class: 'grid' },
      card(
        'Access token',
        { side: sourceBadge(s('GH_TOKEN')) },
        settingsForm(
          [
            {
              key: 'GH_TOKEN',
              label: 'Personal access token',
              type: 'secret',
              placeholder: 'github_pat_… or ghp_…',
              hint: 'Used by gh, and by git for https://github.com remotes. New Remote Control sessions get it after a restart.',
            },
          ],
          { onSaved: () => (state.githubTest = null) },
        ),
        tokenSet &&
          h(
            'div',
            { class: 'row' },
            actionButton(
              'Test token',
              async () => {
                try {
                  state.githubTest = await api('POST', '/api/github/test');
                } catch (err) {
                  state.githubTest = { error: err.message };
                }
                testOut.replaceChildren(...[githubTestResult()].flat().filter(Boolean));
              },
              { busyLabel: 'Testing…' },
            ),
          ),
        testOut,
      ),
      card(
        'Commit identity',
        null,
        settingsForm([
          { key: 'GIT_USER_NAME', label: 'Name', placeholder: 'Ada Lovelace' },
          {
            key: 'GIT_USER_EMAIL',
            label: 'Email',
            type: 'email',
            placeholder: 'you@example.com',
            hint: 'Keeping your email private on GitHub? Use your noreply address, ID+username@users.noreply.github.com, or pushes may be refused.',
          },
        ]),
      ),
      card(
        'Repository',
        null,
        h('p', { class: 'muted small' }, 'Cloned into ', code(ct()?.workspace || '/workspace'), ' when it’s empty: right after you save, and on every start.'),
        settingsForm([
          { key: 'GIT_REPO_URL', label: 'Repository URL', type: 'url', mono: true, placeholder: 'https://github.com/you/project.git', hint: 'Use the https:// URL: the token doesn’t work for git@github.com SSH URLs.' },
          { key: 'GIT_REPO_BRANCH', label: 'Branch', mono: true, placeholder: 'default branch' },
        ]),
        live(() => [ct()?.git, st()?.prepare], workspaceInfo),
      ),
    ),
  ];
}

function workspaceInfo() {
  const g = ct()?.git;
  const p = st()?.prepare;
  return [
    h('h3', null, 'Workspace now'),
    g?.repo
      ? kv([
          ['Branch', h('span', { class: 'mono' }, g.branch || '(detached)')],
          ['Remote', g.remote ? h('span', { class: 'mono' }, g.remote) : 'none'],
          ['Last commit', g.commit ? h('span', { class: 'mono' }, g.commit) : '—'],
        ])
      : h('p', { class: 'muted' }, 'Not a git repository.'),
    p?.state === 'running' && alertBox('info', 'Applying settings…'),
    p?.state === 'failed' && alertBox('err', h('strong', null, 'Applying settings failed'), h('pre', { class: 'output' }, p.output || `exit code ${p.code}`)),
  ];
}

// ---------------------------------------------------------------------------
// Remote Control
// ---------------------------------------------------------------------------
function rcScreen() {
  const text = rc()?.screen;
  const pre = h('pre', { class: 'screen', tabindex: '0', 'aria-label': 'Remote Control output' }, text || 'No output yet.');
  requestAnimationFrame(() => {
    pre.scrollTop = pre.scrollHeight;
  });
  return pre;
}

function remoteControlPage() {
  return [
    h(
      'div',
      { class: 'page-intro' },
      h('h1', null, 'Remote Control'),
      h(
        'p',
        null,
        'Remote Control registers this container with your Claude account, so you can start and continue sessions from ',
        ext('https://claude.ai/code', 'claude.ai/code'),
        ' and the Claude app. Code runs here; the conversation is stored by Anthropic.',
      ),
    ),
    h(
      'div',
      { class: 'grid' },
      live(rcKey, () => rcCard({ full: true })),
      card(
        'Settings',
        null,
        settingsForm(
          [
            { key: 'CLAUDE_RC_NAME', label: 'Name', placeholder: `${state.session.hostname}-… (automatic)`, hint: 'How the container appears in the session list.' },
            {
              key: 'CLAUDE_RC_SPAWN',
              label: 'New sessions',
              type: 'select',
              options: [
                ['same-dir', 'Share the workspace (same-dir, default)'],
                ['worktree', 'Own git worktree each (worktree)'],
                ['session', 'One session, then exit (session)'],
              ],
              hint: 'worktree needs a git repository in the workspace.',
            },
            { key: 'CLAUDE_RC_CAPACITY', label: 'Maximum sessions at once', type: 'number', min: '1', max: '100', placeholder: '32' },
            {
              key: 'CLAUDE_PERMISSION_MODE',
              label: 'Permission mode',
              type: 'select',
              options: [
                ['', 'Claude Code’s default'],
                ['default', 'Ask before edits and commands (default)'],
                ['acceptEdits', 'Accept file edits (acceptEdits)'],
                ['auto', 'Auto mode (auto)'],
                ['plan', 'Plan only (plan)'],
                ['dontAsk', 'Don’t ask; deny what isn’t allowed (dontAsk)'],
                ['bypassPermissions', 'Skip all permission checks (bypassPermissions)'],
              ],
              hint: 'Also used by docker compose exec claude claude. bypassPermissions is reasonable here only for trusted repositories.',
            },
          ],
          { note: h('p', { class: 'hint' }, 'Changes apply when Remote Control restarts.') },
        ),
      ),
      card(
        'Output',
        { wide: true, side: h('span', { class: 'hint' }, 'What Remote Control prints, as its status screen shows it') },
        live(() => rc()?.screen, rcScreen),
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------
const FINE_GRAINED_NEW = 'https://github.com/settings/personal-access-tokens/new';
function tokenLink(params) {
  const q = new URLSearchParams({
    name: 'Claude Code sandbox',
    description: 'Used by Claude Code in the claude-sandbox container',
    expires_in: '90',
    ...params,
  });
  return `${FINE_GRAINED_NEW}?${q}`;
}

function helpPage() {
  const perm = (name, access, needed, why) => h('tr', null, h('td', { class: 'nowrap' }, h('strong', null, name)), h('td', { class: 'nowrap' }, access), h('td', { class: 'nowrap' }, needed), h('td', null, why));
  return [
    h('div', { class: 'page-intro' }, h('h1', null, 'Help'), h('p', null, 'Which GitHub token to create and what to grant, plus how sign-in and settings work here.')),
    h(
      'div',
      { class: 'stack' },
      card(
        'GitHub token: what to grant',
        { wide: true },
        h(
          'div',
          { class: 'prose' },
          h(
            'p',
            null,
            'Use a ',
            h('strong', null, 'fine-grained personal access token'),
            ' limited to the repositories Claude should work on. Anything Claude runs in this container can read the token, so give it only what Claude needs.',
          ),
          h(
            'div',
            { class: 'row' },
            ext(tokenLink({ contents: 'write', pull_requests: 'write', issues: 'read', actions: 'read', statuses: 'read' }), 'Create the recommended token ↗'),
            h('span', { class: 'muted small' }, 'or'),
            ext(tokenLink({ contents: 'write', pull_requests: 'write', issues: 'read', actions: 'read', statuses: 'read', workflows: 'write' }), 'the same, plus workflow files ↗'),
            h('span', { class: 'muted small' }, 'or'),
            ext(tokenLink({ contents: 'read', pull_requests: 'read', issues: 'read', actions: 'read', statuses: 'read' }), 'read-only ↗'),
          ),
          h('p', { class: 'hint' }, 'The links open GitHub’s form with the permissions below filled in. You still choose the owner and repositories.'),
          h('h3', null, 'On the form'),
          h(
            'ol',
            null,
            h('li', null, h('strong', null, 'Resource owner'), ': your account, or the organization that owns the repositories.'),
            h('li', null, h('strong', null, 'Expiration'), ': 90 days is a good balance. “Test token” on the GitHub page shows the date.'),
            h('li', null, h('strong', null, 'Repository access'), ': “Only select repositories”, then pick them.'),
            h('li', null, h('strong', null, 'Repository permissions'), ': as in the table. Leave account and organization permissions at “No access”.'),
            h('li', null, 'Generate the token, copy it (GitHub shows it once), and paste it on the ', h('a', { href: '#github' }, 'GitHub page'), '.'),
          ),
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              null,
              h('thead', null, h('tr', null, h('th', null, 'Permission'), h('th', null, 'Access'), h('th', null, 'Needed?'), h('th', null, 'What Claude uses it for'))),
              h(
                'tbody',
                null,
                perm('Metadata', 'Read-only', 'Required', 'Selected automatically. Lets the token see the repository at all.'),
                perm('Contents', 'Read and write', 'Required', [
                  'Clone and pull, commit, push branches. Read-only if Claude should never push.',
                ]),
                perm('Pull requests', 'Read and write', 'Recommended', ['Open, update and comment on pull requests: ', code('gh pr create'), ', ', code('gh pr view'), '.']),
                perm('Issues', 'Read-only', 'Recommended', ['Read issues you point Claude at (', code('gh issue view'), '). Read and write lets it comment on and close them.']),
                perm('Actions', 'Read-only', 'Recommended', ['See CI runs and their logs: ', code('gh run list'), ', ', code('gh run view --log-failed'), '.']),
                perm('Commit statuses', 'Read-only', 'Optional', 'See status checks that services report on commits.'),
                perm('Workflows', 'Read and write', 'Only if needed', [
                  'GitHub refuses pushes that change files in ',
                  code('.github/workflows/'),
                  ' without it. Grant it only if Claude should edit your CI.',
                ]),
              ),
            ),
          ),
          h(
            'p',
            null,
            h('strong', null, 'Don’t grant'),
            ' Administration, Secrets, Variables, Environments, Deployments, Webhooks or Pages: Claude doesn’t need them, and they reach beyond the code.',
          ),
          h('h3', null, 'Limits of fine-grained tokens'),
          h(
            'ul',
            null,
            h('li', null, 'They can’t call GitHub’s Checks API, so ', code('gh pr checks'), ' may miss check runs. With Actions: Read-only, Claude can still read CI with ', code('gh run view'), '.'),
            h('li', null, 'They don’t work for repositories where you’re an outside collaborator, for public repositories of organizations you don’t belong to, or across several organizations at once. Use a classic token for those.'),
            h('li', null, 'If the organization requires approval, the token stays “pending” and can only read public repositories until an owner approves it.'),
          ),
          h('h3', null, 'Classic token instead'),
          h(
            'p',
            null,
            'Scopes: ',
            code('repo'),
            ' (or ',
            code('public_repo'),
            ' for public repositories only), plus ',
            code('workflow'),
            ' to edit workflow files and ',
            code('read:org'),
            ' for gh features that look up organization teams. A classic token reaches every repository you can, so prefer fine-grained when you can. ',
            ext('https://github.com/settings/tokens/new?scopes=repo,read:org&description=Claude+Code+sandbox', 'Create a classic token ↗'),
          ),
          h('h3', null, 'Also'),
          h(
            'ul',
            null,
            h('li', null, 'Use https:// remotes. The token is wired up as git’s credential helper for https://github.com; SSH remotes need keys this container doesn’t have.'),
            h('li', null, 'Set a commit name and email on the GitHub page. With a private email on GitHub, use your noreply address.'),
            h('li', null, 'If a token leaks, revoke it at ', ext('https://github.com/settings/personal-access-tokens', 'github.com/settings/personal-access-tokens'), '.'),
          ),
          h('p', { class: 'hint' }, 'Sources: GitHub Docs, ', ext('https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens', 'Managing your personal access tokens'), ' and ', ext('https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens', 'Permissions required for fine-grained tokens'), '.'),
        ),
      ),
      card(
        'Claude sign-in options',
        { wide: true },
        h(
          'div',
          { class: 'prose' },
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              null,
              h('thead', null, h('tr', null, ['Option', 'Billing', 'Remote Control', 'How'].map((t) => h('th', null, t)))),
              h(
                'tbody',
                null,
                h('tr', null, h('td', null, h('strong', null, 'Claude account')), h('td', null, 'Your Claude plan'), h('td', null, 'Yes'), h('td', null, 'Claude page → Sign in with Claude')),
                h('tr', null, h('td', null, h('strong', null, 'Long-lived token')), h('td', null, 'Your Claude plan'), h('td', null, 'No'), h('td', null, code('claude setup-token'), ' on any machine, then paste it')),
                h('tr', null, h('td', null, h('strong', null, 'API key')), h('td', null, 'Per use (Claude Console)'), h('td', null, 'No'), h('td', null, 'Paste a Console key')),
              ),
            ),
          ),
          h('p', null, 'An API key outranks the Claude account sign-in. On Team and Enterprise plans an Owner must allow Remote Control in the Claude Code admin settings.'),
        ),
      ),
      card(
        'Where settings live',
        { wide: true },
        h(
          'div',
          { class: 'prose' },
          h(
            'ul',
            null,
            h('li', null, 'Saved settings are in ', code('/home/claude/.claude/claude-sandbox/settings.json'), ' in the claude-config volume (readable only by the claude user), so they survive restarts and image updates.'),
            h('li', null, 'A variable set in the container environment (your .env file or compose.yaml) wins and shows here as “from environment”.'),
            h('li', null, code('docker compose exec claude claude'), ' picks up saved settings right away. A running Remote Control keeps the ones it started with until you restart it.'),
            h('li', null, 'Git identity is applied at once. A repository URL is cloned as soon as you save it, if the workspace is empty.'),
          ),
        ),
      ),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
function securityPage() {
  const fromEnv = st()?.webui?.passwordSource === 'environment' || state.session.passwordSource === 'environment';
  let pwCard;
  if (fromEnv) {
    pwCard = card('Web UI password', null, h('p', null, 'The password comes from ', code('CLAUDE_WEBUI_PASSWORD'), ' in the container environment. Change it there and recreate the container.'));
  } else {
    const current = h('input', { type: 'password', id: 'pw-current', autocomplete: 'current-password', required: true });
    const { fields, pw, validate } = passwordFields(state.session.minPassword);
    const msg = h('div', { class: 'form-msg' });
    const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Change password');
    pwCard = card(
      'Web UI password',
      null,
      h(
        'form',
        {
          onsubmit: async (ev) => {
            ev.preventDefault();
            msg.replaceChildren();
            const problem = validate();
            if (problem) return msg.replaceChildren(alertBox('err', problem));
            submit.disabled = true;
            try {
              await api('POST', '/api/password', { current: current.value, password: pw.value });
              toast('ok', 'Password changed. Other browsers were signed out.');
              renderShell();
            } catch (err) {
              msg.replaceChildren(alertBox('err', err.message));
              submit.disabled = false;
            }
          },
        },
        h('div', { class: 'field' }, h('label', { for: 'pw-current' }, 'Current password'), current),
        fields,
        msg,
        h('div', { class: 'row' }, submit),
      ),
    );
  }
  const port = st()?.webui?.port || 8765;
  return [
    h('div', { class: 'page-intro' }, h('h1', null, 'Security')),
    h(
      'div',
      { class: 'grid' },
      pwCard,
      card(
        'Keep this page private',
        null,
        h(
          'div',
          { class: 'prose' },
          h(
            'ul',
            null,
            h('li', null, 'This page can sign in to Claude, change tokens and start Remote Control, so treat its password like the tokens themselves.'),
            h('li', null, 'Over plain HTTP the password and tokens cross the network unencrypted. Reach it over a private network or VPN, put HTTPS in front of it, or set ', code('CLAUDE_WEBUI_TLS_CERT'), ' and ', code('CLAUDE_WEBUI_TLS_KEY'), '.'),
            h('li', null, 'To accept connections from this machine only, set ', code(`CLAUDE_SANDBOX_WEBUI_PORT=127.0.0.1:${port}`), ' in .env and reach it through an SSH tunnel.'),
            h('li', null, 'After 5 wrong passwords, an address is refused for 15 minutes.'),
            h('li', null, 'Code Claude runs in the container can read saved tokens. Use narrowly scoped ones.'),
          ),
        ),
        h('div', { class: 'card-foot' }, actionButton('Sign out of the web UI', signOutWebUi)),
      ),
    ),
  ];
}

const PAGE_RENDERERS = {
  overview: overviewPage,
  claude: claudePage,
  github: githubPage,
  'remote-control': remoteControlPage,
  help: helpPage,
  security: securityPage,
};

boot();
