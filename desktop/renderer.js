(() => {
  'use strict';

  const api = window.sahabat;
  const VIEW_TITLES = {
    chat: 'Chat',
    workspace: 'Workspace Developer',
    remote: 'Remote SSH',
    models: 'Model',
    api: 'API & Snippet'
  };
  const MODE_MAP = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css', json: 'json', md: 'markdown',
    markdown: 'markdown', sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql',
    xml: 'xml', svg: 'xml', yaml: 'yaml', yml: 'yaml', rs: 'rust', go: 'golang',
    php: 'php', rb: 'ruby', java: 'java', c: 'c_cpp', h: 'c_cpp', cpp: 'c_cpp',
    hpp: 'c_cpp', cs: 'csharp', ini: 'ini', conf: 'ini', toml: 'text', txt: 'text'
  };
  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'Lihat isi sebuah folder di workspace. Path relatif terhadap root workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path folder, mis. "." atau "src"' } }, required: ['path'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Baca isi file teks di workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path file relatif terhadap root' } }, required: ['path'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Tulis atau timpa file di workspace dengan isi baru. Gunakan untuk membuat/mengubah kode.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path file relatif terhadap root' },
            content: { type: 'string', description: 'Isi file lengkap yang baru' }
          },
          required: ['path', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Jalankan perintah shell di workspace (PowerShell di Windows). Akan dikonfirmasi pengguna.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Perintah yang akan dijalankan' },
            cwd: { type: 'string', description: 'Direktori kerja relatif terhadap root, opsional' }
          },
          required: ['command']
        }
      }
    }
  ];

  const S = {
    settings: { baseUrl: 'https://www.sahabatmobile.com/api/v1', hasKey: false, keyHint: '' },
    models: [],
    model: localStorage.getItem('sahabat.model') || '',
    view: 'chat',
    chat: [],
    busy: false,
    requestId: null,
    workspace: { root: null, tree: [] },
    local: { editor: null, tabs: [], active: null, term: null, fit: null, termId: null, expanded: new Set() },
    agent: { messages: [], busy: false },
    ssh: { id: null, dir: null, editor: null, tabs: [], active: null, term: null, fit: null }
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  const dirName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

  function modeFor(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    return 'ace/mode/' + (MODE_MAP[ext] || 'text');
  }

  function aceSetup() {
    ace.config.set('basePath', 'vendor/ace');
    ace.config.set('modePath', 'vendor/ace');
    ace.config.set('themePath', 'vendor/ace');
    ace.config.set('workerPath', 'vendor/ace');
  }

  function makeEditor(elId) {
    const editor = ace.edit(elId);
    editor.setTheme('ace/theme/tomorrow_night');
    editor.session.setUseWorker(false);
    editor.setOptions({
      fontSize: '13px',
      fontFamily: 'Consolas, ui-monospace, monospace',
      showPrintMargin: false,
      useSoftTabs: true,
      tabSize: 2,
      wrap: false,
      highlightActiveLine: true
    });
    return editor;
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function updateKeyBadge() {
    const badge = $('keyBadge');
    if (S.settings.hasKey) {
      badge.textContent = 'Key •••• ' + (S.settings.keyHint || '');
      badge.className = 'badge on';
    } else {
      badge.textContent = 'Key belum diisi';
      badge.className = 'badge off';
    }
  }

  function setStatus(text) {
    $('chatStatus').textContent = text || '';
  }

  function currentModel() {
    return S.model || (S.models[0] && S.models[0].id) || 'MiniMax-M3';
  }

  function setModel(id) {
    if (!id) return;
    S.model = id;
    localStorage.setItem('sahabat.model', id);
    const sel = $('modelSelect');
    if ([...sel.options].some((o) => o.value === id)) sel.value = id;
    $('apiModel').textContent = id;
    renderSnippet();
  }

  function renderModelOptions() {
    const sel = $('modelSelect');
    sel.innerHTML = '';
    if (!S.models.length) {
      const opt = document.createElement('option');
      opt.value = currentModel();
      opt.textContent = currentModel();
      sel.appendChild(opt);
    } else {
      for (const m of S.models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.id;
        sel.appendChild(opt);
      }
      if (!S.models.some((m) => m.id === S.model)) S.model = S.models[0].id;
      sel.value = S.model;
    }
    $('apiModel').textContent = currentModel();
    renderSnippet();
  }

  // ---------- Views ----------
  function switchView(view) {
    S.view = view;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    const target = $('view-' + view);
    if (target) target.classList.remove('hidden');
    $('viewTitle').textContent = VIEW_TITLES[view] || view;
    if (view === 'workspace') ensureLocalWorkspace();
    if (view === 'remote') ensureRemoteEditor();
    if (view === 'models' && S.settings.hasKey) renderModelList();
    setTimeout(() => {
      fitAll();
      try { S.local.editor && S.local.editor.resize(true); } catch {}
      try { S.ssh.editor && S.ssh.editor.resize(true); } catch {}
    }, 80);
  }

  // ---------- Chat ----------
  function chatAdd(role, text) {
    const empty = $('chat').querySelector('.empty');
    if (empty) empty.remove();
    const row = document.createElement('div');
    row.className = 'message ' + role;
    row.innerHTML = '<div class="avatar">' + (role === 'user' ? 'You' : role === 'error' ? '!' : 'AI') + '</div><div class="bubble"></div>';
    row.querySelector('.bubble').textContent = text;
    $('chat').appendChild(row);
    $('chat').scrollTop = $('chat').scrollHeight;
    return row.querySelector('.bubble');
  }

  async function sendChat() {
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text || S.busy) return;
    if (!S.settings.hasKey) { openSettings(); return; }
    input.value = '';
    S.busy = true;
    $('sendChat').classList.add('hidden');
    $('stopChat').classList.remove('hidden');
    setStatus('Menghubungi model...');
    S.chat.push({ role: 'user', content: text });
    chatAdd('user', text);
    const bubble = chatAdd('assistant', '');
    const requestId = 'req-' + Date.now();
    S.requestId = requestId;
    let full = '';
    const offChunk = api.onChunk((d) => {
      if (d.requestId !== requestId) return;
      full += d.delta || '';
      bubble.textContent = full;
      $('chat').scrollTop = $('chat').scrollHeight;
      setStatus('Mengetik...');
    });
    const offDone = api.onDone((d) => {
      if (d.requestId !== requestId) return;
      cleanup();
      if (d.aborted) {
        setStatus('Dihentikan');
      } else {
        S.chat.push({ role: 'assistant', content: full });
        setStatus('');
      }
    });
    const offErr = api.onError((d) => {
      if (d.requestId !== requestId) return;
      cleanup();
      bubble.parentElement.classList.add('error');
      bubble.textContent = d.message || 'Terjadi kesalahan.';
      setStatus('');
    });
    function cleanup() {
      offChunk(); offDone(); offErr();
      S.busy = false;
      S.requestId = null;
      $('sendChat').classList.remove('hidden');
      $('stopChat').classList.add('hidden');
    }
    const res = await api.startChat({
      requestId,
      model: currentModel(),
      messages: S.chat.slice(-20)
    });
    if (!res.ok) {
      cleanup();
      bubble.parentElement.classList.add('error');
      bubble.textContent = (res.error && res.error.message) || 'Gagal mengirim.';
      setStatus('');
    }
  }

  // ---------- Workspace: tree ----------
  function renderTree(container, nodes, depth) {
    container.innerHTML = '';
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      row.dataset.path = node.path;
      if (node.dir) {
        const open = S.local.expanded.has(node.path);
        row.innerHTML = '<span class="caret">' + (open ? '▾' : '▸') + '</span><span class="fname">' + esc(node.name) + '</span>';
        row.addEventListener('click', () => {
          if (S.local.expanded.has(node.path)) S.local.expanded.delete(node.path);
          else S.local.expanded.add(node.path);
          renderTree(container, nodes, depth);
        });
        container.appendChild(row);
        if (open) renderTree(container, node.children || [], depth + 1);
      } else {
        row.innerHTML = '<span class="caret">·</span><span class="fname">' + esc(node.name) + '</span>';
        row.addEventListener('click', () => openLocalFile(node.path));
        container.appendChild(row);
      }
    }
  }

  function loadWorkspaceTree(tree) {
    S.workspace.tree = tree || [];
    renderTree($('fileTree'), S.workspace.tree, 0);
  }

  async function ensureLocalWorkspace() {
    if (!S.local.editor) {
      S.local.editor = makeEditor('editor');
      S.local.editor.commands.addCommand({
        name: 'save',
        bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
        exec: () => saveActiveLocal()
      });
    }
    initLocalTerminal();
    if (!S.workspace.root) {
      const info = await api.workspaceInfo();
      if (info.ok) {
        S.workspace.root = info.root;
        $('wsRoot').textContent = info.root;
        loadWorkspaceTree(info.tree);
      }
    } else {
      const info = await api.workspaceTree();
      if (info.ok) loadWorkspaceTree(info.tree);
    }
    setTimeout(() => { try { S.local.fit && S.local.fit.fit(); } catch {} }, 80);
  }

  async function openFolder() {
    const res = await api.openFolder();
    if (!res.ok) return;
    S.workspace.root = res.root;
    S.local.expanded.clear();
    $('wsRoot').textContent = res.root;
    loadWorkspaceTree(res.tree);
    if (S.local.termId) {
      api.stopTerminal(S.local.termId);
      S.local.termId = null;
    }
    startLocalTerminal(res.root);
    toast('Folder dibuka: ' + dirName(res.root));
  }

  function renderLocalTabs() {
    const bar = $('tabbar');
    bar.innerHTML = '';
    for (const tab of S.local.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab === S.local.active ? ' active' : '');
      el.innerHTML = '<span class="tab-name">' + esc(tab.name) + (tab.dirty ? ' •' : '') + '</span><span class="tab-close">×</span>';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) { closeLocalTab(tab); return; }
        activateLocalTab(tab);
      });
      bar.appendChild(el);
    }
  }

  function activateLocalTab(tab) {
    S.local.active = tab;
    S.local.editor.setSession(tab.session);
    renderLocalTabs();
  }

  async function openLocalFile(filePath) {
    const existing = S.local.tabs.find((t) => t.path === filePath);
    if (existing) { activateLocalTab(existing); return; }
    const res = await api.readFile(filePath);
    if (!res.ok) { toast(res.error || 'Gagal membuka file'); return; }
    const session = ace.createEditSession(res.content);
    session.setMode(modeFor(filePath));
    session.setUseWorker(false);
    const tab = { path: res.path, name: baseName(res.path), session, dirty: false };
    session.on('change', () => {
      if (!tab.dirty) { tab.dirty = true; renderLocalTabs(); }
    });
    S.local.tabs.push(tab);
    activateLocalTab(tab);
  }

  function closeLocalTab(tab) {
    if (tab.dirty && !confirm('File "' + tab.name + '" belum disimpan. Tutup saja?')) return;
    const idx = S.local.tabs.indexOf(tab);
    S.local.tabs.splice(idx, 1);
    if (S.local.active === tab) {
      const next = S.local.tabs[Math.max(0, idx - 1)];
      S.local.active = next || null;
      if (next) S.local.editor.setSession(next.session);
      else S.local.editor.setSession(ace.createEditSession(''));
    }
    renderLocalTabs();
  }

  async function saveActiveLocal() {
    const tab = S.local.active;
    if (!tab) return;
    const res = await api.writeFile(tab.path, S.local.editor.getValue());
    if (!res.ok) { toast(res.error || 'Gagal menyimpan'); return; }
    tab.dirty = false;
    renderLocalTabs();
    const info = await api.workspaceTree();
    if (info.ok) loadWorkspaceTree(info.tree);
    toast('Tersimpan: ' + tab.name);
  }

  // ---------- Workspace: terminal ----------
  function initLocalTerminal() {
    if (S.local.term) return;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'Consolas, ui-monospace, monospace',
      cursorBlink: true,
      convertEol: true,
      theme: { background: '#0b0e13', foreground: '#e6e9ef', cursor: '#3b82f6', selectionBackground: '#264f78' }
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('termLocal'));
    try { fit.fit(); } catch {}
    term.onData((d) => { if (S.local.termId) api.terminalInput(S.local.termId, d); });
    S.local.term = term;
    S.local.fit = fit;
    startLocalTerminal(S.workspace.root);
  }

  async function startLocalTerminal(cwd) {
    if (S.local.termId) return;
    const res = await api.startTerminal({ cwd: cwd || undefined });
    if (!res.ok) {
      S.local.term && S.local.term.writeln('\r\n[gagal memulai terminal] ' + (res.error || ''));
      return;
    }
    S.local.termId = res.id;
    S.local.term && S.local.term.writeln('SahabatMobile terminal — ' + (res.shell || 'shell'));
  }

  // ---------- Agent ----------
  function agentLog(html, cls) {
    const el = document.createElement('div');
    el.className = 'agent-item ' + (cls || '');
    el.innerHTML = html;
    $('agentLog').appendChild(el);
    $('agentLog').scrollTop = $('agentLog').scrollHeight;
    return el;
  }

  function agentSystemPrompt() {
    return [
      'Anda adalah agen coding di dalam aplikasi SahabatMobile Desktop.',
      'Workspace root: ' + (S.workspace.root || '(belum dibuka)'),
      'Gunakan tools untuk membaca/menulis file dan menjalankan perintah.',
      'Selalu pakai path relatif terhadap workspace root. Jangan menulis di luar root.',
      'Kerjakan tugas langkah demi langkah, lalu jelaskan hasil akhir secara singkat dalam Bahasa Indonesia.'
    ].join('\n');
  }

  async function execTool(name, args) {
    if (name === 'list_dir') return api.agentListDir(args.path || '.');
    if (name === 'read_file') return api.agentReadFile(args.path);
    if (name === 'write_file') return api.agentWriteFile(args.path, args.content ?? '');
    if (name === 'run_command') return api.agentRunCommand(args.command, args.cwd, 120000);
    return { ok: false, error: 'Tool tidak dikenal: ' + name };
  }

  async function sendAgent() {
    const input = $('agentInput');
    const text = input.value.trim();
    if (!text || S.agent.busy) return;
    if (!S.settings.hasKey) { openSettings(); return; }
    if (!S.workspace.root) { toast('Buka folder kerja dulu.'); return; }
    input.value = '';
    S.agent.busy = true;
    $('agentSend').classList.add('hidden');
    $('agentStatus').textContent = 'Bekerja...';
    S.agent.messages.push({ role: 'user', content: text });
    agentLog('<div class="agent-user">' + esc(text) + '</div>', 'user');

    const messages = [{ role: 'system', content: agentSystemPrompt() }, ...S.agent.messages];
    let loops = 0;
    let wrote = false;
    while (loops < 8) {
      loops += 1;
      const res = await api.completeChat({ model: currentModel(), messages, tools: TOOLS, maxTokens: 4096 });
      if (!res.ok) {
        agentLog('<div class="agent-error">' + esc((res.error && res.error.message) || 'Gagal memanggil model.') + '</div>', 'error');
        break;
      }
      const msg = res.message || {};
      messages.push(msg);
      S.agent.messages.push(msg);
      if (msg.content && String(msg.content).trim()) {
        agentLog('<div class="agent-ai">' + esc(msg.content) + '</div>', 'ai');
      }
      const calls = msg.tool_calls || [];
      if (!calls.length) break;
      for (const call of calls) {
        const fn = (call.function && call.function.name) || '';
        let args = {};
        try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch {}
        agentLog('<div class="agent-tool"><span class="tool-name">' + esc(fn) + '</span> <span class="tool-args">' + esc(JSON.stringify(args)) + '</span></div>', 'tool');
        const result = await execTool(fn, args);
        const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        S.agent.messages.push({ role: 'tool', tool_call_id: call.id, content: output });
        agentLog('<details class="agent-result"><summary>' + esc(fn) + ' selesai</summary><pre>' + esc(output.slice(0, 4000)) + '</pre></details>', 'result');
        if (fn === 'write_file') wrote = true;
      }
      if (wrote) {
        wrote = false;
        const info = await api.workspaceTree();
        if (info.ok) loadWorkspaceTree(info.tree);
      }
    }
    S.agent.busy = false;
    $('agentSend').classList.remove('hidden');
    $('agentStatus').textContent = '';
    const info = await api.workspaceTree();
    if (info.ok) loadWorkspaceTree(info.tree);
  }

  // ---------- Remote SSH ----------
  function ensureRemoteEditor() {
    if (!S.ssh.editor) {
      S.ssh.editor = makeEditor('reditor');
      S.ssh.editor.commands.addCommand({
        name: 'save',
        bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
        exec: () => saveActiveRemote()
      });
    }
    if (!S.ssh.term) {
      const term = new Terminal({
        fontSize: 12,
        fontFamily: 'Consolas, ui-monospace, monospace',
        cursorBlink: true,
        theme: { background: '#0b0e13', foreground: '#e6e9ef', cursor: '#3b82f6', selectionBackground: '#264f78' }
      });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open($('sshTerm'));
      try { fit.fit(); } catch {}
      term.onData((d) => { if (S.ssh.id) api.sshInput(S.ssh.id, d); });
      S.ssh.term = term;
      S.ssh.fit = fit;
    }
    setTimeout(() => { try { S.ssh.fit && S.ssh.fit.fit(); } catch {} }, 60);
  }

  function renderRemoteList(items, dir) {
    const box = $('sshTree');
    box.innerHTML = '';
    if (dir !== '/') {
      const up = document.createElement('div');
      up.className = 'tree-row';
      up.innerHTML = '<span class="caret">↑</span><span class="fname">..</span>';
      up.addEventListener('click', () => loadRemoteDir(dir.replace(/\/+[^/]+\/?$/, '') || '/'));
      box.appendChild(up);
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.innerHTML = '<span class="caret">' + (item.dir ? '▸' : '·') + '</span><span class="fname">' + esc(item.name) + '</span>';
      row.addEventListener('click', () => {
        if (item.dir) loadRemoteDir(item.path);
        else openRemoteFile(item.path);
      });
      box.appendChild(row);
    }
  }

  async function loadRemoteDir(dir) {
    if (!S.ssh.id) return;
    const res = await api.sshListDir(S.ssh.id, dir);
    if (!res.ok) { toast(res.error || 'Gagal membaca folder remote'); return; }
    S.ssh.dir = res.dir;
    $('sshRoot').textContent = res.dir;
    renderRemoteList(res.items, res.dir);
  }

  function renderRemoteTabs() {
    const bar = $('rtabbar');
    bar.innerHTML = '';
    for (const tab of S.ssh.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab === S.ssh.active ? ' active' : '');
      el.innerHTML = '<span class="tab-name">' + esc(tab.name) + (tab.dirty ? ' •' : '') + '</span><span class="tab-close">×</span>';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) { closeRemoteTab(tab); return; }
        S.ssh.active = tab;
        S.ssh.editor.setSession(tab.session);
        renderRemoteTabs();
      });
      bar.appendChild(el);
    }
  }

  async function openRemoteFile(filePath) {
    if (!S.ssh.id) return;
    const existing = S.ssh.tabs.find((t) => t.path === filePath);
    if (existing) {
      S.ssh.active = existing;
      S.ssh.editor.setSession(existing.session);
      renderRemoteTabs();
      return;
    }
    const res = await api.sshReadFile(S.ssh.id, filePath);
    if (!res.ok) { toast(res.error || 'Gagal membuka file remote'); return; }
    const session = ace.createEditSession(res.content);
    session.setMode(modeFor(filePath));
    session.setUseWorker(false);
    const tab = { path: filePath, name: baseName(filePath), session, dirty: false };
    session.on('change', () => { if (!tab.dirty) { tab.dirty = true; renderRemoteTabs(); } });
    S.ssh.tabs.push(tab);
    S.ssh.active = tab;
    S.ssh.editor.setSession(session);
    renderRemoteTabs();
  }

  function closeRemoteTab(tab) {
    if (tab.dirty && !confirm('File "' + tab.name + '" belum disimpan. Tutup saja?')) return;
    const idx = S.ssh.tabs.indexOf(tab);
    S.ssh.tabs.splice(idx, 1);
    if (S.ssh.active === tab) {
      const next = S.ssh.tabs[Math.max(0, idx - 1)];
      S.ssh.active = next || null;
      if (next) S.ssh.editor.setSession(next.session);
      else S.ssh.editor.setSession(ace.createEditSession(''));
    }
    renderRemoteTabs();
  }

  async function saveActiveRemote() {
    const tab = S.ssh.active;
    if (!tab || !S.ssh.id) return;
    const res = await api.sshWriteFile(S.ssh.id, tab.path, S.ssh.editor.getValue());
    if (!res.ok) { toast(res.error || 'Gagal menyimpan remote'); return; }
    tab.dirty = false;
    renderRemoteTabs();
    toast('Tersimpan: ' + tab.name);
  }

  async function connectSsh(e) {
    e.preventDefault();
    const host = $('sshHost').value.trim();
    const username = $('sshUser').value.trim();
    if (!host || !username) return;
    const btn = $('sshConnect');
    btn.disabled = true;
    btn.textContent = 'Menghubungkan...';
    const res = await api.sshConnect({
      host,
      port: Number($('sshPort').value) || 22,
      username,
      authType: $('sshAuth').value,
      password: $('sshPassword').value,
      privateKey: $('sshKey').value,
      passphrase: $('sshPassphrase') ? $('sshPassphrase').value : ''
    });
    btn.disabled = false;
    btn.textContent = 'Hubungkan';
    if (!res.ok) { toast('SSH gagal: ' + (res.error || 'unknown')); return; }
    S.ssh.id = res.id;
    S.ssh.tabs = [];
    S.ssh.active = null;
    $('sshDisconnect').classList.remove('hidden');
    $('sshRoot').textContent = res.home;
    ensureRemoteEditor();
    S.ssh.term.reset();
    S.ssh.term.writeln('Terhubung ke ' + username + '@' + host + ':' + (Number($('sshPort').value) || 22));
    const shell = await api.sshShell(res.id, S.ssh.term.cols, S.ssh.term.rows);
    if (!shell.ok) toast('Shell gagal: ' + (shell.error || ''));
    loadRemoteDir(res.home);
    toast('SSH terhubung');
  }

  async function disconnectSsh() {
    if (!S.ssh.id) return;
    await api.sshDisconnect(S.ssh.id);
    S.ssh.id = null;
    $('sshDisconnect').classList.add('hidden');
    $('sshRoot').textContent = 'Belum terhubung';
    $('sshTree').innerHTML = '';
    $('rtabbar').innerHTML = '';
    S.ssh.tabs = [];
    if (S.ssh.term) S.ssh.term.writeln('\r\n[koneksi diputus]');
  }

  // ---------- Models & snippets ----------
  function renderModelList() {
    const q = ($('modelSearch').value || '').toLowerCase();
    const list = S.models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q));
    const box = $('modelList');
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="muted">' + (S.settings.hasKey ? 'Tidak ada model yang cocok.' : 'Isi API key dulu untuk memuat model.') + '</p>';
      return;
    }
    for (const m of list) {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.innerHTML =
        '<div class="model-info"><div class="model-name">' + esc(m.name || m.id) + '</div>' +
        '<div class="model-id">' + esc(m.id) + (m.owner ? ' · ' + esc(m.owner) : '') + '</div></div>' +
        '<div class="model-actions"><button class="ghost small use">Pakai</button><button class="ghost small copy">Salin</button></div>';
      row.querySelector('.use').addEventListener('click', () => { setModel(m.id); toast('Model aktif: ' + m.id); });
      row.querySelector('.copy').addEventListener('click', async () => { await api.copyText(m.id); toast('ID disalin'); });
      box.appendChild(row);
    }
  }

  async function loadModels() {
    const res = await api.listModels();
    if (!res.ok) {
      S.models = [];
      renderModelOptions();
      renderModelList();
      if (S.settings.hasKey) toast((res.error && res.error.message) || 'Gagal memuat model');
      return;
    }
    S.models = res.models || [];
    renderModelOptions();
    renderModelList();
  }

  function renderSnippet() {
    const base = S.settings.baseUrl || 'https://www.sahabatmobile.com/api/v1';
    const model = currentModel();
    const snippet = buildSnippet(S.snippet || 'curl', base, model);
    $('snippetCode').textContent = snippet;
    $('apiBase').textContent = base;
    $('apiModel').textContent = model;
  }

  function buildSnippet(kind, base, model) {
    if (kind === 'python') {
      return [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        '    base_url="' + base + '",',
        '    api_key="sk-..."',
        ')',
        '',
        'resp = client.chat.completions.create(',
        '    model="' + model + '",',
        '    messages=[{"role": "user", "content": "Halo!"}],',
        ')',
        'print(resp.choices[0].message.content)'
      ].join('\n');
    }
    if (kind === 'node') {
      return [
        'import OpenAI from "openai";',
        '',
        'const client = new OpenAI({',
        '  baseURL: "' + base + '",',
        '  apiKey: "sk-...",',
        '});',
        '',
        'const resp = await client.chat.completions.create({',
        '  model: "' + model + '",',
        '  messages: [{ role: "user", content: "Halo!" }],',
        '});',
        'console.log(resp.choices[0].message.content);'
      ].join('\n');
    }
    if (kind === 'opencode') {
      return JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          sahabatmobile: {
            npm: '@ai-sdk/openai-compatible',
            name: 'SahabatMobile',
            options: { baseURL: base, apiKey: '{env:SAHABAT_API_KEY}' },
            models: { [model]: { name: model } }
          }
        }
      }, null, 2);
    }
    return [
      'curl ' + base + '/chat/completions \\',
      '  -H "Content-Type: application/json" \\',
      '  -H "Authorization: Bearer sk-..." \\',
      '  -d \'{"model":"' + model + '","messages":[{"role":"user","content":"Halo!"}]}\''
    ].join('\n');
  }

  // ---------- Settings ----------
  function openSettings() {
    $('apiKeyInput').value = '';
    $('baseUrlInput').value = S.settings.baseUrl || '';
    $('settingsModal').classList.remove('hidden');
    setTimeout(() => $('apiKeyInput').focus(), 50);
  }

  async function saveSettings() {
    const payload = { baseUrl: $('baseUrlInput').value.trim() };
    const key = $('apiKeyInput').value.trim();
    if (key) payload.apiKey = key;
    const res = await api.saveSettings(payload);
    S.settings = res;
    updateKeyBadge();
    $('settingsModal').classList.add('hidden');
    if (S.settings.hasKey) loadModels();
    if (S.local.tabs.length === 0) renderSnippet();
  }

  // ---------- Boot ----------
  function fitAll() {
    try { S.local.fit && S.local.fit.fit(); } catch {}
    try { S.ssh.fit && S.ssh.fit.fit(); } catch {}
  }

  function bind() {
    document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
    $('sendChat').addEventListener('click', sendChat);
    $('stopChat').addEventListener('click', () => { if (S.requestId) api.abortChat(S.requestId); });
    $('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    $('modelSelect').addEventListener('change', (e) => setModel(e.target.value));
    $('openSettings').addEventListener('click', openSettings);
    $('cancelSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
    $('saveSettings').addEventListener('click', saveSettings);
    $('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') $('settingsModal').classList.add('hidden'); });

    $('openFolder').addEventListener('click', openFolder);
    $('refreshModels').addEventListener('click', loadModels);
    $('modelSearch').addEventListener('input', renderModelList);

    $('termToggle').addEventListener('click', () => {
      const pane = $('localTermPane');
      pane.classList.toggle('collapsed');
      $('termToggle').textContent = pane.classList.contains('collapsed') ? '+' : '–';
      setTimeout(fitAll, 80);
    });
    $('termClear').addEventListener('click', () => S.local.term && S.local.term.clear());

    $('agentSend').addEventListener('click', sendAgent);
    $('agentInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAgent(); }
    });

    $('snippetChips').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-snippet]');
      if (!btn) return;
      S.snippet = btn.dataset.snippet;
      document.querySelectorAll('#snippetChips .chip').forEach((c) => c.classList.toggle('active', c === btn));
      renderSnippet();
    });
    $('copyBase').addEventListener('click', async () => { await api.copyText(S.settings.baseUrl); toast('Base URL disalin'); });
    $('copySnippet').addEventListener('click', async () => { await api.copyText($('snippetCode').textContent); toast('Snippet disalin'); });

    $('sshAuth').addEventListener('change', () => {
      const key = $('sshAuth').value === 'key';
      $('sshKeyField').classList.toggle('hidden', !key);
      $('sshPassField').classList.toggle('hidden', key);
    });
    $('sshForm').addEventListener('submit', connectSsh);
    $('sshDisconnect').addEventListener('click', disconnectSsh);
    $('sshRefresh').addEventListener('click', () => { if (S.ssh.dir) loadRemoteDir(S.ssh.dir); });
    $('sshTermToggle').addEventListener('click', () => {
      const pane = $('sshTermPane');
      pane.classList.toggle('collapsed');
      $('sshTermToggle').textContent = pane.classList.contains('collapsed') ? '+' : '–';
      setTimeout(fitAll, 80);
    });
    $('sshTermClear').addEventListener('click', () => S.ssh.term && S.ssh.term.clear());

    window.addEventListener('resize', fitAll);
    window.addEventListener('beforeunload', () => {
      if (S.ssh.id) api.sshDisconnect(S.ssh.id);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (S.view === 'remote') saveActiveRemote();
        else if (S.view === 'workspace') saveActiveLocal();
      }
    });
  }

  async function init() {
    aceSetup();
    bind();
    S.settings = await api.getSettings();
    updateKeyBadge();
    renderModelOptions();

    api.onTermData((d) => {
      if (S.local.term && d.id === S.local.termId) S.local.term.write(d.data);
    });
    api.onTermExit((d) => {
      if (d.id === S.local.termId) {
        S.local.termId = null;
        if (S.local.term) S.local.term.writeln('\r\n[terminal berhenti, kode ' + d.code + ']');
      }
    });
    api.onSshData((d) => {
      if (S.ssh.term && d.id === S.ssh.id) S.ssh.term.write(d.data);
    });
    api.onSshExit((d) => {
      if (d.id === S.ssh.id && S.ssh.term) S.ssh.term.writeln('\r\n[shell SSH selesai]');
    });
    api.onSshClosed((d) => {
      if (d.id === S.ssh.id) {
        S.ssh.id = null;
        $('sshDisconnect').classList.add('hidden');
        $('sshRoot').textContent = 'Koneksi terputus';
        if (S.ssh.term) S.ssh.term.writeln('\r\n[koneksi SSH terputus]');
      }
    });

    renderSnippet();
    if (S.settings.hasKey) loadModels();
    else setTimeout(openSettings, 400);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
