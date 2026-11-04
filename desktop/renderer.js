(() => {
  'use strict';

  const api = window.sahabat;
  const VIEW_TITLES = { chat: 'Chat', workspace: 'Workspace Developer', models: 'Model', api: 'API & Snippet', extensions: 'Extensions' };
  const EXT_MODES = {};
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
        description: 'Lihat isi folder pada explorer aktif (lokal/SSH/FTP).',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path folder, mis. "."' } }, required: ['path'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Baca isi file teks pada explorer aktif.',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path file' } }, required: ['path'] }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Tulis atau buat file pada explorer aktif. Gunakan untuk membuat/memperbaiki kode.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path file' },
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
        description: 'Jalankan perintah shell (lokal atau SSH). Akan dikonfirmasi pengguna. Tidak tersedia untuk FTP.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Perintah yang akan dijalankan' },
            cwd: { type: 'string', description: 'Direktori kerja, opsional' }
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
    local: { root: null, tree: [], expanded: new Set() },
    target: { type: 'local', id: null },
    connections: [],
    savedConnections: [],
    remotes: new Map(),
    editor: null,
    tabs: [],
    active: null,
    terms: { local: { term: null, fit: null, id: null, cwd: null }, remote: { term: null, fit: null, sessionId: null } },
    agent: { messages: [], busy: false },
    snippet: 'curl',
    cloneDir: null,
    mapTarget: null,
    clipboard: null,
    extensions: [],
    extCatalog: [],
    extApplied: new Set(),
    extSearchTerm: '',
    extSearchTimer: null,
    extMarket: [],
    extMarketLoading: false,
    extMarketLoaded: false,
    extUpdates: {},
    extSelected: null,
    extFilter: 'all',
    ui: {
      sideWidth: parseInt(localStorage.getItem('sahabat.sideWidth'), 10) || 252,
      agentWidth: parseInt(localStorage.getItem('sahabat.agentWidth'), 10) || 344
    }
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  const dirName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  const joinRemote = (dir, name) => (String(dir).replace(/\/+$/, '') || '') + '/' + name;

  function modeFor(name) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    return 'ace/mode/' + (EXT_MODES[ext] || MODE_MAP[ext] || 'text');
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
    document.querySelectorAll('.act[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    const target = $('view-' + view);
    if (target) target.classList.remove('hidden');
    $('viewTitle').textContent = VIEW_TITLES[view] || view;
    const connectionOpen = !$('connectionPane').classList.contains('hidden');
    const showExtensionsPane = view === 'extensions';
    const showWorkspacePane = view === 'workspace';
    $('app').classList.toggle('no-side', !showExtensionsPane && !showWorkspacePane);
    if (showWorkspacePane) {
      $('extensionPane').classList.add('hidden');
      $('explorerPane').classList.toggle('hidden', connectionOpen);
      $('connectionPane').classList.toggle('hidden', !connectionOpen);
    } else if (showExtensionsPane) {
      $('explorerPane').classList.add('hidden');
      $('connectionPane').classList.add('hidden');
      $('extensionPane').classList.remove('hidden');
      if (!S.extMarketLoaded) loadRecommendedExtensions(true);
    } else {
      $('explorerPane').classList.add('hidden');
      $('connectionPane').classList.add('hidden');
      $('extensionPane').classList.add('hidden');
    }
    if (view === 'workspace') {
      ensureWorkspace();
    }
    if (view === 'models' && S.settings.hasKey) renderModelList();
    if (view === 'extensions') renderExtensions();
    setTimeout(() => {
      fitAll();
      try { S.editor && S.editor.resize(true); } catch {}
    }, 80);
  }

  // ---------- Explorer ----------
  function targetValue() {
    return S.target.type === 'local' ? 'local' : S.target.id;
  }

  function renderTargetSelect() {
    const sel = $('targetSelect');
    sel.innerHTML = '';
    const localOpt = document.createElement('option');
    localOpt.value = 'local';
    localOpt.textContent = 'Lokal';
    sel.appendChild(localOpt);

    if (S.savedConnections.length) {
      const group = document.createElement('optgroup');
      group.label = 'Tersimpan';
      for (const profile of S.savedConnections) {
        const opt = document.createElement('option');
        opt.value = 'saved:' + profile.id;
        const protocol = String(profile.protocol || 'sftp').toUpperCase();
        const label = protocol + ' · ' + (profile.username || '?') + '@' + (profile.host || '?') + ':' + (profile.port || (profile.protocol === 'sftp' ? 22 : 21));
        opt.textContent = label;
        opt.title = profile.name || label;
        group.appendChild(opt);
      }
      sel.appendChild(group);
    }

    if (S.connections.length) {
      const group = document.createElement('optgroup');
      group.label = 'Terhubung';
      for (const c of S.connections) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        group.appendChild(opt);
      }
      sel.appendChild(group);
    }
    sel.value = targetValue();
  }

  function setSideStatus(text) {
    $('sideStatus').textContent = text;
  }

  async function refreshSavedConnections() {
    try {
      const res = await api.listConnections();
      S.savedConnections = res.ok && Array.isArray(res.connections) ? res.connections : [];
    } catch {
      S.savedConnections = [];
    }
    renderTargetSelect();
  }

  function remoteSession() {
    if (S.target.type === 'local') return null;
    return S.remotes.get(S.target.id) || null;
  }

  function renderLocalTree() {
    $('fileTree').innerHTML = '';
    if (!S.local.root) {
      $('wsRoot').textContent = 'Belum ada folder';
      const hint = document.createElement('div');
      hint.className = 'tree-empty';
      hint.textContent = 'Buka folder atau clone repository untuk mulai.';
      $('fileTree').appendChild(hint);
      return;
    }
    $('wsRoot').textContent = S.local.root;
    renderTreeNodes(S.local.tree, 0);
  }

  function renderTreeNodes(nodes, depth) {
    const box = $('fileTree');
    for (const node of nodes) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = 8 + depth * 14 + 'px';
      row.title = node.path;
      if (node.dir) {
        const open = S.local.expanded.has(node.path);
        row.innerHTML = '<span class="caret">' + (open ? '▾' : '▸') + '</span><span class="fname">' + esc(node.name) + '</span>';
        row.addEventListener('click', () => {
          if (S.local.expanded.has(node.path)) S.local.expanded.delete(node.path);
          else S.local.expanded.add(node.path);
          $('fileTree').innerHTML = '';
          renderTreeNodes(S.local.tree, 0);
        });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showEntryMenu(e.clientX, e.clientY, node); });
        box.appendChild(row);
        if (open) renderTreeNodes(node.children || [], depth + 1);
      } else {
        row.innerHTML = '<span class="caret">·</span><span class="fname">' + esc(node.name) + '</span>';
        row.addEventListener('click', () => openFile(node.path));
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showEntryMenu(e.clientX, e.clientY, node); });
        box.appendChild(row);
      }
    }
  }

  function renderRemoteTree(dir, items) {
    $('fileTree').innerHTML = '';
    $('wsRoot').textContent = dir;
    const session = remoteSession();
    const status = session ? session.type.toUpperCase() + ' · ' + dir : dir;
    setSideStatus(status);
    if (dir && dir !== '/') {
      const up = document.createElement('div');
      up.className = 'tree-row';
      up.innerHTML = '<span class="caret">↑</span><span class="fname">..</span>';
      up.addEventListener('click', () => {
        const parent = dir.replace(/\/+[^/]+\/?$/, '') || '/';
        loadRemoteDir(parent);
      });
      $('fileTree').appendChild(up);
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.title = item.path;
      row.innerHTML = '<span class="caret">' + (item.dir ? '▸' : '·') + '</span><span class="fname">' + esc(item.name) + '</span>';
      row.addEventListener('click', () => {
        if (item.dir) loadRemoteDir(item.path);
        else openFile(item.path);
      });
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showEntryMenu(e.clientX, e.clientY, item); });
      $('fileTree').appendChild(row);
    }
  }

  function currentTarget() {
    return { type: S.target.type, id: S.target.id };
  }

  function parentPathOf(p) {
    const s = String(p || '');
    if (S.target.type !== 'local') {
      const d = s.replace(/\/+[^/]+\/?$/, '');
      return d || '/';
    }
    const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (idx < 0) return s;
    if (idx === 2 && /^[A-Za-z]:/.test(s)) return s.slice(0, 3);
    return s.slice(0, idx);
  }

  function joinForTarget(dir, name) {
    if (S.target.type !== 'local') return joinRemote(dir, name);
    return String(dir || '').replace(/[\\/]+$/, '') + '/' + name;
  }

  function hideContextMenu() {
    const menu = $('contextMenu');
    menu.classList.add('hidden');
    menu.innerHTML = '';
  }

  function showContextMenu(x, y, items) {
    const menu = $('contextMenu');
    menu.innerHTML = '';
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'context-sep';
        menu.appendChild(sep);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'context-item';
      btn.textContent = item.label;
      btn.disabled = Boolean(item.disabled);
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        hideContextMenu();
        try { await item.action(); } catch (err) { toast(err.message || 'Gagal'); }
      });
      menu.appendChild(btn);
    }
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - rect.width - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - rect.height - 6)) + 'px';
  }

  function showEntryMenu(x, y, node) {
    const target = currentTarget();
    const folder = node.dir ? node.path : parentPathOf(node.path);
    showContextMenu(x, y, [
      { label: 'Edit', disabled: node.dir, action: () => openFile(node.path) },
      { label: 'Rename', action: () => renameEntry(node) },
      { label: 'Move to...', action: () => moveEntry(node) },
      { sep: true },
      { label: 'Copy', action: () => { S.clipboard = { target, path: node.path, name: node.name, isDir: node.dir, cut: false }; toast('Disalin: ' + node.name); } },
      { label: 'Cut', action: () => { S.clipboard = { target, path: node.path, name: node.name, isDir: node.dir, cut: true }; toast('Siap dipindah: ' + node.name); } },
      { label: 'Paste', disabled: !S.clipboard, action: () => pasteInto(folder) },
      { label: 'Copy path', action: async () => { await api.copyText(node.path); toast('Path disalin'); } },
      { sep: true },
      { label: 'Upload file...', action: () => uploadInto(folder, 'file') },
      { label: 'Upload folder...', action: () => uploadInto(folder, 'folder') },
      { label: 'Download...', action: () => downloadEntryFor(node) },
      { sep: true },
      { label: 'New file', action: () => createEntry('file', folder) },
      { label: 'New folder', action: () => createEntry('dir', folder) },
      { sep: true },
      { label: 'Buka di terminal', disabled: !node.dir, action: () => openInTerminal(node) },
      { label: 'Map drive...', disabled: !node.dir || S.target.type !== 'ssh', action: () => openMapDrive(node) },
      { label: 'Refresh', action: () => refreshExplorer() },
      { sep: true },
      { label: 'Koneksi SSH baru...', action: () => openConnectionForm() },
      { label: 'Putuskan SSH', disabled: S.target.type !== 'ssh', action: () => disconnectRemote() },
      { sep: true },
      { label: 'Delete', action: () => deleteEntry(node) }
    ]);
  }

  function showBlankMenu(x, y) {
    const session = remoteSession();
    const dir = session ? (session.dir || session.home) : S.local.root;
    showContextMenu(x, y, [
      { label: 'New file', disabled: !dir, action: () => createEntry('file', dir) },
      { label: 'New folder', disabled: !dir, action: () => createEntry('dir', dir) },
      { label: 'Paste', disabled: !S.clipboard || !dir, action: () => pasteInto(dir) },
      { sep: true },
      { label: 'Upload file...', disabled: !dir, action: () => uploadInto(dir, 'file') },
      { label: 'Upload folder...', disabled: !dir, action: () => uploadInto(dir, 'folder') },
      { sep: true },
      { label: 'Buka di terminal', disabled: !dir, action: () => openInTerminal({ path: dir, name: baseName(dir), dir: true }) },
      { label: 'Map drive...', disabled: !dir || S.target.type !== 'ssh', action: () => openMapDrive({ path: dir, name: baseName(dir), dir: true }) },
      { label: 'Koneksi SSH baru...', action: () => openConnectionForm() },
      { label: 'Putuskan SSH', disabled: S.target.type !== 'ssh', action: () => disconnectRemote() },
      { label: 'Refresh', action: () => refreshExplorer() }
    ]);
  }

  async function deleteEntry(node) {
    const where = S.target.type === 'local' ? 'lokal' : S.target.type.toUpperCase();
    if (!confirm('Hapus ' + (node.dir ? 'folder ' : 'file ') + node.name + ' dari explorer ' + where + '?')) return;
    const res = S.target.type === 'local'
      ? await api.removeFile(node.path)
      : await api.remoteRemove(S.target.id, node.path, node.dir);
    if (!res.ok) { toast(res.error || 'Gagal menghapus'); return; }
    await refreshExplorer();
    toast('Dihapus: ' + node.name);
  }

  async function renameEntry(node) {
    const name = await askText('Rename', 'Nama baru', 'Rename', node.name);
    if (!name || name === node.name) return;
    if (/[\\/]/.test(name)) { toast('Nama tidak boleh mengandung / atau \\'); return; }
    const dstPath = joinForTarget(parentPathOf(node.path), name);
    const res = await api.entryMove({ srcTarget: currentTarget(), srcPath: node.path, dstTarget: currentTarget(), dstPath, isDir: node.dir });
    if (!res.ok) { toast(res.error || 'Gagal rename'); return; }
    for (const tab of S.tabs) {
      if (!node.dir && tab.path === node.path) {
        tab.path = dstPath;
        tab.name = name;
        tab.key = tabKey(tab.target, dstPath);
      } else if (node.dir && tab.path.startsWith(node.path)) {
        tab.path = dstPath + tab.path.slice(node.path.length);
        tab.key = tabKey(tab.target, tab.path);
      }
    }
    renderTabs();
    await refreshExplorer();
    toast('Diubah nama: ' + name);
  }

  async function moveEntry(node) {
    const destDir = await askText('Pindahkan ke folder', 'Path folder tujuan', 'Pindah', parentPathOf(node.path));
    if (!destDir) return;
    const dstPath = joinForTarget(destDir.replace(/[\\/]+$/, ''), node.name);
    if (dstPath === node.path) return;
    const res = await api.entryMove({ srcTarget: currentTarget(), srcPath: node.path, dstTarget: currentTarget(), dstPath, isDir: node.dir });
    if (!res.ok) { toast(res.error || 'Gagal memindahkan'); return; }
    await refreshExplorer();
    toast('Dipindah ke ' + dstPath);
  }

  async function pasteInto(destDir) {
    if (!S.clipboard) { toast('Clipboard kosong'); return; }
    if (!destDir) { toast('Pilih folder tujuan dulu'); return; }
    const src = S.clipboard;
    const res = await api.entryCopy({
      srcTarget: src.target,
      srcPath: src.path,
      dstTarget: currentTarget(),
      dstDir: destDir,
      isDir: src.isDir,
      cut: src.cut
    });
    if (!res.ok) { toast(res.error || 'Gagal paste'); return; }
    if (src.cut) S.clipboard = null;
    await refreshExplorer();
    toast(src.cut ? 'Dipindah' : 'Paste selesai');
  }

  async function refreshExplorer() {
    if (S.target.type === 'local') {
      if (!S.local.root) { renderLocalTree(); return; }
      const info = await api.workspaceTree();
      if (info.ok) { S.local.tree = info.tree; S.local.root = info.root; }
      renderLocalTree();
      setSideStatus('Lokal · ' + (S.local.root || '-'));
    } else {
      const session = remoteSession();
      if (!session) return;
      await loadRemoteDir(session.dir || session.home);
    }
  }

  async function loadRemoteDir(dir) {
    const session = remoteSession();
    if (!session) return;
    const res = await api.remoteListDir(session.id, dir);
    if (!res.ok) { toast(res.error || 'Gagal membaca folder remote'); return; }
    session.dir = res.dir;
    renderRemoteTree(res.dir, res.items);
  }

  function updateExplorerChrome() {
    const remote = S.target.type !== 'local';
    $('disconnectRemote').classList.toggle('hidden', !remote);
    $('sshDisconnectTop').classList.toggle('hidden', S.target.type !== 'ssh');
    $('mapDriveTop').classList.toggle('hidden', S.target.type !== 'ssh');
    $('openFolder').classList.toggle('hidden', remote);
    $('cloneRepo').classList.toggle('hidden', remote);
    $('newFile').disabled = false;
    $('newFolder').disabled = false;
    $('agentTarget').textContent = remote
      ? (S.target.type.toUpperCase() + ' ' + (remoteSession() ? remoteSession().label.replace(/^(SSH|FTP) /, '') : ''))
      : 'lokal';
  }

  async function ensureWorkspace() {
    if (!S.editor) {
      S.editor = makeEditor('editor');
      S.editor.commands.addCommand({
        name: 'save',
        bindKey: { win: 'Ctrl-S', mac: 'Cmd-S' },
        exec: () => saveActive()
      });
    }
    ensureLocalTerminal();
    updateExplorerChrome();
    if (S.target.type === 'local') {
      if (!S.local.root) {
        const info = await api.workspaceInfo();
        if (info.ok) {
          S.local.root = info.root;
          S.local.tree = info.tree;
        }
      }
      renderLocalTree();
      setSideStatus('Lokal · ' + (S.local.root || 'belum ada folder'));
      showTerminal('local');
    } else {
      const session = remoteSession();
      if (session) {
        await loadRemoteDir(session.dir || session.home);
        showTerminal(session.type === 'ssh' ? 'remote' : 'blocked');
      }
    }
    setTimeout(() => { try { S.terms.local.fit && S.terms.local.fit.fit(); } catch {} }, 80);
  }

  async function switchTarget(value) {
    if (value.startsWith('saved:')) {
      await connectSavedProfile(value.slice(6));
      return;
    }
    if (value === 'local') {
      S.target = { type: 'local', id: null };
    } else {
      const conn = S.connections.find((c) => c.id === value);
      if (!conn) {
        renderTargetSelect();
        return;
      }
      S.target = { type: conn.type, id: conn.id };
    }
    renderTargetSelect();
    await ensureWorkspace();
  }

  // ---------- Connection ----------
  function openConnectionForm() {
    $('explorerPane').classList.add('hidden');
    $('connectionPane').classList.remove('hidden');
    $('connProtocol').value = 'sftp';
    $('connPort').value = '22';
    $('connHost').value = '';
    $('connUser').value = '';
    $('connPassword').value = '';
    $('connKey').value = '';
    $('connName').value = '';
    $('connSave').checked = true;
    $('connPassphrase').value = '';
    $('connKeyField').classList.remove('hidden');
    $('connPassphraseField').classList.remove('hidden');
    setTimeout(() => $('connHost').focus(), 60);
  }

  function closeConnectionForm() {
    $('connectionPane').classList.add('hidden');
    $('explorerPane').classList.remove('hidden');
  }

  async function connectRemote(e) {
    e.preventDefault();
    const protocol = $('connProtocol').value;
    const btn = $('connSubmit');
    btn.disabled = true;
    btn.textContent = 'Menghubungkan...';
    const res = await api.remoteConnect({
      protocol,
      name: $('connName').value.trim(),
      host: $('connHost').value.trim(),
      port: Number($('connPort').value) || (protocol === 'sftp' ? 22 : 21),
      username: $('connUser').value.trim(),
      password: $('connPassword').value,
      passphrase: $('connPassphrase').value,
      authType: protocol === 'sftp' && $('connKey').value.trim() ? 'key' : 'password',
      privateKey: $('connKey').value.trim(),
      saveConnection: $('connSave').checked
    });
    btn.disabled = false;
    btn.textContent = 'Hubungkan';
    if (!res.ok) { toast('Koneksi gagal: ' + (res.error || 'unknown')); return; }
    const conn = { id: res.id, type: res.type, label: res.label, home: res.home, dir: res.home, host: res.host, port: res.port, username: res.username, savedId: res.saved && res.saved.id };
    S.connections.push(conn);
    S.remotes.set(res.id, conn);
    if (res.saved) toast('Koneksi tersimpan: ' + res.saved.name);
    if (res.saved) await refreshSavedConnections();
    renderTargetSelect();
    closeConnectionForm();
    await switchTarget(res.id);
    switchView('workspace');
    toast('Terhubung: ' + res.label);
  }

  function openSavedConnections() {
    renderSavedConnections();
    $('connectionsModal').classList.remove('hidden');
  }

  function closeSavedConnections() {
    $('connectionsModal').classList.add('hidden');
  }

  async function renderSavedConnections() {
    const box = $('connectionsList');
    box.innerHTML = '<div class="tree-empty">Memuat koneksi...</div>';
    const res = await api.listConnections();
    if (!res.ok) {
      box.innerHTML = '<div class="tree-empty">Gagal memuat: ' + esc(res.error || 'unknown') + '</div>';
      return;
    }
    box.innerHTML = '';
    const items = res.connections || [];
    if (!items.length) {
      box.innerHTML = '<div class="tree-empty">Belum ada koneksi tersimpan. Isi form “Koneksi baru” dan centang Simpan.</div>';
      return;
    }
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'connection-item';
      const protocol = item.protocol.toUpperCase();
      const auth = item.authType === 'key' ? 'Private key' + (item.privateKeyName ? ' · ' + item.privateKeyName : '') : (item.hasPassword ? 'Password' : 'Tanpa password');
      const last = item.lastConnected ? ' · Terakhir dipakai: ' + new Date(item.lastConnected).toLocaleString('id-ID') : '';
      card.innerHTML = '<div class="connection-main"><strong>' + esc(item.name) + '</strong><span>' + esc(protocol + ' ' + item.username + '@' + item.host + ':' + item.port) + '</span><small>' + esc(auth + last) + '</small></div>';
      const actions = document.createElement('div');
      actions.className = 'connection-actions';
      const connect = document.createElement('button');
      connect.className = 'primary small';
      connect.textContent = 'Hubungkan';
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        await connectSavedProfile(item.id);
      });
      const remove = document.createElement('button');
      remove.className = 'ghost small danger';
      remove.textContent = 'Hapus';
      remove.addEventListener('click', async () => {
        if (!confirm('Hapus koneksi "' + item.name + '" dari penyimpanan?')) return;
        const result = await api.removeConnection(item.id);
        if (!result.ok) { toast(result.error || 'Gagal menghapus koneksi'); return; }
        await renderSavedConnections();
        await refreshSavedConnections();
        toast('Koneksi dihapus');
      });
      actions.appendChild(connect);
      actions.appendChild(remove);
      card.appendChild(actions);
      box.appendChild(card);
    }
  }

  async function connectSavedProfile(id) {
    const res = await api.connectSaved(id);
    if (!res.ok) { toast('Koneksi gagal: ' + (res.error || 'unknown')); return; }
    const conn = { id: res.id, type: res.type, label: res.label, home: res.home, dir: res.home, host: res.host, port: res.port, username: res.username, savedId: id };
    S.connections.push(conn);
    S.remotes.set(res.id, conn);
    renderTargetSelect();
    closeSavedConnections();
    await switchTarget(res.id);
    switchView('workspace');
    toast('Terhubung: ' + res.label);
  }

  async function disconnectRemote() {
    if (S.target.type === 'local') return;
    const id = S.target.id;
    await api.remoteDisconnect(id);
    S.connections = S.connections.filter((c) => c.id !== id);
    S.remotes.delete(id);
    S.tabs = S.tabs.filter((t) => t.target.id !== id);
    if (S.active && S.active.target.id === id) {
      S.active = S.tabs[S.tabs.length - 1] || null;
      setActiveSession(S.active);
    }
    renderTabs();
    S.target = { type: 'local', id: null };
    renderTargetSelect();
    await ensureWorkspace();
    toast('Koneksi diputus');
  }

  // ---------- Editor ----------
  function aceSetup() {
    ace.config.set('basePath', 'vendor/ace');
    ace.config.set('modePath', 'vendor/ace');
    ace.config.set('themePath', 'vendor/ace');
    ace.config.set('workerPath', 'vendor/ace');
  }

  function editorThemeName() {
    return localStorage.getItem('sahabat.editorTheme') || 'tomorrow_night';
  }

  function makeEditor(elId) {
    const editor = ace.edit(elId);
    editor.setTheme('ace/theme/' + editorThemeName());
    editor.session.setUseWorker(false);
    editor.setReadOnly(false);
    editor.setOptions({
      fontSize: '13px',
      fontFamily: 'Consolas, ui-monospace, monospace',
      showPrintMargin: false,
      useSoftTabs: true,
      tabSize: 2,
      wrap: false,
      highlightActiveLine: true,
      displayIndentGuides: true,
      showFoldWidgets: true,
      enableBasicAutocompletion: true,
      enableSnippets: true,
      enableLiveAutocompletion: false
    });
    editor.commands.addCommand({
      name: 'gotoLineCustom',
      bindKey: { win: 'Ctrl-G', mac: 'Cmd-G' },
      exec: () => gotoEditorLine()
    });
    editor.container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showEditorMenu(e.clientX, e.clientY);
    });
    return editor;
  }

  function tabKey(target, filePath) {
    return (target.id || 'local') + ':' + filePath;
  }

  function renderTabs() {
    const bar = $('tabbar');
    bar.innerHTML = '';
    for (const tab of S.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab === S.active ? ' active' : '');
      const badge = tab.target.type === 'local' ? '' : '<span class="tab-badge">' + tab.target.type.toUpperCase() + '</span>';
      el.innerHTML = badge + '<span class="tab-name">' + esc(tab.name) + (tab.dirty ? ' •' : '') + '</span><span class="tab-close">×</span>';
      el.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close')) { closeTab(tab); return; }
        S.active = tab;
        S.editor.setSession(tab.session);
        renderTabs();
        S.editor.focus();
      });
      bar.appendChild(el);
    }
  }

  function setActiveSession(tab) {
    if (tab) S.editor.setSession(tab.session);
    else S.editor.setSession(ace.createEditSession(''));
  }

  async function openFile(filePath) {
    const target = { type: S.target.type, id: S.target.id };
    const key = tabKey(target, filePath);
    const existing = S.tabs.find((t) => t.key === key);
    if (existing) {
      S.active = existing;
      S.editor.setSession(existing.session);
      renderTabs();
      S.editor.focus();
      return;
    }
    const res = target.type === 'local'
      ? await api.readFile(filePath)
      : await api.remoteReadFile(target.id, filePath);
    if (!res.ok) { toast(res.error || 'Gagal membuka file'); return; }
    const session = ace.createEditSession(res.content);
    session.setMode(modeFor(filePath));
    session.setUseWorker(false);
    const tab = { key, path: filePath, name: baseName(filePath), session, dirty: false, target };
    session.on('change', () => { if (!tab.dirty) { tab.dirty = true; renderTabs(); } });
    S.tabs.push(tab);
    S.active = tab;
    S.editor.setSession(session);
    renderTabs();
    setTimeout(() => S.editor.focus(), 30);
  }

  function closeTab(tab) {
    if (tab.dirty && !confirm('File "' + tab.name + '" belum disimpan. Tutup saja?')) return;
    const idx = S.tabs.indexOf(tab);
    S.tabs.splice(idx, 1);
    if (S.active === tab) {
      S.active = S.tabs[Math.max(0, idx - 1)] || null;
      setActiveSession(S.active);
    }
    renderTabs();
  }

  async function saveActive() {
    const tab = S.active;
    if (!tab) return;
    const content = S.editor.getValue();
    const res = tab.target.type === 'local'
      ? await api.writeFile(tab.path, content)
      : await api.remoteWriteFile(tab.target.id, tab.path, content);
    if (!res.ok) { toast(res.error || 'Gagal menyimpan'); return; }
    tab.dirty = false;
    renderTabs();
    await refreshExplorer();
    toast('Tersimpan: ' + tab.name);
  }

  async function createEntry(kind, targetDir) {
    const name = await askText(kind === 'file' ? 'Nama file baru' : 'Nama folder baru', kind === 'file' ? 'mis. index.html' : 'mis. src');
    if (!name) return;
    if (/[\\/]/.test(name)) { toast('Nama tidak boleh mengandung / atau \\'); return; }
    const session = remoteSession();
    let created;
    let full;
    if (session) {
      const parent = targetDir || session.dir || session.home;
      full = joinRemote(parent, name);
      created = kind === 'file' ? await api.remoteWriteFile(session.id, full, '') : await api.remoteMkdir(session.id, full);
    } else {
      if (!S.local.root) { toast('Buka folder dulu.'); return; }
      const parent = targetDir || S.local.root;
      full = joinForTarget(parent, name);
      created = kind === 'file' ? await api.writeFile(full, '') : await api.mkdir(full);
    }
    if (!created.ok) { toast(created.error || 'Gagal membuat'); return; }
    await refreshExplorer();
    if (kind === 'file') openFile(full);
  }

  // ---------- Editor context menu ----------
  function insertAtCursor(text) {
    if (!S.editor) return;
    S.editor.session.insert(S.editor.getCursorPosition(), text);
    S.editor.focus();
  }

  async function gotoEditorLine() {
    const value = await askText('Ke baris', 'Nomor baris', 'Ke baris');
    const line = parseInt(value, 10);
    if (line > 0 && S.editor) {
      S.editor.gotoLine(line, 0, true);
      S.editor.focus();
    }
  }

  function showEditorMenu(x, y) {
    const ed = S.editor;
    if (!ed) return;
    const hasSel = ed.getSelectedText().length > 0;
    showContextMenu(x, y, [
      { label: 'Undo', action: () => { ed.undo(); ed.focus(); } },
      { label: 'Redo', action: () => { ed.redo(); ed.focus(); } },
      { sep: true },
      {
        label: 'Cut', disabled: !hasSel, action: async () => {
          await api.copyText(ed.getSelectedText());
          ed.session.remove(ed.getSelectionRange());
          ed.focus();
        }
      },
      { label: 'Copy', disabled: !hasSel, action: async () => { await api.copyText(ed.getSelectedText()); ed.focus(); } },
      {
        label: 'Paste', action: async () => {
          const res = await api.readClipboard();
          if (res.ok && res.text) insertAtCursor(res.text);
        }
      },
      {
        label: 'Delete', action: () => {
          if (hasSel) ed.session.remove(ed.getSelectionRange());
          else {
            const pos = ed.getCursorPosition();
            ed.session.remove({ start: pos, end: { row: pos.row, column: pos.column + 1 } });
          }
          ed.focus();
        }
      },
      { label: 'Select all', action: () => { ed.selectAll(); ed.focus(); } },
      { sep: true },
      { label: 'Find', action: () => { ed.focus(); ed.execCommand('find'); } },
      { label: 'Replace', action: () => { ed.focus(); ed.execCommand('replace'); } },
      { label: 'Go to line', action: () => gotoEditorLine() },
      { label: 'Toggle comment', action: () => { ed.toggleCommentLines(); ed.focus(); } },
      { sep: true },
      { label: 'Save', disabled: !S.active, action: () => saveActive() }
    ]);
  }

  // ---------- Panel resize ----------
  function applySideWidth(width, persist) {
    const max = Math.max(200, Math.min(560, window.innerWidth - 620));
    const w = Math.max(168, Math.min(width, max));
    S.ui.sideWidth = w;
    const panel = $('sidepanel');
    panel.style.width = w + 'px';
    panel.style.flex = '0 0 ' + w + 'px';
    if (persist) localStorage.setItem('sahabat.sideWidth', String(w));
    try { S.editor && S.editor.resize(true); } catch {}
  }

  function applyAgentWidth(width, persist) {
    const max = Math.max(260, window.innerWidth - 380);
    const w = Math.max(240, Math.min(width, max));
    S.ui.agentWidth = w;
    document.documentElement.style.setProperty('--agent-width', w + 'px');
    if (persist) localStorage.setItem('sahabat.agentWidth', String(w));
    try { S.editor && S.editor.resize(true); } catch {}
  }

  function bindResizers() {
    const attach = (el, onDelta, onReset) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const startX = e.clientX;
        el.setPointerCapture(e.pointerId);
        document.body.classList.add('resizing');
        const move = (ev) => onDelta(ev.clientX - startX);
        const finish = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', finish);
          el.removeEventListener('pointercancel', finish);
          document.body.classList.remove('resizing');
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', finish);
        el.addEventListener('pointercancel', finish);
      });
      el.addEventListener('dblclick', onReset);
    };
    attach($('resizeLeft'), (delta) => {
      const start = S.ui.sideWidth;
      applySideWidth(start + delta, true);
    }, () => applySideWidth(252, true));
    attach($('resizeAgent'), (delta) => {
      const start = S.ui.agentWidth;
      applyAgentWidth(start - delta, true);
    }, () => applyAgentWidth(344, true));
  }

  // ---------- Extensions ----------
  function formatDownloads(value) {
    const n = Number(value || 0);
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + ' M unduhan';
    if (n >= 1000) return Math.round(n / 1000).toLocaleString('id-ID') + ' Ribu unduhan';
    return n.toLocaleString('id-ID') + ' unduhan';
  }

  function formatRating(value) {
    const n = Number(value || 0);
    if (!n) return 'Belum ada rating';
    return n.toFixed(1) + ' dari 5 (' + Math.round(n * 10) / 10 + '/5)';
  }

  function extMatches(ext, query) {
    if (!query) return true;
    return (ext.id + ' ' + (ext.name || '') + ' ' + (ext.description || '') + ' ' + (ext.publisher || ext.namespace || '')).toLowerCase().includes(query);
  }

  function openVsxUrl(ext) {
    if (ext.repository && /^https?:\/\//i.test(ext.repository)) return ext.repository;
    if (ext.namespace && ext.name) return 'https://open-vsx.org/extension/' + ext.namespace + '/' + ext.name;
    return 'https://open-vsx.org';
  }

  function extIconHtml(ext, className) {
    if (ext.iconDataUrl) return '<img class="' + className + '" src="' + esc(ext.iconDataUrl) + '" alt="" />';
    if (ext.icon) return '<img class="' + className + '" src="' + esc(ext.icon) + '" alt="" />';
    let hash = 0;
    for (const ch of String(ext.id || ext.name || '?')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = hash % 360;
    const letter = String(ext.name || ext.id || '?').trim().charAt(0).toUpperCase() || '?';
    return '<div class="' + className + ' ext-avatar" style="background:hsl(' + hue + ' 65% 34%)">' + esc(letter) + '</div>';
  }

  function findExtension(id) {
    return S.extensions.find((ext) => ext.id === id)
      || S.extCatalog.find((ext) => ext.id === id)
      || S.extMarket.find((ext) => ext.id === id)
      || null;
  }

  function extKindOf(ext) {
    if (S.extensions.includes(ext)) return 'installed';
    if (S.extCatalog.includes(ext)) return 'catalog';
    return 'market';
  }

  function extensionSourceLabel(ext) {
    if (!ext.source) return 'Lokal';
    if (ext.source.registry === 'openvsx') return 'Open VSX';
    if (ext.source.registry === 'folder') return 'Folder';
    if (ext.source.registry === 'vsix') return 'VSIX';
    return 'Ekstensi';
  }

  function addExtAction(container, ext, kind, compact) {
    const source = ext.source || {};
    const update = S.extUpdates[ext.id];
    const makeButton = (label, className, action, title) => {
      const btn = document.createElement('button');
      btn.className = className;
      btn.textContent = label;
      btn.title = title || label;
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        try { await action(btn); } finally { btn.disabled = false; }
      });
      return btn;
    };

    if (kind === 'installed') {
      if (source.registry === 'openvsx') {
        container.appendChild(makeButton(update ? 'Update v' + update.latest : 'Periksa update', update ? 'primary small' : 'ghost small', async () => {
          await installOpenVsxExtension(source.namespace, source.name, update ? update.latest : undefined);
        }));
      } else if (S.extUpdates[ext.id]) {
        container.appendChild(makeButton('Update v' + S.extUpdates[ext.id].latest, 'primary small', async () => {
          await installOpenVsxExtension(source.namespace, source.name, S.extUpdates[ext.id].latest);
        }));
      }
      container.appendChild(makeButton(ext.enabled ? 'Disable' : 'Enable', 'ghost small', async () => {
        const res = await api.extSetEnabled(ext.id, !ext.enabled);
        if (!res.ok) { toast(res.error || 'Gagal mengubah status'); return; }
        await refreshExtensions();
        toast(ext.enabled ? 'Dinonaktifkan: ' + ext.name : 'Diaktifkan: ' + ext.name);
      }));
      container.appendChild(makeButton('Hapus', 'ghost small danger', async () => {
        if (!confirm('Hapus ekstensi ' + ext.name + '?')) return;
        const res = await api.extRemove(ext.id);
        if (!res.ok) { toast(res.error || 'Gagal menghapus'); return; }
        if (S.extSelected === ext.id) S.extSelected = null;
        await refreshExtensions();
        toast('Dihapus: ' + ext.name);
      }));
    } else if (kind === 'catalog') {
      container.appendChild(makeButton('Install', 'primary small', async () => {
        const res = await api.extInstallBuiltin(ext.id);
        if (!res.ok) { toast(res.error || 'Gagal install'); return; }
        await refreshExtensions();
        toast('Terpasang: ' + ext.name);
      }));
    } else {
      container.appendChild(makeButton('Install', 'primary small', async () => {
        await installOpenVsxExtension(ext.namespace, ext.name, ext.version);
      }));
      container.appendChild(makeButton('Open VSX', 'ghost small', async () => {
        const res = await api.extOpenExternal(openVsxUrl(ext));
        if (!res.ok) toast(res.error || 'Gagal membuka Open VSX');
      }));
    }
  }

  async function installOpenVsxExtension(namespace, name, version) {
    const button = document.querySelector('#extUpdateAll');
    const previous = button && button.textContent;
    if (button) { button.disabled = true; button.textContent = 'Mengunduh...'; }
    try {
      const res = await api.extInstallOpenVsx({ namespace, name, version });
      if (!res.ok) { toast(res.error || 'Gagal install dari Open VSX'); return; }
      await refreshExtensions();
      S.extSelected = res.id;
      renderExtensions();
      toast('Terpasang: ' + (res.name || name));
    } finally {
      if (button) { button.disabled = false; button.textContent = previous || ('Update semua (' + Object.keys(S.extUpdates).length + ')'); }
    }
  }

  function selectExtension(id) {
    S.extSelected = id;
    renderExtensions();
    renderExtensionDetail();
  }

  function extSideItem(ext, kind) {
    const row = document.createElement('div');
    row.className = 'ext-side-item' + (S.extSelected === ext.id ? ' selected' : '');
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.title = ext.id;

    const icon = extIconHtml(ext, 'ext-icon');
    const verified = ext.verified ? '<span class="ext-verified" title="Penerbit terverifikasi">✓</span>' : '';
    const source = extensionSourceLabel(ext);
    const update = S.extUpdates[ext.id];
    const downloadText = ext.downloadCount ? formatDownloads(ext.downloadCount) : '';

    row.innerHTML = icon
      + '<div class="ext-side-main">'
      + '<div class="ext-name-line"><span class="ext-name">' + esc(ext.name) + '</span>'
      + (update ? '<span class="ext-version-update">v' + esc(update.latest) + '</span>' : '<span class="ext-version">v' + esc(ext.version || '1.0.0') + '</span>')
      + '</div>'
      + '<div class="ext-byline">' + verified + '<span>' + esc(ext.publisher || ext.namespace || 'unknown') + '</span><span>·</span><span>' + esc(source) + '</span>'
      + (downloadText ? '<span class="ext-download">' + esc(downloadText) + '</span>' : '')
      + '</div>'
      + '<div class="ext-description">' + esc(ext.description || '') + '</div>'
      + '</div>'
      + '<div class="ext-row-action"></div>';

    const action = row.querySelector('.ext-row-action');
    if (kind === 'installed' && S.extUpdates[ext.id]) {
      const source = ext.source || {};
      const btn = document.createElement('button');
      btn.className = 'primary small';
      btn.textContent = 'Update';
      btn.title = 'Update ke v' + S.extUpdates[ext.id].latest;
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        await installOpenVsxExtension(source.namespace, source.name, S.extUpdates[ext.id].latest);
      });
      action.appendChild(btn);
    } else if (kind === 'catalog') {
      const btn = document.createElement('button');
      btn.className = 'primary small';
      btn.textContent = 'Install';
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        const res = await api.extInstallBuiltin(ext.id);
        btn.disabled = false;
        if (!res.ok) { toast(res.error || 'Gagal install'); return; }
        await refreshExtensions();
      });
      action.appendChild(btn);
    } else if (kind === 'market') {
      const btn = document.createElement('button');
      btn.className = 'primary small';
      btn.textContent = 'Install';
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        await installOpenVsxExtension(ext.namespace, ext.name, ext.version);
      });
      action.appendChild(btn);
    }
    row.addEventListener('click', () => selectExtension(ext.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectExtension(ext.id);
      }
    });
    return row;
  }

  function updateAllButton() {
    const count = Object.keys(S.extUpdates).length;
    const btn = $('extUpdateAll');
    if (!btn) return;
    btn.classList.toggle('hidden', count === 0);
    btn.textContent = 'Update semua (' + count + ')';
  }

  function renderExtensions() {
    const box = $('extList');
    const status = $('extStatus');
    if (!box) return;
    box.innerHTML = '';
    const query = S.extSearchTerm.toLowerCase().trim();
    const match = (ext) => extMatches(ext, query);
    const filter = S.extFilter || 'all';
    const installed = S.extensions.filter(match);
    const catalog = S.extCatalog.filter((ext) => !ext.installed && match(ext));
    const market = S.extMarket;
    const updates = installed.filter((ext) => S.extUpdates[ext.id]);
    const showInstalledSection = filter === 'all' || filter === 'installed' || filter === 'updates';
    const showCatalogSection = filter === 'all' || filter === 'recommended' || filter === 'builtin';
    const showMarketSection = filter === 'all' || filter === 'recommended';

    const addGroup = (name, count) => {
      const head = document.createElement('div');
      head.className = 'ext-group';
      head.textContent = count === undefined ? name : name + ' · ' + count;
      box.appendChild(head);
    };
    if (showInstalledSection) {
      const rows = filter === 'updates' ? updates : installed;
      if (rows.length) {
        addGroup(filter === 'updates' ? 'UPDATE TERSEDIA' : 'TERPASANG', rows.length);
        for (const ext of rows) box.appendChild(extSideItem(ext, 'installed'));
      }
    }
    if (showCatalogSection && catalog.length) {
      addGroup('REKOMENDASI BAWAAN', catalog.length);
      for (const ext of catalog) box.appendChild(extSideItem(ext, 'catalog'));
    }
    if (showMarketSection) {
      addGroup(query ? 'OPEN VSX' : 'REKOMENDASI TERATAS', S.extMarketLoading ? 'mencari...' : market.length);
      if (S.extMarketLoading) {
        const note = document.createElement('div');
        note.className = 'tree-empty';
        note.textContent = 'Memuat ekstensi dari Open VSX...';
        box.appendChild(note);
      } else if (market.length) {
        for (const ext of market) box.appendChild(extSideItem(ext, 'market'));
      } else {
        const note = document.createElement('div');
        note.className = 'tree-empty';
        note.textContent = 'Tidak ada ekstensi cocok di Open VSX.';
        box.appendChild(note);
      }
    }
    if (!box.children.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      if (filter === 'updates') empty.textContent = 'Semua ekstensi sudah terbaru.';
      else if (query) empty.textContent = 'Tidak ada hasil untuk "' + query + '".';
      else empty.textContent = 'Belum ada ekstensi. Klik Install atau cari di Open VSX.';
      box.appendChild(empty);
    }
    if (status) {
      const enabled = S.extensions.filter((ext) => ext.enabled).length;
      status.textContent = S.extensions.length + ' terpasang · ' + enabled + ' aktif · ' + Object.keys(S.extUpdates).length + ' update';
    }
    updateAllButton();
  }

  function renderExtensionDetail() {
    const target = $('extDetail');
    if (!target) return;
    const ext = S.extSelected ? findExtension(S.extSelected) : null;
    if (!ext) {
      target.innerHTML = '<div class="ext-welcome"><div class="ext-welcome-icon"><svg viewBox="0 0 24 24"><path d="M10 3h4v3a2 2 0 1 0 4 0h3v4h-3a2 2 0 1 0 0 4h3v4h-4v-3a2 2 0 1 0-4 0v3h-4v-3a2 2 0 1 0-4 0v3H3v-4h3a2 2 0 1 0 0-4H3V6h3a2 2 0 1 0 4 0z"/></svg></div>'
        + '<h1>Extensions</h1><p>Pasang snippet dan bahasa untuk mempercepat kerja.</p>'
        + '<div class="ext-welcome-grid"><div class="ext-welcome-item"><strong>Cari</strong><span>Ketik nama bahasa, mis. python, php, react.</span></div>'
        + '<div class="ext-welcome-item"><strong>Install</strong><span>Ambil langsung dari Open VSX atau dari file .zip.</span></div>'
        + '<div class="ext-welcome-item"><strong>Update</strong><span>Informasi update muncul otomatis.</span></div></div></div>';
      return;
    }
    const kind = extKindOf(ext);
    const byline = (ext.verified ? '<span class="ext-verified-large">✓ Terverifikasi</span>' : '')
      + '<span>' + esc(ext.publisher || ext.namespace || 'Unknown') + '</span>'
      + '<span>·</span><span>' + esc(extensionSourceLabel(ext)) + '</span>';
    const languages = (ext.contributes && ext.contributes.languages) ? Object.keys(ext.contributes.languages).slice(0, 12) : [];
    const snippetScopes = ext.snippets ? Object.keys(ext.snippets) : Object.keys((ext.contributes && ext.contributes.snippets) || {});
    target.innerHTML = '<div class="ext-detail-header">' + extIconHtml(ext, 'ext-icon-large')
      + '<div class="ext-detail-title"><div class="ext-detail-name">' + esc(ext.name) + '</div>'
      + '<div class="ext-detail-byline">' + byline + '</div></div>'
      + '<div class="ext-detail-actions" id="extDetailActions"></div></div>'
      + '<div class="ext-detail-stats">'
      + '<div><label>Versi</label><strong>' + esc(ext.version || '-') + '</strong></div>'
      + '<div><label>Download</label><strong>' + esc(formatDownloads(ext.downloadCount || 0)) + '</strong></div>'
      + '<div><label>Rating</label><strong>' + esc(formatRating(ext.rating)) + '</strong></div>'
      + '<div><label>Source</label><strong>' + esc(extensionSourceLabel(ext)) + '</strong></div>'
      + '</div>'
      + '<div class="ext-detail-section"><h2>Deskripsi</h2><p>' + esc(ext.description || 'Tidak ada deskripsi.') + '</p></div>'
      + '<div class="ext-detail-section"><h2>Kontribusi</h2><div class="ext-contribute-list">'
      + (languages.length ? languages.map((name) => '<span class="ext-badge">.' + esc(name) + '</span>').join('') : '<span class="muted">Tidak memetakan ekstensi file.</span>')
      + (snippetScopes.length ? '<div class="ext-scopes"><label>Snippet</label><div>' + snippetScopes.map((scope) => '<span class="ext-badge">' + esc(scope) + '</span>').join('') + '</div></div>' : '')
      + '</div></div>'
      + '<div class="ext-detail-section"><h2>Kemampuan</h2><ul class="ext-detail-list"><li>Autocomplete berbasis snippet Ace</li><li>Pewarnaan sintaks untuk bahasa yang tersedia</li><li>Install/update/hapus tanpa restart penuh</li></ul></div>';
    const actions = target.querySelector('#extDetailActions');
    addExtAction(actions, ext, kind, false);
  }

  function scheduleMarketplaceSearch(query) {
    const q = String(query || '').trim();
    S.extSearchTerm = q;
    clearTimeout(S.extSearchTimer);
    S.extMarket = [];
    S.extMarketLoading = q.length >= 2;
    renderExtensions();
    if (q.length < 2) return;
    S.extSearchTimer = setTimeout(async () => {
      const res = await api.extSearchOpenVsx(q);
      if (S.extSearchTerm !== q) return;
      S.extMarketLoading = false;
      if (!res.ok) { toast(res.error || 'Gagal mencari di Open VSX'); renderExtensions(); return; }
      S.extMarket = res.extensions || [];
      renderExtensions();
    }, 350);
  }

  async function loadRecommendedExtensions(force) {
    if (!force && S.extMarketLoaded && S.extSearchTerm === '') return;
    S.extMarketLoading = true;
    S.extMarket = [];
    renderExtensions();
    const res = await api.extSearchOpenVsx('snippets');
    S.extMarketLoading = false;
    if (!res.ok) { toast(res.error || 'Gagal memuat Open VSX'); renderExtensions(); return; }
    S.extMarketLoaded = true;
    S.extMarket = res.extensions || [];
    renderExtensions();
  }

  async function refreshExtensions() {
    const res = await api.extList();
    if (!res.ok) { toast(res.error || 'Gagal memuat ekstensi'); return; }
    S.extensions = res.extensions || [];
    S.extCatalog = res.catalog || [];
    renderExtensions();
    renderExtensionDetail();
    applyExtensions();
    checkExtensionUpdates();
  }

  async function checkExtensionUpdates() {
    const res = await api.extCheckUpdates();
    if (!res.ok) return;
    S.extUpdates = {};
    for (const item of res.updates || []) S.extUpdates[item.id] = item;
    renderExtensions();
    renderExtensionDetail();
  }

  function applyExtensions() {
    for (const key of Object.keys(EXT_MODES)) delete EXT_MODES[key];
    const snippetManager = (ace.require('ace/snippets') || {}).snippetManager;
    for (const ext of S.extensions) {
      if (!ext.enabled) continue;
      const langs = (ext.contributes && ext.contributes.languages) || {};
      for (const [extName, mode] of Object.entries(langs)) {
        if (mode) EXT_MODES[extName] = mode;
      }
      const stamp = ext.id + '@' + (ext.version || '1');
      if (S.extApplied.has(stamp)) continue;
      if (snippetManager && typeof snippetManager.parseSnippetFile === 'function') {
        for (const [scope, text] of Object.entries(ext.snippets || {})) {
          try {
            const parsed = snippetManager.parseSnippetFile(text);
            if (parsed && parsed.length) snippetManager.register(parsed, scope);
          } catch {}
        }
      }
      if (ext.contributes && ext.contributes.editorTheme && !localStorage.getItem('sahabat.editorTheme')) {
        const theme = String(ext.contributes.editorTheme).replace('ace/theme/', '');
        localStorage.setItem('sahabat.editorTheme', theme);
        try { S.editor && S.editor.setTheme('ace/theme/' + theme); } catch {}
      }
      S.extApplied.add(stamp);
    }
    if (S.active) S.editor && S.editor.session.setMode(modeFor(S.active.path));
  }

  async function installExtension(kind) {
    const res = kind === 'folder' ? await api.extInstallFolder() : await api.extInstallZip();
    if (res.canceled) return;
    if (!res.ok) { toast(res.error || 'Gagal install'); return; }
    await refreshExtensions();
    toast('Terpasang: ' + (res.name || res.id) + ' v' + (res.version || ''));
    switchView('extensions');
  }

  // ---------- Explorer actions ----------
  function targetFolder(node) {
    return node.dir ? node.path : parentPathOf(node.path);
  }

  async function uploadInto(folder, mode) {
    const res = await api.uploadEntry({ mode, dstTarget: currentTarget(), dstDir: folder });
    if (res.canceled) return;
    if (!res.ok) { toast(res.error || 'Gagal mengunggah'); return; }
    await refreshExplorer();
    toast((res.uploaded || []).length + ' item diunggah ke ' + folder);
  }

  async function downloadEntryFor(node) {
    const res = await api.downloadEntry({
      srcTarget: currentTarget(),
      srcPath: node.path,
      isDir: node.dir,
      name: node.name
    });
    if (res.canceled) return;
    if (!res.ok) { toast(res.error || 'Gagal mengunduh'); return; }
    toast('Diunduh: ' + (res.path || node.name));
  }

  async function openInTerminal(node) {
    if (!node.dir) { toast('Pilih folder untuk dibuka di terminal.'); return; }
    if (S.target.type === 'local') {
      switchView('workspace');
      if (S.terms.local.id) await api.stopTerminal(S.terms.local.id);
      S.terms.local.id = null;
      await startLocalTerminal(node.path);
      toast('Terminal dibuka di ' + node.path);
      return;
    }
    if (S.target.type !== 'ssh') { toast('Terminal remote hanya tersedia untuk SSH.'); return; }
    switchView('workspace');
    ensureWorkspace();
    const safe = String(node.path).replace(/'/g, `'\\''`);
    const command = `cd '${safe}'\r`;
    setTimeout(() => {
      if (S.terms.remote && S.terms.remote.sessionId) api.remoteInput(S.target.id, command);
    }, 500);
    toast('Terminal SSH dibuka di ' + node.path);
  }

  function syncMapDrivePathLabel() {
    $('mapDrivePath').textContent = $('mapRoot').checked ? '/' : (S.mapTarget || '/');
  }

  async function renderMapRequirement() {
    const box = $('mapRequirement');
    if (!box) return;
    const res = await api.mapRequirements();
    const rclone = res.ok && res.rclone;
    const winfsp = res.ok && res.winfsp;
    const missing = [];
    if (!rclone) missing.push('rclone');
    if (!winfsp) missing.push('WinFsp');
    box.classList.toggle('hidden', missing.length === 0);
    $('mapRequirementText').textContent = missing.length
      ? 'Mount butuh ' + missing.join(' dan ') + '.'
      : '';
    $('mapInstallRclone').disabled = Boolean(rclone);
    $('mapInstallRclone').textContent = rclone ? 'rclone terinstall ✓' : 'Install rclone otomatis';
    $('mapInstallWinFsp').disabled = Boolean(winfsp);
    $('mapInstallWinFsp').textContent = winfsp ? 'WinFsp terinstall ✓' : 'Install WinFsp...';
  }

  async function installMapRequirement(kind) {
    const button = $(kind === 'rclone' ? 'mapInstallRclone' : 'mapInstallWinFsp');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = kind === 'rclone' ? 'Mengunduh rclone...' : 'Mengunduh WinFsp...';
    const res = kind === 'rclone' ? await api.mapInstallRclone() : await api.mapInstallWinFsp();
    button.disabled = false;
    if (!res.ok) {
      $('mapHint').textContent = res.error || 'Gagal install';
      button.textContent = label;
      return;
    }
    $('mapHint').textContent = res.message || 'Terpasang.';
    toast(res.message || 'Terpasang');
    await renderMapRequirement();
  }

  function openMapDrive(node) {
    if (node && !node.dir) { toast('Pilih folder VPS untuk map drive.'); return; }
    if (S.target.type !== 'ssh') { toast('Map drive VPS hanya tersedia untuk koneksi SSH/SFTP.'); return; }
    const conn = S.connections.find((item) => item.id === S.target.id) || {};
    S.mapTarget = node ? node.path : '/';
    $('mapRoot').checked = true;
    syncMapDrivePathLabel();
    $('mapMethod').value = 'rclone';
    $('mapNetworkMode').checked = true;
    $('mapCacheMode').value = 'full';
    $('mapHost').value = conn.host || '';
    $('mapPort').value = conn.port || 22;
    $('mapUser').value = conn.username || '';
    $('mapPassword').value = '';
    $('mapKey').value = '';
    $('mapUnc').value = conn.host ? '\\\\' + conn.host + '\\share' + (node && node.path ? '\\' + node.path.replace(/^\/+/, '').replace(/\//g, '\\') : '') : '';
    $('mapSmbUser').value = conn.username || '';
    $('mapSmbPassword').value = '';
    $('mapHint').textContent = '';
    $('mapRcloneSection').classList.remove('hidden');
    $('mapSmbSection').classList.add('hidden');
    $('mapModal').classList.remove('hidden');
    setTimeout(() => $('mapHost').focus(), 60);
    renderMapRequirement();
  }

  function closeMapDrive() {
    $('mapModal').classList.add('hidden');
    S.mapTarget = null;
  }

  async function submitMapDrive() {
    const method = $('mapMethod').value;
    const drive = $('mapDriveLetter').value;
    const submit = $('mapSubmit');
    submit.disabled = true;
    submit.textContent = 'Membuat drive...';
    const payload = { method, drive, remotePath: $('mapRoot').checked ? '/' : (S.mapTarget || '/'), networkMode: $('mapNetworkMode').checked };

    if (method === 'rclone') {
      payload.host = $('mapHost').value.trim();
      payload.port = Number($('mapPort').value) || 22;
      payload.username = $('mapUser').value.trim();
      payload.password = $('mapPassword').value;
      payload.privateKey = $('mapKey').value.trim();
      payload.cacheMode = $('mapCacheMode').value;
    } else {
      payload.unc = $('mapUnc').value.trim();
      payload.username = $('mapSmbUser').value.trim();
      payload.password = $('mapSmbPassword').value;
      payload.persistent = $('mapPersistent').checked;
    }

    const res = await api.mapDrive(payload);
    submit.disabled = false;
    submit.textContent = 'Map drive';
    if (!res.ok) { $('mapHint').textContent = res.error || 'Gagal membuat drive'; return; }
    toast('Drive ' + drive + ': terpasang');
    closeMapDrive();
  }

  // ---------- Terminal ----------
  function ensureLocalTerminal() {
    if (S.terms.local.term) return;
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
    term.onData((d) => { if (S.terms.local.id) api.terminalInput(S.terms.local.id, d); });
    S.terms.local.term = term;
    S.terms.local.fit = fit;
  }

  function ensureRemoteTerminal() {
    if (S.terms.remote.term) return S.terms.remote.term;
    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'Consolas, ui-monospace, monospace',
      cursorBlink: true,
      theme: { background: '#0b0e13', foreground: '#e6e9ef', cursor: '#3b82f6', selectionBackground: '#264f78' }
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('termRemote'));
    try { fit.fit(); } catch {}
    term.onData((d) => { if (S.target.type === 'ssh' && S.terms.remote.sessionId) api.remoteInput(S.terms.remote.sessionId, d); });
    term.onResize(({ cols, rows }) => {
      if (S.target.type === 'ssh' && S.terms.remote.sessionId) api.remoteResize(S.terms.remote.sessionId, cols, rows);
    });
    S.terms.remote.term = term;
    S.terms.remote.fit = fit;
    return term;
  }

  async function startLocalTerminal(cwd) {
    if (S.terms.local.id) return;
    const res = await api.startTerminal({ cwd: cwd || undefined });
    if (!res.ok) { S.terms.local.term && S.terms.local.term.writeln('\r\n[gagal memulai terminal] ' + (res.error || '')); return; }
    S.terms.local.id = res.id;
    S.terms.local.cwd = res.cwd;
    S.terms.local.term && S.terms.local.term.writeln('SahabatMobile terminal — ' + (res.shell || 'shell'));
  }

  async function startRemoteTerminal(id) {
    const term = ensureRemoteTerminal();
    if (S.terms.remote.sessionId === id) return;
    S.terms.remote.sessionId = id;
    term.reset();
    term.writeln('Membuka shell SSH...');
    const res = await api.remoteShell(id, term.cols, term.rows);
    if (!res.ok) term.writeln('\r\n[gagal] ' + (res.error || ''));
  }

  function showTerminal(mode) {
    $('termLocal').classList.toggle('hidden', mode !== 'local');
    $('termRemote').classList.toggle('hidden', mode !== 'remote');
    $('termBlocked').classList.toggle('hidden', mode !== 'blocked');
    $('termLabel').textContent = mode === 'local' ? 'lokal' : mode === 'remote' ? 'SSH' : 'FTP';
    if (mode === 'local') {
      ensureLocalTerminal();
      startLocalTerminal(S.local.root);
      setTimeout(() => { try { S.terms.local.fit && S.terms.local.fit.fit(); } catch {} }, 60);
    } else if (mode === 'remote') {
      ensureRemoteTerminal();
      if (S.target.id) startRemoteTerminal(S.target.id);
      setTimeout(() => { try { S.terms.remote.fit && S.terms.remote.fit.fit(); } catch {} }, 60);
    }
  }

  function fitAll() {
    try { S.terms.local.fit && S.terms.local.fit.fit(); } catch {}
    try { S.terms.remote.fit && S.terms.remote.fit.fit(); } catch {}
  }

  // ---------- Agent ----------
  function agentLog(html, cls) {
    const empty = $('agentLog').querySelector('.agent-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'agent-item ' + (cls || '');
    el.innerHTML = html;
    $('agentLog').appendChild(el);
    $('agentLog').scrollTop = $('agentLog').scrollHeight;
    return el;
  }

  function agentTargetPayload() {
    return S.target.type === 'local' ? { type: 'local' } : { type: S.target.type, id: S.target.id };
  }

  function agentBasePath() {
    if (S.target.type === 'local') return S.local.root || '(belum dibuka)';
    const s = remoteSession();
    return s ? (s.dir || s.home) : '(tidak terhubung)';
  }

  function agentSystemPrompt() {
    const targetLabel = S.target.type === 'local' ? 'folder lokal' : (S.target.type === 'ssh' ? 'server SSH' : 'server FTP');
    return [
      'Anda adalah agen coding di dalam aplikasi SahabatMobile Desktop.',
      'Target explorer aktif: ' + targetLabel + '.',
      'Base path: ' + agentBasePath(),
      'Gunakan tools untuk membaca/menulis file dan menjalankan perintah.',
      'Path bisa absolut sesuai base path atau relatif terhadapnya.',
      S.target.type === 'ftp' ? 'FTP tidak mendukung run_command; gunakan baca/tulis file saja.' : 'Gunakan run_command hanya bila perlu; pengguna akan mengonfirmasi.',
      'Kerjakan tugas langkah demi langkah, lalu jelaskan hasil akhir secara singkat dalam Bahasa Indonesia.'
    ].join('\n');
  }

  async function execTool(name, args) {
    const target = agentTargetPayload();
    if (name === 'list_dir') return api.agentListDir(args.path || (S.target.type === 'local' ? '.' : agentBasePath()), target);
    if (name === 'read_file') return api.agentReadFile(args.path, target);
    if (name === 'write_file') return api.agentWriteFile(args.path, args.content ?? '', target);
    if (name === 'run_command') return api.agentRunCommand(args.command, args.cwd, 120000, target);
    return { ok: false, error: 'Tool tidak dikenal: ' + name };
  }

  async function sendAgent() {
    const input = $('agentInput');
    const text = input.value.trim();
    if (!text || S.agent.busy) return;
    if (!S.settings.hasKey) { openSettings(); return; }
    if (S.target.type === 'local' && !S.local.root) { toast('Buka folder kerja dulu.'); return; }
    if (S.target.type !== 'local' && !remoteSession()) { toast('Koneksi remote tidak aktif.'); return; }
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
        if (fn === 'write_file' && result && result.ok) wrote = true;
      }
      if (wrote) {
        wrote = false;
        await refreshExplorer();
      }
    }
    S.agent.busy = false;
    $('agentSend').classList.remove('hidden');
    $('agentStatus').textContent = '';
    await refreshExplorer();
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
    $('chatStatus').textContent = 'Menghubungi model...';
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
      $('chatStatus').textContent = 'Mengetik...';
    });
    const offDone = api.onDone((d) => {
      if (d.requestId !== requestId) return;
      cleanup();
      if (d.aborted) $('chatStatus').textContent = 'Dihentikan';
      else { S.chat.push({ role: 'assistant', content: full }); $('chatStatus').textContent = ''; }
    });
    const offErr = api.onError((d) => {
      if (d.requestId !== requestId) return;
      cleanup();
      bubble.parentElement.classList.add('error');
      bubble.textContent = d.message || 'Terjadi kesalahan.';
      $('chatStatus').textContent = '';
    });
    function cleanup() {
      offChunk(); offDone(); offErr();
      S.busy = false;
      S.requestId = null;
      $('sendChat').classList.remove('hidden');
      $('stopChat').classList.add('hidden');
    }
    const res = await api.startChat({ requestId, model: currentModel(), messages: S.chat.slice(-20) });
    if (!res.ok) {
      cleanup();
      bubble.parentElement.classList.add('error');
      bubble.textContent = (res.error && res.error.message) || 'Gagal mengirim.';
      $('chatStatus').textContent = '';
    }
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
    $('snippetCode').textContent = buildSnippet(S.snippet, base, model);
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

  // ---------- Settings / modals ----------
  function openSettings() {
    $('apiKeyInput').value = '';
    $('baseUrlInput').value = S.settings.baseUrl || '';
    $('editorThemeSelect').value = editorThemeName();
    $('settingsModal').classList.remove('hidden');
    setTimeout(() => $('apiKeyInput').focus(), 50);
  }

  async function saveSettings() {
    const payload = { baseUrl: $('baseUrlInput').value.trim() };
    const key = $('apiKeyInput').value.trim();
    if (key) payload.apiKey = key;
    S.settings = await api.saveSettings(payload);
    updateKeyBadge();
    const theme = $('editorThemeSelect').value || 'tomorrow_night';
    localStorage.setItem('sahabat.editorTheme', theme);
    try { S.editor && S.editor.setTheme('ace/theme/' + theme); } catch {}
    $('settingsModal').classList.add('hidden');
    if (S.settings.hasKey) loadModels();
  }

  let promptResolve = null;
  function askText(title, placeholder, okLabel, defaultValue) {
    $('promptTitle').textContent = title;
    $('promptInput').value = defaultValue || '';
    $('promptInput').placeholder = placeholder || '';
    $('promptOk').textContent = okLabel || 'Buat';
    $('promptModal').classList.remove('hidden');
    setTimeout(() => {
      $('promptInput').focus();
      if (defaultValue) $('promptInput').select();
    }, 50);
    return new Promise((resolve) => { promptResolve = resolve; });
  }

  function closePrompt(value) {
    $('promptModal').classList.add('hidden');
    if (promptResolve) { promptResolve(value || null); promptResolve = null; }
  }

  function openClone() {
    S.cloneDir = null;
    $('cloneUrl').value = '';
    $('cloneDir').textContent = 'Belum dipilih';
    $('cloneModal').classList.remove('hidden');
    setTimeout(() => $('cloneUrl').focus(), 50);
  }

  async function pickCloneDir() {
    const res = await api.pickDirectory();
    if (!res.ok) return;
    S.cloneDir = res.path;
    $('cloneDir').textContent = res.path;
  }

  async function startClone() {
    const url = $('cloneUrl').value.trim();
    if (!url) { toast('Isi URL repository.'); return; }
    if (!S.cloneDir) { toast('Pilih folder tujuan.'); return; }
    const btn = $('cloneStart');
    btn.disabled = true;
    btn.textContent = 'Meng-clone...';
    const res = await api.cloneRepo(url, S.cloneDir);
    btn.disabled = false;
    btn.textContent = 'Clone';
    if (!res.ok) { toast('Clone gagal: ' + (res.error || '').slice(0, 300)); return; }
    S.local.root = res.root;
    S.local.tree = res.tree;
    S.local.expanded.clear();
    S.target = { type: 'local', id: null };
    renderTargetSelect();
    $('cloneModal').classList.add('hidden');
    switchView('workspace');
    await ensureWorkspace();
    toast('Repository di-clone: ' + dirName(res.root));
  }

  // ---------- Bind ----------
  function bind() {
    document.querySelectorAll('.act[data-view]').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));
    $('actSettings').addEventListener('click', openSettings);
    $('openSettings').addEventListener('click', openSettings);
    $('cancelSettings').addEventListener('click', () => $('settingsModal').classList.add('hidden'));
    $('saveSettings').addEventListener('click', saveSettings);
    $('settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') $('settingsModal').classList.add('hidden'); });

    $('targetSelect').addEventListener('change', (e) => switchTarget(e.target.value));
    $('newConnection').addEventListener('click', openConnectionForm);
    $('closeConnection').addEventListener('click', closeConnectionForm);
    $('connForm').addEventListener('submit', connectRemote);
    $('connProtocol').addEventListener('change', () => {
      const proto = $('connProtocol').value;
      $('connPort').value = proto === 'sftp' ? '22' : '21';
      $('connKeyField').classList.toggle('hidden', proto !== 'sftp');
      $('connPassphraseField').classList.toggle('hidden', proto !== 'sftp');
    });
    $('disconnectRemote').addEventListener('click', disconnectRemote);
    $('openFolder').addEventListener('click', openFolder);
    $('cloneRepo').addEventListener('click', openClone);
    $('refreshExplorer').addEventListener('click', refreshExplorer);
    $('newFile').addEventListener('click', () => createEntry('file'));
    $('newFolder').addEventListener('click', () => createEntry('dir'));
    $('fileTree').addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tree-row')) return;
      e.preventDefault();
      showBlankMenu(e.clientX, e.clientY);
    });
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('scroll', hideContextMenu, true);

    $('extSearch').addEventListener('input', (e) => scheduleMarketplaceSearch(e.target.value));
    $('mapInstallRclone').addEventListener('click', () => installMapRequirement('rclone'));
    $('mapInstallWinFsp').addEventListener('click', () => installMapRequirement('winfsp'));
    $('mapCancel').addEventListener('click', closeMapDrive);
    $('mapModal').addEventListener('click', (e) => { if (e.target.id === 'mapModal') closeMapDrive(); });
    $('mapSubmit').addEventListener('click', submitMapDrive);
    $('mapMethod').addEventListener('change', () => {
      const method = $('mapMethod').value;
      $('mapRcloneSection').classList.toggle('hidden', method !== 'rclone');
      $('mapSmbSection').classList.toggle('hidden', method !== 'smb');
      $('mapHint').textContent = '';
    });
    $('mapRoot').addEventListener('change', syncMapDrivePathLabel);
    $('sshDisconnectTop').addEventListener('click', disconnectRemote);
    $('mapDriveTop').addEventListener('click', () => openMapDrive(null));
    $('savedConnections').addEventListener('click', openSavedConnections);
    $('closeConnections').addEventListener('click', closeSavedConnections);
    $('connectionsModal').addEventListener('click', (e) => {
      if (e.target.id === 'connectionsModal') closeSavedConnections();
    });
    $('extFilter').addEventListener('change', (e) => { S.extFilter = e.target.value; renderExtensions(); });
    $('extRefreshSide').addEventListener('click', async () => {
      await refreshExtensions();
      if (S.extSearchTerm === '') await loadRecommendedExtensions(true);
      toast('Daftar ekstensi diperbarui');
    });
    $('extInstallFolder').addEventListener('click', () => installExtension('folder'));
    $('extInstallZip').addEventListener('click', () => installExtension('zip'));
    $('extUpdateAll').addEventListener('click', async () => {
      const btn = $('extUpdateAll');
      btn.disabled = true;
      const previous = btn.textContent;
      btn.textContent = 'Memperbarui...';
      const res = await api.extUpdateAll();
      btn.disabled = false;
      if (!res.ok) { toast(res.error || 'Gagal update ekstensi'); btn.textContent = previous; return; }
      await refreshExtensions();
      const okCount = (res.results || []).filter((r) => r.ok).length;
      const failCount = (res.results || []).filter((r) => !r.ok).length;
      toast(failCount ? `${okCount} ekstensi diperbarui, ${failCount} gagal` : `${okCount || 0} ekstensi diperbarui`);
    });
    $('extOpenDir').addEventListener('click', async () => {
      const res = await api.extOpenDir();
      if (!res.ok) toast(res.error || 'Gagal membuka folder ekstensi');
    });
    bindResizers();

    $('clonePick').addEventListener('click', pickCloneDir);
    $('cloneCancel').addEventListener('click', () => $('cloneModal').classList.add('hidden'));
    $('cloneStart').addEventListener('click', startClone);

    $('promptOk').addEventListener('click', () => closePrompt($('promptInput').value.trim()));
    $('promptCancel').addEventListener('click', () => closePrompt(null));
    $('promptInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); closePrompt($('promptInput').value.trim()); }
      if (e.key === 'Escape') closePrompt(null);
    });

    $('sendChat').addEventListener('click', sendChat);
    $('stopChat').addEventListener('click', () => { if (S.requestId) api.abortChat(S.requestId); });
    $('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
    });
    $('modelSelect').addEventListener('change', (e) => setModel(e.target.value));
    $('refreshModels').addEventListener('click', loadModels);
    $('modelSearch').addEventListener('input', renderModelList);

    $('agentSend').addEventListener('click', sendAgent);
    $('agentInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAgent(); }
    });

    $('termToggle').addEventListener('click', () => {
      const pane = $('termPane');
      pane.classList.toggle('collapsed');
      $('termToggle').textContent = pane.classList.contains('collapsed') ? '+' : '–';
      setTimeout(fitAll, 80);
    });
    $('termClear').addEventListener('click', () => {
      if (!S.terms.local.term) return;
      S.terms.local.term.clear();
      if (S.terms.remote.term) S.terms.remote.term.clear();
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

    window.addEventListener('resize', () => {
      fitAll();
      applySideWidth(S.ui.sideWidth, false);
      applyAgentWidth(S.ui.agentWidth, false);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (S.view === 'workspace') saveActive();
      }
      if (e.key === 'Escape') {
        hideContextMenu();
        if (!$('mapModal').classList.contains('hidden')) closeMapDrive();
        if (!$('connectionsModal').classList.contains('hidden')) closeSavedConnections();
        if (!$('promptModal').classList.contains('hidden')) closePrompt(null);
        if (!$('cloneModal').classList.contains('hidden')) $('cloneModal').classList.add('hidden');
        if (!$('settingsModal').classList.contains('hidden')) $('settingsModal').classList.add('hidden');
      }
    });
  }

  async function openFolder() {
    const res = await api.openFolder();
    if (!res.ok) return;
    S.local.root = res.root;
    S.local.tree = res.tree;
    S.local.expanded.clear();
    S.target = { type: 'local', id: null };
    renderTargetSelect();
    if (S.terms.local.id) await api.stopTerminal(S.terms.local.id);
    S.terms.local.id = null;
    S.terms.local.term && S.terms.local.term.reset();
    await ensureWorkspace();
    toast('Folder dibuka: ' + dirName(res.root));
  }

  async function init() {
    aceSetup();
    bind();
    applySideWidth(S.ui.sideWidth, false);
    applyAgentWidth(S.ui.agentWidth, false);
    await refreshExtensions();
    S.settings = await api.getSettings();
    updateKeyBadge();
    renderModelOptions();
    await refreshSavedConnections();
    renderSnippet();

    api.onTermData((d) => {
      if (S.terms.local.term && d.id === S.terms.local.id) S.terms.local.term.write(d.data);
    });
    api.onTermExit((d) => {
      if (d.id === S.terms.local.id) {
        S.terms.local.id = null;
        if (S.terms.local.term) S.terms.local.term.writeln('\r\n[terminal berhenti, kode ' + d.code + ']');
      }
    });
    api.onRemoteData((d) => {
      if (S.terms.remote.term && d.id === S.terms.remote.sessionId) S.terms.remote.term.write(d.data);
    });
    api.onRemoteExit((d) => {
      if (S.terms.remote.term && d.id === S.terms.remote.sessionId) S.terms.remote.term.writeln('\r\n[shell SSH selesai]');
    });
    api.onRemoteClosed((d) => {
      S.connections = S.connections.filter((c) => c.id !== d.id);
      S.remotes.delete(d.id);
      S.tabs = S.tabs.filter((t) => t.target.id !== d.id);
      if (S.active && S.active.target.id === d.id) {
        S.active = S.tabs[S.tabs.length - 1] || null;
        setActiveSession(S.active);
        renderTabs();
      }
      if (S.target.id === d.id) {
        S.target = { type: 'local', id: null };
        renderTargetSelect();
        ensureWorkspace();
      }
      toast('Koneksi remote terputus');
    });

    if (S.settings.hasKey) loadModels();
    else setTimeout(openSettings, 400);
  }

  window.addEventListener('DOMContentLoaded', init);
})();
