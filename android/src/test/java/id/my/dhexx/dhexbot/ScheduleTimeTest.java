package id.my.dhexx.dhexbot;

import java.time.Instant;

public final class ScheduleTimeTest {
    public static void main(String[] args) {
        if (!"01-01-2027 06:30:00 WIB".equals(ScheduleTime.display("2026-12-31T23:30:00.000Z"))) throw new AssertionError();
        if (!"2027-01-01T06:30".equals(ScheduleTime.editValue("2026-12-31T23:30:00.000Z"))) throw new AssertionError();
        if (!"".equals(ScheduleTime.editValue("2026-12-31T23:30:01Z")) || !"".equals(ScheduleTime.editValue(null))) throw new AssertionError();
        long now = Instant.parse("2026-12-31T23:29:00Z").toEpochMilli();
        if (!ScheduleTime.validFuture("2027-01-01T06:30", now) || ScheduleTime.validFuture("2027-02-30T06:30", now) || ScheduleTime.validFuture("2027-01-01T06:29", now)) throw new AssertionError();
        if (!"Waktu tidak tersedia".equals(ScheduleTime.display("tidak-valid"))) throw new AssertionError();
    }
}
