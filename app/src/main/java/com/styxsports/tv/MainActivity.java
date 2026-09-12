package com.styxsports.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.util.Locale;

public class MainActivity extends Activity {

    /** Site the app is pinned to. */
    static final String HOME_URL = "https://v5.gostreameast.link/";

    /**
     * Top-level (main frame) navigations are only allowed to hosts that match one of these
     * fragments. Everything else (pop-under ads, redirect chains, app-store links) is dropped
     * so a TV remote never gets stuck on a page it can't get back from.
     */
    private static final String[] ALLOWED_HOST_FRAGMENTS = {
            "streameast",
    };

    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

    private static final long CURSOR_HIDE_DELAY_MS = 4000L;

    private FrameLayout root;
    private WebView webView;
    private CursorView cursor;

    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable hideCursorRunnable = () -> cursor.animate().alpha(0f).setDuration(250).start();

    private float density;
    private long touchDownTime;
    private boolean centerHeld;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveMode();

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        cursor = new CursorView(this);
        root.addView(cursor, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        configureWebView();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(HOME_URL);
            Toast.makeText(this, R.string.hint_controls, Toast.LENGTH_LONG).show();
        }
        scheduleCursorHide();
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(DESKTOP_UA);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) {
                    return false; // iframes (players) are left alone
                }
                return !isAllowedTopLevel(request.getUrl());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                cursor.bringToFront();
                applyImmersiveMode();
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });
    }

    private boolean isAllowedTopLevel(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) return false;

        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);

        String homeHost = Uri.parse(HOME_URL).getHost();
        if (homeHost != null && host.equals(homeHost.toLowerCase(Locale.ROOT))) return true;

        for (String fragment : ALLOWED_HOST_FRAGMENTS) {
            if (host.contains(fragment)) return true;
        }
        return false;
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        if (fullscreenCallback != null) {
            fullscreenCallback.onCustomViewHidden();
            fullscreenCallback = null;
        }
        applyImmersiveMode();
    }

    // ---------------------------------------------------------------------------------------------
    // Remote-control handling
    // ---------------------------------------------------------------------------------------------

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;

        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP:
                if (down) moveCursor(0, -1, event.getRepeatCount());
                return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:
                if (down) moveCursor(0, 1, event.getRepeatCount());
                return true;
            case KeyEvent.KEYCODE_DPAD_LEFT:
                if (down) moveCursor(-1, 0, event.getRepeatCount());
                return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (down) moveCursor(1, 0, event.getRepeatCount());
                return true;

            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
                if (down) {
                    if (event.getRepeatCount() == 0 && !centerHeld) {
                        centerHeld = true;
                        cursor.setPressed(true);
                        sendTouch(MotionEvent.ACTION_DOWN);
                    }
                } else if (centerHeld) {
                    centerHeld = false;
                    cursor.setPressed(false);
                    sendTouch(MotionEvent.ACTION_UP);
                }
                showCursor();
                return true;

            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE:
                if (down) return true;
                if (fullscreenView != null) {
                    exitFullscreen();
                } else if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    finish();
                }
                return true;

            case KeyEvent.KEYCODE_MENU:
                if (down) {
                    exitFullscreen();
                    webView.reload();
                    Toast.makeText(this, R.string.reloading, Toast.LENGTH_SHORT).show();
                }
                return true;

            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (down) togglePlayback();
                return true;

            default:
                return super.dispatchKeyEvent(event);
        }
    }

    private void moveCursor(int dx, int dy, int repeat) {
        showCursor();

        // Accelerate while the key is held.
        float speed = 14f * density * (1f + Math.min(repeat, 24) * 0.18f);
        float stepX = dx * speed;
        float stepY = dy * speed;

        int w = root.getWidth();
        int h = root.getHeight();
        if (w == 0 || h == 0) return;

        float x = cursor.getCursorX();
        float y = cursor.getCursorY();
        float nx = x + stepX;
        float ny = y + stepY;

        // When the pointer enters the outer 15% of the screen, turn further movement into
        // page scrolling, as long as the page can still scroll that way.
        float marginX = w * 0.15f;
        float marginY = h * 0.15f;
        View scroller = fullscreenView != null ? null : webView;

        if (scroller != null) {
            if (dy < 0 && ny < marginY && scroller.canScrollVertically(-1)) {
                float limit = Math.min(y, marginY);
                scroller.scrollBy(0, (int) (ny - limit));
                ny = limit;
            } else if (dy > 0 && ny > h - marginY && scroller.canScrollVertically(1)) {
                float limit = Math.max(y, h - marginY);
                scroller.scrollBy(0, (int) (ny - limit));
                ny = limit;
            }
            if (dx < 0 && nx < marginX && scroller.canScrollHorizontally(-1)) {
                float limit = Math.min(x, marginX);
                scroller.scrollBy((int) (nx - limit), 0);
                nx = limit;
            } else if (dx > 0 && nx > w - marginX && scroller.canScrollHorizontally(1)) {
                float limit = Math.max(x, w - marginX);
                scroller.scrollBy((int) (nx - limit), 0);
                nx = limit;
            }
        }

        nx = Math.max(0f, Math.min(w - 1f, nx));
        ny = Math.max(0f, Math.min(h - 1f, ny));
        cursor.setPosition(nx, ny);

        // If OK is held while moving, feed the movement through as a drag.
        if (centerHeld) sendTouch(MotionEvent.ACTION_MOVE);
    }

    private void sendTouch(int action) {
        View target = fullscreenView != null ? fullscreenView : webView;
        long now = SystemClock.uptimeMillis();
        if (action == MotionEvent.ACTION_DOWN) touchDownTime = now;

        MotionEvent ev = MotionEvent.obtain(touchDownTime, now, action,
                cursor.getCursorX(), cursor.getCursorY(), 0);
        ev.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        target.dispatchTouchEvent(ev);
        ev.recycle();
    }

    private void showCursor() {
        handler.removeCallbacks(hideCursorRunnable);
        cursor.animate().cancel();
        cursor.setAlpha(1f);
        scheduleCursorHide();
    }

    private void scheduleCursorHide() {
        handler.postDelayed(hideCursorRunnable, CURSOR_HIDE_DELAY_MS);
    }

    private void togglePlayback() {
        // Only reaches same-origin <video> elements; cross-origin player iframes are opaque.
        webView.evaluateJavascript(
                "(function(){var v=document.querySelector('video');"
                        + "if(!v)return 'none';if(v.paused){v.play();return 'play';}v.pause();return 'pause';})()",
                null);
    }

    // ---------------------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------------------

    private void applyImmersiveMode() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersiveMode();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        applyImmersiveMode();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        exitFullscreen();
        root.removeView(webView);
        webView.destroy();
        super.onDestroy();
    }
}
