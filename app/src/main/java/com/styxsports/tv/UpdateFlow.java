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

    private final Activity activity;
    private final ExecutorService io;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private File pendingInstall;

    UpdateFlow(Activity activity, ExecutorService io) {
        this.activity = activity;
        this.io = io;
    }

    /** Background check; shows the offer dialog on the main thread if a newer release exists. */
    void checkInBackground() {
        io.execute(() -> {
            try {
                AppUpdater.Release latest = AppUpdater.fetchLatest();
                if (latest != null
                        && AppUpdater.isNewer(latest.version, AppUpdater.installedVersion(activity))) {
                    handler.post(() -> offer(latest));
                }
            } catch (Exception ignored) {
                // Update check is best-effort.
            }
        });
    }

    private boolean gone() {
        return activity.isFinishing() || activity.isDestroyed();
    }

    private void offer(AppUpdater.Release release) {
        if (gone()) return;
        String message = activity.getString(R.string.update_message,
                release.version, AppUpdater.installedVersion(activity));
        if (!release.notes.isEmpty()) message += "\n\n" + release.notes;

        new AlertDialog.Builder(activity)
                .setTitle(R.string.update_title)
                .setMessage(message)
                .setPositiveButton(R.string.update_install, (d, w) -> downloadAndInstall(release))
                .setNegativeButton(R.string.update_later, null)
                .show();
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
            // One-time: the OS needs "Install unknown apps" enabled for this app.
            pendingInstall = apk;
            Toast.makeText(activity, R.string.update_allow_source, Toast.LENGTH_LONG).show();
            try {
                activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName())), REQ_INSTALL_PERMISSION);
            } catch (ActivityNotFoundException e) {
                Toast.makeText(activity, R.string.update_allow_source_manual, Toast.LENGTH_LONG).show();
            }
            return;
        }
        try {
            activity.startActivity(AppUpdater.installIntent(activity, apk));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, activity.getString(R.string.update_failed, e.getMessage()),
                    Toast.LENGTH_LONG).show();
        }
    }

    /** Forward from {@link Activity#onActivityResult}. */
    void onActivityResult(int requestCode) {
        if (requestCode == REQ_INSTALL_PERMISSION && pendingInstall != null) {
            File apk = pendingInstall;
            pendingInstall = null;
            if (AppUpdater.canInstall(activity)) install(apk);
        }
    }
}
