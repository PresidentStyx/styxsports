package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * The site through the web version (sports.styxam.com, web/src/index.js).
 *
 * Some networks - offices, schools, hotels - cut TLS to the site and its video CDNs by name
 * ("Unable to parse TLS packet header" is their firewall answering instead of the site). The
 * Worker reads the site from Cloudflare and proxies the video (/hls/), like the browser
 * version, so the app switches to it when the site itself is unreachable and tries the site
 * directly again every {@link #RETRY_DIRECT_MS}. The Worker knows the caller by its install id
 * ({@link Presence#id}, sent as X-Styx-Device by {@link Http}); nothing else is needed.
 *
 * Every method blocks; call from a background thread.
 */
final class Relay {

    private static final String TAG = "StyxRelay";
    static final String BASE = Pool.WEB;
    private static final String PREFS = "styxsports_relay";
    /** When the app switched to the relay; 0 = talking to the site directly. */
    private static final String KEY_SINCE = "since";
    private static final String KEY_DIRECT_TRY = "direct_try";
    private static final long RETRY_DIRECT_MS = 30 * 60_000L;

    private Relay() {}

    // ---------------------------------------------------------------------------------------------
    // Mode
    // ---------------------------------------------------------------------------------------------

    /** Is the app reading the site through the Worker right now? */
    static boolean active(Context ctx) {
        return prefs(ctx).getLong(KEY_SINCE, 0) > 0;
    }

    /** Switch to the relay (site unreachable) or back to the site (it answered again). */
    static void set(Context ctx, boolean on) {
        boolean was = active(ctx);
        if (was == on) return;
        Log.i(TAG, on ? "site unreachable from this network: reading it through " + BASE
                : "site reachable again: back to reading it directly");
        prefs(ctx).edit().putLong(KEY_SINCE, on ? System.currentTimeMillis() : 0)
                .putLong(KEY_DIRECT_TRY, System.currentTimeMillis()).apply();
    }

    /** The relay is on and the site has not been tried directly for a while. */
    static boolean dueForDirectTry(Context ctx) {
        return active(ctx) && System.currentTimeMillis() - prefs(ctx).getLong(KEY_DIRECT_TRY, 0) > RETRY_DIRECT_MS;
    }

    static void notedDirectTry(Context ctx) {
        prefs(ctx).edit().putLong(KEY_DIRECT_TRY, System.currentTimeMillis()).apply();
    }

    /** Does this failure look like the network refusing the site (rather than the site erring)? */
    static boolean looksBlocked(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof javax.net.ssl.SSLException || t instanceof java.net.UnknownHostException
                    || t instanceof java.net.ConnectException || t instanceof java.net.SocketTimeoutException
                    || t instanceof java.net.NoRouteToHostException) {
                return true;
            }
            String m = t.getMessage() == null ? "" : t.getMessage();
            if (m.contains("TLS") || m.contains("SSL") || m.contains("reset") || m.contains("ECONNREFUSED")) return true;
        }
        return false;
    }

    // ---------------------------------------------------------------------------------------------
    // Schedule
    // ---------------------------------------------------------------------------------------------

    /** The listing (/api/schedule), crests rewritten to load through the Worker too. */
    static Snapshot schedule(Context ctx) throws IOException {
        JSONObject o = call(ctx, BASE + "/api/schedule", 60_000);
        Snapshot s = new Snapshot();
        s.fetchedAtMs = System.currentTimeMillis();
        s.sourceBaseUrl = o.optString("base", "");
        JSONArray cats = o.optJSONArray("categories");
        if (cats != null) {
            for (int i = 0; i < cats.length(); i++) {
                JSONObject c = cats.optJSONObject(i);
                if (c == null) continue;
                Snapshot.Category cat = new Snapshot.Category(c.optInt("id"), c.optString("name", "?"));
                cat.liveCount = c.optInt("liveCount");
                cat.soonCount = c.optInt("soonCount");
                s.categories.add(cat);
            }
        }
        JSONArray evs = o.optJSONArray("events");
        if (evs != null) {
            for (int i = 0; i < evs.length(); i++) {
                JSONObject j = evs.optJSONObject(i);
                if (j == null) continue;
                Event e = new Event();
                e.id = j.optString("id", "");
                e.categoryId = j.optInt("categoryId", 0);
                e.home = j.optString("home", "");
                e.away = j.optString("away", "");
                e.url = j.optString("url", "");
                e.startTs = j.optLong("startTs", 0);
                e.live = j.optBoolean("live", false);
                e.ended = j.optBoolean("ended", false);
                e.hot = j.optBoolean("hot", false);
                e.hotRank = j.optInt("hotRank", 0);
                e.premium = j.optBoolean("premium", false);
                e.league = j.optString("league", "");
                e.crestHome = absolute(j.optString("crestHome", ""));
                e.crestAway = absolute(j.optString("crestAway", ""));
                e.liveText = j.optString("liveText", "");
                e.score = j.optString("score", "");
                if (!e.id.isEmpty() && !e.url.isEmpty()) s.events.add(e);
            }
        }
        if (s.events.isEmpty()) throw new IOException("the relay listed no games");
        Log.i(TAG, "schedule via relay: " + s.events.size() + " events, " + s.categories.size() + " categories");
        return s;
    }

    /** The live clocks/scores feed (/api/status), the site's own JSON for {@link SiteParser#mergeStatus}. */
    static String status(Context ctx) throws IOException {
        ensureAnnounced(ctx);
        return Http.getText(BASE + "/api/status", null, 30_000);
    }

    // ---------------------------------------------------------------------------------------------
    // Streams
    // ---------------------------------------------------------------------------------------------

    /** A stream page's server tabs (/api/stream?only=servers); no HTML, so resolve tabs with {@link #resolve}. */
    static StreamResolver.Page page(Context ctx, String pageUrl) throws IOException {
        JSONObject o = call(ctx, BASE + "/api/stream?page=" + Uri.encode(pageUrl) + "&only=servers&slot="
                + Uri.encode(Presence.id(ctx)), 45_000);
        JSONArray arr = o.optJSONArray("servers");
        List<StreamResolver.Server> servers = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.optJSONObject(i);
                if (s == null) continue;
                String u = s.optString("pageUrl", "");
                if (!u.startsWith("http")) continue;
                servers.add(new StreamResolver.Server(s.optString("name", "Server " + (servers.size() + 1)), u,
                        s.optBoolean("active", false), s.optBoolean("premium", false)));
            }
        }
        if (servers.isEmpty()) servers.add(new StreamResolver.Server("Server 1", pageUrl, true, false));
        int active = Math.max(0, Math.min(servers.size() - 1, o.optInt("activeIndex", 0)));
        Log.i(TAG, "stream page via relay: " + servers.size() + " servers, active=" + active);
        return new StreamResolver.Page(servers, active, "");
    }

    /**
     * Resolves one server tab through the Worker (/api/stream?server=). The Worker answers with
     * the CDN playlist URL and, for the free CDNs, its own proxied copy; the CDN is tried from
     * here first (fast, and the only thing that works for CDNs whose tokens are bound to the
     * viewer's IP), the proxy when this network refuses the CDN or the CDN refuses this device.
     * The premium CDN is never proxied (its panel bans the account for it), so a premium tab on
     * a network that blocks that CDN resolves to nothing and the free tabs are used.
     *
     * A premium tab spends a connection of the shared account, so it needs this device's pool
     * lease (the Worker refuses otherwise: state "gate"). Never throws.
     */
    static StreamResolver.Stream resolve(Context ctx, StreamResolver.Server server, boolean premium) {
        String origin = StreamResolver.originOf(server.pageUrl);
        if (premium && premiumBlocked()) {
            // Every premium tab plays from the same CDN, and this network refused it a moment
            // ago: don't spend seconds (and a Worker page fetch) finding that out tab by tab.
            Log.i(TAG, server.name + ": premium CDN is blocked here, skipping");
            return new StreamResolver.Stream(server, null, origin, null, "blocked");
        }
        try {
            ensureAnnounced(ctx);
            String q = "?server=" + Uri.encode(server.pageUrl) + "&name=" + Uri.encode(server.name)
                    + (premium ? "&premium=1" : "") + "&slot=" + Uri.encode(Presence.id(ctx)) + "&relay=1";
            JSONObject o = new JSONObject(Http.getText(BASE + "/api/stream" + q, null, 45_000));
            JSONObject s = o.optJSONObject("stream");
            if (s == null) {
                Log.w(TAG, server.name + " via web: " + o.optString("error", "no stream"));
                return new StreamResolver.Stream(server, null, origin, null, "");
            }
            String state = s.optString("state", "");
            if (s.optBoolean("warming", false)) {
                Log.i(TAG, server.name + " via web: warming");
                return new StreamResolver.Stream(server, null, origin, null, "warming");
            }
            String direct = s.isNull("direct") ? "" : s.optString("direct", "");
            String hop = s.isNull("hop") ? "" : s.optString("hop", "");
            String proxy = s.isNull("hls") ? "" : BASE + s.optString("hls", "");
            String playerOrigin = s.isNull("playerOrigin") ? "" : s.optString("playerOrigin", "");
            if (!playerOrigin.isEmpty()) origin = playerOrigin;
            Log.i(TAG, server.name + " via web: state=" + state + " cdn=" + s.optString("cdn", "-")
                    + " direct=" + !direct.isEmpty() + " hop=" + !hop.isEmpty() + " proxy=" + !proxy.equals(BASE));
            if (direct.isEmpty() && proxy.equals(BASE)) return new StreamResolver.Stream(server, null, origin, null, state);

            // The CDN from here first, then the edge its front door redirects to, then the
            // Worker's proxy: each one look from this device (Ways).
            Ways w = tryWays(server.name, origin, direct, hop, proxy.equals(BASE) ? "" : proxy);
            if (w.url != null) return new StreamResolver.Stream(server, w.url, origin, null, state);
            if (w.cdnUnreachable && s.optBoolean("ownAddressOnly", false)) {
                // The premium CDN (never proxied) does not answer from here at all: the other
                // premium tabs would fail the same way for the next while.
                Log.w(TAG, "premium CDN unreachable from this network; premium tabs skipped for "
                        + PREMIUM_BLOCKED_MS / 60_000 + " min");
                premiumBlockedUntil = System.currentTimeMillis() + PREMIUM_BLOCKED_MS;
                return new StreamResolver.Stream(server, null, origin, null, "blocked");
            }
            return new StreamResolver.Stream(server, null, origin, null, w.state);
        } catch (Exception e) {
            Log.w(TAG, server.name + " via web failed: " + e.getMessage());
            return new StreamResolver.Stream(server, null, origin, null, "");
        }
    }

    /**
     * A Live TV channel whose front door this network refuses: the Worker (/api/iptv/token)
     * says which edge the channel redirects to, and the edge is tried from here (segments only
     * play from the address that opened it). The Worker never proxies this CDN itself - the
     * panel bans the account when one viewer's requests arrive from many addresses - so when
     * the edge is blocked too, the channel cannot play on this network (IOException with the
     * Worker's message). Needs this device's pool lease or a channel of the account shared to
     * the pool.
     *
     * @return the playlist URL to play, or null with the reason in {@link Ways#state}
     */
    static Ways channel(Context ctx, String name, String channelUrl, String playerOrigin) throws IOException {
        JSONObject o = call(ctx, BASE + "/api/iptv/token?u=" + Uri.encode(channelUrl) + "&slot="
                + Uri.encode(Presence.id(ctx)) + "&relay=1", 30_000);
        String hop = o.isNull("hop") ? "" : o.optString("hop", "");
        String hls = o.isNull("hls") ? "" : o.optString("hls", "");
        if (hop.isEmpty() && hls.isEmpty()) throw new IOException(o.optString("error", "no way to the channel"));
        return tryWays(name, playerOrigin, "", hop, hls.isEmpty() ? "" : BASE + hls);
    }

    /** What {@link #tryWays} found: a playlist URL to play, or none and why ("warming", "cdn 404", ""). */
    static final class Ways {
        final String url;
        final String state;
        /** The CDN's own URL got no answer at all from here (connection or TLS failure, not a refusal). */
        final boolean cdnUnreachable;

        Ways(String url, String state) {
            this(url, state, false);
        }

        Ways(String url, String state, boolean cdnUnreachable) {
            this.url = url;
            this.state = state;
            this.cdnUnreachable = cdnUnreachable;
        }
    }

    /** How long premium tabs are skipped after the premium CDN failed to answer from this network. */
    private static final long PREMIUM_BLOCKED_MS = 10 * 60_000;
    private static volatile long premiumBlockedUntil;

    /** Whether the premium CDN was found unreachable from this network within the last while. */
    static boolean premiumBlocked() {
        return System.currentTimeMillis() < premiumBlockedUntil;
    }

    /**
     * One look from this device at each way to a stream, in order - the CDN URL, the edge it
     * redirects to, the Worker's proxy - skipping empty ones; the first that answers with a
     * playlist wins. A "warming" answer ends the search (the channel is the same behind every
     * way); a refusal (4xx) or no answer moves on to the next.
     */
    private static Ways tryWays(String name, String origin, String direct, String hop, String proxy) {
        String[][] ways = { { "CDN", direct }, { "edge", hop }, { "proxy", proxy } };
        String lastState = "";
        boolean cdnUnreachable = false;
        for (String[] w : ways) {
            if (w[1] == null || w[1].isEmpty()) continue;
            boolean viaProxy = w[0].equals("proxy");
            StreamResolver.PlaylistCheck c = StreamResolver.checkPlaylist(w[1], viaProxy || origin == null ? null : origin + "/");
            if (c.ok && c.warming) {
                Log.i(TAG, name + ": " + w[0] + " is warming up");
                return new Ways(null, "warming");
            }
            if (c.ok) {
                Log.i(TAG, name + ": playing from the " + w[0] + " (" + StreamResolver.hostOf(c.url) + ")");
                return new Ways(c.url, "");
            }
            Log.i(TAG, name + ": " + w[0] + " from here: " + (c.code > 0 ? "HTTP " + c.code : c.error));
            if (w[0].equals("CDN") && c.code == 0) cdnUnreachable = true;
            lastState = c.code > 0 ? "cdn " + c.code : "";
        }
        return new Ways(null, lastState, cdnUnreachable);
    }

    // ---------------------------------------------------------------------------------------------

    private static volatile long announcedAt;

    /** The Worker only serves devices it has heard from in the last minutes; make sure it has. */
    private static void ensureAnnounced(Context ctx) {
        if (System.currentTimeMillis() - announcedAt < 60_000) return;
        if (Presence.announce(ctx)) announcedAt = System.currentTimeMillis();
    }

    private static JSONObject call(Context ctx, String url, int readTimeoutMs) throws IOException {
        ensureAnnounced(ctx);
        String body;
        try {
            body = Http.getText(url, null, readTimeoutMs);
        } catch (IOException e) {
            String m = e.getMessage() == null ? "" : e.getMessage();
            if (m.contains("HTTP 401")) {
                // The Worker has not heard from this device (yet): announce it and try once more.
                announcedAt = 0;
                ensureAnnounced(ctx);
                try {
                    body = Http.getText(url, null, readTimeoutMs);
                } catch (IOException again) {
                    throw new IOException("the web relay did not accept this device");
                }
            } else if (m.contains("HTTP 403")) {
                throw new IOException("the web relay refused the request");
            } else {
                throw e;
            }
        }
        JSONObject o;
        try {
            o = new JSONObject(body);
        } catch (Exception e) {
            throw new IOException("bad answer from the web relay");
        }
        if (o.has("error") && !o.isNull("error")) throw new IOException(o.optString("error"));
        return o;
    }

    private static String absolute(String path) {
        if (path == null || path.isEmpty()) return "";
        return path.startsWith("/") ? BASE + path : path;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
