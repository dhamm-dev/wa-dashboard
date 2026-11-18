package id.my.dhexx.dhexbot;

public final class AccountActionGuardTest {
    public static void main(String[] args) {
        AccountActionGuard guard = new AccountActionGuard();
        if (guard.begin("a", "qr") || !guard.begin("a", "logged_out") || guard.begin("a", "logged_out")) throw new AssertionError();
        guard.observe("a", "connecting");
        if (!guard.blocked("a")) throw new AssertionError();
        guard.finish("a");
        guard.observe("a", "logged_out");
        guard.observe("a", "unknown");
        if (!guard.blocked("a")) throw new AssertionError();
        guard.observe("a", "connecting");
        if (guard.blocked("a") || !guard.begin("a", "disconnected") || !guard.begin("b", "logged_out")) throw new AssertionError();
        guard.finish("a");
        guard.observe("a", "qr");
        if (guard.blocked("a") || !guard.blocked("b")) throw new AssertionError();
    }
}
