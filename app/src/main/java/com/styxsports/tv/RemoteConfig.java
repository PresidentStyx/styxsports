package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * Behaviour that can be changed without shipping a new APK. The app loads the last cached copy
 * synchronously at startup, then refreshes it from {@link #CONFIG_URL} in the background.
 */
final class RemoteConfig {

    static final String CONFIG_URL =
            "https://raw.githubusercontent.com/PresidentStyx/styxsports/master/config.json";

    private static final String PREFS = "styxsports";
    private static final String KEY_JSON = "config_json";

    private static final String DEFAULT_HOME_URL = "https://v5.gostreameast.link/";
    private static final String DEFAULT_DATA_BASE_URL = "https://v2.streameast.ga";
    // "streamea.st" is the site's SSO/help/status domain and is spelled differently.
    private static final List<String> DEFAULT_ALLOWED = Arrays.asList("streameast", "streamea.st");
    private static final List<String> DEFAULT_BLOCKED = Arrays.asList("adexchangeclear.com", "adcash");

    /** Player-first styling for stream pages; overridable via config so it can track site changes. */
    static final int DEFAULT_PLAYER_VIEWPORT_WIDTH = 1280;
    static final String DEFAULT_PLAYER_CSS =
            "header.se-chrome,#mobileMenu,.se-sidebar,.se-announce,#pp-toast-container,footer,"
                    + ".se-footer,#live-chat-iframe,.se-chat,[id^=nl-],.nl-newsletter-sidebar,"
                    + ".se-board__promo,.discount-feed-banner,.se-ended__card,#se-nprog,.se-mob-topbar,"
                    + "#se-player-share,.se-player-share,.se-share-modal,.se-chat__bottom-cta,.se-chat__floating"
                    + "{display:none!important}"
                    + "html,body{background:#000!important;margin:0!important;padding:0!important;"
                    + "overflow-x:hidden!important}"
                    + "main.main-content,.streameast-main,.se-video,.se-layout,.se-main"
                    + "{max-width:none!important;width:100%!important;margin:0!important;padding:0!important}"
                    + ".se-layout{display:block!important}"
                    + ".se-board{padding:6px 16px!important;margin:0!important}"
                    + "#se-player-root,.se-player{width:100%!important;margin:0 auto!important}"
                    // The site pins the player iframe to 600px tall; size it to the screen instead
                    // (16:9 of the width, capped so the server tabs and scoreboard stay visible).
                    + "#se-player-root iframe{display:block;width:100%!important;"
                    + "height:calc(100vw*9/16)!important;max-height:calc(100vh - 160px)!important}"
                    + "::-webkit-scrollbar{display:none!important}"
                    + "*{-webkit-user-select:none!important;user-select:none!important;"
                    + "-webkit-tap-highlight-color:transparent!important}";

    /** Page loaded when the native home is disabled or "Open website" is chosen. */
    final String homeUrl;
    /** Origin of the site whose listing pages are parsed for the native home. */
    final String dataBaseUrl;
    /** Kill switch: false shows the plain WebView experience instead of the native home. */
    final boolean nativeHome;
    final List<String> allowedHostFragments;
    final List<String> blockedHostFragments;
    /** Empty means "use the app's built-in user agent". */
    final String userAgent;
    /** Extra JavaScript run after every page load; may be empty. */
    final String pageScript;
    /** CSS injected into stream pages opened from the native home. */
    final String playerCss;
    /** JavaScript injected into stream pages opened from the native home; may be empty. */
    final String playerScript;
    /** CSS px width the stream page is laid out at (0 = leave the site's own viewport). */
    final int playerViewportWidth;
    final String rawJson;

    private RemoteConfig(String homeUrl, String dataBaseUrl, boolean nativeHome,
                         List<String> allowed, List<String> blocked, String userAgent,
                         String pageScript, String playerCss, String playerScript,
                         int playerViewportWidth, String rawJson) {
        this.homeUrl = homeUrl;
        this.dataBaseUrl = stripTrailingSlash(dataBaseUrl);
        this.nativeHome = nativeHome;
        this.allowedHostFragments = lower(allowed);
        this.blockedHostFragments = lower(blocked);
        this.userAgent = userAgent;
        this.pageScript = pageScript;
        this.playerCss = playerCss;
        this.playerScript = playerScript;
        this.playerViewportWidth = playerViewportWidth;
        this.rawJson = rawJson;
    }

    static RemoteConfig defaults() {
        return new RemoteConfig(DEFAULT_HOME_URL, DEFAULT_DATA_BASE_URL, true, DEFAULT_ALLOWED,
                DEFAULT_BLOCKED, "", "", DEFAULT_PLAYER_CSS, "", DEFAULT_PLAYER_VIEWPORT_WIDTH, "");
    }

    static RemoteConfig parse(String json) throws JSONException {
        JSONObject o = new JSONObject(json);
        String home = httpOr(o.optString("homeUrl", ""), DEFAULT_HOME_URL);
        String dataBase = httpOr(o.optString("dataBaseUrl", ""), DEFAULT_DATA_BASE_URL);
        List<String> allowed = toList(o.optJSONArray("allowedHostFragments"));
        if (allowed.isEmpty()) allowed = DEFAULT_ALLOWED;
        String playerCss = o.optString("playerCss", "").trim();
        if (playerCss.isEmpty()) playerCss = DEFAULT_PLAYER_CSS;
        return new RemoteConfig(
                home,
                dataBase,
                o.optBoolean("nativeHome", true),
                allowed,
                toList(o.optJSONArray("blockedHostFragments")),
                o.optString("userAgent", "").trim(),
                o.optString("pageScript", "").trim(),
                playerCss,
                o.optString("playerScript", "").trim(),
                o.optInt("playerViewportWidth", DEFAULT_PLAYER_VIEWPORT_WIDTH),
                json);
    }

    /** Last successfully fetched config, or built-in defaults. Never throws. */
    static RemoteConfig load(Context ctx) {
        String json = prefs(ctx).getString(KEY_JSON, null);
        if (json != null) {
            try {
                return parse(json);
            } catch (JSONException ignored) {
                // fall through to defaults
            }
        }
        return defaults();
    }

    void save(Context ctx) {
        if (rawJson.isEmpty()) return;
        prefs(ctx).edit().putString(KEY_JSON, rawJson).apply();
    }

    boolean isAllowedHost(String host) {
        return matches(host, allowedHostFragments);
    }

    boolean isBlockedHost(String host) {
        return matches(host, blockedHostFragments);
    }

    private static boolean matches(String host, List<String> fragments) {
        if (host == null) return false;
        String h = host.toLowerCase(Locale.ROOT);
        for (String f : fragments) {
            if (!f.isEmpty() && h.contains(f)) return true;
        }
        return false;
    }

    private static String httpOr(String value, String fallback) {
        String v = value.trim();
        return (v.startsWith("http://") || v.startsWith("https://")) ? v : fallback;
    }

    private static String stripTrailingSlash(String s) {
        return s.endsWith("/") ? s.substring(0, s.length() - 1) : s;
    }

    private static List<String> toList(JSONArray arr) {
        List<String> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            String s = arr.optString(i, "").trim();
            if (!s.isEmpty()) out.add(s);
        }
        return out;
    }

    private static List<String> lower(List<String> in) {
        List<String> out = new ArrayList<>(in.size());
        for (String s : in) out.add(s.toLowerCase(Locale.ROOT));
        return Collections.unmodifiableList(out);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
