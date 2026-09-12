package com.styxsports.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebHistoryItem;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.util.Locale;

/**
 * The WebView screen. Opened by {@link HomeActivity} either for one stream page ("player mode",
 * with the site's chrome stripped by injected CSS) or for the plain website as a fallback.
 * Navigation is by a D-pad driven virtual pointer.
 */
public class PlayerActivity extends Activity {

    static final String EXTRA_URL = "url";
    static final String EXTRA_PLAYER_MODE = "player";

    private static final long CURSOR_HIDE_DELAY_MS = 4000L;
    private static final long LOADING_OVERLAY_TIMEOUT_MS = 12_000L;

    /** Applied to every page: no scrollbars, no text selection, no tap highlight. */
    private static final String BASE_CSS =
            "::-webkit-scrollbar{display:none!important}"
                    + "*{-webkit-user-select:none!important;user-select:none!important;"
                    + "-webkit-tap-highlight-color:transparent!important;-webkit-touch-callout:none!important}";

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

    static Intent intent(Context ctx, String url, boolean playerMode) {
        return new Intent(ctx, PlayerActivity.class)
                .putExtra(EXTRA_URL, url)
                .putExtra(EXTRA_PLAYER_MODE, playerMode);
    }

    private RemoteConfig config;
    private boolean playerMode;

    private FrameLayout root;
    private WebView webView;
    private CursorView cursor;
    private View loadingOverlay;

    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable hideCursorRunnable = () -> cursor.animate().alpha(0f).setDuration(250).start();
    private final Runnable hideOverlayRunnable = this::hideLoadingOverlay;

    private float density;
    private long touchDownTime;
    private boolean centerHeld;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;
        config = RemoteConfig.load(this);
        playerMode = getIntent().getBooleanExtra(EXTRA_PLAYER_MODE, false);
        String url = getIntent().getStringExtra(EXTRA_URL);
        if (url == null || url.isEmpty()) url = config.homeUrl;

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveMode();

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setLongClickable(false);
        webView.setOnLongClickListener(v -> true);
        webView.setHapticFeedbackEnabled(false);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        loadingOverlay = buildLoadingOverlay();
        root.addView(loadingOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        cursor = new CursorView(this);
        root.addView(cursor, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        configureWebView();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(url);
            if (!playerMode) {
                Toast.makeText(this, getString(R.string.hint_controls,
                        AppUpdater.installedVersion(this)), Toast.LENGTH_LONG).show();
            }
        }
        scheduleCursorHide();
    }

    private View buildLoadingOverlay() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(androidx.core.content.ContextCompat.getColor(this, R.color.bg));
        box.setClickable(false);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.wordmark);
        int w = (int) (220 * density);
        int h = (int) (61 * density);
        box.addView(logo, new LinearLayout.LayoutParams(w, h));

        ProgressBar spinner = new ProgressBar(this);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(
                (int) (36 * density), (int) (36 * density));
        sp.topMargin = (int) (28 * density);
        box.addView(spinner, sp);
        return box;
    }

    private void showLoadingOverlay() {
        handler.removeCallbacks(hideOverlayRunnable);
        loadingOverlay.animate().cancel();
        loadingOverlay.setAlpha(1f);
        loadingOverlay.setVisibility(View.VISIBLE);
        handler.postDelayed(hideOverlayRunnable, LOADING_OVERLAY_TIMEOUT_MS);
    }

    private void hideLoadingOverlay() {
        handler.removeCallbacks(hideOverlayRunnable);
        if (loadingOverlay.getVisibility() != View.VISIBLE) return;
        loadingOverlay.animate().alpha(0f).setDuration(220)
                .withEndAction(() -> loadingOverlay.setVisibility(View.GONE)).start();
    }

    private void applyUserAgent() {
        String ua = config.userAgent.isEmpty() ? Http.DESKTOP_UA : config.userAgent;
        if (!ua.equals(webView.getSettings().getUserAgentString())) {
            webView.getSettings().setUserAgentString(ua);
        }
    }

    /** Idempotent: adds a <style id=...> once per document. */
    private void injectCss(WebView view, String id, String css) {
        if (css.isEmpty()) return;
        String js = "(function(){if(document.getElementById(" + JSONObject.quote(id) + "))return;"
                + "var s=document.createElement('style');s.id=" + JSONObject.quote(id) + ";"
                + "s.textContent=" + JSONObject.quote(css) + ";"
                + "(document.head||document.documentElement).appendChild(s);})();";
        view.evaluateJavascript(js, null);
    }

    private void injectStyles(WebView view) {
        injectCss(view, "styx-base", BASE_CSS);
        if (playerMode) {
            applyViewport(view);
            injectCss(view, "styx-player", config.playerCss);
        }
    }

    /**
     * A 1080p TV at the WebView's usual density is only ~960 CSS px wide, so the site serves its
     * tablet layout (cramped player, mobile chat bar). Forcing a desktop viewport width makes it
     * lay out like a desktop page, which wide-viewport/overview mode then scales to fit.
     */
    private void applyViewport(WebView view) {
        if (config.playerViewportWidth <= 0) return;
        String js = "(function(){var c='width=" + config.playerViewportWidth + "';"
                + "var m=document.querySelector('meta[name=viewport]');"
                + "if(!m){m=document.createElement('meta');m.name='viewport';"
                + "(document.head||document.documentElement).appendChild(m);}"
                + "if(m.content!==c)m.content=c;})();";
        view.evaluateJavascript(js, null);
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
                // Server-side redirects of a navigation we already approved are the site's own
                // doing (e.g. its SSO hand-off through a differently spelled domain). Let them
                // through; only http(s) is ever allowed.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && request.isRedirect()) {
                    return !isWebScheme(request.getUrl());
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
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                showLoadingOverlay();
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                // First paint of the new document: style it before the user sees it.
                injectStyles(view);
                handler.removeCallbacks(hideOverlayRunnable);
                handler.postDelayed(hideOverlayRunnable, 250);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectStyles(view);
                // Make target="_blank" links navigate in place. onCreateWindow() below is the
                // fallback for anything this misses (e.g. window.open from scripts).
                view.evaluateJavascript(STRIP_BLANK_TARGETS_JS, null);
                if (!config.pageScript.isEmpty()) view.evaluateJavascript(config.pageScript, null);
                if (playerMode && !config.playerScript.isEmpty()) {
                    view.evaluateJavascript(config.playerScript, null);
                }
                hideLoadingOverlay();
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture,
                                          Message resultMsg) {
                // Fast path: for a tapped <a target="_blank">, the hit-test result already
                // holds the link URL, so we can navigate directly without a popup window.
                WebView.HitTestResult hit = view.getHitTestResult();
                String hitUrl = hit != null ? hit.getExtra() : null;
                if (hitUrl != null && (hit.getType() == WebView.HitTestResult.SRC_ANCHOR_TYPE
                        || hit.getType() == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE)) {
                    if (isAllowedTopLevel(Uri.parse(hitUrl))) webView.loadUrl(hitUrl);
                    return false; // no window created
                }

                // Otherwise (window.open from script, etc.) a throwaway WebView receives the
                // navigation; we capture its first URL and load it in the main view instead.
                final WebView popup = new WebView(PlayerActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    private boolean handled;

                    private void redirect(Uri target) {
                        if (handled) return;
                        handled = true;
                        if (target != null && isAllowedTopLevel(target)) {
                            webView.loadUrl(target.toString());
                        }
                        handler.post(popup::destroy);
                    }

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        redirect(request.getUrl());
                        return true;
                    }

                    @Override
                    public void onPageStarted(WebView v, String url, Bitmap favicon) {
                        // Some WebView versions skip shouldOverrideUrlLoading for a popup's
                        // initial navigation; this catches it.
                        if (url != null && !url.equals("about:blank")) redirect(Uri.parse(url));
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

    private static boolean isWebScheme(Uri uri) {
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        scheme = scheme.toLowerCase(Locale.ROOT);
        return scheme.equals("http") || scheme.equals("https");
    }

    private boolean isAllowedTopLevel(Uri uri) {
        if (!isWebScheme(uri)) return false;

        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.ROOT);

        RemoteConfig c = config;
        String homeHost = Uri.parse(c.homeUrl).getHost();
        if (homeHost != null && host.equals(homeHost.toLowerCase(Locale.ROOT))) return true;
        String dataHost = Uri.parse(c.dataBaseUrl).getHost();
        if (dataHost != null && host.equals(dataHost.toLowerCase(Locale.ROOT))) return true;
        return c.isAllowedHost(host);
    }

    /**
     * The site reaches every page through an SSO hop (auth domain, connect.php) that leaves
     * entries in the WebView history; plain goBack() lands on one and is bounced straight back
     * to the same page. Returns the negative offset of the nearest earlier entry that is a real,
     * different page, or 0 when there is none (then Back should leave this screen).
     */
    private int stepsToPreviousRealPage() {
        WebBackForwardList list = webView.copyBackForwardList();
        WebHistoryItem current = list.getCurrentItem();
        if (current == null) return 0;
        String currentPath = pathOf(current.getUrl());
        for (int i = list.getCurrentIndex() - 1; i >= 0; i--) {
            String url = list.getItemAtIndex(i).getUrl();
            if (url == null) continue;
            Uri u = Uri.parse(url);
            String host = u.getHost();
            String path = pathOf(url);
            if (host == null || !isAllowedTopLevel(u)) continue;
            host = host.toLowerCase(Locale.ROOT);
            if (host.contains("streamea.st") || path.contains("connect") || path.contains("sso")
                    || path.contains("auth") || path.equals(currentPath)) {
                continue; // redirect artifact, or the same page on a mirror domain
            }
            return i - list.getCurrentIndex();
        }
        return 0;
    }

    private static String pathOf(String url) {
        String p = Uri.parse(url).getPath();
        return p == null ? "" : p.toLowerCase(Locale.ROOT);
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
                } else {
                    int steps = stepsToPreviousRealPage();
                    if (steps < 0) {
                        webView.goBackOrForward(steps);
                    } else {
                        finish();
                    }
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

        // Build a fully-specified single-finger event. The short obtain() overload leaves the
        // tool type UNKNOWN, which Chromium may not treat as a genuine touch.
        MotionEvent.PointerProperties props = new MotionEvent.PointerProperties();
        props.id = 0;
        props.toolType = MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords coords = new MotionEvent.PointerCoords();
        coords.x = cursor.getCursorX();
        coords.y = cursor.getCursorY();
        coords.pressure = 1f;
        coords.size = 1f;

        MotionEvent ev = MotionEvent.obtain(touchDownTime, now, action, 1,
                new MotionEvent.PointerProperties[]{props},
                new MotionEvent.PointerCoords[]{coords},
                0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, 0);
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
