package com.styxsports.tv;

import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import java.io.IOException;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Turns a stream page into something playable.
 *
 * A stream page lists its servers as tabs and embeds the active one as an iframe. The embed is a
 * wrapper page around the real player page, which holds the HLS playlist URL (signed, expiring)
 * in a script. Every hop is fetched with the previous page as Referer because the embed hosts
 * return 403 without one, and the CDN expects the player page's origin as Referer/Origin.
 *
 * All methods block; call from a background thread.
 */
final class StreamResolver {

    private static final String TAG = "StyxResolver";
    private static final int MAX_HOPS = 4;
    /** Embed hosts answer slowly (measured ~14 s for the site's primary one) but do answer. */
    private static final int HOP_READ_TIMEOUT_MS = 22_000;

    /** One server tab on the stream page. */
    static final class Server {
        final String name;
        /** Stream page URL for this server. */
        final String pageUrl;
        final boolean active;
        final boolean premium;

        Server(String name, String pageUrl, boolean active, boolean premium) {
            this.name = name;
            this.pageUrl = pageUrl;
            this.active = active;
            this.premium = premium;
        }
    }

    /** The page to load in the WebView and the Referer it must be loaded with. */
    static final class Target {
        final String url;
        final String referer;

        Target(String url, String referer) {
            this.url = url;
            this.referer = referer;
        }
    }

    /** A fully resolved server: HLS playlist for the native player, embed for the WebView. */
    static final class Stream {
        final Server server;
        /**
         * Signed HLS playlist URL - its final location after redirects, checked once from this
         * device ({@link #checkPlaylist}); null when the server has no HLS player we understand or
         * the CDN has no video for it yet ({@code state} "warming").
         */
        final String hlsUrl;
        /** Origin of the page that hosts the player, sent as Referer/Origin to the CDN. */
        final String playerOrigin;
        /** Outer embed page (WebView fallback); null for a gated/empty server. */
        final Target embed;
        /** Player state on the page, e.g. "live", "gate", "" when unknown. */
        final String state;

        Stream(Server server, String hlsUrl, String playerOrigin, Target embed, String state) {
            this.server = server;
            this.hlsUrl = hlsUrl;
            this.playerOrigin = playerOrigin;
            this.embed = embed;
            this.state = state;
        }

        boolean playableNatively() {
            return hlsUrl != null;
        }
    }

    /** The stream page with its server tabs and the active server resolved. */
    static final class Resolved {
        final List<Server> servers;
        /** Index of the active server in {@link #servers}. */
        final int activeIndex;
        final Stream active;

        Resolved(List<Server> servers, int activeIndex, Stream active) {
            this.servers = servers;
            this.activeIndex = activeIndex;
            this.active = active;
        }
    }

    private static final Pattern IGNORE_SRC = Pattern.compile(
            "about:blank|sso-frame|streamea\\.st|chat|recaptcha|google|facebook|twitter|"
                    + "histats|doubleclick|adsystem", Pattern.CASE_INSENSITIVE);

    private final ParserRules rules;

    StreamResolver(ParserRules rules) {
        this.rules = rules;
    }

    // ---------------------------------------------------------------------------------------------
    // Stream page
    // ---------------------------------------------------------------------------------------------

    /** A fetched stream page: its server tabs and the HTML (which embeds the active server). */
    static final class Page {
        final List<Server> servers;
        final int activeIndex;
        final String html;

        Page(List<Server> servers, int activeIndex, String html) {
            this.servers = servers;
            this.activeIndex = activeIndex;
            this.html = html;
        }
    }

    /** Fetches the stream page and its server tabs only (fast; no embed hops). */
    Page page(String streamPageUrl) throws IOException {
        String html = Http.getText(streamPageUrl);
        List<Server> servers = parseServers(html, streamPageUrl);
        int activeIndex = 0;
        for (int i = 0; i < servers.size(); i++) if (servers.get(i).active) activeIndex = i;
        if (servers.isEmpty()) {
            servers.add(new Server("Server 1", streamPageUrl, true, false));
        }
        Log.i(TAG, "stream page: " + servers.size() + " servers, active=" + activeIndex);
        return new Page(servers, activeIndex, html);
    }

    /** Fetches the stream page: server tabs plus the active server fully resolved. */
    Resolved resolve(String streamPageUrl) throws IOException {
        Page p = page(streamPageUrl);
        Stream active = resolve(p.servers.get(p.activeIndex), p);
        return new Resolved(p.servers, p.activeIndex, active);
    }

    /** Resolves one server, reusing the page HTML when it is the page's active server. */
    Stream resolve(Server server, Page page) throws IOException {
        if (page != null && page.servers.get(page.activeIndex) == server) {
            return resolveFromHtml(server, page.html);
        }
        return resolveFromHtml(server, Http.getText(server.pageUrl));
    }

    /** Server tabs, in page order. Empty when the markup has none. */
    List<Server> parseServers(String html, String pageUrl) {
        List<Server> out = new ArrayList<>();
        Matcher m = rules.serverItem.matcher(html);
        while (m.find()) {
            String classes = m.group(1) == null ? "" : m.group(1);
            String href = m.group(2);
            String inner = m.group(3) == null ? "" : m.group(3);
            String name = SiteParser.unescape(firstGroup(rules.serverName, inner, "")).trim();
            if (name.isEmpty()) name = "Server " + (out.size() + 1);
            out.add(new Server(name, resolveUrl(href, pageUrl),
                    classes.contains(rules.serverActiveClass), classes.contains(rules.serverProClass)));
        }
        return out;
    }

    private Stream resolveFromHtml(Server server, String pageHtml) {
        String state = firstGroup(rules.playerState, pageHtml, "");
        String embedUrl = mainEmbed(pageHtml, server.pageUrl);
        if (embedUrl == null) {
            // Premium servers play inline: the page itself carries a Clappr player whose playlist
            // URL is a (reversed) base64 literal. No iframe, so nothing for the WebView fallback.
            String inline = findHls(pageHtml);
            if (inline != null) {
                Log.i(TAG, server.name + ": inline hls on " + hostOf(inline));
                return checked(new Stream(server, inline, originOf(server.pageUrl), null, state));
            }
            Log.i(TAG, server.name + ": no embed (state=" + state + ") " + fingerprint(pageHtml));
            return new Stream(server, null, null, null, state);
        }
        Target embed = new Target(embedUrl, server.pageUrl);

        // Walk the embed chain until a page carries the playlist URL.
        Target hop = embed;
        for (int depth = 0; depth < MAX_HOPS; depth++) {
            String inner;
            try {
                inner = fetchWithRetry(hop);
            } catch (IOException e) {
                Log.w(TAG, server.name + ": hop " + depth + " failed: " + e.getMessage());
                break;
            }
            String hls = findHls(inner);
            if (hls != null) {
                Log.i(TAG, server.name + ": hls at depth " + depth + " on " + hostOf(hop.url));
                return checked(new Stream(server, hls, originOf(hop.url), embed, state));
            }
            String next = firstEmbed(inner, hop.url);
            if (next == null) {
                Log.i(TAG, server.name + ": dead end at " + hostOf(hop.url) + " (" + inner.length()
                        + " chars) " + fingerprint(inner));
                break;
            }
            hop = new Target(next, hop.url);
        }
        Log.i(TAG, server.name + ": embed only (no hls found)");
        return new Stream(server, null, null, embed, state);
    }

    /** One look at a playlist from this device (see {@link #checkPlaylist}). */
    static final class PlaylistCheck {
        /** The CDN answered with a playlist (it may still be warming). */
        final boolean ok;
        /** Where the playlist really is after redirects; the player must work from this URL. */
        final String url;
        /** The only segment is warming.ts: the channel is still spinning up, no video yet. */
        final boolean warming;
        final int code;
        final String error;
        /** Media playlists only: how many segments the window holds and the target duration (s). */
        final int segments, targetSec;

        PlaylistCheck(boolean ok, String url, boolean warming, int code, String error) {
            this(ok, url, warming, code, error, 0, 0);
        }

        PlaylistCheck(boolean ok, String url, boolean warming, int code, String error, int segments, int targetSec) {
            this.ok = ok;
            this.url = url;
            this.warming = warming;
            this.code = code;
            this.error = error;
            this.segments = segments;
            this.targetSec = targetSec;
        }

        /** "3 x 10s" for the log, or "" when the body was a master playlist. */
        String shape() {
            return segments > 0 ? segments + " x " + targetSec + "s" : "";
        }
    }

    private static final Pattern WARMING = Pattern.compile("warming\\.ts", Pattern.CASE_INSENSITIVE);
    private static final Pattern EXTINF = Pattern.compile("^#EXTINF:", Pattern.MULTILINE);
    private static final Pattern TARGET_DURATION = Pattern.compile("^#EXT-X-TARGETDURATION:(\\d+)", Pattern.MULTILINE);

    /**
     * Fetches a playlist once, from this device, the way the player will. The premium CDN answers
     * {@code tv.steast.io/...m3u8} with a 302 to {@code edge-N.iptv4.net/auth/<token>} whose
     * segment URIs are relative and bound to the IP that hit /auth/, so the player has to resolve
     * them against that final URL; and while a channel spins up it serves a one-segment
     * {@code warming.ts} placeholder that is not worth waiting on. No proxy is ever involved:
     * this request and the player's leave from the same address.
     */
    static PlaylistCheck checkPlaylist(String url, String referer) {
        try {
            Http.Fetched f = Http.fetch(url, referer, 10_000, 64 * 1024);
            String body = f.body.trim();
            if (f.code < 200 || f.code >= 300) return new PlaylistCheck(false, url, false, f.code, "HTTP " + f.code + " from " + hostOf(url));
            if (!body.startsWith("#EXTM3U")) return new PlaylistCheck(false, url, false, f.code, "not a playlist");
            int segments = 0;
            for (Matcher m = EXTINF.matcher(body); m.find(); ) segments++;
            Matcher td = TARGET_DURATION.matcher(body);
            int targetSec = td.find() ? Integer.parseInt(td.group(1)) : 0;
            return new PlaylistCheck(true, f.finalUrl, WARMING.matcher(body).find(), f.code, null, segments, targetSec);
        } catch (IOException e) {
            return new PlaylistCheck(false, url, false, 0, e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
        }
    }

    /**
     * Applies {@link #checkPlaylist} to a resolved stream: the final URL, or no URL with state
     * "warming" / "cdn <code>". A check that could not reach the CDN at all changes nothing.
     */
    private static Stream checked(Stream s) {
        if (s.hlsUrl == null) return s;
        PlaylistCheck c = checkPlaylist(s.hlsUrl, s.playerOrigin == null ? null : s.playerOrigin + "/");
        if (c.ok) {
            if (c.warming) {
                Log.i(TAG, s.server.name + ": playlist is warming up on " + hostOf(c.url));
                return new Stream(s.server, null, s.playerOrigin, s.embed, "warming");
            }
            Log.i(TAG, s.server.name + ": playlist " + (c.url.equals(s.hlsUrl) ? "at " : "redirected to ") + hostOf(c.url)
                    + (c.shape().isEmpty() ? "" : " (" + c.shape() + ")"));
            return new Stream(s.server, c.url, s.playerOrigin, s.embed, s.state);
        }
        if (c.code >= 400) {
            Log.i(TAG, s.server.name + ": playlist refused: " + c.error);
            return new Stream(s.server, null, s.playerOrigin, s.embed, "cdn " + c.code);
        }
        Log.i(TAG, s.server.name + ": playlist check inconclusive (" + c.error + "); playing anyway");
        return s;
    }

    /** Embed hosts are flaky: one dropped connection is not a verdict on the server. */
    private static String fetchWithRetry(Target hop) throws IOException {
        try {
            return Http.getText(hop.url, hop.referer, HOP_READ_TIMEOUT_MS);
        } catch (SocketTimeoutException timeout) {
            throw timeout; // a host this slow will not recover within a retry; move on
        } catch (IOException first) {
            Log.w(TAG, "retrying " + hostOf(hop.url) + " after: " + first.getMessage());
            return Http.getText(hop.url, hop.referer, HOP_READ_TIMEOUT_MS);
        }
    }

    /**
     * Playlist URL in a player page: plain (JSON-escaped) first, then base64 (atob), then any
     * long base64 literal that decodes - plain or reversed - to a playlist URL.
     */
    private String findHls(String html) {
        String plain = firstGroup(rules.hlsUrl, html, null);
        if (plain != null) return unescapeJs(plain);
        String viaAtob = decodedPlaylist(rules.hlsUrlBase64, html);
        if (viaAtob != null) return viaAtob;
        return decodedPlaylist(rules.base64Literal, html);
    }

    private static String decodedPlaylist(Pattern p, String html) {
        Matcher m = p.matcher(html);
        while (m.find()) {
            String decoded;
            try {
                decoded = new String(Base64.decode(m.group(1), Base64.DEFAULT), "UTF-8").trim();
            } catch (Exception notBase64) {
                continue;
            }
            if (isPlaylistUrl(decoded)) return decoded;
            String reversed = new StringBuilder(decoded).reverse().toString().trim();
            if (isPlaylistUrl(reversed)) return reversed;
        }
        return null;
    }

    private static boolean isPlaylistUrl(String s) {
        return s.startsWith("http") && (s.contains(".m3u8") || s.contains("/hls")) && !s.contains("\n");
    }

    /** Script/iframe sources and playback hints of a page, for diagnosing unsupported players. */
    private static String fingerprint(String html) {
        StringBuilder b = new StringBuilder("scripts=");
        Matcher m = Pattern.compile("<script[^>]*\\ssrc=\"([^\"]+)\"").matcher(html);
        int n = 0;
        while (m.find() && n++ < 8) b.append(m.group(1)).append(' ');
        b.append("hints=");
        Matcher h = Pattern.compile("[^\\s\"'<>]{0,60}(m3u8|\\.mpd|hls\\(|\\.php\\?|source:|file:|src:)[^\\s\"'<>]{0,60}")
                .matcher(html);
        n = 0;
        while (h.find() && n++ < 8) b.append(h.group()).append(' ');
        return b.toString();
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    /** The stream page's player iframe: the configured id first, else the first off-site iframe. */
    private String mainEmbed(String html, String pageUrl) {
        String byId = firstGroup(rules.embedIframe, html, null);
        if (byId != null && !IGNORE_SRC.matcher(byId).find()) return resolveUrl(byId, pageUrl);
        String pageHost = hostOf(pageUrl);
        Matcher m = rules.anyIframe.matcher(html);
        while (m.find()) {
            String src = m.group(1);
            if (src == null || src.isEmpty() || IGNORE_SRC.matcher(src).find()) continue;
            String abs = resolveUrl(src, pageUrl);
            if (!hostOf(abs).equals(pageHost)) return abs;
        }
        return null;
    }

    private String firstEmbed(String html, String pageUrl) {
        Matcher m = rules.anyIframe.matcher(html);
        while (m.find()) {
            String src = m.group(1);
            if (src != null && !src.isEmpty() && !IGNORE_SRC.matcher(src).find()) {
                return resolveUrl(src, pageUrl);
            }
        }
        return null;
    }

    /** True for an embed URL a stream page may hand us (not the site itself, not an SSO frame). */
    static boolean isEmbedUrl(String src, String pageUrl) {
        if (src == null || src.isEmpty() || IGNORE_SRC.matcher(src).find()) return false;
        return !hostOf(src).equals(hostOf(pageUrl));
    }

    /** Resolves a (possibly relative, HTML-escaped) src against the page it appeared on. */
    static String resolveUrl(String src, String pageUrl) {
        String s = SiteParser.unescape(src.trim());
        try {
            return new URI(pageUrl).resolve(s).toString();
        } catch (Exception e) {
            return SiteParser.absolute(s, originOf(pageUrl));
        }
    }

    /** Undoes JSON/JS string escaping: \u0026 -> &, \/ -> /. */
    static String unescapeJs(String s) {
        Matcher m = Pattern.compile("\\\\u([0-9a-fA-F]{4})").matcher(s);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            m.appendReplacement(sb, Matcher.quoteReplacement(
                    String.valueOf((char) Integer.parseInt(m.group(1), 16))));
        }
        m.appendTail(sb);
        return sb.toString().replace("\\/", "/");
    }

    static String originOf(String url) {
        Uri u = Uri.parse(url);
        return u.getScheme() + "://" + u.getHost();
    }

    static String hostOf(String url) {
        String h = Uri.parse(url).getHost();
        return h == null ? "" : h.toLowerCase(Locale.ROOT);
    }

    private static String firstGroup(Pattern p, String in, String fallback) {
        Matcher m = p.matcher(in);
        return m.find() ? m.group(1) : fallback;
    }
}
