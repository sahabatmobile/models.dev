const { app, BrowserWindow, ipcMain, safeStorage, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_BASE_URL = 'https://www.sahabatmobile.com/api/v1';
const controllers = new Map();
let storedKey = null;

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
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
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
