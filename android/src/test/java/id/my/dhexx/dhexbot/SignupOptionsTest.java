package id.my.dhexx.dhexbot;

public final class SignupOptionsTest {
    public static void main(String[] args) {
        if (!SignupOptions.enabled(true, Boolean.TRUE)) throw new AssertionError();
        for (Object value : new Object[] { null, Boolean.FALSE, "true", 1 }) {
            if (SignupOptions.enabled(true, value)) throw new AssertionError();
        }
        if (SignupOptions.enabled(false, Boolean.TRUE)) throw new AssertionError();
    }
}
