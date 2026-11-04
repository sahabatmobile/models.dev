const $ = (id) => document.getElementById(id);

const chatEl = $('chat');
const emptyState = $('emptyState');
const inputEl = $('input');
const sendBtn = $('send');
const stopBtn = $('stop');
const statusEl = $('status');
const modelSelect = $('modelSelect');
const refreshBtn = $('refreshModels');
const keyBadge = $('keyBadge');
const tabTitle = $('tabTitle');
const settingsModal = $('settingsModal');
const baseUrlInput = $('baseUrlInput');
const apiKeyInput = $('apiKeyInput');
const keyHint = $('keyHint');
const systemInput = $('systemInput');
const traeModelId = $('traeModelId');
const traeBaseUrl = $('traeBaseUrl');
const traeKeyHint = $('traeKeyHint');
const testResult = $('testResult');
const snippetBox = $('snippetBox');
const modelList = $('modelList');
const modelSearch = $('modelSearch');

const state = {
  messages: [],
  models: [],
  hasKey: false,
  baseUrl: 'https://www.sahabatmobile.com/api/v1',
  busy: false,
  requestId: null,
  assistantBubble: null,
  assistantText: '',
  snippetKind: 'curl',
  activeTab: 'chat'
};

const TAB_TITLES = {
  chat: 'Chat',
  trae: 'Integrasi Trae',
  api: 'API & Snippet',
  models: 'Model'
};

function setStatus(text) {
  statusEl.textContent = text || '';
}

function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function hideEmpty() {
  if (emptyState && emptyState.parentNode) emptyState.remove();
}

function addMessage(role, content) {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'message ' + role;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'You' : 'AI';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content || '';
  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  chatEl.appendChild(wrap);
  scrollToBottom();
  return bubble;
}

function appendToBubble(bubble, text) {
  bubble.textContent += text;
  scrollToBottom();
}

function updateKeyBadge() {
  keyBadge.textContent = state.hasKey ? 'Key aktif' : 'Key belum diisi';
  keyBadge.classList.toggle('on', state.hasKey);
  keyBadge.classList.toggle('off', !state.hasKey);
  traeKeyHint.textContent = state.hasKey
    ? 'Tersimpan aman di perangkat ini'
    : 'Belum ada key. Buka Pengaturan dulu.';
}

function switchTab(tab) {
  state.activeTab = tab;
  tabTitle.textContent = TAB_TITLES[tab] || tab;
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tab);
  });
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('hidden', view.id !== 'view-' + tab);
  });
  if (tab === 'api') renderSnippet();
  if (tab === 'models') renderModelList();
}

function currentModel() {
  return modelSelect.value || '';
}

function populateModels(models) {
  state.models = models;
  modelSelect.innerHTML = '';
  if (!models.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Tidak ada model';
    modelSelect.appendChild(opt);
    updateModelTargets();
    return;
  }
  const saved = localStorage.getItem('sahabat.model');
  for (const model of models) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.name ? model.name + '  (' + model.id + ')' : model.id;
    modelSelect.appendChild(opt);
  }
  if (saved && models.some((m) => m.id === saved)) {
    modelSelect.value = saved;
  }
  updateModelTargets();
}

function updateModelTargets() {
  const id = currentModel();
  traeModelId.textContent = id || '-';
  if (state.activeTab === 'api') renderSnippet();
}

async function loadModels() {
  if (!state.hasKey) return null;
  setStatus('Memuat model...');
  const result = await window.sahabat.listModels();
  if (result.ok) {
    populateModels(result.models);
    setStatus(result.models.length + ' model tersedia');
    return result;
  }
  setStatus('Gagal memuat model: ' + (result.error && result.error.message ? result.error.message : ''));
  return result;
}

async function refreshSettings() {
  const settings = await window.sahabat.getSettings();
  state.hasKey = settings.hasKey;
  state.baseUrl = settings.baseUrl || state.baseUrl;
  baseUrlInput.value = state.baseUrl;
  traeBaseUrl.textContent = state.baseUrl;
  keyHint.textContent = settings.hasKey ? 'Key tersimpan: ' + settings.keyHint : 'Belum ada API key tersimpan.';
  apiKeyInput.value = '';
  updateKeyBadge();
}

function openSettings() {
  refreshSettings().then(() => settingsModal.classList.remove('hidden'));
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

async function saveSettings() {
  const settings = await window.sahabat.saveSettings({
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value.trim()
  });
  state.hasKey = settings.hasKey;
  state.baseUrl = settings.baseUrl || state.baseUrl;
  traeBaseUrl.textContent = state.baseUrl;
  localStorage.setItem('sahabat.system', systemInput.value.trim());
  closeSettings();
  await refreshSettings();
  if (state.hasKey) await loadModels();
}

function setBusy(busy) {
  state.busy = busy;
  sendBtn.classList.toggle('hidden', busy);
  stopBtn.classList.toggle('hidden', !busy);
  inputEl.disabled = busy;
}

function buildPayloadMessages() {
  const messages = [];
  const system = (localStorage.getItem('sahabat.system') || '').trim();
  if (system) messages.push({ role: 'system', content: system });
  for (const msg of state.messages) {
    messages.push({ role: msg.role, content: msg.content });
  }
  return messages;
}

async function sendMessage() {
  if (state.busy) return;
  const text = inputEl.value.trim();
  if (!text) return;
  if (!state.hasKey) {
    openSettings();
    return;
  }
  const model = currentModel();
  if (!model) {
    setStatus('Pilih model dulu.');
    return;
  }

  addMessage('user', text);
  state.messages.push({ role: 'user', content: text });
  inputEl.value = '';

  state.assistantText = '';
  state.requestId = crypto.randomUUID();
  state.assistantBubble = addMessage('assistant', '');
  setBusy(true);
  setStatus('Mengirim...');

  const result = await window.sahabat.startChat({
    requestId: state.requestId,
    model,
    temperature: 0.7,
    maxTokens: 4096,
    messages: buildPayloadMessages()
  });

  if (!result.ok) {
    const bubble = state.assistantBubble;
    bubble.classList.add('error');
    bubble.textContent = result.error ? result.error.message : 'Gagal mengirim pesan.';
    setBusy(false);
    state.requestId = null;
    setStatus('');
  }
}

function stopMessage() {
  if (state.requestId) {
    window.sahabat.abortChat(state.requestId);
    setStatus('Menghentikan...');
  }
}

function renderSnippet() {
  const base = state.baseUrl;
  const model = currentModel() || 'MiniMax-M3';
  const key = 'sk-sm-YOUR_KEY_HERE';
  let text = '';
  if (state.snippetKind === 'curl') {
    text = 'curl ' + base + '/chat/completions \\\n' +
      '  -H "Authorization: Bearer ' + key + '" \\\n' +
      '  -H "Content-Type: application/json" \\\n' +
      "  -d '{\n" +
      '    "model": "' + model + '",\n' +
      '    "messages": [{"role":"user","content":"Halo!"}],\n' +
      '    "stream": false\n' +
      "  }'";
  } else if (state.snippetKind === 'python') {
    text = 'from openai import OpenAI\n\n' +
      'client = OpenAI(\n' +
      '    base_url="' + base + '",\n' +
      '    api_key="' + key + '",\n' +
      ')\n\n' +
      'resp = client.chat.completions.create(\n' +
      '    model="' + model + '",\n' +
      '    messages=[{"role": "user", "content": "Halo!"}],\n' +
      ')\n' +
      'print(resp.choices[0].message.content)';
  } else if (state.snippetKind === 'node') {
    text = 'import OpenAI from "openai";\n\n' +
      'const client = new OpenAI({\n' +
      '  baseURL: "' + base + '",\n' +
      '  apiKey: "' + key + '",\n' +
      '});\n\n' +
      'const resp = await client.chat.completions.create({\n' +
      '  model: "' + model + '",\n' +
      '  messages: [{ role: "user", content: "Halo!" }],\n' +
      '});\n' +
      'console.log(resp.choices[0].message.content);';
  } else {
    text = '{\n' +
      '  "$schema": "https://opencode.ai/config.json",\n' +
      '  "provider": {\n' +
      '    "sahabatmobile": {\n' +
      '      "npm": "@ai-sdk/openai-compatible",\n' +
      '      "name": "SahabatMobile",\n' +
      '      "options": { "baseURL": "' + base + '" },\n' +
      '      "models": { "' + model + '": { "name": "' + model + '" } }\n' +
      '    }\n' +
      '  }\n' +
      '}';
  }
  snippetBox.textContent = text;
}

function renderModelList() {
  const query = modelSearch.value.trim().toLowerCase();
  modelList.innerHTML = '';
  const filtered = state.models.filter((m) =>
    !query || m.id.toLowerCase().includes(query) || (m.name || '').toLowerCase().includes(query)
  );
  if (!filtered.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = state.hasKey ? 'Tidak ada model yang cocok.' : 'Isi API key dulu untuk memuat model.';
    modelList.appendChild(empty);
    return;
  }
  for (const model of filtered) {
    const row = document.createElement('div');
    row.className = 'model-row';
    const info = document.createElement('div');
    info.className = 'model-info';
    const name = document.createElement('div');
    name.className = 'model-name';
    name.textContent = model.name || model.id;
    const id = document.createElement('div');
    id.className = 'model-id';
    id.textContent = model.id;
    info.appendChild(name);
    info.appendChild(id);
    const copy = document.createElement('button');
    copy.className = 'ghost small';
    copy.textContent = 'Salin ID';
    copy.addEventListener('click', () => copyWithFeedback(copy, model.id, 'Salin ID'));
    row.appendChild(info);
    row.appendChild(copy);
    modelList.appendChild(row);
  }
}

async function copyWithFeedback(button, text, original) {
  await window.sahabat.copyText(text);
  button.textContent = 'Tersalin';
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

async function testConnection() {
  testResult.textContent = 'Menguji...';
  const result = await window.sahabat.listModels();
  if (result.ok) {
    testResult.textContent = 'Berhasil · ' + result.models.length + ' model';
    populateModels(result.models);
  } else {
    testResult.textContent = 'Gagal · ' + (result.error && result.error.message ? result.error.message : 'tidak diketahui');
  }
}

window.sahabat.onChunk((data) => {
  if (data.requestId !== state.requestId) return;
  state.assistantText += data.delta;
  if (state.assistantBubble) appendToBubble(state.assistantBubble, data.delta);
  setStatus('Mengetik...');
});

window.sahabat.onDone((data) => {
  if (data.requestId !== state.requestId) return;
  if (state.assistantText) {
    state.messages.push({ role: 'assistant', content: state.assistantText });
  }
  setBusy(false);
  state.requestId = null;
  state.assistantBubble = null;
  const tokens = data.usage && data.usage.total_tokens;
  setStatus(data.aborted ? 'Dihentikan' : tokens ? 'Selesai · ' + tokens + ' token' : 'Selesai');
});

window.sahabat.onError((data) => {
  if (data.requestId !== state.requestId) return;
  if (state.assistantBubble) {
    state.assistantBubble.classList.add('error');
    state.assistantBubble.textContent = data.message || 'Terjadi kesalahan.';
  }
  setBusy(false);
  state.requestId = null;
  setStatus('');
});

document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', () => switchTab(item.dataset.tab));
});

document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', () => {
    const target = $(button.dataset.copy);
    if (target) copyWithFeedback(button, target.textContent, 'Salin');
  });
});

document.querySelectorAll('#snippetTabs .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    state.snippetKind = chip.dataset.snippet;
    document.querySelectorAll('#snippetTabs .chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderSnippet();
  });
});

sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', stopMessage);
refreshBtn.addEventListener('click', loadModels);
$('openSettings').addEventListener('click', openSettings);
$('cancelSettings').addEventListener('click', closeSettings);
$('saveSettings').addEventListener('click', saveSettings);
$('copyKeyBtn').addEventListener('click', async () => {
  const result = await window.sahabat.copyKey();
  const button = $('copyKeyBtn');
  button.textContent = result.ok ? 'Tersalin' : 'Key kosong';
  setTimeout(() => {
    button.textContent = 'Salin key';
  }, 1200);
});
$('testConnBtn').addEventListener('click', testConnection);
$('copySnippetBtn').addEventListener('click', () => copyWithFeedback($('copySnippetBtn'), snippetBox.textContent, 'Salin snippet'));

modelSelect.addEventListener('change', () => {
  localStorage.setItem('sahabat.model', modelSelect.value);
  updateModelTargets();
});

modelSearch.addEventListener('input', renderModelList);

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  systemInput.value = localStorage.getItem('sahabat.system') || '';
  await refreshSettings();
  switchTab('chat');
  if (state.hasKey) {
    await loadModels();
  } else {
    openSettings();
  }
});
