package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Anonymous playback telemetry for the Worker's /api/telemetry (web/src/telemetry.js): what
 * started and how fast, what stalled, what was switched away from and why, what failed, how
 * long it was watched, and which version this install moved to. Keyed by the same install id
 * as /api/ping; no account, no titles beyond the site's game id and server name.
 *
 * Events queue in memory and post every minute and when the player closes. Off unless the
 * `telemetry` flag in config.json is on for this device (see {@link Flags}). Never throws.
 */
final class Telemetry {
    private static final String TAG = "Telemetry";
    static final String URL = Pool.WEB + "/api/telemetry";
    private static final long FLUSH_MS = 60_000L;
    private static final int MAX_QUEUE = 200;
    private static final String PREFS = "styxsports";
    private static final String KEY_LAST_VERSION = "telemetry_last_version";

    private static final List<JSONObject> queue = new ArrayList<>();
    private static final Handler handler = new Handler(Looper.getMainLooper());
    private static boolean scheduled;
    private static Context app;

    private Telemetry() {}

    /** One playback attempt's identity, stamped on every event it produces. */
    static final class Attempt {
        final String game, server, cdn;
        final boolean premium, relay;
        /** When the viewer asked for this stream (the press, or the Left/Right switch); ttff counts from here. */
        long startedAt = SystemClock.elapsedRealtime();
        /** The stream was resolved before the press (Prefetch): its start is reported as "pre". */
        boolean pre;
        long firstFrameAt, stallAt;

        Attempt(String game, String server, String cdn, boolean premium, boolean relay) {
            this.game = game == null ? "" : game;
            this.server = server == null ? "" : server;
            this.cdn = cdn == null ? "" : cdn;
            this.premium = premium;
            this.relay = relay;
        }

        boolean started() {
            return firstFrameAt > 0;
        }
    }

    private static boolean enabledCache;
    private static long enabledCheckedAt;

    /**
     * The `telemetry` flag, re-read from the cached config.json at most every 5 minutes. On unless
     * config.json says {@code "telemetry": false} (same default as the web player), so a missing or
     * unreachable config never blinds /stats.
     */
    static boolean enabled(Context ctx) {
        long now = SystemClock.elapsedRealtime();
        if (enabledCheckedAt != 0 && now - enabledCheckedAt < 5 * 60_000L) return enabledCache;
        try {
            enabledCache = RemoteConfig.load(ctx).flags(ctx).on("telemetry", true);
        } catch (Throwable t) {
            enabledCache = true;
        }
        enabledCheckedAt = now;
        return enabledCache;
    }

    /** First frame: time to first frame from the attempt's start. */
    static void start(Context ctx, Attempt a) {
        a.firstFrameAt = SystemClock.elapsedRealtime();
        a.stallAt = 0;
        Json ev = stamp(a, "start").put("game", a.game).put("server", a.server).put("ttff", a.firstFrameAt - a.startedAt);
        if (a.pre) ev.put("pre", true);
        push(ctx, ev);
    }

    /** Buffering began after the first frame. */
    static void stallBegan(Attempt a) {
        if (a.started() && a.stallAt == 0) a.stallAt = SystemClock.elapsedRealtime();
    }

    /** Playback resumed after a stall. */
    static void stallEnded(Context ctx, Attempt a, long positionMs) {
        if (a.stallAt == 0) return;
        long d = SystemClock.elapsedRealtime() - a.stallAt;
        a.stallAt = 0;
        push(ctx, stamp(a, "stall").put("duration", d).put("position", Math.max(0, positionMs)));
    }

    static void error(Context ctx, Attempt a, String code) {
        push(ctx, stamp(a, "error").put("code", code));
    }

    static void switched(Context ctx, String from, String to, String reason) {
        push(ctx, new Json().put("kind", "switch").put("from", from).put("to", to).put("reason", reason));
    }

    /** The attempt is over; records how long it was watched (nothing if it never showed a frame). */
    static void stop(Context ctx, Attempt a) {
        if (a == null || !a.started()) return;
        long watched = SystemClock.elapsedRealtime() - a.firstFrameAt;
        a.firstFrameAt = 0;
        push(ctx, stamp(a, "stop").put("duration", watched));
    }

    /** Called at launch: an install that came up on a new version reports the update. */
    static void noteLaunch(Context ctx) {
        try {
            app = ctx.getApplicationContext();
            SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String now = AppUpdater.installedVersion(ctx);
            String last = p.getString(KEY_LAST_VERSION, "");
            if (!now.equals(last)) {
                p.edit().putString(KEY_LAST_VERSION, now).apply();
                if (!last.isEmpty()) push(ctx, new Json().put("kind", "update").put("from", last).put("to", now).put("outcome", "installed"));
            }
        } catch (Throwable ignored) {
            // best effort
        }
    }

    private static Json stamp(Attempt a, String kind) {
        return new Json().put("kind", kind).put("cdn", a.cdn).put("premium", a.premium).put("relay", a.relay);
    }

    private static void push(Context ctx, Json j) {
        if (ctx == null) return;
        app = ctx.getApplicationContext();
        if (!enabled(app)) return;
        j.put("at", System.currentTimeMillis());
        synchronized (queue) {
            if (queue.size() >= MAX_QUEUE) queue.remove(0);
            queue.add(j.o);
        }
        schedule();
    }

    private static void schedule() {
        if (scheduled) return;
        scheduled = true;
        handler.postDelayed(() -> { scheduled = false; flush(); }, FLUSH_MS);
    }

    /** Posts everything queued on a background thread. Safe to call from any thread. */
    static void flush() {
        final List<JSONObject> batch;
        synchronized (queue) {
            if (queue.isEmpty() || app == null) return;
            batch = new ArrayList<>(queue.subList(0, Math.min(queue.size(), 50)));
            queue.subList(0, batch.size()).clear();
        }
        final Context ctx = app;
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("device", Presence.id(ctx));
                body.put("platform", "apk");
                body.put("version", AppUpdater.installedVersion(ctx));
                body.put("network", Relay.active(ctx) ? "relay" : "direct");
                body.put("events", new JSONArray(batch));
                Http.postJson(URL, body.toString());
            } catch (Throwable t) {
                Log.i(TAG, "dropped " + batch.size() + " events: " + t);
            }
        }, "telemetry").start();
        synchronized (queue) {
            if (!queue.isEmpty()) schedule();
        }
    }

    /** JSONObject without checked exceptions in the way. */
    private static final class Json {
        final JSONObject o = new JSONObject();

        Json put(String k, Object v) {
            try { o.put(k, v); } catch (JSONException ignored) { /* never for these types */ }
            return this;
        }
    }
}
