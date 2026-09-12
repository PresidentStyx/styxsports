package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Starred teams and leagues. A game is a favourite when either team or its league is starred;
 * favourites sort first in every row and get a star marker.
 */
final class Favorites {

    private static final String PREFS = "styxsports_favorites";
    private static final String KEY_TEAMS = "teams";
    private static final String KEY_LEAGUES = "leagues";

    private final SharedPreferences prefs;
    private final Set<String> teams;
    private final Set<String> leagues;
    /** Category id -> name, so games without a league key can be starred by sport. */
    private final Map<Integer, String> categoryNames = new HashMap<>();

    Favorites(Context ctx) {
        prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        teams = new HashSet<>(prefs.getStringSet(KEY_TEAMS, Collections.<String>emptySet()));
        leagues = new HashSet<>(prefs.getStringSet(KEY_LEAGUES, Collections.<String>emptySet()));
    }

    boolean isTeam(String name) {
        return !name.isEmpty() && teams.contains(key(name));
    }

    boolean isLeague(String league) {
        return !league.isEmpty() && leagues.contains(key(league));
    }

    boolean matches(Event e) {
        return isTeam(e.home) || isTeam(e.away) || isLeague(leagueOf(e));
    }

    /** The event's league key, or its sport category name when the card has no league. */
    String leagueOf(Event e) {
        if (!e.league.isEmpty()) return e.league;
        String cat = categoryNames.get(e.categoryId);
        return cat == null ? "" : cat;
    }

    void setCategories(Snapshot s) {
        categoryNames.clear();
        for (Snapshot.Category c : s.categories) categoryNames.put(c.id, c.name);
    }

    /** @return the new state. */
    boolean toggleTeam(String name) {
        boolean now = toggle(teams, key(name));
        prefs.edit().putStringSet(KEY_TEAMS, new HashSet<>(teams)).apply();
        return now;
    }

    boolean toggleLeague(String league) {
        boolean now = toggle(leagues, key(league));
        prefs.edit().putStringSet(KEY_LEAGUES, new HashSet<>(leagues)).apply();
        return now;
    }

    boolean isEmpty() {
        return teams.isEmpty() && leagues.isEmpty();
    }

    private static boolean toggle(Set<String> set, String k) {
        if (set.remove(k)) return false;
        set.add(k);
        return true;
    }

    private static String key(String s) {
        return s.trim().toLowerCase(Locale.ROOT);
    }
}
