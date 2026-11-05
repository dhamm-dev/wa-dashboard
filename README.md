# WA Dashboard

Dashboard pribadi untuk satu admin dengan beberapa akun WhatsApp. Setiap akun mempunyai sesi, kontak, status, dan grupnya sendiri. Pesan dapat dikirim langsung atau dijadwalkan sekali maupun mingguan dalam WIB.

## Menjalankan dengan Node.js

Gunakan Node.js 24 atau lebih baru. Jalankan `npm ci`, lalu atur `ADMIN_PASSWORD` (wajib diisi, tanpa batas panjang khusus) dan `SESSION_SECRET` (minimal 32 karakter acak) sebagai variabel lingkungan. Kata sandi pendek kurang aman, meskipun dashboard digunakan secara lokal. Jalankan `npm start`, kemudian buka `http://127.0.0.1:3000`. Buat secret misalnya dengan `openssl rand -hex 32`. Jangan menyimpan kredensial di repositori.

Data disimpan di direktori `data/` secara default. `DATA_DIR`, `HOST`, dan `PORT` dapat diatur melalui lingkungan. Backup direktori data secara aman saat aplikasi berhenti; direktori ini berisi database, lampiran, serta kredensial sesi WhatsApp.

## Docker Compose di Ubuntu

Salin `.env.example` menjadi `.env`, isi `ADMIN_PASSWORD` dan `SESSION_SECRET`, lalu jalankan `docker compose up -d --build`. Buka `http://127.0.0.1:3000`. Data tersimpan dalam volume `dashboard-data`. Compose hanya membuka port di loopback; untuk akses jarak jauh gunakan satu reverse proxy HTTPS tepercaya, set `COOKIE_SECURE=true` dan `TRUST_PROXY=1`, serta pastikan port aplikasi tidak dapat diakses langsung oleh klien yang tidak tepercaya. Lindungi akses ke mesin dan volume. Konfigurasi Compose belum diuji pada lingkungan pembuatan ini.

## Penggunaan

Tambahkan akun, perbarui data sampai QR muncul, lalu pindai dengan WhatsApp pada perangkat terkait. Jika WhatsApp mengeluarkan sesi, tombol Tautkan ulang menghapus kredensial sesi lama akun tersebut dan meminta QR baru. Pilih akun untuk menyimpan kontak atau memuat grup yang diikuti akun itu. Isi pesan atau unggah lampiran maksimal 10 MB. Jenis yang diterima: JPG, JPEG, PNG, GIF, WebP, PDF, TXT dan CSV UTF-8, DOCX, XLSX, PPTX, ZIP, MP3, dan MP4. Pilih kirim sekarang, sekali, atau mingguan. Waktu pada formulir selalu WIB, terlepas zona waktu server.

Pencarian tujuan menggabungkan kontak yang disimpan di dashboard dengan kontak yang diterima dari event Baileys selama proses server berjalan. Nama kontak lokal diutamakan jika nomor sama. Kontak WhatsApp hanya ditampilkan saat akun terhubung dan perlu pembaruan data setelah event diterima; memori kontak hilang saat server dimulai ulang atau sesi ditautkan ulang. Event yang diterima bergantung pada WhatsApp dan tidak menjamin seluruh buku telepon. Kontak yang hanya memiliki ID LID tanpa nomor telepon yang dapat digunakan belum ditampilkan. Penghapusan pada halaman kontak hanya menghapus kontak lokal, bukan kontak WhatsApp.

Foto profil belum ditampilkan. [Dokumentasi Baileys](https://github.com/WhiskeySockets/Baileys#fetch-profile-picture-groups-too) menjelaskan `profilePictureUrl`, tetapi tidak menetapkan daftar host CDN yang dapat digunakan sebagai batas keamanan. Proxy membutuhkan validasi host, DNS dan redirect pada setiap koneksi serta pembatasan ukuran dan waktu; pemuatan langsung di browser juga mengungkap alamat IP browser ke host foto dan memerlukan pembatasan CSP. Sampai sumber host yang tepercaya tersedia, dashboard memakai inisial atau huruf G sebagai fallback.

Jadwal yang jatuh tempo saat server mati atau akun terputus dicatat sebagai terlewat dan tidak dikirim ulang. Scheduler memeriksa setiap detik dan juga melewatkan kejadian yang terlambat lebih dari 15 detik, termasuk ketika proses terhambat. Pengiriman terjadwal diproses berurutan, sehingga satu pengiriman yang lambat dapat menyebabkan jadwal lain terlewat. Kegagalan pengiriman tidak dicoba ulang otomatis. Jadwal mingguan tetap berlanjut. Riwayat berhasil berarti panggilan pengiriman diterima oleh koneksi Baileys, bukan bukti pesan dibaca atau diterima perangkat tujuan. Jika proses berhenti saat pengiriman berlangsung, hasilnya bisa tidak pasti dan dicatat gagal tanpa retry. Jalankan hanya satu instance agar scheduler tidak memproses jadwal secara bersamaan.

Daftar jadwal dapat dicari berdasarkan akun, tujuan, tanggal WIB, dan status aktif, nonaktif, atau selesai. Filter tanggal memakai waktu berikutnya, atau waktu terakhir untuk jadwal yang selesai. Jadwal dapat diubah, dinonaktifkan, diaktifkan kembali, atau dihapus; penghapusan tidak menghapus riwayat. Perubahan tidak membatalkan pengiriman yang sudah dimulai. Saat jadwal nonaktif tidak ada pengiriman atau riwayat terlewat; saat diaktifkan kembali, jadwal mingguan melanjutkan pada kejadian berikutnya yang lebih dari 15 detik di masa depan. Jadwal sekali yang waktunya lewat harus diubah ke waktu baru. Data lama dengan waktu kosong menjadi nonaktif karena versi lama tidak membedakan jadwal selesai dan dibatalkan; ubah waktunya sebelum mengaktifkan. Data lama tersebut tidak muncul pada filter tanggal sampai waktu baru disimpan.

## Batasan dan keamanan

Baileys menggunakan protokol WhatsApp tidak resmi. Perubahan protokol dapat merusak koneksi, dan penggunaannya dapat melanggar ketentuan WhatsApp atau menyebabkan pembatasan akun. Tidak ada jaminan stabilitas koneksi.

Ini aplikasi satu admin, bukan sistem multi-tenant yang aman. Pemisahan akun membatasi sesi, kontak, lampiran, dan grup berdasarkan akun, tetapi semua data dapat diakses admin yang sama. Sesi login disimpan di memori dan hilang saat server dimulai ulang; pembatasan percobaan login juga hanya berlaku per proses. Gunakan HTTPS untuk akses di luar host, kata sandi unik, dan batasi akses jaringan. Nama lampiran disanitasi; file disimpan dengan ID acak di direktori privat, tidak dieksekusi atau disajikan melalui HTTP. Ekstensi dibatasi dan signature dasar diperiksa tanpa mempercayai MIME dari browser. Pemeriksaan ini bukan validasi menyeluruh atau pemindaian malware: ZIP dan dokumen Office dapat berisi konten berbahaya. Admin bertanggung jawab memeriksa file dan penerimanya. File tersimpan dan volume harus dilindungi serta dikelola oleh operator.

## Pengujian

Jalankan `npm test`. Pengujian WhatsApp sesungguhnya membutuhkan akun dan pemindaian QR. Docker Compose dan seluruh kombinasi browser atau perangkat tidak tercakup oleh pengujian otomatis yang tersedia.
