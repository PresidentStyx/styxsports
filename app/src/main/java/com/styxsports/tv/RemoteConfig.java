package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
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
    private static final List<String> DEFAULT_ALLOWED = Collections.singletonList("streameast");

    final String homeUrl;
    final List<String> allowedHostFragments;
    final List<String> blockedHostFragments;
    /** Empty means "use the app's built-in user agent". */
    final String userAgent;
    /** Extra JavaScript run after every page load; may be empty. */
    final String pageScript;
    final String rawJson;

    private RemoteConfig(String homeUrl, List<String> allowed, List<String> blocked,
                         String userAgent, String pageScript, String rawJson) {
        this.homeUrl = homeUrl;
        this.allowedHostFragments = lower(allowed);
        this.blockedHostFragments = lower(blocked);
        this.userAgent = userAgent;
        this.pageScript = pageScript;
        this.rawJson = rawJson;
    }

    static RemoteConfig defaults() {
        return new RemoteConfig(DEFAULT_HOME_URL, DEFAULT_ALLOWED, Collections.emptyList(), "", "", "");
    }

    static RemoteConfig parse(String json) throws JSONException {
        JSONObject o = new JSONObject(json);
        String home = o.optString("homeUrl", DEFAULT_HOME_URL).trim();
        if (!home.startsWith("http://") && !home.startsWith("https://")) {
            home = DEFAULT_HOME_URL;
        }
        List<String> allowed = toList(o.optJSONArray("allowedHostFragments"));
        if (allowed.isEmpty()) allowed = DEFAULT_ALLOWED;
        return new RemoteConfig(
                home,
                allowed,
                toList(o.optJSONArray("blockedHostFragments")),
                o.optString("userAgent", "").trim(),
                o.optString("pageScript", "").trim(),
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
