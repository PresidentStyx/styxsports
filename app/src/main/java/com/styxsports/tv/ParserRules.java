package com.styxsports.tv;

import org.json.JSONObject;

import java.util.regex.Pattern;

/**
 * Everything the app relies on in the site's markup, in one place and overridable from
 * config.json ({@code "parser": { ... }}) so a markup change can be fixed without a new APK.
 *
 * Regexes are Java syntax; group 1 is always the captured value. Attribute names are the
 * {@code data-*} attributes on the match cards. Only keys present in the config are overridden.
 */
final class ParserRules {

    // --- listing page --------------------------------------------------------------------------
    /** Opening tag of a match card; group 1 = class list, group 2 = the remaining attributes. */
    final Pattern cardStart;
    final Pattern cardTitle;
    final Pattern cardLink;
    final Pattern liveText;
    final Pattern homeScore;
    final Pattern awayScore;
    final Pattern catButton;
    final Pattern catLabel;
    final Pattern catLive;
    final Pattern catSoon;
    final Pattern showMore;
    /** Links to per-sport listing pages; group 1 = path, group 2 = sport slug. */
    final Pattern sportPage;
    final String statusPath;

    final String attrId, attrIdAlt, attrCategory, attrTime, attrTeams, attrHot, attrHotRank,
            attrPro, attrLeague, attrLeagueAlt, attrMarkHome, attrMarkAway;
    final String liveClass, hotClass;

    // --- stream page ---------------------------------------------------------------------------
    /** One server tab; group 1 = class list, group 2 = href, group 3 = inner HTML. */
    final Pattern serverItem;
    /** Server display name inside a tab's inner HTML. */
    final Pattern serverName;
    final String serverActiveClass, serverProClass;
    /** Player state attribute on the stream page (e.g. live / gate). */
    final Pattern playerState;
    /** The player embed iframe on the stream page (by id). */
    final Pattern embedIframe;
    /** Any iframe src, for the hops inside the embed chain. */
    final Pattern anyIframe;
    /** The HLS playlist URL inside a player page (JSON-escaped in a script). */
    final Pattern hlsUrl;
    /** A base64-encoded playlist URL, e.g. Clappr's {@code source: window.atob("...")}. */
    final Pattern hlsUrlBase64;

    private ParserRules(JSONObject o) {
        cardStart = re(o, "cardStart", "<(?:div|a)\\s+class=\"m-card\\b([^\"]*)\"([^>]*)>");
        cardTitle = re(o, "cardTitle", "m-card__title\"[^>]*>([^<]*)<");
        cardLink = re(o, "cardLink", "class=\"m-card__link\"[^>]*?href=\"([^\"]+)\"");
        liveText = re(o, "liveText", "status-live\"[^>]*>([^<]*)<");
        homeScore = re(o, "homeScore", "data-split-home-score=\"[^\"]*\"[^>]*>([^<]*)<");
        awayScore = re(o, "awayScore", "data-split-away-score=\"[^\"]*\"[^>]*>([^<]*)<");
        catButton = re(o, "catButton", "<button\\b[^>]*class=\"m-cat-band__item[^\"]*\"[^>]*>");
        catLabel = re(o, "catLabel", "m-cat-band__label\">([^<]*)<");
        catLive = re(o, "catLive", "m-hud-live\">(\\d+)<");
        catSoon = re(o, "catSoon", "m-hud-soon\">(\\d+)<");
        showMore = re(o, "showMore", "<button\\b[^>]*class=\"m-show-more\"[^>]*>");
        sportPage = re(o, "sportPage", "href=\"(/([a-z0-9-]+)-streams/)\"");
        statusPath = str(o, "statusPath", "/data/espn_status_batch.json");

        attrId = str(o, "attrId", "data-match-id");
        attrIdAlt = str(o, "attrIdAlt", "data-mac-id");
        attrCategory = str(o, "attrCategory", "data-cat-id");
        attrTime = str(o, "attrTime", "data-time");
        attrTeams = str(o, "attrTeams", "data-team-names");
        attrHot = str(o, "attrHot", "data-hot-game");
        attrHotRank = str(o, "attrHotRank", "data-hot-rank");
        attrPro = str(o, "attrPro", "data-pro-only");
        attrLeague = str(o, "attrLeague", "data-league-key");
        attrLeagueAlt = str(o, "attrLeagueAlt", "data-sport-tag");
        attrMarkHome = str(o, "attrMarkHome", "data-mark-home");
        attrMarkAway = str(o, "attrMarkAway", "data-mark-away");
        liveClass = str(o, "liveClass", "m-card--live");
        hotClass = str(o, "hotClass", "m-card--hot");

        serverItem = re(o, "serverItem",
                "<li\\s+class=\"se-stream\\b([^\"]*)\"[^>]*>\\s*<a[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</li>");
        serverName = re(o, "serverName", "se-stream__name\"[^>]*>([^<]*)<");
        serverActiveClass = str(o, "serverActiveClass", "is-active");
        serverProClass = str(o, "serverProClass", "is-pro");
        playerState = re(o, "playerState", "id=\"se-player-root\"[^>]*data-state=\"([^\"]*)\"");
        embedIframe = re(o, "embedIframe", "<iframe[^>]*\\bid=\"iframe\"[^>]*\\ssrc=\"([^\"]+)\"");
        anyIframe = re(o, "anyIframe", "<iframe[^>]*\\ssrc=\"([^\"]+)\"");
        hlsUrl = re(o, "hlsUrl", "[\"'](https?:[^\"']+\\.m3u8[^\"']*)[\"']");
        hlsUrlBase64 = re(o, "hlsUrlBase64", "atob\\(\\s*[\"']([A-Za-z0-9+/=]{16,})[\"']\\s*\\)");
    }

    static ParserRules defaults() {
        return new ParserRules(new JSONObject());
    }

    /** @param o the config's "parser" object; null or {} gives the defaults. */
    static ParserRules from(JSONObject o) {
        return new ParserRules(o == null ? new JSONObject() : o);
    }

    private static Pattern re(JSONObject o, String key, String def) {
        String v = o.optString(key, "").trim();
        if (!v.isEmpty()) {
            try {
                return Pattern.compile(v, Pattern.DOTALL);
            } catch (Exception ignored) {
                // a broken override must not take the app down
            }
        }
        return Pattern.compile(def, Pattern.DOTALL);
    }

    private static String str(JSONObject o, String key, String def) {
        String v = o.optString(key, "").trim();
        return v.isEmpty() ? def : v;
    }
}
