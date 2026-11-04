const { app, BrowserWindow, ipcMain, safeStorage, shell, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Client: SshClient } = require('ssh2');
const { Client: FtpClient } = require('basic-ftp');

const DEFAULT_BASE_URL = 'https://www.sahabatmobile.com/api/v1';
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
            return out;
          })()`);
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

app.whenReady().then(() => {
  storedKey = loadKey();
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
});

ipcMain.handle('settings:get', () => ({
  baseUrl: getBaseUrl(),
  hasKey: Boolean(storedKey),
  keyHint: maskKey(storedKey)
}));

ipcMain.handle('settings:copyKey', () => {
  if (!storedKey) return { ok: false };
  clipboard.writeText(storedKey);
  return { ok: true };
});

ipcMain.handle('clipboard:write', (event, text) => {
  clipboard.writeText(String(text || ''));
  return { ok: true };
});

ipcMain.handle('settings:set', (event, payload) => {
  const data = readSettings();
  if (payload.baseUrl && payload.baseUrl.trim()) {
    data.baseUrl = payload.baseUrl.trim().replace(/\/+$/, '');
  }
  writeSettings(data);
  if (payload.apiKey && payload.apiKey.trim()) {
    saveKey(payload.apiKey.trim());
  }
  return { baseUrl: getBaseUrl(), hasKey: Boolean(storedKey), keyHint: maskKey(storedKey) };
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
      owner: m.owned_by || ''
    })).sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models: list };
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

ipcMain.handle('chat:complete', async (event, payload) => {
  if (!storedKey) return { ok: false, error: { message: 'API key belum diisi.' } };
  const body = {
    model: payload.model,
    messages: payload.messages,
    stream: false,
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.3,
    max_tokens: payload.maxTokens || 4096
  };
  if (Array.isArray(payload.tools) && payload.tools.length) {
    body.tools = payload.tools;
    body.tool_choice = 'auto';
  }
  try {
    const res = await fetch(getBaseUrl() + '/chat/completions', {
      method: 'POST',
      headers: authHeaders(storedKey),
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: errorMessage(res.status, text) };
    const parsed = JSON.parse(text);
    const choice = (parsed.choices && parsed.choices[0]) || null;
    return {
      ok: true,
      message: (choice && choice.message) || { role: 'assistant', content: '' },
      finishReason: choice && choice.finish_reason,
      usage: parsed.usage || null
    };
  } catch (err) {
    return { ok: false, error: { message: 'Koneksi gagal: ' + err.message } };
  }
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

ipcMain.handle('remote:connect', async (event, cfg) => {
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
      return { ok: true, id, home, type: 'ftp', label: 'FTP ' + username + '@' + host };
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
    return { ok: true, id, home, type: 'ssh', label: 'SSH ' + username + '@' + host };
  } catch (err) {
    try { client.end(); } catch {}
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

ipcMain.handle('remote:shell', async (event, payload) => {
  try {
    const s = getRemote(payload.id);
    if (s.type !== 'ssh') return { ok: false, error: 'FTP tidak mendukung terminal.' };
    if (s.shell) return { ok: true };
    const stream = await new Promise((resolve, reject) => {
      s.client.shell({ term: 'xterm-256color', cols: payload.cols || 120, rows: payload.rows || 30 }, (err, st) => (err ? reject(err) : resolve(st)));
    });
    stream.setEncoding('utf8');
    stream.on('data', (d) => send('remote:data', { id: payload.id, data: d }));
    stream.stderr.on('data', (d) => send('remote:data', { id: payload.id, data: d }));
    stream.on('close', () => send('remote:exit', { id: payload.id }));
    s.shell = stream;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('remote:input', (event, payload) => {
  const s = remotes.get(payload.id);
  if (s && s.shell) s.shell.write(String(payload.data || ''));
  return { ok: Boolean(s && s.shell) };
});

ipcMain.handle('remote:resize', (event, payload) => {
  const s = remotes.get(payload.id);
  if (s && s.shell) s.shell.setWindow(payload.rows || 30, payload.cols || 120, 0, 0);
  return { ok: Boolean(s && s.shell) };
});

ipcMain.handle('remote:disconnect', (event, id) => {
  const s = remotes.get(id);
  if (s) {
    try { if (s.shell) s.shell.end(); } catch {}
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
  if (!allowAgentCommands) {
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
