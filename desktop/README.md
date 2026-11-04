# SahabatMobile Desktop

Aplikasi desktop (Electron) untuk memakai AI Gateway SahabatMobile tanpa ribet.

## Fitur

- Chat dengan streaming (kata-per-kata) ke `https://www.sahabatmobile.com/api/v1`
- Daftar model otomatis dari endpoint `/models`
- API key disimpan terenkripsi lewat OS keychain (`safeStorage`), tidak pernah dikirim ke tampilan
- Penanganan error 401 / 402 / 403 / 429 / 5xx dengan pesan yang jelas
- Tema gelap, riwayat percakapan di sesi berjalan

## Menjalankan

```bash
npm install
npm start
```

Lalu buka **Pengaturan**, isi API key (`sk-sm-...` untuk PAYG atau key paket dari Plan Details), simpan, dan pilih model.

## Build installer

```bash
npm run dist
```

Hasil build ada di folder `dist/` (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`/`.deb`).

## Struktur

- `main.js` — proses utama Electron, request API, penyimpanan key
- `preload.js` — jembatan IPC yang aman
- `index.html`, `styles.css`, `renderer.js` — antarmuka
