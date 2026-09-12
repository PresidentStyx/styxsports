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

    private static final Pattern ATTR =
            Pattern.compile("([a-zA-Z][\\w-]*)=\"([^\"]*)\"");

    /** A "Load more" control: the IDs the server did not inline, fetched via an AJAX endpoint. */
    static final class ShowMore {
        int categoryId;
        String endpoint = "/ajax/ajax_match_cards.php";
        final List<String> ids = new ArrayList<>();
    }

    private SiteParser() {}

    /** Parses the category band and all inline cards of a listing page. */
    static Snapshot parseListing(ParserRules r, String html, String baseUrl) {
        Snapshot s = new Snapshot();
        s.sourceBaseUrl = baseUrl;
        parseCategories(r, html, s);
        s.events.addAll(parseCards(r, html, baseUrl));
        return s;
    }

    static void parseCategories(ParserRules r, String html, Snapshot into) {
        Matcher m = r.catButton.matcher(html);
        while (m.find()) {
            Map<String, String> attrs = attrs(m.group());
            String cat = attrs.get("data-m-cat");
            if (cat == null || !cat.matches("\\d+")) continue; // skips the "All" entry
            int end = html.indexOf("</button>", m.end());
            String inner = end > 0 ? html.substring(m.end(), end) : "";
            String name = firstGroup(r.catLabel, inner, "Category " + cat);
            Snapshot.Category c = new Snapshot.Category(Integer.parseInt(cat), unescape(name).trim());
            c.liveCount = parseInt(firstGroup(r.catLive, inner, "0"));
            c.soonCount = parseInt(firstGroup(r.catSoon, inner, "0"));
            if (into.category(c.id) == null) into.categories.add(c);
        }
    }

    /** Parses every match card in an HTML fragment (a page or an AJAX payload). */
    static List<Event> parseCards(ParserRules r, String html, String baseUrl) {
        List<Event> out = new ArrayList<>();
        Matcher m = r.cardStart.matcher(html);
        List<int[]> spans = new ArrayList<>();
        while (m.find()) spans.add(new int[]{m.start(), m.end()});

        for (int i = 0; i < spans.size(); i++) {
            int start = spans.get(i)[0];
            int tagEnd = spans.get(i)[1];
            int next = i + 1 < spans.size() ? spans.get(i + 1)[0] : Math.min(html.length(), tagEnd + 6000);
            String tag = html.substring(start, tagEnd);
            String body = html.substring(tagEnd, next);
            Event e = parseCard(r, tag, body, baseUrl);
            if (e != null) out.add(e);
        }
        return out;
    }

    private static Event parseCard(ParserRules r, String tag, String body, String baseUrl) {
        Matcher cm = r.cardStart.matcher(tag);
        if (!cm.find()) return null;
        String classes = cm.group(1);
        Map<String, String> a = attrs(cm.group(2));

        Event e = new Event();
        e.id = firstNonEmpty(a.get(r.attrId), a.get(r.attrIdAlt));
        e.categoryId = parseInt(a.get(r.attrCategory));
        e.startTs = parseLong(a.get(r.attrTime));
        e.live = classes.contains(r.liveClass);
        e.hot = classes.contains(r.hotClass) || "1".equals(a.get(r.attrHot));
        e.hotRank = parseInt(a.get(r.attrHotRank));
        e.premium = "1".equals(a.get(r.attrPro));
        e.league = firstNonEmpty(a.get(r.attrLeague), a.get(r.attrLeagueAlt));

        String names = unescape(a.get(r.attrTeams));
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
        if (href == null || href.isEmpty()) href = firstGroup(r.cardLink, body, "");
        if (href.isEmpty()) return null;
        e.url = absolute(unescape(href), baseUrl);

        if (e.home.isEmpty()) e.home = unescape(firstGroup(r.cardTitle, body, "")).trim();
        if (e.home.isEmpty()) {
            Matcher al = Pattern.compile("aria-label=\"([^\"]+)\"").matcher(body);
            if (al.find()) e.home = unescape(al.group(1));
        }
        if (e.home.isEmpty()) return null;
        if (e.id.isEmpty()) e.id = e.url;

        e.crestHome = absolute(unescape(a.get(r.attrMarkHome)), baseUrl);
        e.crestAway = absolute(unescape(a.get(r.attrMarkAway)), baseUrl);

        e.liveText = unescape(firstGroup(r.liveText, body, "")).trim();
        String hs = firstGroup(r.homeScore, body, "").trim();
        String as = firstGroup(r.awayScore, body, "").trim();
        if (!hs.isEmpty() && !as.isEmpty()) e.score = hs + " - " + as;
        return e;
    }

    static List<ShowMore> parseShowMore(ParserRules r, String html) {
        List<ShowMore> out = new ArrayList<>();
        Matcher m = r.showMore.matcher(html);
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
