// Web UI for the Claude Code sandbox (see README.md, "Web UI").
//
// Started by `claude-sandbox server` as the unprivileged `claude` user. It:
//   - asks for a password (CLAUDE_WEBUI_PASSWORD, or one created on first visit
//     with the setup code printed in the container log),
//   - saves settings to $CLAUDE_CONFIG_DIR/claude-sandbox/settings.json, which
//     the entrypoint loads (the container's own environment always wins),
//   - drives `claude auth login` so you can sign in from the browser,
//   - runs `claude-sandbox remote-control` as a child process and restarts it
//     when it exits, so Remote Control can be turned on and off from here.
//
// No dependencies beyond Node.js itself.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const env = process.env;
const PORT = Number.parseInt(env.CLAUDE_WEBUI_PORT || '8765', 10);
const HOST = env.CLAUDE_WEBUI_HOST || undefined; // all interfaces, IPv6 too when available
const ENTRYPOINT = env.CLAUDE_SANDBOX_ENTRYPOINT || '/usr/local/bin/claude-sandbox';
const REAL_CLAUDE = '/usr/local/lib/claude-code/claude';
const CONFIG_DIR = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const WORKDIR = env.CLAUDE_WORKDIR || '/workspace';
const STATE_DIR = path.join(CONFIG_DIR, 'claude-sandbox');
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const AUTH_FILE = path.join(STATE_DIR, 'webui-auth.json');
const SETUP_CODE_FILE = path.join(STATE_DIR, 'setup-code');
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const RC_ARGS = process.argv.slice(2); // extra arguments given to `server`

const MIN_PASSWORD = 12;
const SESSION_IDLE_MS = 12 * 3600_000;
const SESSION_MAX_MS = 7 * 24 * 3600_000;
const STATUS_TTL_MS = 10_000;
const COOKIE = 'claude_sandbox_session';

const log = (msg) => process.stderr.write(`[claude-sandbox] web UI: ${msg}\n`);

// The password must not reach Remote Control or anything Claude runs.
const envPassword = env.CLAUDE_WEBUI_PASSWORD || '';
delete env.CLAUDE_WEBUI_PASSWORD;

const isTrue = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ''));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Settings (keep the names in sync with docker/settings.sh)
// ---------------------------------------------------------------------------
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const check = {
  text: (max) => (v) => (v.length > max ? `must be at most ${max} characters` : CONTROL_CHARS.test(v) ? 'must be a single line' : null),
  token: (v) => (/^[\x21-\x7e]{8,1024}$/.test(v) ? null : 'must be a single word of printable characters, with no spaces'),
  email: (v) => (v.length <= 254 && /^[^\s@<>]+@[^\s@<>]+$/.test(v) ? null : 'is not an email address'),
  oneOf: (...values) => (v) => (values.includes(v) ? null : `must be one of ${values.join(', ')}`),
  int: (min, max) => (v) => (/^\d+$/.test(v) && +v >= min && +v <= max ? null : `must be a whole number from ${min} to ${max}`),
  repoUrl: (v) => {
    if (v.length > 2048 || /\s/.test(v) || CONTROL_CHARS.test(v)) return 'is not a git URL';
    if (/^https?:\/\/[^/]*@/.test(v)) return 'must not contain a user name or token: save the token as the GitHub token instead';
    if (/^https?:\/\/[^/]+\/.+/.test(v) || /^ssh:\/\/[^/]+\/.+/.test(v) || /^[\w.-]+@[\w.-]+:[^:].*/.test(v)) return null;
    return 'must be an https://, ssh:// or user@host:path URL';
  },
  branch: (v) => (/^(?!-)(?!.*\.\.)[\w./-]{1,200}$/.test(v) ? null : 'is not a branch or tag name'),
};

const SETTINGS = {
  ANTHROPIC_API_KEY: { label: 'API key', secret: true, check: check.token },
  CLAUDE_CODE_OAUTH_TOKEN: { label: 'Long-lived token', secret: true, check: check.token },
  GH_TOKEN: { label: 'GitHub token', secret: true, check: check.token, alsoEnv: 'GITHUB_TOKEN' },
  GIT_USER_NAME: { label: 'Commit name', check: check.text(100) },
  GIT_USER_EMAIL: { label: 'Commit email', check: check.email },
  GIT_REPO_URL: { label: 'Repository URL', check: check.repoUrl },
  GIT_REPO_BRANCH: { label: 'Branch', check: check.branch },
  CLAUDE_REMOTE_CONTROL: { label: 'Remote Control', check: check.oneOf('0', '1'), default: '1' },
  CLAUDE_RC_NAME: { label: 'Session name', check: check.text(80) },
  CLAUDE_RC_SPAWN: { label: 'Spawn mode', check: check.oneOf('same-dir', 'worktree', 'session'), default: 'same-dir' },
  CLAUDE_RC_CAPACITY: { label: 'Capacity', check: check.int(1, 100), default: '32' },
  CLAUDE_PERMISSION_MODE: {
    label: 'Permission mode',
    check: check.oneOf('default', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'),
  },
};
// Changing these doesn't reach a running Remote Control: its sessions keep the
// environment it started with. Git identity and the repository are applied by
// `claude-sandbox prepare` instead.
const RESTART_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN',
  'CLAUDE_RC_NAME', 'CLAUDE_RC_SPAWN', 'CLAUDE_RC_CAPACITY', 'CLAUDE_PERMISSION_MODE',
]);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function savedSettings() {
  const saved = readJson(SETTINGS_FILE, {});
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
}

// This process got the container's own environment (the entrypoint removed the
// saved values it had loaded), so anything set here came from Compose or `-e`.
function envValue(key) {
  const meta = SETTINGS[key];
  return env[key] || (meta.alsoEnv && env[meta.alsoEnv]) || '';
}

function effectiveValue(key) {
  return envValue(key) || savedSettings()[key] || '';
}

function maskSecret(value) {
  const prefix = /^(sk-ant-[a-z]+\d*-|github_pat_|gh[pousr]_)/.exec(value)?.[0] ?? '';
  return `${prefix}…${value.slice(-4)}`;
}

function describeSettings() {
  const saved = savedSettings();
  return Object.fromEntries(
    Object.entries(SETTINGS).map(([key, meta]) => {
      const fromEnv = envValue(key);
      const value = fromEnv || saved[key] || '';
      const item = {
        label: meta.label,
        source: fromEnv ? 'environment' : value ? 'saved' : 'default',
        locked: Boolean(fromEnv),
        set: Boolean(value),
        default: meta.default ?? '',
        secret: Boolean(meta.secret),
      };
      if (fromEnv && meta.alsoEnv && !env[key]) item.envName = meta.alsoEnv;
      if (meta.secret) item.hint = value ? maskSecret(value) : '';
      else item.value = value;
      return [key, item];
    }),
  );
}

function saveSettings(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw httpError(400, 'Expected an object of settings');
  const saved = savedSettings();
  const next = { ...saved };
  const errors = {};
  for (const [key, raw] of Object.entries(values)) {
    const meta = SETTINGS[key];
    if (!meta) {
      errors[key] = 'is not a setting the web UI manages';
    } else if (envValue(key)) {
      errors[key] = `is set in the container environment (${env[key] ? key : meta.alsoEnv}); change it there`;
    } else if (raw === null || raw === '') {
      delete next[key];
    } else if (typeof raw !== 'string') {
      errors[key] = 'must be text';
    } else {
      const value = raw.trim();
      const problem = meta.check(value);
      if (problem) errors[key] = `${meta.label} ${problem}`;
      else next[key] = value;
    }
  }
  if (Object.keys(errors).length) throw httpError(400, Object.values(errors).join('; '), { errors });
  const changed = Object.keys(SETTINGS).filter((k) => (saved[k] ?? '') !== (next[k] ?? ''));
  if (changed.length) writePrivate(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return changed;
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------
function childEnv(extra = {}) {
  return { ...env, ...extra };
}

function withoutTokens(e) {
  const copy = { ...e };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete copy[k];
  return copy;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const stripAnsi = (s) => s.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');

// For children started with `detached: true`: the entrypoint runs some commands
// as its own children rather than exec'ing them, so signal the whole group.
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function capture(cmd, args, { timeout = 60_000, childEnvironment = childEnv() } = {}) {
  return new Promise((resolve) => {
    let output = '';
    let done = false;
    const child = spawn(cmd, args, { cwd: WORKDIR, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => stdout.push(d));
    child.stderr.on('data', (d) => {
      output = (output + d.toString()).slice(-16_000);
    });
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: error ? String(error) : output });
    };
    child.on('error', (err) => finish(-1, err));
    child.on('close', (code) => finish(code ?? -1));
  });
}

// ---------------------------------------------------------------------------
// Container status (from `claude-sandbox status --json`, cached briefly)
// ---------------------------------------------------------------------------
const statusCache = { at: 0, seq: 0, value: null, pending: null };
let statusSeq = 0;

function invalidateStatus() {
  statusCache.at = 0;
  statusCache.pending = null; // a check already running may predate the change
}

function containerStatus({ fresh = false } = {}) {
  if (!fresh && statusCache.value && Date.now() - statusCache.at < STATUS_TTL_MS) return Promise.resolve(statusCache.value);
  if (!fresh && statusCache.pending) return statusCache.pending;
  const seq = ++statusSeq;
  const pending = capture(ENTRYPOINT, ['status', '--json'], { timeout: 30_000 })
    .then((r) => {
      let value = null;
      try {
        value = JSON.parse(r.stdout);
      } catch {
        log(`could not read the container status: ${r.stderr.trim().split('\n').pop() || `exit ${r.code}`}`);
      }
      if (value && seq > statusCache.seq) Object.assign(statusCache, { value, seq, at: Date.now() });
      return value ?? statusCache.value;
    })
    .finally(() => {
      if (statusCache.pending === pending) statusCache.pending = null;
    });
  statusCache.pending = pending;
  return pending;
}

function osRelease() {
  try {
    return /^PRETTY_NAME="?([^"\n]*)"?/m.exec(fs.readFileSync('/etc/os-release', 'utf8'))?.[1] ?? '';
  } catch {
    return '';
  }
}

function diskFree(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Remote Control output: a tiny terminal that understands what the status
// screen uses (newlines, cursor up, erase below, OSC 8 links), so the page can
// show the current screen instead of every redraw.
// ---------------------------------------------------------------------------
class Screen {
  constructor(maxLines = 400) {
    this.maxLines = maxLines;
    this.lines = [''];
    this.links = [[]];
    this.row = 0;
    this.col = 0;
    this.pending = '';
    this.link = null;
    this.runStart = 0; // first line of the current run; the URL and links come from there on
  }

  beginRun(banner) {
    this.mark(banner);
    this.links = this.links.map(() => []);
    this.runStart = this.row;
  }

  write(chunk) {
    const s = this.pending + chunk;
    this.pending = '';
    const csi = /\x1b\[([0-?]*)[ -/]*([@-~])/y;
    const osc = /\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)/y;
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\x1b') {
        if (i + 1 >= s.length) {
          this.pending = s.slice(i);
          return;
        }
        const re = s[i + 1] === '[' ? csi : s[i + 1] === ']' ? osc : null;
        if (!re) {
          i += 2;
          continue;
        }
        re.lastIndex = i;
        const m = re.exec(s);
        if (!m) {
          if (s.length - i < 4096) this.pending = s.slice(i); // incomplete; wait for more
          return;
        }
        if (re === csi) this.csi(m[1], m[2]);
        else this.osc(m[1]);
        i = re.lastIndex;
        continue;
      }
      if (ch === '\n') this.newline();
      else if (ch === '\r') this.col = 0;
      else if (ch === '\b') this.col = Math.max(0, this.col - 1);
      else if (ch === '\t') this.put(' '.repeat(8 - (this.col % 8)));
      else if (ch >= ' ' && ch !== '\x7f') this.put(ch);
      i++;
    }
  }

  put(text) {
    const line = this.lines[this.row];
    this.lines[this.row] =
      this.col >= line.length
        ? line.padEnd(this.col) + text
        : line.slice(0, this.col) + text + line.slice(this.col + text.length);
    this.col += text.length;
    if (this.link) this.link.text += text;
  }

  newline() {
    this.row++;
    this.col = 0;
    if (this.row >= this.lines.length) {
      this.lines.push('');
      this.links.push([]);
    }
    const extra = this.lines.length - this.maxLines;
    if (extra > 0) {
      this.lines.splice(0, extra);
      this.links.splice(0, extra);
      this.row -= extra;
      this.runStart = Math.max(0, this.runStart - extra);
    }
  }

  csi(params, final) {
    const n = Number.parseInt(params, 10) || 1;
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - n);
        break;
      case 'B':
        this.row = Math.min(this.lines.length - 1, this.row + n);
        break;
      case 'C':
        this.col += n;
        break;
      case 'D':
        this.col = Math.max(0, this.col - n);
        break;
      case 'G':
        this.col = n - 1;
        break;
      case 'J': // erase below (all modes treated alike: the status screen only uses 0)
        this.lines[this.row] = this.lines[this.row].slice(0, this.col);
        if (this.col === 0) this.links[this.row] = [];
        this.lines.length = this.row + 1;
        this.links.length = this.row + 1;
        break;
      case 'K':
        if (params === '2') this.lines[this.row] = '';
        else if (params === '1') this.lines[this.row] = ' '.repeat(this.col) + this.lines[this.row].slice(this.col);
        else this.lines[this.row] = this.lines[this.row].slice(0, this.col);
        if (params === '2' || this.col === 0) this.links[this.row] = [];
        break;
      default: // colours and anything else: ignore
    }
  }

  osc(body) {
    if (!body.startsWith('8;')) return;
    const uri = body.slice(body.indexOf(';', 2) + 1);
    if (uri) {
      this.link = { url: uri, text: '' };
    } else if (this.link) {
      if (/^https:\/\//.test(this.link.url)) this.links[this.row].push(this.link);
      this.link = null;
    }
  }

  mark(text) {
    if (this.lines[this.row] !== '') this.newline();
    this.put(text);
    this.newline();
  }

  text(maxLines = 300) {
    const lines = this.lines.slice(-maxLines);
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  }

  environmentUrl() {
    for (let r = this.lines.length - 1; r >= this.runStart; r--) {
      const m = /https:\/\/[^\s]+\/code\?environment=[\w-]+/.exec(this.lines[r]);
      if (m) return m[0];
    }
    return null;
  }

  sessionLinks() {
    const seen = new Map();
    for (const link of this.links.flat()) seen.set(link.url, link.text.trim() || link.url);
    return [...seen].slice(-20).map(([url, title]) => ({ url, title }));
  }
}

// ---------------------------------------------------------------------------
// Remote Control supervisor
// ---------------------------------------------------------------------------
const rc = {
  child: null,
  startedAt: null,
  stopping: null, // promise while a stop is in progress
  lastExit: null,
  quickFailures: 0, // consecutive runs that ended within a minute
  gaveUp: false,
  retryAt: null,
  retryTimer: null,
  restartPending: false,
  screen: new Screen(),
};
const RETRY_DELAYS_S = [5, 15, 30, 60, 120];
const MAX_QUICK_FAILURES = 6;
let shuttingDown = false;

function clearRetry() {
  clearTimeout(rc.retryTimer);
  rc.retryTimer = null;
  rc.retryAt = null;
}

function startRemoteControl() {
  clearRetry();
  rc.restartPending = false;
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  rc.screen.beginRun(`── Remote Control starting (${time}) ──`);
  log('starting Remote Control');
  const child = spawn(ENTRYPOINT, ['remote-control', ...RC_ARGS], {
    cwd: WORKDIR,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'], // stdin stays open but unused
    detached: true, // own process group, so a stop can take its sessions with it
  });
  rc.child = child;
  rc.startedAt = Date.now();
  for (const stream of [child.stdout, child.stderr]) {
    const decoder = new StringDecoder('utf8');
    stream.on('data', (d) => {
      process.stdout.write(d); // keeps `docker attach` and `docker compose logs` working
      rc.screen.write(decoder.write(d));
    });
  }
  child.stdin.on('error', () => {});
  child.on('error', (err) => {
    rc.screen.mark(`could not start Remote Control: ${err.message}`);
    if (child.pid === undefined) onRemoteControlExit(child, -1, null); // never spawned: no 'exit' follows
  });
  child.on('exit', (code, signal) => onRemoteControlExit(child, code, signal));
}

function onRemoteControlExit(child, code, signal) {
  if (rc.child !== child) return;
  const ranMs = Date.now() - rc.startedAt;
  rc.child = null;
  rc.lastExit = { code, signal, at: Date.now(), ranMs };
  rc.screen.mark(`── Remote Control exited (${signal ?? `code ${code}`}) ──`);
  invalidateStatus();
  if (rc.stopping || shuttingDown) return;
  log(`Remote Control exited (${signal ?? `code ${code}`}) after ${Math.round(ranMs / 1000)}s`);
  rc.quickFailures = ranMs < 60_000 ? rc.quickFailures + 1 : 0;
  if (rc.quickFailures >= MAX_QUICK_FAILURES) {
    rc.gaveUp = true;
    log('Remote Control keeps exiting; not restarting it until you start it again from the web UI');
    return;
  }
  const delay = rc.quickFailures === 0 ? 2 : RETRY_DELAYS_S[Math.min(rc.quickFailures - 1, RETRY_DELAYS_S.length - 1)];
  rc.retryAt = Date.now() + delay * 1000;
  rc.retryTimer = setTimeout(() => {
    rc.retryTimer = null;
    rc.retryAt = null;
    reconcile({ fresh: true });
  }, delay * 1000);
}

function stopRemoteControl(graceMs = 15_000) {
  clearRetry();
  const child = rc.child;
  if (!child) return Promise.resolve();
  if (rc.stopping) return rc.stopping;
  log('stopping Remote Control');
  rc.stopping = new Promise((resolve) => {
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => killGroup('SIGKILL'), graceMs);
    child.once('exit', () => {
      clearTimeout(timer);
      setTimeout(() => killGroup('SIGKILL'), 2000).unref(); // stragglers in the group
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      resolve();
    }
  }).finally(() => {
    rc.stopping = null;
    rc.quickFailures = 0;
  });
  return rc.stopping;
}

let reconciling = false;
let reconcileAgain = false;

// Start or stop Remote Control so it matches its setting and what's possible.
async function reconcile({ fresh = true } = {}) {
  if (reconciling) {
    reconcileAgain = true;
    return;
  }
  reconciling = true;
  try {
    do {
      reconcileAgain = false;
      if (shuttingDown) return;
      const st = await containerStatus({ fresh });
      const info = st?.remoteControl;
      if (!info) return;
      const wanted = info.enabled && info.blockers.length === 0;
      if (!wanted) {
        clearRetry();
        if (rc.child) await stopRemoteControl();
      } else if (!rc.child && !rc.stopping && !rc.retryTimer && !rc.gaveUp && !loginJob.child) {
        startRemoteControl();
      }
    } while (reconcileAgain);
  } finally {
    reconciling = false;
  }
}

function remoteControlView(st, withScreen) {
  const info = st?.remoteControl ?? { enabled: false, blockers: [] };
  let state;
  if (rc.stopping) state = 'stopping';
  else if (rc.child) state = rc.screen.environmentUrl() || Date.now() - rc.startedAt > 20_000 ? 'running' : 'starting';
  else if (!info.enabled) state = 'off';
  else if (info.blockers.length) state = 'blocked';
  else if (rc.gaveUp) state = 'failed';
  else if (rc.retryTimer) state = 'retrying';
  else state = 'stopped';
  return {
    state,
    enabled: info.enabled,
    locked: Boolean(envValue('CLAUDE_REMOTE_CONTROL')),
    blockers: info.blockers,
    pid: rc.child?.pid ?? null,
    startedAt: rc.child ? rc.startedAt : null,
    lastExit: rc.lastExit,
    retryAt: rc.retryAt,
    restartPending: Boolean(rc.child) && rc.restartPending,
    url: rc.child ? rc.screen.environmentUrl() : null,
    sessions: rc.child ? rc.screen.sessionLinks() : [],
    screen: withScreen ? rc.screen.text() : undefined,
  };
}

async function remoteControlAction(action) {
  const setEnabled = (on) => {
    const fromEnv = envValue('CLAUDE_REMOTE_CONTROL');
    if (fromEnv) {
      if (isTrue(fromEnv) !== on) {
        throw httpError(409, `CLAUDE_REMOTE_CONTROL=${fromEnv} is set in the container environment; change it there (for example in .env)`);
      }
      return;
    }
    saveSettings({ CLAUDE_REMOTE_CONTROL: on ? '1' : '0' });
  };
  switch (action) {
    case 'start':
      setEnabled(true);
      rc.gaveUp = false;
      rc.quickFailures = 0;
      clearRetry();
      break;
    case 'stop':
      setEnabled(false);
      break;
    case 'restart':
      rc.gaveUp = false;
      rc.quickFailures = 0;
      await stopRemoteControl();
      break;
    default:
      throw httpError(400, 'Unknown action');
  }
  await reconcile({ fresh: true });
}

// ---------------------------------------------------------------------------
// Claude sign-in: `claude-sandbox login` with the code passed in on stdin
// ---------------------------------------------------------------------------
const LOGIN_URL = /https:\/\/[^\s\x1b\x07]+\/oauth\/authorize\?[^\s\x1b\x07]+/;
const loginJob = { child: null, state: 'idle', url: null, output: '', error: null, timer: null, finishedAt: null };

function startClaudeLogin({ sso = false } = {}) {
  if (loginJob.child) throw httpError(409, 'A sign-in is already in progress');
  const args = ['login', '--claudeai'];
  if (sso) args.push('--sso');
  const child = spawn(ENTRYPOINT, args, { cwd: WORKDIR, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  Object.assign(loginJob, { child, state: 'starting', url: null, output: '', error: null, finishedAt: null });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (d) => {
      const text = stripAnsi(d.toString()).replace(/Paste code here if prompted >\s*/g, '');
      loginJob.output = (loginJob.output + text).slice(-8000);
      const m = LOGIN_URL.exec(loginJob.output);
      if (m && loginJob.state === 'starting') {
        loginJob.url = m[0];
        loginJob.state = 'waiting';
      }
    });
  }
  child.stdin.on('error', () => {});
  loginJob.timer = setTimeout(() => cancelClaudeLogin('The sign-in timed out. Start again.'), 15 * 60_000);
  let finished = false;
  const finish = (code, spawnError) => {
    if (finished) return;
    finished = true;
    clearTimeout(loginJob.timer);
    loginJob.child = null;
    loginJob.finishedAt = Date.now();
    if (loginJob.state === 'cancelled') {
      // nothing to report
    } else if (code === 0) {
      loginJob.state = 'succeeded';
      log('signed in to claude.ai');
      if (rc.child) rc.restartPending = true;
      rc.gaveUp = false;
    } else {
      loginJob.state = 'failed';
      const lines = loginJob.output.split('\n').map((l) => l.trim()).filter(Boolean);
      loginJob.error =
        loginJob.error || spawnError || lines.reverse().find((l) => /fail|error|invalid/i.test(l)) || lines[0] || `Sign-in exited with code ${code}`;
    }
    invalidateStatus();
    reconcile({ fresh: true });
  };
  child.on('error', (err) => finish(-1, `Could not start the sign-in: ${err.message}`));
  child.on('close', (code) => finish(code ?? -1));
}

function submitClaudeLoginCode(code) {
  if (!loginJob.child || loginJob.state !== 'waiting') throw httpError(409, 'No sign-in is waiting for a code');
  if (typeof code !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(code.trim())) throw httpError(400, 'Paste the whole code from the sign-in page');
  loginJob.child.stdin.write(`${code.trim()}\n`);
  loginJob.state = 'verifying';
}

function cancelClaudeLogin(reason = null) {
  if (!loginJob.child) return;
  loginJob.state = reason ? 'failed' : 'cancelled';
  loginJob.error = reason;
  signalGroup(loginJob.child, 'SIGTERM');
}

function loginView() {
  const { state, url, error, finishedAt } = loginJob;
  return { state, url, error, finishedAt, output: state === 'failed' ? loginJob.output.slice(-2000) : undefined };
}

async function claudeLogout() {
  cancelClaudeLogin();
  await stopRemoteControl();
  const r = await capture(REAL_CLAUDE, ['auth', 'logout'], { childEnvironment: withoutTokens(childEnv()) });
  invalidateStatus();
  await reconcile({ fresh: true });
  if (r.code !== 0) throw httpError(500, `Sign-out failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
}

// ---------------------------------------------------------------------------
// `claude-sandbox prepare`: git identity, credential helper, clone
// ---------------------------------------------------------------------------
const prepareJob = { child: null, state: 'idle', output: '', code: null, finishedAt: null, again: false };

function runPrepare() {
  if (prepareJob.child) {
    prepareJob.again = true;
    return;
  }
  prepareJob.again = false;
  Object.assign(prepareJob, { state: 'running', output: '', code: null });
  const child = spawn(ENTRYPOINT, ['prepare'], { cwd: WORKDIR, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  prepareJob.child = child;
  const append = (d) => {
    prepareJob.output = (prepareJob.output + stripAnsi(d.toString())).slice(-8000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    prepareJob.child = null;
    prepareJob.code = code;
    prepareJob.state = code === 0 ? 'succeeded' : 'failed';
    prepareJob.finishedAt = Date.now();
    invalidateStatus();
    if (prepareJob.again) runPrepare();
  };
  child.on('error', (err) => {
    append(String(err));
    finish(-1);
  });
  child.on('close', (code) => finish(code ?? -1));
}

function prepareView() {
  const { state, output, code, finishedAt } = prepareJob;
  return { state, output: output.slice(-4000), code, finishedAt };
}

async function afterSettingsChange(changed) {
  if (!changed.length) return;
  invalidateStatus();
  if (changed.some((k) => k !== 'CLAUDE_REMOTE_CONTROL')) runPrepare();
  if (rc.child && changed.some((k) => RESTART_KEYS.has(k))) rc.restartPending = true;
  rc.gaveUp = false;
  await reconcile({ fresh: true });
}

// ---------------------------------------------------------------------------
// GitHub token check
// ---------------------------------------------------------------------------
function tokenKind(token) {
  if (token.startsWith('github_pat_')) return 'fine-grained';
  if (token.startsWith('ghp_')) return 'classic';
  if (token.startsWith('gho_')) return 'OAuth (gh auth login)';
  if (token.startsWith('ghs_')) return 'GitHub App installation';
  if (token.startsWith('ghu_')) return 'GitHub App user';
  return 'unknown';
}

function githubRepo(url) {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url || '');
  return m ? { owner: m[1], name: m[2] } : null;
}

async function githubTest() {
  const token = effectiveValue('GH_TOKEN');
  if (!token) throw httpError(400, 'No GitHub token is set');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'claude-sandbox-webui',
  };
  const get = (url) => fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  const result = { kind: tokenKind(token) };
  let res;
  try {
    res = await get('https://api.github.com/user');
  } catch (err) {
    throw httpError(502, `Could not reach api.github.com: ${err.cause?.code || err.message}`);
  }
  if (!res.ok) {
    result.ok = false;
    result.error = res.status === 401 ? 'GitHub rejected the token: it is wrong, expired or revoked' : `GitHub answered ${res.status}`;
    return result;
  }
  const user = await res.json();
  Object.assign(result, {
    ok: true,
    login: user.login,
    name: user.name,
    expires: res.headers.get('github-authentication-token-expiration'),
    scopes: res.headers.get('x-oauth-scopes'),
  });
  const st = await containerStatus();
  const repoUrl = effectiveValue('GIT_REPO_URL') || st?.git?.remote || '';
  const repo = githubRepo(repoUrl);
  if (repo) {
    const r = await get(`https://api.github.com/repos/${repo.owner}/${repo.name}`).catch(() => null);
    const body = r?.ok ? await r.json() : null;
    result.repo = {
      fullName: `${repo.owner}/${repo.name}`,
      accessible: Boolean(body),
      private: body?.private ?? null,
      push: body?.permissions?.push ?? null,
      status: r?.status ?? null,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Web UI password, sessions and sign-in rate limiting
// ---------------------------------------------------------------------------
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 512 * 1024 * 1024;
let hashQueue = Promise.resolve(); // one scrypt at a time keeps memory use bounded

function scrypt(password, salt, { N, r, p, keylen }) {
  const run = () =>
    new Promise((resolve, reject) =>
      crypto.scrypt(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) =>
        err ? reject(err) : resolve(key),
      ),
    );
  const result = hashQueue.then(run, run);
  hashQueue = result.catch(() => {});
  return result;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT);
  return { algorithm: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

async function verifyPassword(password, record) {
  const expected = Buffer.from(record.hash, 'base64');
  const params = { N: record.N, r: record.r, p: record.p, keylen: expected.length };
  if (!(params.N >= 2 ** 14 && params.N <= 2 ** 20 && params.r <= 16 && params.p <= 4)) return false;
  const actual = await scrypt(password, Buffer.from(record.salt, 'base64'), params);
  return crypto.timingSafeEqual(actual, expected);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  if (password.length > 256) return 'Use at most 256 characters';
  if (/^(.)\1+$/.test(password)) return 'Use more than one repeated character';
  return null;
}

let passwordRecord = null; // { source: 'environment' | 'saved', ...hash }
let setupCode = null;
let settingUp = false;

const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const normalizeCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function initPassword() {
  if (envPassword) {
    if (envPassword.length < MIN_PASSWORD) log(`warning: CLAUDE_WEBUI_PASSWORD is shorter than ${MIN_PASSWORD} characters`);
    passwordRecord = { source: 'environment', ...(await hashPassword(envPassword)) };
    return;
  }
  const saved = readJson(AUTH_FILE, null);
  if (saved?.hash && saved?.salt) {
    passwordRecord = { source: 'saved', ...saved };
    return;
  }
  const chars = Array.from({ length: 12 }, () => SETUP_ALPHABET[crypto.randomInt(SETUP_ALPHABET.length)]).join('');
  setupCode = chars.replace(/(.{4})(?=.)/g, '$1-');
  writePrivate(SETUP_CODE_FILE, `${setupCode}\n`);
}

function setupCodeMatches(code) {
  const a = Buffer.from(normalizeCode(code));
  const b = Buffer.from(normalizeCode(setupCode));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const sessions = new Map(); // token -> { created, seen }

function newSession(res) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { created: Date.now(), seen: Date.now() });
  const secure = server instanceof https.Server ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}${secure}`);
  return token;
}

function sessionToken(req) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => {
      const i = c.indexOf('=');
      return [c.slice(0, i).trim(), c.slice(i + 1).trim()];
    }),
  );
  return cookies[COOKIE] || null;
}

function currentSession(req) {
  const token = sessionToken(req);
  const s = token && sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now - s.seen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) {
    sessions.delete(token);
    return null;
  }
  s.seen = now;
  return token;
}

const failures = new Map(); // ip -> { count, since, until }
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

function lockedFor(ip) {
  const f = failures.get(ip);
  if (!f) return 0;
  const now = Date.now();
  if (f.until > now) return f.until - now;
  if (now - f.since > FAILURE_WINDOW_MS) failures.delete(ip);
  return 0;
}

function recordFailure(ip) {
  const now = Date.now();
  let f = failures.get(ip);
  if (!f || now - f.since > FAILURE_WINDOW_MS) f = { count: 0, since: now, until: 0 };
  f.count++;
  if (f.count >= MAX_FAILURES) {
    f.until = now + FAILURE_WINDOW_MS;
    f.count = 0;
    f.since = now;
    log(`too many wrong passwords from ${ip}; refusing it for 15 minutes`);
  }
  failures.set(ip, f);
}

function rateLimit(ip) {
  const wait = lockedFor(ip);
  if (wait) throw httpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60_000)} minutes.`, { retryAfter: Math.ceil(wait / 1000) });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, extra });
}

const STATIC = new Map();
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function loadStatic() {
  for (const name of fs.readdirSync(PUBLIC_DIR)) {
    const body = fs.readFileSync(path.join(PUBLIC_DIR, name));
    const etag = `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`;
    STATIC.set(`/${name}`, { body, etag, type: TYPES[path.extname(name)] || 'application/octet-stream' });
  }
  STATIC.set('/', STATIC.get('/index.html'));
}

function securityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(httpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Cookies are SameSite=Strict; on top of that, writes must be same-origin JSON.
function checkSameOrigin(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw httpError(415, 'Expected application/json');
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
    throw httpError(403, 'Cross-site request refused');
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host;
    try {
      host = new URL(origin).host;
    } catch {
      host = null;
    }
    if (host !== req.headers.host) throw httpError(403, 'Cross-origin request refused');
  }
}

async function statusPayload(url) {
  const fresh = url?.searchParams.has('fresh');
  const st = await containerStatus({ fresh });
  return {
    container: st,
    remoteControl: remoteControlView(st, url?.searchParams.has('screen')),
    login: loginView(),
    prepare: prepareView(),
    webui: {
      startedAt: Date.now() - process.uptime() * 1000,
      passwordSource: passwordRecord?.source ?? null,
      tls: server instanceof https.Server,
      node: process.version,
      os: osRelease(),
      disk: diskFree(WORKDIR),
      port: PORT,
    },
  };
}

const routes = {
  'GET /api/session': {
    public: true,
    fn: ({ session }) => ({
      authenticated: Boolean(session),
      setupRequired: !passwordRecord,
      passwordSource: passwordRecord?.source ?? null,
      hostname: os.hostname(),
      minPassword: MIN_PASSWORD,
    }),
  },
  'POST /api/setup': {
    public: true,
    fn: async ({ body, ip, res }) => {
      if (passwordRecord) throw httpError(409, 'A password is already set. Sign in instead.');
      rateLimit(ip);
      if (!setupCodeMatches(body.setupCode)) {
        recordFailure(ip);
        throw httpError(403, 'That setup code is not right. Copy it from the container log.');
      }
      const problem = passwordProblem(body.password);
      if (problem) throw httpError(400, problem);
      if (settingUp) throw httpError(409, 'Setup is already in progress');
      settingUp = true;
      try {
        const record = await hashPassword(body.password);
        writePrivate(AUTH_FILE, `${JSON.stringify({ ...record, createdAt: new Date().toISOString() }, null, 2)}\n`);
        passwordRecord = { source: 'saved', ...record };
      } finally {
        settingUp = false;
      }
      setupCode = null;
      fs.rmSync(SETUP_CODE_FILE, { force: true });
      log('web UI password created');
      newSession(res);
      return { ok: true };
    },
  },
  'POST /api/login': {
    public: true,
    fn: async ({ body, ip, res }) => {
      if (!passwordRecord) throw httpError(409, 'Create a password first');
      rateLimit(ip);
      const ok = typeof body.password === 'string' && body.password.length <= 1024 && (await verifyPassword(body.password, passwordRecord));
      if (!ok) {
        recordFailure(ip);
        throw httpError(401, 'Wrong password');
      }
      failures.delete(ip);
      newSession(res);
      return { ok: true };
    },
  },
  'POST /api/logout': {
    public: true,
    fn: ({ req, res }) => {
      sessions.delete(sessionToken(req));
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
      return { ok: true };
    },
  },
  'POST /api/password': {
    fn: async ({ body, ip, res }) => {
      if (passwordRecord.source === 'environment') throw httpError(409, 'The password comes from CLAUDE_WEBUI_PASSWORD; change it there');
      rateLimit(ip);
      if (typeof body.current !== 'string' || !(await verifyPassword(body.current, passwordRecord))) {
        recordFailure(ip);
        throw httpError(403, 'The current password is wrong');
      }
      const problem = passwordProblem(body.password);
      if (problem) throw httpError(400, problem);
      const record = await hashPassword(body.password);
      writePrivate(AUTH_FILE, `${JSON.stringify({ ...record, createdAt: new Date().toISOString() }, null, 2)}\n`);
      passwordRecord = { source: 'saved', ...record };
      sessions.clear(); // sign out everywhere else
      newSession(res);
      log('web UI password changed');
      return { ok: true };
    },
  },
  'GET /api/status': { fn: ({ url }) => statusPayload(url) },
  'GET /api/settings': { fn: () => ({ settings: describeSettings() }) },
  'POST /api/settings': {
    fn: async ({ body }) => {
      const changed = saveSettings(body.values);
      await afterSettingsChange(changed);
      return { changed, settings: describeSettings() };
    },
  },
  'POST /api/remote-control': {
    fn: async ({ body }) => {
      await remoteControlAction(body.action);
      return statusPayload(null);
    },
  },
  'POST /api/claude/login': {
    fn: ({ body }) => {
      if (body.action === 'start') startClaudeLogin({ sso: Boolean(body.sso) });
      else if (body.action === 'code') submitClaudeLoginCode(body.code);
      else if (body.action === 'cancel') cancelClaudeLogin();
      else throw httpError(400, 'Unknown action');
      return { login: loginView() };
    },
  },
  'POST /api/claude/logout': {
    fn: async () => {
      await claudeLogout();
      return { ok: true };
    },
  },
  'POST /api/github/test': { fn: () => githubTest() },
};

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('ok\n');
  }
  if (url.pathname.startsWith('/api/')) {
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return sendJson(res, 404, { error: 'Not found' });
    try {
      const session = currentSession(req);
      if (!route.public && !session) throw httpError(401, 'Sign in first');
      let body = {};
      if (req.method !== 'GET') {
        checkSameOrigin(req);
        body = await readBody(req);
        if (!body || typeof body !== 'object') body = {};
      }
      const ip = req.socket.remoteAddress || 'unknown';
      const result = await route.fn({ req, res, url, body, ip, session });
      return sendJson(res, 200, result ?? {});
    } catch (err) {
      if (!err.status) log(`error in ${req.method} ${url.pathname}: ${err.stack || err}`);
      if (err.extra?.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
      return sendJson(res, err.status || 500, { error: err.status ? err.message : 'Internal error', ...(err.extra || {}) });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  const file = STATIC.get(url.pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found\n');
  }
  if (req.headers['if-none-match'] === file.etag) {
    res.writeHead(304);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': file.type, ETag: file.etag, 'Cache-Control': 'no-cache' });
  res.end(req.method === 'HEAD' ? undefined : file.body);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
let server;
if (env.CLAUDE_WEBUI_TLS_CERT || env.CLAUDE_WEBUI_TLS_KEY) {
  if (!env.CLAUDE_WEBUI_TLS_CERT || !env.CLAUDE_WEBUI_TLS_KEY) {
    log('set both CLAUDE_WEBUI_TLS_CERT and CLAUDE_WEBUI_TLS_KEY to serve HTTPS');
    process.exit(1);
  }
  server = https.createServer(
    { cert: fs.readFileSync(env.CLAUDE_WEBUI_TLS_CERT), key: fs.readFileSync(env.CLAUDE_WEBUI_TLS_KEY) },
    (req, res) => handle(req, res),
  );
} else {
  server = http.createServer((req, res) => handle(req, res));
}
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}: stopping`);
  server.close();
  cancelClaudeLogin();
  if (prepareJob.child) signalGroup(prepareJob.child, 'SIGTERM');
  await stopRemoteControl(20_000);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => {});
process.stdout.on('error', () => {}); // Remote Control output is copied here; never die on it

loadStatic();
await initPassword();
server.on('error', (err) => {
  log(`cannot listen on port ${PORT}: ${err.message}`);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  log(`listening on ${scheme}://${HOST ?? '0.0.0.0'}:${PORT} (in the container; Compose publishes it on the host)`);
  if (setupCode) {
    log('no password yet: open the web UI and create one with this setup code');
    log(`setup code: ${setupCode}`);
  }
});
reconcile({ fresh: true });
// Pick up logins and settings changed outside the web UI (for example
// `docker compose exec claude claude auth login`).
setInterval(() => {
  if (!rc.child && !rc.stopping) reconcile({ fresh: true });
}, 30_000).unref();
