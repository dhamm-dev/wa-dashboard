# Dhexbot Android dev

Android native Java tanpa library aplikasi pihak ketiga. Build menggunakan JDK,
Android SDK, aapt2, d8 dan apksigner yang sudah tersedia secara lokal; tidak
mengunduh komponen. Default toolchain berada di
`/home/dhexx/Projects/dhexbot-android-tools-20261115`.

```sh
sh android/build.sh staging
sh android/build.sh production
```

Jalankan dari root proyek. `DHEXBOT_TOOLS`, `JAVA_HOME`, `ANDROID_HOME`,
`BUILD_TOOLS`, dan `ANDROID_PLATFORM` dapat mengganti lokasi tool. Setiap build
menulis ke direktori baru di `android/build/` dan mencetak lokasi APK unsigned.
APK unsigned tidak dapat diinstal. Varian harus dipilih secara eksplisit.
Untuk APK yang dapat diinstal dan diperbarui, gunakan keystore yang sudah ada,
disimpan di luar proyek, dengan tepat satu key entry. Tidak ada kunci yang dibuat
oleh build. Masukkan kata sandi secara tersembunyi dalam shell bash interaktif:

```sh
export DHEXBOT_KEYSTORE=/lokasi/aman/keystore
read -rs -p 'Keystore password: ' DHEXBOT_STORE_PASSWORD; printf '\n'
read -rs -p 'Key password: ' DHEXBOT_KEY_PASSWORD; printf '\n'
export DHEXBOT_STORE_PASSWORD DHEXBOT_KEY_PASSWORD
sh android/build.sh staging signed
unset DHEXBOT_STORE_PASSWORD DHEXBOT_KEY_PASSWORD
```

Ganti `staging` dengan `production` hanya jika memang ingin memakai server
production. Password diteruskan lewat environment, bukan argumen proses; lokasi
keystore diteruskan sebagai argumen apksigner. Jangan aktifkan shell tracing.
Signing gagal jika keystore, password, atau key tidak valid; APK ditandatangani
diverifikasi oleh apksigner. Gunakan sertifikat dan package yang sama serta
versionCode yang lebih tinggi untuk memperbarui instalasi sebelumnya. Sertifikat
debug sementara dari build lama tidak tersedia, sehingga build baru tidak dapat
memperbaruinya. Kedua varian memakai package yang sama dan tidak dapat dipasang
berdampingan; jangan gunakan build dev untuk mengganti aplikasi produksi.
Build juga menjalankan tes Java untuk validasi input, URL otorisasi Google, dan
pengurutan ID kunci bot, penjagaan permintaan koneksi akun, serta aturan dan
konversi waktu jadwal.

Origin dikunci saat kompilasi: staging menggunakan `https://wa-staging.dhexx.my.id`
dan production menggunakan `https://wa.dhexx.my.id`. Keduanya berlabel Dev,
belum dirilis, dan production mengakses data production secara nyata. Server
harus menjalankan kode backend yang sesuai, HTTPS, secure cookies, dan konfigurasi
Google OAuth Android yang valid.

Layar menghubungkan Google OAuth lewat browser dan poll, login/daftar email,
daftar dan penambahan akun ordinary, QR serta kode pairing, dan pembuatan/daftar
jadwal teks sekali atau mingguan beserta riwayat. Gunakan nomor dengan kode negara
tanpa tanda plus untuk pairing. Jadwal menerima JID dan waktu WIB eksplisit.
Untuk akun `disconnected` tersedia tindakan hubungkan; akun `logged_out` dapat
ditautkan ulang setelah konfirmasi penghapusan sesi WhatsApp lama di server.
Setelah permintaan koneksi, tindakan yang sama ditahan sampai status berubah;
penahan ini hanya berada di memori proses. Daftar jadwal dan riwayat maksimal
500 entri per respons server, dan waktu pada daftar ditampilkan dalam WIB.
Respons POST yang terputus tidak dicoba ulang otomatis; periksa daftar sebelum
mengirim kembali. Email yang belum diverifikasi ditandai, dan pemulihan kata sandi
belum tersedia. Email disimpan sebagai teks biasa di server. Login Google dan email tidak ditautkan otomatis.

Cookie dan transaksi OAuth hanya di memori; sesi hilang saat proses aplikasi
berakhir. Backup dinonaktifkan dan screenshot diblokir. Pilihan tema disimpan
secara lokal. Setelah login, aplikasi memeriksa cookie sesi dan `/api/me` sebelum
menampilkan akun. Perubahan tema di layar masuk membuang sesi dan transaksi login
yang belum selesai. Ketika tema sistem berubah, pengguna dapat menerapkannya
dengan mengakhiri sesi lokal dan masuk lagi, atau menunda perubahan. Admin yang
terverifikasi dapat melihat akun bot, mengubah role,
dan mengelola konfigurasi serta kunci lewat endpoint bot-config. Daftar model
diminta dari server; nilai kunci tidak ditampilkan kembali dan inputnya dibersihkan
saat aplikasi berhenti. Perubahan role ke bot menjeda jadwal aktif; pengiriman
yang sudah berlangsung dapat memiliki hasil yang tidak pasti. Jadwal teks dapat
diedit, dijeda, dilanjutkan, dan dihapus dengan revision server. Jadwal berlampiran
tidak dapat diedit di aplikasi; jeda dan hapus tetap tersedia. Input pesan jadwal
dikosongkan ketika aplikasi berhenti. Tidak ada UI pengiriman lampiran,
pengelola kontak. Fitur ini belum diuji pada perangkat
atau dengan akun staging dalam sesi pengembangan ini; keberhasilan build bukan
bukti integrasi backend atau aksesibilitas perangkat.

Desain: ENERGY 2 / RHYTHM 1 / MOTION 1. Oranye memberi identitas Dhexbot pada
ikon dan aksen; satu kolom menjaga formulir tetap terbaca pada layar sempit;
tipografi sistem mempertahankan skala teks dan perilaku kontrol native.
