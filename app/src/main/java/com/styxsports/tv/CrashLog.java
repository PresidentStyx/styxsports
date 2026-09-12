package com.styxsports.tv;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.webkit.WebView;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Records crashes so they can be shown on the next launch. There is no server side: the report
 * is meant to be read off the TV screen (or photographed) and sent by the user.
 *
 * Two kinds are captured:
 *  - Java exceptions, through the default uncaught-exception handler installed by {@link StyxApp};
 *  - the player screen dying without a Java trace (the WebView's native code taking the whole
 *    process down), detected by a marker set while a stream is open and cleared when the screen
 *    stops normally.
 */
final class CrashLog {
    private static final String PREFS = "styxsports_crash";
    private static final String KEY_TRACE = "trace";
    private static final String KEY_WHEN = "when";
    private static final String KEY_PLAYER_URL = "player_url";
    private static final String KEY_PLAYER_SINCE = "player_since";
    private static final String KEY_PLAYER_DEATHS = "player_deaths";
    private static final int MAX_TRACE = 6000;

    private CrashLog() {}

    static void install(Context ctx) {
        final Context app = ctx.getApplicationContext();
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            try {
                recordJava(app, thread, e);
            } catch (Throwable ignored) {
                // never mask the original crash
            }
            if (previous != null) previous.uncaughtException(thread, e);
        });
    }

    static void recordJava(Context ctx, Thread thread, Throwable e) {
        StringWriter sw = new StringWriter();
        e.printStackTrace(new PrintWriter(sw));
        String trace = "Thread: " + thread.getName() + "\n" + sw;
        if (trace.length() > MAX_TRACE) trace = trace.substring(0, MAX_TRACE) + "\n…";
        prefs(ctx).edit()
                .putString(KEY_TRACE, trace)
                .putLong(KEY_WHEN, System.currentTimeMillis())
                .commit(); // synchronous: the process is about to die
    }

    /** A non-exception failure worth reporting (e.g. the WebView renderer being killed). */
    static void recordNote(Context ctx, String note) {
        prefs(ctx).edit()
                .putString(KEY_TRACE, note)
                .putLong(KEY_WHEN, System.currentTimeMillis())
                .commit();
    }

    static void markPlayerOpen(Context ctx, String url) {
        prefs(ctx).edit()
                .putString(KEY_PLAYER_URL, url)
                .putLong(KEY_PLAYER_SINCE, System.currentTimeMillis())
                .commit();
    }

    /**
     * Full report text if something worth showing was recorded since the last {@link #clear},
     * else null.
     *
     * A Java trace is always shown. A bare "player was open when the process ended" marker is
     * weaker evidence: the user may have force-stopped the app, the OS may have trimmed it in the
     * background, or it was updated. Those are filtered with the OS exit reason where available
     * (API 30+), and the marker alone only counts once it has happened twice in a row.
     */
    static String pendingReport(Context ctx) {
        SharedPreferences p = prefs(ctx);
        String trace = p.getString(KEY_TRACE, null);
        String playerUrl = p.getString(KEY_PLAYER_URL, null);
        if (trace == null && playerUrl == null) return null;

        String exit = lastExitDescription(ctx);
        if (trace == null) {
            if (exit != null && !looksLikeCrash(exit)) {
                // Explained away by the OS: force stop, background trim, update, ...
                clear(ctx);
                return null;
            }
            int deaths = p.getInt(KEY_PLAYER_DEATHS, 0) + 1;
            if (deaths < 2) {
                // First unexplained death: remember it, but don't bother the user yet.
                p.edit().remove(KEY_PLAYER_URL).remove(KEY_PLAYER_SINCE)
                        .putInt(KEY_PLAYER_DEATHS, deaths).commit();
                return null;
            }
        }

        StringBuilder b = new StringBuilder();
        if (trace != null) {
            b.append("Crashed at ").append(time(p.getLong(KEY_WHEN, 0))).append('\n');
        } else {
            b.append("The player screen died without a Java error at ")
                    .append(time(p.getLong(KEY_PLAYER_SINCE, 0)))
                    .append(" — the process was killed from native code or by the system"
                            + " (second time in a row).\n");
        }
        if (exit != null) b.append("OS exit reason: ").append(exit).append('\n');
        if (playerUrl != null) b.append("Stream: ").append(playerUrl).append('\n');
        b.append('\n').append(environment(ctx)).append('\n');
        if (trace != null) b.append('\n').append(trace);
        return b.toString();
    }

    /** The player screen closed normally: the streak of unexplained deaths is over. */
    static void notePlayerClosedNormally(Context ctx) {
        prefs(ctx).edit().remove(KEY_PLAYER_URL).remove(KEY_PLAYER_SINCE)
                .remove(KEY_PLAYER_DEATHS).commit();
    }

    private static boolean looksLikeCrash(String exit) {
        return exit.startsWith("crash") || exit.startsWith("anr") || exit.startsWith("low memory")
                || exit.startsWith("excessive resource") || exit.startsWith("signaled");
    }

    /** Why the previous instance of this process ended, per the OS (API 30+), else null. */
    private static String lastExitDescription(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null;
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(ctx.getPackageName(), 0, 1);
            if (list == null || list.isEmpty()) return null;
            ApplicationExitInfo info = list.get(0);
            String desc = info.getDescription() == null ? "" : " (" + info.getDescription() + ")";
            switch (info.getReason()) {
                case ApplicationExitInfo.REASON_CRASH: return "crash" + desc;
                case ApplicationExitInfo.REASON_CRASH_NATIVE: return "crash (native)" + desc;
                case ApplicationExitInfo.REASON_ANR: return "anr" + desc;
                case ApplicationExitInfo.REASON_LOW_MEMORY: return "low memory" + desc;
                case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "excessive resource usage" + desc;
                case ApplicationExitInfo.REASON_SIGNALED: return "signaled " + info.getStatus() + desc;
                case ApplicationExitInfo.REASON_USER_REQUESTED: return "force stopped by user" + desc;
                case ApplicationExitInfo.REASON_USER_STOPPED: return "user stopped" + desc;
                case ApplicationExitInfo.REASON_PERMISSION_CHANGE: return "permission change" + desc;
                case ApplicationExitInfo.REASON_PACKAGE_UPDATED: return "app updated" + desc;
                case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "initialization failure" + desc;
                case ApplicationExitInfo.REASON_DEPENDENCY_DIED: return "dependency died" + desc;
                case ApplicationExitInfo.REASON_EXIT_SELF: return "exited itself" + desc;
                case ApplicationExitInfo.REASON_OTHER: return "other" + desc;
                default: return "unknown" + desc;
            }
        } catch (Throwable t) {
            return null;
        }
    }

    static void clear(Context ctx) {
        prefs(ctx).edit().clear().commit();
    }

    static String environment(Context ctx) {
        String abi = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "?";
        return "App " + AppUpdater.installedVersion(ctx)
                + " · Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")\n"
                + Build.MANUFACTURER + " " + Build.MODEL + " · " + abi + "\n"
                + "WebView " + webViewVersion(ctx);
    }

    private static String webViewVersion(Context ctx) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PackageInfo pi = WebView.getCurrentWebViewPackage();
                if (pi != null) return pi.packageName + " " + pi.versionName;
            }
            PackageManager pm = ctx.getPackageManager();
            for (String pkg : new String[] {"com.google.android.webview", "com.android.webview",
                    "com.amazon.webview.chromium", "com.android.chrome"}) {
                try {
                    return pkg + " " + pm.getPackageInfo(pkg, 0).versionName;
                } catch (PackageManager.NameNotFoundException ignored) {
                    // try the next one
                }
            }
        } catch (Throwable ignored) {
            // fall through
        }
        return "unknown";
    }

    private static String time(long ms) {
        if (ms <= 0) return "?";
        return new SimpleDateFormat("MMM d, h:mm:ss a", Locale.US).format(new Date(ms));
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
