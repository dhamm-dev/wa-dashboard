package id.my.dhexx.dhexbot;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.method.TransformationMethod;
import android.graphics.Rect;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Handler timers = new Handler(Looper.getMainLooper());
    private final CookieManager cookies = new CookieManager(null, CookiePolicy.ACCEPT_ORIGINAL_SERVER);
    private LinearLayout body;
    private TextView notice;
    private int screen = 0;
    private volatile int generation = 0;
    private boolean alive = true, pending = false, mutation = false, verifying = false, emailUnverified = false, authenticated = false;
    private volatile boolean foreground = false;
    private volatile JSONObject sensitivePayload;
    private volatile int sessionEpoch = 0;
    private EditText passwordField, keyField, scheduleTextField;
    private String googleId, googleSecret;
    private long googleExpiry;
    private String accountId, accountName, accountRole, userRole;
    private TextView accountStatus;
    private ImageView qrImage;
    private LinearLayout accountActions;
    private String currentAccountStatus;
    private int accountStatusSerial = 0, systemNight;
    private boolean themeRefreshPending, themePromptVisible;
    private final AccountActionGuard accountActionGuard = new AccountActionGuard();
    private boolean schedulePreflight;
    private boolean publicSignup;
    private static final String CONFLICT = "Permintaan belum dapat diproses. Periksa status dan coba lagi nanti.";

    interface Result { void done(Object value, String error); }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        systemNight = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        applyTheme(); login();
    }
    @Override protected void onResume() { super.onResume(); foreground = true; maybePromptSystemTheme(); if (googleId != null && !themePromptVisible) pollGoogle(); else if (accountId != null && screen == 2) refreshAccount(); }
    @Override protected void onStop() { foreground = false; clearSecrets(); accountStatusSerial++; currentAccountStatus = null; if (screen == 2 && accountActions != null) accountActions.removeAllViews(); timers.removeCallbacksAndMessages(null); super.onStop(); }
    @Override protected void onDestroy() { alive = false; timers.removeCallbacksAndMessages(null); handler.removeCallbacksAndMessages(null); worker.shutdownNow(); super.onDestroy(); }
    @Override public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        int next = c.uiMode & Configuration.UI_MODE_NIGHT_MASK;
        if (next != systemNight && "system".equals(getPreferences(0).getString("theme", "system"))) themeRefreshPending = true;
        systemNight = next;
        maybePromptSystemTheme();
    }

    private void maybePromptSystemTheme() {
        if (!foreground || !themeRefreshPending || themePromptVisible || mutation || pending || verifying || !alive) return;
        themePromptVisible = true;
        new AlertDialog.Builder(this).setTitle("Tema sistem berubah")
                .setMessage("Untuk menerapkan tema, sesi lokal akan diakhiri, login Google yang belum selesai dibatalkan, dan perubahan formulir yang belum disimpan dibuang. Anda perlu masuk lagi.")
                .setNegativeButton("Nanti", (d,w) -> { themeRefreshPending = false; })
                .setPositiveButton("Terapkan dan masuk lagi", (d,w) -> {
                    if (mutation || pending || verifying) { message("Tunggu hingga permintaan selesai."); return; }
                    themeRefreshPending = false; endSession(); applyTheme(); login(); message("Tema diterapkan. Silakan masuk lagi.");
                })
                .setOnDismissListener(d -> { themePromptVisible = false; if (googleId != null && foreground) pollGoogle(); })
                .show();
    }

    private void applyTheme() {
        String mode = getPreferences(0).getString("theme", "system");
        Configuration config = new Configuration(getResources().getConfiguration());
        if (mode.equals("system")) config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | (android.content.res.Resources.getSystem().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK);
        if (!mode.equals("system")) config.uiMode = (config.uiMode & ~Configuration.UI_MODE_NIGHT_MASK) | (mode.equals("dark") ? Configuration.UI_MODE_NIGHT_YES : Configuration.UI_MODE_NIGHT_NO);
        getResources().updateConfiguration(config, getResources().getDisplayMetrics());
        getTheme().applyStyle(R.style.AppTheme, true);
    }
    private int dp(int n) { return (int)(n * getResources().getDisplayMetrics().density + .5f); }
    private void clearSecrets() { if (passwordField != null) passwordField.setText(""); if (keyField != null) keyField.setText(""); if (scheduleTextField != null) scheduleTextField.setText(""); JSONObject payload = sensitivePayload; if (payload != null) synchronized (payload) { payload.remove("key"); } }
    private void page(String title, int next) {
        clearSecrets(); passwordField = null; keyField = null; scheduleTextField = null;
        screen = next; generation++; schedulePreflight = false; timers.removeCallbacksAndMessages(null);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true);
        body = new LinearLayout(this); body.setOrientation(LinearLayout.VERTICAL); body.setPadding(dp(24), dp(24), dp(24), dp(32));
        scroll.addView(body); setContentView(scroll);
        TextView brand = text(BuildConfig.LABEL, 15); brand.setTextColor(isDark() ? 0xffffb77f : 0xff993800);
        TextView heading = text(title, 28); heading.setTypeface(null, 1); heading.setPadding(0, dp(12), 0, dp(10)); if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        notice = text("", 16); notice.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
    }
    private boolean isDark() { return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES; }
    private TextView text(String s, int size) { TextView v = new TextView(this); v.setText(s); v.setTextSize(size); v.setPadding(0, dp(6), 0, dp(6)); body.addView(v); return v; }
    private Button button(String label, Runnable action) { Button b = new Button(this); b.setText(label); b.setAllCaps(false); b.setMinHeight(dp(48)); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.topMargin = dp(8); body.addView(b, p); b.setOnClickListener(v -> { if (mutation) message("Tunggu hingga permintaan selesai."); else action.run(); }); return b; }
    private EditText field(String label, int type) { text(label, 16); EditText e = new EditText(this); e.setSingleLine(true); e.setInputType(type); e.setContentDescription(label); body.addView(e, new LinearLayout.LayoutParams(-1, -2)); return e; }
    private void message(String value) { if (notice != null) notice.setText(value); }
    private void theme() {
        if (mutation || pending || verifying) { message("Tunggu hingga permintaan selesai sebelum mengganti tema."); return; }
        new AlertDialog.Builder(this).setTitle("Tema").setSingleChoiceItems(new String[]{"Ikuti sistem", "Terang", "Gelap"}, -1, (d, n) -> {
            String choice = new String[]{"system", "light", "dark"}[n]; d.dismiss();
            if (screen == 0 && googleId != null) new AlertDialog.Builder(this).setTitle("Batalkan login Google?").setMessage("Mengganti tema akan membatalkan login Google yang belum selesai. Anda perlu memulainya lagi.").setNegativeButton("Batal", null).setPositiveButton("Ganti tema", (dialog, which) -> applyChosenTheme(choice)).show();
            else applyChosenTheme(choice);
        }).setNegativeButton("Batal", null).show();
    }
    private void applyChosenTheme(String choice) {
        if (mutation || pending || verifying) { message("Tunggu hingga permintaan selesai sebelum mengganti tema."); return; }
        getPreferences(0).edit().putString("theme", choice).apply(); themeRefreshPending = false;
        applyTheme(); if (screen == 1 && authenticated) accounts(); else { endSession(); login(); message("Tema diterapkan. Silakan masuk."); }
    }

    private void endSession() {
        synchronized (cookies) { sessionEpoch++; cookies.getCookieStore().removeAll(); }
        authenticated = false; emailUnverified = false; googleId = null; googleSecret = null; pending = false; verifying = false;
        accountId = null; accountName = null; accountRole = null; userRole = null; currentAccountStatus = null; accountStatusSerial++; clearSecrets(); timers.removeCallbacksAndMessages(null);
    }
    private boolean hasSessionCookie() {
        try {
            synchronized (cookies) {
                URI uri = new URI(BuildConfig.ORIGIN + "/api/me");
                boolean sent = false;
                for (Map.Entry<String, List<String>> h : cookies.get(uri, Collections.emptyMap()).entrySet()) {
                    if (!"Cookie".equalsIgnoreCase(h.getKey())) continue;
                    for (String value : h.getValue()) for (String part : value.split(";")) if (part.trim().startsWith("connect.sid=")) sent = true;
                }
                if (!sent) return false;
                for (HttpCookie c : cookies.getCookieStore().get(uri)) {
                    if ("connect.sid".equals(c.getName()) && c.getSecure() && c.isHttpOnly() && !c.hasExpired()
                            && c.getValue() != null && !c.getValue().isEmpty()
                            && (c.getPath() == null || "/".equals(c.getPath()) || "/api".equals(c.getPath()))) return true;
                }
            }
        } catch (Exception ignored) { }
        return false;
    }
    private void verifySession(boolean unverified, String expectedRole) {
        if (!hasSessionCookie()) { endSession(); login(); message("Sesi tidak tersedia. Silakan masuk lagi."); return; }
        verifying = true;
        message("Memeriksa sesi...");
        request("GET", "/api/me", null, (result, error) -> {
            verifying = false;
            JSONObject me = result instanceof JSONObject ? (JSONObject) result : new JSONObject();
            String role = me.optString("role");
            if (error != null || !Boolean.TRUE.equals(me.opt("ok")) || !("customer".equals(role) || "admin".equals(role)) || (expectedRole != null && !expectedRole.equals(role)) || !hasSessionCookie()) {
                endSession(); login(); message(error != null ? error : "Sesi tidak dapat diverifikasi. Silakan masuk lagi."); return;
            }
            authenticated = true; userRole = role; emailUnverified = unverified; accounts();
        });
    }

    private void request(String method, String path, JSONObject data, Result done) {
        int current = generation, epoch = sessionEpoch;
        boolean modifying = !method.equals("GET") && !path.equals("/api/google/android/poll");
        if (modifying && mutation) { message("Permintaan sebelumnya masih berlangsung."); return; }
        if (modifying) mutation = true;
        final boolean secretRequest = data != null && data.has("key");
        if (secretRequest) sensitivePayload = data;
        worker.execute(() -> {
            Object value = null; String error = null; boolean started = false, unauthorized = false;
            try {
                if (epoch != sessionEpoch || (modifying && current != generation) || (secretRequest && !foreground)) throw new IOException();
                URL url = new URL(BuildConfig.ORIGIN + path);
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setInstanceFollowRedirects(false); c.setConnectTimeout(12000); c.setReadTimeout(15000); c.setUseCaches(false); c.setRequestMethod(method);
                c.setRequestProperty("Accept", "application/json"); c.setRequestProperty("X-Dashboard-Request", "1");
                Map<String, List<String>> headers;
                synchronized (cookies) { headers = epoch == sessionEpoch ? cookies.get(url.toURI(), Collections.emptyMap()) : Collections.emptyMap(); }
                for (Map.Entry<String, List<String>> h : headers.entrySet()) if (h.getKey() != null) for (String v : h.getValue()) c.addRequestProperty(h.getKey(), v);
                if (data != null) { c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json"); byte[] bytes; synchronized (data) { if (secretRequest && !data.has("key")) throw new IOException(); bytes = data.toString().getBytes(StandardCharsets.UTF_8); data.remove("password"); data.remove("key"); } if (secretRequest) sensitivePayload = null; c.setFixedLengthStreamingMode(bytes.length); started = true; try (OutputStream out = c.getOutputStream()) { out.write(bytes); } finally { Arrays.fill(bytes, (byte)0); } }
                int status = c.getResponseCode();
                unauthorized = status == 401 || (status == 403 && (path.contains("/bot-config") || path.endsWith("/role")));
                synchronized (cookies) {
                    if (epoch == sessionEpoch && !unauthorized) {
                        cookies.put(url.toURI(), c.getHeaderFields());
                        for (HttpCookie cookie : new ArrayList<>(cookies.getCookieStore().getCookies())) if (!cookie.getSecure()) cookies.getCookieStore().remove(url.toURI(), cookie);
                    }
                }
                InputStream stream = status < 400 ? c.getInputStream() : c.getErrorStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                if (stream != null) { try (InputStream in = stream) { byte[] b = new byte[4096]; int n; while ((n = in.read(b)) != -1) { if (out.size() + n > 1048576) throw new IOException(); out.write(b, 0, n); } } }
                String raw = new String(out.toByteArray(), StandardCharsets.UTF_8);
                if (status >= 200 && status < 300) value = new JSONTokener(raw).nextValue();
                else if (status >= 500 && modifying && !path.endsWith("/models")) error = "Server gagal memproses respons. Hasil perubahan belum pasti; periksa sebelum mengirim lagi (" + status + ").";
                else if (status == 404 || status == 503) error = "Layanan tidak tersedia (" + status + ").";
                else if (status == 429) error = "Terlalu banyak permintaan. Coba lagi nanti.";
                else if (status == 409) error = CONFLICT;
                else error = "Permintaan ditolak oleh server (" + status + ").";
                c.disconnect();
            } catch (Exception e) { error = started ? "Koneksi terputus. Hasil permintaan belum pasti; periksa sebelum mengirim lagi." : "Tidak dapat menghubungi server. Periksa koneksi dan coba lagi."; }
            if (data != null) synchronized (data) { data.remove("password"); data.remove("key"); }
            if (secretRequest) sensitivePayload = null;
            final Object result = value; final String failure = error; final boolean expired = unauthorized;
            handler.post(() -> { if (modifying) mutation = false; if (path.startsWith("/api/accounts/") && (path.endsWith("/connect") || path.endsWith("/repair"))) accountActionGuard.finish(path.substring("/api/accounts/".length(), path.lastIndexOf('/'))); if (!alive || epoch != sessionEpoch) return; if (expired) { endSession(); login(); message("Sesi berakhir atau autentikasi gagal. Silakan masuk lagi."); } else if (generation == current) done.done(result, failure); maybePromptSystemTheme(); });
        });
    }
    private JSONObject json(String... pairs) { JSONObject j = new JSONObject(); try { for (int i = 0; i < pairs.length; i += 2) j.put(pairs[i], pairs[i+1]); } catch (JSONException e) { throw new IllegalArgumentException(e); } return j; }

    private void login() {
        googleId = null; googleSecret = null; accountId = null; page("Masuk", 0);
        publicSignup = false;
        text("Masuk dengan Google atau email dan kata sandi.", 16);
        button("Masuk dengan Google", this::startGoogle);
        EditText email = field("Email", 33);
        EditText password = field("Kata sandi (minimal 12 karakter)", 129);
        passwordField = password; password.setSaveEnabled(false); if (android.os.Build.VERSION.SDK_INT >= 26) password.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        button("Masuk dengan email", () -> emailAuth(email, password, false));
        Button register = button("Daftar dengan email", () -> emailAuth(email, password, true));
        register.setVisibility(View.GONE); register.setEnabled(false);
        TextView signupStatus = text("Pendaftaran publik belum tersedia.", 16);
        signupStatus.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        request("GET", "/api/auth/options", null, (result, error) -> {
            Object option = result instanceof JSONObject ? ((JSONObject) result).opt("publicSignup") : null;
            publicSignup = SignupOptions.enabled(error == null, option);
            if (publicSignup) { register.setVisibility(View.VISIBLE); register.setEnabled(true); signupStatus.setVisibility(View.GONE); }
        });
        text("Email yang didaftarkan belum diverifikasi dan disimpan sebagai teks biasa di server. Pemulihan kata sandi belum tersedia.", 14);
        button("Tema", this::theme);
    }
    private void emailAuth(EditText email, EditText password, boolean register) {
        if (register && !publicSignup) { message("Pendaftaran publik belum tersedia."); return; }
        if (mutation || pending || verifying) { message("Tunggu hingga permintaan selesai."); return; }
        if (googleId != null) endSession();
        String address = email.getText().toString().trim(), pass = password.getText().toString();
        password.setText("");
        if (address.isEmpty() || pass.codePointCount(0, pass.length()) < 12) { message("Isi email dan kata sandi minimal 12 karakter."); return; }
        message(register ? "Mendaftarkan akun..." : "Sedang masuk...");
        JSONObject data = json("email", address, "password", pass);
        request("POST", "/api/email/" + (register ? "register" : "login"), data, (result, error) -> {
            if (error != null) { message(error); return; }
            JSONObject o = result instanceof JSONObject ? (JSONObject)result : new JSONObject();
            if (!Boolean.TRUE.equals(o.opt("ok")) || !"customer".equals(o.optString("role"))) { endSession(); message("Respons login tidak dikenali."); return; }
            verifySession(!o.optBoolean("emailVerified", false), "customer");
        });
    }
    private void startGoogle() {
        if (mutation || pending || verifying) { message("Tunggu hingga permintaan selesai."); return; }
        if (googleId != null) endSession();
        byte[] secret = new byte[32]; new SecureRandom().nextBytes(secret);
        googleSecret = Base64.encodeToString(secret, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        message("Menyiapkan login Google...");
        request("POST", "/api/google/android/start", json("secret", googleSecret, "purpose", "login"), (result, error) -> {
            if (error != null || !(result instanceof JSONObject)) { googleSecret = null; message(error != null ? error : "Respons login tidak dikenali."); return; }
            JSONObject o = (JSONObject)result; String id = o.optString("id"), link = o.optString("authorizationUrl");
            if (!id.matches("[A-Za-z0-9_-]{43}") || !GoogleAuthorization.valid(link, BuildConfig.ORIGIN)) { endSession(); message("Respons login tidak dikenali."); return; }
            Uri uri = Uri.parse(link);
            googleId = id; googleExpiry = android.os.SystemClock.elapsedRealtime() + Math.min(300, Math.max(1, o.optInt("expiresIn", 300))) * 1000L;
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); message("Selesaikan login di browser, lalu kembali ke aplikasi."); }
            catch (Exception e) { googleId = null; googleSecret = null; message("Browser tidak tersedia."); }
        });
    }
    private void pollGoogle() {
        if (!foreground || googleId == null || pending || themePromptVisible) return;
        if (android.os.SystemClock.elapsedRealtime() >= googleExpiry) { googleId = null; googleSecret = null; message("Login kedaluwarsa. Mulai lagi."); return; }
        pending = true;
        request("POST", "/api/google/android/poll", json("id", googleId, "secret", googleSecret), (result, error) -> {
            pending = false;
            if (error != null || !(result instanceof JSONObject)) { googleId = null; googleSecret = null; message(error != null ? error : "Respons login tidak dikenali."); return; }
            String status = ((JSONObject)result).optString("status");
            if ("complete".equals(status)) { googleId = null; googleSecret = null; verifySession(false, null); }
            else if ("pending".equals(status)) { message("Menunggu login Google di browser..."); if (foreground) timers.postDelayed(this::pollGoogle, 2000); }
            else { googleId = null; googleSecret = null; message("Login gagal. Mulai lagi."); }
        });
    }
    private void accounts() {
        if (!authenticated) { endSession(); login(); message("Silakan masuk terlebih dahulu."); return; }
        accountId = null; page("Akun WhatsApp", 1);
        if (emailUnverified) text("Email akun ini belum diverifikasi. Pemulihan kata sandi belum tersedia.", 15);
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); body.addView(list);
        message("Memuat akun...");
        request("GET", "/api/accounts", null, (result, error) -> {
            if (error != null || !(result instanceof JSONArray)) { message(error != null ? error : "Respons akun tidak dikenali."); return; }
            JSONArray a = (JSONArray)result; message(a.length() == 0 ? "Belum ada akun WhatsApp. Tambahkan akun untuk menautkan nomor." : "Pilih akun untuk melihat status dan kode pairing.");
            for (int i = 0; i < a.length(); i++) { JSONObject o = a.optJSONObject(i); if (o == null) continue; String role = o.optString("role"); if (!"ordinary".equals(role) && !("admin".equals(userRole) && "bot".equals(role))) continue; String id = o.optString("id"), name = o.optString("name"); if (!id.matches("[0-9a-fA-F-]{36}")) continue; Button b = new Button(this); b.setAllCaps(false); b.setText(name + " · " + (role.equals("bot") ? "Bot" : "Biasa") + " · " + o.optString("status")); b.setMinHeight(dp(48)); list.addView(b); b.setOnClickListener(v -> { accountRole = role; account(id, name); }); }
        });
        EditText name = field("Nama akun baru", 1);
        button("Tambahkan akun", () -> { String n = name.getText().toString().trim(); if (n.isEmpty() || n.length() > 80) { message("Isi nama akun, maksimal 80 karakter."); return; } message("Menambahkan akun..."); request("POST", "/api/accounts", json("name", n, "role", "ordinary"), (r, e) -> { if (e != null) message(e); else if (r instanceof JSONObject && ((JSONObject)r).has("id")) accounts(); else message("Respons tidak dikenali. Periksa daftar akun sebelum mencoba lagi."); }); });
        if ("admin".equals(userRole)) button("Tambahkan akun bot", () -> { String n = name.getText().toString().trim(); if (n.isEmpty() || n.length() > 80) { message("Isi nama akun, maksimal 80 karakter."); return; } message("Menambahkan akun bot..."); request("POST", "/api/accounts", json("name", n, "role", "bot"), (r,e) -> { if (e != null) message(e); else if (r instanceof JSONObject && ((JSONObject)r).has("id")) accounts(); else message("Respons tidak dikenali. Periksa daftar akun sebelum mencoba lagi."); }); });
        button("Perbarui daftar", this::accounts);
        button("Keluar", () -> { message("Mengakhiri sesi..."); request("POST", "/api/logout", new JSONObject(), (r,e) -> { endSession(); login(); if (e != null) message("Sesi lokal dihapus. " + e); }); });
        button("Tema", this::theme);
    }
    private void account(String id, String name) {
        accountId = id; accountName = name; page(name, 2);
        currentAccountStatus = null; accountStatusSerial++;
        accountStatus = text("Memuat status...", 16);
        accountActions = new LinearLayout(this); accountActions.setOrientation(LinearLayout.VERTICAL); body.addView(accountActions);
        qrImage = new ImageView(this); qrImage.setAdjustViewBounds(true); qrImage.setContentDescription("Kode QR WhatsApp untuk dipindai dengan perangkat lain"); body.addView(qrImage, new LinearLayout.LayoutParams(-1, -2));
        text("Tanpa perangkat kedua, gunakan kode pairing. Di WhatsApp buka Perangkat tertaut dan pilih tautkan dengan nomor telepon.", 16);
        EditText phone = field("Nomor dengan kode negara, hanya angka", 2);
        button("Minta kode pairing", () -> { String p = phone.getText().toString().trim(); if (!InputValidation.pairingPhone(p)) { message("Nomor harus 6 sampai 15 digit dan tidak diawali nol."); return; } message("Meminta kode pairing..."); request("POST", "/api/accounts/" + id + "/pairing-code", json("phone", p), (r,e) -> { if (e != null) message(e); else if (r instanceof JSONObject && ((JSONObject)r).optString("code").matches("[A-Z0-9]{8}")) message("Kode pairing: " + ((JSONObject)r).optString("code")); else message("Respons kode tidak dikenali."); }); });
        button("Perbarui status", this::refreshAccount);
        if ("ordinary".equals(accountRole)) button("Jadwal dan riwayat", () -> schedules(id, name));
        if ("admin".equals(userRole)) {
            if ("bot".equals(accountRole)) button("Konfigurasi bot", () -> botConfig(id, name));
            button("Ubah ke " + ("bot".equals(accountRole) ? "akun biasa" : "akun bot"), () -> changeRole(id));
        }
        button("Kembali ke akun", this::accounts);
        refreshAccount();
    }
    private void refreshAccount() {
        if (!foreground || screen != 2 || accountId == null) return;
        timers.removeCallbacksAndMessages(null);
        final String id = accountId;
        final int serial = ++accountStatusSerial;
        request("GET", "/api/accounts", null, (r,e) -> {
            if (serial != accountStatusSerial || !foreground) return;
            if (e != null || !(r instanceof JSONArray)) { currentAccountStatus = null; accountActions.removeAllViews(); accountStatus.setText(e != null ? e : "Respons status tidak dikenali."); }
            else { JSONArray a = (JSONArray)r; JSONObject found = null; for (int i=0; i<a.length(); i++) { JSONObject o = a.optJSONObject(i); if (o != null && id.equals(o.optString("id"))) { found = o; break; } }
                if (found == null) { currentAccountStatus = null; accountActions.removeAllViews(); accountStatus.setText("Akun tidak ditemukan."); qrImage.setImageDrawable(null); }
                else if (!found.optString("role").equals(accountRole)) { accounts(); message("Role akun berubah. Pilih akun kembali."); return; }
                else { currentAccountStatus = found.optString("status", "tidak diketahui"); accountStatus.setText("Status: " + currentAccountStatus); updateAccountActions(id, currentAccountStatus); String qr = found.optString("qr", ""); if (qr.startsWith("data:image/png;base64,") && qr.length() < 400000) { try { byte[] bytes = Base64.decode(qr.substring(qr.indexOf(',')+1), Base64.DEFAULT); Bitmap image = BitmapFactory.decodeByteArray(bytes, 0, bytes.length); qrImage.setImageBitmap(image); } catch (IllegalArgumentException ex) { qrImage.setImageDrawable(null); } } else qrImage.setImageDrawable(null); }
            }
            if (foreground && screen == 2) timers.postDelayed(this::refreshAccount, 5000);
        });
    }
    private void updateAccountActions(String id, String status) {
        accountActions.removeAllViews();
        accountActionGuard.observe(id, status);
        if (accountActionGuard.blocked(id)) {
            TextView wait = new TextView(this); wait.setText("Permintaan sebelumnya telah dikirim. Tunggu perubahan status sebelum meminta lagi."); wait.setTextSize(16); accountActions.addView(wait); return;
        }
        LinearLayout saved = body; body = accountActions;
        if ("disconnected".equals(status)) button("Hubungkan akun", () -> accountConnectionAction(id, "disconnected"));
        else if ("logged_out".equals(status)) button("Tautkan ulang akun", () -> new AlertDialog.Builder(this).setTitle("Tautkan ulang akun?").setMessage("Sesi WhatsApp yang telah keluar akan dihapus dari server dan akun disiapkan untuk ditautkan kembali. Anda perlu memasukkan kode pairing atau memindai QR baru.").setNegativeButton("Batal", null).setPositiveButton("Tautkan ulang", (d,w) -> accountConnectionAction(id, "logged_out")).show());
        body = saved;
    }
    private void accountConnectionAction(String id, String expected) {
        if (!foreground || !authenticated || screen != 2 || !id.equals(accountId) || !expected.equals(currentAccountStatus) || mutation || !accountActionGuard.begin(id, expected)) { message("Status akun berubah atau belum diperbarui. Perbarui status."); return; }
        accountStatusSerial++; currentAccountStatus = null; accountActions.removeAllViews(); timers.removeCallbacksAndMessages(null);
        message(expected.equals("logged_out") ? "Menyiapkan penautan ulang..." : "Menghubungkan akun...");
        request("POST", "/api/accounts/" + id + (expected.equals("logged_out") ? "/repair" : "/connect"), new JSONObject(), (r,e) -> {
            accountActionGuard.finish(id);
            if (e != null) message(e + " Tunggu perubahan status sebelum meminta lagi.");
            else if (r instanceof JSONObject && Boolean.TRUE.equals(((JSONObject)r).opt("ok"))) message("Permintaan selesai. Memeriksa status akun...");
            else message("Hasil permintaan tidak dikenali. Tunggu perubahan status sebelum meminta lagi.");
            if (foreground) refreshAccount();
        });
    }
    private void changeRole(String id) {
        if (!"admin".equals(userRole) || !id.equals(accountId)) return;
        String previous = accountRole, target = "bot".equals(previous) ? "ordinary" : "bot";
        String warning = target.equals("bot")
                ? "Jadwal aktif akan dijeda. Pengiriman yang sudah berlangsung mungkin tetap terkirim atau hasilnya tidak pasti. Periksa riwayat setelah perubahan."
                : "Akun menjadi akun biasa. Jadwal yang dijeda tidak otomatis aktif kembali.";
        new AlertDialog.Builder(this).setTitle("Ubah role akun?").setMessage(warning).setNegativeButton("Batal", null).setPositiveButton("Ubah role", (d,w) -> {
            if (screen != 2 || !id.equals(accountId) || !"admin".equals(userRole) || !previous.equals(accountRole)) { message("Akun berubah. Perbarui daftar akun."); return; }
            message("Mengubah role...");
            request("PUT", "/api/accounts/" + id + "/role", json("expectedRole", previous, "role", target), (r,e) -> {
                if (e != null) { message(e + " Perbarui daftar akun sebelum mencoba lagi."); return; }
                if (!(r instanceof JSONObject) || !Boolean.TRUE.equals(((JSONObject)r).opt("ok")) || !target.equals(((JSONObject)r).optString("role"))) { message("Hasil perubahan tidak dikenali. Perbarui daftar akun."); return; }
                accounts(); message("Role diubah. Perbarui daftar untuk melihat status terbaru.");
            });
        }).show();
    }
    private boolean botAccess(String id) { return authenticated && "admin".equals(userRole) && "bot".equals(accountRole) && id.equals(accountId); }
    private String botPath(String id) { return "/api/accounts/" + id + "/bot-config"; }
    private void botConfig(String id, String name) {
        if (!botAccess(id)) { accounts(); return; }
        page("Konfigurasi bot · " + name, 5); message("Memuat konfigurasi...");
        LinearLayout form = new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL); body.addView(form);
        button("Kembali ke akun", () -> account(id, name));
        request("GET", botPath(id), null, (r,e) -> {
            if (e != null || !(r instanceof JSONObject)) { message(e != null ? e : "Respons konfigurasi tidak dikenali."); return; }
            JSONObject config = (JSONObject)r;
            JSONArray phones = config.optJSONArray("adminPhones"), commands = config.optJSONArray("enabledCommands"), keys = config.optJSONArray("keys");
            if (!"gemini".equals(config.optString("provider")) || !(config.opt("enabled") instanceof Boolean) || !(config.opt("model") instanceof String) || !(config.opt("systemInstruction") instanceof String) || phones == null || commands == null || keys == null) { message("Respons konfigurasi tidak dikenali."); return; }
            message("Konfigurasi dimuat. Simpan sebelum membuka pengelolaan kunci.");
            LinearLayout original = body; body = form;
            CheckBox enabled = new CheckBox(this); enabled.setText("Aktifkan bot"); enabled.setChecked(config.optBoolean("enabled")); enabled.setMinHeight(dp(48)); body.addView(enabled);
            text("Model", 16);
            ArrayList<String> models = new ArrayList<>(); models.add("(Tidak dipilih)"); String selected = config.optString("model"); if (!selected.isEmpty()) models.add(selected);
            ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, models);
            Spinner model = new Spinner(this); model.setContentDescription("Model bot"); model.setAdapter(adapter); if (!selected.isEmpty()) model.setSelection(1); body.addView(model);
            button("Muat daftar model dari server", () -> {
                message("Memuat model..."); request("POST", botPath(id) + "/models", new JSONObject(), (value, failure) -> {
                    if (failure != null || !(value instanceof JSONObject)) { message(failure != null ? failure : "Respons model tidak dikenali."); return; }
                    JSONArray found = ((JSONObject)value).optJSONArray("models"); if (found == null) { message("Respons model tidak dikenali."); return; }
                    String current = model.getSelectedItemPosition() <= 0 ? "" : (String)model.getSelectedItem();
                    models.clear(); models.add("(Tidak dipilih)"); if (!current.isEmpty()) models.add(current);
                    for (int i=0; i<found.length(); i++) { JSONObject item = found.optJSONObject(i); if (item == null) continue; String candidate = item.optString("name"); JSONArray methods = item.optJSONArray("supportedGenerationMethods"); boolean generate = false; if (methods != null) for (int k=0; k<methods.length(); k++) if ("generateContent".equals(methods.optString(k))) generate = true; if (generate && candidate.matches("models/[A-Za-z0-9][A-Za-z0-9._-]{0,127}") && !models.contains(candidate) && !models.contains(candidate.substring(7))) models.add(candidate); }
                    adapter.notifyDataSetChanged(); model.setSelection(current.isEmpty() ? 0 : 1); message(models.size() == 1 ? "Tidak ada model generateContent yang tersedia." : "Daftar model dimuat. Pilih model lalu simpan konfigurasi.");
                });
            });
            EditText instruction = field("Instruksi sistem", 131073); instruction.setSingleLine(false); instruction.setMinLines(3); instruction.setText(config.optString("systemInstruction"));
            EditText admins = field("Nomor admin, satu nomor per baris", 131073); admins.setSingleLine(false); admins.setMinLines(2);
            ArrayList<String> numbers = new ArrayList<>(); for (int i=0; i<phones.length(); i++) numbers.add(phones.optString(i)); admins.setText(android.text.TextUtils.join("\n", numbers));
            text("Perintah aktif. Token dan status hanya untuk nomor admin.", 16);
            LinkedHashSet<String> choices = new LinkedHashSet<>(Arrays.asList("menu", "help", "ping", "info", "resetai", "token", "status"));
            for (int i=0; i<commands.length(); i++) { String command = commands.optString(i); if (command.matches("[a-z][a-z0-9_-]{0,31}")) choices.add(command); }
            ArrayList<CheckBox> boxes = new ArrayList<>();
            for (String command : choices) { CheckBox box = new CheckBox(this); box.setText(command); box.setMinHeight(dp(48)); for (int i=0; i<commands.length(); i++) if (command.equals(commands.optString(i))) box.setChecked(true); body.addView(box); boxes.add(box); }
            button("Simpan konfigurasi", () -> {
                String chosen = model.getSelectedItemPosition() <= 0 ? "" : (String)model.getSelectedItem(); String instruct = instruction.getText().toString();
                JSONArray adminArray = new JSONArray(), commandArray = new JSONArray(); String lines = admins.getText().toString().trim();
                HashSet<String> seenPhones = new HashSet<>();
                if (!lines.isEmpty()) for (String line : lines.split("\\r?\\n")) { String phone = line.trim(); if (!phone.matches("[1-9][0-9]{5,14}") || !seenPhones.add(phone)) { message("Nomor admin harus unik, 6 sampai 15 digit, tanpa tanda plus."); return; } adminArray.put(phone); }
                for (CheckBox box : boxes) if (box.isChecked()) commandArray.put(box.getText().toString());
                if (adminArray.length() > 50 || instruct.length() > 16000 || commandArray.length() > 100) { message("Konfigurasi melebihi batas server."); return; }
                try { JSONObject data = new JSONObject(); data.put("model", chosen); data.put("systemInstruction", instruct); data.put("enabled", enabled.isChecked()); data.put("adminPhones", adminArray); data.put("enabledCommands", commandArray);
                    message("Menyimpan konfigurasi..."); request("PUT", botPath(id), data, (value, failure) -> { if (failure != null) message(failure + " Periksa konfigurasi sebelum mencoba lagi."); else if (value instanceof JSONObject && Boolean.TRUE.equals(((JSONObject)value).opt("ok"))) message("Konfigurasi disimpan."); else message("Hasil tidak dikenali. Perbarui konfigurasi sebelum mencoba lagi."); });
                } catch (JSONException ex) { message("Konfigurasi tidak valid."); }
            });
            button("Kelola kunci (" + keys.length() + ")", () -> new AlertDialog.Builder(this).setTitle("Buka pengelolaan kunci?").setMessage("Perubahan konfigurasi yang belum disimpan akan dibuang.").setNegativeButton("Batal", null).setPositiveButton("Buka", (dialog,which) -> botKeys(id, name)).show());
            button("Muat ulang konfigurasi", () -> new AlertDialog.Builder(this).setTitle("Muat ulang?").setMessage("Perubahan yang belum disimpan akan dibuang.").setNegativeButton("Batal", null).setPositiveButton("Muat ulang", (dialog,which) -> botConfig(id,name)).show());
            body = original;
        });
    }
    private void botKeys(String id, String name) {
        if (!botAccess(id)) { accounts(); return; }
        page("Kunci bot · " + name, 6); text("Nilai kunci hanya dapat dimasukkan, tidak dapat dilihat kembali. Urutan menentukan prioritas.", 16); message("Memuat daftar kunci...");
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); body.addView(list);
        button("Tambahkan kunci", () -> keyEntry(id, name, null));
        button("Muat ulang kunci", () -> botKeys(id, name));
        button("Kembali ke konfigurasi", () -> botConfig(id, name));
        request("GET", botPath(id), null, (r,e) -> {
            if (e != null || !(r instanceof JSONObject)) { message(e != null ? e : "Respons kunci tidak dikenali."); return; }
            JSONArray rows = ((JSONObject)r).optJSONArray("keys"); if (rows == null) { message("Respons kunci tidak dikenali."); return; }
            ArrayList<String> ids = new ArrayList<>();
            for (int i=0; i<rows.length(); i++) { JSONObject row = rows.optJSONObject(i); String key = row == null ? "" : row.optString("id"); if (!key.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}") || ids.contains(key)) { message("Respons kunci tidak dikenali."); return; } ids.add(key); }
            message(ids.isEmpty() ? "Belum ada kunci bot." : "Kunci terdaftar berdasarkan prioritas:");
            for (int i=0; i<ids.size(); i++) {
                final int index = i; String keyId = ids.get(i); TextView label = new TextView(this); label.setTextSize(16); label.setText("Kunci " + (i+1) + " · ID " + keyId); label.setPadding(0, dp(12), 0, dp(4)); list.addView(label);
                LinearLayout saved = body; body = list;
                button("Ganti kunci " + (i+1), () -> keyEntry(id, name, keyId));
                if (i > 0) button("Naikkan kunci " + (i+1), () -> reorderKeys(id, name, ids, index, index-1));
                if (i+1 < ids.size()) button("Turunkan kunci " + (i+1), () -> reorderKeys(id, name, ids, index, index+1));
                button("Hapus kunci " + (i+1), () -> new AlertDialog.Builder(this).setTitle("Hapus kunci?").setMessage("Kunci ini akan dihapus dari akun bot.").setNegativeButton("Batal", null).setPositiveButton("Hapus", (dialog,which) -> { if (screen != 6 || !botAccess(id)) { message("Akun berubah. Muat ulang daftar."); return; } message("Menghapus kunci..."); request("DELETE", botPath(id) + "/keys/" + keyId, new JSONObject(), (value,failure) -> keyResult(id,name,value,failure)); }).show());
                body = saved;
            }
        });
    }
    private void reorderKeys(String id, String name, ArrayList<String> ids, int from, int to) {
        ArrayList<String> reordered = BotKeyOrder.move(ids, from, to);
        if (reordered == null) { message("Urutan kunci berubah. Muat ulang daftar."); return; }
        try { JSONObject data = new JSONObject(); data.put("ids", new JSONArray(reordered)); message("Mengubah urutan..."); request("PUT", botPath(id) + "/keys/order", data, (value,failure) -> keyResult(id,name,value,failure)); } catch (JSONException ex) { message("Urutan tidak valid."); }
    }
    private void keyResult(String id, String name, Object value, String failure) {
        if (failure != null) { message(failure + " Muat ulang daftar kunci sebelum mencoba lagi."); return; }
        if (!(value instanceof JSONObject) || !Boolean.TRUE.equals(((JSONObject)value).opt("ok"))) { message("Hasil tidak dikenali. Muat ulang daftar kunci."); return; }
        botKeys(id, name);
    }
    private void keyEntry(String id, String name, String keyId) {
        if (!botAccess(id)) { accounts(); return; }
        page(keyId == null ? "Tambahkan kunci" : "Ganti kunci", 7);
        text("Nilai disembunyikan dan tidak dapat dilihat kembali. Masukkan kunci lengkap.", 16);
        EditText key = field("Nilai kunci", 129); keyField = key; key.setSaveEnabled(false); key.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); key.setLongClickable(false); key.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING | android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI);
        key.setTransformationMethod(new TransformationMethod() {
            public CharSequence getTransformation(CharSequence source, View view) { return new CharSequence() { public int length() { return source.length(); } public char charAt(int index) { return '\u2022'; } public CharSequence subSequence(int start, int end) { char[] mask = new char[end-start]; Arrays.fill(mask, '\u2022'); return new String(mask); } public String toString() { return subSequence(0, length()).toString(); } }; }
            public void onFocusChanged(View view, CharSequence source, boolean focused, int direction, Rect rect) { }
        });
        button(keyId == null ? "Simpan kunci baru" : "Simpan kunci pengganti", () -> {
            if (mutation) { message("Tunggu hingga permintaan selesai."); return; }
            String secret = key.getText().toString(); key.setText("");
            if (secret.length() < 1 || secret.length() > 4096 || !secret.equals(secret.trim()) || !secret.matches("[\\x20-\\x7e]+")) { message("Nilai kunci tidak valid. Masukkan ulang."); return; }
            message("Menyimpan kunci..."); request(keyId == null ? "POST" : "PUT", botPath(id) + "/keys" + (keyId == null ? "" : "/" + keyId), json("key", secret), (r,e) -> {
                if (e != null) { message(e + " Muat ulang daftar sebelum mencoba lagi."); return; }
                JSONObject o = r instanceof JSONObject ? (JSONObject)r : new JSONObject();
                if ((keyId == null && o.optString("id").matches("[0-9a-f-]{36}")) || (keyId != null && Boolean.TRUE.equals(o.opt("ok")))) botKeys(id,name); else message("Hasil tidak dikenali. Periksa daftar kunci sebelum mencoba lagi.");
            });
        });
        button("Kembali ke daftar kunci", () -> botKeys(id,name));
    }
    private void schedules(String id, String name) { schedules(id, name, null); }
    private void schedules(String id, String name, String feedback) {
        if (!authenticated || !"ordinary".equals(accountRole) || !id.equals(accountId)) { accounts(); return; }
        page("Jadwal · " + name, 3);
        text("Semua waktu ditampilkan dalam WIB (UTC+7). Server mengembalikan maksimal 500 jadwal, sehingga daftar mungkin tidak lengkap.", 16);
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); body.addView(list);
        message("Memuat jadwal...");
        request("GET", "/api/schedules?accountId=" + id, null, (r,e) -> {
            if (e != null || !(r instanceof JSONArray)) { message((feedback == null ? "" : feedback + " ") + (e != null ? e : "Respons jadwal tidak dikenali.")); return; }
            JSONArray a = (JSONArray)r; message((feedback == null ? "" : feedback + " ") + (a.length() == 0 ? "Belum ada jadwal untuk akun ini." : "Jadwal akun ini:"));
            for (int i=0; i<a.length(); i++) {
                JSONObject o = a.optJSONObject(i); if (o == null) continue;
                String scheduleId = o.optString("id"), repeatValue = o.optString("repeat"); Object revision = o.opt("revision"), enabledValue = o.opt("enabled");
                boolean valid = scheduleId.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}") && id.equals(o.optString("account_id")) && ScheduleRules.validRevision(revision) && (enabledValue instanceof Integer || enabledValue instanceof Long) && (((Number)enabledValue).longValue() == 0 || ((Number)enabledValue).longValue() == 1) && o.has("next_at") && (o.isNull("next_at") || o.opt("next_at") instanceof String) && ("once".equals(repeatValue) || "weekly".equals(repeatValue));
                boolean enabled = valid && ((Number)enabledValue).intValue() == 1, hasNext = o.has("next_at") && !o.isNull("next_at");
                boolean editable = ScheduleRules.editable(o.has("attachment_id"), o.isNull("attachment_id")) && o.opt("jid") instanceof String && o.opt("text") instanceof String;
                TextView t = new TextView(this); t.setTextSize(16); t.setPadding(0, dp(16), 0, dp(8));
                t.setText("Tujuan: " + o.optString("jid") + "\nPesan: " + o.optString("text") + "\n" + ("weekly".equals(repeatValue) ? "Mingguan" : "Sekali") + "\nBerikutnya: " + (hasNext ? ScheduleTime.display(o.optString("next_at")) : "Tidak ada") + "\nStatus: " + (!valid ? "Tidak dikenali" : enabled ? (hasNext ? "Aktif" : "Selesai") : "Dijeda") + (editable ? "" : "\nJadwal berlampiran atau data lampiran tidak tersedia. Isi tidak dapat diedit di aplikasi ini.")); list.addView(t);
                if (!valid) continue;
                final long version = ((Number)revision).longValue(); final int renderedGeneration = generation;
                LinearLayout saved = body; body = list;
                if (editable) button("Edit jadwal " + (i+1), () -> editSchedule(id, name, o, version));
                if (enabled && hasNext) button("Jeda jadwal " + (i+1), () -> setScheduleEnabled(id, name, scheduleId, version, false));
                if (!enabled && hasNext) button("Lanjutkan jadwal " + (i+1), () -> setScheduleEnabled(id, name, scheduleId, version, true));
                if (!enabled && !hasNext) text(editable ? "Pilih waktu baru melalui edit sebelum melanjutkan jadwal ini." : "Jadwal ini tidak dapat dilanjutkan di aplikasi karena tidak ada waktu berikutnya dan lampirannya tidak dapat diedit.", 15);
                button("Hapus jadwal " + (i+1), () -> new AlertDialog.Builder(this).setTitle("Hapus jadwal?").setMessage("Jadwal akan dihapus. Pengiriman yang sudah berlangsung mungkin tetap terjadi atau hasilnya tidak pasti.").setNegativeButton("Batal", null).setPositiveButton("Hapus", (dialog,which) -> {
                    if (screen != 3 || generation != renderedGeneration || !id.equals(accountId)) { message("Tampilan berubah. Perbarui daftar jadwal."); return; }
                    try { JSONObject data = new JSONObject(); data.put("revision", version); withOrdinaryAccount(id, () -> scheduleMutation(id, name, "DELETE", "/api/schedules/" + scheduleId, data)); } catch (JSONException ex) { message("Revisi jadwal tidak valid."); }
                }).show());
                body = saved;
            }
        });
        EditText jid = field("Tujuan: nomor@s.whatsapp.net atau ID grup@g.us", 1);
        EditText text = field("Pesan", 131073); scheduleTextField = text; text.setSaveEnabled(false); text.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); text.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING); text.setSingleLine(false); text.setMinLines(2);
        EditText at = field("Tanggal dan jam WIB: YYYY-MM-DDTHH:MM", 1);
        text("Pengulangan", 16);
        Spinner repeat = new Spinner(this); repeat.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, new String[]{"Sekali", "Mingguan"})); body.addView(repeat);
        button("Simpan jadwal", () -> {
            String dest = jid.getText().toString().trim(), content = text.getText().toString(), time = at.getText().toString().trim();
            String repetition = repeat.getSelectedItemPosition() == 0 ? "once" : "weekly";
            if (!ScheduleRules.destination(dest) || content.trim().isEmpty() || content.length() > 4000 || !ScheduleTime.validFuture(time, System.currentTimeMillis())) { message("Periksa tujuan, pesan, dan waktu WIB. Waktu harus valid dan lebih dari 15 detik ke depan."); return; }
            withOrdinaryAccount(id, () -> { message("Menyimpan jadwal..."); request("POST", "/api/messages", json("accountId", id, "jid", dest, "text", content, "repeat", repetition, "at", time), (r,e) -> { if (CONFLICT.equals(e)) schedules(id, name, "Jadwal berubah. Periksa daftar terbaru."); else if (e != null) message(e + " Periksa daftar sebelum mengirim lagi."); else if (r instanceof JSONObject && "scheduled".equals(((JSONObject)r).optString("status"))) schedules(id, name, "Jadwal disimpan."); else message("Respons jadwal tidak dikenali. Periksa daftar sebelum mencoba lagi."); }); });
        });
        button("Perbarui jadwal", () -> schedules(id, name));
        button("Lihat riwayat", () -> history(id, name));
        button("Kembali ke akun", () -> account(id, name));
    }
    private void withOrdinaryAccount(String id, Runnable action) {
        if (!foreground || !authenticated || !"ordinary".equals(accountRole) || !id.equals(accountId) || schedulePreflight || mutation || !(screen == 3 || screen == 8)) { message("Tunggu permintaan selesai atau perbarui akun."); return; }
        schedulePreflight = true; message("Memeriksa akun...");
        request("GET", "/api/accounts", null, (value, failure) -> {
            schedulePreflight = false;
            if (!foreground) { message("Aplikasi tidak aktif. Periksa kembali sebelum mengirim."); return; }
            if (failure != null || !(value instanceof JSONArray)) { message(failure != null ? failure : "Status akun tidak dikenali."); return; }
            JSONArray rows = (JSONArray)value; JSONObject found = null; for (int i=0; i<rows.length(); i++) { JSONObject row = rows.optJSONObject(i); if (row != null && id.equals(row.optString("id"))) { found = row; break; } }
            if (found == null || !"ordinary".equals(found.optString("role"))) { accounts(); message("Akun tidak lagi tersedia sebagai akun biasa. Pilih akun kembali."); return; }
            action.run();
        });
    }
    private void setScheduleEnabled(String id, String name, String scheduleId, long version, boolean enabled) {
        try { JSONObject data = new JSONObject(); data.put("revision", version); data.put("enabled", enabled); withOrdinaryAccount(id, () -> scheduleMutation(id, name, "POST", "/api/schedules/" + scheduleId + "/enabled", data)); }
        catch (JSONException ex) { message("Revisi jadwal tidak valid."); }
    }
    private void scheduleMutation(String id, String name, String method, String path, JSONObject data) {
        message("Menyimpan perubahan jadwal...");
        request(method, path, data, (value, failure) -> {
            if (CONFLICT.equals(failure)) { schedules(id, name, "Jadwal berubah atau sedang diproses. Periksa daftar terbaru."); return; }
            if (failure != null) { schedules(id, name, failure + " Periksa daftar sebelum mengirim lagi."); return; }
            if (value instanceof JSONObject && Boolean.TRUE.equals(((JSONObject)value).opt("ok"))) schedules(id, name, "Perubahan jadwal disimpan.");
            else schedules(id, name, "Hasil tidak dikenali. Periksa daftar sebelum mengirim lagi.");
        });
    }
    private void editSchedule(String id, String name, JSONObject row, long version) {
        if (!"ordinary".equals(accountRole) || !id.equals(accountId) || !ScheduleRules.editable(row.has("attachment_id"), row.isNull("attachment_id"))) { message("Jadwal tidak dapat diedit di aplikasi ini."); return; }
        String scheduleId = row.optString("id"), repetition = row.optString("repeat");
        page("Edit jadwal · " + name, 8);
        text("Waktu menggunakan WIB. Jadwal yang dijeda tetap dijeda setelah diedit; lanjutkan secara terpisah.", 16);
        EditText jid = field("Tujuan: nomor@s.whatsapp.net atau ID grup@g.us", 1); jid.setSaveEnabled(false); jid.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); jid.setText(row.optString("jid"));
        EditText content = field("Pesan", 131073); scheduleTextField = content; content.setSaveEnabled(false); content.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); content.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING); content.setSingleLine(false); content.setMinLines(2); content.setText(row.optString("text"));
        EditText time = field("Tanggal dan jam WIB: YYYY-MM-DDTHH:MM", 1); time.setSaveEnabled(false); time.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); time.setText(row.isNull("next_at") ? "" : ScheduleTime.editValue(row.optString("next_at")));
        text("Pengulangan", 16); Spinner repeat = new Spinner(this); repeat.setContentDescription("Pengulangan"); repeat.setAdapter(new ArrayAdapter<String>(this, android.R.layout.simple_spinner_dropdown_item, new String[]{"Sekali", "Mingguan"})); repeat.setSelection("weekly".equals(repetition) ? 1 : 0); body.addView(repeat);
        button("Simpan perubahan", () -> {
            String dest = jid.getText().toString().trim(), textValue = content.getText().toString(), at = time.getText().toString().trim(), selectedRepeat = repeat.getSelectedItemPosition() == 0 ? "once" : "weekly";
            if (!ScheduleRules.destination(dest) || textValue.trim().isEmpty() || textValue.length() > 4000 || !ScheduleTime.validFuture(at, System.currentTimeMillis())) { message("Periksa tujuan, pesan, dan waktu WIB. Waktu harus valid dan lebih dari 15 detik ke depan."); return; }
            try { JSONObject data = new JSONObject(); data.put("revision", version); data.put("accountId", id); data.put("jid", dest); data.put("text", textValue); data.put("repeat", selectedRepeat); data.put("at", at); data.put("attachmentId", JSONObject.NULL); withOrdinaryAccount(id, () -> scheduleMutation(id, name, "PUT", "/api/schedules/" + scheduleId, data)); }
            catch (JSONException ex) { message("Data jadwal tidak valid."); }
        });
        button("Kembali ke jadwal", () -> schedules(id, name));
    }
    private void history(String id, String name) {
        page("Riwayat · " + name, 4); message("Memuat riwayat...");
        text("Waktu ditampilkan dalam WIB (UTC+7). Server mengembalikan maksimal 500 entri, sehingga riwayat mungkin tidak lengkap.", 16);
        LinearLayout list = new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); body.addView(list);
        request("GET", "/api/history?accountId=" + id, null, (r,e) -> { if (e != null || !(r instanceof JSONArray)) { message(e != null ? e : "Respons riwayat tidak dikenali."); return; } JSONArray a = (JSONArray)r; message(a.length() == 0 ? "Belum ada riwayat untuk akun ini." : "Riwayat akun ini:"); for (int i=0; i<a.length(); i++) { JSONObject o = a.optJSONObject(i); if (o == null) continue; TextView t = new TextView(this); t.setTextSize(16); t.setPadding(0, dp(8), 0, dp(8)); String detail = o.optString("detail", ""); t.setText("Tujuan: " + o.optString("jid") + "\nPesan: " + o.optString("text") + "\nStatus: " + o.optString("status") + (detail.isEmpty() ? "" : "\nKeterangan: " + detail) + "\nDicatat: " + ScheduleTime.display(o.optString("created_at")) + (o.isNull("scheduled_at") || !o.has("scheduled_at") ? "" : "\nDijadwalkan: " + ScheduleTime.display(o.optString("scheduled_at")))); list.addView(t); } });
        button("Perbarui riwayat", () -> history(id, name));
        button("Kembali ke jadwal", () -> schedules(id, name));
    }
    @Override public void onBackPressed() { if (mutation) { message("Tunggu hingga permintaan selesai."); return; } if (screen == 2) accounts(); else if (screen == 3 || screen == 5) account(accountId, accountName); else if (screen == 4 || screen == 8) schedules(accountId, accountName); else if (screen == 6) botConfig(accountId, accountName); else if (screen == 7) botKeys(accountId, accountName); else super.onBackPressed(); }
}
