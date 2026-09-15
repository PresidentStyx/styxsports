package com.styxsports.tv;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;

/**
 * Remote feature flags from config.json (`features`, `minVersion`, `pinned`), resolved for this
 * install. The rules are exactly those of the Worker's flags.js and the Roku's Flags.brs, so a
 * flag means the same thing on every platform:
 * <pre>
 *   "hero": true                                  on everywhere
 *   "hero": { "apk": true, "roku": false }        per platform (missing platform = false)
 *   "hero": { "rollout": 25 }                     on for 25% of devices (stable per device id)
 *   "hero": { "rollout": 50, "platforms": ["apk", "web"], "minVersion": "4.0" }
 * </pre>
 */
final class Flags {
    static final String PLATFORM = "apk";

    private final JSONObject features;
    private final JSONObject minVersion;
    private final JSONObject pinned;
    private final String deviceId;
    private final String version;

    Flags(RemoteConfig cfg, Context ctx) {
        this(cfg.features, cfg.minVersion, cfg.pinned, Presence.id(ctx), AppUpdater.installedVersion(ctx));
    }

    Flags(JSONObject features, JSONObject minVersion, JSONObject pinned, String deviceId, String version) {
        this.features = features == null ? new JSONObject() : features;
        this.minVersion = minVersion == null ? new JSONObject() : minVersion;
        this.pinned = pinned == null ? new JSONObject() : pinned;
        this.deviceId = deviceId == null ? "" : deviceId;
        this.version = version == null ? "" : version;
    }

    /** Whether a named feature is on for this device; unknown names are off. */
    boolean on(String name) {
        return flagOn(features.opt(name), PLATFORM, deviceId, version);
    }

    /** True when config.json's minVersion for the APK is above this build. */
    boolean updateRequired() {
        String min = minVersion.optString(PLATFORM, "");
        return !min.isEmpty() && !version.isEmpty() && compareVersions(version, min) < 0;
    }

    /** The APK version this device is pinned to (rollback), or null. */
    String pinnedVersion() {
        if (deviceId.isEmpty()) return null;
        for (Iterator<String> it = pinned.keys(); it.hasNext(); ) {
            String prefix = it.next();
            if (!prefix.startsWith("_") && deviceId.startsWith(prefix)) return pinned.optString(prefix, null);
        }
        return null;
    }

    /** Stable 0..99 bucket for a device id (same arithmetic as flags.js / Flags.brs). */
    static int bucket(String deviceId) {
        int h = 0;
        for (int i = 0; i < deviceId.length(); i++) h = (h * 31 + deviceId.charAt(i)) % 100003;
        return h % 100;
    }

    static boolean flagOn(Object spec, String platform, String deviceId, String version) {
        if (spec instanceof Boolean) return (Boolean) spec;
        if (!(spec instanceof JSONObject)) return false;
        JSONObject o = (JSONObject) spec;
        JSONArray platforms = o.optJSONArray("platforms");
        if (platforms != null) {
            boolean listed = false;
            for (int i = 0; i < platforms.length(); i++) if (platform.equals(platforms.optString(i))) listed = true;
            if (!listed) return false;
        }
        if (o.has(platform) && o.opt(platform) instanceof Boolean && !o.optBoolean(platform)) return false;
        String min = o.optString("minVersion", "");
        if (!min.isEmpty() && !version.isEmpty() && compareVersions(version, min) < 0) return false;
        if (o.opt("rollout") instanceof Number) return bucket(deviceId) < ((Number) o.opt("rollout")).doubleValue();
        if (o.opt(platform) instanceof Boolean && o.optBoolean(platform)) return true;
        if (o.opt("enabled") instanceof Boolean) return o.optBoolean("enabled");
        return false;
    }

    /** -1, 0, 1 for dotted numeric versions ("3.9" &lt; "3.10" &lt; "4.0"); junk compares as 0. */
    static int compareVersions(String a, String b) {
        String[] pa = a.split("\\."), pb = b.split("\\.");
        for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
            int d = part(pa, i) - part(pb, i);
            if (d != 0) return d < 0 ? -1 : 1;
        }
        return 0;
    }

    private static int part(String[] parts, int i) {
        if (i >= parts.length) return 0;
        try { return Integer.parseInt(parts[i].trim()); } catch (NumberFormatException e) { return 0; }
    }
}
