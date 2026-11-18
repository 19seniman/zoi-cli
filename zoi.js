#!/usr/bin/env node
/**
 * zoi.js — CLI untuk zoi.network (ZOI LABS)
 *
 * Zero dependency. Node >= 18 (global fetch).
 * Kredensial & token disimpan di .env (mode 600):
 *
 *   ZOI_EMAIL=you@mail.com
 *   ZOI_PASSWORD=secret
 *   ZOI_TOKEN=...            # diisi otomatis setelah login
 *   ZOI_REFRESH_TOKEN=...
 *   ZOI_DEVICE_ID=...        # dibuat otomatis, dipakai server untuk device session
 *   ZOI_API_BASE=https://api.zoi.network/v1
 *
 * Command:
 *   setup      isi .env tanpa editor (kredensial diuji dulu)
 *   edit       buka .env di editor (dibuat otomatis kalau belum ada)
 *   login      login pakai email+password dari .env atau flag
 *   logout     hapus token dari .env
 *   env        tampilkan .env (disamarkan)
 *   me         profil akun
 *   balance    saldo wallet
 *   tx         transaksi terakhir
 *   ref        statistik referral
 *   get/post   panggil endpoint apa pun
 *
 * contoh:
 *   node zoi.js setup --email you@mail.com --password 'secret'
 *   node zoi.js login --debug
 *   node zoi.js me
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Config / .env
// ---------------------------------------------------------------------------

const ENV_FILE = process.env.ZOI_ENV_FILE ?? path.join(process.cwd(), '.env');
const DEFAULT_API_BASE = 'https://api.zoi.network/v1';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m, code = 1) => {
  console.error(C.r(`✖ ${m}`));
  process.exit(code);
};
const log = (m) => console.log(`${C.dim(new Date().toLocaleTimeString())} ${m}`);

const ENV_TEMPLATE = `# zoi.js — isi email & password akun zoi.network, lalu simpan.
#
# Login pakai email + password (dari aplikasi Zoi)
ZOI_EMAIL=
ZOI_PASSWORD=
#
# Diisi otomatis oleh script:
ZOI_TOKEN=
ZOI_REFRESH_TOKEN=
ZOI_DEVICE_ID=
#
# Opsional
ZOI_API_BASE=https://api.zoi.network/v1
`;

function readEnvFile(file = ENV_FILE) {
  const out = { __lines: [], __order: [] };
  if (!fs.existsSync(file)) return out;
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      out.__lines.push({ type: 'raw', text: line });
      continue;
    }
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!out.__order.includes(m[1])) out.__order.push(m[1]);
    out[m[1]] = v;
    out.__lines.push({ type: 'kv', key: m[1] });
  }
  return out;
}

function writeEnvFile(patch, file = ENV_FILE) {
  const env = readEnvFile(file);
  const seen = new Set();
  const lines = [];
  const render = (k, v) => {
    const quote = /[\s#'"`$]/.test(v) || v === '';
    return `${k}=${quote ? `"${v.replace(/"/g, '\\"')}"` : v}`;
  };
  for (const item of env.__lines) {
    if (item.type === 'raw') {
      lines.push({ raw: item.text });
      continue;
    }
    const k = item.key;
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      seen.add(k);
      const v = patch[k];
      if (v === null || v === undefined || v === '') continue;
      lines.push({ raw: render(k, String(v)) });
    } else if (env[k] !== undefined) {
      lines.push({ raw: render(k, env[k]) });
    }
  }
  const missing = Object.keys(patch).filter((k) => !seen.has(k) && patch[k] !== null && patch[k] !== undefined && patch[k] !== '');
  if (missing.length && lines.length && String(lines[lines.length - 1].raw).trim() !== '') lines.push({ raw: '' });
  for (const k of missing) lines.push({ raw: render(k, String(patch[k])) });
  const body = lines
    .map((l) => l.raw)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  fs.writeFileSync(file, body + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return file;
}

function ensureEnvFile({ quiet = false } = {}) {
  const exists = fs.existsSync(ENV_FILE);
  let existing = '';
  if (exists) {
    try {
      existing = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {}
    if (existing.trim() !== '') return false;
  }
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.writeFileSync(ENV_FILE, ENV_TEMPLATE, { mode: 0o600 });
  try {
    fs.chmodSync(ENV_FILE, 0o600);
  } catch {}
  if (!quiet) console.log(C.dim(`i ${path.basename(ENV_FILE)} ${exists ? 'diisi template (file kosong)' : 'dibuat dengan template'} — edit: nano ${path.basename(ENV_FILE)}`));
  return true;
}

let ENV = readEnvFile();

function envGet(key, fallback = null) {
  const v = ENV[key] ?? process.env[key];
  return v !== undefined && v !== '' ? v : fallback;
}

let API_BASE = envGet('ZOI_API_BASE', DEFAULT_API_BASE);

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const rand = (a, b) => a + Math.random() * (b - a);
const mask = (v, keep = 4) => {
  if (!v) return '—';
  const s = String(v);
  if (s.length <= keep * 2) return '*'.repeat(s.length);
  return `${s.slice(0, keep)}${'*'.repeat(Math.min(16, s.length - keep * 2))}${s.slice(-keep)}`;
};
const fmtNum = (n, dec = 2) => {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) : String(n ?? '—');
};

const GUARD = {
  minGapMs: num(envGet('ZOI_MIN_GAP_MS', '3000'), 3000),
  jitterPct: num(envGet('ZOI_JITTER_PCT', '25'), 25),
  maxRetries: num(envGet('ZOI_MAX_RETRIES', '3'), 3),
  backoffBaseMs: num(envGet('ZOI_BACKOFF_MS', '5000'), 5000),
  timeoutMs: num(envGet('ZOI_TIMEOUT_MS', '20000'), 20000),
};

const withJitter = (ms) => {
  const j = (GUARD.jitterPct / 100) * ms;
  return Math.round(Math.max(300, ms + rand(-j, j)));
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { cmd: positional[0], args: positional.slice(1), flags };
}

async function ask(prompt, { mask: masked = false } = {}) {
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const c of stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').split('\n')[0].trim();
  }
  if (!masked) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(prompt)).trim();
    } finally {
      rl.close();
    }
  }
  stdout.write(prompt);
  return await new Promise((resolve) => {
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor({ code, message, http, path: p, body }) {
    super(`${code ?? 'ERROR'}${http ? ` (HTTP ${http})` : ''}${message ? `: ${message}` : ''}`);
    this.code = code;
    this.http = http;
    this.path = p;
    this.body = body;
  }
}

const session = {
  token: envGet('ZOI_TOKEN'),
  refreshToken: envGet('ZOI_REFRESH_TOKEN'),
};
const isDebug = () => process.env.ZOI_DEBUG === '1' || ENV.ZOI_DEBUG === '1';

function maskDeep(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…(${v.length})` : v;
  if (typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.slice(0, 4).map((x) => maskDeep(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = /token|pass|secret|auth|code/i.test(k) && typeof val === 'string' ? mask(val, 3) : maskDeep(val, depth + 1);
  }
  return out;
}

let lastWriteAt = 0;
async function pace(method) {
  if (method === 'GET') return;
  const gap = withJitter(GUARD.minGapMs);
  const since = Date.now() - lastWriteAt;
  if (since < gap) await sleep(gap - since);
  lastWriteAt = Date.now();
}

function headers(json = true) {
  const h = {
    Accept: 'application/json',
    'User-Agent': 'zoi.js/1.0 (+node)',
    'expo-platform': 'android',
  };
  if (json) h['Content-Type'] = 'application/json';
  if (session.token) h.Authorization = `Bearer ${session.token}`;
  return h;
}

async function request(method, p, { body, auth = true, timeoutMs = GUARD.timeoutMs } = {}) {
  const url = p.startsWith('http') ? p : `${API_BASE}${p.startsWith('/') ? p : '/' + p}`;
  await pace(method);

  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: auth ? headers(body !== undefined) : { ...headers(body !== undefined), Authorization: undefined },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (attempt < GUARD.maxRetries) {
        const wait = withJitter(GUARD.backoffBaseMs * 2 ** attempt);
        log(C.y(`  network error — retry ${attempt + 1}/${GUARD.maxRetries} dalam ${Math.round(wait / 1000)}s`));
        await sleep(wait);
        continue;
      }
      throw new ApiError({ code: 'NETWORK', message: String(e?.message ?? e), path: p });
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      if (attempt < GUARD.maxRetries) {
        const wait = withJitter(Number.isFinite(ra) && ra > 0 ? ra * 1000 : GUARD.backoffBaseMs * 2 ** attempt);
        log(C.y(`  HTTP ${res.status} — cooldown ${Math.round(wait / 1000)}s (retry ${attempt + 1}/${GUARD.maxRetries})`));
        await sleep(wait);
        continue;
      }
      throw new ApiError({ code: 'RATE_LIMITED', message: `HTTP ${res.status}`, http: res.status, path: p });
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (isDebug()) {
      console.log(C.dim(`  [debug] ${method} ${url} → ${res.status}`));
      console.log(C.dim(`  [debug] ${JSON.stringify(maskDeep(json ?? text)).slice(0, 600)}`));
    }

    if (res.status === 401 || res.status === 403) {
      throw new ApiError({
        code: json?.error?.code ?? json?.error ?? 'UNAUTHORIZED',
        message: json?.error?.message ?? 'token ditolak',
        http: res.status,
        path: p,
        body: json,
      });
    }
    if (!res.ok) {
      const err = json?.error;
      const code = typeof err === 'string' ? err : err?.code ?? `HTTP_${res.status}`;
      const msg = typeof err === 'object' ? err?.message : '';
      throw new ApiError({ code, message: msg, http: res.status, path: p, body: json });
    }
    return { data: json, status: res.status, headers: res.headers };
  }
}

const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o) => request('POST', p, { body: body ?? {}, ...o }),
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function getDeviceId() {
  let id = envGet('ZOI_DEVICE_ID');
  if (id) return id;
  id = crypto.randomUUID();
  writeEnvFile({ ZOI_DEVICE_ID: id });
  ENV = readEnvFile();
  return id;
}

function extractAuth(payload) {
  const root = payload ?? {};
  const seen = new Set();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || seen.has(o) || depth > 3) return null;
    seen.add(o);
    const at = o.accessToken ?? o.access_token ?? o.token ?? o.jwt ?? (typeof o.access_token === 'string' ? o.access_token : null);
    if (typeof at === 'string' && at.length > 10) {
      return { token: at, refreshToken: o.refreshToken ?? o.refresh_token ?? null, user: o.user ?? root.user ?? null };
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') {
        const hit = walk(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(root);
}

function adoptAuth(payload) {
  const t = extractAuth(payload);
  if (!t) return null;
  writeEnvFile({ ZOI_TOKEN: t.token, ZOI_REFRESH_TOKEN: t.refreshToken ?? '' });
  ENV = readEnvFile();
  session.token = t.token;
  session.refreshToken = t.refreshToken ?? session.refreshToken;
  return t.user ?? null;
}

/** POST /auth/sign-in — field yang terbukti wajib: email, password, deviceId */
async function signIn(email, password) {
  const deviceId = getDeviceId();
  const r = await request('POST', '/auth/sign-in', {
    body: { email, password, deviceId },
    auth: false,
  });
  return r.data;
}

const PENDING_FILE = path.join(path.dirname(ENV_FILE), '.zoi-pending.json');

function savePending(obj) {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
  } catch {}
}
function loadPending() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Field skalar dari respons sign-in — kandidat token/challenge yang harus dikirim balik. */
function scalarFields(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'user' || v && typeof v === 'object') continue;
    if (typeof v === 'string' || typeof v === 'number') out[k] = v;
  }
  return out;
}

/**
 * Kirim OTP. Server menolak email+code saja (missing_fields), jadi kandidat
 * body disusun bertingkat: minimal → +semua field skalar respons sign-in.
 */
async function verifyOtp(email, code, signInData) {
  const extra = scalarFields(signInData);
  const tries = [
    { email, code },
    { email, otp: code },
    { email, code, ...extra },
    { ...extra, email, code },
    { email, code, challengeId: signInData?.challengeId ?? signInData?.id },
  ].filter((b) => !Object.values(b).includes(undefined));

  const errs = [];
  for (const body of tries) {
    try {
      const r = await request('POST', '/auth/sign-in/verify-otp', { body, auth: false });
      console.log(C.g(`✔ OTP diterima (field: ${Object.keys(body).join(', ')})`));
      try {
        fs.existsSync(PENDING_FILE) && fs.unlinkSync(PENDING_FILE);
      } catch {}
      return r.data;
    } catch (e) {
      errs.push(`${Object.keys(body).join('+')} → ${e.code}`);
      if (!['missing_fields', 'invalid_otp', 'invalid_code', 'otp_invalid', 'VALIDATION_ERROR'].includes(e.code)) break;
    }
  }
  throw new ApiError({
    code: 'OTP_FAILED',
    message: errs.join('\n    '),
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function printUser(u) {
  if (!u) return console.log(C.y('(profil kosong)'));
  const obj = u.user ?? u;
  const rows = Object.entries(obj).filter(([k, v]) => v !== null && typeof v !== 'object');
  console.log(C.b('— akun —'));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(18)} ${v}`);
}

async function cmdLogin(flags) {
  if (flags.debug === true) process.env.ZOI_DEBUG = '1';

  // alternatif: tempel token yang sudah ada (mis. dari aplikasi/devtools)
  if (typeof flags.token === 'string' && flags.token) {
    const t = flags.token.replace(/^Bearer\s+/i, '').trim();
    writeEnvFile({ ZOI_TOKEN: t });
    ENV = readEnvFile();
    session.token = t;
    console.log(C.g(`✔ token disimpan di ${ENV_FILE}`));
    const me = await api.get('/auth/me').catch((e) => {
      console.log(C.y(`  token tersimpan, tapi /auth/me gagal: ${e.message}`));
      return null;
    });
    if (me) printUser(me.data);
    return;
  }

  let email = typeof flags.email === 'string' ? flags.email : envGet('ZOI_EMAIL');
  let password = typeof flags.password === 'string' ? flags.password : envGet('ZOI_PASSWORD');

  if (!email) die('pakai --email <email> atau isi ZOI_EMAIL di .env');
  if (!password) {
    password = await ask(stdin.isTTY ? 'Password: ' : '', { mask: stdin.isTTY });
    if (!password) die('password kosong — pakai --password atau isi ZOI_PASSWORD di .env');
  }

  console.log(C.dim(`→ POST ${API_BASE}/auth/sign-in  (device ${mask(envGet('ZOI_DEVICE_ID'), 6)})`));

  let data;
  try {
    data = await signIn(email, password);
  } catch (e) {
    if (e.code === 'invalid_credentials') die('email/password salah (invalid_credentials)');
    if (e.code === 'missing_fields') die('server bilang missing_fields — bentuk body perlu disesuaikan');
    throw e;
  }

  // kredensial baru disimpan setelah server menerimanya
  writeEnvFile({ ZOI_EMAIL: email, ZOI_PASSWORD: password });
  ENV = readEnvFile();

  // respons bisa langsung berisi token, atau minta OTP
  let user = adoptAuth(data);
  if (session.token) {
    console.log(C.g(`✔ login OK — token ditulis ke ${ENV_FILE}`));
    if (!user) {
      const me = await api.get('/auth/me').catch(() => null);
      user = me?.data;
    }
    if (user) printUser(user);
    return;
  }

  const needsOtp =
    data && (data.needsOtp === true || data.requiresOtp === true || data.otpRequired === true || data.challengeId || data.challenge || data.otpChallenge);
  if (needsOtp) {
    savePending({ email, deviceId: getDeviceId(), response: data, savedAt: new Date().toISOString() });
    console.log(C.y('akun ini butuh kode OTP.'));
    const keys = data && typeof data === 'object' ? Object.keys(data) : [];
    console.log(C.dim(`  field respons sign-in: ${keys.join(', ') || '(kosong)'}`));
    console.log(C.dim(`  respons (disamarkan): ${JSON.stringify(maskDeep(data)).slice(0, 400)}`));
    if (data.emailSentTo) console.log(C.dim(`  kode dikirim ke ${data.emailSentTo}`));
    let code = typeof flags.otp === 'string' ? flags.otp : null;
    if (!code && stdin.isTTY) code = await ask('Kode OTP: ');
    if (!code) {
      console.log(C.dim('  kirim kodenya: node zoi.js login --otp 123456'));
      process.exit(2);
    }
    const v = await verifyOtp(email, code, data);
    user = adoptAuth(v);
    if (session.token) {
      console.log(C.g(`✔ login OK — token ditulis ke ${ENV_FILE}`));
      if (!user) user = (await api.get('/auth/me').catch(() => null))?.data;
      if (user) printUser(user);
      return;
    }
  }

  console.log(C.r('✖ respons login tidak berisi token.'));
  console.log(C.dim(`  isi respons: ${JSON.stringify(maskDeep(data)).slice(0, 500)}`));
  console.log(C.dim('  jalankan dengan --debug untuk detail penuh'));
  process.exit(2);
}

async function cmdSetup(flags) {
  ensureEnvFile({ quiet: true });
  const force = flags.force === true;
  if (envGet('ZOI_EMAIL') && envGet('ZOI_PASSWORD') && !force) {
    console.log(C.y('kredensial sudah ada di .env'));
    console.log(C.dim('  timpa: node zoi.js setup --force   |   edit: node zoi.js edit'));
    return;
  }
  let email = typeof flags.email === 'string' ? flags.email : null;
  let password = typeof flags.password === 'string' ? flags.password : null;
  if (!email && stdin.isTTY) {
    email = await ask('Email: ');
    password = password ?? (await ask('Password: ', { mask: true }));
  }
  if (!email) die("pakai: node zoi.js setup --email you@mail.com --password 'secret'");

  console.log(C.dim(`→ uji login ke ${API_BASE}/auth/sign-in`));
  let data;
  try {
    data = await signIn(email, password);
  } catch (e) {
    console.log(C.y(`  ${e.message}`));
    if (!force) {
      console.log(C.y('! tidak disimpan — kredensial belum valid'));
      process.exit(2);
    }
    data = null;
  }

  writeEnvFile({ ZOI_EMAIL: email, ZOI_PASSWORD: password });
  ENV = readEnvFile();
  console.log(C.g(`✔ ${ENV_FILE} tersimpan (chmod 600)`));

  if (data) {
    adoptAuth(data);
    if (session.token) console.log(C.g('✔ login berhasil — siap: node zoi.js me'));
  }
}

function cmdEdit() {
  ensureEnvFile();
  if (!stdin.isTTY) return console.log(`  nano ${ENV_FILE}`);
  const editor = process.env.ZOI_EDITOR || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
  const candidates = editor === 'nano' || editor === 'notepad' ? (process.platform === 'win32' ? ['notepad'] : ['nano', 'vim', 'vi']) : [editor];
  for (const ed of candidates) {
    const r = spawnSync(ed, [ENV_FILE], { stdio: 'inherit' });
    if (r.error && r.error.code === 'ENOENT') {
      console.log(C.y(`editor "${ed}" tidak ada. tanpa editor: node zoi.js setup`));
      continue;
    }
    ENV = readEnvFile();
    API_BASE = envGet('ZOI_API_BASE', DEFAULT_API_BASE);
    session.token = envGet('ZOI_TOKEN');
    console.log(C.dim(`i ${ENV_FILE} dimuat ulang`));
    return;
  }
  die('tidak ada editor — pakai: node zoi.js setup');
}

function cmdLogout() {
  writeEnvFile({ ZOI_TOKEN: '', ZOI_REFRESH_TOKEN: '' });
  ENV = readEnvFile();
  session.token = null;
  console.log(C.g('✔ token dihapus dari .env'));
}

function cmdEnv() {
  console.log(C.b(`— ${ENV_FILE} —`));
  if (!fs.existsSync(ENV_FILE)) return console.log(C.y('  (belum ada) — jalankan: node zoi.js'));
  if (!envGet('ZOI_EMAIL') && !envGet('ZOI_TOKEN')) {
    console.log(C.y(`  (belum ada kredensial terisi — ${fs.statSync(ENV_FILE).size} byte)`));
    return console.log(C.dim('  isi: node zoi.js setup   atau   node zoi.js edit'));
  }
  for (const k of ['ZOI_EMAIL', 'ZOI_PASSWORD', 'ZOI_TOKEN', 'ZOI_REFRESH_TOKEN', 'ZOI_DEVICE_ID', 'ZOI_API_BASE']) {
    if (ENV[k] !== undefined && ENV[k] !== '') {
      const shown = /PASSWORD|TOKEN/.test(k) ? mask(ENV[k], 4) : ENV[k];
      console.log(`  ${k.padEnd(17)} ${shown}`);
    }
  }
  try {
    console.log(C.dim(`  mode ${(fs.statSync(ENV_FILE).mode & 0o777).toString(8)}  size ${fs.statSync(ENV_FILE).size}B`));
  } catch {}
}

function requireToken() {
  if (!session.token) die('belum login — jalankan: node zoi.js login');
}

async function cmdMe(flags) {
  requireToken();
  const r = await api.get('/auth/me');
  if (flags.json) return console.log(JSON.stringify(r.data, null, 2));
  printUser(r.data);
  console.log(JSON.stringify(r.data, null, 2));
}

async function cmdBalance(flags) {
  requireToken();
  const out = {};
  for (const [name, p] of [
    ['balance', '/wallet/balance'],
    ['summary', '/wallet/summary'],
  ]) {
    try {
      out[name] = (await api.get(p)).data;
    } catch (e) {
      out[name] = { error: e.code };
    }
  }
  if (flags.json) return console.log(JSON.stringify(out, null, 2));
  console.log(C.b('— wallet —'));
  console.log(JSON.stringify(out, null, 2));
}

async function cmdTx(flags) {
  requireToken();
  const r = await api.get('/transactions');
  const d = r.data;
  if (flags.json) return console.log(JSON.stringify(d, null, 2));
  const items = Array.isArray(d) ? d : d?.items ?? d?.transactions ?? [];
  console.log(C.b(`— transaksi (${items.length}) —`));
  for (const t of items.slice(0, 20)) {
    const amt = t.amount ?? t.value ?? '?';
    const kind = t.type ?? t.kind ?? '?';
    const at = t.createdAt ?? t.timestamp ?? '';
    console.log(`  ${String(kind).padEnd(18)} ${fmtNum(amt, 4).padStart(12)}  ${at}`);
  }
  if (!items.length) console.log(JSON.stringify(d, null, 2).slice(0, 600));
}

async function cmdRef(flags) {
  requireToken();
  const r = await api.get('/referrals/stats');
  console.log(C.b('— referral —'));
  console.log(JSON.stringify(r.data, null, 2));
}

// ---------------------------------------------------------------------------
// Sync harian + streak
// ---------------------------------------------------------------------------

function tzInfo() {
  let timeZone = 'UTC';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {}
  return { timeZone, utcOffsetMinutes: -new Date().getTimezoneOffset() };
}

async function fetchSyncState() {
  const r = await api.get('/sync/state');
  return r.data ?? {};
}

/** POST /sync — body mengikuti syncDeviceInfoRequestSchema di bundle app. */
async function performSync() {
  const body = { deviceId: getDeviceId(), platform: 'android', ...tzInfo() };
  const r = await api.post('/sync', body);
  return r.data ?? {};
}

const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
};

function syncReadiness(st) {
  const nextAt = pick(st, ['nextSyncAt', 'nextSync', 'syncReadyAt', 'nextSyncTime']);
  const canSync = pick(st, ['canSync', 'canSyncNow', 'syncAvailable']);
  const lastAt = pick(st, ['lastSyncAt', 'lastSync', 'syncedAt']);
  const cooldownH = pick(st, ['cooldownHours', 'cooldown']);
  const nextMs = nextAt ? Date.parse(nextAt) : NaN;
  const readyByTime = Number.isFinite(nextMs) ? Date.now() >= nextMs : null;
  return { canSync, nextAt, nextMs, lastAt, cooldownH, readyByTime };
}

function hms(ms) {
  if (!Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  let t = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(t / 3600);
  t -= h * 3600;
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${neg ? '-' : ''}${h > 0 ? h + 'j ' : ''}${m}m ${sec}s`;
}

function showStreak(st) {
  const streak = st.streak ?? st.streakInfo ?? {};
  const tier = pick(streak, ['tier', 'tierKey', 'currentTier']) ?? pick(st, ['streakTier', 'memberTier']);
  const days = pick(streak, ['days', 'count', 'current', 'dayCount']) ?? pick(st, ['streakDays', 'streakCount']);
  const nextTierIn = pick(streak, ['daysToNextTier', 'toNextTier']) ?? pick(st, ['daysToNextTier']);
  const shield = pick(streak, ['shield', 'shields', 'shieldCount']);

  console.log(C.b('— streak —'));
  if (tier !== undefined) console.log(`  tier          ${tier}`);
  if (days !== undefined) console.log(`  hari          ${days}`);
  if (nextTierIn !== undefined) console.log(`  ke tier next  ${nextTierIn} hari`);
  if (shield !== undefined) console.log(`  shield        ${shield}`);

  const known = new Set(['streak', 'streakInfo', 'streakTier', 'memberTier', 'streakDays', 'streakCount', 'daysToNextTier']);
  const rest = Object.keys(st).filter((k) => !known.has(k) && !['nextSyncAt', 'lastSyncAt', 'canSync', 'canSyncNow', 'user'].includes(k));
  if (tier === undefined && days === undefined) {
    console.log(C.y('  (bentuk data streak belum dikenal — jalankan: node zoi.js state --debug)'));
    console.log(JSON.stringify(st, null, 2).slice(0, 900));
    return;
  }
  if (rest.length) console.log(C.dim(`  field lain: ${rest.slice(0, 10).join(', ')}`));
}

function showSyncResult(data) {
  const bd = data.breakdown ?? data.sync ?? data.reward ?? {};
  const total = pick(data, ['total', 'amount', 'reward', 'earned']) ?? pick(bd, ['total']);
  console.log(C.g('✔ sync berhasil'));
  const parts = [];
  for (const [k, v] of Object.entries(bd)) {
    if (typeof v === 'number' || typeof v === 'string') parts.push(`${k}=${v}`);
  }
  if (parts.length) console.log(`  rincian   ${parts.join('  ')}`);
  if (total !== undefined) console.log(`  total     ${total}`);
  if (data.streak || data.streakInfo) {
    const st = data.streak ?? data.streakInfo;
    const tier = pick(st, ['tier', 'tierKey']);
    const days = pick(st, ['days', 'count', 'current']);
    if (tier !== undefined || days !== undefined) console.log(`  streak    ${days ?? '?'} hari · tier ${tier ?? '?'}`);
  }
  if (!parts.length && total === undefined) console.log(C.dim(`  respons: ${JSON.stringify(data).slice(0, 400)}`));
}

async function cmdState(flags) {
  requireToken();
  const st = await fetchSyncState();
  if (flags.json) return console.log(JSON.stringify(st, null, 2));
  const r = syncReadiness(st);
  console.log(C.b('— sync state —'));
  console.log(`  bisa sync     ${r.canSync === undefined ? (r.readyByTime ? C.g('ya (jadwal)') : C.dim('belum')) : r.canSync ? C.g('ya') : C.dim('belum')}`);
  if (r.lastAt) console.log(`  terakhir      ${new Date(r.lastAt).toLocaleString()}`);
  if (r.nextAt) console.log(`  berikutnya    ${new Date(r.nextAt).toLocaleString()} (${hms(r.nextMs - Date.now())})`);
  if (r.cooldownH !== undefined) console.log(`  cooldown      ${r.cooldownH} jam`);
  showStreak(st);
}

async function cmdSync(flags) {
  requireToken();
  const st = await fetchSyncState().catch(() => ({}));
  const r = syncReadiness(st);
  if (!flags.force && r.canSync === false && r.readyByTime === false) {
    console.log(C.y(`belum waktunya sync — berikutnya ${new Date(r.nextAt).toLocaleString()} (${hms(r.nextMs - Date.now())})`));
    return;
  }
  if (flags['dry-run']) {
    console.log(C.dim('dry-run: POST /sync tidak dikirim'));
    console.log(JSON.stringify({ deviceId: mask(getDeviceId(), 6), platform: 'android', ...tzInfo() }, null, 2));
    return;
  }
  const data = await performSync();
  if (flags.json) return console.log(JSON.stringify(data, null, 2));
  showSyncResult(data);
  const after = await fetchSyncState().catch(() => null);
  if (after) {
    const r2 = syncReadiness(after);
    if (r2.nextAt) console.log(C.dim(`  sync berikutnya ${new Date(r2.nextAt).toLocaleString()} (${hms(r2.nextMs - Date.now())})`));
    showStreak(after);
  }
}

async function cmdAuto(flags) {
  const dry = flags['dry-run'] === true;
  const once = flags.once === true;
  requireToken();
  console.log(C.b('auto sync + streak') + C.dim(` — ${dry ? 'DRY-RUN' : 'LIVE'}, Ctrl+C stop`));

  let iterations = 0;
  for (;;) {
    iterations++;
    try {
      const st = await fetchSyncState();
      const r = syncReadiness(st);

      if (r.canSync === false && r.readyByTime === false) {
        const waitMs = Math.max(30_000, Math.min((r.nextMs ?? Date.now() + 3_600_000) - Date.now() + 2000, 30 * 60 * 1000));
        if (once) {
          console.log(C.y(`belum waktunya — berikutnya ${new Date(r.nextAt).toLocaleString()} (${hms(r.nextMs - Date.now())})`));
          showStreak(st);
          return;
        }
        log(`belum waktunya · streak ${pick(st.streak ?? {}, ['days', 'count']) ?? '?'} · tidur ${hms(waitMs)}`);
        await sleep(waitMs);
        continue;
      }

      if (dry) {
        log('[dry] akan POST /sync');
        showStreak(st);
        return;
      }

      const data = await performSync();
      showSyncResult(data);
      const after = await fetchSyncState().catch(() => null);
      if (after) showStreak(after);
      if (once) return;

      const r2 = after ? syncReadiness(after) : r;
      const waitMs = Number.isFinite(r2.nextMs) ? Math.max(30_000, Math.min(r2.nextMs - Date.now() + 2000, 30 * 60 * 1000)) : 15 * 60 * 1000;
      log(C.dim(`  tidur ${hms(waitMs)}`));
      await sleep(withJitter(waitMs));
    } catch (e) {
      if (e.code === 'invalid_session' || e.http === 401) die('token ditolak — jalankan: node zoi.js login', 3);
      log(C.r(`  error: ${e.message} — retry 60s`));
      if (once) throw e;
      await sleep(60_000);
    }
  }
}

async function cmdRaw(method, p, bodyArg, flags) {
  if (!p) die(`pakai: ${method.toLowerCase()} /path [json]`);
  let body;
  if (bodyArg) {
    try {
      body = JSON.parse(bodyArg);
    } catch {
      die('body harus JSON');
    }
  }
  const r = method === 'GET' ? await api.get(p) : await api.post(p, body);
  console.log(JSON.stringify(r.data, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = `zoi.js — client zoi.network (creds di .env)

  setup [--email E --password P] [--force]
  edit | env | logout
  login [--email E] [--password P] [--otp CODE] [--debug]
  state | streak      status sync + streak (read-only)
  sync               sync sekarang (--force, --dry-run, --json)
  auto               sync otomatis mengikuti jadwal (--once, --dry-run)
  me | balance | tx | ref
  get <path> | post <path> '<json>'

.env: ZOI_EMAIL ZOI_PASSWORD ZOI_TOKEN ZOI_REFRESH_TOKEN ZOI_DEVICE_ID ZOI_API_BASE
guard: ZOI_MIN_GAP_MS ZOI_JITTER_PCT ZOI_MAX_RETRIES ZOI_BACKOFF_MS ZOI_TIMEOUT_MS
Base : ${API_BASE}
`;

async function main() {
  const { cmd, args, flags } = parseArgs(process.argv.slice(2));
  if (ensureEnvFile()) ENV = readEnvFile();
  if (flags.env) process.env.ZOI_ENV_FILE = String(flags.env);
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);

  switch (cmd) {
    case 'setup':
      return cmdSetup(flags);
    case 'edit':
      return cmdEdit();
    case 'logout':
      return cmdLogout();
    case 'env':
      return cmdEnv();
    case 'login':
      return cmdLogin(flags);
  }

  const known = ['me', 'state', 'streak', 'sync', 'auto', 'balance', 'tx', 'ref', 'get', 'post'];
  if (!known.includes(cmd)) die(`command tidak dikenal: ${cmd}`);

  if (typeof flags.token === 'string' && flags.token) {
    writeEnvFile({ ZOI_TOKEN: flags.token.replace(/^Bearer\s+/i, '').trim() });
    ENV = readEnvFile();
    session.token = envGet('ZOI_TOKEN');
  }

  switch (cmd) {
    case 'me':
      return cmdMe(flags);
    case 'state':
      return cmdState(flags);
    case 'sync':
      return cmdSync(flags);
    case 'streak':
      return cmdState(flags);
    case 'auto':
      return cmdAuto(flags);
    case 'balance':
      return cmdBalance(flags);
    case 'tx':
      return cmdTx(flags);
    case 'ref':
      return cmdRef(flags);
    case 'get':
      return cmdRaw('GET', flags.path ?? args[0], null, flags);
    case 'post':
      return cmdRaw('POST', args[0], args[1], flags);
  }
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(C.r(`✖ ${e.message}`));
    if (e.body && isDebug()) console.error(C.dim(JSON.stringify(maskDeep(e.body), null, 2)));
  } else console.error(C.r(`✖ ${e?.stack ?? e}`));
  process.exit(1);
});
