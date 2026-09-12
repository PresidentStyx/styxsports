package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Games the user opened recently, newest first, for the "Continue watching" row. */
final class Recents {

    private static final String PREFS = "styxsports_recents";
    private static final String KEY = "items";
    private static final int MAX = 8;
    /** Older entries are dropped: the game is over by then. */
    private static final long MAX_AGE_MS = 6 * 60 * 60_000L;

    /** A recent event plus when it was last opened. */
    static final class Item {
        final Event event;
        final long openedAtMs;

        Item(Event event, long openedAtMs) {
            this.event = event;
            this.openedAtMs = openedAtMs;
        }
    }

    private Recents() {}

    static void record(Context ctx, Event e) {
        List<Item> items = load(ctx);
        List<Item> out = new ArrayList<>();
        out.add(new Item(e, System.currentTimeMillis()));
        for (Item it : items) {
            if (!it.event.id.equals(e.id) && out.size() < MAX) out.add(it);
        }
        save(ctx, out);
    }

    /** Recent items that are still worth showing, newest first. */
    static List<Item> load(Context ctx) {
        List<Item> out = new ArrayList<>();
        String json = prefs(ctx).getString(KEY, null);
        if (json == null) return out;
        long cutoff = System.currentTimeMillis() - MAX_AGE_MS;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                long at = o.optLong("at", 0);
                if (at < cutoff) continue;
                JSONObject ev = o.optJSONObject("event");
                if (ev == null) continue;
                out.add(new Item(Event.fromJson(ev), at));
            }
        } catch (Exception ignored) {
            // corrupt store: start over
        }
        return out;
    }

    static void clear(Context ctx) {
        prefs(ctx).edit().remove(KEY).apply();
    }

    private static void save(Context ctx, List<Item> items) {
        try {
            JSONArray arr = new JSONArray();
            for (Item it : items) {
                arr.put(new JSONObject().put("at", it.openedAtMs).put("event", it.event.toJson()));
            }
            prefs(ctx).edit().putString(KEY, arr.toString()).apply();
        } catch (Exception ignored) {
            // best effort
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
