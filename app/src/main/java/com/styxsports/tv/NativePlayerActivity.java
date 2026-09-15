package com.styxsports.tv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.OptIn;
import androidx.core.content.ContextCompat;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.Timeline;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.LoadControl;
import androidx.media3.exoplayer.analytics.AnalyticsListener;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.hls.playlist.DefaultHlsPlaylistTracker;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.LoadEventInfo;
import androidx.media3.exoplayer.source.MediaLoadData;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.upstream.DefaultAllocator;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Full-screen native player for a game. Resolves the stream page to its HLS playlist and plays it
 * with ExoPlayer; Left/Right (or the media prev/next and channel keys) switch servers, OK
 * pauses, Back returns home. A failing or stalling server is retried once with a fresh playlist
 * URL and then skipped automatically. When no server can be played natively the site's own web
 * player is used as a fallback ({@link PlayerActivity}).
 */
public class NativePlayerActivity extends Activity {

    private static final String TAG = "StyxNative";
    private static final String EXTRA_EVENT = "event";
    private static final String EXTRA_CHANNEL_GROUP = "channelGroup";
    private static final String EXTRA_CHANNEL_INDEX = "channelIndex";
    private static final String PREFS = "styxsports_servers";

    private static final long HUD_HIDE_MS = 3500L;
    private static final long STALL_MS = 15_000L;
    private static final long START_TIMEOUT_MS = 25_000L;
    /**
     * The premium CDN (re)starts a channel when its first viewer arrives and serves a static
     * playlist for 30-40 s until the encoder catches up; then the sequence jumps. A premium
     * tab gets a little longer to show its first frame; once playing, a stall is a stall.
     */
    private static final long PREMIUM_START_TIMEOUT_MS = 35_000L;
    /**
     * The premium CDN cuts 10 s segments and opens a fresh viewer's window with a single one,
     * growing it by a segment every 10 s to a 60 s slide. Left alone, ExoPlayer starts at the
     * front of that first segment and polls the playlist every target duration (11 s), so it
     * runs dry just before each new segment lands and stalls every cycle; hls.js and Roku drift
     * into a two-segment margin and never do. So on that CDN the player waits for a runway
     * before the first frame, and after a stall for a comfortable one rather than the stock 5 s
     * - one longer pause instead of a stutter every twenty seconds.
     *
     * <p>The runway steps up (4.0): the first frame comes at {@link #RUNWAY_START_MS} (most
     * streams then settle behind the live edge on their own and never stall); a stream that does
     * stall once starts and resumes with {@link #RUNWAY_STEADY_MS} / {@link #RUNWAY_REBUFFER_MS}
     * from then on. Two-segment starts for everyone cost 6 s on every game for a stutter only
     * some streams have.
     */
    private static final long RUNWAY_START_MS = 6_000L;
    private static final long RUNWAY_STEADY_MS = 12_000L;
    private static final long RUNWAY_REBUFFER_MS = 15_000L;
    /** Where in the live window a premium stream is joined when it has that much to offer. */
    private static final long PREMIUM_LIVE_OFFSET_MS = 30_000L;
    /** A rebuffer on the premium CDN may need two new segments (~20 s) before the runway is met. */
    private static final long PREMIUM_STALL_MS = 30_000L;
    /**
     * Self-healing (4.0 phase 2.2): a stream that keeps playing but badly is left for the next
     * best server without a black screen. "Badly" is {@link #DEGRADE_STALLS} stalls within
     * {@link #DEGRADE_WINDOW_MS}, {@link #DEGRADE_LONG_STALLS} stalls longer than the rebuffer
     * runway, or {@link #DEGRADE_ERRORS} segment/playlist load errors within
     * {@link #DEGRADE_ERROR_WINDOW_MS}. The next server is resolved and prepared in a second
     * player (muted, no surface) and swapped in once it is ready with a steady runway; if it
     * never gets there within {@link #STANDBY_TIMEOUT_MS} the next candidate is tried and the
     * degraded stream simply keeps going.
     */
    private static final int DEGRADE_STALLS = 3;
    private static final long DEGRADE_WINDOW_MS = 120_000L;
    private static final int DEGRADE_LONG_STALLS = 2;
    private static final int DEGRADE_ERRORS = 3;
    private static final long DEGRADE_ERROR_WINDOW_MS = 60_000L;
    private static final long STANDBY_TIMEOUT_MS = 40_000L;
    private static final long SCORE_REFRESH_MS = 30_000L;
    /** After this long without an answer, the next server is tried in parallel. */
    private static final long IMPATIENCE_MS = 6_000L;
    /** Behind-live-window recoveries (seek to the live edge) allowed in a row before the server is a failure. */
    private static final int MAX_LIVE_EDGE_RESYNCS = 2;
    /** A resync this long after the previous one starts the count over: the stream was fine in between. */
    private static final long RESYNC_RESET_MS = 90_000L;
    /** The site's unnamed server tabs ("Server 7"). */
    private static final java.util.regex.Pattern GENERIC_TAB = Prefetch.GENERIC_TAB;

    static Intent intent(Context ctx, Event e) {
        Intent i = new Intent(ctx, NativePlayerActivity.class);
        try {
            i.putExtra(EXTRA_EVENT, e.toJson().toString());
        } catch (Exception ignored) {
            // the event still has a URL; the HUD just shows less
        }
        return i;
    }

    /**
     * Plays channel {@code index} of a Live TV group; Left/Right zap through the group. The
     * playlist is read from {@link Iptv} (memory or disk), not passed in the intent.
     */
    static Intent channelIntent(Context ctx, String group, int index) {
        return new Intent(ctx, NativePlayerActivity.class)
                .putExtra(EXTRA_CHANNEL_GROUP, group)
                .putExtra(EXTRA_CHANNEL_INDEX, index);
    }

    private RemoteConfig config;
    private Event event;
    /** Live TV mode: the group being zapped through; null when playing a game's stream page. */
    private String channelGroup;
    private List<Iptv.Channel> channels;
    private StreamResolver resolver;
    private final ExecutorService io = Executors.newCachedThreadPool();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private float density;

    private ExoPlayer player;
    private RunwayLoadControl loadControl;
    private PlayerView playerView;
    private View hudTop, hudBottom;
    private TextView hudTitle, hudPill, hudScore, hudServer, hudHint;
    private View statusPanel;
    private ProgressBar spinner;
    private TextView statusText;
    private LinearLayout statusButtons;

    /** Servers in try order: the account's premium tabs first (when signed in), then the free ones. */
    private final List<StreamResolver.Server> servers = new ArrayList<>();
    private final Map<String, StreamResolver.Stream> resolved = new HashMap<>();
    /** Servers whose stream Home resolved before OK was pressed (telemetry marks their start "pre"). */
    private final Set<String> preResolved = new HashSet<>();
    /** When the viewer asked for what is loading now: the press that opened this screen, then each switch. */
    private long askedAt;
    /** The stream page as fetched; its HTML already embeds the active server. */
    private StreamResolver.Page page;
    private int current = -1;
    /** Servers already re-resolved once after a failure (the playlist token may have expired). */
    private final List<String> retried = new ArrayList<>();
    /** Servers that failed in this auto-fallback sweep. */
    private final List<String> failed = new ArrayList<>();
    private int loadGeneration;
    /** The server whose stream the load control's runway state belongs to (see RUNWAY_STEADY_MS). */
    private String runwayFor = "";
    /** When the current server was selected; used to pace automatic fail-over. */
    private long switchedAt;
    private boolean everPlayed;
    /** The current server was picked by the user; remember it once it actually plays. */
    private boolean manualSelection;
    /** Our slot in the shared premium account's 5-connection pool (needed for premium servers and Live TV). */
    private Pool.Lease lease;
    /** The pool turned us down (all slots taken); premium tabs are skipped until a manual retry. */
    private boolean poolFull;
    private int poolUsed, poolMax = 5;
    /** The playback attempt telemetry is describing (null before the first play()). */
    private Telemetry.Attempt attempt;

    // Self-healing state (see DEGRADE_*). All on the main thread.
    /** Stall starts on the current stream since it first played, oldest first. */
    private final ArrayDeque<Long> stallStarts = new ArrayDeque<>();
    /** When the current stall began (0 while playing). */
    private long stallBeganAt;
    /** Stalls on the current stream that outlasted the rebuffer runway. */
    private int longStalls;
    /** Segment / playlist load errors on the current stream, oldest first. */
    private final ArrayDeque<Long> loadErrors = new ArrayDeque<>();
    /** The player being readied on the next server while the current one limps on (null when none). */
    private ExoPlayer standby;
    private RunwayLoadControl standbyControl;
    private int standbyIndex = -1;
    /** Why a migration is under way ("stalls", "long-stalls", "errors"); null when none. */
    private String migrating;
    private long migrateAskedAt;
    /** Servers left because they degraded: not migrated back to in this sitting (Left/Right still can). */
    private final Set<String> degraded = new HashSet<>();
    private final Runnable standbyTimeout = () -> standbyFailed("no video after " + STANDBY_TIMEOUT_MS / 1000 + "s");

    private final Runnable hideHud = this::hideHud;
    private final Runnable stallCheck = () -> {
        Log.w(TAG, "stalled: " + liveState());
        onFailure("stalled");
    };
    private final Runnable startTimeout = () -> onFailure("no video after " + startTimeoutMs() / 1000 + "s");
    /** Behind-live-window recoveries on the current server (reset on every switch). */
    private int liveEdgeResyncs;
    private long lastResyncAt;
    private final Runnable scoreTick = new Runnable() {
        @Override
        public void run() {
            refreshScore();
            handler.postDelayed(this, SCORE_REFRESH_MS);
        }
    };

    // ---------------------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        askedAt = SystemClock.elapsedRealtime();
        config = RemoteConfig.load(this);
        resolver = new StreamResolver(config.parser);
        density = getResources().getDisplayMetrics().density;
        channelGroup = getIntent().getStringExtra(EXTRA_CHANNEL_GROUP);
        if (channelGroup != null) {
            event = new Event();
            event.id = "iptv:" + channelGroup;
            event.url = "iptv://" + android.net.Uri.encode(channelGroup);
            event.league = channelGroup;
            event.live = true;
        } else {
            event = parseEvent(getIntent().getStringExtra(EXTRA_EVENT));
        }
        if (event == null || event.url.isEmpty()) {
            finish();
            return;
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveMode();
        setContentView(buildUi());
        CrashLog.markPlayerOpen(this, event.url);

        lease = new Pool.Lease(this, io, handler);
        createPlayer();
        showStatus(getString(R.string.np_connecting), true);
        resolvePage();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersiveMode();
        handler.removeCallbacks(scoreTick);
        if (channelGroup == null) handler.postDelayed(scoreTick, SCORE_REFRESH_MS);
    }

    @Override
    protected void onStop() {
        super.onStop();
        // A TV app is either on screen or gone: release everything and re-resolve next time.
        CrashLog.notePlayerClosedNormally(this);
        Telemetry.stop(this, attempt);
        Telemetry.flush();
        boolean backgrounded = !isFinishing();
        // Playback stopped: give the premium slot back. Zapping back to the Live TV screen keeps
        // it (that screen renews the same lease at once); leaving the app from a channel drops it.
        if (lease != null) lease.stop(channelGroup != null && !backgrounded);
        if (backgrounded) finish();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        dropStandby();
        if (player != null) {
            player.release();
            player = null;
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersiveMode();
    }

    private void applyImmersiveMode() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    // ---------------------------------------------------------------------------------------------
    // UI
    // ---------------------------------------------------------------------------------------------

    private int dp(float v) {
        return Math.round(v * density);
    }

    private int color(int res) {
        return ContextCompat.getColor(this, res);
    }

    @OptIn(markerClass = UnstableApi.class) // PlayerView shutter/reset setters
    private View buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        playerView = new PlayerView(this);
        playerView.setUseController(false);
        playerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        playerView.setShutterBackgroundColor(Color.BLACK);
        playerView.setKeepContentOnPlayerReset(false);
        root.addView(playerView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // --- HUD: title/score at the top, server + hints at the bottom, on soft gradients.
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.VERTICAL);
        top.setPadding(dp(48), dp(28), dp(48), dp(36));
        top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[] {0xCC000000, 0x00000000}));
        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setOrientation(LinearLayout.HORIZONTAL);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        hudPill = new TextView(this);
        hudPill.setTextSize(12);
        hudPill.setTypeface(Typeface.DEFAULT_BOLD);
        hudPill.setTextColor(Color.WHITE);
        hudPill.setPadding(dp(9), dp(3), dp(9), dp(3));
        titleRow.addView(hudPill);
        hudTitle = new TextView(this);
        hudTitle.setTextColor(Color.WHITE);
        hudTitle.setTextSize(22);
        hudTitle.setTypeface(Typeface.DEFAULT_BOLD);
        hudTitle.setSingleLine(true);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        tp.leftMargin = dp(14);
        titleRow.addView(hudTitle, tp);
        top.addView(titleRow);
        hudScore = new TextView(this);
        hudScore.setTextColor(0xFFDDDDDD);
        hudScore.setTextSize(16);
        LinearLayout.LayoutParams scp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        scp.topMargin = dp(6);
        top.addView(hudScore, scp);
        hudTop = top;
        root.addView(top, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));

        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setPadding(dp(48), dp(40), dp(48), dp(26));
        bottom.setBackground(new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[] {0xCC000000, 0x00000000}));
        hudServer = new TextView(this);
        hudServer.setTextColor(Color.WHITE);
        hudServer.setTextSize(16);
        hudServer.setTypeface(Typeface.DEFAULT_BOLD);
        bottom.addView(hudServer);
        hudHint = new TextView(this);
        hudHint.setTextColor(0xFFBBBBBB);
        hudHint.setTextSize(13);
        hudHint.setText(channelGroup != null ? R.string.np_hint_channels : R.string.np_hint);
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hp.topMargin = dp(4);
        bottom.addView(hudHint, hp);
        hudBottom = bottom;
        root.addView(bottom, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));

        // --- Centre status: spinner + message + buttons (errors, premium).
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        spinner = new ProgressBar(this);
        panel.addView(spinner, new LinearLayout.LayoutParams(dp(40), dp(40)));
        statusText = new TextView(this);
        statusText.setTextColor(Color.WHITE);
        statusText.setTextSize(17);
        statusText.setGravity(Gravity.CENTER);
        statusText.setMaxWidth(dp(560));
        LinearLayout.LayoutParams stp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stp.topMargin = dp(16);
        panel.addView(statusText, stp);
        statusButtons = new LinearLayout(this);
        statusButtons.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.topMargin = dp(22);
        panel.addView(statusButtons, bp);
        statusPanel = panel;
        root.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        bindHud();
        return root;
    }

    private TextView pillButton(String label, View.OnClickListener onClick) {
        TextView b = new TextView(this);
        b.setText(label);
        b.setTextColor(ContextCompat.getColorStateList(this, R.color.button_text));
        b.setTextSize(14);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(dp(18), dp(9), dp(18), dp(9));
        b.setBackgroundResource(R.drawable.button_bg);
        b.setFocusable(true);
        b.setClickable(true);
        b.setOnClickListener(onClick);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.rightMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    private void bindHud() {
        hudTitle.setText(event.title());
        if (event.ended) {
            hudPill.setText(R.string.pill_final);
            hudPill.setBackground(pill(color(R.color.pill_time)));
            hudPill.setVisibility(View.VISIBLE);
        } else if (event.live) {
            String txt = getString(R.string.pill_live);
            if (!event.liveText.isEmpty()) txt += "  " + event.liveText;
            hudPill.setText(txt);
            hudPill.setBackground(pill(color(R.color.live)));
            hudPill.setVisibility(View.VISIBLE);
        } else {
            hudPill.setVisibility(View.GONE);
        }
        StringBuilder sb = new StringBuilder();
        if (!event.score.isEmpty() && !event.away.isEmpty()) {
            sb.append(event.home).append("  ").append(event.score.replace(" - ", " – "))
                    .append("  ").append(event.away);
        }
        hudScore.setText(sb);
        hudScore.setVisibility(sb.length() == 0 ? View.GONE : View.VISIBLE);
        bindServerLabel();
    }

    private void bindServerLabel() {
        if (current < 0 || servers.isEmpty()) {
            hudServer.setText("");
            return;
        }
        StreamResolver.Server s = servers.get(current);
        String label = channelGroup != null
                ? getString(R.string.np_channel_of, current + 1, servers.size(), channelGroup)
                : getString(R.string.np_server_of, current + 1, servers.size(), s.name);
        if (s.premium) label += "   ·   ★ " + getString(R.string.np_premium_marker);
        if (player != null && !player.getPlayWhenReady() && everPlayed) {
            label += "   ·   " + getString(R.string.np_paused);
        }
        hudServer.setText(label);
    }

    private GradientDrawable pill(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(5));
        return d;
    }

    private void showHud() {
        handler.removeCallbacks(hideHud);
        bindServerLabel();
        fade(hudTop, true);
        fade(hudBottom, true);
        boolean paused = player != null && !player.getPlayWhenReady();
        if (!paused) handler.postDelayed(hideHud, HUD_HIDE_MS);
    }

    private void hideHud() {
        handler.removeCallbacks(hideHud);
        fade(hudTop, false);
        fade(hudBottom, false);
    }

    private void fade(View v, boolean in) {
        v.animate().cancel();
        if (in) {
            v.setVisibility(View.VISIBLE);
            v.animate().alpha(1f).setDuration(180).start();
        } else {
            v.animate().alpha(0f).setDuration(260)
                    .withEndAction(() -> v.setVisibility(View.INVISIBLE)).start();
        }
    }

    private void showStatus(String message, boolean busy) {
        statusPanel.setVisibility(View.VISIBLE);
        spinner.setVisibility(busy ? View.VISIBLE : View.GONE);
        statusText.setText(message);
        statusButtons.removeAllViews();
        statusButtons.setVisibility(View.GONE);
    }

    private void showStatusWithActions(String message, boolean allowWeb) {
        showStatus(message, false);
        statusButtons.setVisibility(View.VISIBLE);
        statusButtons.addView(pillButton(getString(R.string.action_retry), v -> retryAll()));
        StreamResolver.Stream cur = currentStream();
        if (allowWeb && cur != null && cur.embed != null) {
            statusButtons.addView(pillButton(getString(R.string.np_open_web), v -> openWebPlayer(cur)));
        }
        statusButtons.addView(pillButton(getString(R.string.np_back_home), v -> finish()));
        statusButtons.getChildAt(0).requestFocus();
    }

    private void hideStatus() {
        statusPanel.setVisibility(View.GONE);
    }

    // ---------------------------------------------------------------------------------------------
    // Resolution and playback
    // ---------------------------------------------------------------------------------------------

    private static final AudioAttributes AUDIO = new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build();

    @OptIn(markerClass = UnstableApi.class) // setVideoScalingMode, LoadControl
    private void createPlayer() {
        loadControl = new RunwayLoadControl();
        player = new ExoPlayer.Builder(this).setLoadControl(loadControl).build();
        player.setAudioAttributes(AUDIO, true);
        player.setVideoScalingMode(C.VIDEO_SCALING_MODE_SCALE_TO_FIT);
        player.addListener(mainListener);
        player.addAnalyticsListener(loadErrorListener);
        playerView.setPlayer(player);
    }

    /** Segment / playlist fetches that failed (ExoPlayer retries them itself): a burst is a degraded stream. */
    @OptIn(markerClass = UnstableApi.class)
    private final AnalyticsListener loadErrorListener = new AnalyticsListener() {
        @Override
        public void onLoadError(AnalyticsListener.EventTime t, LoadEventInfo info, MediaLoadData data, IOException e, boolean cancelled) {
            if (!everPlayed || cancelled) return;
            long now = SystemClock.elapsedRealtime();
            loadErrors.addLast(now);
            while (!loadErrors.isEmpty() && now - loadErrors.peekFirst() > DEGRADE_ERROR_WINDOW_MS) loadErrors.pollFirst();
            Log.w(TAG, "load error (" + loadErrors.size() + " in " + DEGRADE_ERROR_WINDOW_MS / 1000 + " s): " + describe(e));
            checkHealth();
        }
    };

    private final Player.Listener mainListener = new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING) {
                    handler.removeCallbacks(stallCheck);
                    handler.postDelayed(stallCheck, onPremiumCdn() ? PREMIUM_STALL_MS : STALL_MS);
                    if (attempt != null) Telemetry.stallBegan(attempt);
                    if (everPlayed) {
                        showStatus(getString(R.string.np_buffering), true);
                        Log.i(TAG, "buffering: " + liveState());
                        // This stream ran dry once: from here on it starts and resumes with the
                        // longer runway (see RUNWAY_STEADY_MS) instead of stuttering every cycle.
                        if (loadControl.runway && !loadControl.stalled) {
                            loadControl.stalled = true;
                            Log.i(TAG, "runway: stepping up to " + RUNWAY_STEADY_MS / 1000 + " s for this stream");
                        }
                        long now = SystemClock.elapsedRealtime();
                        stallBeganAt = now;
                        stallStarts.addLast(now);
                        while (!stallStarts.isEmpty() && now - stallStarts.peekFirst() > DEGRADE_WINDOW_MS) stallStarts.pollFirst();
                        checkHealth();
                    }
                } else if (state == Player.STATE_READY) {
                    Log.i(TAG, (everPlayed ? "resumed: " : "ready: ") + liveState());
                    handler.removeCallbacks(stallCheck);
                    handler.removeCallbacks(startTimeout);
                    handler.removeCallbacks(impatience);
                    if (attempt != null) {
                        if (!attempt.started()) Telemetry.start(NativePlayerActivity.this, attempt);
                        else Telemetry.stallEnded(NativePlayerActivity.this, attempt, player.getCurrentPosition());
                    }
                    if (stallBeganAt > 0) {
                        long stall = SystemClock.elapsedRealtime() - stallBeganAt;
                        stallBeganAt = 0;
                        if (stall > RUNWAY_REBUFFER_MS) longStalls++;
                        checkHealth();
                    }
                    hideStatus();
                    if (channelGroup == null && lease.held() && current < servers.size() && !servers.get(current).premium) {
                        // A free server is what plays (the premium tabs failed, or the viewer
                        // picked it): the shared slot is someone else's to take. A later premium
                        // pick acquires again.
                        Log.i(TAG, "free server playing: giving the pool slot back");
                        lease.release();
                    }
                    if (!everPlayed) {
                        everPlayed = true;
                        failed.clear();
                        if (channelGroup != null && channels != null && current < channels.size()) {
                            Iptv.recordRecent(NativePlayerActivity.this, channels.get(current));
                        } else if (manualSelection) {
                            rememberServer();
                        }
                        showHud();
                    }
                } else if (state == Player.STATE_ENDED) {
                    onFailure("stream ended");
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Log.w(TAG, "player error: " + error.getErrorCodeName() + " " + describe(error.getCause())
                        + " | " + liveState());
                long now = SystemClock.elapsedRealtime();
                if (liveEdgeResyncs > 0 && now - lastResyncAt > RESYNC_RESET_MS) liveEdgeResyncs = 0;
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW
                        && liveEdgeResyncs < MAX_LIVE_EDGE_RESYNCS) {
                    // The live window moved past us (the premium CDN's sequence jumps once a
                    // restarted channel catches up): rejoin at the live edge, same stream.
                    liveEdgeResyncs++;
                    lastResyncAt = now;
                    Log.i(TAG, "rejoining the live edge (" + liveEdgeResyncs + ")");
                    showStatus(getString(R.string.np_buffering), true);
                    player.seekToDefaultPosition();
                    player.prepare();
                    return;
                }
                if (error.errorCode == PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED) {
                    peekManifest(currentStream());
                }
                onFailure(error.getErrorCodeName());
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                bindServerLabel();
            }
    };

    // ---------------------------------------------------------------------------------------------
    // Self-healing: leave a degraded stream for the next best server without a black screen
    // ---------------------------------------------------------------------------------------------

    /** Is the current stream degraded enough to leave? Starts a migration when it is. */
    private void checkHealth() {
        // Live TV: the viewer chose this channel; the stall timer is the only judge there.
        if (channelGroup != null || !everPlayed || migrating != null || standby != null || isFinishing()) return;
        String why = null;
        if (stallStarts.size() >= DEGRADE_STALLS) why = "stalls";
        else if (longStalls >= DEGRADE_LONG_STALLS) why = "long-stalls";
        else if (loadErrors.size() >= DEGRADE_ERRORS) why = "errors";
        if (why != null) migrate(why);
    }

    /** Debug: pretend the stream just hit the stall threshold. */
    private void checkHealthForced() {
        if (migrating != null || standby != null) return;
        long now = SystemClock.elapsedRealtime();
        while (stallStarts.size() < DEGRADE_STALLS) stallStarts.addLast(now);
        checkHealth();
    }

    /** The current stream is degraded: ready the next best server in a second player. */
    private void migrate(String why) {
        if (current < 0 || current >= servers.size()) return;
        StreamResolver.Server from = servers.get(current);
        degraded.add(from.pageUrl);
        // The next best in preference order (the list already has premium tabs first while we
        // hold a slot): not this one, not failed, not one we already left as degraded. Premium
        // tabs only while a slot is held - acquiring one mid-game is the manual path's job.
        StreamResolver.Server pick = null;
        int pickIdx = -1;
        for (int i = 0; i < servers.size(); i++) {
            StreamResolver.Server s = servers.get(i);
            if (i == current || failed.contains(s.pageUrl) || degraded.contains(s.pageUrl)) continue;
            if (s.premium && !lease.held()) continue;
            pick = s;
            pickIdx = i;
            break;
        }
        if (pick == null) {
            Log.i(TAG, from.name + " is degraded (" + why + ") but there is no other server to move to");
            return;
        }
        migrating = why;
        migrateAskedAt = SystemClock.elapsedRealtime();
        standbyIndex = pickIdx;
        Log.i(TAG, from.name + " is degraded (" + why + ", " + liveState() + "); readying " + pick.name + " alongside");
        final StreamResolver.Server target = pick;
        final int idx = pickIdx;
        io.execute(() -> {
            StreamResolver.Stream st;
            try {
                st = resolveServer(target); // fresh: signed playlist URLs are short-lived
            } catch (Exception e) {
                st = null;
                Log.w(TAG, target.name + " resolve failed: " + e);
            }
            final StreamResolver.Stream got = st;
            handler.post(() -> {
                if (isFinishing() || migrating == null || standbyIndex != idx) return;
                if (got != null) resolved.put(target.pageUrl, got);
                if (got == null || !got.playableNatively()) {
                    standbyFailed(got == null ? "resolve failed" : "no player (" + got.state + ")");
                    return;
                }
                startStandby(got);
            });
        });
    }

    @OptIn(markerClass = UnstableApi.class)
    private void startStandby(StreamResolver.Stream st) {
        Prepared p = prepare(st);
        standbyControl = new RunwayLoadControl();
        standbyControl.runway = p.runway;
        standbyControl.stalled = true; // it takes over from a limping stream: start it with the steady runway
        standby = new ExoPlayer.Builder(this).setLoadControl(standbyControl).build();
        // No audio focus and no sound until it is on screen; without a surface the video
        // renderer decodes to a placeholder, so READY means real frames are flowing.
        standby.setAudioAttributes(AUDIO, false);
        standby.setVolume(0f);
        standby.setVideoScalingMode(C.VIDEO_SCALING_MODE_SCALE_TO_FIT);
        standby.addListener(standbyListener);
        standby.setMediaSource(p.source);
        standby.prepare();
        standby.setPlayWhenReady(true);
        handler.removeCallbacks(standbyTimeout);
        handler.postDelayed(standbyTimeout, STANDBY_TIMEOUT_MS);
        Log.i(TAG, "standby: " + st.server.name + " via " + StreamResolver.hostOf(st.hlsUrl));
    }

    private final Player.Listener standbyListener = new Player.Listener() {
        @Override
        public void onPlaybackStateChanged(int state) {
            if (state == Player.STATE_READY) swapToStandby(true);
            else if (state == Player.STATE_ENDED) standbyFailed("ended");
        }

        @Override
        public void onPlayerError(PlaybackException error) {
            standbyFailed(error.getErrorCodeName());
        }
    };

    /**
     * The standby becomes the player on screen and the degraded one is released: with frames
     * ({@code ready}) the swap is seamless; promoted early (the old stream died first) it shows
     * the connecting overlay and the usual READY handling takes it from there.
     */
    @OptIn(markerClass = UnstableApi.class) // analytics listener
    private void swapToStandby(boolean ready) {
        if (standby == null || standbyIndex < 0 || standbyIndex >= servers.size()) return;
        handler.removeCallbacks(standbyTimeout);
        handler.removeCallbacks(stallCheck);
        handler.removeCallbacks(startTimeout);
        ExoPlayer old = player;
        StreamResolver.Server from = current >= 0 && current < servers.size() ? servers.get(current) : null;
        StreamResolver.Server to = servers.get(standbyIndex);
        StreamResolver.Stream st = resolved.get(to.pageUrl);
        Log.i(TAG, (ready ? "switching to " : "promoting ") + to.name + " (" + migrating + "); " + liveState());

        standby.removeListener(standbyListener);
        standby.addListener(mainListener);
        standby.addAnalyticsListener(loadErrorListener);
        standby.setAudioAttributes(AUDIO, true);
        standby.setVolume(1f);
        playerView.setPlayer(standby);
        player = standby;
        loadControl = standbyControl;
        standby = null;
        standbyControl = null;
        old.removeListener(mainListener);
        old.removeAnalyticsListener(loadErrorListener);
        old.release();

        // Bookkeeping the normal path does in switchTo()/play()/READY.
        Telemetry.stop(this, attempt);
        if (from != null) Telemetry.switched(this, from.name, to.name, "degraded-" + migrating);
        current = standbyIndex;
        standbyIndex = -1;
        migrating = null;
        manualSelection = false;
        liveEdgeResyncs = 0;
        retried.remove(to.pageUrl);
        runwayFor = to.pageUrl;
        stallStarts.clear();
        loadErrors.clear();
        stallBeganAt = 0;
        longStalls = 0;
        if (st != null) {
            boolean relay = st.hlsUrl.startsWith(Pool.WEB + "/hls/") || st.hlsUrl.startsWith(Pool.WEB + "/ts/");
            attempt = new Telemetry.Attempt(event.id, to.name,
                    relay ? StreamResolver.hostOf(st.playerOrigin) : StreamResolver.hostOf(st.hlsUrl), to.premium, relay);
            attempt.startedAt = migrateAskedAt;
        } else {
            attempt = null;
        }
        bindServerLabel();
        if (!ready) {
            // Not playing yet: the READY handler reports the start, clears the sweep and
            // releases a slot a free server does not need; the start timeout still applies.
            everPlayed = false;
            switchedAt = System.currentTimeMillis();
            showStatus(getString(R.string.np_connecting_to, to.name), true);
            showHud();
            handler.postDelayed(startTimeout, startTimeoutMs());
            return;
        }
        if (attempt != null) Telemetry.start(this, attempt);
        if (!to.premium && lease.held()) {
            Log.i(TAG, "free server playing: giving the pool slot back");
            lease.release();
        }
        hideStatus();
        showHud();
        Toast.makeText(this, getString(R.string.np_migrated, to.name), Toast.LENGTH_SHORT).show();
    }

    /** The standby did not get going: drop it, and try the next candidate for the same reason. */
    private void standbyFailed(String why) {
        if (migrating == null) return;
        String reason = migrating;
        StreamResolver.Server s = standbyIndex >= 0 && standbyIndex < servers.size() ? servers.get(standbyIndex) : null;
        Log.w(TAG, "standby " + (s == null ? "?" : s.name) + " failed: " + why);
        if (s != null && !failed.contains(s.pageUrl)) failed.add(s.pageUrl);
        dropStandby();
        // The degraded stream is still on screen; look for another candidate right away.
        migrate(reason);
    }

    /** Forget any migration in progress (a manual switch, a failure sweep, or leaving). */
    private void dropStandby() {
        handler.removeCallbacks(standbyTimeout);
        if (standby != null) {
            standby.removeListener(standbyListener);
            standby.release();
            standby = null;
            standbyControl = null;
        }
        standbyIndex = -1;
        migrating = null;
    }

    private void resolvePage() {
        final int gen = ++loadGeneration;
        if (channelGroup != null) {
            io.execute(() -> {
                Iptv list = Iptv.cached(this);
                if (list == null) {
                    try {
                        list = Iptv.fetch(this);
                    } catch (Exception e) {
                        final String why = shortError(e);
                        handler.post(() -> {
                            if (gen != loadGeneration || isFinishing()) return;
                            showStatusWithActions(getString(R.string.np_page_failed, why), false);
                        });
                        return;
                    }
                }
                final Iptv.Group g = Iptv.RECENT_GROUP.equals(channelGroup)
                        ? new Iptv.Group(channelGroup, Iptv.recents(this)) : list.group(channelGroup);
                handler.post(() -> {
                    if (gen != loadGeneration || isFinishing()) return;
                    onChannelsLoaded(g);
                });
            });
            return;
        }
        io.execute(() -> {
            try {
                final StreamResolver.Page p = fetchPage();
                handler.post(() -> {
                    if (gen != loadGeneration || isFinishing()) return;
                    onPageResolved(p);
                });
            } catch (Exception e) {
                Log.w(TAG, "resolve failed: " + e);
                handler.post(() -> {
                    if (gen != loadGeneration || isFinishing()) return;
                    showStatusWithActions(getString(R.string.np_page_failed, shortError(e)), false);
                });
            }
        });
    }

    /** The stream page's server tabs: what Home pre-fetched while the card had focus, else read now. Blocking. */
    private StreamResolver.Page fetchPage() throws IOException {
        return Prefetch.page(this, resolver, event);
    }

    private void onPageResolved(StreamResolver.Page p) {
        page = p;
        // Streams Home resolved while the card had focus play straight away (loadServer finds
        // them in `resolved`); the pool lease below turns Home's pre-warm into ours.
        Map<String, StreamResolver.Stream> ahead = Prefetch.streams(event.id);
        if (!ahead.isEmpty()) {
            resolved.putAll(ahead);
            preResolved.addAll(ahead.keySet());
            Log.i(TAG, ahead.size() + " server(s) pre-resolved");
        }
        // Premium tabs on the page and a way to play them (own account, or an account someone
        // shared through the pool): take a slot in the connection pool before touching a
        // premium server (like app.js resolvePage). Denied: the free servers are used and the
        // viewer is told.
        boolean hasPremium = false;
        for (StreamResolver.Server s : p.servers) if (s.premium) hasPremium = true;
        if (premiumCapable() && hasPremium && !lease.held()) {
            final int gen = loadGeneration;
            lease.acquire("game", event.title(), r -> {
                if (gen != loadGeneration || isFinishing()) return;
                notePool(r);
                arrangeServers(p);
            });
            return;
        }
        arrangeServers(p);
    }

    /**
     * Can this device play premium tabs at all: its own account unless that is known to lack
     * premium, otherwise an account shared through the pool (played via the Worker).
     */
    private boolean premiumCapable() {
        return Prefetch.premiumCapable(this);
    }

    /** Remembers a pool answer and, when it was a refusal, says so. */
    private void notePool(Pool.Reply r) {
        poolUsed = r.used;
        poolMax = r.max;
        poolFull = r.ok && !r.granted;
        if (r.granted) return;
        String note = r.ok ? getString(R.string.pool_full_note, r.used, r.max) : getString(R.string.pool_unreachable_note);
        Toast.makeText(this, note, Toast.LENGTH_LONG).show();
    }

    private void arrangeServers(StreamResolver.Page p) {
        servers.clear();
        // With a pool slot (own account or a shared one): the premium servers go first and are
        // tried first; a premium tab that turns out to be locked (account without premium)
        // simply fails over to the free ones like any other dead server. Signed out with
        // nothing shared: premium tabs are skipped entirely. Pool full: start on free; the
        // premium tabs stay reachable with Left/Right, which asks the pool again.
        boolean signedIn = Account.isSignedIn(this);
        boolean capable = premiumCapable();
        boolean premiumLocked = (signedIn && Boolean.FALSE.equals(Account.premiumKnown(this))) || (capable && !lease.held());
        List<StreamResolver.Server> premium = new ArrayList<>();
        List<StreamResolver.Server> free = new ArrayList<>();
        for (StreamResolver.Server s : p.servers) {
            if (!s.premium) free.add(s);
            else if (signedIn || capable) premium.add(s);
        }
        // Named premium tabs ("Redzone 1", "Raiders") are the site's own players and resolve;
        // its generic "Server N" premium tabs are third-party embeds (embed.st) that no native
        // player can read. Try the named ones first so the sweep does not burn time on the rest.
        List<StreamResolver.Server> named = new ArrayList<>();
        List<StreamResolver.Server> generic = new ArrayList<>();
        for (StreamResolver.Server s : premium) (GENERIC_TAB.matcher(s.name).matches() ? generic : named).add(s);
        premium.clear();
        premium.addAll(named);
        premium.addAll(generic);
        if (premiumLocked) {
            // Known not to be premium: keep the tabs reachable with Left/Right but start on free.
            servers.addAll(free);
            servers.addAll(premium);
        } else {
            servers.addAll(premium);
            servers.addAll(free);
        }
        if (servers.isEmpty()) {
            showPremiumOnly();
            return;
        }
        if (free.isEmpty() && poolFull) {
            // Every server is premium and the shared account's connections are all taken.
            showStatusWithActions(getString(R.string.pool_full_only, poolUsed, poolMax), false);
            return;
        }
        // No slot: the automatic sweep (and the impatience race) leave the premium tabs alone.
        if (poolFull) for (StreamResolver.Server s : premium) if (!failed.contains(s.pageUrl)) failed.add(s.pageUrl);

        int start = 0;
        StreamResolver.Server active = p.servers.get(p.activeIndex);
        if (servers.contains(active) && (premium.isEmpty() || premiumLocked)) start = servers.indexOf(active);

        // Prefer the server that worked last time for this game, unless a premium server has
        // become available since (a fresh sign-in) and the remembered one is a free server.
        String preferred = prefs().getString(event.id, null);
        if (preferred != null) {
            for (int i = 0; i < servers.size(); i++) {
                StreamResolver.Server s = servers.get(i);
                if (!s.pageUrl.equals(preferred)) continue;
                if (s.premium && poolFull) continue;
                if (s.premium || premium.isEmpty() || premiumLocked) start = i;
            }
        }
        Log.i(TAG, "servers: " + servers.size() + " (" + premium.size() + " premium, signedIn=" + signedIn
                + ", locked=" + premiumLocked + "), starting at " + start);
        switchTo(start, false);
    }

    /** Live TV: every channel of the group becomes a "server", so Left/Right zap through them. */
    private void onChannelsLoaded(Iptv.Group g) {
        servers.clear();
        resolved.clear();
        channels = g == null ? null : g.channels;
        if (channels == null || channels.isEmpty()) {
            showStatusWithActions(getString(R.string.np_page_failed, getString(R.string.ltv_group_gone)), false);
            return;
        }
        int start = getIntent().getIntExtra(EXTRA_CHANNEL_INDEX, 0);
        String origin = StreamResolver.originOf(new SiteRepository(this).currentBase(config));
        for (Iptv.Channel c : channels) {
            StreamResolver.Server s = new StreamResolver.Server(c.name, c.url, false, false);
            servers.add(s);
            resolved.put(c.url, new StreamResolver.Stream(s, c.url, origin, null, "live"));
        }
        if (start < 0 || start >= servers.size()) start = 0;
        Log.i(TAG, "live tv: " + servers.size() + " channels in " + channelGroup + ", starting at " + start);
        // Live TV counts toward the account's 5 connections: the Live TV screen took the slot;
        // renew it under this channel's name (a fresh acquire when it lapsed).
        if ((Account.isSignedIn(this) || Pool.sharedIptv(this)) && !lease.held()) {
            final int gen = loadGeneration;
            final int first = start;
            lease.acquire("tv", servers.get(first).name, r -> {
                if (gen != loadGeneration || isFinishing()) return;
                if (!r.granted && r.ok) {
                    poolUsed = r.used;
                    poolMax = r.max;
                    poolFull = true;
                    showStatusWithActions(getString(R.string.ltv_pool_full, r.used, r.max), false);
                    return;
                }
                switchTo(first, false);
            });
            return;
        }
        switchTo(start, false);
    }

    /** Every server is premium and none is available to us. */
    private void showPremiumOnly() {
        if (Account.isSignedIn(this) || Pool.sharedAvailable(this)) {
            showStatusWithActions(getString(R.string.np_premium_only), false);
            return;
        }
        showStatus(getString(R.string.np_premium_only_signed_out), false);
        statusButtons.setVisibility(View.VISIBLE);
        statusButtons.addView(pillButton(getString(R.string.np_sign_in), v -> {
            startActivity(AccountActivity.intent(this));
            finish();
        }));
        statusButtons.addView(pillButton(getString(R.string.np_back_home), v -> finish()));
        statusButtons.getChildAt(0).requestFocus();
    }

    /** Loads server {@code index}; {@code manual} resets the automatic fallback sweep. */
    private void switchTo(int index, boolean manual) {
        if (servers.isEmpty()) return;
        index = ((index % servers.size()) + servers.size()) % servers.size();
        current = index;
        switchedAt = System.currentTimeMillis();
        manualSelection = manual;
        if (manual) {
            failed.clear();
            retried.clear();
            // Left/Right: the wait the viewer feels starts now (the automatic sweep keeps the
            // original press so a fail-over's start time counts the failed server too).
            askedAt = SystemClock.elapsedRealtime();
        }
        everPlayed = false;
        liveEdgeResyncs = 0;
        dropStandby(); // a switch by hand or by the sweep supersedes any migration under way
        handler.removeCallbacks(stallCheck);
        handler.removeCallbacks(startTimeout);
        player.stop();
        player.clearMediaItems();
        Telemetry.stop(this, attempt);
        attempt = null;
        StreamResolver.Server s = servers.get(index);
        if (channelGroup != null) {
            event.home = s.name;
            hudTitle.setText(s.name);
            lease.setLabel(s.name);
        }
        showStatus(getString(R.string.np_connecting_to, s.name), true);
        bindServerLabel();
        showHud();

        // A premium tab picked by hand (or after the lease lapsed): (re)acquire a pool slot first.
        if (channelGroup == null && s.premium && premiumCapable() && !lease.held()) {
            final int gen = ++loadGeneration;
            handler.removeCallbacks(impatience);
            lease.acquire("game", event.title(), r -> {
                if (gen != loadGeneration || isFinishing()) return;
                notePool(r);
                if (r.granted) {
                    loadServer(s, manual);
                } else {
                    // Every premium tab is out of reach until the pool has room again.
                    for (StreamResolver.Server o : servers) if (o.premium && !failed.contains(o.pageUrl)) failed.add(o.pageUrl);
                    onFailure("pool");
                }
            });
            return;
        }
        loadServer(s, manual);
    }

    private void loadServer(StreamResolver.Server s, boolean manual) {
        StreamResolver.Stream cached = resolved.get(s.pageUrl);
        if (channelGroup != null && cached != null) {
            // Live TV channels are direct URLs, but the CDN redirects each to the edge that
            // serves its (IP-bound) segments and answers warming.ts while a channel spins up:
            // look once from here, then play from the final URL.
            final int gen = ++loadGeneration;
            final StreamResolver.Stream direct = cached;
            io.execute(() -> {
                StreamResolver.PlaylistCheck c = StreamResolver.checkPlaylist(direct.hlsUrl, direct.playerOrigin + "/");
                Log.i(TAG, direct.server.name + " playlist check: " + (c.ok ? "ok" : "failed") + " HTTP " + c.code
                        + " at " + StreamResolver.hostOf(c.url) + (c.warming ? " (warming)" : "")
                        + (c.shape().isEmpty() ? "" : " " + c.shape())
                        + (c.error == null ? "" : " " + c.error));
                // The CDN did not answer at all: on a network that blocks it by name, the web
                // relay knows the edge behind it (Relay.channel), and when the edge is blocked
                // too it relays the channel's continuous TS itself (/ts/, progressive playback).
                Relay.Ways ways = null;
                if (!c.ok && c.code == 0) {
                    Log.i(TAG, direct.server.name + ": CDN unreachable from here; asking the web relay");
                    try {
                        ways = Relay.channel(this, direct.server.name, direct.hlsUrl, direct.playerOrigin);
                    } catch (IOException e) {
                        Log.w(TAG, direct.server.name + ": relay has no way to it: " + e.getMessage());
                        ways = new Relay.Ways(null, "blocked");
                    }
                }
                final Relay.Ways via = ways;
                handler.post(() -> {
                    if (gen != loadGeneration || isFinishing()) return;
                    if (c.ok && c.warming) {
                        onFailure("warming");
                    } else if (!c.ok && c.code >= 400) {
                        onFailure(c.error);
                    } else if (via != null && via.url != null) {
                        play(new StreamResolver.Stream(direct.server, via.url, direct.playerOrigin, null, direct.state));
                    } else if (via != null) {
                        onFailure(via.state.isEmpty() ? "unreachable" : via.state);
                    } else {
                        play(new StreamResolver.Stream(direct.server, c.ok ? c.url : direct.hlsUrl, direct.playerOrigin, null, direct.state));
                    }
                });
            });
            return;
        }
        if (cached != null && !retried.contains(s.pageUrl)) {
            play(cached);
            return;
        }
        final int gen = ++loadGeneration;
        handler.removeCallbacks(impatience);
        if (!manual && servers.size() > 1) handler.postDelayed(impatience, IMPATIENCE_MS);
        io.execute(() -> {
            try {
                final StreamResolver.Stream got = resolveServer(s);
                handler.post(() -> {
                    if (isFinishing()) return;
                    resolved.put(s.pageUrl, got); // keep it for manual switching even if superseded
                    if (gen != loadGeneration) return;
                    play(got);
                });
            } catch (Exception e) {
                Log.w(TAG, s.name + " resolve failed: " + e);
                handler.post(() -> {
                    if (gen != loadGeneration || isFinishing()) return;
                    onFailure(shortError(e));
                });
            }
        });
    }

    /** One server tab to a playable stream, the way this network allows (see {@link Prefetch#resolveServer}). Blocking. */
    private StreamResolver.Stream resolveServer(StreamResolver.Server s) throws IOException {
        return Prefetch.resolveServer(this, resolver, s, page, lease.held());
    }

    /**
     * The chosen server is slow to answer (some embed hosts take 15-20 s): start resolving the
     * next one too and play whichever is ready first. The slow one stays available via Left.
     */
    private final Runnable impatience = new Runnable() {
        @Override
        public void run() {
        if (everPlayed || isFinishing() || servers.size() < 2 || current < 0) return;
        if (player != null && player.getPlaybackState() == Player.STATE_BUFFERING && player.getTotalBufferedDuration() > 0) {
            // Segments are arriving: the player is filling its runway, not stuck. Look again
            // later; the start timeout is the real limit.
            Log.i(TAG, servers.get(current).name + " is loading (" + liveState() + "); not racing yet");
            handler.postDelayed(this, IMPATIENCE_MS);
            return;
        }
        final int gen = loadGeneration;
        final int idx = current;
        // A slow premium tab races a free server, never a second premium one: that would cost
        // the shared account another connection and start another channel warming up.
        boolean freeOnly = servers.get(idx).premium;
        int nextIdx = -1;
        for (int i = 1; i < servers.size(); i++) {
            int cand = (idx + i) % servers.size();
            if (!failed.contains(servers.get(cand).pageUrl) && (!freeOnly || !servers.get(cand).premium)) {
                nextIdx = cand;
                break;
            }
        }
        if (nextIdx < 0) return;
        final int alt = nextIdx;
        final StreamResolver.Server s = servers.get(alt);
        Log.i(TAG, servers.get(idx).name + " is slow; also trying " + s.name);
        io.execute(() -> {
            StreamResolver.Stream st;
            try {
                st = resolveServer(s);
            } catch (Exception e) {
                return;
            }
            handler.post(() -> {
                if (isFinishing()) return;
                resolved.put(s.pageUrl, st);
                if (gen != loadGeneration || everPlayed || current != idx || !st.playableNatively()) return;
                if (player.getPlaybackState() == Player.STATE_BUFFERING && player.getTotalBufferedDuration() > 0) {
                    Log.i(TAG, s.name + " answered, but " + servers.get(idx).name + " is loading (" + liveState() + "); staying");
                    return;
                }
                Log.i(TAG, s.name + " answered first; switching");
                current = alt;
                loadGeneration++; // the slow server's answer must not interrupt this one
                bindServerLabel();
                play(st);
            });
        });
        }
    };

    private void play(StreamResolver.Stream st) {
        if (st.server.premium) {
            // What the site gave a premium tab tells us whether the account really has premium.
            if (st.playableNatively() || st.embed != null) Account.notePremium(this, true);
            else if ("gate".equals(st.state)) Account.notePremium(this, false);
        }
        if (!st.playableNatively()) {
            Log.i(TAG, st.server.name + " has no HLS (state=" + st.state + ")");
            // No CDN was reached; the failure below is attributed to the server's player page.
            attempt = new Telemetry.Attempt(channelGroup != null ? "tv" : event.id, st.server.name,
                    st.playerOrigin != null ? StreamResolver.hostOf(st.playerOrigin) : StreamResolver.hostOf(st.server.pageUrl),
                    st.server.premium || channelGroup != null, false);
            // "warming": the CDN's warming.ts placeholder - no video on this server yet, try another.
            // "blocked": this network refuses the premium CDN (nothing was fetched for it).
            onFailure("gate".equals(st.state) ? "premium" : "warming".equals(st.state) ? "warming"
                    : "blocked".equals(st.state) ? "blocked" : "no player");
            return;
        }
        Prepared p = prepare(st);
        // Premium tabs, Live TV and proxied streams: wait for a runway before the first frame
        // and after a stall (see RUNWAY_*).
        loadControl.runway = p.runway;
        // A different stream starts on the short runway again; the same one re-opened after a
        // stall (reconnect, live-edge resync) keeps the steady runway it earned.
        if (!st.server.pageUrl.equals(runwayFor)) loadControl.stalled = false;
        runwayFor = st.server.pageUrl;
        // Relayed streams carry the CDN inside a signed token; the player origin names its family.
        attempt = new Telemetry.Attempt(channelGroup != null ? "tv" : event.id, st.server.name,
                p.relay ? StreamResolver.hostOf(st.playerOrigin) : StreamResolver.hostOf(st.hlsUrl),
                p.premiumCdn, p.relay);
        // Time to first frame counts from the press, not from here: resolving is part of the wait.
        attempt.startedAt = askedAt;
        attempt.pre = preResolved.contains(st.server.pageUrl);
        stallStarts.clear();
        loadErrors.clear();
        stallBeganAt = 0;
        longStalls = 0;
        player.setMediaSource(p.source);
        player.prepare();
        player.setPlayWhenReady(true);
        handler.removeCallbacks(startTimeout);
        handler.postDelayed(startTimeout, startTimeoutMs());
        Log.i(TAG, "playing " + st.server.name + " via " + StreamResolver.hostOf(st.hlsUrl));
    }

    /** A stream's media source and what kind of CDN it is on (shared by the player and the standby). */
    private static final class Prepared {
        MediaSource source;
        /** Premium tab or Live TV channel: the slow-starting premium CDN. */
        boolean premiumCdn;
        /** Through the Worker (proxy or continuous TS): each segment makes two trips. */
        boolean relay;
        /** Wait for a runway before the first frame and after a stall. */
        boolean runway;
    }

    @OptIn(markerClass = UnstableApi.class) // HlsMediaSource / DefaultHttpDataSource (Media3 version is pinned)
    private Prepared prepare(StreamResolver.Stream st) {
        Prepared p = new Prepared();
        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", st.playerOrigin + "/");
        headers.put("Origin", st.playerOrigin);
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(Http.DESKTOP_UA)
                .setDefaultRequestProperties(headers)
                .setConnectTimeoutMs(12_000)
                .setReadTimeoutMs(12_000)
                .setAllowCrossProtocolRedirects(true);
        p.premiumCdn = st.server.premium || channelGroup != null;
        // A stream relayed through the Worker's proxy: each segment makes two trips (CDN to
        // Cloudflare, Cloudflare to here), so it arrives later than from the CDN itself.
        final boolean viaProxy = st.hlsUrl.startsWith(Pool.WEB + "/hls/");
        // The premium panel relayed by the Worker as one continuous MPEG-TS response (Relay.java):
        // not HLS at all - a plain progressive stream with no live window to sit in.
        final boolean viaTs = st.hlsUrl.startsWith(Pool.WEB + "/ts/");
        p.relay = viaProxy || viaTs;
        p.runway = p.premiumCdn || viaProxy || viaTs;
        MediaItem.Builder item = new MediaItem.Builder().setUri(st.hlsUrl);
        // Join the live window 30 s back when it is that deep (the free CDNs' windows are 60 s).
        if ((p.premiumCdn || viaProxy) && !viaTs) {
            item.setLiveConfiguration(new MediaItem.LiveConfiguration.Builder()
                    .setTargetOffsetMs(PREMIUM_LIVE_OFFSET_MS).build());
        }
        // A channel's final URL (after the CDN's redirect to /auth/<token>) carries no extension;
        // the channel's own URL says whether it is HLS.
        if (!viaTs && (st.hlsUrl.contains(".m3u8") || st.server.pageUrl.contains(".m3u8") || channelGroup == null)) {
            // A restarted premium channel repeats the same playlist for 30-40 s; ExoPlayer's
            // default gives up on an unchanging live playlist after 3 target durations. Allow
            // twice that - the stall timer above is the viewer-facing limit.
            HlsMediaSource.Factory hls = new HlsMediaSource.Factory(http).setAllowChunklessPreparation(true);
            if (p.premiumCdn) {
                hls.setPlaylistTrackerFactory((dsf, policy, parserFactory) ->
                        new DefaultHlsPlaylistTracker(dsf, policy, parserFactory, 6.0));
            }
            p.source = hls.createMediaSource(item.build());
        } else {
            // IPTV channels without an HLS variant, and the Worker's /ts/ relay of the premium
            // panel, are plain MPEG-TS over HTTP; let the default factory sniff the container.
            p.source = new DefaultMediaSourceFactory(http).createMediaSource(item.build());
        }
        return p;
    }

    /** "offset=16s buffered=13s window=60s" - where in the live window the player sits. */
    private String liveState() {
        if (player == null) return "no player";
        long offset = player.getCurrentLiveOffset();
        Timeline tl = player.getCurrentTimeline();
        long window = tl.isEmpty() ? C.TIME_UNSET
                : tl.getWindow(player.getCurrentMediaItemIndex(), new Timeline.Window()).getDurationMs();
        return "offset=" + (offset == C.TIME_UNSET ? "?" : offset / 1000 + "s")
                + " buffered=" + player.getTotalBufferedDuration() / 1000 + "s"
                + " window=" + (window == C.TIME_UNSET ? "?" : window / 1000 + "s");
    }

    /**
     * ExoPlayer's load control with a switchable runway: on the premium CDN, playback starts
     * only with {@link #RUNWAY_START_MS} buffered ({@link #RUNWAY_STEADY_MS} once the stream has
     * stalled) and resumes after a stall only with {@link #RUNWAY_REBUFFER_MS}; everywhere else
     * the stock 2.5 s / 5 s apply. The stock rule also halves the requirement against the target
     * live offset, which is exactly what makes it start with no margin on a one-segment window -
     * hence the plain comparison here.
     */
    @UnstableApi
    private static final class RunwayLoadControl extends DefaultLoadControl {
        volatile boolean runway;
        /** This stream has stalled after playing: starts on it now wait for the steady runway. */
        volatile boolean stalled;

        RunwayLoadControl() {
            super(new DefaultAllocator(true, C.DEFAULT_BUFFER_SEGMENT_SIZE),
                    DEFAULT_MIN_BUFFER_MS, 60_000, DEFAULT_BUFFER_FOR_PLAYBACK_MS,
                    DEFAULT_BUFFER_FOR_PLAYBACK_AFTER_REBUFFER_MS, DEFAULT_TARGET_BUFFER_BYTES,
                    DEFAULT_PRIORITIZE_TIME_OVER_SIZE_THRESHOLDS, DEFAULT_BACK_BUFFER_DURATION_MS,
                    DEFAULT_RETAIN_BACK_BUFFER_FROM_KEYFRAME);
        }

        @Override
        public boolean shouldStartPlayback(LoadControl.Parameters p) {
            if (!runway) return super.shouldStartPlayback(p);
            long needMs = p.rebuffering ? RUNWAY_REBUFFER_MS : stalled ? RUNWAY_STEADY_MS : RUNWAY_START_MS;
            return p.bufferedDurationUs >= needMs * 1000L;
        }
    }

    /** Premium tabs and Live TV channels are on the slow-starting premium CDN. */
    private boolean onPremiumCdn() {
        return channelGroup != null || (current >= 0 && current < servers.size() && servers.get(current).premium);
    }

    private long startTimeoutMs() {
        return onPremiumCdn() ? PREMIUM_START_TIMEOUT_MS : START_TIMEOUT_MS;
    }

    /** A server failed: refresh it once (expired token), then move on, then give up. */
    private void onFailure(String why) {
        if (current < 0 || servers.isEmpty() || isFinishing()) return;
        handler.removeCallbacks(stallCheck);
        handler.removeCallbacks(startTimeout);
        StreamResolver.Server s = servers.get(current);
        Log.w(TAG, s.name + " failed: " + why);
        // A tab that was never fetched ("blocked", "pool") or is gated ("premium") is not a CDN failure.
        if (attempt != null && !"blocked".equals(why) && !"pool".equals(why) && !"premium".equals(why)) {
            Telemetry.error(this, attempt, why);
        }

        boolean premium = "premium".equals(why);
        if (standby != null && !premium) {
            // The degraded stream died before its replacement was ready: the replacement goes
            // on screen now (with the connecting overlay) rather than starting over on it.
            Log.i(TAG, s.name + " gave out while " + servers.get(standbyIndex).name + " was getting ready; promoting it");
            swapToStandby(false);
            return;
        }
        if (!premium && !retried.contains(s.pageUrl) && (everPlayed || preResolved.contains(s.pageUrl))) {
            // It was playing (the playlist token probably expired), or it was resolved while the
            // card had focus and the signed URL went stale before the press: re-resolve the same
            // server once before writing it off.
            retried.add(s.pageUrl);
            preResolved.remove(s.pageUrl);
            Toast.makeText(this, getString(R.string.np_reconnecting, s.name), Toast.LENGTH_SHORT).show();
            switchTo(current, false);
            return;
        }
        if (channelGroup != null) {
            // The viewer chose this channel: don't zap away on their behalf.
            player.stop();
            int msg = "warming".equals(why) ? R.string.np_channel_warming
                    : "blocked".equals(why) ? R.string.np_livetv_blocked : R.string.np_channel_failed;
            // A network that blocks the Live TV hosts blocks every channel: don't sit on a
            // shared slot while the message is up (Retry takes one again).
            if ("blocked".equals(why)) lease.release();
            showStatusWithActions(getString(msg, s.name), false);
            return;
        }
        if (!failed.contains(s.pageUrl)) failed.add(s.pageUrl);
        if (failed.size() < servers.size()) {
            // The list is already in preference order (premium tabs first while we hold a pool
            // slot, the remembered server may sit anywhere in it): the next try is the first
            // untried one in that order, not the next one around the circle - otherwise starting
            // on a remembered tab near the end would skip the better tabs before it.
            int next = current;
            for (int cand = 0; cand < servers.size(); cand++) {
                if (!failed.contains(servers.get(cand).pageUrl)) {
                    next = cand;
                    break;
                }
            }
            if (!"blocked".equals(why)) {
                Toast.makeText(this, getString(R.string.np_trying_next, s.name, servers.get(next).name),
                        Toast.LENGTH_SHORT).show();
            }
            Telemetry.switched(this, s.name, servers.get(next).name, why);
            // Servers that die instantly would otherwise be swept in a burst of page fetches,
            // which the site rate-limits (HTTP 429); pace the sweep. A tab skipped as "blocked"
            // fetched nothing, so there is nothing to pace.
            long sinceSwitch = System.currentTimeMillis() - switchedAt;
            final int target = next;
            final int gen = ++loadGeneration;
            if (sinceSwitch < 3_000L && !"blocked".equals(why)) {
                showStatus(getString(R.string.np_connecting_to, servers.get(next).name), true);
                handler.postDelayed(() -> {
                    if (gen == loadGeneration && !isFinishing()) switchTo(target, false);
                }, 1_500L);
            } else {
                switchTo(target, false);
            }
            return;
        }
        // Everything failed. Offer the web player if any server had an embed.
        boolean anyEmbed = false;
        boolean allPremium = true;
        for (StreamResolver.Stream st : resolved.values()) {
            if (st.embed != null) anyEmbed = true;
            if (!"gate".equals(st.state)) allPremium = false;
        }
        player.stop();
        boolean hasPremium = false;
        for (StreamResolver.Server sv : servers) if (sv.premium) hasPremium = true;
        if (allPremium && !resolved.isEmpty()) {
            showPremiumOnly();
        } else if (poolFull && hasPremium && !lease.held()) {
            showStatusWithActions(getString(R.string.pool_full_free_failed, poolMax), anyEmbed);
        } else {
            showStatusWithActions(getString(R.string.np_all_failed), anyEmbed);
        }
    }

    private void retryAll() {
        failed.clear();
        retried.clear();
        // Live TV without a pool slot (the pool was full): go through the channel list again,
        // which asks the pool first.
        if (channelGroup != null && !servers.isEmpty() && (lease.held() || !(Account.isSignedIn(this) || Pool.sharedIptv(this)))) {
            switchTo(Math.max(current, 0), true);
            return;
        }
        resolved.clear();
        preResolved.clear();
        if (event != null) Prefetch.forget(event.id); // Retry means fresh: nothing resolved ahead is reused
        hideStatus();
        showStatus(getString(R.string.np_connecting), true);
        resolvePage();
    }

    private StreamResolver.Stream currentStream() {
        if (current < 0 || current >= servers.size()) return null;
        return resolved.get(servers.get(current).pageUrl);
    }

    private void openWebPlayer(StreamResolver.Stream st) {
        startActivity(PlayerActivity.embedIntent(this, event.url, st.embed.url, st.embed.referer));
        finish();
    }

    private void rememberServer() {
        if (current >= 0 && current < servers.size()) {
            prefs().edit().putString(event.id, servers.get(current).pageUrl).apply();
        }
    }

    private void togglePlayPause() {
        if (player == null) return;
        boolean play = !player.getPlayWhenReady();
        player.setPlayWhenReady(play);
        if (play && player.getPlaybackState() == Player.STATE_IDLE) player.prepare();
        showHud();
    }

    // ---------------------------------------------------------------------------------------------
    // Live score
    // ---------------------------------------------------------------------------------------------

    private void refreshScore() {
        final String base = StreamResolver.originOf(event.url);
        io.execute(() -> {
            try {
                String json = Http.getText(base + config.parser.statusPath);
                handler.post(() -> {
                    if (isFinishing()) return;
                    SiteParser.mergeStatus(config.parser, json, Collections.singletonList(event));
                    bindHud();
                });
            } catch (Exception ignored) {
                // optional
            }
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Keys
    // ---------------------------------------------------------------------------------------------

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        boolean down = e.getAction() == KeyEvent.ACTION_DOWN;
        // Let the status panel's buttons handle navigation/clicks when it is showing.
        boolean panelUp = statusPanel.getVisibility() == View.VISIBLE
                && statusButtons.getVisibility() == View.VISIBLE;
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_BACK:
            case KeyEvent.KEYCODE_ESCAPE:
            case KeyEvent.KEYCODE_MEDIA_STOP:
                if (down) finish();
                return true;

            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                if (panelUp) return super.dispatchKeyEvent(e);
                if (down && e.getRepeatCount() == 0) togglePlayPause();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                if (down && player != null) {
                    player.setPlayWhenReady(true);
                    showHud();
                }
                return true;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
                if (down && player != null) {
                    player.setPlayWhenReady(false);
                    showHud();
                }
                return true;

            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                if (panelUp) return super.dispatchKeyEvent(e);
                if (down && e.getRepeatCount() == 0) manualSwitch(-1);
                return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_MEDIA_NEXT:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                if (panelUp) return super.dispatchKeyEvent(e);
                if (down && e.getRepeatCount() == 0) manualSwitch(+1);
                return true;

            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_INFO:
                if (panelUp) return super.dispatchKeyEvent(e);
                if (down) {
                    if (hudTop.getVisibility() == View.VISIBLE && hudTop.getAlpha() > 0.5f) hideHud();
                    else showHud();
                }
                return true;

            case KeyEvent.KEYCODE_MENU:
                if (down) {
                    retried.clear();
                    switchTo(current, true);
                }
                return true;

            case KeyEvent.KEYCODE_PROG_RED:
                // Debug builds only: "the stream is degraded" on demand (adb shell input keyevent
                // PROG_RED) so the migration can be watched without waiting for a bad night.
                if (down && (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
                        && everPlayed && channelGroup == null) {
                    Log.i(TAG, "debug: forcing a migration");
                    checkHealthForced();
                }
                return true;
            default:
                return super.dispatchKeyEvent(e);
        }
    }

    private void manualSwitch(int delta) {
        if (servers.size() < 2) {
            Toast.makeText(this, R.string.np_only_server, Toast.LENGTH_SHORT).show();
            showHud();
            return;
        }
        int to = ((current + delta) % servers.size() + servers.size()) % servers.size();
        if (current >= 0) Telemetry.switched(this, servers.get(current).name, servers.get(to).name, "manual");
        switchTo(current + delta, true);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private static Event parseEvent(String json) {
        if (json == null) return null;
        try {
            return Event.fromJson(new JSONObject(json));
        } catch (Exception e) {
            return null;
        }
    }

    /** What did the CDN send instead of a playlist? Logged (head only) to diagnose dead servers. */
    private void peekManifest(StreamResolver.Stream st) {
        if (st == null || st.hlsUrl == null) return;
        io.execute(() -> {
            try {
                String body = Http.getText(st.hlsUrl, st.playerOrigin + "/");
                String head = body.length() > 160 ? body.substring(0, 160) : body;
                Log.w(TAG, st.server.name + " manifest body (" + body.length() + " chars): "
                        + head.replaceAll("\\s+", " "));
            } catch (Exception e) {
                Log.w(TAG, st.server.name + " manifest fetch: " + e.getMessage());
            }
        });
    }

    /** "HTTP 403 from host" for CDN refusals, else the exception itself. */
    @OptIn(markerClass = UnstableApi.class)
    private static String describe(Throwable cause) {
        if (cause instanceof HttpDataSource.InvalidResponseCodeException) {
            HttpDataSource.InvalidResponseCodeException e = (HttpDataSource.InvalidResponseCodeException) cause;
            return "HTTP " + e.responseCode + " from " + e.dataSpec.uri.getHost();
        }
        return String.valueOf(cause);
    }

    private static String shortError(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}
