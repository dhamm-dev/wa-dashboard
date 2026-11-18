package id.my.dhexx.dhexbot;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public final class AccountActionGuard {
    private final Map<String, String> awaiting = new HashMap<>();
    private final Set<String> pending = new HashSet<>();

    public boolean begin(String id, String status) {
        if (id == null || !("disconnected".equals(status) || "logged_out".equals(status)) || awaiting.containsKey(id)) return false;
        awaiting.put(id, status);
        pending.add(id);
        return true;
    }
    public void finish(String id) { pending.remove(id); }
    public void observe(String id, String status) {
        String previous = awaiting.get(id);
        if (previous != null && !pending.contains(id) && knownStatus(status) && !previous.equals(status)) awaiting.remove(id);
    }
    public boolean blocked(String id) { return awaiting.containsKey(id); }
    private static boolean knownStatus(String status) {
        return "disconnected".equals(status) || "logged_out".equals(status) || "connecting".equals(status) || "connected".equals(status) || "qr".equals(status);
    }
}
