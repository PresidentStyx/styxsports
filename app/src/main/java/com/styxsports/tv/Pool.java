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
            // Signed in here: the lease is on this device's own account. It only takes a shared
            // slot when that account is one of the shared ones, which the Worker tells from the
            // playlist URL's fingerprint (never the URL itself).
            if (Account.isSignedIn(ctx)) {
                body.put("own", true);
                String fp = fingerprint(Account.playlistUrl(ctx));
                if (fp != null) body.put("acct", fp);
            }
        } catch (Exception ignored) {
            // JSONObject.put only throws for NaN / null keys
        }
        return call(ctx, "/acquire", body);
    }

    /** First 8 bytes of SHA-256 as hex, like the Worker's fingerprint(); null without a URL. */
    static String fingerprint(String iptvUrl) {
        if (iptvUrl == null || iptvUrl.trim().isEmpty()) return null;
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(iptvUrl.trim().getBytes("UTF-8"));
            StringBuilder b = new StringBuilder(16);
            for (int i = 0; i < 8; i++) b.append(String.format(java.util.Locale.ROOT, "%02x", d[i] & 0xff));
            return b.toString();
        } catch (Exception e) {
            return null;
        }
    }

    static Reply heartbeat(Context ctx, String label) {
        JSONObject body = new JSONObject();
        try {
            body.put("id", Presence.id(ctx));
            if (label != null && !label.isEmpty()) body.put("label", clip(label));
        } catch (Exception ignored) {
            // see above
        }
        return call(ctx, "/heartbeat", body);
    }

    static Reply release(Context ctx) {
        JSONObject body = new JSONObject();
        try {
            body.put("id", Presence.id(ctx));
        } catch (Exception ignored) {
            // see above
        }
        return call(ctx, "/release", body);
    }

    private static String clip(String s) {
        if (s == null) return "";
        return s.length() > 80 ? s.substring(0, 80) : s;
    }

    // ---------------------------------------------------------------------------------------------
    // The shared accounts themselves (never their cookies). A device with no sign-in of its own
    // plays the premium tabs and Live TV through the Worker while it holds a lease: the Worker
    // reads the site with a shared session and hands back the playlist URL, which this device
    // then plays from its own IP. What is shared is refreshed with every presence ping and kept
    // in prefs so the home screen and player can decide synchronously.
    // ---------------------------------------------------------------------------------------------

    private static final String PREFS = "styxsports";
    private static final String KEY_SHARED = "pool_shared";
    private static final String KEY_SHARED_IPTV = "pool_iptv";
    private static final String KEY_SHARED_PREMIUM = "pool_premium"; // "yes" / "no" / ""

    /** GET /api/pool/info into prefs. Blocking; failures keep the last answer. */
    static void refreshInfo(Context ctx) {
        try {
            noteInfo(ctx, new JSONObject(Http.getText(BASE + "/info", null, 8_000)));
        } catch (Exception e) {
            Log.w(TAG, "/info failed: " + e.getMessage());
        }
    }

    /** Folds the shared-account facts out of an /info or /acquire reply. */
    static void noteInfo(Context ctx, JSONObject o) {
        if (o == null || !o.has("shared")) return;
        android.content.SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        e.putBoolean(KEY_SHARED, o.optBoolean("shared", false));
        e.putBoolean(KEY_SHARED_IPTV, o.optBoolean("sharedIptv", false));
        String p = o.isNull("sharedPremium") ? "" : o.optBoolean("sharedPremium", false) ? "yes" : "no";
        e.putString(KEY_SHARED_PREMIUM, p);
        e.apply();
    }

    /** Someone shared an account and this device has none of its own: premium comes from the pool. */
    static boolean sharedAvailable(Context ctx) {
        if (Account.isSignedIn(ctx)) return false;
        android.content.SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return p.getBoolean(KEY_SHARED, false) && !"no".equals(p.getString(KEY_SHARED_PREMIUM, ""));
    }

    /** A shared account has a Live TV playlist and this device has no account of its own. */
    static boolean sharedIptv(Context ctx) {
        if (Account.isSignedIn(ctx)) return false;
        android.content.SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return p.getBoolean(KEY_SHARED, false) && p.getBoolean(KEY_SHARED_IPTV, false);
    }

    /**
     * The shared account's channel list through the Worker (this device's lease vouches for the
     * call), rebuilt as M3U text so {@link Iptv#parse} and the disk cache treat it like the
     * account's own playlist. Blocking.
     */
    static String fetchIptvM3u(Context ctx) throws java.io.IOException {
        String body;
        try {
            body = Http.getText(WEB + "/api/iptv?slot=" + Uri.encode(Presence.id(ctx)), null, 90_000);
        } catch (java.io.IOException e) {
            String m = e.getMessage() == null ? "" : e.getMessage();
            if (m.contains("403")) throw new java.io.IOException("no pool slot");
            if (m.contains("401")) throw new java.io.IOException("the pool lease was not accepted");
            throw e;
        }
        JSONObject o;
        try {
            o = new JSONObject(body);
        } catch (Exception e) {
            throw new java.io.IOException("bad channel list");
        }
        if (o.has("error")) throw new java.io.IOException(o.optString("error"));
        org.json.JSONArray groups = o.optJSONArray("groups");
        if (groups == null) throw new java.io.IOException("bad channel list");
        StringBuilder m3u = new StringBuilder("#EXTM3U\n");
        for (int i = 0; i < groups.length(); i++) {
            JSONObject g = groups.optJSONObject(i);
            if (g == null) continue;
            String gn = g.optString("n", "Other").replace('"', '\'');
            org.json.JSONArray cs = g.optJSONArray("c");
            if (cs == null) continue;
            for (int j = 0; j < cs.length(); j++) {
                JSONObject c = cs.optJSONObject(j);
                if (c == null) continue;
                String u = c.optString("u", "");
                if (!u.startsWith("http")) continue;
                String logo = c.optString("l", "").replace('"', '\'');
                m3u.append("#EXTINF:-1 tvg-logo=\"").append(logo).append("\" group-title=\"").append(gn).append("\",")
                        .append(c.optString("n", "Channel").replace('\n', ' ')).append('\n').append(u).append('\n');
            }
        }
        return m3u.toString();
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
        return Relay.resolve(ctx, server, true);
    }

    private static Reply call(Context ctx, String path, JSONObject body) {
        Reply r = new Reply();
        try {
            JSONObject o = new JSONObject(Http.postJson(BASE + path, body.toString()));
            noteInfo(ctx, o); // acquire / heartbeat replies carry the shared-account facts too
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
