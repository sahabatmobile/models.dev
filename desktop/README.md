# SahabatMobile Desktop

Aplikasi desktop (Electron) untuk memakai AI Gateway SahabatMobile tanpa ribet.

Tahap saat ini: **mode Developer** (integrasi Trae + API + chat). Mode UMKM dan 3D Creator disiapkan sebagai tahap berikutnya.

## Fitur

- Onboarding wajib API key (PAYG `sk-sm-...` atau key paket dari Plan Details)
- API key disimpan terenkripsi lewat OS keychain (`safeStorage`), tidak pernah dikirim ke tampilan
- Chat streaming (kata-per-kata) ke `https://www.sahabatmobile.com/api/v1`
- Daftar model otomatis dari endpoint `/models`, lengkap dengan pencarian dan salin ID
- Panel **Integrasi Trae**: nilai siap-salin untuk `Settings > Models > Add Model > Custom Model`
- Panel **API & Snippet**: contoh cURL, Python, Node.js, dan config OpenCode
- Tes koneksi dan penanganan error 401 / 402 / 403 / 429 / 5xx

## Menjalankan

```bash
npm install
npm start
```

Lalu isi API key di **Pengaturan**, pilih model, dan mulai chat.

## Build installer

```bash
npm run dist
```

Hasil build ada di folder `dist/` (Windows `.exe`, macOS `.dmg`, Linux `.AppImage`/`.deb`).

## Integrasi Trae (trae.ai)

Di Trae: `Settings > Models > Add Model > Custom Model`, lalu isi:

- API Format: `OpenAI Chat Completions`
- Full URL: `Off`
- Custom Request URL: `https://www.sahabatmobile.com/api/v1`
- Model ID: mis. `MiniMax-M3`
- API Key: key SahabatMobile

Untuk fitur agent / tool calling, gunakan `MiniMax-M3`.

## Struktur

- `main.js` — proses utama Electron, request API, penyimpanan key
- `preload.js` — jembatan IPC yang aman
- `index.html`, `styles.css`, `renderer.js` — antarmuka
