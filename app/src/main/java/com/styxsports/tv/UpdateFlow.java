package com.styxsports.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import java.io.File;
import java.util.concurrent.ExecutorService;

/** Checks GitHub Releases for a newer build and walks the user through installing it. */
final class UpdateFlow {

    static final int REQ_INSTALL_PERMISSION = 1001;

    /** A TV app is rarely relaunched, so re-check while it sits open (on resume and on the refresh tick). */
    private static final long RECHECK_MS = 30 * 60_000L;
    /** After "Later", leave the viewer alone for this long before offering the same version again. */
    private static final long SNOOZE_MS = 4 * 60 * 60_000L;

    private final Activity activity;
    private final ExecutorService io;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private File pendingInstall;
    private long lastCheckAt;
    private boolean checking;
    /** The dialog on screen, if any: one at a time, and pressing a button on it may open the next. */
    private AlertDialog dialog;
    private String snoozedVersion;
    private long snoozedAt;

    UpdateFlow(Activity activity, ExecutorService io) {
        this.activity = activity;
        this.io = io;
    }

    /**
     * Background check, right now (launch, Refresh button). A newer release is downloaded
     * quietly first, so the card that appears has a single "Install now" step; if the download
     * fails the classic offer (download on request) is shown instead.
     */
    void checkInBackground() {
        check(true);
    }

    /** Background check unless one ran recently; call freely from resume/refresh paths. */
    void checkIfDue() {
        if (System.currentTimeMillis() - lastCheckAt >= RECHECK_MS) check(false);
    }

    private void check(boolean force) {
        if (checking || offering()) return;
        checking = true;
        lastCheckAt = System.currentTimeMillis();
        io.execute(() -> {
            try {
                AppUpdater.Release latest = AppUpdater.fetchLatest();
                if (latest == null
                        || !AppUpdater.isNewer(latest.version, AppUpdater.installedVersion(activity))) {
                    AppUpdater.cleanup(activity);
                    return;
                }
                boolean snoozed = latest.version.equals(snoozedVersion)
                        && System.currentTimeMillis() - snoozedAt < SNOOZE_MS;
                if (snoozed && !force) return;
                File apk;
                try {
                    apk = AppUpdater.downloadIfNeeded(activity, latest);
                } catch (Exception e) {
                    apk = null;
                }
                final File ready = apk;
                handler.post(() -> {
                    if (ready != null) offerReady(latest, ready);
                    else offer(latest);
                });
            } catch (Exception ignored) {
                // Update check is best-effort.
            } finally {
                handler.post(() -> checking = false);
            }
        });
    }

    private boolean offering() {
        return dialog != null && dialog.isShowing();
    }

    private boolean gone() {
        return activity.isFinishing() || activity.isDestroyed();
    }

    /** The APK is already on disk: one button installs it. */
    private void offerReady(AppUpdater.Release release, File apk) {
        if (gone() || offering()) return;
        String message = activity.getString(R.string.update_ready_message,
                release.version, AppUpdater.installedVersion(activity));
        if (!release.notes.isEmpty()) message += "\n\n" + release.notes;

        dialog = new AlertDialog.Builder(activity)
                .setTitle(R.string.update_ready_title)
                .setMessage(message)
                .setPositiveButton(R.string.update_install_now, (d, w) -> install(apk))
                .setNegativeButton(R.string.update_later, (d, w) -> snooze(release))
                .setOnCancelListener(d -> snooze(release))
                .show();
    }

    private void offer(AppUpdater.Release release) {
        if (gone() || offering()) return;
        String message = activity.getString(R.string.update_message,
                release.version, AppUpdater.installedVersion(activity));
        if (!release.notes.isEmpty()) message += "\n\n" + release.notes;

        dialog = new AlertDialog.Builder(activity)
                .setTitle(R.string.update_title)
                .setMessage(message)
                .setPositiveButton(R.string.update_install, (d, w) -> downloadAndInstall(release))
                .setNegativeButton(R.string.update_later, (d, w) -> snooze(release))
                .setOnCancelListener(d -> snooze(release))
                .show();
    }

    private void snooze(AppUpdater.Release release) {
        snoozedVersion = release.version;
        snoozedAt = System.currentTimeMillis();
    }

    private void downloadAndInstall(AppUpdater.Release release) {
        Toast.makeText(activity, R.string.update_downloading, Toast.LENGTH_SHORT).show();
        io.execute(() -> {
            try {
                File apk = AppUpdater.download(activity, release);
                handler.post(() -> install(apk));
            } catch (Exception e) {
                handler.post(() -> Toast.makeText(activity,
                        activity.getString(R.string.update_failed, e.getMessage()),
                        Toast.LENGTH_LONG).show());
            }
        });
    }

    private void install(File apk) {
        if (gone()) return;
        if (!AppUpdater.canInstall(activity)) {
            // One-time: the OS needs "Install unknown apps" enabled for this app. Google TV
            // opens the *list* of apps (focus on some other app) rather than our own toggle, so
            // the viewer is told what to look for before the screen appears - a toast is gone by
            // the time they get there.
            askPermission(apk, false);
            return;
        }
        try {
            activity.startActivity(AppUpdater.installIntent(activity, apk));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, activity.getString(R.string.update_failed, e.getMessage()),
                    Toast.LENGTH_LONG).show();
        }
    }

    /** Reached from a button of the offer dialog (still dismissing) or from the settings round-trip. */
    private void askPermission(File apk, boolean again) {
        if (gone()) return;
        dialog = new AlertDialog.Builder(activity)
                .setTitle(R.string.update_permission_title)
                .setMessage(again ? R.string.update_permission_retry_message : R.string.update_permission_message)
                .setPositiveButton(again ? R.string.update_permission_try_again : R.string.update_permission_open,
                        (d, w) -> openPermissionSettings(apk))
                .setNegativeButton(R.string.update_later, (d, w) -> { })
                .show();
    }

    private void openPermissionSettings(File apk) {
        pendingInstall = apk;
        try {
            activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())), REQ_INSTALL_PERMISSION);
        } catch (ActivityNotFoundException e) {
            pendingInstall = null;
            Toast.makeText(activity, R.string.update_allow_source_manual, Toast.LENGTH_LONG).show();
        }
    }

    /** Forward from {@link Activity#onActivityResult}. */
    void onActivityResult(int requestCode) {
        if (requestCode == REQ_INSTALL_PERMISSION && pendingInstall != null) {
            File apk = pendingInstall;
            pendingInstall = null;
            // Granted: straight on to the installer, no second "Install now". Not granted (the
            // viewer toggled the wrong row, or none): say so and offer the list again.
            if (AppUpdater.canInstall(activity)) install(apk);
            else handler.post(() -> askPermission(apk, true));
        }
    }
}
