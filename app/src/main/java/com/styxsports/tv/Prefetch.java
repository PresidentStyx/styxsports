package com.styxsports.tv;

import android.content.Context;
import android.os.Handler;
import android.os.SystemClock;
import android.util.Log;

import java.io.IOException;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Zero-wait start (4.0 phase 2.1): resolves a game's stream while its card merely has focus, so
 * pressing OK plays instead of spinning.
 *
 * <p>Home calls {@link #focus} when a card gains focus and {@link #blur} when it loses it. After
 * {@link #FREE_DELAY_MS} of focus the stream page (server tabs) and the best <em>free</em> server
 * are resolved on a background thread - free servers cost nothing but a page read. After
 * {@link #PREMIUM_DELAY_MS}, if this device can play premium tabs and the {@code prewarm} flag is
 * on, it asks the pool for a <em>pre-warm</em> lease ({@code acquire { prewarm: true }}, granted
 * only while two slots stay free, dropped by the Worker after 60 s unless the player converts it)
 * and resolves the first named premium tab too. {@link NativePlayerActivity} reads the result
 * through {@link #page} and {@link #streams}; anything older than {@link #TTL_MS} is ignored
 * (playlist URLs are signed and short-lived).
 *
 * <p>The player's own {@code acquire} for the same game turns the pre-warm into a real lease
 * (same device id, same slot), so Home must never release it after handing a game to the player:
 * {@link #handOff} forgets it; {@link #releasePrewarm} is for leaving Home or moving to another
 * game before any player opened.
 */
final class Prefetch {
    private static final String TAG = "StyxPrefetch";
    static final long FREE_DELAY_MS = 600;
    static final long PREMIUM_DELAY_MS = 2_000;
    /** A pre-resolved stream older than this is not trusted (signed URLs, IP-bound edge tokens). */
    static final long TTL_MS = 90_000;
    private static final int MAX_ENTRIES = 8;
    /** The site's generic "Server N" premium tabs are embeds no native player reads; named tabs resolve. */
    static final Pattern GENERIC_TAB = Pattern.compile("(?i)^server\\s*\\d+$");
    private static final String PREFS = "styxsports";

    /** What has been resolved for one game. */
    static final class Entry {
        final String eventId;
        StreamResolver.Page page;
        /** server pageUrl -> playable stream (only successes are kept; failures are retried by the player). */
        final Map<String, StreamResolver.Stream> streams = new HashMap<>();
        long at = SystemClock.elapsedRealtime();
        /** A premium pre-warm was attempted (granted or not) - not again within the TTL. */
        boolean premiumTried;

        Entry(String eventId) {
            this.eventId = eventId;
        }

        boolean fresh() {
            return SystemClock.elapsedRealtime() - at < TTL_MS;
        }
    }

    private static final LinkedHashMap<String, Entry> cache = new LinkedHashMap<>();
    /** Two lanes: a slow free-server embed chain must not hold up the premium pass. */
    private static final ExecutorService io = Executors.newFixedThreadPool(2);
    /** The game whose card has focus right now ("" when none); written on the main thread, read by the lanes. */
    private static volatile String wanted = "";
    private static Runnable pendingFree, pendingPremium;
    /** Home holds a pre-warm lease for this game (null when none). Guarded by {@code cache}. */
    private static String prewarmFor;
    /** The game most recently handed to the player; its pool slot is the player's. Guarded by {@code cache}. */
    private static String handedOff = "";

    private Prefetch() {}

    // ---------------------------------------------------------------------------------------------
    // Home
    // ---------------------------------------------------------------------------------------------

    /** A game card gained focus: schedule the free resolve, then the premium pre-warm. */
    static void focus(final Context ctx, final Handler handler, final Event e) {
        blur(handler);
        if (e == null || e.url.isEmpty() || e.ended) return;
        wanted = e.id;
        final Context app = ctx.getApplicationContext();
        pendingFree = () -> io.execute(() -> warm(app, e, false));
        pendingPremium = () -> io.execute(() -> warm(app, e, true));
        handler.postDelayed(pendingFree, FREE_DELAY_MS);
        handler.postDelayed(pendingPremium, PREMIUM_DELAY_MS);
        // Browsing on: a pre-warm taken for another game is given back right away. Back in Home
        // from the player, the slot is free again (the player released it), so a new hand-off
        // for the same game must go through the pool afresh.
        boolean other;
        synchronized (cache) {
            handedOff = "";
            other = prewarmFor != null && !prewarmFor.equals(e.id);
        }
        if (other) releasePrewarm(app);
    }

    /** Focus left the card (or Home is going away): nothing queued runs. */
    static void blur(Handler handler) {
        wanted = "";
        if (pendingFree != null) handler.removeCallbacks(pendingFree);
        if (pendingPremium != null) handler.removeCallbacks(pendingPremium);
        pendingFree = pendingPremium = null;
    }

    /** The player is opening this game: it takes over any pre-warm lease (its acquire converts it). */
    static void handOff(String eventId) {
        synchronized (cache) {
            handedOff = eventId == null ? "" : eventId;
            if (prewarmFor != null && prewarmFor.equals(eventId)) prewarmFor = null;
        }
    }

    /** Gives a pre-warm lease back (Home paused without opening a game, or moved to another game). */
    static void releasePrewarm(Context ctx) {
        synchronized (cache) {
            if (prewarmFor == null) return;
            prewarmFor = null;
        }
        final Context app = ctx.getApplicationContext();
        new Thread(() -> Pool.release(app), "prewarm-release").start();
    }

    // ---------------------------------------------------------------------------------------------
    // Player
    // ---------------------------------------------------------------------------------------------

    /** The game's stream page: pre-fetched when fresh, else read now (and kept). Blocking. */
    static StreamResolver.Page page(Context ctx, StreamResolver resolver, Event e) throws IOException {
        Entry en = fresh(e.id);
        if (en != null && en.page != null) {
            Log.i(TAG, e.id + ": stream page from prefetch");
            return en.page;
        }
        StreamResolver.Page p = fetchPage(ctx, resolver, e.url);
        entry(e.id).page = p;
        return p;
    }

    /** Retry means fresh: what was resolved ahead for this game is dropped (page and streams). */
    static void forget(String eventId) {
        synchronized (cache) {
            cache.remove(eventId);
        }
    }

    /** Streams resolved ahead for this game (empty when none or stale). */
    static Map<String, StreamResolver.Stream> streams(String eventId) {
        synchronized (cache) {
            Entry en = fresh(eventId);
            return en == null ? new HashMap<>() : new HashMap<>(en.streams);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Shared with the player: how a page and a server are read on this network
    // ---------------------------------------------------------------------------------------------

    /** The stream page's server tabs: from the site, or through the web relay when this network refuses it. Blocking. */
    static StreamResolver.Page fetchPage(Context ctx, StreamResolver resolver, String pageUrl) throws IOException {
        if (Relay.active(ctx)) return Relay.page(ctx, pageUrl);
        try {
            return resolver.page(pageUrl);
        } catch (IOException e) {
            if (!Relay.looksBlocked(e)) throw e;
            // The site stopped answering since the schedule loaded (or the schedule came from
            // the launch cache): read the page through the relay instead.
            Log.w(TAG, "stream page: " + e.getMessage() + "; asking the web relay");
            StreamResolver.Page p = Relay.page(ctx, pageUrl);
            Relay.set(ctx, true);
            return p;
        }
    }

    /**
     * One server tab to a playable stream, the way this network allows. Blocking.
     *
     * <ul>
     *   <li>Site blocked here ({@link Relay#active}): the Worker reads the tab and this device
     *       plays the CDN directly when it can, the Worker's proxy when it cannot.</li>
     *   <li>Premium tab without an account of our own: the Worker reads it with the shared
     *       account (this device's pool lease vouches for it).</li>
     *   <li>Otherwise this device resolves it; a premium tab our session gets no player for is
     *       retried through the Worker, and a page host this network refuses sends the whole
     *       tab to the relay.</li>
     * </ul>
     *
     * @param leaseHeld this device holds a pool slot (premium tabs may be read with the shared account)
     */
    static StreamResolver.Stream resolveServer(Context ctx, StreamResolver resolver, StreamResolver.Server s,
                                               StreamResolver.Page page, boolean leaseHeld) throws IOException {
        final boolean viaPool = s.premium && leaseHeld;
        if (Relay.active(ctx)) return Relay.resolve(ctx, s, viaPool);
        // No account here: this session cannot open a premium tab at all, so the Worker reads it
        // with the shared account straight away.
        if (viaPool && !Account.isSignedIn(ctx)) return Pool.resolveShared(ctx, s);
        StreamResolver.Stream st;
        try {
            st = resolver.resolve(s, page);
        } catch (IOException e) {
            if (!Relay.looksBlocked(e)) throw e;
            Log.i(TAG, s.name + ": " + e.getMessage() + "; asking the web relay");
            return Relay.resolve(ctx, s, viaPool);
        }
        // The site does not give every session the same premium player: when ours gets an
        // embed it cannot read, the Worker resolves the tab with the shared account.
        if (viaPool && !st.playableNatively() && !"gate".equals(st.state) && !"warming".equals(st.state)) {
            Log.i(TAG, s.name + ": no player for this session; asking the web player");
            StreamResolver.Stream shared = Pool.resolveShared(ctx, s);
            if (shared.playableNatively() || "warming".equals(shared.state)) st = shared;
        }
        return st;
    }

    /**
     * Can this device play premium tabs at all: its own account unless that is known to lack
     * premium, otherwise an account shared through the pool (played via the Worker).
     */
    static boolean premiumCapable(Context ctx) {
        if (Account.isSignedIn(ctx)) return !Boolean.FALSE.equals(Account.premiumKnown(ctx));
        return Pool.sharedAvailable(ctx);
    }

    // ---------------------------------------------------------------------------------------------

    /** Background: the page, then one server - free, or (premium pass) a named premium tab under a pre-warm lease. */
    private static void warm(Context ctx, Event e, boolean premium) {
        if (!e.id.equals(wanted)) return; // focus moved on before this ran
        try {
            RemoteConfig config = RemoteConfig.load(ctx);
            StreamResolver resolver = new StreamResolver(config.parser);
            StreamResolver.Page p = page(ctx, resolver, e);
            if (!e.id.equals(wanted)) return;
            // Not on yet: the tabs are known, but there is no stream worth a slot or an embed chain.
            if (!e.live) return;
            Entry en = entry(e.id);
            StreamResolver.Server pick = null;
            String preferred = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(e.id, null);
            boolean leaseHeld = false;
            if (!premium) {
                // A device that will start on a premium tab (see NativePlayerActivity.arrangeServers)
                // has nothing to gain from a free resolve, and a slow embed host would only hold
                // up the premium pass behind it.
                if (premiumCapable(ctx)) {
                    for (StreamResolver.Server s : p.servers) if (s.premium && !GENERIC_TAB.matcher(s.name).matches()) return;
                }
                // The server that worked last time, else the page's active tab, else the first free one.
                for (StreamResolver.Server s : p.servers) if (!s.premium && s.pageUrl.equals(preferred)) pick = s;
                if (pick == null) {
                    StreamResolver.Server active = p.servers.get(p.activeIndex);
                    if (!active.premium) pick = active;
                }
                if (pick == null) for (StreamResolver.Server s : p.servers) if (!s.premium) { pick = s; break; }
            } else {
                if (en.premiumTried || !premiumCapable(ctx) || !config.flags(ctx).on("prewarm", true)) return;
                for (StreamResolver.Server s : p.servers) if (s.premium && s.pageUrl.equals(preferred)) pick = s;
                if (pick == null) for (StreamResolver.Server s : p.servers) if (s.premium && !GENERIC_TAB.matcher(s.name).matches()) { pick = s; break; }
                if (pick == null) return;
                en.premiumTried = true;
                Pool.Reply r = Pool.acquire(ctx, "game", e.title(), true);
                if (!r.granted) {
                    Log.i(TAG, e.id + ": no pre-warm (" + (r.ok ? r.used + "/" + r.max : r.error) + ")");
                    return;
                }
                synchronized (cache) {
                    // OK was pressed while the pool answered: the player's acquire owns the slot
                    // now (same id) and is resolving this tab itself. It must not be remembered
                    // as ours - a later release would take it from under the player.
                    if (e.id.equals(handedOff)) {
                        Log.i(TAG, e.id + ": pre-warm answered after the press; the player has it");
                        return;
                    }
                    prewarmFor = e.id;
                }
                leaseHeld = true;
                if (!e.id.equals(wanted)) { // focus moved on while the pool answered
                    releasePrewarm(ctx);
                    return;
                }
            }
            if (pick == null || en.streams.containsKey(pick.pageUrl)) return;
            long t0 = SystemClock.elapsedRealtime();
            StreamResolver.Stream st = resolveServer(ctx, resolver, pick, p, leaseHeld);
            if (st.playableNatively()) {
                synchronized (cache) {
                    en.streams.put(pick.pageUrl, st);
                }
                Log.i(TAG, e.id + ": " + pick.name + (pick.premium ? " (premium)" : "") + " ready in "
                        + (SystemClock.elapsedRealtime() - t0) + " ms via " + StreamResolver.hostOf(st.hlsUrl));
            } else {
                Log.i(TAG, e.id + ": " + pick.name + " not playable ahead (state=" + st.state + ")");
                if (premium) releasePrewarm(ctx); // nothing to hold the slot for (no-op once handed off)
            }
        } catch (Exception ex) {
            Log.w(TAG, e.id + ": prefetch failed: " + ex.getMessage());
        }
    }

    private static Entry fresh(String eventId) {
        synchronized (cache) {
            Entry en = cache.get(eventId);
            if (en == null) return null;
            if (!en.fresh()) {
                cache.remove(eventId);
                return null;
            }
            return en;
        }
    }

    private static Entry entry(String eventId) {
        synchronized (cache) {
            Entry en = cache.get(eventId);
            if (en != null && en.fresh()) return en;
            en = new Entry(eventId);
            cache.put(eventId, en);
            for (Iterator<String> it = cache.keySet().iterator(); cache.size() > MAX_ENTRIES && it.hasNext(); ) {
                it.next();
                it.remove();
            }
            return en;
        }
    }
}
