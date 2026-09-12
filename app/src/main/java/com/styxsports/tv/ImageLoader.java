package com.styxsports.tv;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.LruCache;
import android.widget.ImageView;

import com.caverock.androidsvg.PreserveAspectRatio;
import com.caverock.androidsvg.SVG;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Memory-cached loader for team crests.
 *
 * The site serves crests as 500x500 PNGs (1 MB each once decoded) and the same team appears in
 * several rows, so images are decoded down to the size they are shown at and one bitmap per URL
 * is shared by every view that needs it. On a 2 GB TV the difference is ~500 MB versus ~5 MB.
 */
final class ImageLoader {

    private static final String TAG = "StyxImages";
    private static final long MAX_IMAGE_BYTES = 2 * 1024 * 1024; // some SVGs embed a raster

    private final int targetPx;
    private final LruCache<String, Bitmap> cache = new LruCache<>(12 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };
    private final Set<String> failed = new HashSet<>();
    /** URL -> views waiting for it; a URL is being fetched iff it has an entry here. */
    private final Map<String, List<ImageView>> inFlight = new HashMap<>();
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final Handler main = new Handler(Looper.getMainLooper());

    /** @param targetPx the pixel size images are displayed at; decoding stops shrinking there. */
    ImageLoader(int targetPx) {
        this.targetPx = Math.max(16, targetPx);
    }

    /** Sets the bitmap on the view once loaded, unless the view has been re-bound meanwhile. */
    void load(String url, ImageView into, int placeholderRes) {
        if (url == null || url.isEmpty()) {
            into.setTag(null);
            into.setImageResource(placeholderRes);
            return;
        }
        into.setTag(url);
        Bitmap hit = cache.get(url);
        if (hit != null) {
            into.setImageBitmap(hit);
            return;
        }
        into.setImageResource(placeholderRes);
        synchronized (failed) {
            if (failed.contains(url)) return;
        }
        synchronized (inFlight) {
            List<ImageView> waiting = inFlight.get(url);
            if (waiting != null) {
                waiting.add(into);
                return;
            }
            waiting = new ArrayList<>();
            waiting.add(into);
            inFlight.put(url, waiting);
        }
        pool.execute(() -> fetch(url));
    }

    private void fetch(String url) {
        Bitmap bmp = null;
        try {
            byte[] bytes = Http.getBytes(url, MAX_IMAGE_BYTES);
            bmp = decodeScaled(bytes);
            if (bmp == null) Log.w(TAG, "undecodable image " + url + " (" + bytes.length + " bytes)");
        } catch (Exception e) {
            Log.w(TAG, "image failed " + url + ": " + e);
        }
        final Bitmap ready = bmp;
        final List<ImageView> waiting;
        synchronized (inFlight) {
            waiting = inFlight.remove(url);
        }
        if (ready == null) {
            synchronized (failed) {
                failed.add(url);
            }
            return;
        }
        cache.put(url, ready);
        if (waiting == null) return;
        main.post(() -> {
            for (ImageView v : waiting) {
                if (url.equals(v.getTag())) v.setImageBitmap(ready);
            }
        });
    }

    /** Decodes with the largest power-of-two subsample that keeps the image >= targetPx. */
    private Bitmap decodeScaled(byte[] bytes) {
        if (looksLikeSvg(bytes)) return renderSvg(bytes);
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
        int sample = 1;
        int size = Math.max(o.outWidth, o.outHeight);
        while (size / (sample * 2) >= targetPx) sample *= 2;
        o.inJustDecodeBounds = false;
        o.inSampleSize = sample;
        o.inPreferredConfig = Bitmap.Config.ARGB_8888;
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.length, o);
    }

    private static boolean looksLikeSvg(byte[] bytes) {
        int n = Math.min(bytes.length, 512);
        String head = new String(bytes, 0, n, StandardCharsets.US_ASCII).toLowerCase(Locale.ROOT);
        return head.contains("<svg") || head.startsWith("<?xml");
    }

    /** Rasterises an SVG crest at exactly the displayed size, preserving aspect ratio. */
    private Bitmap renderSvg(byte[] bytes) {
        try {
            SVG svg = SVG.getFromInputStream(new ByteArrayInputStream(bytes));
            svg.setDocumentWidth("100%");
            svg.setDocumentHeight("100%");
            // Fit inside the square while keeping the drawing's own proportions.
            svg.setDocumentPreserveAspectRatio(PreserveAspectRatio.LETTERBOX);
            Bitmap bmp = Bitmap.createBitmap(targetPx, targetPx, Bitmap.Config.ARGB_8888);
            svg.renderToCanvas(new Canvas(bmp));
            return bmp;
        } catch (Exception e) {
            Log.w(TAG, "svg render failed: " + e);
            return null;
        }
    }

    /** Drops cached bitmaps that no view is currently showing (they reload on demand). */
    void trim() {
        cache.evictAll();
    }

    /** Lets previously failed URLs be tried again (failures are usually transient rate limits). */
    void forgetFailures() {
        synchronized (failed) {
            failed.clear();
        }
    }

    void shutdown() {
        pool.shutdownNow();
        synchronized (inFlight) {
            inFlight.clear();
        }
    }
}
