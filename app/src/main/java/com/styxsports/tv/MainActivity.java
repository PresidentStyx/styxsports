package com.styxsports.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {

    /**
     * Site, host allow/block lists, UA and page script all come from {@link RemoteConfig}
     * (cached copy first, refreshed from GitHub on each launch). Top-level navigations to hosts
     * outside the allow list are dropped so a TV remote never gets stuck on an ad page.
     */
    private volatile RemoteConfig config;

    private static final int REQ_INSTALL_PERMISSION = 1001;

    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    + "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

    private static final long CURSOR_HIDE_DELAY_MS = 4000L;

    /** Removes target="_blank" from all links, now and as the page adds more. */
    private static final String STRIP_BLANK_TARGETS_JS =
            "(function(){"
                    + "var fix=function(r){(r.querySelectorAll?r.querySelectorAll('a[target]'):[])"
                    + ".forEach(function(a){a.removeAttribute('target');});};"
                    + "fix(document);"
                    + "if(!window.__styxObs){window.__styxObs=new MutationObserver(function(ms){"
                    + "ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType===1)fix(n);});});"
                    + "});window.__styxObs.observe(document.documentElement,{childList:true,subtree:true});}"
                    + "})();";

    private FrameLayout root;
    private WebView webView;
    private CursorView cursor;

    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable hideCursorRunnable = () -> cursor.animate().alpha(0f).setDuration(250).start();

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private File pendingInstall;

    private float density;
    private long touchDownTime;
    private boolean centerHeld;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;
        config = RemoteConfig.load(this);

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
            webView.loadUrl(config.homeUrl);
            Toast.makeText(this, R.string.hint_controls, Toast.LENGTH_LONG).show();
            refreshConfigAndCheckForUpdate();
        }
        scheduleCursorHide();
    }

    // ---------------------------------------------------------------------------------------------
    // Remote config + self-update
    // ---------------------------------------------------------------------------------------------

    private void refreshConfigAndCheckForUpdate() {
        io.execute(() -> {
            try {
                RemoteConfig fresh = RemoteConfig.parse(Http.getText(RemoteConfig.CONFIG_URL));
                handler.post(() -> applyConfig(fresh));
            } catch (Exception ignored) {
                // Offline or GitHub unreachable: keep using the cached copy.
            }
            try {
                AppUpdater.Release latest = AppUpdater.fetchLatest();
                if (latest != null
                        && AppUpdater.isNewer(latest.version, AppUpdater.installedVersion(this))) {
                    handler.post(() -> offerUpdate(latest));
                }
            } catch (Exception ignored) {
                // Update check is best-effort.
            }
        });
    }

    private void applyConfig(RemoteConfig fresh) {
        if (isFinishing() || isDestroyed()) return;
        String previousHome = config.homeUrl;
        fresh.save(this);
        config = fresh;
        applyUserAgent();

        // If the site moved and the user hasn't navigated anywhere yet, jump to the new home.
        if (!previousHome.equals(fresh.homeUrl) && webView.copyBackForwardList().getSize() <= 1) {
            webView.loadUrl(fresh.homeUrl);
        }
    }

    private void applyUserAgent() {
        String ua = config.userAgent.isEmpty() ? DESKTOP_UA : config.userAgent;
        if (!ua.equals(webView.getSettings().getUserAgentString())) {
            webView.getSettings().setUserAgentString(ua);
        }
    }

    private void offerUpdate(AppUpdater.Release release) {
        if (isFinishing() || isDestroyed()) return;
        String message = getString(R.string.update_message,
                release.version, AppUpdater.installedVersion(this));
        if (!release.notes.isEmpty()) message += "\n\n" + release.notes;

        new AlertDialog.Builder(this)
                .setTitle(R.string.update_title)
                .setMessage(message)
                .setPositiveButton(R.string.update_install, (d, w) -> downloadAndInstall(release))
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    private void downloadAndInstall(AppUpdater.Release release) {
        Toast.makeText(this, R.string.update_downloading, Toast.LENGTH_SHORT).show();
        io.execute(() -> {
            try {
                File apk = AppUpdater.download(this, release);
                handler.post(() -> installApk(apk));
            } catch (Exception e) {
                handler.post(() -> Toast.makeText(this,
                        getString(R.string.update_failed, e.getMessage()), Toast.LENGTH_LONG).show());
            }
        });
    }

    private void installApk(File apk) {
        if (isFinishing() || isDestroyed()) return;
        if (!AppUpdater.canInstall(this)) {
            // One-time: the OS needs "Install unknown apps" enabled for this app.
            pendingInstall = apk;
            Toast.makeText(this, R.string.update_allow_source, Toast.LENGTH_LONG).show();
            try {
                startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())), REQ_INSTALL_PERMISSION);
            } catch (ActivityNotFoundException e) {
                Toast.makeText(this, R.string.update_allow_source_manual, Toast.LENGTH_LONG).show();
            }
            return;
        }
        try {
            startActivity(AppUpdater.installIntent(this, apk));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, getString(R.string.update_failed, e.getMessage()),
                    Toast.LENGTH_LONG).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_INSTALL_PERMISSION && pendingInstall != null) {
            File apk = pendingInstall;
            pendingInstall = null;
            if (AppUpdater.canInstall(this)) installApk(apk);
        }
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
        // The site opens every event link with target="_blank". Multiple-window support must be
        // on for those clicks to reach onCreateWindow(), where we redirect them into this view.
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        applyUserAgent();

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

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                // Runs on a background thread. Swallow requests to known ad/pop-under hosts.
                if (config.isBlockedHost(request.getUrl().getHost())) {
                    return new WebResourceResponse("text/plain", "utf-8",
                            new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                // Make target="_blank" links navigate in place. onCreateWindow() below is the
                // fallback for anything this misses (e.g. window.open from scripts).
                view.evaluateJavascript(STRIP_BLANK_TARGETS_JS, null);
                String extra = config.pageScript;
                if (!extra.isEmpty()) view.evaluateJavascript(extra, null);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          Message resultMsg) {
                // A throwaway WebView receives the new-window navigation; we capture its first
                // URL, run it through the host guard, and load it in the main view instead.
                final WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        Uri target = request.getUrl();
                        if (isAllowedTopLevel(target)) {
                            webView.loadUrl(target.toString());
                        }
                        handler.post(popup::destroy);
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }

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

        RemoteConfig c = config;
        String homeHost = Uri.parse(c.homeUrl).getHost();
        if (homeHost != null && host.equals(homeHost.toLowerCase(Locale.ROOT))) return true;
        return c.isAllowedHost(host);
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
        io.shutdownNow();
        handler.removeCallbacksAndMessages(null);
        exitFullscreen();
        root.removeView(webView);
        webView.destroy();
        super.onDestroy();
    }
}
