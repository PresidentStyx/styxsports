package com.styxsports.tv;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import android.widget.ImageView;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Tiny memory-cached image loader for team crests. */
final class ImageLoader {

    private static final long MAX_IMAGE_BYTES = 512 * 1024;

    private final LruCache<String, Bitmap> cache = new LruCache<>(6 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) {
            return value.getByteCount();
        }
    };
    private final Set<String> failed = new HashSet<>();
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final Handler main = new Handler(Looper.getMainLooper());

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
        pool.execute(() -> {
            Bitmap bmp = null;
            try {
                byte[] bytes = Http.getBytes(url, MAX_IMAGE_BYTES);
                bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            } catch (Exception ignored) {
                // leave placeholder
            }
            if (bmp == null) {
                synchronized (failed) {
                    failed.add(url);
                }
                return;
            }
            cache.put(url, bmp);
            final Bitmap ready = bmp;
            main.post(() -> {
                if (url.equals(into.getTag())) into.setImageBitmap(ready);
            });
        });
    }

    void shutdown() {
        pool.shutdownNow();
    }
}
