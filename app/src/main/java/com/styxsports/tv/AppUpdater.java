package com.styxsports.tv;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;

/**
 * Checks GitHub Releases for a newer build and hands the downloaded APK to the system installer.
 * Sideloaded apps cannot self-install silently, so the user still confirms one "Install" dialog.
 */
final class AppUpdater {

    static final String LATEST_RELEASE_API =
            "https://api.github.com/repos/PresidentStyx/styxsports/releases/latest";
    static final String ASSET_NAME = "StyxSports.apk";
    private static final long MAX_APK_BYTES = 50L * 1024 * 1024;

    static final class Release {
        final String version;
        final String apkUrl;
        final String notes;

        Release(String version, String apkUrl, String notes) {
            this.version = version;
            this.apkUrl = apkUrl;
            this.notes = notes;
        }
    }

    private AppUpdater() {}

    /** @return the latest release, or null if it has no {@link #ASSET_NAME} asset. */
    static Release fetchLatest() throws IOException, JSONException {
        JSONObject o = new JSONObject(Http.getText(LATEST_RELEASE_API));
        String tag = o.optString("tag_name", "");
        JSONArray assets = o.optJSONArray("assets");
        if (tag.isEmpty() || assets == null) return null;

        for (int i = 0; i < assets.length(); i++) {
            JSONObject a = assets.getJSONObject(i);
            if (ASSET_NAME.equals(a.optString("name"))) {
                String url = a.optString("browser_download_url", "");
                if (url.isEmpty()) return null;
                return new Release(normalize(tag), url, o.optString("body", "").trim());
            }
        }
        return null;
    }

    static String installedVersion(Context ctx) {
        try {
            String v = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
            return v == null ? "0" : normalize(v);
        } catch (PackageManager.NameNotFoundException e) {
            return "0";
        }
    }

    /** Numeric dotted comparison: 1.10 > 1.9, "v1.2" == "1.2". */
    static boolean isNewer(String remote, String local) {
        String[] r = normalize(remote).split("\\.");
        String[] l = normalize(local).split("\\.");
        int n = Math.max(r.length, l.length);
        for (int i = 0; i < n; i++) {
            int rv = i < r.length ? parseInt(r[i]) : 0;
            int lv = i < l.length ? parseInt(l[i]) : 0;
            if (rv != lv) return rv > lv;
        }
        return false;
    }

    static File download(Context ctx, Release release) throws IOException {
        File dir = new File(ctx.getCacheDir(), "updates");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
        File apk = new File(dir, ASSET_NAME);
        Http.getToFile(release.apkUrl, apk, MAX_APK_BYTES);
        if (apk.length() < 10_000) throw new IOException("Downloaded APK is suspiciously small");
        return apk;
    }

    static Intent installIntent(Context ctx, File apk) {
        Intent i = new Intent(Intent.ACTION_VIEW);
        Uri uri;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apk);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } else {
            uri = Uri.fromFile(apk);
        }
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return i;
    }

    /** True when the OS will let this app launch the package installer. */
    static boolean canInstall(Context ctx) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
                || ctx.getPackageManager().canRequestPackageInstalls();
    }

    private static String normalize(String v) {
        String s = v.trim();
        if (s.startsWith("v") || s.startsWith("V")) s = s.substring(1);
        return s;
    }

    private static int parseInt(String s) {
        StringBuilder digits = new StringBuilder();
        for (char c : s.toCharArray()) {
            if (Character.isDigit(c)) digits.append(c); else break;
        }
        return digits.length() == 0 ? 0 : Integer.parseInt(digits.toString());
    }
}
