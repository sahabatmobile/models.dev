# SahabatMobile Desktop

Aplikasi desktop (Electron) untuk AI Gateway SahabatMobile, dengan tampilan seperti editor kode modern (activity bar + explorer, tab editor, agent chat di kanan).

Tahap saat ini: **mode Developer**. Mode UMKM dan 3D Creator disiapkan sebagai tahap berikutnya.

## Fitur

- Onboarding wajib API key (PAYG `sk-sm-...` atau key paket dari Plan Details)
- API key disimpan terenkripsi lewat OS keychain (`safeStorage`)
- Chat streaming ke `https://www.sahabatmobile.com/api/v1`
- Daftar model otomatis dari `/models` (cari, pakai, salin ID)
- Panel API & snippet: cURL, Python, Node.js, config OpenCode

## Workspace Developer

- **Activity bar + Explorer** ala VS Code: Open Folder, Clone Repo, file/folder baru, hapus, dan target explorer
- **Editor kode** (Ace) dengan tab, pewarnaan sintaks, dan simpan `Ctrl+S`
- **Terminal** lokal (PowerShell) dan terminal SSH
- **Agent AI** yang bekerja pada explorer **aktif**:
  - Bisa membaca, menulis, dan membuat file
  - Bisa menjalankan perintah (dengan konfirmasi)
  - Mendukung folder **lokal**, **SSH/SFTP**, dan **FTP/FTPS**
- **Remote**: SSH/SFTP untuk terminal + file, FTP/FTPS untuk file. Kredensial tidak disimpan.

Untuk agent / tool calling, gunakan **MiniMax-M3**.

## Menjalankan

```bash
npm install
npm start
```

Lalu isi API key di **Pengaturan**, pilih target di Explorer, dan mulai.

## Build installer

```bash
npm run dist
```

Hasil build ada di folder `dist/` (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`/`.deb`). Versi portable:

```bash
npx electron-builder --win portable
```

## Struktur

- `main.js` — proses utama: API, filesystem, terminal, SSH/SFTP, FTP
- `preload.js` — jembatan IPC
- `renderer.js` — chat, explorer, editor, agent, koneksi remote
- `index.html`, `styles.css` — tampilan
- `vendor/` — Ace editor dan xterm.js (offline)
- `build/icon.png` — ikon aplikasi
