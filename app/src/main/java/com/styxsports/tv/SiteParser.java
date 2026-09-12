package com.styxsports.tv;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Extracts events from the site's listing HTML. The site has no event JSON, but every match card
 * carries its data as attributes (data-match-id, data-time, data-team-names, ...), which is what
 * this reads. Markup outside those attributes is deliberately not relied upon.
 */
final class SiteParser {

    /** Team cards are <div class="m-card ..."> with an inner link; event cards are <a class="m-card ..." href>. */
    private static final Pattern CARD_START =
            Pattern.compile("<(?:div|a)\\s+class=\"m-card\\b([^\"]*)\"([^>]*)>");
    private static final Pattern CARD_TITLE = Pattern.compile("m-card__title\"[^>]*>([^<]*)<");
    private static final Pattern ATTR =
            Pattern.compile("([a-zA-Z][\\w-]*)=\"([^\"]*)\"");
    private static final Pattern CARD_LINK =
            Pattern.compile("class=\"m-card__link\"[^>]*?href=\"([^\"]+)\"");
    private static final Pattern LIVE_TEXT =
            Pattern.compile("status-live\"[^>]*>([^<]*)<");
    private static final Pattern HOME_SCORE =
            Pattern.compile("data-split-home-score=\"[^\"]*\"[^>]*>([^<]*)<");
    private static final Pattern AWAY_SCORE =
            Pattern.compile("data-split-away-score=\"[^\"]*\"[^>]*>([^<]*)<");

    private static final Pattern CAT_BUTTON =
            Pattern.compile("<button\\b[^>]*class=\"m-cat-band__item[^\"]*\"[^>]*>");
    private static final Pattern CAT_LABEL = Pattern.compile("m-cat-band__label\">([^<]*)<");
    private static final Pattern CAT_LIVE = Pattern.compile("m-hud-live\">(\\d+)<");
    private static final Pattern CAT_SOON = Pattern.compile("m-hud-soon\">(\\d+)<");

    private static final Pattern SHOW_MORE =
            Pattern.compile("<button\\b[^>]*class=\"m-show-more\"[^>]*>");

    /** A "Load more" control: the IDs the server did not inline, fetched via an AJAX endpoint. */
    static final class ShowMore {
        int categoryId;
        String endpoint = "/ajax/ajax_match_cards.php";
        final List<String> ids = new ArrayList<>();
    }

    private SiteParser() {}

    /** Parses the category band and all inline cards of a listing page. */
    static Snapshot parseListing(String html, String baseUrl) {
        Snapshot s = new Snapshot();
        s.sourceBaseUrl = baseUrl;
        parseCategories(html, s);
        s.events.addAll(parseCards(html, baseUrl));
        return s;
    }

    static void parseCategories(String html, Snapshot into) {
        Matcher m = CAT_BUTTON.matcher(html);
        while (m.find()) {
            Map<String, String> attrs = attrs(m.group());
            String cat = attrs.get("data-m-cat");
            if (cat == null || !cat.matches("\\d+")) continue; // skips the "All" entry
            int end = html.indexOf("</button>", m.end());
            String inner = end > 0 ? html.substring(m.end(), end) : "";
            String name = firstGroup(CAT_LABEL, inner, "Category " + cat);
            Snapshot.Category c = new Snapshot.Category(Integer.parseInt(cat), unescape(name).trim());
            c.liveCount = parseInt(firstGroup(CAT_LIVE, inner, "0"));
            c.soonCount = parseInt(firstGroup(CAT_SOON, inner, "0"));
            if (into.category(c.id) == null) into.categories.add(c);
        }
    }

    /** Parses every match card in an HTML fragment (a page or an AJAX payload). */
    static List<Event> parseCards(String html, String baseUrl) {
        List<Event> out = new ArrayList<>();
        Matcher m = CARD_START.matcher(html);
        List<int[]> spans = new ArrayList<>();
        while (m.find()) spans.add(new int[]{m.start(), m.end()});

        for (int i = 0; i < spans.size(); i++) {
            int start = spans.get(i)[0];
            int tagEnd = spans.get(i)[1];
            int next = i + 1 < spans.size() ? spans.get(i + 1)[0] : Math.min(html.length(), tagEnd + 6000);
            String tag = html.substring(start, tagEnd);
            String body = html.substring(tagEnd, next);
            Event e = parseCard(tag, body, baseUrl);
            if (e != null) out.add(e);
        }
        return out;
    }

    private static Event parseCard(String tag, String body, String baseUrl) {
        Matcher cm = CARD_START.matcher(tag);
        if (!cm.find()) return null;
        String classes = cm.group(1);
        Map<String, String> a = attrs(cm.group(2));

        Event e = new Event();
        e.id = firstNonEmpty(a.get("data-match-id"), a.get("data-mac-id"));
        e.categoryId = parseInt(a.get("data-cat-id"));
        e.startTs = parseLong(a.get("data-time"));
        e.live = classes.contains("m-card--live");
        e.hot = classes.contains("m-card--hot") || "1".equals(a.get("data-hot-game"));
        e.hotRank = parseInt(a.get("data-hot-rank"));
        e.premium = "1".equals(a.get("data-pro-only"));
        e.league = firstNonEmpty(a.get("data-league-key"), a.get("data-sport-tag"));

        String names = unescape(a.get("data-team-names"));
        if (names != null && !names.isEmpty()) {
            int bar = names.indexOf('|');
            if (bar >= 0) {
                e.home = names.substring(0, bar).trim();
                e.away = names.substring(bar + 1).trim();
            } else {
                e.home = names.trim();
            }
        }

        String href = a.get("href"); // <a class="m-card"> variant
        if (href == null || href.isEmpty()) href = firstGroup(CARD_LINK, body, "");
        if (href.isEmpty()) return null;
        e.url = absolute(unescape(href), baseUrl);

        if (e.home.isEmpty()) e.home = unescape(firstGroup(CARD_TITLE, body, "")).trim();
        if (e.home.isEmpty()) {
            Matcher al = Pattern.compile("aria-label=\"([^\"]+)\"").matcher(body);
            if (al.find()) e.home = unescape(al.group(1));
        }
        if (e.home.isEmpty()) return null;
        if (e.id.isEmpty()) e.id = e.url;

        e.crestHome = absolute(unescape(a.get("data-mark-home")), baseUrl);
        e.crestAway = absolute(unescape(a.get("data-mark-away")), baseUrl);

        e.liveText = unescape(firstGroup(LIVE_TEXT, body, "")).trim();
        String hs = firstGroup(HOME_SCORE, body, "").trim();
        String as = firstGroup(AWAY_SCORE, body, "").trim();
        if (!hs.isEmpty() && !as.isEmpty()) e.score = hs + " - " + as;
        return e;
    }

    static List<ShowMore> parseShowMore(String html) {
        List<ShowMore> out = new ArrayList<>();
        Matcher m = SHOW_MORE.matcher(html);
        while (m.find()) {
            Map<String, String> a = attrs(m.group());
            ShowMore sm = new ShowMore();
            sm.categoryId = parseInt(a.get("data-category"));
            String ep = a.get("data-endpoint");
            if (ep != null && !ep.isEmpty()) sm.endpoint = ep;
            String ids = a.get("data-ids");
            if (ids != null) {
                for (String id : ids.split(",")) {
                    id = id.trim();
                    if (id.matches("[1-9]\\d*")) sm.ids.add(id);
                }
            }
            if (!sm.ids.isEmpty()) out.add(sm);
        }
        return out;
    }

    /**
     * Merges /data/espn_status_batch.json (live clock and score keyed by match id) into events.
     * Best effort: any malformed input is ignored.
     */
    static void mergeStatus(String json, List<Event> events) {
        try {
            JSONObject root = new JSONObject(json);
            JSONObject m = root.optJSONObject("m");
            if (m == null) return;
            Map<String, Event> byId = new HashMap<>();
            for (Event e : events) byId.put(e.id, e);
            Iterator<String> keys = m.keys();
            while (keys.hasNext()) {
                String id = keys.next();
                Event e = byId.get(id);
                if (e == null) continue;
                JSONObject st = m.optJSONObject(id);
                if (st == null) continue;
                String cls = st.optString("vCls", "");
                boolean live = st.optBoolean("lw", false) || cls.contains("live");
                if (live) {
                    e.live = true;
                    String txt = unescape(st.optString("vTxt", "")).trim();
                    if (!txt.isEmpty()) e.liveText = txt;
                    String sc = st.optString("vSc", "").trim();
                    if (!sc.isEmpty()) e.score = sc;
                }
            }
        } catch (Exception ignored) {
            // status feed is optional
        }
    }

    // --- helpers ---------------------------------------------------------------------------------

    static Map<String, String> attrs(String tag) {
        Map<String, String> out = new HashMap<>();
        Matcher m = ATTR.matcher(tag);
        while (m.find()) out.put(m.group(1), m.group(2));
        return out;
    }

    static String absolute(String href, String baseUrl) {
        if (href == null || href.isEmpty()) return "";
        if (href.startsWith("http://") || href.startsWith("https://")) return href;
        if (href.startsWith("//")) return "https:" + href;
        if (!href.startsWith("/")) href = "/" + href;
        return baseUrl + href;
    }

    static String unescape(String s) {
        if (s == null || s.indexOf('&') < 0) return s;
        String r = s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#039;", "'")
                .replace("&#39;", "'").replace("&apos;", "'").replace("&lt;", "<")
                .replace("&gt;", ">").replace("&nbsp;", " ");
        // numeric entities
        Matcher m = Pattern.compile("&#(\\d+);").matcher(r);
        StringBuffer sb = new StringBuffer();
        while (m.find()) {
            String rep;
            try {
                rep = new String(Character.toChars(Integer.parseInt(m.group(1))));
            } catch (Exception ex) {
                rep = m.group();
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(rep));
        }
        m.appendTail(sb);
        return sb.toString();
    }

    private static String firstGroup(Pattern p, String in, String fallback) {
        Matcher m = p.matcher(in);
        return m.find() ? m.group(1) : fallback;
    }

    private static String firstNonEmpty(String a, String b) {
        if (a != null && !a.isEmpty()) return a;
        return b == null ? "" : b;
    }

    private static int parseInt(String s) {
        try {
            return s == null ? 0 : Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static long parseLong(String s) {
        try {
            return s == null ? 0 : Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
