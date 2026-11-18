package id.my.dhexx.dhexbot;

public final class GoogleAuthorizationTest {
    private static final String ORIGIN = "https://wa-staging.dhexx.my.id";
    private static final String RANDOM = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    private static final String URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=123.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fwa-staging.dhexx.my.id%2Fapi%2Fgoogle%2Fandroid%2Fcallback&response_type=code&scope=openid+email&state=" + RANDOM + "&nonce=" + RANDOM + "&code_challenge=" + RANDOM + "&code_challenge_method=S256";

    private static void expect(String url, boolean expected) {
        if (GoogleAuthorization.valid(url, ORIGIN) != expected) throw new AssertionError("Unexpected validation result");
    }

    public static void main(String[] args) {
        expect(URL, true);
        expect(URL.replace("wa-staging.dhexx.my.id%2Fapi", "evil.example%2Fapi"), false);
        expect(URL.replace("accounts.google.com/", "accounts.google.com:443/"), false);
        expect(URL.replace("accounts.google.com/", "accounts.google.com:/"), false);
        expect(URL.replace("accounts.google.com/", "attacker@accounts.google.com/"), false);
        expect(URL.replace("accounts.google.com/", "accounts.google.com.evil.example/"), false);
        expect(URL + "#fragment", false);
        expect(URL + "&redirect_uri=https%3A%2F%2Fevil.example", false);
        expect(URL + "&%72edirect_uri=https%3A%2F%2Fevil.example", false);
        expect(URL.replace("callback&response_type", "callback%3Fevil%3D1&response_type"), false);
        expect(URL + "&extra=value", false);
        expect(URL.replace("response_type=code", "response_type=token"), false);
        expect(URL.replace("scope=openid+email", "scope=openid"), false);
        expect(URL.replace("code_challenge_method=S256", "code_challenge_method=plain"), false);
        expect(URL.replace("state=" + RANDOM, "state=bad"), false);
        expect(URL.replace("nonce=" + RANDOM, "nonce=bad"), false);
        expect(URL.replace("code_challenge=" + RANDOM, "code_challenge=bad"), false);
        expect(URL.replace("state=" + RANDOM, "state=" + RANDOM.substring(0, 42) + "B"), false);
        expect(URL.replace("scope=openid+email", "scope=%ZZ"), false);
    }
}
