package id.my.dhexx.dhexbot;

public final class ScheduleRules {
    private ScheduleRules() {}
    public static boolean editable(boolean attachmentFieldPresent, boolean attachmentIsNull) {
        return attachmentFieldPresent && attachmentIsNull;
    }
    public static boolean validRevision(Object value) {
        if (!(value instanceof Integer) && !(value instanceof Long)) return false;
        long revision = ((Number)value).longValue();
        return revision >= 0 && revision <= 9007199254740991L;
    }
    public static boolean destination(String value) {
        return value != null && value.matches("(?:[1-9][0-9]{5,19}@s\\.whatsapp\\.net|[0-9]{5,25}(?:-[0-9]{1,25})?@g\\.us)");
    }
}
