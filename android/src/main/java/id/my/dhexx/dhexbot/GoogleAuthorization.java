package id.my.dhexx.dhexbot;

import java.net.URI;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;

public final class GoogleAuthorization {
    private GoogleAuthorization() {}

    public static boolean valid(String value, String origin) {
        if (value == null || value.length() > 8192 || !InputValidation.httpsOrigin(origin)) return false;
        try {
            URI uri = new URI(value);
            if (!"https".equals(uri.getScheme()) || !"accounts.google.com".equals(uri.getHost())
                    || !"accounts.google.com".equals(uri.getRawAuthority()) || uri.getPort() != -1 || uri.getRawUserInfo() != null || uri.getRawFragment() != null
                    || !"/o/oauth2/v2/auth".equals(uri.getRawPath()) || uri.getRawQuery() == null) return false;
            Map<String, String> params = new HashMap<>();
            for (String item : uri.getRawQuery().split("&", -1)) {
                int equals = item.indexOf('=');
                if (equals <= 0) return false;
                String key = URLDecoder.decode(item.substring(0, equals), "UTF-8");
                String val = URLDecoder.decode(item.substring(equals + 1), "UTF-8");
                if (params.put(key, val) != null) return false;
            }
            String base = origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
            return params.size() == 8
                    && params.getOrDefault("client_id", "").matches("[A-Za-z0-9._-]{1,255}")
                    && (base + "/api/google/android/callback").equals(params.get("redirect_uri"))
                    && "code".equals(params.get("response_type"))
                    && "openid email".equals(params.get("scope"))
                    && "S256".equals(params.get("code_challenge_method"))
                    && randomValue(params.get("state")) && randomValue(params.get("nonce"))
                    && randomValue(params.get("code_challenge"));
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean randomValue(String value) {
        return value != null && value.matches("[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]");
    }
}
