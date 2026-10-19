package com.styxsports.tv;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.CopyOnWriteArrayList;

import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Cast from the phone (web/src/cast.js). While any screen of the app is showing, one WebSocket
 * stays open to the Worker; a paired phone's "open" command closes whatever is playing and opens
 * that game through Home ({@link HomeActivity#EXTRA_CAST_EVENT}). Pairing: {@link #pairCode} gets
 * the 6-digit code Home shows, and {@link Listener#onPaired} fires when a phone enters it.
 * Remote flag "cast" (default on).
 */
final class Cast {

    private static final String TAG = "StyxCast";
    private static final String WS_URL = Pool.WEB.replaceFirst("^http", "ws") + "/api/cast/ws";
    private static final long PING_MS = 30_000L;
    private static final long MAX_BACKOFF_MS = 60_000L;

    interface Listener {
        void onPaired(String phoneName);
    }

    private static final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<>();
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static Application app;
    private static int started;
    private static WebSocket socket;
    private static long backoffMs = 2_000L;

    private Cast() {}

    static void install(Application a) {
        app = a;
        a.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityStarted(Activity act) {
                if (started++ == 0) connectSoon(0);
            }
            @Override public void onActivityStopped(Activity act) {
                if (--started == 0) disconnect();
            }
            @Override public void onActivityCreated(Activity act, Bundle b) {}
            @Override public void onActivityResumed(Activity act) {}
            @Override public void onActivityPaused(Activity act) {}
            @Override public void onActivitySaveInstanceState(Activity act, Bundle b) {}
            @Override public void onActivityDestroyed(Activity act) {}
        });
    }

    static boolean enabled(Context ctx) {
        return RemoteConfig.load(ctx).flags(ctx).on("cast", true);
    }

    static void addListener(Listener l) { listeners.add(l); }
    static void removeListener(Listener l) { listeners.remove(l); }

    /** A fresh pairing code for this TV ({"code": "123456", "expiresInS": 600}). Blocking. */
    static JSONObject pairCode(Context ctx) throws IOException {
        Presence.announce(ctx); // the Worker only answers TVs it has heard from
        try {
            return new JSONObject(Http.postJson(Pool.WEB + "/api/cast/pair", "{}"));
        } catch (org.json.JSONException e) {
            throw new IOException("bad answer from the Styx server");
        }
    }

    // ---------------------------------------------------------------------------------------------

    private static final Runnable ping = new Runnable() {
        @Override public void run() {
            WebSocket ws = socket;
            if (ws != null) ws.send("ping");
            main.postDelayed(this, PING_MS);
        }
    };

    private static void connectSoon(long delayMs) {
        main.postDelayed(() -> {
            if (started == 0 || socket != null || app == null) return;
            new Thread(Cast::connect, "cast").start();
        }, delayMs);
    }

    private static void connect() {
        if (!enabled(app)) return;
        Presence.announce(app);
        Request req = new Request.Builder().url(WS_URL)
                .header("X-Styx-Device", Presence.id(app))
                .header("User-Agent", Http.DESKTOP_UA)
                .build();
        WebSocket ws = Http.workerClient().newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket w, Response r) {
                Log.i(TAG, "listening for the phone");
                backoffMs = 2_000L;
                main.removeCallbacks(ping);
                main.postDelayed(ping, PING_MS);
            }

            @Override public void onMessage(WebSocket w, String text) {
                if ("pong".equals(text)) return;
                main.post(() -> handle(text));
            }

            @Override public void onFailure(WebSocket w, Throwable t, Response r) {
                Log.w(TAG, "connection failed: " + t.getMessage() + (r != null ? " (HTTP " + r.code() + ")" : ""));
                main.post(() -> dropped(w));
            }

            @Override public void onClosed(WebSocket w, int code, String reason) {
                main.post(() -> dropped(w));
            }
        });
        main.post(() -> {
            if (started == 0) ws.close(1000, "background");
            else socket = ws;
        });
    }

    private static void dropped(WebSocket w) {
        if (socket != w && socket != null) return;
        socket = null;
        main.removeCallbacks(ping);
        if (started > 0) {
            long wait = backoffMs;
            backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
            connectSoon(wait);
        }
    }

    private static void disconnect() {
        main.removeCallbacks(ping);
        WebSocket ws = socket;
        socket = null;
        if (ws != null) ws.close(1000, "background");
    }

    private static void handle(String text) {
        JSONObject o;
        try {
            o = new JSONObject(text);
        } catch (Exception e) {
            return;
        }
        String cmd = o.optString("cmd", "");
        String from = o.optString("from", "");
        if ("paired".equals(cmd)) {
            for (Listener l : listeners) l.onPaired(from);
            if (listeners.isEmpty()) Toast.makeText(app, app.getString(R.string.cast_paired, nameOr(from)), Toast.LENGTH_LONG).show();
        } else if ("open".equals(cmd)) {
            JSONObject ev = o.optJSONObject("event");
            Event e = ev == null ? null : Relay.eventFrom(ev);
            if (e == null) return;
            Log.i(TAG, "open " + e.id + " from " + from);
            Toast.makeText(app, app.getString(R.string.cast_opening, e.title(), nameOr(from)), Toast.LENGTH_LONG).show();
            Intent i = new Intent(app, HomeActivity.class)
                    .putExtra(HomeActivity.EXTRA_CAST_EVENT, ev.toString())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            app.startActivity(i);
        }
    }

    private static String nameOr(String from) {
        return from == null || from.isEmpty() ? app.getString(R.string.cast_a_phone) : from;
    }
}
