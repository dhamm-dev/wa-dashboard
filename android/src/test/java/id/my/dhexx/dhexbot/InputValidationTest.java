package id.my.dhexx.dhexbot;

public final class InputValidationTest {
    private static void expect(boolean actual, boolean expected) {
        if (actual != expected) throw new AssertionError();
    }

    public static void main(String[] args) {
        expect(InputValidation.pairingPhone("628123456789"), true);
        expect(InputValidation.pairingPhone("+628123456789"), false);
        expect(InputValidation.pairingPhone("012345"), false);
        expect(InputValidation.pairingPhone("12345"), false);
        expect(InputValidation.pairingPhone("1234567890123456"), false);
        expect(InputValidation.httpsOrigin("https://example.com"), true);
        expect(InputValidation.httpsOrigin("http://example.com"), false);
        expect(InputValidation.httpsOrigin("https://example.com/path"), false);
        expect(InputValidation.httpsOrigin("https://user@example.com"), false);
        expect(InputValidation.httpsOrigin("https://example.com?x=1"), false);
        expect(InputValidation.httpsOrigin("https://example.com:0"), false);
    }
}
