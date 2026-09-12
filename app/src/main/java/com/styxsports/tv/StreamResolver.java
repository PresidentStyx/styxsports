package com.styxsports.tv;

import android.net.Uri;
import android.util.Log;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Finds the actual video player behind a stream page.
 *
 * A stream page embeds the site's default server as {@code <iframe id="iframe" src=...>}; that
 * embed page usually wraps yet another iframe holding the real player (Clappr + hls.js). Loading
 * that innermost page directly gives a full-screen player with nothing else on it. Every hop is
 * fetched with the previous page as Referer because the embed hosts return 403 without one.
 */
final class StreamResolver {

    /** The page to load in the WebView and the Referer it must be loaded with. */
    static final class Target {
        final String url;
        final String referer;

        Target(String url, String referer) {
            this.url = url;
            this.referer = referer;
        }
    }

    private static final String TAG = "StyxResolver";

    private static final Pattern IFRAME = Pattern.compile(
            "<iframe\\b([^>]*)>", Pattern.CASE_INSENSITIVE);
    private static final Pattern ATTR = Pattern.compile(
            "\\b(id|src|class)\\s*=\\s*\"([^\"]*)\"", Pattern.CASE_INSENSITIVE);
    /** Iframes that are never the player. */
    private static final Pattern IGNORE_SRC = Pattern.compile(
            "about:blank|sso-frame|streamea\\.st|chat|recaptcha|google|facebook|twitter|"
                    + "histats|doubleclick|adsystem", Pattern.CASE_INSENSITIVE);

    private StreamResolver() {}

    /**
     * @return the stream page's embed (the outer player page) and the Referer to load it with, or
     *         null when the page has no playable embed (premium gate, not started yet, unknown
     *         markup, fetch failed) and should be shown as-is.
     *
     * Only the first hop is resolved on purpose: the innermost player pages refuse to run outside
     * an iframe ({@code if(window==window.top) location="/"}), while the outer embed page is a
     * plain full-size iframe wrapper that is same-origin with the player, so the WebView can
     * script play/pause into it.
     */
    static Target resolve(String streamPageUrl) {
        String html;
        try {
            html = Http.getText(streamPageUrl);
        } catch (Exception e) {
            Log.w(TAG, "stream page fetch failed: " + e);
            return null;
        }
        String embed = mainEmbed(html, streamPageUrl);
        Log.i(TAG, "stream page " + html.length() + " chars, player-root=" + html.contains("se-player-root")
                + ", iframes=" + countIframes(html) + ", state=" + attr(html, "data-state") + ", embed=" + embed);
        return embed == null ? null : new Target(embed, streamPageUrl);
    }

    /** True for an embed URL a stream page may hand us (not the site itself, not an SSO frame). */
    static boolean isEmbedUrl(String src, String pageUrl) {
        if (src == null || src.isEmpty() || IGNORE_SRC.matcher(src).find()) return false;
        return !hostOf(src).equals(hostOf(pageUrl));
    }
    /** The stream page's player iframe: id="iframe" first, else the first non-site iframe. */
    private static String mainEmbed(String html, String pageUrl) {
        String byId = null;
        String fallback = null;
        Matcher m = IFRAME.matcher(html);
        String pageHost = hostOf(pageUrl);
        while (m.find()) {
            String attrs = m.group(1);
            String id = null, src = null;
            Matcher a = ATTR.matcher(attrs);
            while (a.find()) {
                String name = a.group(1).toLowerCase(Locale.ROOT);
                if (name.equals("id")) id = a.group(2);
                else if (name.equals("src")) src = a.group(2);
            }
            if (src == null || src.isEmpty() || IGNORE_SRC.matcher(src).find()) continue;
            String abs = resolveUrl(src, pageUrl);
            if ("iframe".equals(id)) {
                byId = abs;
                break;
            }
            if (fallback == null && !hostOf(abs).equals(pageHost)) fallback = abs;
        }
        return byId != null ? byId : fallback;
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

    private static String originOf(String url) {
        Uri u = Uri.parse(url);
        return u.getScheme() + "://" + u.getHost();
    }

    private static int countIframes(String html) {
        int n = 0;
        Matcher m = IFRAME.matcher(html);
        while (m.find()) n++;
        return n;
    }

    private static String attr(String html, String name) {
        Matcher m = Pattern.compile(name + "=\"([^\"]*)\"").matcher(html);
        return m.find() ? m.group(1) : "-";
    }

    static String hostOf(String url) {
        String h = Uri.parse(url).getHost();
        return h == null ? "" : h.toLowerCase(Locale.ROOT);
    }
}
