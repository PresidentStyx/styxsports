package com.styxsports.tv;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Minimal blocking HTTP helpers; always call from a background thread. */
final class Http {

    private static final int TIMEOUT_MS = 10_000;
    private static final long MAX_TEXT_BYTES = 512 * 1024;

    private Http() {}

    static String getText(String url) throws IOException {
        HttpURLConnection c = open(url);
        try {
            check(c);
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            copy(c.getInputStream(), buf, MAX_TEXT_BYTES);
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
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
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(TIMEOUT_MS);
        c.setInstanceFollowRedirects(true);
        c.setRequestProperty("User-Agent", "StyxSports-Android");
        c.setRequestProperty("Accept", "application/vnd.github+json, application/json, */*");
        c.setUseCaches(false);
        return c;
    }

    private static void check(HttpURLConnection c) throws IOException {
        int code = c.getResponseCode();
        if (code < 200 || code >= 300) throw new IOException("HTTP " + code + " for " + c.getURL());
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
