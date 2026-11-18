package id.my.dhexx.dhexbot;

public final class ScheduleRulesTest {
    public static void main(String[] args) {
        if (!ScheduleRules.editable(true, true) || ScheduleRules.editable(true, false) || ScheduleRules.editable(false, true)) throw new AssertionError();
        if (!ScheduleRules.validRevision(0) || !ScheduleRules.validRevision(9007199254740991L) || ScheduleRules.validRevision(-1) || ScheduleRules.validRevision(1.0) || ScheduleRules.validRevision(9007199254740992L)) throw new AssertionError();
        if (!ScheduleRules.destination("628123456789@s.whatsapp.net") || !ScheduleRules.destination("12345-67890@g.us") || ScheduleRules.destination("+628123456789@s.whatsapp.net")) throw new AssertionError();
    }
}
