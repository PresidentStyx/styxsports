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
import java.net.URL;
import java.nio.charset.StandardCharsets;

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
     * cookie jar for plain HttpURLConnection calls. Safe to call repeatedly.
     */
    static synchronized void ensureCookies() {
        if (CookieHandler.getDefault() == null) {
            CookieHandler.setDefault(new CookieManager(null, CookiePolicy.ACCEPT_ALL));
        }
    }

    static String getText(String url) throws IOException {
        HttpURLConnection c = open(url);
        try {
            check(c);
            return readText(c);
        } finally {
            c.disconnect();
        }
    }

    static String postForm(String url, String formBody) throws IOException {
        HttpURLConnection c = open(url);
        try {
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
        HttpURLConnection c = open(url);
        try {
            check(c);
            // Drain so the connection can be reused.
            copy(c.getInputStream(), new ByteArrayOutputStream(), MAX_TEXT_BYTES);
            return c.getURL().toString();
        } finally {
            c.disconnect();
        }
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
