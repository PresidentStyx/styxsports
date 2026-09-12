package com.styxsports.tv;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Everything the home screen needs, in display order. Serialisable for the launch cache. */
final class Snapshot {

    static final class Category {
        final int id;
        final String name;
        int liveCount;
        int soonCount;

        Category(int id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    /** Categories in the order the site presents them. */
    final List<Category> categories = new ArrayList<>();
    final List<Event> events = new ArrayList<>();
    long fetchedAtMs;
    String sourceBaseUrl = "";

    Category category(int id) {
        for (Category c : categories) if (c.id == id) return c;
        return null;
    }

    List<Event> liveEvents() {
        List<Event> out = new ArrayList<>();
        for (Event e : events) if (e.live) out.add(e);
        Collections.sort(out, LIVE_ORDER);
        return out;
    }

    /** Events per category, live first then by start time, keyed in category order. */
    Map<Category, List<Event>> byCategory() {
        Map<Category, List<Event>> out = new LinkedHashMap<>();
        for (Category c : categories) out.put(c, new ArrayList<>());
        Category other = null;
        for (Event e : events) {
            Category c = category(e.categoryId);
            if (c == null) {
                if (other == null) {
                    other = new Category(-1, "Other");
                    out.put(other, new ArrayList<>());
                }
                c = other;
            }
            out.get(c).add(e);
        }
        for (Map.Entry<Category, List<Event>> en : new ArrayList<>(out.entrySet())) {
            if (en.getValue().isEmpty()) {
                out.remove(en.getKey());
            } else {
                Collections.sort(en.getValue(), ROW_ORDER);
            }
        }
        return out;
    }

    /** Ranked "most viewed" first, then earliest kick-off. */
    private static final Comparator<Event> LIVE_ORDER = (a, b) -> {
        int ra = a.hotRank > 0 ? a.hotRank : Integer.MAX_VALUE;
        int rb = b.hotRank > 0 ? b.hotRank : Integer.MAX_VALUE;
        if (ra != rb) return Integer.compare(ra, rb);
        return Long.compare(a.startTs, b.startTs);
    };

    /** Live first (in LIVE_ORDER), then upcoming by start time. */
    private static final Comparator<Event> ROW_ORDER = (a, b) -> {
        if (a.live != b.live) return a.live ? -1 : 1;
        if (a.live) return LIVE_ORDER.compare(a, b);
        return Long.compare(a.startTs, b.startTs);
    };

    String toJson() {
        try {
            JSONArray cats = new JSONArray();
            for (Category c : categories) {
                cats.put(new JSONObject().put("id", c.id).put("name", c.name)
                        .put("live", c.liveCount).put("soon", c.soonCount));
            }
            JSONArray evs = new JSONArray();
            for (Event e : events) evs.put(e.toJson());
            return new JSONObject().put("at", fetchedAtMs).put("base", sourceBaseUrl)
                    .put("categories", cats).put("events", evs).toString();
        } catch (JSONException e) {
            return "";
        }
    }

    static Snapshot fromJson(String json) throws JSONException {
        JSONObject o = new JSONObject(json);
        Snapshot s = new Snapshot();
        s.fetchedAtMs = o.optLong("at", 0);
        s.sourceBaseUrl = o.optString("base", "");
        JSONArray cats = o.optJSONArray("categories");
        if (cats != null) {
            for (int i = 0; i < cats.length(); i++) {
                JSONObject c = cats.getJSONObject(i);
                Category cat = new Category(c.optInt("id"), c.optString("name", "?"));
                cat.liveCount = c.optInt("live");
                cat.soonCount = c.optInt("soon");
                s.categories.add(cat);
            }
        }
        JSONArray evs = o.optJSONArray("events");
        if (evs != null) {
            for (int i = 0; i < evs.length(); i++) s.events.add(Event.fromJson(evs.getJSONObject(i)));
        }
        return s;
    }
}
