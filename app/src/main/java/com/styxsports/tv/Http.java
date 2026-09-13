package com.styxsports.tv;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Minimal blocking HTTP helpers; always call from a background thread. */
final class Http {

    /** Same UA the WebView uses, so the site serves the same markup to both. */
    static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

    private static final int TIMEOUT_MS = 12_000;
    private static final long MAX_TEXT_BYTES = 4L * 1024 * 1024;

    private Http() {}

    /**
     * The site fronts its pages with a cookie-based SSO redirect chain, so the process needs a
     * cookie jar for plain HttpURLConnection calls. The jar is the WebView's persistent cookie
     * store, so the schedule fetcher, the stream resolver, the web player and the account sign-in
     * all share one session that survives restarts. Safe to call repeatedly.
     */
    static synchronized void ensureCookies() {
        if (CookieHandler.getDefault() != null) return;
        try {
            CookieHandler.setDefault(new WebkitCookieHandler());
        } catch (Throwable noWebView) {
            CookieHandler.setDefault(new CookieManager(null, CookiePolicy.ACCEPT_ALL));
        }
    }

    /** Writes the cookie store to disk (after a sign-in / sign-out). */
    static void flushCookies() {
        try {
            android.webkit.CookieManager.getInstance().flush();
        } catch (Throwable ignored) {
            // no WebView on this device; the in-memory jar has nothing to flush
        }
    }

    /** java.net cookie handler backed by {@link android.webkit.CookieManager}. */
    private static final class WebkitCookieHandler extends CookieHandler {
        private final android.webkit.CookieManager store = android.webkit.CookieManager.getInstance();

        WebkitCookieHandler() {
            store.setAcceptCookie(true);
        }

        @Override
        public Map<String, List<String>> get(URI uri, Map<String, List<String>> requestHeaders) {
            String cookie = store.getCookie(uri.toString());
            if (cookie == null || cookie.isEmpty()) return Collections.emptyMap();
            return Collections.singletonMap("Cookie", Collections.singletonList(cookie));
        }

        @Override
        public void put(URI uri, Map<String, List<String>> responseHeaders) {
            for (Map.Entry<String, List<String>> e : responseHeaders.entrySet()) {
                String name = e.getKey();
                if (name == null || !(name.equalsIgnoreCase("Set-Cookie") || name.equalsIgnoreCase("Set-Cookie2"))) {
                    continue;
                }
                for (String value : e.getValue()) store.setCookie(uri.toString(), value);
            }
        }
    }

    static String getText(String url) throws IOException {
        return getText(url, null);
    }

    /** @param referer sent as the Referer header when non-null (embed hosts insist on one). */
    static String getText(String url, String referer) throws IOException {
        return getText(url, referer, TIMEOUT_MS);
    }

    /** @param readTimeoutMs how long to wait for the response; some embed hosts take ~15 s. */
    static String getText(String url, String referer, int readTimeoutMs) throws IOException {
        HttpURLConnection c = open(url);
        try {
            c.setReadTimeout(readTimeoutMs);
            if (referer != null) c.setRequestProperty("Referer", referer);
            check(c);
            return readText(c);
        } finally {
            c.disconnect();
        }
    }

    static String postForm(String url, String formBody) throws IOException {
        return postForm(url, formBody, null);
    }

    static String postForm(String url, String formBody, String referer) throws IOException {
        HttpURLConnection c = open(url);
        try {
            if (referer != null) c.setRequestProperty("Referer", referer);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
            c.setRequestProperty("X-Requested-With", "XMLHttpRequest");
            byte[] body = formBody.getBytes(StandardCharsets.UTF_8);
            c.setFixedLengthStreamingMode(body.length);
            try (OutputStream out = c.getOutputStream()) {
                out.write(body);
            }
            check(c);
            return readText(c);
        } finally {
            c.disconnect();
        }
    }

    /** Follows redirects and returns the URL that finally answered 2xx. */
    static String finalUrl(String url) throws IOException {
        // HttpURLConnection follows same-scheme redirects itself but hands back the 3xx when the
        // scheme changes (the site's SSO hops between http and https), so follow those by hand.
        for (int hop = 0; hop < 8; hop++) {
            HttpURLConnection c = open(url);
            try {
                int code = c.getResponseCode();
                String location = c.getHeaderField("Location");
                if (code >= 300 && code < 400 && location != null) {
                    url = new URL(c.getURL(), location).toString();
                    continue;
                }
                check(c);
                // Drain so the connection can be reused.
                copy(c.getInputStream(), new ByteArrayOutputStream(), MAX_TEXT_BYTES);
                return c.getURL().toString();
            } finally {
                c.disconnect();
            }
        }
        throw new IOException("Too many redirects for " + url);
    }

    static byte[] getBytes(String url, long maxBytes) throws IOException {
        HttpURLConnection c = open(url);
        try {
            check(c);
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            copy(c.getInputStream(), buf, maxBytes);
            return buf.toByteArray();
        } finally {
            c.disconnect();
        }
    }

    static void getToFile(String url, File dest, long maxBytes) throws IOException {
        HttpURLConnection c = open(url);
        try {
            check(c);
            File tmp = new File(dest.getPath() + ".part");
            try (OutputStream out = new FileOutputStream(tmp)) {
                copy(c.getInputStream(), out, maxBytes);
            }
            if (dest.exists() && !dest.delete()) throw new IOException("Cannot replace " + dest);
            if (!tmp.renameTo(dest)) throw new IOException("Cannot move " + tmp + " to " + dest);
        } finally {
            c.disconnect();
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        ensureCookies();
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(TIMEOUT_MS);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", DESKTOP_UA);
        c.setRequestProperty("Accept", "text/html,application/json,application/vnd.github+json,*/*");
        c.setRequestProperty("Accept-Language", "en-US,en;q=0.9");
        c.setUseCaches(false);
        return c;
    }

    private static void check(HttpURLConnection c) throws IOException {
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code + " for " + c.getURL());
    }

    private static String readText(HttpURLConnection c) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        copy(c.getInputStream(), buf, MAX_TEXT_BYTES);
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }

    private static void copy(InputStream in, OutputStream out, long max) throws IOException {
        byte[] b = new byte[16 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(b)) != -1) {
            total += n;
            if (total > max) throw new IOException("Response larger than " + max + " bytes");
            out.write(b, 0, n);
        }
    }
}
