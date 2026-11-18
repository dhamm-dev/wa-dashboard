package id.my.dhexx.dhexbot;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.Locale;

public final class ScheduleTime {
    private static final ZoneOffset WIB = ZoneOffset.ofHours(7);
    private static final DateTimeFormatter INPUT = DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm", Locale.ROOT).withResolverStyle(ResolverStyle.STRICT);
    private static final DateTimeFormatter DISPLAY = DateTimeFormatter.ofPattern("dd-MM-uuuu HH:mm:ss", Locale.ROOT).withZone(WIB);
    private ScheduleTime() {}

    public static String display(String iso) {
        try { return DISPLAY.format(Instant.parse(iso)) + " WIB"; }
        catch (Exception e) { return "Waktu tidak tersedia"; }
    }
    public static String editValue(String iso) {
        try {
            Instant instant = Instant.parse(iso);
            if (instant.getNano() != 0 || Math.floorMod(instant.getEpochSecond(), 60) != 0) return "";
            return INPUT.format(LocalDateTime.ofInstant(instant, WIB));
        } catch (Exception e) { return ""; }
    }
    public static boolean validFuture(String local, long nowMillis) {
        try { return LocalDateTime.parse(local, INPUT).toInstant(WIB).toEpochMilli() > nowMillis + 15000; }
        catch (Exception e) { return false; }
    }
}
