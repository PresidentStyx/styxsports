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
import android.util.Log;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
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
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The WebView screen. Opened by {@link HomeActivity} either for one stream page ("player mode",
 * with the site's chrome stripped by injected CSS) or for the plain website as a fallback.
 * Navigation is by a D-pad driven virtual pointer.
 */
public class PlayerActivity extends Activity {

    private static final String TAG = "StyxPlayer";
    static final String EXTRA_URL = "url";
    private static final String STATE_DIRECT = "direct";
    private static final String STATE_DIRECT_HOST = "directHost";
    static final String EXTRA_PLAYER_MODE = "player";
    static final String EXTRA_EMBED_URL = "embedUrl";
    static final String EXTRA_EMBED_REFERER = "embedReferer";

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

    /** Opens an already resolved embed page full screen (fallback from the native player). */
    static Intent embedIntent(Context ctx, String streamPageUrl, String embedUrl, String referer) {
        return intent(ctx, streamPageUrl, true)
                .putExtra(EXTRA_EMBED_URL, embedUrl)
                .putExtra(EXTRA_EMBED_REFERER, referer);
    }

    /** Full-screen styling for a resolved player page (Clappr/hls.js on a black body). */
    private static final String DIRECT_CSS =
            "html,body{background:#000!important;margin:0!important;padding:0!important;"
                    + "width:100%!important;height:100%!important;overflow:hidden!important}"
                    + "#player,#player>div,[data-player],.player-container,video,iframe"
                    + "{position:fixed!important;top:0!important;left:0!important;width:100vw!important;"
                    + "height:100vh!important;max-width:none!important;max-height:none!important;"
                    + "margin:0!important;border:0!important}"
                    + ".media-control,.unmute,#UnMutePlayer{display:none!important}"
                    + "::-webkit-scrollbar{display:none!important}";

    /**
     * Walks the page and every same-origin frame inside it (the embed page is a wrapper around
     * the real player frame), styles each one full screen and starts the first video found.
     * Returns what it did so the caller can stop retrying once the video is actually running.
     */
    private static final String AUTOPLAY_JS =
            "(function(){"
                    + "var css=" + jsString(DIRECT_CSS) + ";"
                    + "function style(d){if(!d.getElementById('styx-direct')){var s=d.createElement('style');"
                    + "s.id='styx-direct';s.textContent=css;(d.head||d.documentElement).appendChild(s);}}"
                    + "function go(w){var r='none';try{var d=w.document;if(!d)return r;style(d);"
                    + "var v=d.querySelector('video');"
                    + "if(v&&!v.paused&&!v.ended&&v.readyState>=3)return 'playing';"
                    + "if(v){v.muted=false;var p=v.play();if(p&&p.catch)p.catch(function(){});r='started';}"
                    + "try{w.eval(\"if(typeof player!=='undefined'&&player&&player.play)player.play();\");}catch(e){}"
                    + "if(!v){var b=d.querySelector('.player-poster,.play-wrapper,[data-poster],"
                    + ".vjs-big-play-button,.jw-display-icon-display,.plyr__control--overlaid');"
                    + "if(b){b.click();r='clicked';}}"
                    + "}catch(e){return 'x';}"
                    + "for(var i=0;i<w.frames.length;i++){var s=go(w.frames[i]);"
                    + "if(s==='playing')return s;if(s!=='none'&&s!=='x')r=s;}"
                    + "return r;}"
                    + "return go(window);})()";

    /** Play/pause the first video in the page or any same-origin frame. */
    private static final String TOGGLE_JS =
            "(function(){function go(w){try{var v=w.document.querySelector('video');"
                    + "if(v){if(v.paused){v.play();return 'play';}v.pause();return 'pause';}}catch(e){}"
                    + "for(var i=0;i<w.frames.length;i++){var s=go(w.frames[i]);if(s)return s;}return null;}"
                    + "return go(window)||'none';})()";

    /**
     * Pulls the player embed out of a stream page the WebView has already loaded (used when the
     * background fetch could not, e.g. rate limiting). Returns "" when there is none.
     */
    private static final String FIND_EMBED_JS =
            "(function(){var f=document.querySelector('#se-player-root iframe,iframe#iframe,.se-player iframe');"
                    + "return f&&f.src?f.src:'';})()";

    private static final int AUTOPLAY_ATTEMPTS = 20;
    private static final long AUTOPLAY_INTERVAL_MS = 700L;

    private RemoteConfig config;
    private boolean playerMode;
    /** True when the WebView shows a resolved player page rather than the site's stream page. */
    private boolean directMode;
    private String directHost;
    private String streamPageUrl;
    /** Set when the stream page is being shown only because resolving failed; retry from its DOM. */
    private boolean embedLookupPending;
    private int autoplayAttempts;
    private final ExecutorService resolver = Executors.newSingleThreadExecutor();

    private FrameLayout root;
    private WebView webView;
    private CursorView cursor;
    private View loadingOverlay;

    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean cursorVisible = true;
    private final Runnable hideCursorRunnable = () -> {
        cursorVisible = false;
        cursor.animate().alpha(0f).setDuration(250).start();
    };
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

        // Cleared in onStop(). If it is still set on the next launch, this screen was killed
        // without a Java exception (WebView native crash / system kill); HomeActivity reports it.
        CrashLog.markPlayerOpen(this, url);

        streamPageUrl = url;
        if (savedInstanceState != null) {
            directMode = savedInstanceState.getBoolean(STATE_DIRECT, false);
            directHost = savedInstanceState.getString(STATE_DIRECT_HOST);
            if (directMode) {
                cursor.setAlpha(0f);
                cursorVisible = false;
            }
            webView.restoreState(savedInstanceState);
        } else if (playerMode && getIntent().hasExtra(EXTRA_EMBED_URL)) {
            loadDirect(new StreamResolver.Target(getIntent().getStringExtra(EXTRA_EMBED_URL),
                    getIntent().getStringExtra(EXTRA_EMBED_REFERER)));
        } else if (playerMode && config.directPlayer) {
            openDirect(url);
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
        int w = (int) (300 * density);
        int h = (int) (46 * density);
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
    private static String jsString(String s) {
        return JSONObject.quote(s);
    }

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
        if (directMode) {
            injectCss(view, "styx-direct", DIRECT_CSS);
        } else if (playerMode) {
            applyViewport(view);
            injectCss(view, "styx-player", config.playerCss);
        }
    }

    /**
     * Resolves the stream page to its innermost player page off the main thread and loads that
     * full screen. Falls back to the stream page itself (premium gate, countdown, unknown markup).
     */
    private void openDirect(String pageUrl) {
        showLoadingOverlay();
        handler.removeCallbacks(hideOverlayRunnable); // keep the splash up while resolving
        resolver.execute(() -> {
            StreamResolver.Target target = null;
            try {
                target = new StreamResolver(config.parser).resolve(pageUrl).active.embed;
            } catch (Exception e) {
                Log.w(TAG, "resolve failed: " + e);
            }
            final StreamResolver.Target resolved = target;
            handler.post(() -> {
                if (isFinishing() || webView == null) return;
                if (resolved == null) {
                    // Show the stream page; onPageFinished() gets a second chance to find the
                    // embed in the rendered page (see tryEmbedFromPage).
                    Log.i(TAG, "no player embed resolved; loading stream page");
                    directMode = false;
                    embedLookupPending = true;
                    webView.loadUrl(pageUrl);
                    return;
                }
                loadDirect(resolved);
            });
        });
    }

    private void loadDirect(StreamResolver.Target target) {
        Log.i(TAG, "direct player " + target.url + " referer " + target.referer);
        directMode = true;
        directHost = StreamResolver.hostOf(target.url);
        embedLookupPending = false;
        // No pointer on a full-screen player; OK toggles play/pause. Arrows bring it back.
        handler.removeCallbacks(hideCursorRunnable);
        cursor.setAlpha(0f);
        cursorVisible = false;
        showLoadingOverlay();
        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", target.referer);
        webView.loadUrl(target.url, headers);
    }

    /** Fallback after the stream page rendered in the WebView: lift its player embed from the DOM. */
    private void tryEmbedFromPage(WebView view, String pageUrl) {
        if (!embedLookupPending) return;
        embedLookupPending = false;
        view.evaluateJavascript(FIND_EMBED_JS, result -> {
            if (webView == null || directMode) return;
            String src = result == null ? "" : result.replace("\"", "").trim();
            if (src.isEmpty() || "null".equals(src)) {
                Log.i(TAG, "stream page has no embed (gate or not started); staying on it");
                return;
            }
            if (!StreamResolver.isEmbedUrl(src, pageUrl)) return;
            loadDirect(new StreamResolver.Target(src, pageUrl));
        });
    }

    /**
     * Embed hosts bounce a player loaded outside an iframe to their own homepage. If that happens
     * (or the embed navigates anywhere else on its host), give up on direct mode and show the
     * site's stream page instead so the user still gets the normal player.
     */
    private boolean handleDirectRedirect(Uri uri) {
        if (!directMode || webView == null) return false;
        String host = uri.getHost();
        if (host == null || !host.equalsIgnoreCase(directHost)) return false;
        String path = uri.getPath() == null ? "" : uri.getPath();
        if (path.isEmpty() || path.equals("/")) {
            Log.i(TAG, "embed bounced to its homepage; falling back to stream page");
            directMode = false;
            directHost = null;
            webView.stopLoading();
            webView.loadUrl(streamPageUrl);
            return true;
        }
        return false;
    }

    private void startAutoplay() {
        autoplayAttempts = 0;
        handler.removeCallbacks(autoplayRunnable);
        handler.post(autoplayRunnable);
    }

    private final Runnable autoplayRunnable = new Runnable() {
        @Override
        public void run() {
            if (webView == null || !directMode) return;
            if (autoplayAttempts++ >= AUTOPLAY_ATTEMPTS) {
                Log.i(TAG, "autoplay gave up");
                hideLoadingOverlay();
                return;
            }
            webView.evaluateJavascript(AUTOPLAY_JS, result -> {
                if (webView == null) return;
                if (result != null && result.contains("playing")) {
                    Log.i(TAG, "video playing after " + autoplayAttempts + " attempt(s)");
                    hideLoadingOverlay();
                    return;
                }
                if (autoplayAttempts == 1 || autoplayAttempts % 5 == 0) Log.i(TAG, "autoplay " + result);
                handler.postDelayed(this, AUTOPLAY_INTERVAL_MS);
            });
        }
    };

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
                Log.i(TAG, "navigate " + request.getUrl());
                if (handleDirectRedirect(request.getUrl())) return true;
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
                Log.i(TAG, "page started " + url);
                if (url != null && handleDirectRedirect(Uri.parse(url))) return;
                showLoadingOverlay();
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // Without this the whole app is killed when the page's renderer dies. Record it,
                // drop the dead WebView and go back to the home screen instead.
                boolean crashed = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && detail.didCrash();
                CrashLog.recordNote(PlayerActivity.this,
                        "WebView renderer " + (crashed ? "crashed" : "was killed (out of memory)")
                                + " while showing " + view.getUrl());
                Toast.makeText(PlayerActivity.this, R.string.player_crashed, Toast.LENGTH_LONG).show();
                if (webView != null) {
                    root.removeView(webView);
                    webView.destroy();
                    webView = null;
                }
                finish();
                return true;
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
                if (directMode) {
                    startAutoplay();
                    return; // overlay comes down once the video is running (or on timeout)
                }
                if (playerMode) tryEmbedFromPage(view, url);
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

        if (directHost != null && host.equals(directHost)) return true;
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
        if (webView == null) return true; // renderer died; the screen is on its way out
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
                if (directMode && !cursorVisible && fullscreenView == null) {
                    // Full-screen player without a pointer: OK is play/pause.
                    if (down && event.getRepeatCount() == 0) webView.evaluateJavascript(TOGGLE_JS, null);
                    return true;
                }
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
                } else if (playerMode) {
                    finish(); // a game is one screen: Back always returns to the home rows
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
        cursorVisible = true;
        scheduleCursorHide();
    }

    private void scheduleCursorHide() {
        handler.postDelayed(hideCursorRunnable, CURSOR_HIDE_DELAY_MS);
    }

    private void togglePlayback() {
        // Only reaches same-origin players; cross-origin player iframes are opaque.
        webView.evaluateJavascript(TOGGLE_JS, null);
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
        if (webView != null) webView.saveState(outState);
        outState.putBoolean(STATE_DIRECT, directMode);
        outState.putString(STATE_DIRECT_HOST, directHost);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webView != null) webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView == null) return;
        webView.onResume();
        applyImmersiveMode();
        CrashLog.markPlayerOpen(this, webView.getUrl() != null ? webView.getUrl() : "");
    }

    @Override
    protected void onStop() {
        // Reached on every orderly exit (Back, Home button, another app on top). A process that
        // dies while a stream is open never gets here, which is what the marker detects.
        CrashLog.notePlayerClosedNormally(this);
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        resolver.shutdownNow();
        exitFullscreen();
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
