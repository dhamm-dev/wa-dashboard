package id.my.dhexx.dhexbot;

import java.net.URI;
import java.net.URISyntaxException;

public final class InputValidation {
    private InputValidation() {}

    public static boolean pairingPhone(String value) {
        return value != null && value.matches("[1-9][0-9]{5,14}");
    }

    public static boolean httpsOrigin(String value) {
        if (value == null) return false;
        try {
            URI uri = new URI(value);
            String path = uri.getRawPath();
            return "https".equalsIgnoreCase(uri.getScheme())
                    && uri.getHost() != null
                    && uri.getRawUserInfo() == null
                    && (path == null || path.isEmpty() || "/".equals(path))
                    && uri.getRawQuery() == null && uri.getRawFragment() == null
                    && (uri.getPort() == -1 || (uri.getPort() > 0 && uri.getPort() <= 65535));
        } catch (URISyntaxException e) {
            return false;
        }
    }
}
