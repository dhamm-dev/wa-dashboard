package id.my.dhexx.dhexbot;

import java.util.Arrays;
import java.util.List;

public final class BotKeyOrderTest {
    public static void main(String[] args) {
        String first = "00000000-0000-4000-8000-000000000001", second = "00000000-0000-4000-8000-000000000002";
        List<String> original = Arrays.asList(first, second);
        if (!BotKeyOrder.move(original, 0, 1).equals(Arrays.asList(second, first)) || !original.equals(Arrays.asList(first, second))) throw new AssertionError();
        if (BotKeyOrder.move(original, -1, 0) != null || BotKeyOrder.move(original, 0, 0) != null || BotKeyOrder.move(Arrays.asList(first, first), 0, 1) != null || BotKeyOrder.move(Arrays.asList(first, "bad"), 0, 1) != null) throw new AssertionError();
    }
}
