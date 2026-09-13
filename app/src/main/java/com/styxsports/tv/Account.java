package com.styxsports.tv;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Log;

import org.json.JSONObject;

import java.io.IOException;
import java.net.URLEncoder;

/**
 * The viewer's account on the site, signed in with the site's own TV flow: the TV asks the
 * account service for a short code, the viewer types it (or scans the QR) on their phone, and the
 * TV then swaps the approved code for a session. The session lives in the shared cookie store
 * ({@link Http#ensureCookies()}), so every fetch the app makes is signed in from then on and the
 * stream pages hand out the premium servers the account is entitled to.
 *
 * Network methods block; call them from a background thread.
 */
final class Account {

    private static final String TAG = "StyxAccount";
    private static final String PREFS = "styxsports_account";
    private static final String KEY_SIGNED_IN = "signed_in";
    private static final String KEY_CHECKED_AT = "checked_at";
    private static final String KEY_PREMIUM = "premium"; // "yes" / "no" / absent = unknown
    private static final String KEY_DEVICE_ID = "device_id";

    /** Re-check the session this often while the app is in use. */
    static final long RECHECK_MS = 6L * 60 * 60 * 1000;

    /** A sign-in code the viewer enters on their phone. */
    static final class Code {
        final String code;
        final String deviceId;
        /** Unix seconds when the code stops working. */
        final long expiresAt;

        Code(String code, String deviceId, long expiresAt) {
            this.code = code;
            this.deviceId = deviceId;
            this.expiresAt = expiresAt;
        }

        /** "VH8 48Z" for the screen. */
        String display() {
            return code.length() == 6 ? code.substring(0, 3) + " " + code.substring(3) : code;
        }
    }

    /** One answer from the approval poll. */
    static final class Poll {
        /** pending, approved, used, expired or invalid. */
        final String status;
        /** Present when approved. */
        final String token;

        Poll(String status, String token) {
            this.status = status;
            this.token = token;
        }
    }

    private final Context ctx;
    private final RemoteConfig config;

    Account(Context ctx, RemoteConfig config) {
        this.ctx = ctx.getApplicationContext();
        this.config = config;
    }

    // ---------------------------------------------------------------------------------------------
    // Cached state (main-thread safe)
    // ---------------------------------------------------------------------------------------------

    static boolean isSignedIn(Context ctx) {
        return prefs(ctx).getBoolean(KEY_SIGNED_IN, false);
    }

    /** True once a premium server has actually been unlocked for this account; false once gated. */
    static Boolean premiumKnown(Context ctx) {
        String p = prefs(ctx).getString(KEY_PREMIUM, null);
        return p == null ? null : "yes".equals(p);
    }

    /** The player reports what it saw: a premium server with a real player, or a locked one. */
    static void notePremium(Context ctx, boolean unlocked) {
        if (!isSignedIn(ctx)) return;
        prefs(ctx).edit().putString(KEY_PREMIUM, unlocked ? "yes" : "no").apply();
    }

    static boolean isStale(Context ctx) {
        return System.currentTimeMillis() - prefs(ctx).getLong(KEY_CHECKED_AT, 0) > RECHECK_MS;
    }

    /** URL the QR code points at; the viewer signs in there and types the code. */
    String activateUrl() {
        return config.authBaseUrl + "/activate?from=" + mirrorHost();
    }

    /** "auth.streamea.st/activate" for the on-screen instructions. */
    String activateDisplay() {
        return Uri.parse(activateUrl()).getHost() + "/activate";
    }

    // ---------------------------------------------------------------------------------------------
    // Sign-in flow (background thread)
    // ---------------------------------------------------------------------------------------------

    /** Asks for a fresh code. Reuses the device id so re-requests replace the old code. */
    Code requestCode() throws IOException {
        String deviceId = prefs(ctx).getString(KEY_DEVICE_ID, "");
        String body = deviceId.isEmpty() ? "" : "device_id=" + enc(deviceId);
        JSONObject d = json(Http.postForm(config.authBaseUrl + "/device/code", body, config.authBaseUrl + "/tv"));
        if (!d.optBoolean("success")) throw new IOException("Code request refused");
        String code = d.optString("code", "");
        String id = d.optString("device_id", deviceId);
        if (code.isEmpty() || id.isEmpty()) throw new IOException("Malformed code response");
        prefs(ctx).edit().putString(KEY_DEVICE_ID, id).apply();
        long expiresAt = d.optLong("expires_at", System.currentTimeMillis() / 1000 + d.optLong("expires_in", 600));
        return new Code(code, id, expiresAt);
    }

    /** Has the viewer approved the code yet? */
    Poll poll(Code code) throws IOException {
        String url = config.authBaseUrl + "/device/poll?code=" + enc(code.code) + "&device_id=" + enc(code.deviceId);
        JSONObject d = json(Http.getText(url, config.authBaseUrl + "/tv"));
        return new Poll(d.optString("status", "pending"), d.optString("auth_token", ""));
    }

    /**
     * Swaps an approved token for a session on the account service and on the mirror the app
     * reads (the account service redirects to the mirror's SSO hand-off).
     */
    void completeSignIn(String token) throws IOException {
        String base = mirrorBase();
        String landed = Http.finalUrl(config.authBaseUrl + "/device/login?token=" + enc(token) + "&from=" + mirrorHost());
        Log.i(TAG, "device login landed on " + StreamResolver.hostOf(landed));
        // Make sure the mirror ran its SSO hand-off too (harmless if the redirect already did).
        try {
            Http.getText(base + "/");
        } catch (IOException e) {
            Log.w(TAG, "mirror hand-off after sign-in failed: " + e.getMessage());
        }
        Http.flushCookies();
        if (!refreshStatus()) throw new IOException("Signed in, but the account service does not see a session");
        prefs(ctx).edit().remove(KEY_PREMIUM).apply(); // learn it fresh from the first stream
    }

    /** Asks the account service whether the cookies still make a signed-in session. */
    boolean refreshStatus() throws IOException {
        String landed = Http.finalUrl(config.authBaseUrl + "/my-account/");
        boolean signedIn = !landed.contains("/login");
        Log.i(TAG, "account status: " + (signedIn ? "signed in" : "signed out") + " (" + landed + ")");
        SharedPreferences.Editor e = prefs(ctx).edit()
                .putBoolean(KEY_SIGNED_IN, signedIn)
                .putLong(KEY_CHECKED_AT, System.currentTimeMillis());
        if (!signedIn) e.remove(KEY_PREMIUM);
        e.apply();
        return signedIn;
    }

    /** Signs out on the account service and forgets every cookie the app holds. */
    void signOut() {
        try {
            Http.finalUrl(config.authBaseUrl + "/logout/");
        } catch (IOException e) {
            Log.w(TAG, "logout request failed: " + e.getMessage());
        }
        try {
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            cm.removeAllCookies(null);
            cm.flush();
        } catch (Throwable ignored) {
            // no WebView cookie store on this device
        }
        prefs(ctx).edit().clear().apply();
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private String mirrorBase() {
        return new SiteRepository(ctx).currentBase(config);
    }

    private String mirrorHost() {
        return StreamResolver.hostOf(mirrorBase());
    }

    private static JSONObject json(String text) throws IOException {
        try {
            return new JSONObject(text);
        } catch (Exception e) {
            throw new IOException("Unexpected answer from the account service");
        }
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
