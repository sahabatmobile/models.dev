const { app, BrowserWindow, ipcMain, safeStorage, shell, clipboard, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync, spawnSync } = require('child_process');
const { Readable } = require('stream');
const { Client: SshClient } = require('ssh2');
const { Client: FtpClient } = require('basic-ftp');
const AdmZip = require('adm-zip');
const dbEngine = require('./db');

const DEFAULT_BASE_URL = 'https://www.sahabatmobile.com/api/v1';
const DEFAULT_UPDATE_FEED = 'https://raw.githubusercontent.com/sahabatmobile/models.dev/dev/desktop/update.json';
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', '.cache', '__pycache__']);
const MAX_READ = 5 * 1024 * 1024;
const posix = path.posix;

const controllers = new Map();
const terminals = new Map();
const remotes = new Map();
let storedKey = null;
let workspaceRoot = null;
let termSeq = 0;
let remoteSeq = 0;
let allowAgentCommands = false;

function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  return { enc: true, value: safeStorage.encryptString(text).toString('base64') };
}

function decryptSecret(value) {
  if (!value || !value.value) return '';
  try {
    const buf = Buffer.from(value.value, 'base64');
    return value.enc ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return '';
  }
}

const PROFILE_PROTOCOLS = ['sftp', 'ftp', 'ftps', ...dbEngine.KINDS];

function normalizeProfileProtocol(p) {
  p = String(p || '').toLowerCase().trim();
  if (p === 'postgresql' || p === 'pgsql') p = 'postgres';
  if (p === 'mariadb') p = 'mysql';
  return PROFILE_PROTOCOLS.includes(p) ? p : 'sftp';
}

function defaultPortOf(p) {
  return ({ sftp: 22, ftp: 21, ftps: 21, mysql: 3306, postgres: 5432, sqlserver: 1433, mongodb: 27017, redis: 6379, elasticsearch: 9200 })[p] || 22;
}

function connectionPublic(p) {
  return {
    id: p.id,
    name: p.name,
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    username: p.username,
    authType: p.authType,
    privateKeyName: p.privateKey ? path.basename(p.privateKey) : '',
    hasPassword: Boolean(p.password),
    hasPassphrase: Boolean(p.passphrase),
    database: p.database || '',
    filePath: p.filePath || '',
    lastConnected: p.lastConnected || null,
    updatedAt: p.updatedAt || null
  };
}

function readConnections() {
  const s = readSettings();
  const list = Array.isArray(s.connections) ? s.connections : [];
  return list.map((p) => ({
    ...p,
    passwordValue: decryptSecret(p.password),
    passphraseValue: decryptSecret(p.passphrase)
  }));
}

function readConnectionProfile(id) {
  return readConnections().find((p) => p.id === id) || null;
}

function writeConnections(profiles) {
  const s = readSettings();
  s.connections = profiles;
  writeSettings(s);
}

function saveConnectionProfile(cfg) {
  if (cfg && cfg.connectionId) {
    const updated = updateConnectionProfile(cfg.connectionId, cfg);
    if (updated.ok) return updated.connection;
  }
  const s = readSettings();
  const list = Array.isArray(s.connections) ? s.connections : [];
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const protocol = normalizeProfileProtocol(cfg.protocol);
  const username = String(cfg.username || cfg.user || '').trim();
  const host = String(cfg.host || '').trim();
  const filePath = String(cfg.filePath || '').trim();
  const fallbackName = protocol === 'sqlite'
    ? 'SQLITE ' + (filePath ? path.basename(filePath) : '')
    : protocol.toUpperCase() + ' ' + (username ? username + '@' : '') + host;
  const profile = {
    id,
    name: String(cfg.name || '').trim() || fallbackName,
    protocol,
    host,
    port: Number(cfg.port) || defaultPortOf(protocol),
    username,
    authType: cfg.authType === 'key' ? 'key' : 'password',
    privateKey: cfg.privateKey ? String(cfg.privateKey).trim() : '',
    password: encryptSecret(cfg.password),
    passphrase: encryptSecret(cfg.passphrase),
    database: String(cfg.database || '').trim(),
    filePath: protocol === 'sqlite' ? filePath : '',
    lastConnected: new Date().toISOString()
  };
  list.unshift(profile);
  writeConnections(list.slice(0, 30));
  return connectionPublic(profile);
}

function updateConnectionProfile(id, cfg) {
  const s = readSettings();
  const list = Array.isArray(s.connections) ? s.connections : [];
  const index = list.findIndex((p) => p.id === id);
  if (index === -1) return { ok: false, error: 'Koneksi tersimpan tidak ditemukan.' };
  const prev = list[index];
  const protocol = normalizeProfileProtocol(cfg.protocol);
  const username = String(cfg.username || cfg.user || '').trim();
  const host = String(cfg.host || '').trim();
  const filePath = String(cfg.filePath || prev.filePath || '').trim();
  if (protocol === 'sqlite') {
    if (!filePath) return { ok: false, error: 'File database SQLite wajib diisi.' };
  } else {
    if (!host) return { ok: false, error: 'Host tidak boleh kosong.' };
    if (!username) return { ok: false, error: 'Username tidak boleh kosong.' };
  }
  const fallbackName = protocol === 'sqlite'
    ? 'SQLITE ' + (filePath ? path.basename(filePath) : '')
    : protocol.toUpperCase() + ' ' + (username ? username + '@' : '') + host;
  const next = {
    ...prev,
    name: String(cfg.name || '').trim() || fallbackName,
    protocol,
    host,
    port: Number(cfg.port) || defaultPortOf(protocol),
    username,
    authType: cfg.authType === 'key' ? 'key' : 'password',
    privateKey: cfg.privateKey ? String(cfg.privateKey).trim() : '',
    database: String(cfg.database !== undefined ? cfg.database : (prev.database || '')).trim(),
    filePath: protocol === 'sqlite' ? filePath : '',
    updatedAt: new Date().toISOString()
  };
  if (typeof cfg.password === 'string' && cfg.password.length) {
    next.password = encryptSecret(cfg.password);
  }
  if (typeof cfg.passphrase === 'string' && cfg.passphrase.length) {
    next.passphrase = encryptSecret(cfg.passphrase);
  }
  if (cfg.clearPassword) next.password = null;
  if (cfg.clearPassphrase) next.passphrase = null;
  list[index] = next;
  s.connections = list;
  writeSettings(s);
  return { ok: true, connection: connectionPublic(next) };
}

function updateConnectionLastConnected(id) {
  const s = readSettings();
  const list = Array.isArray(s.connections) ? s.connections : [];
  let changed = false;
  for (const profile of list) {
    if (profile.id === id) {
      profile.lastConnected = new Date().toISOString();
      changed = true;
      break;
    }
  }
  if (changed) writeConnections(list);
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(data, null, 2), 'utf8');
}

function getBaseUrl() {
  const s = readSettings();
  return (s.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function saveKey(key) {
  storedKey = key;
  const s = readSettings();
  if (safeStorage.isEncryptionAvailable()) {
    s.apiKey = { enc: true, value: safeStorage.encryptString(key).toString('base64') };
  } else {
    s.apiKey = { enc: false, value: Buffer.from(key, 'utf8').toString('base64') };
  }
  writeSettings(s);
}

function loadKey() {
  const s = readSettings();
  if (!s.apiKey || !s.apiKey.value) return null;
  try {
    const buf = Buffer.from(s.apiKey.value, 'base64');
    return s.apiKey.enc ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return null;
  }
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return key.slice(0, 5) + '****' + key.slice(-4);
}

const THINKING_PATTERNS = [
  'think', 'thinking', 'reason', 'reasoning', 'reasoner',
  'deepseek', 'qwq', 'inkling', 'trinity', 'olmo-',
  'claude-opus', 'claude-sonnet', 'claude-fable',
  'mimo-v2', 'minimax-m', 'gpt-5', 'codex',
  'o1', 'o3', 'o4',
];

/** Heuristik: model yang kemungkinan mendukung reasoning effort (thinking). */
function modelSupportsThinking(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return false;
  return THINKING_PATTERNS.some((p) => id.includes(p));
}

/** Buang field reasoning dari history sebelum dikirim (banyak gateway menolak/eror jika ikut di-echo). */
function stripReasoningFields(msg) {
  if (!msg || typeof msg !== 'object') return msg;
  const { reasoning_content, reasoning, thinking, ...rest } = msg;
  return rest;
}

function stripReasoningFromMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(stripReasoningFields);
}

// ---------- Auto-detection paket API key (Hemat / Coding / MiniMax / Pro vs PAYG) ----------
const PACKAGE_MODELS = {
  hemat: ['mimo-v2.5'],
  coding: ['mimo-v2.5', 'mimo-v2.5-pro', 'deepseek-v3.2', 'deepseek-v4-flash', 'qwen3.7-flash'],
  minimax: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1', 'MiniMax-M2'],
  pro: [
    'mimo-v2.5', 'mimo-v2.5-pro', 'deepseek-v3.2', 'deepseek-v4-flash', 'qwen3.7-flash',
    'MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1',
    'deepseek-v4-pro', 'google/gemini-2.5-flash', 'claude-3-haiku',
  ],
};

const PACKAGE_NAMES = {
  hemat: 'Paket Hemat',
  coding: 'Paket Coding',
  minimax: 'Paket MiniMax',
  pro: 'Paket Pro',
};

const PACKAGE_UNION = Array.from(new Set([].concat(...Object.values(PACKAGE_MODELS))));

// Deteksi 1: awalan key (sk-hemat-..., sk-minimax-..., dst.)
function packageFromKey(key) {
  const k = String(key || '').toLowerCase();
  if (!k) return null;
  if (k.startsWith('sk-hemat')) return 'hemat';
  if (k.startsWith('sk-coding')) return 'coding';
  if (k.startsWith('sk-minimax')) return 'minimax';
  if (k.startsWith('sk-pro')) return 'pro';
  return null;
}

function packageFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (t.includes('hemat')) return 'hemat';
  if (t.includes('coding')) return 'coding';
  if (t.includes('minimax')) return 'minimax';
  if (/\bpro\b/.test(t)) return 'pro';
  return null;
}

// Deteksi 2: probe minimal ke model eksklusif paket.
// Aturan gateway: mimo-* / minimax-* ditolak 403 model_requires_package BILA tanpa paket.
async function probePackage() {
  try {
    const res = await fetch(getBaseUrl() + '/chat/completions', {
      method: 'POST',
      headers: authHeaders(storedKey),
      body: JSON.stringify({ model: 'mimo-v2.5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8, stream: false })
    });
    const text = await res.text();
    if (res.ok) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* bukan JSON */ }
      const planRaw = parsed && (parsed.plan || parsed.package || parsed.billed_to ||
        (parsed.billing && (parsed.billing.plan || parsed.billing.package)) ||
        (parsed.usage && (parsed.usage.plan || parsed.usage.billing)));
      const plan = packageFromText(typeof planRaw === 'string' ? planRaw : JSON.stringify(planRaw || ''));
      return { hasPackage: true, plan };
    }
    if (/model_requires_package/i.test(text) || res.status === 403) return { hasPackage: false, plan: null };
    return { hasPackage: null, plan: null };
  } catch {
    return { hasPackage: null, plan: null };
  }
}

// Cache hasil deteksi 15 menit (probe berbiaya ~1 token).
let accessCache = { at: 0, key: '', value: null };

async function detectModelAccess() {
  const s = readSettings();
  const mode = s.modelAccessMode || 'auto';
  if (mode !== 'auto') {
    if (mode === 'payg') return { detected: true, source: 'mode', allowed: null, plan: 'Pay-as-you-go', note: 'Mode manual: Pay-as-you-go - semua model ditampilkan (biaya per pemakaian).' };
    if (PACKAGE_MODELS[mode]) return { detected: true, source: 'mode', allowed: [...PACKAGE_MODELS[mode]], plan: PACKAGE_NAMES[mode], note: 'Mode manual: ' + PACKAGE_NAMES[mode] + ' - hanya ' + PACKAGE_MODELS[mode].length + ' model yang ditanggung paket.' };
  }
  if (!storedKey) return { detected: false, note: 'API key belum diisi.', allowed: null };
  // Lapis 1: awalan key.
  const byPrefix = packageFromKey(storedKey);
  if (byPrefix) {
    return {
      detected: true, source: 'prefix', allowed: [...PACKAGE_MODELS[byPrefix]], plan: PACKAGE_NAMES[byPrefix],
      note: 'API key terdeteksi: ' + PACKAGE_NAMES[byPrefix] + ' - model di luar daftar paket tidak ditampilkan agar saldo wallet tidak terpotong.'
    };
  }
  // Lapis 2: cache.
  const now = Date.now();
  if (accessCache.value && accessCache.key === storedKey && now - accessCache.at < 15 * 60 * 1000) return accessCache.value;
  // Lapis 3: probe ke server.
  const probe = await probePackage();
  let result;
  if (probe.hasPackage === false) {
    result = {
      detected: true, source: 'probe', allowed: null, plan: 'Pay-as-you-go',
      note: 'API key terdeteksi: Pay-as-you-go (tanpa paket) - semua model boleh, biaya per pemakaian.'
    };
  } else if (probe.hasPackage === true && probe.plan) {
    result = {
      detected: true, source: 'probe', allowed: [...PACKAGE_MODELS[probe.plan]], plan: PACKAGE_NAMES[probe.plan],
      note: 'API key terdeteksi: ' + PACKAGE_NAMES[probe.plan] + ' - hanya model yang ditanggung paket yang ditampilkan.'
    };
  } else if (probe.hasPackage === true) {
    result = {
      detected: true, source: 'probe', allowed: [...PACKAGE_UNION], plan: 'Paket aktif',
      note: 'Paket terdeteksi aktif (jenis belum terbaca) - menampilkan model yang umum ditanggung paket. Centang "Tampilkan semua model" bila perlu.'
    };
  } else {
    result = {
      detected: false, allowed: null,
      note: 'Paket API key tidak dapat dideteksi otomatis - menampilkan semua model. Atur manual di Pengaturan - Model & paket API.'
    };
  }
  // Jangan cache hasil yang tidak pasti (deteksi gagal) agar bisa dicoba ulang.
  if (result.detected !== false) accessCache = { at: now, key: storedKey, value: result };
  return result;
}

function blockedModelIds() {
  try {
    const s = readSettings();
    return Array.isArray(s.modelBlocked) ? s.modelBlocked.map(String) : [];
  } catch { return []; }
}

function addBlockedModel(model) {
  try {
    const s = readSettings();
    const list = Array.isArray(s.modelBlocked) ? s.modelBlocked.map(String) : [];
    if (!list.includes(String(model))) {
      s.modelBlocked = [...list, String(model)].slice(0, 100);
      writeSettings(s);
    }
  } catch { /* abaikan */ }
}

function authHeaders(key) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + key,
    'x-api-key': key
  };
}

function errorMessage(status, text) {
  let detail = '';
  let type = '';
  let code = '';
  try {
    const parsed = JSON.parse(text);
    detail = (parsed.error && parsed.error.message) || parsed.message || '';
    type = (parsed.error && parsed.error.type) || '';
    code = (parsed.error && parsed.error.code) || '';
  } catch {
    detail = (text || '').slice(0, 300);
  }
  const fallback = {
    400: 'Permintaan tidak valid.',
    401: 'API key salah atau tidak aktif.',
    402: 'Saldo kredit tidak cukup. Top-up dulu.',
    403: 'Model di luar paket atau tidak bisa dipakai.',
    404: 'Endpoint tidak ditemukan.',
    429: 'Rate limit atau kuota habis. Coba lagi nanti.',
    500: 'Server error.',
    502: 'Provider upstream error, coba lagi.'
  };
  return { status, message: detail || fallback[status] || 'Terjadi kesalahan.', type, code };
}

// ---------- Open VSX registry ----------

const OPEN_VSX_BASE = 'https://open-vsx.org';
const MAX_VSIX_SIZE = 150 * 1024 * 1024;

function compareVersions(a, b) {
  const pa = String(a || '0').match(/\d+/g) || ['0'];
  const pb = String(b || '0').match(/\d+/g) || ['0'];
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = Number(pa[i] || 0);
    const y = Number(pb[i] || 0);
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function fetchTextOnce(url, timeoutMs = 15000, binary = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SahabatMobile-Desktop/1.0' },
      signal: controller.signal
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + (body ? ': ' + body.slice(0, 200) : ''));
    }
    if (binary) return Buffer.from(await res.arrayBuffer());
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonOnce(url, timeoutMs = 15000) {
  const text = await fetchTextOnce(url, timeoutMs);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Respons Open VSX bukan JSON valid.');
  }
}

function zipPath(zip, relativePath) {
  const entries = zip.getEntries();
  const clean = normalizePath(relativePath);
  const candidates = [clean, 'extension/' + clean];
  for (const entry of entries) {
    const normalized = entry.entryName.replace(/\\/g, '/').replace(/^\.\//, '');
    if (candidates.includes(normalized)) return entry;
  }
  return null;
}

function readJsonEntry(zip, relativePath) {
  const entry = zipPath(zip, relativePath);
  if (!entry) return null;
  try {
    return JSON.parse(entry.getData().toString('utf8'));
  } catch {
    return null;
  }
}

function readTextEntry(zip, relativePath) {
  const entry = zipPath(zip, relativePath);
  return entry ? entry.getData().toString('utf8') : null;
}

function packageId(pkg) {
  return safeExtId((pkg.publisher || 'openvsx') + '.' + (pkg.name || 'extension'));
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function assertSafeRelative(value) {
  const normalized = normalizePath(value);
  if (normalized.split('/').includes('..')) throw new Error('Path tidak aman di dalam arsip.');
  return normalized;
}

function vsCodeSnippetToAce(snip, fallbackName) {
  const name = String(snip.prefix || snip.label || fallbackName || 'Snippet').trim();
  const prefixes = Array.isArray(snip.prefix) ? snip.prefix : [snip.prefix || name];
  const bodyLines = Array.isArray(snip.body) ? snip.body.slice() : String(snip.body || '').split(/\r?\n/);
  const description = String(snip.description || name || 'Snippet').replace(/[\r\n]+/g, ' ').trim();
  const output = [];
  for (const rawPrefix of prefixes) {
    if (!rawPrefix) continue;
    const prefix = String(rawPrefix).trim().split(/\s+/).join('-');
    if (!prefix) continue;
    output.push('snippet ' + prefix + ' ' + description);
    for (const line of bodyLines) {
      output.push('\t' + String(line).replace(/\t/g, '    '));
    }
  }
  return output.join('\n');
}

function vsCodeSnippetsToAce(jsonText, sourceName) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('File snippet tidak valid: ' + sourceName);
  }
  const blocks = [];
  for (const [name, snip] of Object.entries(parsed || {})) {
    if (!snip || typeof snip !== 'object') continue;
    const block = vsCodeSnippetToAce(snip, name);
    if (block) blocks.push(block);
  }
  return blocks.join('\n');
}

function extractVsLanguages(packageJson) {
  const languages = {};
  for (const item of (packageJson.contributes && packageJson.contributes.languages) || []) {
    const langId = String(item.id || '').trim();
    if (!langId) continue;
    for (const rawExt of item.extensions || []) {
      const ext = String(rawExt).replace(/^\./, '').trim().toLowerCase();
      if (/^[a-z0-9_-]+$/.test(ext)) languages[ext] = langId;
    }
  }
  return languages;
}

function sanitizeSnippetFileName(value) {
  return String(value || 'snippet').replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase();
}

function installFromPackagePaths(packageJson, source, resolveText, resolveBinary) {
  const vsSnippets = (packageJson.contributes && packageJson.contributes.snippets) || [];
  const vsLanguages = (packageJson.contributes && packageJson.contributes.languages) || [];
  const languages = extractVsLanguages(packageJson);
  const id = packageId(packageJson);
  const dest = path.join(extensionsDir(), id);
  const staging = path.join(os.tmpdir(), 'sahabat-ext-install-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(path.join(staging, 'snippets'), { recursive: true });

  let snippetCount = 0;
  const snippetFiles = new Map();
  try {
    for (const contribution of vsSnippets) {
      const language = String(contribution.language || '').trim();
      const rel = assertSafeRelative(contribution.path || '');
      if (!language || !rel) continue;
      const text = resolveText(rel);
      if (text == null) continue;
      const converted = vsCodeSnippetsToAce(text, rel);
      if (!converted) continue;
      const key = sanitizeSnippetFileName(language);
      snippetFiles.set(key, (snippetFiles.get(key) || '') + '\n' + converted);
      snippetCount += (converted.match(/^snippet /mg) || []).length;
    }

    if (snippetCount === 0 && Object.keys(languages).length === 0) {
      throw new Error('Ekstensi ini tidak berisi snippet atau mapping bahasa; belum didukung.');
    }

    for (const [name, content] of snippetFiles.entries()) {
      fs.writeFileSync(path.join(staging, 'snippets', name + '.snippets'), content.trim() + '\n', 'utf8');
    }

    const contributes = {};
    if (snippetFiles.size) {
      contributes.snippets = {};
      for (const name of snippetFiles.keys()) contributes.snippets[name] = 'snippets/' + name + '.snippets';
    }
    if (Object.keys(languages).length) contributes.languages = languages;

    const manifest = {
      id,
      name: packageJson.displayName || packageJson.name || id,
      version: packageJson.version || '0.0.0',
      publisher: packageJson.publisher || 'openvsx',
      description: packageJson.description || '',
      source: source || { registry: 'openvsx' },
      contributes
    };

    if (resolveBinary) {
      const iconRef = packageJson.icon || packageJson.userIcon;
      if (iconRef) {
        try {
          const rel = assertSafeRelative(iconRef);
          const iconData = resolveBinary(rel);
          if (iconData && iconData.length < 2 * 1024 * 1024) {
            const ext = path.extname(rel).toLowerCase() || '.png';
            const safeExt = /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : '.png';
            const destIcon = 'icon' + safeExt;
            fs.writeFileSync(path.join(staging, destIcon), iconData);
            manifest.icon = destIcon;
          }
        } catch {}
      }
    }
    fs.writeFileSync(path.join(staging, 'extension.json'), JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf8');

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(staging, dest, { recursive: true });
    return { id, name: manifest.name, version: manifest.version };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function installFromVsixBuffer(buffer, source) {
  if (buffer.length > MAX_VSIX_SIZE) throw new Error('Ukuran ekstensi terlalu besar (maks 150 MB).');
  const zip = new AdmZip(buffer);
  const packageJson = readJsonEntry(zip, 'extension/package.json') || readJsonEntry(zip, 'package.json');
  if (!packageJson) throw new Error('Arsip VSIX tidak berisi extension/package.json.');
  return installFromPackagePaths(packageJson, source, (rel) => readTextEntry(zip, rel), (rel) => {
    const entry = zipPath(zip, rel);
    return entry ? entry.getData() : null;
  });
}

function installFromDir(dir) {
  const packageJson = readExtPackageJson(dir);
  if (packageJson) {
    return installFromPackagePaths(packageJson, { registry: 'folder', path: dir }, (rel) => {
      try {
        return fs.readFileSync(path.join(dir, assertSafeRelative(rel)), 'utf8');
      } catch {
        return null;
      }
    }, (rel) => {
      try {
        return fs.readFileSync(path.join(dir, assertSafeRelative(rel)));
      } catch {
        return null;
      }
    });
  }
  return installExtensionFromDir(dir);
}

function readExtPackageJson(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg === 'object' && pkg.name) return pkg;
  } catch {}
  return null;
}

function extensionsDir() {
  return path.join(app.getPath('userData'), 'extensions');
}

function builtinExtensionsDir() {
  const builtin = path.basename(__dirname) === 'app.asar' ||
    __dirname.includes(path.sep + 'app.asar') ||
    __dirname.includes('/app.asar');
  if (builtin) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'extensions');
  }
  return path.join(__dirname, 'extensions');
}

function extensionsStateFile() {
  return path.join(app.getPath('userData'), 'extensions-state.json');
}

function readExtState() {
  try {
    const data = JSON.parse(fs.readFileSync(extensionsStateFile(), 'utf8'));
    return { disabled: Array.isArray(data.disabled) ? data.disabled : [] };
  } catch {
    return { disabled: [] };
  }
}

function writeExtState(state) {
  fs.mkdirSync(path.dirname(extensionsStateFile()), { recursive: true });
  fs.writeFileSync(extensionsStateFile(), JSON.stringify(state, null, 2), 'utf8');
}

function safeExtId(value) {
  const id = String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  return id || 'extension';
}

function readExtManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'extension.json'), 'utf8'));
    if (!manifest || typeof manifest !== 'object') return null;
    if (!manifest.id || typeof manifest.id !== 'string') manifest.id = safeExtId(path.basename(dir));
    return manifest;
  } catch {
    return null;
  }
}

function readExtSnippets(manifest, dir) {
  const snippets = {};
  const files = (manifest.contributes && manifest.contributes.snippets) || {};
  for (const [scope, rel] of Object.entries(files)) {
    try {
      snippets[scope] = fs.readFileSync(path.join(dir, rel), 'utf8');
    } catch {}
  }
  return snippets;
}

function readExtIcon(manifest, dir) {
  const ref = manifest.icon || (manifest.userIcon && manifest.userIcon);
  if (!ref) return null;
  try {
    const rel = assertSafeRelative(ref);
    const file = path.join(dir, rel);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    const ext = path.extname(file).slice(1).toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' }[ext] || 'application/octet-stream';
    return 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
  } catch {
    return null;
  }
}

function listSubdirs(base) {
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name));
  } catch {
    return [];
  }
}

function installExtensionFromDir(srcDir) {
  const manifest = readExtManifest(srcDir);
  if (!manifest) throw new Error('extension.json tidak ditemukan atau tidak valid.');
  const id = safeExtId(manifest.id);
  const dest = path.join(extensionsDir(), id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  return { id, name: manifest.name || id, version: manifest.version || '0.0.0' };
}

async function installExtensionFromZip(zipPath) {
  const zip = new AdmZip(zipPath);
  if (readJsonEntry(zip, 'extension/package.json') || readJsonEntry(zip, 'package.json')) {
    return installFromVsixBuffer(fs.readFileSync(zipPath), {
      registry: 'vsix',
      path: zipPath
    });
  }
  const tmp = path.join(os.tmpdir(), 'sahabat-ext-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    zip.extractAllTo(tmp, true);
    let root = tmp;
    if (!fs.existsSync(path.join(root, 'extension.json'))) {
      const found = listSubdirs(root).find((dir) => fs.existsSync(path.join(dir, 'extension.json')));
      if (found) root = found;
    }
    if (!fs.existsSync(path.join(root, 'extension.json'))) {
      throw new Error('Arsip tidak berisi ekstensi yang didukung (package.json atau extension.json).');
    }
    return installExtensionFromDir(root);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function getInstalledExtensions() {
  const state = readExtState();
  const installed = [];
  const installedIds = new Set();
  for (const dir of listSubdirs(extensionsDir())) {
    const manifest = readExtManifest(dir);
    if (!manifest) continue;
    const id = safeExtId(manifest.id);
    installedIds.add(id);
    installed.push({
      ...manifest,
      id,
      enabled: !state.disabled.includes(id),
      snippets: readExtSnippets(manifest, dir),
      iconDataUrl: readExtIcon(manifest, dir)
    });
  }
  return { installed, installedIds };
}

ipcMain.handle('ext:list', () => {
  const { installed, installedIds } = getInstalledExtensions();
  const catalog = [];
  for (const dir of listSubdirs(builtinExtensionsDir())) {
    const manifest = readExtManifest(dir);
    if (!manifest) continue;
    const id = safeExtId(manifest.id);
    catalog.push({ ...manifest, id, installed: installedIds.has(id) });
  }
  return { ok: true, extensions: installed, catalog, dir: extensionsDir() };
});

ipcMain.handle('ext:installBuiltin', (event, id) => {
  try {
    const dir = path.join(builtinExtensionsDir(), safeExtId(id));
    if (!fs.existsSync(path.join(dir, 'extension.json'))) {
      throw new Error('Ekstensi bawaan tidak ditemukan.');
    }
    return { ok: true, ...installExtensionFromDir(dir) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:installFolder', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Pilih folder ekstensi',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  try {
    return { ok: true, ...installFromDir(result.filePaths[0]) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:installZip', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Pilih arsip ekstensi',
    properties: ['openFile'],
    filters: [{ name: 'Arsip ekstensi', extensions: ['zip'] }]
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  try {
    return { ok: true, ...(await installExtensionFromZip(result.filePaths[0])) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:remove', (event, id) => {
  try {
    const key = safeExtId(id);
    fs.rmSync(path.join(extensionsDir(), key), { recursive: true, force: true });
    const state = readExtState();
    state.disabled = state.disabled.filter((item) => item !== key);
    writeExtState(state);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:setEnabled', (event, id, enabled) => {
  try {
    const key = safeExtId(id);
    const state = readExtState();
    state.disabled = state.disabled.filter((item) => item !== key);
    if (!enabled) state.disabled.push(key);
    writeExtState(state);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:openDir', async () => {
  fs.mkdirSync(extensionsDir(), { recursive: true });
  const err = await shell.openPath(extensionsDir());
  return err ? { ok: false, error: err } : { ok: true };
});

async function downloadAndInstallOpenVsx(namespace, name, version) {
  const base = OPEN_VSX_BASE + '/api/' + encodeURIComponent(namespace) + '/' + encodeURIComponent(name);
  const latest = await fetchJsonOnce(base);
  const selectedVersion = version || latest.version;
  if (!selectedVersion) throw new Error('Versi ekstensi tidak ditemukan.');
  const meta = version ? await fetchJsonOnce(base + '/' + encodeURIComponent(selectedVersion)) : latest;
  const downloadUrl = (meta.files && meta.files.download) ||
    base + '/' + encodeURIComponent(selectedVersion) + '/file/' +
    encodeURIComponent(namespace + '.' + name + '-' + selectedVersion + '.vsix');
  const buf = await fetchTextOnce(downloadUrl, 60000, true);
  if (buf.length > MAX_VSIX_SIZE) throw new Error('Ukuran ekstensi terlalu besar (maks 150 MB).');
  if (meta.files && meta.files.sha256) {
    const expected = (await fetchTextOnce(meta.files.sha256, 15000)).trim().toLowerCase();
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (expected && actual !== expected) throw new Error('Checksum VSIX tidak cocok.');
  }
  const installed = installFromVsixBuffer(buf, {
    registry: 'openvsx',
    namespace,
    name,
    version: selectedVersion
  });
  return installed;
}

ipcMain.handle('ext:searchOpenVsx', async (event, query) => {
  const q = String(query || '').trim();
  if (!q) return { ok: true, extensions: [] };
  try {
    const url = OPEN_VSX_BASE + '/api/-/search?query=' + encodeURIComponent(q) + '&size=15';
    const data = await fetchJsonOnce(url);
    const extensions = (data.extensions || []).map((item) => ({
      id: safeExtId(String(item.namespace || '') + '.' + String(item.name || '')),
      namespace: item.namespace || '',
      name: item.name || '',
      displayName: item.displayName || item.name || '',
      description: item.description || '',
      version: item.version || '',
      publisher: item.namespaceDisplayName || item.namespace || '',
      downloadCount: Number(item.downloadCount || 0),
      rating: Number(item.averageRating || item.rating || 0),
      reviewCount: Number(item.reviewCount || 0),
      verified: Boolean(item.verified),
      targetPlatform: item.targetPlatform || 'universal',
      repository: item.repository || item.homepage || '',
      registry: 'openvsx',
      icon: item.files && typeof item.files.icon === 'string' && item.files.icon.startsWith('https://open-vsx.org/')
        ? item.files.icon
        : ''
    }));
    return { ok: true, extensions };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:installOpenVsx', async (event, payload) => {
  const namespace = String(payload?.namespace || '').trim();
  const name = String(payload?.name || '').trim();
  const version = String(payload?.version || '').trim();
  if (!namespace || !name) return { ok: false, error: 'Namespace dan nama ekstensi wajib diisi.' };

  try {
    const installed = await downloadAndInstallOpenVsx(namespace, name, version || undefined);
    return { ok: true, ...installed };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:checkUpdates', async () => {
  try {
    const { installed } = getInstalledExtensions();
    const candidates = installed.filter((ext) => ext.source && ext.source.registry === 'openvsx');
    const checks = candidates.map(async (ext) => {
      try {
        const meta = await fetchJsonOnce(
          OPEN_VSX_BASE + '/api/' + encodeURIComponent(ext.source.namespace) + '/' + encodeURIComponent(ext.source.name)
        );
        const latest = meta.version || '';
        if (latest && compareVersions(latest, ext.version) > 0) {
          return {
            id: ext.id,
            name: ext.name,
            current: ext.version,
            latest,
            downloadCount: Number(meta.downloadCount || 0)
          };
        }
        return null;
      } catch {
        return null;
      }
    });
    const updates = (await Promise.all(checks)).filter(Boolean);
    return { ok: true, updates, checked: candidates.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:updateAll', async () => {
  try {
    const { installed } = getInstalledExtensions();
    const candidates = installed.filter((ext) => ext.source && ext.source.registry === 'openvsx');
    const checks = await Promise.all(candidates.map(async (ext) => {
      try {
        const meta = await fetchJsonOnce(
          OPEN_VSX_BASE + '/api/' + encodeURIComponent(ext.source.namespace) + '/' + encodeURIComponent(ext.source.name)
        );
        return { ext, latest: meta.version || '' };
      } catch {
        return { ext, latest: '' };
      }
    }));

    const results = [];
    for (const { ext, latest } of checks) {
      if (!latest || compareVersions(latest, ext.version) <= 0) continue;
      try {
        await downloadAndInstallOpenVsx(ext.source.namespace, ext.source.name, latest);
        results.push({ id: ext.id, ok: true, name: ext.name, from: ext.version, to: latest });
      } catch (err) {
        results.push({ id: ext.id, ok: false, name: ext.name, error: err.message });
      }
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ext:openExternal', async (event, url) => {
  const value = String(url || '');
  if (!/^https:\/\/(open-vsx\.org|github\.com|gitlab\.com|bitbucket\.org|www\.[a-z0-9.-]+)\//i.test(value) &&
      !/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\//i.test(value) &&
      !/^https:\/\/open-vsx\.org/i.test(value)) {
    return { ok: false, error: 'URL tidak didukung' };
  }
  await shell.openExternal(value);
  return { ok: true };
});

// ---------- drive mapping (rclone + WinFsp / SMB) ----------

function driveMappingDir() {
  return path.join(app.getPath('userData'), 'drive-mounts');
}

function driveMappingFile() {
  return path.join(driveMappingDir(), 'mappings.json');
}

function readDriveMappings() {
  try {
    const data = JSON.parse(fs.readFileSync(driveMappingFile(), 'utf8'));
    return Array.isArray(data.mappings) ? data.mappings : [];
  } catch {
    return [];
  }
}

function writeDriveMappings(mappings) {
  fs.mkdirSync(driveMappingDir(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(driveMappingDir(), 0o700); } catch {}
  fs.writeFileSync(driveMappingFile(), JSON.stringify({ mappings }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(driveMappingFile(), 0o600); } catch {}
}

function isDriveInUse(drive) {
  try {
    return fs.existsSync(drive + ':\\') || String(spawnSync('net.exe', ['use'], { windowsHide: true, encoding: 'utf8' }).stdout || '').includes(drive + ':');
  } catch {
    return fs.existsSync(drive + ':\\');
  }
}

function findCommand(name, fallbacks) {
  const fromEnv = process.env[name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_EXE'];
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const candidate of fallbacks || []) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  try {
    const out = execFileSync('where.exe', [name], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const match = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return match || null;
  } catch {
    return null;
  }
}

function findExecutableRecursive(root, name, maxDepth = 5) {
  try {
    if (!fs.existsSync(root)) return null;
    const walk = (dir, depth) => {
      if (depth > maxDepth) return null;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = walk(full, depth + 1);
          if (found) return found;
        } else if (entry.name.toLowerCase() === name.toLowerCase()) {
          return full;
        }
      }
      return null;
    };
    return walk(root, 0);
  } catch {
    return null;
  }
}

function findInstalledRclone() {
  return findExecutableRecursive(path.join(app.getPath('userData'), 'tools', 'rclone'), 'rclone.exe');
}

function findRclone() {
  const installed = findInstalledRclone();
  if (installed) return installed;
  return findCommand('rclone.exe', [
    'C:\\Program Files\\rclone\\rclone.exe',
    'C:\\Program Files (x86)\\rclone\\rclone.exe',
    path.join(os.homedir(), 'scoop', 'shims', 'rclone.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Rclone.Rclone', 'rclone.exe')
  ]);
}

function readRegistryValue(key, valueName) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', valueName], {
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const match = out.match(new RegExp(valueName + '\\s+\\S+\\s+(.+)'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function findWinFsp() {
  const registryDirs = [
    readRegistryValue('HKLM\\SOFTWARE\\WOW6432Node\\WinFsp', 'InstallDir'),
    readRegistryValue('HKLM\\SOFTWARE\\WinFsp', 'InstallDir')
  ].filter(Boolean);
  const candidates = [
    ...registryDirs.map((dir) => path.join(dir, 'bin', 'launcher-x64.exe')),
    'C:\\Program Files\\WinFsp\\bin\\launcher-x64.exe',
    'C:\\Program Files (x86)\\WinFsp\\bin\\launcher-x64.exe',
    'C:\\Program Files\\WinFsp\\bin\\winfsp-x64.dll',
    'C:\\Program Files (x86)\\WinFsp\\bin\\winfsp-x64.dll'
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findSshfs() {
  const candidates = [
    'C:\\Program Files\\SSHFS-Win\\bin\\sshfs-win.exe',
    'C:\\Program Files (x86)\\SSHFS-Win\\bin\\sshfs-win.exe'
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function iniEscape(value) {
  return String(value || '').replace(/[\"\\]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function buildRcloneConfig(remoteName, payload, obscuredPass, obscuredKeyPass) {
  const lines = [
    '[' + remoteName + ']',
    'type = sftp',
    'host = ' + iniEscape(payload.host),
    'user = ' + iniEscape(payload.username),
    'port = ' + (Number(payload.port) || 22),
    'known_hosts_file = none'
  ];
  if (obscuredPass) lines.push('pass = ' + obscuredPass);
  if (payload.privateKey) lines.push('key_file = ' + iniEscape(payload.privateKey));
  if (obscuredKeyPass) lines.push('key_file_pass = ' + obscuredKeyPass);
  return lines.join('\n') + '\n';
}

ipcMain.handle('drive:requirements', () => {
  const rclone = findRclone();
  const winfsp = findWinFsp();
  const sshfs = findSshfs();
  return { ok: true, rclone: Boolean(rclone), winfsp: Boolean(winfsp), sshfs: Boolean(sshfs), rclonePath: rclone || '', winfspPath: winfsp || '', sshfsPath: sshfs || '' };
});

ipcMain.handle('drive:installRclone', async () => {
  try {
    const installedDir = path.join(app.getPath('userData'), 'tools', 'rclone');
    fs.rmSync(installedDir, { recursive: true, force: true });
    fs.mkdirSync(installedDir, { recursive: true });
    const buf = await fetchTextOnce('https://downloads.rclone.org/rclone-current-windows-amd64.zip', 180000, true);
    if (buf.length > 100 * 1024 * 1024) throw new Error('Arsip rclone terlalu besar.');
    const zip = new AdmZip(buf);
    zip.extractAllTo(installedDir, true);
    const exe = findExecutableRecursive(installedDir, 'rclone.exe');
    if (!exe) throw new Error('rclone.exe tidak ditemukan di arsip.');
    return { ok: true, path: exe, message: 'rclone berhasil terpasang di ' + path.dirname(exe) };
  } catch (err) {
    return { ok: false, error: 'Gagal install rclone: ' + err.message };
  }
});

ipcMain.handle('drive:installWinFsp', async () => {
  try {
    const releases = await fetchJsonOnce('https://api.github.com/repos/winfsp/winfsp/releases/latest');
    const asset = (releases.assets || []).find((item) => /\.msi$/i.test(item.name) && !/tests?/i.test(item.name));
    if (!asset) throw new Error('Paket MSI WinFsp tidak ditemukan di rilis terbaru.');
    const tempPath = path.join(os.tmpdir(), 'winfsp-latest.msi');
    const buf = await fetchTextOnce(asset.browser_download_url, 240000, true);
    if (buf.length > 100 * 1024 * 1024) throw new Error('Paket WinFsp terlalu besar.');
    fs.writeFileSync(tempPath, buf);
    const command = 'Start-Process -FilePath msiexec.exe -ArgumentList \'/i "' + tempPath + '" /quiet /norestart\' -Verb RunAs -Wait -PassThru | exit $_.ExitCode';
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      timeout: 600000,
      stdio: 'ignore'
    });
    const installed = findWinFsp();
    if (!installed) throw new Error('WinFsp selesai dipasang tetapi belum terdeteksi. Coba restart aplikasi.');
    return { ok: true, path: installed, message: 'WinFsp berhasil terpasang.' };
  } catch (err) {
    return { ok: false, error: 'Gagal install WinFsp: ' + err.message };
  }
});

ipcMain.handle('drive:map', async (event, payload) => {
  try {
    if (process.platform !== 'win32') return { ok: false, error: 'Map drive hanya tersedia di Windows.' };
    const drive = String(payload.drive || '').trim().toUpperCase().replace(/:$/, '');
    if (!/^[A-Z]$/.test(drive)) return { ok: false, error: 'Pilih drive valid, mis. G:.' };
    if (isDriveInUse(drive)) return { ok: false, error: 'Drive ' + drive + ': sudah dipakai.' };
    const remotePath = String(payload.remotePath || '').trim();
    if (!remotePath) return { ok: false, error: 'Path VPS tidak valid.' };
    if (payload.method === 'smb') {
      const unc = String(payload.unc || '').trim();
      const user = String(payload.username || '').trim();
      const password = String(payload.password || '');
      if (!/^\\\\[^\\]+\\[^\\]+/.test(unc)) return { ok: false, error: 'UNC share tidak valid. Contoh: \\\\10.10.10.2\\data\\project' };
      if (!user) return { ok: false, error: 'Username SMB wajib diisi.' };
      const args = ['use', drive + ':', unc];
      if (password) args.push(password);
      args.push('/USER:' + user);
      args.push('/PERSISTENT:' + (payload.persistent ? 'YES' : 'NO'));
      const result = spawnSync('net.exe', args, { windowsHide: true, encoding: 'utf8' });
      const out = ((result.stdout || '') + '\n' + (result.stderr || '')).trim();
      if (result.status !== 0) return { ok: false, error: out || 'Gagal memakai net use.' };
      const mappings = readDriveMappings().filter((item) => item.drive !== drive);
      mappings.push({ drive, method: 'smb', unc, username: user, created: new Date().toISOString() });
      writeDriveMappings(mappings);
      return { ok: true, drive, message: out || ('Drive ' + drive + ': berhasil dipasang.') };
    }

    if (payload.method === 'sshfs') {
      const host = String(payload.host || '').trim();
      const user = String(payload.username || '').trim();
      if (!host || !user) return { ok: false, error: 'Host dan username wajib diisi.' };
      const password = String(payload.password || '');
      const port = Number(payload.port) || 22;
      const sshfsExe = findSshfs();
      if (!sshfsExe) {
        return { ok: false, error: 'SSHFS-Win tidak ditemukan. Install dari https://github.com/winfsp/sshfs-win/releases lalu coba lagi.' };
      }
      if (!findWinFsp()) {
        return { ok: false, error: 'WinFsp tidak ditemukan. Install dari https://github.com/winfsp/winfsp/releases lalu coba lagi.' };
      }
      // Path absolute VPS (root) -> PATH di UNC (relatif terhadap /).
      const cleanPath = remotePath.replace(/^[/\\]+|[/\\]+$/g, '').split(/[/\\]+/).filter(Boolean).join('\\');
      // Tanpa password: key auth (.kr) memakai %USERPROFILE%\\.ssh\\id_rsa. Dengan password: auth password (.r).
      const suffix = password ? 'r' : 'kr';
      const prefix = '\\sshfs.' + suffix + '\\' + user + '@' + host + '!' + port + (cleanPath ? '\\' + cleanPath : '');
      const args = ['svc', prefix, drive + ':'];
      if (password) args.push('-o', 'password_stdin');
      const result = spawnSync(sshfsExe, args, {
        input: password ? password + '\n' : '',
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30000
      });
      if (result.error) return { ok: false, error: 'Gagal menjalankan SSHFS-Win: ' + result.error.message };
      if (result.status !== 0) {
        const detail = ((result.stderr || '') + '\n' + (result.stdout || '')).trim();
        const hint = password
          ? 'Cek host, port, dan password.'
          : 'Tanpa password, SSHFS-Win memakai key %USERPROFILE%\\.ssh\\id_rsa (tanpa passphrase). Isi password SSH untuk auth password.';
        return { ok: false, error: 'Gagal mount SSHFS-Win. ' + (detail ? detail.split('\n').filter(Boolean).slice(-1)[0] : hint) };
      }
      const mappings = readDriveMappings().filter((item) => item.drive !== drive);
      mappings.push({
        drive,
        method: 'sshfs',
        host,
        port,
        username: user,
        remotePath,
        created: new Date().toISOString()
      });
      writeDriveMappings(mappings);
      return { ok: true, drive, message: 'Drive ' + drive + ': berhasil dipasang (SSHFS-Win).' };
    }

    if (payload.method !== 'rclone') return { ok: false, error: 'Metode tidak dikenal.' };
    const host = String(payload.host || '').trim();
    const user = String(payload.username || '').trim();
    if (!host || !user) return { ok: false, error: 'Host dan username wajib diisi.' };
    const password = String(payload.password || '');
    const privateKey = String(payload.privateKey || '').trim();
    if (privateKey && !fs.existsSync(privateKey)) return { ok: false, error: 'File private key tidak ditemukan: ' + privateKey };

    const rclone = findRclone();
    if (!rclone) {
      return { ok: false, error: 'rclone tidak ditemukan. Install dari https://rclone.org/downloads/ lalu coba lagi.' };
    }
    const winfsp = findWinFsp();
    if (!winfsp) {
      return { ok: false, error: 'WinFsp tidak ditemukan. Install dari https://github.com/winfsp/winfsp/releases lalu coba lagi.' };
    }

    const obscurePtr = (value) => execFileSync(rclone, ['obscure', value], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 64 * 1024
    }).trim();

    let obscuredPass = '';
    let obscuredKeyPass = '';
    try {
      if (password) obscuredPass = obscurePtr(password);
      if (privateKey && password) obscuredKeyPass = obscurePtr(password);
    } catch (err) {
      return { ok: false, error: 'Gagal mengencode password untuk rclone: ' + err.message };
    }

    const remoteName = 'sahabat-' + drive.toLowerCase();
    const configDir = path.join(driveMappingDir(), drive);
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(configDir, 0o700); } catch {}
    const configPath = path.join(configDir, 'rclone.conf');
    const logPath = path.join(configDir, 'mount.log');
    fs.writeFileSync(configPath, buildRcloneConfig(remoteName, {
      host,
      username: user,
      port: Number(payload.port) || 22,
      privateKey
    }, obscuredPass, obscuredKeyPass), { mode: 0o600 });
    try { fs.chmodSync(configPath, 0o600); } catch {}

    const args = [
      'mount',
      remoteName + ':' + remotePath,
      drive + ':',
      '--network-mode',
      '--volname', 'Sahabat VPS',
      '--vfs-cache-mode', String(payload.cacheMode || 'full'),
      '--config', configPath,
      '--log-level', 'INFO'
    ];
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(rclone, args, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd]
    });
    fs.closeSync(logFd);
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (child.exitCode !== null) {
      let detail = '';
      try { detail = fs.readFileSync(logPath, 'utf8').slice(-2000); } catch {}
      return { ok: false, error: 'rclone keluar dengan error. ' + (detail || 'Cek koneksi dan kredensial Anda.') };
    }
    const mappings = readDriveMappings().filter((item) => item.drive !== drive);
    mappings.push({
      drive,
      method: 'rclone',
      pid: child.pid,
      host,
      port: Number(payload.port) || 22,
      username: user,
      remotePath,
      config: configPath,
      created: new Date().toISOString()
    });
    writeDriveMappings(mappings);
    return { ok: true, drive, message: 'Drive ' + drive + ': akan segera tampil. Jika belum muncul, cek log di ' + logPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('drive:unmap', async (event, driveInput) => {
  try {
    if (process.platform !== 'win32') return { ok: false, error: 'Hanya tersedia di Windows.' };
    const drive = String(driveInput || '').trim().toUpperCase().replace(/:$/, '');
    if (!/^[A-Z]$/.test(drive)) return { ok: false, error: 'Drive tidak valid.' };
    const mappings = readDriveMappings();
    const mapping = mappings.find((item) => item.drive === drive);
    let ok = false;
    let output = '';

    if (mapping && mapping.method === 'rclone') {
      const rclone = findRclone();
      if (rclone && mapping.config && fs.existsSync(mapping.config)) {
        const result = spawnSync(rclone, ['unmount', drive + ':', '--config', mapping.config], { windowsHide: true, encoding: 'utf8' });
        ok = result.status === 0;
        output = ((result.stdout || '') + '\n' + (result.stderr || '')).trim();
      }
      if (mapping.pid) {
        try { process.kill(mapping.pid); ok = true; } catch {}
      }
      const fallback = spawnSync('net.exe', ['use', drive + ':', '/delete', '/Y'], { windowsHide: true, encoding: 'utf8' });
      output = output || ((fallback.stdout || '') + '\n' + (fallback.stderr || '')).trim();
      ok = ok || fallback.status === 0;
      if (mapping.config) { try { fs.unlinkSync(mapping.config); } catch {} }
    } else {
      const result = spawnSync('net.exe', ['use', drive + ':', '/delete', '/Y'], { windowsHide: true, encoding: 'utf8' });
      ok = result.status === 0;
      output = ((result.stdout || '') + '\n' + (result.stderr || '')).trim();
    }

    if (!ok) return { ok: false, error: output || 'Gagal unmount drive ' + drive + ':' };
    writeDriveMappings(mappings.filter((item) => item.drive !== drive));
    return { ok: true, message: 'Drive ' + drive + ': dilepas.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- Menu bar ala VS Code (File / Edit / View / Terminal / Help) ----------
let openTerminals = []; // diset renderer via menu:syncTerminals

function sendToRenderer(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function buildAppMenu() {
  const tabs = openTerminals;
  const terminalTabItems = tabs.length
    ? tabs.map((t) => ({
        label: (t.kind === 'ssh' ? 'SSH · ' : 'Lokal · ') + t.label,
        type: 'radio',
        checked: Boolean(t.active),
        click: () => sendToRenderer('menu:event', { action: 'focusTerminal', uid: t.uid }),
      }))
    : [{ label: '(tidak ada terminal)', enabled: false }];

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'Ctrl+K Ctrl+O', click: () => sendToRenderer('menu:event', { action: 'openFolder' }) },
        { label: 'Clone Repository…', click: () => sendToRenderer('menu:event', { action: 'cloneRepo' }) },
        { type: 'separator' },
        { label: 'Save File', accelerator: 'Ctrl+S', click: () => sendToRenderer('menu:event', { action: 'save' }) },
        { type: 'separator' },
        { role: 'quit', label: 'Keluar' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo', label: 'Undo' },
        { role: 'redo', label: 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: 'Cut' },
        { role: 'copy', label: 'Copy' },
        { role: 'paste', label: 'Paste' },
        { role: 'selectAll', label: 'Select All' },
        { type: 'separator' },
        { label: 'Panduan Shortcut Chat', accelerator: 'Ctrl+Alt+H', click: () => sendToRenderer('menu:event', { action: 'shortcutGuide' }) },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Chat', click: () => sendToRenderer('menu:event', { action: 'view', view: 'chat' }) },
        { label: 'Workspace Developer', click: () => sendToRenderer('menu:event', { action: 'view', view: 'workspace' }) },
        { label: 'Models', click: () => sendToRenderer('menu:event', { action: 'view', view: 'models' }) },
        { label: 'API & Snippet', click: () => sendToRenderer('menu:event', { action: 'view', view: 'api' }) },
        { label: 'Extensions', click: () => sendToRenderer('menu:event', { action: 'view', view: 'extensions' }) },
        { type: 'separator' },
        { label: 'Toggle Sidebar (Explorer)', accelerator: 'Ctrl+B', click: () => sendToRenderer('menu:event', { action: 'toggleSidebar' }) },
        { label: 'Toggle Agent Panel', accelerator: 'Ctrl+J', click: () => sendToRenderer('menu:event', { action: 'toggleAgent' }) },
        { label: 'Toggle Terminal', accelerator: 'Ctrl+`', click: () => sendToRenderer('menu:event', { action: 'toggleTerminal' }) },
        { type: 'separator' },
        { role: 'reload', label: 'Reload Window' },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        { label: 'New Terminal', accelerator: 'Ctrl+`', click: () => sendToRenderer('menu:event', { action: 'newTerminal' }) },
        { label: 'Split Terminal', accelerator: 'Ctrl+Shift+5', click: () => sendToRenderer('menu:event', { action: 'splitTerminal' }) },
        { type: 'separator' },
        { label: 'Run Active File', accelerator: 'Ctrl+Alt+R', click: () => sendToRenderer('menu:event', { action: 'runActiveFile' }) },
        { label: 'Run Selected Text', accelerator: 'Ctrl+Alt+N', click: () => sendToRenderer('menu:event', { action: 'runSelectedText' }) },
        { type: 'separator' },
        { label: 'Kill Terminal', accelerator: 'Ctrl+Shift+K', click: () => sendToRenderer('menu:event', { action: 'killTerminal' }) },
        { label: 'Clear Terminal', click: () => sendToRenderer('menu:event', { action: 'clearTerminal' }) },
        { label: 'Close Terminal Panel', click: () => sendToRenderer('menu:event', { action: 'closeTerminalPanel' }) },
        { type: 'separator' },
        ...terminalTabItems,
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Tentang SahabatMobile', click: () => sendToRenderer('menu:event', { action: 'about' }) },
        { type: 'separator' },
        { label: 'Website SahabatMobile', click: () => shell.openExternal('https://www.sahabatmobile.com') },
        { label: 'Dokumentasi', click: () => shell.openExternal('https://www.sahabatmobile.com/docs') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on('menu:syncTerminals', (event, list) => {
  openTerminals = (Array.isArray(list) ? list : []).slice(0, 12).map((t) => ({
    uid: String((t && t.uid) || ''),
    label: String((t && t.label) || '').slice(0, 60),
    kind: (t && t.kind === 'ssh') ? 'ssh' : 'local',
    active: Boolean(t && t.active),
  })).filter((t) => t.uid);
  buildAppMenu();
});

// ---------- database connections (MySQL/MariaDB, PostgreSQL, SQLite, SQL Server, MongoDB, Redis, Elasticsearch) ----------
const dbSessions = new Map();
let dbSeq = 0;

function mustDbSession(id) {
  const s = dbSessions.get(String(id || ''));
  if (!s) throw new Error('Sesi database tidak ditemukan atau sudah diputus.');
  return s;
}

function dbLabel(p) {
  const kind = normalizeProfileProtocol(p.protocol || p.kind);
  if (kind === 'sqlite') return 'SQLITE · ' + path.basename(p.filePath || '');
  const user = p.user || p.username || '';
  return kind.toUpperCase() + ' · ' + (user ? user + '@' : '') + (p.host || '') + ':' + (Number(p.port) || defaultPortOf(kind));
}

function dbWrap(run) {
  return async (event, payload) => {
    try {
      return await run(payload || {});
    } catch (err) {
      return { ok: false, error: (err && err.message) ? err.message : String(err) };
    }
  };
}

ipcMain.handle('db:connect', dbWrap(async (cfg) => {
  cfg = cfg || {};
  const kind = normalizeProfileProtocol(cfg.protocol || cfg.kind);
  if (!dbEngine.isDbProtocol(kind)) throw new Error('Tipe koneksi tidak didukung: ' + (cfg.protocol || ''));
  // Hubungkan ulang profil tersimpan (untuk target dropdown).
  if (cfg.connectionId) {
    const profile = readConnectionProfile(String(cfg.connectionId));
    if (!profile) throw new Error('Koneksi tersimpan tidak ditemukan.');
    const session = await dbEngine.createSession(profile);
    const id = 'db' + (++dbSeq);
    dbSessions.set(id, session);
    updateConnectionLastConnected(profile.id);
    return { ok: true, id, type: 'db', label: dbLabel(profile), protocol: profile.protocol, host: profile.host, port: profile.port, username: profile.username, savedId: profile.id };
  }
  const session = await dbEngine.createSession({ ...cfg, kind });
  const id = 'db' + (++dbSeq);
  dbSessions.set(id, session);
  let saved = null;
  if (cfg.saveConnection) saved = saveConnectionProfile({ ...cfg, protocol: kind, port: Number(cfg.port) || defaultPortOf(kind) });
  return {
    ok: true, id, type: 'db',
    label: dbLabel({ ...cfg, protocol: kind, port: Number(cfg.port) || defaultPortOf(kind) }),
    protocol: kind, host: cfg.host, port: Number(cfg.port) || defaultPortOf(kind), username: cfg.user || cfg.username || '',
    savedId: saved ? saved.id : undefined,
  };
}));

ipcMain.handle('db:disconnect', dbWrap(async (payload) => {
  const id = String(payload.id || '');
  const s = dbSessions.get(id);
  if (s) { try { await dbEngine.closeSession(s); } catch {} dbSessions.delete(id); }
  return { ok: true };
}));

ipcMain.handle('db:listDatabases', dbWrap(async (payload) => dbEngine.listDatabases(mustDbSession(payload.id))));

ipcMain.handle('db:listTables', dbWrap(async (payload) => dbEngine.listTables(mustDbSession(payload.id), payload.database)));

ipcMain.handle('db:runQuery', dbWrap(async (payload) => dbEngine.runQuery(mustDbSession(payload.id), payload.database, payload.sql)));

ipcMain.handle('db:redisValue', dbWrap(async (payload) => dbEngine.redisKeyValue(mustDbSession(payload.id), String(payload.key || ''))));

ipcMain.handle('dialog:openFile', async (event, options) => {
  const opts = options || {};
  const result = await dialog.showOpenDialog({
    title: opts.title || 'Pilih file',
    properties: ['openFile'],
    filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : [{ name: 'Semua file', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, cancelled: true };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('dialog:saveCsv', async (event, payload) => {
  const content = String((payload && payload.content) || '');
  const result = await dialog.showSaveDialog({
    title: 'Export CSV',
    defaultPath: (payload && payload.defaultPath) || 'export.csv',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { ok: true, path: result.filePath };
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1020,
    minHeight: 640,
    backgroundColor: '#0f1115',
    title: 'SahabatMobile Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile('index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.argv.includes('--smoke-test')) {
    win.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log('[renderer:' + level + '] ' + message + ' (' + sourceId + ':' + line + ')');
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const tf = path.join(os.tmpdir(), 'sahabat-smoke-entry');
          fs.rmSync(tf, { recursive: true, force: true });
          fs.mkdirSync(path.join(tf, 'sub'), { recursive: true });
          fs.writeFileSync(path.join(tf, 'a.txt'), 'data-a');
          const smokeProfileId = 'smoke-edit-conn';
          const smokeSettings = readSettings();
          const smokeConnections = Array.isArray(smokeSettings.connections) ? smokeSettings.connections : [];
          smokeSettings.connections = smokeConnections.filter((p) => p.id !== smokeProfileId);
          smokeSettings.connections.push({
            id: smokeProfileId,
            name: 'Smoke Edit',
            protocol: 'sftp',
            host: '127.0.0.1',
            port: 22,
            username: 'smoke',
            authType: 'password',
            privateKey: '',
            password: encryptSecret('secret'),
            lastConnected: null
          });
          writeSettings(smokeSettings);
          const result = await win.webContents.executeJavaScript(`(async () => {
            const out = {};
            out.ace = typeof window.ace;
            out.term = typeof window.Terminal;
            document.querySelector('[data-view="workspace"]').click();
            await new Promise(r => setTimeout(r, 800));
            out.aceContent = !!document.querySelector('#editor .ace_content');
            out.agentPanel = !!document.querySelector('#agentLog');
            out.activity = document.querySelectorAll('.act').length;
            out.sidepanel = !!document.querySelector('#explorerPane');
            out.resizerLeft = !!document.querySelector('#resizeLeft');
            out.resizerAgent = !!document.querySelector('#resizeAgent');
            out.sideWidth = document.querySelector('#sidepanel').style.width;
            out.agentWidth = getComputedStyle(document.documentElement).getPropertyValue('--agent-width').trim();
            document.querySelector('[data-view="extensions"]').click();
            await new Promise(r => setTimeout(r, 3500));
            out.extView = !document.querySelector('#view-extensions').classList.contains('hidden');
            out.extensionRows = document.querySelectorAll('#extList .ext-side-item').length;
            out.extensionDetail = !!document.querySelector('#extDetail h1') || !!document.querySelector('#extDetail .ext-detail-header');
            out.extFilter = !!document.querySelector('#extFilter');
            document.getElementById('extSearch').value = 'python snippets';
            document.getElementById('extSearch').dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 3500));
            out.marketRows = document.querySelectorAll('#extList .ext-side-item').length;
            const openVsxSearch = await window.sahabat.extSearchOpenVsx('python snippets');
            out.openVsxResults = openVsxSearch.ok ? openVsxSearch.extensions.length : -1;
            const beforeExtensions = await window.sahabat.extList();
            out.catalog = beforeExtensions.catalog.length;
            const testId = 'ericsia.pythonsnippets3';
            const hadOpenVsxTest = beforeExtensions.extensions.some(e => e.id.toLowerCase() === testId);
            if (!hadOpenVsxTest) {
              const installed = await window.sahabat.extInstallOpenVsx({ namespace: 'EricSia', name: 'pythonsnippets3', version: '3.3.18' });
              const afterInstall = await window.sahabat.extList();
              const updates = await window.sahabat.extCheckUpdates();
              const removed = await window.sahabat.extRemove('ericsia.pythonsnippets3');
              out.openVsxTest = {
                ok: installed.ok,
                error: installed.error || '',
                listed: afterInstall.extensions.some(e => e.id.toLowerCase() === testId),
                updateCheck: updates.ok ? updates.checked : -1,
                removed: removed.ok
              };
            } else {
              out.openVsxTest = 'already-installed';
            }
            const hadPythonPack = beforeExtensions.extensions.some(e => e.id === 'python-pack');
            if (!hadPythonPack) {
              const installed = await window.sahabat.extInstallBuiltin('python-pack');
              const afterInstall = await window.sahabat.extList();
              const removed = await window.sahabat.extRemove('python-pack');
              out.installTest = {
                ok: installed.ok,
                error: installed.error || '',
                listed: afterInstall.extensions.some(e => e.id === 'python-pack'),
                removed: removed.ok
              };
            } else {
              out.installTest = 'already-installed';
            }
            document.querySelector('[data-view="workspace"]').click();
            await new Promise(r => setTimeout(r, 350));
            const ed = ace.edit(document.getElementById('editor'));
            ed.setValue('hello');
            ed.navigateFileEnd();
            ed.insert(' world');
            out.editValue = ed.getValue();
            out.readOnly = ed.getReadOnly();
            out.editable = ed.getValue() === 'hello world';
            document.getElementById('editor').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 120 }));
            await new Promise(r => setTimeout(r, 60));
            out.editorMenu = Array.from(document.querySelectorAll('#contextMenu .context-item')).map(b => b.textContent);
            document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            document.getElementById('fileTree').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 220, clientY: 260 }));
            await new Promise(r => setTimeout(r, 60));
            out.treeMenu = Array.from(document.querySelectorAll('#contextMenu .context-item')).map(b => b.textContent);
            document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            out.mapModal = !!document.querySelector('#mapModal');
            out.mapMethodDefault = (document.querySelector('#mapMethod') || {}).value || '';
            out.mapInstallSshfs = !!document.querySelector('#mapInstallSshfs');
            out.dbProtocolOptions = document.querySelectorAll('#connProtocol option').length;
            out.dbApis = ['dbConnect','dbDisconnect','dbListDatabases','dbListTables','dbRunQuery','dbRedisValue'].map(k => typeof window.sahabat[k]).join(',');
            out.mapRoot = !!document.querySelector('#mapRoot');
            out.mapDriveTop = !!document.querySelector('#mapDriveTop');
            out.connectionsModal = !!document.querySelector('#connectionsModal');
            out.sshDisconnectTop = !!document.querySelector('#sshDisconnectTop');
            out.mapRootOption = !!document.querySelector('.map-root-option');
            out.savedConnectionsButton = !!document.querySelector('#savedConnections');
            out.savedTargetOptions = document.querySelectorAll('#targetSelect optgroup[label="Tersimpan"] option').length;
            const mapRequirements = await window.sahabat.mapRequirements();
            out.mapRequirements = { rclone: mapRequirements.rclone, winfsp: mapRequirements.winfsp, sshfs: mapRequirements.sshfs };
            const savedList = await window.sahabat.listConnections();
            out.savedList = savedList.ok ? savedList.connections.length : -1;
            const missingSaved = await window.sahabat.connectSaved('smoke-missing-id');
            out.missingSavedError = missingSaved.error || '';
            const smbValidation = await window.sahabat.mapDrive({ method: 'bogus', drive: 'Z', remotePath: '/', username: 'smoke' });
            out.smbValidationError = smbValidation.error || '';
            out.uploadApi = typeof window.sahabat.uploadEntry;
            out.downloadApi = typeof window.sahabat.downloadEntry;
            out.chatAttach = !!document.querySelector('#attachChat');
            out.newChatButton = !!document.querySelector('#newChat');
            out.updateBadge = !!document.querySelector('#updateBadge');
            out.updateApi = typeof window.sahabat.checkUpdate;
            out.connectionEditApi = typeof window.sahabat.updateConnection + '/' + typeof window.sahabat.getConnection;
            out.connectionEditUi = !!document.querySelector('#connSaveOnly') + '/' + !!document.querySelector('#editConnectionTop');
            const missingConn = await window.sahabat.getConnection('smoke-missing-id');
            out.missingConnError = missingConn.error || '';
            const upd = await window.sahabat.checkUpdate();
            out.update = { ok: upd.ok, noFeed: !!upd.noFeed, current: upd.current, hasUpdate: !!upd.hasUpdate };
            const connGet = await window.sahabat.getConnection('smoke-edit-conn');
            out.connEditGet = { ok: connGet.ok, name: connGet.connection && connGet.connection.name, hasPassword: !!(connGet.connection && connGet.connection.hasPassword) };
            const connUpd = await window.sahabat.updateConnection({ id: 'smoke-edit-conn', protocol: 'sftp', name: 'Smoke Edited', host: '127.0.0.2', port: 2222, username: 'smoke2', authType: 'password', privateKey: '', password: '' });
            out.connEditUpdate = { ok: connUpd.ok, name: connUpd.connection && connUpd.connection.name, host: connUpd.connection && connUpd.connection.host, port: connUpd.connection && connUpd.connection.port };
            const connAfter = await window.sahabat.getConnection('smoke-edit-conn');
            out.connEditKeptPassword = !!(connAfter.connection && connAfter.connection.hasPassword);
            const connRemove = await window.sahabat.removeConnection('smoke-edit-conn');
            out.connEditRemoved = connRemove.ok;
            out.mapApi = typeof window.sahabat.mapDrive;
            out.unmapApi = typeof window.sahabat.unmapDrive;
            out.clipboardApi = typeof window.sahabat.readClipboard;
            out.entryApi = typeof window.sahabat.entryCopy + '/' + typeof window.sahabat.entryMove;
            out.searchbox = typeof ace.require('ace/ext/searchbox');
            out.snipMod = Object.keys(ace.require('ace/snippets') || {});
            out.langTools = Object.keys(ace.require('ace/ext/language_tools') || {});
            const tf = ${JSON.stringify(tf)};
            const tgt = { type: 'local', id: null };
            const cp = await window.sahabat.entryCopy({ srcTarget: tgt, srcPath: tf + '\\\\a.txt', dstTarget: tgt, dstDir: tf + '\\\\sub', isDir: false });
            const mv = await window.sahabat.entryMove({ srcTarget: tgt, srcPath: tf + '\\\\a.txt', dstTarget: tgt, dstPath: tf + '\\\\b.txt', isDir: false });
            out.fileOps = { cp: cp.ok, mv: mv.ok, cpErr: cp.error || '', mvErr: mv.error || '' };
            ed.focus();
            ed.navigateFileEnd();
            out.focused = ed.isFocused();
            return out;
          })()`);
          win.webContents.sendInputEvent({ type: 'char', keyCode: 'X' });
          win.webContents.sendInputEvent({ type: 'char', keyCode: 'Y' });
          await new Promise((r) => setTimeout(r, 200));
          result.typedValue = await win.webContents.executeJavaScript(`ace.edit(document.getElementById('editor')).getValue()`);
          result.typedOk = String(result.typedValue).endsWith('XY');
          const prevClip = clipboard.readText();
          await win.webContents.executeJavaScript(`(() => { const ed = ace.edit(document.getElementById('editor')); ed.focus(); ed.selectAll(); return true; })()`);
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
          await new Promise((r) => setTimeout(r, 200));
          result.copyOk = clipboard.readText() === 'hello worldXY';
          clipboard.writeText('ZZZ');
          await win.webContents.executeJavaScript(`(() => { const ed = ace.edit(document.getElementById('editor')); ed.focus(); ed.navigateFileEnd(); return true; })()`);
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Control' });
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' });
          await new Promise((r) => setTimeout(r, 200));
          result.pasteOk = String(await win.webContents.executeJavaScript(`ace.edit(document.getElementById('editor')).getValue()`)).endsWith('ZZZ');
          clipboard.writeText(prevClip);
          result.fileOps.moved = fs.readFileSync(path.join(tf, 'b.txt'), 'utf8') === 'data-a';
          result.fileOps.copied = fs.readFileSync(path.join(tf, 'sub', 'a.txt'), 'utf8') === 'data-a';
          fs.rmSync(tf, { recursive: true, force: true });
          result.fileOps.cleaned = !fs.existsSync(tf);
          console.log('SMOKE_RESULT ' + JSON.stringify(result));
        } catch (err) {
          console.log('SMOKE_ERR ' + err.message);
        }
        app.quit();
      }, 2500);
    });
  }
}

function send(channel, payload) {
  const wins = BrowserWindow.getAllWindows();
  if (wins[0] && !wins[0].isDestroyed()) wins[0].webContents.send(channel, payload);
}

function resolveInRoot(target) {
  if (!workspaceRoot) throw new Error('Folder kerja belum dibuka.');
  const abs = path.resolve(workspaceRoot, target || '.');
  const rel = path.relative(workspaceRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path di luar folder kerja.');
  return abs;
}

function assertTextBuffer(buf, label) {
  if (buf.length > MAX_READ) throw new Error(label + ' terlalu besar (maks 5 MB).');
  if (buf.includes(0)) throw new Error(label + ' terdeteksi biner, tidak bisa dibuka di editor.');
  return buf.toString('utf8');
}

async function buildTree(dir, depth) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries = entries.filter((e) => !IGNORED_DIRS.has(e.name));
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const nodes = [];
  for (const entry of entries.slice(0, 400)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path: full, dir: true, children: await buildTree(full, depth + 1) });
    } else {
      nodes.push({ name: entry.name, path: full, dir: false });
    }
  }
  return nodes;
}

function localShell() {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-i'] };
}

function runShellCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const sh = localShell();
    const args = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-Command', command]
      : ['-lc', command];
    let child;
    try {
      child = spawn(sh.file, args, { cwd: cwd || workspaceRoot || os.homedir(), env: process.env, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: err.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      stderr += '\n[timeout] perintah dihentikan setelah ' + Math.round(timeoutMs / 1000) + ' detik.';
    }, timeoutMs || 120000);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); if (stderr.length > 200000) stderr = stderr.slice(-200000); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function rmTree(dir) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) rmTree(p);
      else fs.unlinkSync(p);
    }
    fs.rmdirSync(dir);
  } catch {}
}

// ---------- remote (SSH/SFTP + FTP) ----------

function getRemote(id) {
  const session = remotes.get(id);
  if (!session) throw new Error('Koneksi remote tidak ditemukan.');
  return session;
}

async function remoteList(session, dir) {
  const target = dir || session.home || '.';
  if (session.type === 'ssh') {
    const entries = await new Promise((resolve, reject) => {
      session.sftp.readdir(target, (err, list) => (err ? reject(err) : resolve(list)));
    });
    return entries
      .filter((e) => !IGNORED_DIRS.has(e.filename) && e.filename !== '.' && e.filename !== '..')
      .sort((a, b) => Number(b.attrs.isDirectory()) - Number(a.attrs.isDirectory()) || a.filename.localeCompare(b.filename))
      .slice(0, 800)
      .map((e) => ({ name: e.filename, path: posix.join(target, e.filename), dir: e.attrs.isDirectory() }));
  }
  const entries = await session.client.list(target);
  return entries
    .filter((e) => !IGNORED_DIRS.has(e.name) && e.name !== '.' && e.name !== '..')
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
    .slice(0, 800)
    .map((e) => ({ name: e.name, path: posix.join(target, e.name), dir: e.isDirectory }));
}

async function remoteRead(session, filePath) {
  if (session.type === 'ssh') {
    const buf = await new Promise((resolve, reject) => {
      session.sftp.readFile(filePath, (err, data) => (err ? reject(err) : resolve(data)));
    });
    return assertTextBuffer(buf, 'File remote');
  }
  const tmp = path.join(os.tmpdir(), 'sahabat-dl-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  try {
    await session.client.downloadTo(tmp, filePath);
    const buf = await fs.promises.readFile(tmp);
    return assertTextBuffer(buf, 'File remote');
  } finally {
    try { await fs.promises.unlink(tmp); } catch {}
  }
}

async function remoteWrite(session, filePath, content) {
  if (session.type === 'ssh') {
    await new Promise((resolve, reject) => {
      session.sftp.writeFile(filePath, String(content ?? ''), 'utf8', (err) => (err ? reject(err) : resolve()));
    });
    return;
  }
  const tmp = path.join(os.tmpdir(), 'sahabat-ul-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const prev = await session.client.pwd();
  try {
    await fs.promises.writeFile(tmp, String(content ?? ''), 'utf8');
    const parent = posix.dirname(filePath);
    if (parent && parent !== '.' && parent !== '/') {
      try { await session.client.ensureDir(parent); } catch {}
    }
    await session.client.uploadFrom(tmp, filePath);
  } finally {
    try { await session.client.cd(prev); } catch {}
    try { await fs.promises.unlink(tmp); } catch {}
  }
}

async function remoteMkdir(session, dirPath) {
  if (session.type === 'ssh') {
    await new Promise((resolve, reject) => session.sftp.mkdir(dirPath, (err) => (err ? reject(err) : resolve())));
    return;
  }
  const prev = await session.client.pwd();
  try {
    await session.client.ensureDir(dirPath);
  } finally {
    try { await session.client.cd(prev); } catch {}
  }
}

async function remoteRemove(session, filePath, isDir) {
  if (session.type === 'ssh') {
    await new Promise((resolve, reject) => {
      const cb = (err) => (err ? reject(err) : resolve());
      if (isDir) session.sftp.rmdir(filePath, cb);
      else session.sftp.unlink(filePath, cb);
    });
    return;
  }
  if (isDir) await session.client.removeDir(filePath);
  else await session.client.remove(filePath);
}

function remoteCommand(session, command, cwd, timeoutMs) {
  if (session.type !== 'ssh') {
    return Promise.resolve({ code: -1, output: 'FTP tidak mendukung eksekusi perintah. Gunakan terminal lokal atau koneksi SSH.' });
  }
  return new Promise((resolve) => {
    const full = cwd ? "cd '" + String(cwd).replace(/'/g, "'\\''") + "' && " + command : command;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ code: -1, output: '[timeout] perintah remote dihentikan.' });
      }
    }, timeoutMs || 120000);
    session.client.exec(full, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        resolve({ code: -1, output: err.message });
        return;
      }
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      stream.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, output: (stdout + (stderr ? '\n[stderr]\n' + stderr : '')).slice(0, 100000) || '(tanpa output)' });
      });
    });
  });
}

function resolveAgentTarget(target) {
  if (target && target.id) {
    const session = getRemote(target.id);
    return { kind: 'remote', session, type: session.type };
  }
  return { kind: 'local' };
}

// ---------- generic entry operations (local + remote) ----------

function targetSession(target) {
  if (target && target.id) return getRemote(target.id);
  return null;
}

function isRemoteTarget(target) {
  return Boolean(target && target.id);
}

function joinForRemote(remote, dir, name) {
  return remote ? posix.join(dir, name) : path.join(dir, name);
}

function basenameForRemote(remote, p) {
  return remote ? posix.basename(p) : path.basename(p);
}

function dirnameForRemote(remote, p) {
  return remote ? posix.dirname(p) : path.dirname(p);
}

async function listRaw(session, dir) {
  if (!session) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }));
  }
  return remoteList(session, dir);
}

async function readRaw(session, filePath) {
  if (!session) return fs.promises.readFile(filePath);
  if (session.type === 'ssh') {
    return new Promise((resolve, reject) => {
      session.sftp.readFile(filePath, (err, data) => (err ? reject(err) : resolve(data)));
    });
  }
  const tmp = path.join(os.tmpdir(), 'sahabat-rc-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  try {
    await session.client.downloadTo(tmp, filePath);
    return await fs.promises.readFile(tmp);
  } finally {
    try { await fs.promises.unlink(tmp); } catch {}
  }
}

async function writeRaw(session, filePath, buffer) {
  if (!session) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, buffer);
    return;
  }
  if (session.type === 'ssh') {
    const parent = posix.dirname(filePath);
    if (parent && parent !== '/' && parent !== '.') {
      await new Promise((resolve) => session.sftp.mkdir(parent, () => resolve()));
    }
    await new Promise((resolve, reject) => {
      session.sftp.writeFile(filePath, buffer, (err) => (err ? reject(err) : resolve()));
    });
    return;
  }
  const tmp = path.join(os.tmpdir(), 'sahabat-wc-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  const prev = await session.client.pwd();
  try {
    await fs.promises.writeFile(tmp, buffer);
    const parent = posix.dirname(filePath);
    if (parent && parent !== '/' && parent !== '.') {
      try { await session.client.ensureDir(parent); } catch {}
    }
    await session.client.uploadFrom(tmp, filePath);
  } finally {
    try { await session.client.cd(prev); } catch {}
    try { await fs.promises.unlink(tmp); } catch {}
  }
}

async function mkdirRaw(session, dirPath) {
  if (!session) {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return;
  }
  if (session.type === 'ssh') {
    await new Promise((resolve, reject) => {
      session.sftp.mkdir(dirPath, (err) => {
        if (err && err.code !== 4) reject(err);
        else resolve();
      });
    });
    return;
  }
  const prev = await session.client.pwd();
  try {
    await session.client.ensureDir(dirPath);
  } finally {
    try { await session.client.cd(prev); } catch {}
  }
}

async function removeRaw(session, targetPath, isDir) {
  if (!session) {
    if (isDir) rmTree(targetPath);
    else await fs.promises.unlink(targetPath);
    return;
  }
  if (isDir) {
    const items = await remoteList(session, targetPath);
    for (const item of items) await removeRaw(session, item.path, item.dir);
    if (session.type === 'ssh') {
      await new Promise((resolve, reject) => session.sftp.rmdir(targetPath, (err) => (err ? reject(err) : resolve())));
    } else {
      await session.client.removeDir(targetPath);
    }
    return;
  }
  if (session.type === 'ssh') {
    await new Promise((resolve, reject) => session.sftp.unlink(targetPath, (err) => (err ? reject(err) : resolve())));
  } else {
    await session.client.remove(targetPath);
  }
}

async function copyEntry(srcSession, srcPath, dstSession, dstPath, isDir) {
  if (isDir) {
    await mkdirRaw(dstSession, dstPath);
    const items = await listRaw(srcSession, srcPath);
    for (const item of items) {
      const childDst = dstSession ? posix.join(dstPath, item.name) : path.join(dstPath, item.name);
      await copyEntry(srcSession, item.path, dstSession, childDst, item.dir);
    }
    return;
  }
  const buffer = await readRaw(srcSession, srcPath);
  await writeRaw(dstSession, dstPath, buffer);
}

async function uniqueDestination(session, dir, name) {
  let names;
  try {
    names = new Set((await listRaw(session, dir)).map((i) => i.name));
  } catch {
    names = new Set();
  }
  if (!names.has(name)) return joinForRemote(session, dir, name);
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let i = 1;
  while (names.has(base + ' (' + i + ')' + ext)) i += 1;
  return joinForRemote(session, dir, base + ' (' + i + ')' + ext);
}

async function fastRename(srcSession, srcPath, dstSession, dstPath) {
  if (!srcSession && !dstSession) {
    try { await fs.promises.rename(srcPath, dstPath); return true; } catch { return false; }
  }
  if (srcSession && dstSession && srcSession === dstSession && srcSession.type === 'ssh') {
    try {
      await new Promise((resolve, reject) => srcSession.sftp.rename(srcPath, dstPath, (err) => (err ? reject(err) : resolve())));
      return true;
    } catch { return false; }
  }
  if (srcSession && dstSession && srcSession === dstSession && srcSession.type === 'ftp') {
    try { await srcSession.client.rename(srcPath, dstPath); return true; } catch { return false; }
  }
  return false;
}

app.whenReady().then(() => {
  storedKey = loadKey();
  buildAppMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  for (const child of terminals.values()) { try { child.kill(); } catch {} }
  for (const s of remotes.values()) { try { s.client.end ? s.client.end() : s.client.close(); } catch {} }
  for (const s of dbSessions.values()) { dbEngine.closeSession(s).catch(() => {}); }
});

ipcMain.handle('settings:get', () => {
  const s = readSettings();
  return {
    baseUrl: getBaseUrl(),
    hasKey: Boolean(storedKey),
    keyHint: maskKey(storedKey),
    version: app.getVersion(),
    updateFeed: s.updateFeed || DEFAULT_UPDATE_FEED,
    autoUpdate: s.autoUpdate !== false,
    agentThinking: ['default', 'low', 'mid', 'high', 'xhigh'].includes(s.agentThinking) ? s.agentThinking : 'default',
    modelAccessMode: ['auto', 'payg', 'hemat', 'coding', 'minimax', 'pro'].includes(s.modelAccessMode) ? s.modelAccessMode : 'auto',
    modelAccessAll: s.modelAccessAll === true,
    modelBlockedCount: Array.isArray(s.modelBlocked) ? s.modelBlocked.length : 0
  };
});

ipcMain.handle('settings:copyKey', () => {
  if (!storedKey) return { ok: false };
  clipboard.writeText(storedKey);
  return { ok: true };
});

// ---------- Auto-update ----------

function normalizeReleaseVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function pickUpdateAsset(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const patterns = {
    win32: /\.exe$/i,
    darwin: /\.dmg$/i,
    linux: /\.(appimage|deb)$/i
  };
  const re = patterns[process.platform] || patterns.win32;
  const asset = assets.find((a) => re.test(a.name || a.browser_download_url || ''));
  return asset ? (asset.browser_download_url || asset.url || '') : '';
}

function parseUpdateFeed(data) {
  if (!data || typeof data !== 'object') throw new Error('Format feed tidak dikenali.');
  if (data.version || data.url) {
    return {
      version: normalizeReleaseVersion(data.version),
      url: String(data.url || ''),
      notes: String(data.notes || data.changelog || ''),
      mandatory: Boolean(data.mandatory)
    };
  }
  const tag = data.tag_name || data.name;
  if (tag) {
    return {
      version: normalizeReleaseVersion(tag),
      url: pickUpdateAsset(data),
      notes: String(data.body || ''),
      mandatory: false
    };
  }
  throw new Error('Feed tidak memuat "version" atau "tag_name".');
}

ipcMain.handle('app:version', () => ({
  version: app.getVersion(),
  platform: process.platform,
  electron: process.versions.electron
}));

ipcMain.handle('update:check', async () => {
  const current = app.getVersion();
  const feed = String(readSettings().updateFeed || DEFAULT_UPDATE_FEED).trim();
  try {
    const text = await fetchTextOnce(feed, 15000);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Feed bukan JSON valid.');
    }
    const info = parseUpdateFeed(data);
    if (!info.version) throw new Error('Versi terbaru tidak ada di feed.');
    return {
      ok: true,
      current,
      latest: info.version,
      hasUpdate: compareVersions(info.version, current) > 0,
      url: info.url,
      notes: info.notes,
      mandatory: info.mandatory,
      feed
    };
  } catch (err) {
    const noFeed = /HTTP 404|HTTP 403|HTTP 401/.test(String(err.message || ''));
    if (noFeed) {
      return { ok: true, current, latest: '', hasUpdate: false, url: '', notes: '', mandatory: false, feed, noFeed: true };
    }
    return { ok: false, current, feed, error: 'Gagal cek pembaruan: ' + err.message };
  }
});

ipcMain.handle('update:download', async (event, payload) => {
  const url = String((payload && payload.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL unduhan tidak valid.' };
  let name = 'SahabatMobile-Desktop-update.exe';
  try {
    const parsed = new URL(url);
    name = decodeURIComponent((parsed.pathname.split('/').pop() || name));
  } catch {}
  name = name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'update.exe';
  const dir = path.join(app.getPath('temp'), 'sahabat-update');
  const target = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const res = await fetch(url, { headers: { 'User-Agent': 'SahabatMobile-Desktop/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length') || 0);
    const sender = event.sender;
    let received = 0;
    const out = fs.createWriteStream(target);
    await new Promise((resolve, reject) => {
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        received += chunk.length;
        try {
          sender.send('update:progress', {
            received,
            total,
            percent: total ? Math.round((received / total) * 100) : 0
          });
        } catch {}
      });
      body.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      body.pipe(out);
    });
    return { ok: true, path: target, name, size: received };
  } catch (err) {
    return { ok: false, error: 'Gagal mengunduh update: ' + err.message };
  }
});

ipcMain.handle('update:install', async (event, filePath) => {
  const target = String(filePath || '');
  if (!target || !fs.existsSync(target)) return { ok: false, error: 'File update tidak ditemukan.' };
  const err = await shell.openPath(target);
  if (err) return { ok: false, error: err };
  return { ok: true };
});

ipcMain.handle('clipboard:write', (event, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

ipcMain.handle('clipboard:read', () => ({ ok: true, text: clipboard.readText() }));

ipcMain.handle('settings:set', (event, payload) => {
  const data = readSettings();
  if (payload.baseUrl && payload.baseUrl.trim()) {
    data.baseUrl = payload.baseUrl.trim().replace(/\/+$/, '');
  }
  if (typeof payload.updateFeed === 'string' && payload.updateFeed.trim()) {
    data.updateFeed = payload.updateFeed.trim();
  }
  if (typeof payload.autoUpdate === 'boolean') {
    data.autoUpdate = payload.autoUpdate;
  }
  if (typeof payload.modelAccessMode === 'string' && ['auto', 'payg', 'hemat', 'coding', 'minimax', 'pro'].includes(payload.modelAccessMode)) {
    data.modelAccessMode = payload.modelAccessMode;
  }
  if (typeof payload.modelAccessAll === 'boolean') {
    data.modelAccessAll = payload.modelAccessAll;
  }
  if (payload.resetBlockedModels === true) {
    data.modelBlocked = [];
  }
  if (typeof payload.agentThinking === 'string') {
    const v = payload.agentThinking.toLowerCase();
    if (['default', 'low', 'mid', 'high', 'xhigh'].includes(v)) data.agentThinking = v;
  }
  writeSettings(data);
  if (payload.apiKey && payload.apiKey.trim()) {
    saveKey(payload.apiKey.trim());
  }
  const s = readSettings();
  return {
    baseUrl: getBaseUrl(),
    hasKey: Boolean(storedKey),
    keyHint: maskKey(storedKey),
    version: app.getVersion(),
    updateFeed: s.updateFeed || DEFAULT_UPDATE_FEED,
    autoUpdate: s.autoUpdate !== false,
    agentThinking: ['default', 'low', 'mid', 'high', 'xhigh'].includes(s.agentThinking) ? s.agentThinking : 'default',
    modelAccessMode: ['auto', 'payg', 'hemat'].includes(s.modelAccessMode) ? s.modelAccessMode : 'auto',
    modelAccessAll: s.modelAccessAll === true,
    modelBlockedCount: Array.isArray(s.modelBlocked) ? s.modelBlocked.length : 0
  };
});

ipcMain.handle('models:list', async () => {
  if (!storedKey) return { ok: false, error: { message: 'API key belum diisi.' } };
  try {
    const res = await fetch(getBaseUrl() + '/models', { headers: authHeaders(storedKey) });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: errorMessage(res.status, text) };
    const parsed = JSON.parse(text);
    const list = (parsed.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      owner: m.owned_by || '',
      thinking: modelSupportsThinking(m.id)
    })).sort((a, b) => a.id.localeCompare(b.id));
    const s = readSettings();
    const blocked = blockedModelIds();
    let shown = list;
    let access;
    if (!s.modelAccessAll) {
      access = await detectModelAccess();
      if (access.allowed) {
        const allow = new Set(access.allowed.map((id) => String(id).toLowerCase()));
        shown = shown.filter((m) => allow.has(String(m.id).toLowerCase()));
      }
      if (blocked.length) shown = shown.filter((m) => !blocked.includes(String(m.id)));
    } else {
      access = { detected: true, source: 'mode', allowed: null, note: 'Menampilkan semua model (filter paket dimatikan).' };
    }
    const hidden = list.length - shown.length;
    const accessOut = { ...access, total: list.length, shown: shown.length, hidden, blockedCount: blocked.length };
    if (hidden) accessOut.note = (access.note || 'Model sesuai paket Anda.') + ' ' + hidden + ' model disembunyikan.';
    return { ok: true, models: shown, total: list.length, access: accessOut, blockedCount: blocked.length };
  } catch (err) {
    return { ok: false, error: { message: 'Gagal menghubungi server: ' + err.message } };
  }
});

ipcMain.handle('chat:start', async (event, payload) => {
  const sender = event.sender;
  const requestId = payload.requestId;
  if (!storedKey) {
    return { ok: false, error: { message: 'API key belum diisi.' } };
  }
  const controller = new AbortController();
  controllers.set(requestId, controller);
  const body = {
    model: payload.model,
    messages: payload.messages,
    stream: true,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.7,
    max_tokens: payload.maxTokens || 4096
  };
  try {
    const res = await fetch(getBaseUrl() + '/chat/completions', {
      method: 'POST',
      headers: authHeaders(storedKey),
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: errorMessage(res.status, text) };
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      const text = await res.text();
      let content = '';
      let usage = null;
      try {
        const parsed = JSON.parse(text);
        content = (parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content) || '';
        usage = parsed.usage || null;
      } catch {
        content = text;
      }
      if (content) sender.send('chat:chunk', { requestId, delta: content });
      sender.send('chat:done', { requestId, usage });
      return { ok: true };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    let usage = null;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          finished = true;
          break;
        }
        if (!data) continue;
        try {
          const chunk = JSON.parse(data);
          if (chunk.usage) usage = chunk.usage;
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          const textPart = delta && (delta.content || '');
          if (textPart) sender.send('chat:chunk', { requestId, delta: textPart });
        } catch {
          continue;
        }
      }
    }
    sender.send('chat:done', { requestId, usage });
    return { ok: true };
  } catch (err) {
    if (err.name === 'AbortError') {
      sender.send('chat:done', { requestId, aborted: true });
      return { ok: true, aborted: true };
    }
    sender.send('chat:error', { requestId, message: 'Koneksi gagal: ' + err.message });
    return { ok: false, error: { message: 'Koneksi gagal: ' + err.message } };
  } finally {
    controllers.delete(requestId);
  }
});

ipcMain.handle('chat:abort', (event, requestId) => {
  const controller = controllers.get(requestId);
  if (controller) controller.abort();
  return { ok: true };
});

function completionFromParsed(parsed) {
  const choice = (parsed.choices && parsed.choices[0]) || null;
  const message = (choice && choice.message) || { role: 'assistant', content: '' };
  const rawContent = String(message.content || '');
  let reasoning = '';
  if (message.reasoning_content) reasoning = String(message.reasoning_content);
  else if (message.reasoning) reasoning = String(message.reasoning);
  else if (message.thinking) reasoning = String(message.thinking);
  else {
    const m = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
    if (m) reasoning = m[1].trim();
  }
  const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
  const cleanContent = thinkMatch ? rawContent.replace(thinkMatch[0], '').trim() : rawContent;
  return {
    ok: true,
    message: { ...stripReasoningFields(message), content: cleanContent },
    reasoning,
    finishReason: choice && choice.finish_reason,
    usage: parsed.usage || null,
  };
}

// ---------- Chat completion dengan pembatalan (AbortController) ----------
const chatControllers = new Map();
let chatSeq = 0;

ipcMain.handle('chat:complete', async (event, payload) => {
  if (!storedKey) return { ok: false, error: { message: 'API key belum diisi.' } };
  const model = String(payload.model || '');
  const capable = modelSupportsThinking(model);
  const body = {
    model,
    messages: stripReasoningFromMessages(payload.messages),
    stream: false,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.3,
    max_tokens: payload.maxTokens || 4096
  };
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools;
    body.tool_choice = 'auto';
  }
  // Thinking (reasoning effort) — hanya dikirim jika model terdeteksi support.
  const THINKING_MAP = { low: 'low', mid: 'medium', high: 'high', xhigh: 'xhigh' };
  const think = String(payload.reasoningEffort || '').toLowerCase();
  if (capable && Object.prototype.hasOwnProperty.call(THINKING_MAP, think)) {
    body.reasoning_effort = THINKING_MAP[think];
  }
  const requestId = String(payload.requestId || ('c' + (++chatSeq)));
  const controller = new AbortController();
  chatControllers.set(requestId, controller);
  // Rantai percobaan: penuh → tanpa reasoning_effort → tanpa tools.
  // Gateway kadang menolak param dengan error umum ("Terjadi kesalahan internal"),
  // jadi recovery tidak boleh bergantung pada teks error.
  const attempts = [{ body, toolsStripped: false, reasoningStripped: false }];
  if (body.reasoning_effort) {
    const b = { ...body };
    delete b.reasoning_effort;
    attempts.push({ body: b, toolsStripped: false, reasoningStripped: true });
  }
  let lastStatus = 0;
  let lastText = '';
  try {
    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      const res = await fetch(getBaseUrl() + '/chat/completions', {
        method: 'POST',
        headers: authHeaders(storedKey),
        body: JSON.stringify(attempt.body),
        signal: controller.signal
      });
      if (res.ok) {
        const out = completionFromParsed(JSON.parse(await res.text()));
        if (attempt.reasoningStripped) out.note = 'Thinking diabaikan — model/gateway menolak parameter reasoning.';
        if (attempt.toolsStripped) out.toolsDisabled = true;
        return out;
      }
      const text = await res.text();
      lastStatus = res.status;
      lastText = text;
      // Varian terakhir: tanpa tools (hanya jika error menyebut tool/function).
      const isToolErr = /tool|function|model_no_tool/i.test(text);
      const isGeneric = res.status >= 500 || /internal|kesalahan/i.test(text);
      if (attempt.body.tools && isToolErr && i === attempts.length - 1) {
        const b = { ...attempt.body };
        delete b.tools;
        delete b.tool_choice;
        attempts.push({ body: b, toolsStripped: true, reasoningStripped: attempt.reasoningStripped });
        continue;
      }
      // Error lain yang tidak berkaitan param → berhenti, jangan retry percuma.
      if (!isToolErr && !isGeneric && !attempt.reasoningStripped) break;
    }
    return { ok: false, error: errorMessage(lastStatus, lastText) };
  } catch (err) {
    if (err && (err.name === 'AbortError' || controller.signal.aborted)) {
      return { ok: false, aborted: true, error: { message: 'Dihentikan oleh pengguna.' } };
    }
    return { ok: false, error: { message: 'Koneksi gagal: ' + err.message } };
  } finally {
    chatControllers.delete(requestId);
  }
});

ipcMain.handle('chat:cancel', (event, requestId) => {
  const c = chatControllers.get(String(requestId || ''));
  if (c) { c.abort(); return { ok: true }; }
  return { ok: false };
});

ipcMain.handle('dialog:openFolder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  workspaceRoot = result.filePaths[0];
  return { ok: true, root: workspaceRoot, tree: await buildTree(workspaceRoot, 0) };
});

ipcMain.handle('dialog:pickDirectory', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('repo:clone', async (event, payload) => {
  const url = String(payload.url || '').trim();
  const parent = String(payload.dir || '').trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) return { ok: false, error: 'URL repository tidak valid.' };
  if (!parent) return { ok: false, error: 'Folder tujuan belum dipilih.' };
  let name = url.replace(/\.git$/, '').split(/[\\/]/).pop() || 'repo';
  if (name.includes(':')) name = name.split(':').pop();
  const target = path.join(parent, name);
  if (fs.existsSync(target)) return { ok: false, error: 'Folder tujuan sudah ada: ' + target };
  const result = await new Promise((resolve) => {
    let log = '';
    let child;
    try {
      child = spawn('git', ['clone', '--depth', '1', url, target], { cwd: parent, env: process.env, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, log: err.message });
      return;
    }
    child.stdout.on('data', (d) => { log += d.toString('utf8'); });
    child.stderr.on('data', (d) => { log += d.toString('utf8'); });
    child.on('error', (err) => resolve({ code: -1, log: log + err.message }));
    child.on('close', (code) => resolve({ code, log }));
  });
  if (result.code !== 0) return { ok: false, error: result.log.slice(-2000) || 'git clone gagal.' };
  workspaceRoot = target;
  return { ok: true, root: target, tree: await buildTree(target, 0), log: result.log };
});

ipcMain.handle('workspace:info', async () => {
  if (!workspaceRoot) return { ok: false };
  return { ok: true, root: workspaceRoot, tree: await buildTree(workspaceRoot, 0) };
});

ipcMain.handle('workspace:tree', async () => {
  if (!workspaceRoot) return { ok: false };
  return { ok: true, root: workspaceRoot, tree: await buildTree(workspaceRoot, 0) };
});

ipcMain.handle('fs:read', async (event, filePath) => {
  try {
    const abs = resolveInRoot(filePath);
    const buf = await fs.promises.readFile(abs);
    return { ok: true, path: abs, content: assertTextBuffer(buf, 'File') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:write', async (event, payload) => {
  try {
    const abs = resolveInRoot(payload.path);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, String(payload.content ?? ''), 'utf8');
    return { ok: true, path: abs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:mkdir', async (event, dirPath) => {
  try {
    const abs = resolveInRoot(dirPath);
    await fs.promises.mkdir(abs, { recursive: true });
    return { ok: true, path: abs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('fs:remove', async (event, filePath) => {
  try {
    const abs = resolveInRoot(filePath);
    const st = await fs.promises.lstat(abs);
    if (st.isDirectory()) rmTree(abs);
    else await fs.promises.unlink(abs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('entry:copy', async (event, payload) => {
  try {
    const srcSession = targetSession(payload.srcTarget);
    const dstSession = targetSession(payload.dstTarget);
    const name = basenameForRemote(Boolean(srcSession), payload.srcPath);
    const destPath = await uniqueDestination(dstSession, payload.dstDir, name);
    await copyEntry(srcSession, payload.srcPath, dstSession, destPath, Boolean(payload.isDir));
    if (payload.cut) await removeRaw(srcSession, payload.srcPath, Boolean(payload.isDir));
    return { ok: true, path: destPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('entry:move', async (event, payload) => {
  try {
    const srcSession = targetSession(payload.srcTarget);
    const dstSession = targetSession(payload.dstTarget);
    if (srcSession === dstSession) {
      const done = await fastRename(srcSession, payload.srcPath, dstSession, payload.dstPath);
      if (done) return { ok: true, path: payload.dstPath };
    }
    if (!payload.overwrite) {
      const parent = dirnameForRemote(Boolean(dstSession), payload.dstPath);
      const name = basenameForRemote(Boolean(dstSession), payload.dstPath);
      const items = await listRaw(dstSession, parent).catch(() => []);
      if (items.some((i) => i.name === name)) {
        return { ok: false, error: 'Tujuan sudah ada: ' + payload.dstPath };
      }
    }
    await copyEntry(srcSession, payload.srcPath, dstSession, payload.dstPath, Boolean(payload.isDir));
    await removeRaw(srcSession, payload.srcPath, Boolean(payload.isDir));
    return { ok: true, path: payload.dstPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('entry:upload', async (event, payload) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const mode = payload.mode === 'folder' ? 'folder' : 'file';
    const dialogOptions = mode === 'folder'
      ? { title: 'Pilih folder untuk diunggah ke target', properties: ['openDirectory'] }
      : { title: 'Pilih file untuk diunggah ke target', properties: ['openFile', 'multiSelections'] };
    const result = await dialog.showOpenDialog(win, dialogOptions);
    if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true, uploaded: [] };

    const dstTarget = payload.dstTarget || { type: 'local', id: null };
    const dstSession = targetSession(dstTarget);
    const dstDir = payload.dstDir;
    if (!dstDir) throw new Error('Folder tujuan tidak valid.');
    try {
      const entries = await listRaw(dstSession, dstDir);
      void entries;
    } catch {
      throw new Error('Folder tujuan tidak bisa diakses.');
    }

    const itemIsDir = (source) => fs.statSync(source).isDirectory();
    if (mode === 'folder' && !itemIsDir(result.filePaths[0])) {
      throw new Error('Folder yang dipilih tidak valid.');
    }

    const names = result.filePaths.map((source) => basenameForRemote(false, source));
    const existing = new Set((await listRaw(dstSession, dstDir)).map((entry) => entry.name));
    const overlaps = names.filter((name) => existing.has(name));
    if (overlaps.length) {
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        title: 'Timpa file?',
        message: `Ada ${overlaps.length} file/folder dengan nama yang sama di tujuan.`,
        detail: overlaps.slice(0, 20).join(', ') + (overlaps.length > 20 ? '\n...' : ''),
        buttons: ['Timpa', 'Batal'],
        defaultId: 0,
        cancelId: 1
      });
      if (answer.response !== 0) return { ok: true, canceled: true, uploaded: [] };
    }

    const uploaded = [];
    const failed = [];
    for (const source of result.filePaths) {
      try {
        if (mode === 'file' && itemIsDir(source)) continue;
        const name = basenameForRemote(false, source);
        const destPath = dstSession ? posix.join(dstDir, name) : path.join(dstDir, name);
        await copyEntry(null, source, dstSession, destPath, itemIsDir(source));
        uploaded.push({ source, dest: destPath });
      } catch (err) {
        failed.push({ source, error: err.message });
      }
    }
    return { ok: failed.length === 0, uploaded, failed, dstDir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('entry:download', async (event, payload) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const srcTarget = payload.srcTarget || { type: 'local', id: null };
    const srcSession = targetSession(srcTarget);
    const name = payload.name || basenameForRemote(Boolean(srcSession), payload.srcPath);
    const downloadDir = app.getPath('downloads');
    let destPath;

    if (!payload.isDir) {
      const result = await dialog.showSaveDialog(win, {
        title: 'Simpan file dari target',
        defaultPath: path.join(downloadDir, name)
      });
      if (result.canceled || !result.filePath) return { ok: true, canceled: true };
      destPath = result.filePath;
    } else {
      const result = await dialog.showOpenDialog(win, {
        title: 'Pilih folder tujuan',
        properties: ['openDirectory', 'createDirectory']
      });
      if (result.canceled || !result.filePaths[0]) return { ok: true, canceled: true };
      destPath = path.join(result.filePaths[0], name);
    }

    if (fs.existsSync(destPath)) {
      const answer = await dialog.showMessageBox(win, {
        type: 'question',
        title: payload.isDir ? 'Tambahkan ke folder?' : 'Timpa file?',
        message: payload.isDir
          ? `Folder "${name}" sudah ada. Isi akan ditambahkan/ditimpa.`
          : `File "${basenameForRemote(false, destPath)}" akan ditimpa.`,
        buttons: ['Lanjutkan', 'Batal'],
        defaultId: 0,
        cancelId: 1
      });
      if (answer.response !== 0) return { ok: true, canceled: true };
    }

    await copyEntry(srcSession, payload.srcPath, null, destPath, Boolean(payload.isDir));
    return { ok: true, path: destPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('term:start', async (event, payload) => {
  const id = 't' + (++termSeq);
  const sh = localShell();
  const cwd = payload && payload.cwd ? payload.cwd : (workspaceRoot || os.homedir());
  let child;
  try {
    child = spawn(sh.file, sh.args, { cwd, env: process.env, windowsHide: true });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  child.stdout.on('data', (d) => send('term:data', { id, data: d.toString('utf8') }));
  child.stderr.on('data', (d) => send('term:data', { id, data: d.toString('utf8') }));
  child.on('exit', (code) => {
    terminals.delete(id);
    send('term:exit', { id, code });
  });
  child.on('error', (err) => send('term:data', { id, data: '\r\n[error] ' + err.message + '\r\n' }));
  terminals.set(id, child);
  return { ok: true, id, cwd, shell: sh.file };
});

ipcMain.handle('term:input', (event, payload) => {
  const child = terminals.get(payload.id);
  if (child && child.stdin.writable) child.stdin.write(String(payload.data || ''));
  return { ok: Boolean(child) };
});

ipcMain.handle('term:stop', (event, id) => {
  const child = terminals.get(id);
  if (child) { try { child.kill(); } catch {} }
  terminals.delete(id);
  return { ok: true };
});

async function openRemoteConnection(cfg) {
  const id = 'r' + (++remoteSeq);
  const host = String(cfg.host || '').trim();
  const username = String(cfg.username || '').trim();
  if (!host || !username) return { ok: false, error: 'Host dan username wajib diisi.' };
  const protocol = cfg.protocol || 'sftp';

  if (protocol === 'ftp' || protocol === 'ftps') {
    const client = new FtpClient();
    client.ftp.verbose = false;
    try {
      await client.access({
        host,
        port: Number(cfg.port) || 21,
        user: username,
        password: String(cfg.password || ''),
        secure: protocol === 'ftps',
        secureOptions: protocol === 'ftps' ? { rejectUnauthorized: false } : undefined
      });
      const home = await client.pwd();
      remotes.set(id, { type: 'ftp', client, home, shell: null });
      return { ok: true, id, home, type: 'ftp', label: 'FTP ' + username + '@' + host, host, port: Number(cfg.port) || 21, username };
    } catch (err) {
      try { client.close(); } catch {}
      return { ok: false, error: err.message };
    }
  }

  const client = new SshClient();
  const options = {
    host,
    port: Number(cfg.port) || 22,
    username,
    readyTimeout: 25000,
    keepaliveInterval: 15000
  };
  if (cfg.authType === 'key' && cfg.privateKey) {
    try {
      options.privateKey = fs.readFileSync(String(cfg.privateKey).trim());
    } catch (err) {
      return { ok: false, error: 'Gagal membaca private key: ' + err.message };
    }
    if (cfg.passphrase) options.passphrase = String(cfg.passphrase);
  } else {
    options.password = String(cfg.password || '');
  }
  try {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect(options);
    });
    const sftp = await new Promise((resolve, reject) => client.sftp((err, s) => (err ? reject(err) : resolve(s))));
    const home = await new Promise((resolve) => sftp.realpath('.', (err, p) => resolve(err ? '.' : p)));
    remotes.set(id, { type: 'ssh', client, sftp, home, shell: null });
    client.on('close', () => {
      remotes.delete(id);
      send('remote:closed', { id });
    });
    const port = Number(cfg.port) || 22;
    return { ok: true, id, home, type: 'ssh', label: 'SSH ' + username + '@' + host, host, port, username };
  } catch (err) {
    try { client.end(); } catch {}
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('remote:connect', async (event, cfg) => {
  const result = await openRemoteConnection(cfg);
  if (!result.ok) return result;
  if (cfg && cfg.saveConnection) {
    const saved = saveConnectionProfile(cfg);
    return { ...result, saved };
  }
  return result;
});

ipcMain.handle('remote:connectSaved', async (event, id) => {
  const profile = readConnectionProfile(id);
  if (!profile) return { ok: false, error: 'Koneksi tersimpan tidak ditemukan.' };
  const result = await openRemoteConnection({
    protocol: profile.protocol,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authType: profile.authType,
    privateKey: profile.privateKey,
    password: profile.passwordValue,
    passphrase: profile.passphraseValue
  });
  if (!result.ok) return result;
  updateConnectionLastConnected(id);
  return { ...result, saved: connectionPublic(profile) };
});

ipcMain.handle('connections:list', () => {
  const s = readSettings();
  const list = Array.isArray(s.connections) ? s.connections : [];
  return { ok: true, connections: list.map(connectionPublic) };
});

ipcMain.handle('connections:remove', (event, id) => {
  try {
    const s = readSettings();
    const list = Array.isArray(s.connections) ? s.connections : [];
    s.connections = list.filter((p) => p.id !== id);
    writeSettings(s);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('connections:get', (event, id) => {
  const s = readSettings();
  const list = Array.isArray(s.connections) ? s.connections : [];
  const profile = list.find((p) => p.id === id);
  if (!profile) return { ok: false, error: 'Koneksi tersimpan tidak ditemukan.' };
  return {
    ok: true,
    connection: {
      ...connectionPublic(profile),
      privateKey: profile.privateKey || ''
    }
  };
});

ipcMain.handle('connections:update', (event, payload) => {
  try {
    const id = String((payload && payload.id) || '');
    if (!id) return { ok: false, error: 'ID koneksi tidak valid.' };
    const result = updateConnectionProfile(id, payload || {});
    if (!result.ok) return result;
    return { ok: true, connection: result.connection };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:listDir', async (event, payload) => {
  try {
    const session = getRemote(payload.id);
    return { ok: true, dir: payload.dir || session.home, items: await remoteList(session, payload.dir) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:readFile', async (event, payload) => {
  try {
    const session = getRemote(payload.id);
    return { ok: true, content: await remoteRead(session, payload.path) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:writeFile', async (event, payload) => {
  try {
    const session = getRemote(payload.id);
    await remoteWrite(session, payload.path, payload.content);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:mkdir', async (event, payload) => {
  try {
    const session = getRemote(payload.id);
    await remoteMkdir(session, payload.path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:remove', async (event, payload) => {
  try {
    const session = getRemote(payload.id);
    await remoteRemove(session, payload.path, Boolean(payload.dir));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- remote shell (multi-stream per sesi SSH) ----------
let shellSeq = 0;

ipcMain.handle('remote:shell', async (event, payload) => {
  try {
    const s = getRemote(payload.id);
    if (s.type !== 'ssh') return { ok: false, error: 'FTP tidak mendukung terminal.' };
    const cols = Math.max(20, Math.min(500, Number(payload.cols) || 120));
    const rows = Math.max(5, Math.min(200, Number(payload.rows) || 30));
    const stream = await new Promise((resolve, reject) => {
      s.client.shell({ term: 'xterm-256color', cols, rows }, (err, st) => (err ? reject(err) : resolve(st)));
    });
    const shellId = 'sh' + (++shellSeq);
    if (!s.shells) s.shells = new Map();
    stream.setEncoding('utf8');
    stream.on('data', (d) => send('remote:data', { id: payload.id, shellId, data: d }));
    if (stream.stderr) stream.stderr.on('data', (d) => send('remote:data', { id: payload.id, shellId, data: d }));
    stream.on('close', () => {
      if (s.shells) s.shells.delete(shellId);
      send('remote:exit', { id: payload.id, shellId });
    });
    s.shells.set(shellId, stream);
    return { ok: true, shellId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:input', (event, payload) => {
  const s = remotes.get(payload.id);
  const stream = s && s.shells && s.shells.get(String(payload.shellId));
  if (stream) stream.write(String(payload.data || ''));
  return { ok: Boolean(stream) };
});

ipcMain.handle('remote:resize', (event, payload) => {
  const s = remotes.get(payload.id);
  const stream = s && s.shells && s.shells.get(String(payload.shellId));
  if (stream) stream.setWindow(payload.rows || 30, payload.cols || 120, 0, 0);
  return { ok: Boolean(stream) };
});

ipcMain.handle('remote:closeShell', (event, payload) => {
  const s = remotes.get(payload.id);
  const shellId = String(payload.shellId || '');
  const stream = s && s.shells && s.shells.get(shellId);
  if (stream) { try { stream.end(); } catch {} }
  if (s && s.shells) s.shells.delete(shellId);
  return { ok: true };
});

ipcMain.handle('remote:disconnect', (event, id) => {
  const s = remotes.get(id);
  if (s) {
    if (s.shells) {
      for (const stream of s.shells.values()) { try { stream.end(); } catch {} }
      s.shells.clear();
    } else if (s.shell) { try { s.shell.end(); } catch {} }
    try { if (s.type === 'ssh') s.client.end(); else s.client.close(); } catch {}
    remotes.delete(id);
  }
  return { ok: true };
});

ipcMain.handle('agent:listDir', async (event, payload) => {
  try {
    const ctx = resolveAgentTarget(payload.target);
    if (ctx.kind === 'remote') {
      const items = await remoteList(ctx.session, payload.dir);
      return { ok: true, path: payload.dir || ctx.session.home, items: items.map((i) => ({ name: i.name, type: i.dir ? 'dir' : 'file' })) };
    }
    const abs = resolveInRoot(payload.dir || '.');
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    const items = entries
      .filter((e) => !IGNORED_DIRS.has(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 500)
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
    return { ok: true, path: abs, items };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('agent:readFile', async (event, payload) => {
  try {
    const ctx = resolveAgentTarget(payload.target);
    if (ctx.kind === 'remote') {
      const content = await remoteRead(ctx.session, payload.path);
      return { ok: true, content: content.length > 120000 ? content.slice(0, 120000) + '\n...[dipotong]' : content };
    }
    const abs = resolveInRoot(payload.path);
    const buf = await fs.promises.readFile(abs);
    const content = assertTextBuffer(buf, 'File');
    return { ok: true, path: abs, content: content.length > 120000 ? content.slice(0, 120000) + '\n...[dipotong]' : content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('agent:writeFile', async (event, payload) => {
  try {
    const ctx = resolveAgentTarget(payload.target);
    if (ctx.kind === 'remote') {
      await remoteWrite(ctx.session, payload.path, payload.content);
      return { ok: true };
    }
    const abs = resolveInRoot(payload.path);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, String(payload.content ?? ''), 'utf8');
    return { ok: true, path: abs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('agent:runCommand', async (event, payload) => {
  const ctx = resolveAgentTarget(payload.target);
  const win = BrowserWindow.fromWebContents(event.sender);
  const where = ctx.kind === 'remote' ? (ctx.type === 'ssh' ? 'server SSH' : 'server FTP (tidak didukung)') : 'folder lokal';
  if (!allowAgentCommands && !payload.allow) {
    const answer = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Jalankan', 'Batal'],
      defaultId: 1,
      cancelId: 1,
      title: 'Agen menjalankan perintah',
      message: 'Agen ingin menjalankan perintah di ' + where + ':',
      detail: String(payload.command || '').slice(0, 2000),
      checkboxLabel: 'Izinkan agen menjalankan perintah selama sesi ini',
      checkboxChecked: false
    });
    if (answer.response !== 0) return { ok: true, denied: true, output: 'Pengguna menolak eksekusi perintah.' };
    if (answer.checkboxChecked) allowAgentCommands = true;
  }
  if (ctx.kind === 'remote') {
    if (ctx.type !== 'ssh') return { ok: false, error: 'FTP tidak mendukung eksekusi perintah.' };
    const result = await remoteCommand(ctx.session, String(payload.command || ''), payload.cwd, payload.timeoutMs);
    return { ok: true, code: result.code, output: result.output };
  }
  if (!workspaceRoot) return { ok: false, error: 'Folder kerja belum dibuka.' };
  const cwd = payload.cwd ? resolveInRoot(payload.cwd) : workspaceRoot;
  const result = await runShellCommand(String(payload.command || ''), cwd, payload.timeoutMs);
  return {
    ok: true,
    code: result.code,
    output: (result.stdout + (result.stderr ? '\n[stderr]\n' + result.stderr : '')).slice(0, 60000) || '(tanpa output)'
  };
});
