# SahabatMobile Desktop

Aplikasi desktop (Electron) untuk memakai AI Gateway SahabatMobile tanpa ribet, lengkap dengan workspace developer.

Tahap saat ini: **mode Developer**. Mode UMKM dan 3D Creator disiapkan sebagai tahap berikutnya.

## Fitur

- Onboarding wajib API key (PAYG `sk-sm-...` atau key paket dari Plan Details)
- API key disimpan terenkripsi lewat OS keychain (`safeStorage`), tidak pernah dikirim ke tampilan
- Chat streaming ke `https://www.sahabatmobile.com/api/v1`
- Daftar model otomatis dari `/models` (cari, pakai, salin ID)
- Panel API & snippet: cURL, Python, Node.js, config OpenCode
- Tes koneksi dan penanganan error 401 / 402 / 403 / 429 / 5xx

## Workspace Developer

- **Explorer + editor kode** (Ace) dengan tab, pewarnaan sintaks, dan simpan `Ctrl+S`
- **Terminal lokal** (PowerShell di Windows) di panel bawah
- **Agent AI** yang bisa membaca/menulis file dan menjalankan perintah — setiap perintah dikonfirmasi dulu, dan hanya di dalam folder kerja
- **Remote SSH**: hubungkan VPS (password atau private key), terminal PTY asli, jelajah file remote via SFTP, edit dan simpan langsung

Semua fitur AI memakai model SahabatMobile yang dipilih. Untuk agent / tool calling, gunakan **MiniMax-M3**.

## Menjalankan

```bash
npm install
npm start
```

Lalu isi API key di **Pengaturan**, buka folder kerja di tab **Workspace**, dan mulai.

## Build installer

```bash
npm run dist
```

Hasil build ada di folder `dist/` (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`/`.deb`). Versi portable:

```bash
npx electron-builder --win portable
```

## Struktur

- `main.js` — proses utama Electron: API, filesystem, terminal, SSH
- `preload.js` — jembatan IPC yang aman
- `renderer.js` — antarmuka chat, workspace, agent, remote
- `index.html`, `styles.css` — tampilan
- `vendor/` — Ace editor dan xterm.js (offline, tanpa CDN)
- `build/icon.png` — ikon aplikasi
