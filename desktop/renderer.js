const chatEl = document.getElementById('chat');
const emptyState = document.getElementById('emptyState');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const modelSelect = document.getElementById('modelSelect');
const refreshBtn = document.getElementById('refreshModels');
const settingsModal = document.getElementById('settingsModal');
const baseUrlInput = document.getElementById('baseUrlInput');
const apiKeyInput = document.getElementById('apiKeyInput');
const keyHint = document.getElementById('keyHint');
const systemInput = document.getElementById('systemInput');

const state = {
  messages: [],
  models: [],
  busy: false,
  requestId: null,
  assistantBubble: null,
  assistantText: '',
  usage: null
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

function populateModels(models) {
  state.models = models;
  modelSelect.innerHTML = '';
  if (!models.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Tidak ada model';
    modelSelect.appendChild(opt);
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
}

async function loadModels() {
  if (!state.hasKey) return;
  setStatus('Memuat model...');
  const result = await window.sahabat.listModels();
  if (result.ok) {
    populateModels(result.models);
    setStatus(result.models.length + ' model tersedia');
  } else {
    setStatus('Gagal memuat model: ' + (result.error.message || ''));
  }
}

async function refreshSettings() {
  const settings = await window.sahabat.getSettings();
  state.hasKey = settings.hasKey;
  baseUrlInput.value = settings.baseUrl || '';
  keyHint.textContent = settings.hasKey
    ? 'Key tersimpan: ' + settings.keyHint
    : 'Belum ada API key tersimpan.';
  apiKeyInput.value = '';
}

function openSettings() {
  refreshSettings().then(() => settingsModal.classList.remove('hidden'));
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

async function saveSettings() {
  const payload = {
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value.trim()
  };
  const settings = await window.sahabat.saveSettings(payload);
  state.hasKey = settings.hasKey;
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

function buildPayloadMessages(userText) {
  const messages = [];
  const system = (localStorage.getItem('sahabat.system') || '').trim();
  if (system) messages.push({ role: 'system', content: system });
  for (const msg of state.messages) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: userText });
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
  const model = modelSelect.value;
  if (!model) {
    setStatus('Pilih model dulu.');
    return;
  }

  addMessage('user', text);
  state.messages.push({ role: 'user', content: text });
  inputEl.value = '';

  state.assistantText = '';
  state.usage = null;
  state.requestId = crypto.randomUUID();
  state.assistantBubble = addMessage('assistant', '');
  setBusy(true);
  setStatus('Mengirim...');

  const result = await window.sahabat.startChat({
    requestId: state.requestId,
    model,
    temperature: 0.7,
    maxTokens: 4096,
    messages: buildPayloadMessages(text)
  });

  if (!result.ok) {
    const bubble = state.assistantBubble;
    bubble.classList.add('error');
    bubble.textContent = result.error ? result.error.message : 'Gagal mengirim pesan.';
    setBusy(false);
    state.requestId = null;
    setStatus('');
    return;
  }
}

function stopMessage() {
  if (state.requestId) {
    window.sahabat.abortChat(state.requestId);
    setStatus('Menghentikan...');
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

sendBtn.addEventListener('click', sendMessage);
stopBtn.addEventListener('click', stopMessage);
refreshBtn.addEventListener('click', loadModels);
document.getElementById('openSettings').addEventListener('click', openSettings);
document.getElementById('cancelSettings').addEventListener('click', closeSettings);
document.getElementById('saveSettings').addEventListener('click', saveSettings);

modelSelect.addEventListener('change', () => {
  localStorage.setItem('sahabat.model', modelSelect.value);
});

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  systemInput.value = localStorage.getItem('sahabat.system') || '';
  await refreshSettings();
  if (state.hasKey) {
    await loadModels();
  } else {
    openSettings();
  }
});
