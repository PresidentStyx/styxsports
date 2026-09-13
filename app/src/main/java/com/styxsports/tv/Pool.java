package com.styxsports.tv;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;

/**
 * The shared premium account's connection pool (sports.styxam.com/api/pool, see web/src/pool.js).
 *
 * <p>The site caps a premium account at 5 simultaneous connections and one account is lent to
 * every viewer across web, APK and Roku. Before this device uses a premium server or opens Live
 * TV it takes a lease on one of the slots; the lease is renewed every 20 s while something plays
 * and dropped when playback stops (a missed one expires after 45 s). Free streams never need one.
 * The Worker never hands out the account's cookies: the device keeps using its own signed-in
 * session for the site; the pool only keeps the total under 5.
 *
 * <p>{@link Lease} is the per-screen state machine (acquire, heartbeat, release) on the UI thread;
 * the static calls block and belong on a worker thread.
 */
final class Pool {

    private static final String TAG = "StyxPool";
    static final String WEB = "https://sports.styxam.com";
    static final String BASE = WEB + "/api/pool";
    static final long HEARTBEAT_MS = 20_000L;

    private Pool() {}

    static final class Reply {
        /** The pool answered (granted may still be false); false means it was unreachable. */
        boolean ok;
        boolean granted;
        int used;
        int max = 5;
        String error = "";
    }

    interface Callback {
        void done(Reply r);
    }

    /** kind: "game" | "tv"; label: game title or channel name (shown on /stats). */
    static Reply acquire(Context ctx, String kind, String label) {
        JSONObject body = new JSONObject();
        try {
            body.put("id", Presence.id(ctx));
            body.put("kind", kind);
            body.put("label", clip(label));
            body.put("platform", "apk");
        } catch (Exception ignored) {
            // JSONObject.put only throws for NaN / null keys
        }
        return call("/acquire", body);
    }

    static Reply heartbeat(Context ctx, String label) {
        JSONObject body = new JSONObject();
        try {
            body.put("id", Presence.id(ctx));
            if (label != null && !label.isEmpty()) body.put("label", clip(label));
        } catch (Exception ignored) {
            // see above
        }
        return call("/heartbeat", body);
    }

    static Reply release(Context ctx) {
        JSONObject body = new JSONObject();
        try {
            body.put("id", Presence.id(ctx));
        } catch (Exception ignored) {
            // see above
        }
        return call("/release", body);
    }

    private static String clip(String s) {
        if (s == null) return "";
        return s.length() > 80 ? s.substring(0, 80) : s;
    }

    /**
     * Resolves a premium tab through the Worker, which reads the page with the shared account
     * and answers with the playlist URL (never the cookies); this device's lease id vouches for
     * the call. Used when this device's own session gets no player for the tab - the site does
     * not hand every session the same premium player. Blocking; never throws.
     *
     * @return a stream (hlsUrl null with state "warming" / "gate" / "" when there is nothing to play)
     */
    static StreamResolver.Stream resolveShared(Context ctx, StreamResolver.Server server) {
        String origin = StreamResolver.originOf(server.pageUrl);
        try {
            String q = "?server=" + Uri.encode(server.pageUrl) + "&name=" + Uri.encode(server.name)
                    + "&premium=1&slot=" + Uri.encode(Presence.id(ctx));
            JSONObject o = new JSONObject(Http.getText(WEB + "/api/stream" + q, null, 30_000));
            JSONObject s = o.optJSONObject("stream");
            if (s == null) {
                Log.w(TAG, server.name + " via web: " + o.optString("error", "no stream"));
                return new StreamResolver.Stream(server, null, origin, null, "");
            }
            String state = s.optString("state", "");
            if (s.optBoolean("warming", false)) {
                Log.i(TAG, server.name + " via web: warming");
                return new StreamResolver.Stream(server, null, origin, null, "warming");
            }
            String direct = s.isNull("direct") ? "" : s.optString("direct", "");
            String proxy = s.isNull("hls") ? "" : s.optString("hls", "");
            String url = !direct.isEmpty() ? direct : !proxy.isEmpty() ? WEB + proxy : null;
            Log.i(TAG, server.name + " via web: state=" + state + " cdn=" + s.optString("cdn", "-")
                    + (url == null ? " (nothing to play)" : direct.isEmpty() ? " (proxied)" : " (direct)"));
            if (url == null) return new StreamResolver.Stream(server, null, origin, null, state);
            // Like every playlist: one look from here for the redirect target and warming.ts.
            StreamResolver.PlaylistCheck c = StreamResolver.checkPlaylist(url, origin + "/");
            if (c.ok && c.warming) return new StreamResolver.Stream(server, null, origin, null, "warming");
            if (!c.ok && c.code >= 400) return new StreamResolver.Stream(server, null, origin, null, "cdn " + c.code);
            return new StreamResolver.Stream(server, c.ok ? c.url : url, origin, null, state);
        } catch (Exception e) {
            Log.w(TAG, server.name + " via web failed: " + e.getMessage());
            return new StreamResolver.Stream(server, null, origin, null, "");
        }
    }

    private static Reply call(String path, JSONObject body) {
        Reply r = new Reply();
        try {
            JSONObject o = new JSONObject(Http.postJson(BASE + path, body.toString()));
            r.ok = true;
            r.granted = o.optBoolean("granted", false);
            r.used = o.optInt("used", 0);
            int max = o.optInt("max", 0);
            if (max > 0) r.max = max;
            r.error = o.optString("error", "");
            Log.i(TAG, path + " -> granted=" + r.granted + " " + r.used + "/" + r.max);
        } catch (Exception e) {
            r.error = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            Log.w(TAG, path + " failed: " + r.error);
        }
        return r;
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * One screen's slot: {@link #acquire} before a premium resolve or Live TV, {@link #release}
     * when playback stops. Heartbeats run on {@code handler} while the lease is held; a heartbeat
     * answered {@code granted: false} means the lease expired (the stream keeps playing, the next
     * premium pick re-acquires).
     */
    static final class Lease {
        private final Context ctx;
        private final ExecutorService io;
        private final Handler handler;
        private boolean held;
        private String label = "";
        private final Runnable beat = new Runnable() {
            @Override
            public void run() {
                if (!held) return;
                final String l = label;
                submit(() -> {
                    Reply r = Pool.heartbeat(ctx, l);
                    handler.post(() -> {
                        if (held && r.ok && !r.granted) {
                            Log.w(TAG, "lease lost");
                            held = false;
                            handler.removeCallbacks(beat);
                        }
                    });
                });
                handler.postDelayed(this, HEARTBEAT_MS);
            }
        };

        Lease(Context ctx, ExecutorService io, Handler handler) {
            this.ctx = ctx.getApplicationContext();
            this.io = io;
            this.handler = handler;
        }

        boolean held() {
            return held;
        }

        /** Takes (or renews) the slot; the callback runs on the handler's thread. */
        void acquire(String kind, String label, Callback cb) {
            this.label = label == null ? "" : label;
            final String l = this.label;
            submit(() -> {
                Reply r = Pool.acquire(ctx, kind, l);
                handler.post(() -> {
                    held = r.granted;
                    handler.removeCallbacks(beat);
                    if (held) handler.postDelayed(beat, HEARTBEAT_MS);
                    cb.done(r);
                });
            });
        }

        /** What /stats shows for this slot (the channel being watched, say); sent right away. */
        void setLabel(String label) {
            String l = label == null ? "" : label;
            if (l.equals(this.label)) return;
            this.label = l;
            if (held) {
                handler.removeCallbacks(beat);
                handler.post(beat);
            }
        }

        /** Stops heartbeats; the slot is given back unless {@code keep} (another screen takes over). */
        void stop(boolean keep) {
            handler.removeCallbacks(beat);
            if (!held) return;
            held = false;
            // Own thread: the screen's executor is usually shutting down right after this.
            if (!keep) new Thread(() -> Pool.release(ctx), "pool-release").start();
        }

        void release() {
            stop(false);
        }

        private void submit(Runnable r) {
            try {
                io.execute(r);
            } catch (RejectedExecutionException e) {
                // the screen is shutting down; the lease expires on its own
            }
        }
    }
}
