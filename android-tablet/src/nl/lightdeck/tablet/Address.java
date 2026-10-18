package nl.lightdeck.tablet;

/** What a person types as the address of lightdeck, made into the address of its tablet page. */
final class Address {
    private Address() {}

    /**
     * "192.168.68.183:8080" becomes "http://192.168.68.183:8080/tablet", as does the same with
     * "http://" in front or a slash after it. An address that has a path is kept as it is, so is its
     * scheme (https works as well). An empty string is the default of this build.
     */
    static String clean(String typed) {
        String text = typed == null ? "" : typed.trim();
        if (text.isEmpty()) return Config.URL;
        if (!text.contains("://")) text = "http://" + text;
        while (text.endsWith("/")) text = text.substring(0, text.length() - 1);
        // Only a bare host (and port) gets the page of the tablet.
        int start = text.indexOf("://") + 3;
        if (text.indexOf('/', start) < 0) text = text + "/tablet";
        return text;
    }
}
