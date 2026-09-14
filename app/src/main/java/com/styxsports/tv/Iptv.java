package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The premium account's IPTV playlist: an M3U of ~11k live channels in ~200 groups, with logos.
 * Fetched with the account's personal link, cached on disk (the file is a few MB) and parsed in
 * the background; one parsed copy is kept in memory for the Live TV screen and the player.
 *
 * The "M3U Plus" list carries the logos and groups but points at MPEG-TS streams; the panel also
 * serves it with HLS URLs when asked ({@code output=hls}), which is what we try first because
 * HLS recovers from hiccups better. Either plays in ExoPlayer.
 */
final class Iptv {

    private static final String TAG = "StyxIptv";
    private static final String CACHE_FILE = "iptv_playlist.m3u";
    private static final String PREFS = "styxsports_iptv";
    private static final String KEY_RECENT = "recent";
    private static final long MAX_PLAYLIST_BYTES = 48L * 1024 * 1024;
    private static final int MAX_RECENT = 24;
    /** Re-download the playlist after this long. */
    static final long FRESH_MS = 12L * 60 * 60 * 1000;

    /** Name of the synthetic group holding recently watched channels. */
    static final String RECENT_GROUP = "\u2605 Recently watched";

    static final class Channel {
        final String name;
        final String logo;
        final String group;
        final String url;
        final String tvgId;

        Channel(String name, String logo, String group, String url, String tvgId) {
            this.name = name;
            this.logo = logo;
            this.group = group;
            this.url = url;
            this.tvgId = tvgId;
        }

        JSONObject toJson() throws Exception {
            return new JSONObject().put("n", name).put("l", logo).put("g", group).put("u", url).put("t", tvgId);
        }

        static Channel fromJson(JSONObject o) {
            return new Channel(o.optString("n", ""), o.optString("l", ""), o.optString("g", ""),
                    o.optString("u", ""), o.optString("t", ""));
        }
    }

    static final class Group {
        final String name;
        final List<Channel> channels;

        Group(String name, List<Channel> channels) {
            this.name = name;
            this.channels = channels;
        }
    }

    private static volatile Iptv loaded;

    final List<Group> groups;
    final int channelCount;
    final long fetchedAt;

    private Iptv(List<Group> groups, int channelCount, long fetchedAt) {
        this.groups = groups;
        this.channelCount = channelCount;
        this.fetchedAt = fetchedAt;
    }

    // ---------------------------------------------------------------------------------------------
    // Loading
    // ---------------------------------------------------------------------------------------------

    /** The parsed playlist if this process already has it. */
    static Iptv loaded() {
        return loaded;
    }

    /** Memory, then the disk cache (parsed here; call from a background thread). Null if neither. */
    static Iptv cached(Context ctx) {
        Iptv l = loaded;
        if (l != null) return l;
        File f = cacheFile(ctx);
        if (!f.exists()) return null;
        try {
            byte[] bytes = new byte[(int) f.length()];
            try (FileInputStream in = new FileInputStream(f)) {
                int off = 0, n;
                while (off < bytes.length && (n = in.read(bytes, off, bytes.length - off)) > 0) off += n;
            }
            Iptv parsed = parse(new String(bytes, StandardCharsets.UTF_8), f.lastModified());
            if (parsed.channelCount == 0) return null;
            loaded = parsed;
            return parsed;
        } catch (Exception e) {
            Log.w(TAG, "cache unreadable: " + e);
            return null;
        }
    }

    boolean isFresh() {
        return System.currentTimeMillis() - fetchedAt < FRESH_MS;
    }

    /** Downloads the account's playlist, caches it and returns the parsed result. Blocking. */
    static Iptv fetch(Context ctx) throws IOException {
        if (!Account.isSignedIn(ctx)) {
            // No account here: the shared account's list, through the Worker, with our pool lease.
            if (!Pool.sharedIptv(ctx)) throw new IOException("This account has no IPTV playlist");
            return store(ctx, Pool.fetchIptvM3u(ctx));
        }
        String plus = Account.playlistUrl(ctx);
        if (plus == null) throw new IOException("This account has no IPTV playlist");
        String hls = plus + (plus.contains("?") ? "&" : "?") + "output=hls";
        String text = null;
        try {
            text = download(hls);
            Iptv probe = parse(text, System.currentTimeMillis());
            int m3u8 = 0;
            for (Group g : probe.groups) for (Channel c : g.channels) if (c.url.contains(".m3u8")) m3u8++;
            if (probe.channelCount == 0 || m3u8 * 2 < probe.channelCount) {
                Log.i(TAG, "hls variant unusable (" + m3u8 + "/" + probe.channelCount + "); using the plain list");
                text = null;
            }
        } catch (IOException e) {
            Log.w(TAG, "hls variant failed: " + e.getMessage());
        }
        if (text == null) text = download(plus);
        return store(ctx, text);
    }

    /** Parses a playlist, keeps it as the disk cache and the loaded list. */
    private static Iptv store(Context ctx, String text) throws IOException {
        Iptv parsed = parse(text, System.currentTimeMillis());
        if (parsed.channelCount == 0) throw new IOException("Playlist is empty");
        File f = cacheFile(ctx);
        File tmp = new File(f.getPath() + ".part");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
        if (!tmp.renameTo(f)) Log.w(TAG, "could not replace cache file");
        loaded = parsed;
        Log.i(TAG, "playlist: " + parsed.channelCount + " channels in " + parsed.groups.size() + " groups");
        return parsed;
    }

    static void clearCache(Context ctx) {
        loaded = null;
        File f = cacheFile(ctx);
        if (f.exists() && !f.delete()) Log.w(TAG, "could not delete cache");
        prefs(ctx).edit().clear().apply();
    }

    private static String download(String url) throws IOException {
        return new String(Http.getBytes(url, MAX_PLAYLIST_BYTES), StandardCharsets.UTF_8);
    }

    private static File cacheFile(Context ctx) {
        return new File(ctx.getApplicationContext().getFilesDir(), CACHE_FILE);
    }

    // ---------------------------------------------------------------------------------------------
    // Parsing
    // ---------------------------------------------------------------------------------------------

    private static final Pattern ATTR = Pattern.compile("([A-Za-z][\\w-]*)=\"([^\"]*)\"");

    static Iptv parse(String m3u, long fetchedAt) {
        Map<String, List<Channel>> byGroup = new LinkedHashMap<>();
        int count = 0;
        String pendingInfo = null;
        int start = 0, len = m3u.length();
        while (start < len) {
            int nl = m3u.indexOf('\n', start);
            if (nl < 0) nl = len;
            String line = m3u.substring(start, nl).trim();
            start = nl + 1;
            if (line.isEmpty()) continue;
            if (line.startsWith("#EXTINF")) {
                pendingInfo = line;
            } else if (line.charAt(0) != '#' && pendingInfo != null) {
                Channel c = channel(pendingInfo, line);
                pendingInfo = null;
                if (c == null) continue;
                List<Channel> list = byGroup.get(c.group);
                if (list == null) byGroup.put(c.group, list = new ArrayList<>());
                list.add(c);
                count++;
            }
        }
        // Sports groups first (this is a sports app), everything else in the playlist's order.
        List<Group> sports = new ArrayList<>(), rest = new ArrayList<>();
        for (Map.Entry<String, List<Channel>> e : byGroup.entrySet()) {
            Group g = new Group(e.getKey(), e.getValue());
            (isSports(g.name) ? sports : rest).add(g);
        }
        sports.addAll(rest);
        return new Iptv(sports, count, fetchedAt);
    }

    private static boolean isSports(String group) {
        String g = group.toLowerCase(Locale.ROOT);
        return g.contains("sport") || g.contains("espn") || g.contains("bein") || g.contains("desport")
                || g.contains("esporte") || g.contains("dazn") || g.contains("ppv");
    }

    private static Channel channel(String extinf, String url) {
        if (!url.startsWith("http")) return null;
        int comma = extinf.lastIndexOf(',');
        String name = comma >= 0 ? extinf.substring(comma + 1).trim() : "";
        String logo = "", group = "", tvgId = "";
        Matcher m = ATTR.matcher(comma >= 0 ? extinf.substring(0, comma) : extinf);
        while (m.find()) {
            switch (m.group(1).toLowerCase(Locale.ROOT)) {
                case "tvg-logo": logo = m.group(2).trim(); break;
                case "group-title": group = m.group(2).trim(); break;
                case "tvg-id": tvgId = m.group(2).trim(); break;
                case "tvg-name": if (name.isEmpty()) name = m.group(2).trim(); break;
                default: break;
            }
        }
        if (name.isEmpty()) name = "Channel";
        if (group.isEmpty()) group = "Other";
        if (!logo.startsWith("http")) logo = "";
        return new Channel(name, logo, group, url, tvgId);
    }

    // ---------------------------------------------------------------------------------------------
    // Lookup
    // ---------------------------------------------------------------------------------------------

    Group group(String name) {
        for (Group g : groups) if (g.name.equals(name)) return g;
        return null;
    }

    /** All groups for the screen: recently watched (when any) first, then the playlist's. */
    List<Group> groupsWithRecent(Context ctx) {
        List<Channel> recent = recents(ctx);
        if (recent.isEmpty()) return groups;
        List<Group> out = new ArrayList<>(groups.size() + 1);
        out.add(new Group(RECENT_GROUP, recent));
        out.addAll(groups);
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // Recently watched
    // ---------------------------------------------------------------------------------------------

    static List<Channel> recents(Context ctx) {
        List<Channel> out = new ArrayList<>();
        try {
            JSONArray arr = new JSONArray(prefs(ctx).getString(KEY_RECENT, "[]"));
            for (int i = 0; i < arr.length(); i++) out.add(Channel.fromJson(arr.getJSONObject(i)));
        } catch (Exception ignored) {
            // corrupt: start over
        }
        return out;
    }

    static void recordRecent(Context ctx, Channel c) {
        List<Channel> list = recents(ctx);
        for (int i = list.size() - 1; i >= 0; i--) if (list.get(i).url.equals(c.url)) list.remove(i);
        list.add(0, c);
        while (list.size() > MAX_RECENT) list.remove(list.size() - 1);
        JSONArray arr = new JSONArray();
        try {
            for (Channel ch : list) arr.put(ch.toJson());
        } catch (Exception ignored) {
            return;
        }
        prefs(ctx).edit().putString(KEY_RECENT, arr.toString()).apply();
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
