package id.my.dhexx.dhexbot;

public final class SignupOptions {
    private SignupOptions() { }
    public static boolean enabled(boolean success, Object value) {
        return success && Boolean.TRUE.equals(value);
    }
}
