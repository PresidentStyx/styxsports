package com.styxsports.tv;

import org.json.JSONException;
import org.json.JSONObject;

/** One listed game/fight/race parsed from the site's match cards. */
final class Event {
    String id = "";
    int categoryId;
    String home = "";
    String away = "";
    /** Absolute URL of the stream page. */
    String url = "";
    /** Unix seconds of scheduled start; 0 if unknown. */
    long startTs;
    boolean live;
    boolean hot;
    /** 1 = most viewed; 0 when not ranked. */
    int hotRank;
    boolean premium;
    /** e.g. "epl", "mls", or a sport tag like "cricket" for the Other category. */
    String league = "";
    /** Absolute crest image URLs; may be empty. */
    String crestHome = "";
    String crestAway = "";
    /** Live clock/status text such as "85'" or "Q3 04:12"; may be empty. */
    String liveText = "";
    /** Score such as "2 - 1"; may be empty. */
    String score = "";

    String title() {
        if (away.isEmpty()) return home;
        return home + " vs " + away;
    }

    JSONObject toJson() throws JSONException {
        return new JSONObject()
                .put("id", id).put("cat", categoryId).put("home", home).put("away", away)
                .put("url", url).put("ts", startTs).put("live", live).put("hot", hot)
                .put("rank", hotRank).put("pro", premium).put("league", league)
                .put("ch", crestHome).put("ca", crestAway).put("lt", liveText).put("sc", score);
    }

    static Event fromJson(JSONObject o) {
        Event e = new Event();
        e.id = o.optString("id", "");
        e.categoryId = o.optInt("cat", 0);
        e.home = o.optString("home", "");
        e.away = o.optString("away", "");
        e.url = o.optString("url", "");
        e.startTs = o.optLong("ts", 0);
        e.live = o.optBoolean("live", false);
        e.hot = o.optBoolean("hot", false);
        e.hotRank = o.optInt("rank", 0);
        e.premium = o.optBoolean("pro", false);
        e.league = o.optString("league", "");
        e.crestHome = o.optString("ch", "");
        e.crestAway = o.optString("ca", "");
        e.liveText = o.optString("lt", "");
        e.score = o.optString("sc", "");
        return e;
    }
}
