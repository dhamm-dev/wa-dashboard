package id.my.dhexx.dhexbot;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;

public final class BotKeyOrder {
    private BotKeyOrder() {}
    public static ArrayList<String> move(List<String> ids, int from, int to) {
        if (ids == null || ids.size() > 50 || from < 0 || to < 0 || from >= ids.size() || to >= ids.size() || Math.abs(from - to) != 1) return null;
        HashSet<String> unique = new HashSet<>();
        for (String id : ids) if (id == null || !id.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}") || !unique.add(id)) return null;
        ArrayList<String> result = new ArrayList<>(ids);
        Collections.swap(result, from, to);
        return result;
    }
}
