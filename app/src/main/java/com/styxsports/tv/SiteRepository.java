package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Loads the event listing: configured site origin first, with automatic discovery of the current
 * origin through the gateway page when that fails (the site changes domains frequently).
 * All methods block; call from a background thread.
 */
final class SiteRepository {

    private static final String TAG = "StyxSite";
    private static final String PREFS = "styxsports";
    private static final String KEY_SNAPSHOT = "snapshot_json";
    private static final String KEY_DISCOVERED_BASE = "discovered_base";
    private static final int AJAX_BATCH = 50;

    private final Context ctx;

    SiteRepository(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /** The site origin the listing was last fetched from (falls back to the configured one). */
    String currentBase(RemoteConfig cfg) {
        String discovered = prefs().getString(KEY_DISCOVERED_BASE, null);
        return discovered != null ? discovered : cfg.dataBaseUrl;
    }

    /** Last successful result, for instant paint at launch; null if none. */
    Snapshot cached() {
        String json = prefs().getString(KEY_SNAPSHOT, null);
        if (json == null) return null;
        try {
            return Snapshot.fromJson(json);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Full refresh. From the site when it answers; through the web relay ({@link Relay}) when
     * this network refuses it. Once on the relay, the site is retried directly now and then.
     */
    Snapshot fetch(RemoteConfig cfg) throws IOException {
        boolean relay = Relay.active(ctx);
        IOException relayFailure = null;
        if (relay && !Relay.dueForDirectTry(ctx)) {
            try {
                Snapshot s = Relay.schedule(ctx);
                remember(s.sourceBaseUrl.isEmpty() ? cfg.dataBaseUrl : s.sourceBaseUrl, s);
                return s;
            } catch (IOException e) {
                relayFailure = e;
                Log.w(TAG, "relay failed (" + e.getMessage() + "); trying the site directly");
            }
        }
        if (relay) Relay.notedDirectTry(ctx);
        IOException direct;
        try {
            Snapshot s = fetchDirect(cfg);
            Relay.set(ctx, false);
            return s;
        } catch (IOException e) {
            direct = e;
        }
        if (relayFailure != null) throw direct; // both ways failed this round
        Log.w(TAG, "site unreachable (" + direct.getMessage() + ")" + (Relay.looksBlocked(direct) ? " - looks like this network blocks it" : "")
                + "; trying the web relay");
        try {
            Snapshot s = Relay.schedule(ctx);
            Relay.set(ctx, true);
            remember(s.sourceBaseUrl.isEmpty() ? cfg.dataBaseUrl : s.sourceBaseUrl, s);
            return s;
        } catch (IOException e) {
            Log.w(TAG, "relay failed too: " + e.getMessage());
            throw direct;
        }
    }

    /** Listing page, then the "load more" batches, then the live-status feed, all from the site. */
    private Snapshot fetchDirect(RemoteConfig cfg) throws IOException {
        List<String> candidates = new ArrayList<>();
        String discovered = prefs().getString(KEY_DISCOVERED_BASE, null);
        if (discovered != null) candidates.add(discovered);
        if (!candidates.contains(cfg.dataBaseUrl)) candidates.add(cfg.dataBaseUrl);

        IOException last = null;
        for (String base : candidates) {
            try {
                Snapshot s = fetchFrom(cfg.parser, base);
                if (!s.events.isEmpty()) {
                    remember(base, s);
                    return s;
                }
            } catch (IOException e) {
                last = e;
            }
        }

        // Both known origins failed: find where the gateway's mirror links land today.
        String found = discoverBase(cfg);
        if (found != null && !candidates.contains(found)) {
            Snapshot s = fetchFrom(cfg.parser, found);
            if (!s.events.isEmpty()) {
                remember(found, s);
                return s;
            }
        }
        throw last != null ? last : new IOException("No events found");
    }

    /** Cheap refresh of live clocks/scores for an existing snapshot. */
    void refreshStatus(RemoteConfig cfg, Snapshot s) {
        try {
            String text;
            if (Relay.active(ctx)) text = Relay.status(ctx);
            else if (s.sourceBaseUrl.isEmpty()) return;
            else text = Http.getText(s.sourceBaseUrl + cfg.parser.statusPath);
            SiteParser.mergeStatus(cfg.parser, text, s.events);
        } catch (IOException ignored) {
            // optional
        }
    }

    private Snapshot fetchFrom(ParserRules r, String base) throws IOException {
        String html = Http.getText(base + "/");
        Snapshot s = SiteParser.parseListing(r, html, base);
        if (s.events.isEmpty()) return s;

        Set<String> seen = new HashSet<>();
        for (Event e : s.events) seen.add(e.id);

        for (SiteParser.ShowMore sm : SiteParser.parseShowMore(r, html)) {
            for (int i = 0; i < sm.ids.size(); i += AJAX_BATCH) {
                List<String> batch = sm.ids.subList(i, Math.min(sm.ids.size(), i + AJAX_BATCH));
                try {
                    String body = "category_id=" + sm.categoryId + "&ids=" + join(batch);
                    JSONObject payload = new JSONObject(Http.postForm(base + sm.endpoint, body));
                    if (!payload.optBoolean("ok", false)) continue;
                    for (Event e : SiteParser.parseCards(r, payload.optString("html", ""), base)) {
                        if (seen.add(e.id)) s.events.add(e);
                    }
                } catch (Exception ignored) {
                    // Partial data is better than none; the inline cards already loaded.
                }
            }
        }

        // Small categories (UFC, Boxing, ...) are often not inlined on the front page at all;
        // their dedicated "/<sport>-streams/" page lists them.
        List<String> sportPaths = new ArrayList<>();
        Matcher pm = r.sportPage.matcher(html);
        while (pm.find()) if (!sportPaths.contains(pm.group(1))) sportPaths.add(pm.group(1));
        for (Snapshot.Category c : s.categories) {
            if (c.liveCount + c.soonCount == 0 || hasEvents(s, c.id)) continue;
            String path = sportPathFor(c.name, sportPaths);
            if (path == null) continue;
            try {
                for (Event e : SiteParser.parseCards(r, Http.getText(base + path), base)) {
                    if (e.categoryId == 0) e.categoryId = c.id;
                    if (seen.add(e.id)) s.events.add(e);
                }
            } catch (IOException ignored) {
                // optional
            }
        }

        try {
            SiteParser.mergeStatus(r, Http.getText(base + r.statusPath), s.events);
        } catch (IOException ignored) {
            // optional
        }
        s.fetchedAtMs = System.currentTimeMillis();
        return s;
    }

    private static boolean hasEvents(Snapshot s, int categoryId) {
        for (Event e : s.events) if (e.categoryId == categoryId) return true;
        return false;
    }

    /** "MLB" -> "/mlb-streams/", "Other" -> "/other-events-streams/" (whatever the page offers). */
    private static String sportPathFor(String categoryName, List<String> paths) {
        String slug = categoryName.toLowerCase(Locale.ROOT).trim().replace(' ', '-');
        for (String p : paths) if (p.equals("/" + slug + "-streams/")) return p;
        for (String p : paths) if (p.startsWith("/" + slug)) return p;
        return null;
    }

    /**
     * The gateway page (config homeUrl) links to mirror domains that 30x to the current real
     * origin. Follow the first one that matches the allow list and return its origin.
     */
    private String discoverBase(RemoteConfig cfg) {
        try {
            String html = Http.getText(cfg.homeUrl);
            String gatewayHost = Uri.parse(cfg.homeUrl).getHost();
            Matcher m = Pattern.compile("href=\"(https?://([^\"/]+)/)\"").matcher(html);
            Set<String> tried = new HashSet<>();
            while (m.find()) {
                String url = m.group(1);
                String host = m.group(2);
                if (host.equalsIgnoreCase(gatewayHost) || !cfg.isAllowedHost(host)) continue;
                if (!tried.add(host)) continue;
                try {
                    Uri fin = Uri.parse(Http.finalUrl(url));
                    if (fin.getHost() != null && cfg.isAllowedHost(fin.getHost())) {
                        return fin.getScheme() + "://" + fin.getHost();
                    }
                } catch (IOException ignored) {
                    // try the next mirror
                }
                if (tried.size() >= 4) break;
            }
        } catch (IOException ignored) {
            // gateway unreachable
        }
        return null;
    }

    private void remember(String base, Snapshot s) {
        prefs().edit()
                .putString(KEY_DISCOVERED_BASE, base)
                .putString(KEY_SNAPSHOT, s.toJson())
                .apply();
    }

    private static String join(List<String> parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            if (sb.length() > 0) sb.append(',');
            sb.append(p);
        }
        return sb.toString();
    }

    private SharedPreferences prefs() {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
