package com.styxsports.tv;

import android.app.Activity;
import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import java.util.UUID;

/**
 * Anonymous "I'm open" ping so the web Worker can show how many TVs are watching.
 * One random id per install; no account, no watch history. Failures are ignored.
 */
final class Presence {

    static final String URL = "https://sports.styxam.com/api/ping";
    private static final String PREFS = "styxsports";
    private static final String KEY_ID = "presence_id";
    private static final long INTERVAL_MS = 60_000;

    private Presence() {}

    static void install(Application app) {
        app.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            private int started;
            private final Handler handler = new Handler(Looper.getMainLooper());
            private final Runnable tick = new Runnable() {
                @Override public void run() {
                    send(app);
                    handler.postDelayed(this, INTERVAL_MS);
                }
            };

            @Override public void onActivityCreated(Activity a, Bundle s) {}

            @Override public void onActivityStarted(Activity a) {
                if (started++ == 0) {
                    send(app);
                    handler.postDelayed(tick, INTERVAL_MS);
                }
            }

            @Override public void onActivityResumed(Activity a) {}

            @Override public void onActivityPaused(Activity a) {}

            @Override public void onActivityStopped(Activity a) {
                if (--started == 0) handler.removeCallbacks(tick);
            }

            @Override public void onActivitySaveInstanceState(Activity a, Bundle o) {}

            @Override public void onActivityDestroyed(Activity a) {}
        });
    }

    private static void send(Context ctx) {
        final String id = id(ctx);
        final String device = deviceName(ctx);
        new Thread(() -> {
            try {
                Http.postJson(URL, "{\"id\":\"" + id + "\",\"platform\":\"apk\",\"device\":\"" + jsonEscape(device) + "\"}");
            } catch (Throwable ignored) {
                // presence is best-effort; never surface to the viewer
            }
        }, "presence").start();
    }

    /**
     * What this device is called on the stats page: the name the owner gave it in Android
     * settings ("Living Room TV") when there is one, then make and model ("Google Chromecast",
     * "Amazon AFTKA"). Never null.
     */
    static String deviceName(Context ctx) {
        String model = (android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL).trim();
        if (android.os.Build.MODEL != null && android.os.Build.MANUFACTURER != null
                && android.os.Build.MODEL.toLowerCase(java.util.Locale.ROOT).startsWith(android.os.Build.MANUFACTURER.toLowerCase(java.util.Locale.ROOT))) {
            model = android.os.Build.MODEL;
        }
        if (model.length() > 1) model = Character.toUpperCase(model.charAt(0)) + model.substring(1);
        String given = null;
        try {
            given = android.provider.Settings.Global.getString(ctx.getContentResolver(), "device_name");
        } catch (Throwable ignored) {
            // some builds hide it; the model is enough
        }
        if (given == null || given.trim().isEmpty() || given.trim().equalsIgnoreCase(model)) return model;
        return given.trim() + " · " + model;
    }

    private static String jsonEscape(String s) {
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c < 0x20) b.append(' ');
            else b.append(c);
        }
        return b.toString();
    }

    /** The install's random id; also the lease id for the shared premium pool ({@link Pool}). */
    static String id(Context ctx) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String id = p.getString(KEY_ID, "");
        if (id == null || id.length() < 8) {
            id = UUID.randomUUID().toString();
            p.edit().putString(KEY_ID, id).apply();
        }
        return id;
    }
}
