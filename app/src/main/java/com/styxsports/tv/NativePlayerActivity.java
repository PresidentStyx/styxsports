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
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.hls.playlist.DefaultHlsPlaylistTracker;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
    private static final long SCORE_REFRESH_MS = 30_000L;
    /** After this long without an answer, the next server is tried in parallel. */
    private static final long IMPATIENCE_MS = 6_000L;
    /** Behind-live-window recoveries (seek to the live edge) allowed per server before it is a failure. */
    private static final int MAX_LIVE_EDGE_RESYNCS = 1;
    /** The site's unnamed server tabs ("Server 7"). */
    private static final java.util.regex.Pattern GENERIC_TAB = java.util.regex.Pattern.compile("(?i)^server\\s*\\d+$");

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
    /** The stream page as fetched; its HTML already embeds the active server. */
    private StreamResolver.Page page;
    private int current = -1;
    /** Servers already re-resolved once after a failure (the playlist token may have expired). */
    private final List<String> retried = new ArrayList<>();
    /** Servers that failed in this auto-fallback sweep. */
    private final List<String> failed = new ArrayList<>();
    private int loadGeneration;
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

    private final Runnable hideHud = this::hideHud;
    private final Runnable stallCheck = () -> onFailure("stalled");
    private final Runnable startTimeout = () -> onFailure("no video after " + startTimeoutMs() / 1000 + "s");
    /** Behind-live-window recoveries on the current server (reset on every switch). */
    private int liveEdgeResyncs;
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

    @OptIn(markerClass = UnstableApi.class) // setVideoScalingMode
    private void createPlayer() {
        player = new ExoPlayer.Builder(this).build();
        player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true);
        player.setVideoScalingMode(C.VIDEO_SCALING_MODE_SCALE_TO_FIT);
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_BUFFERING) {
                    handler.removeCallbacks(stallCheck);
                    handler.postDelayed(stallCheck, STALL_MS);
                    if (everPlayed) showStatus(getString(R.string.np_buffering), true);
                } else if (state == Player.STATE_READY) {
                    handler.removeCallbacks(stallCheck);
                    handler.removeCallbacks(startTimeout);
                    handler.removeCallbacks(impatience);
                    hideStatus();
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
                Log.w(TAG, "player error: " + error.getErrorCodeName() + " " + describe(error.getCause()));
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW
                        && liveEdgeResyncs < MAX_LIVE_EDGE_RESYNCS) {
                    // The live window moved past us (the premium CDN's sequence jumps once a
                    // restarted channel catches up): rejoin at the live edge, same stream.
                    liveEdgeResyncs++;
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
        });
        playerView.setPlayer(player);
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
                StreamResolver.Page p = resolver.page(event.url);
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

    private void onPageResolved(StreamResolver.Page p) {
        page = p;
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
        if (Account.isSignedIn(this)) return !Boolean.FALSE.equals(Account.premiumKnown(this));
        return Pool.sharedAvailable(this);
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
        }
        everPlayed = false;
        liveEdgeResyncs = 0;
        handler.removeCallbacks(stallCheck);
        handler.removeCallbacks(startTimeout);
        player.stop();
        player.clearMediaItems();
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
                        + (c.error == null ? "" : " " + c.error));
                handler.post(() -> {
                    if (gen != loadGeneration || isFinishing()) return;
                    if (c.ok && c.warming) {
                        onFailure("warming");
                    } else if (!c.ok && c.code >= 400) {
                        onFailure(c.error);
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
        final boolean viaPool = s.premium && lease.held();
        // No account here: this session cannot open a premium tab at all, so the Worker reads it
        // with the shared account straight away.
        final boolean sharedOnly = viaPool && !Account.isSignedIn(this);
        io.execute(() -> {
            try {
                StreamResolver.Stream st;
                if (sharedOnly) {
                    st = Pool.resolveShared(this, s);
                } else {
                    st = resolver.resolve(s, page);
                    // The site does not give every session the same premium player: when ours
                    // gets an embed it cannot read, the Worker resolves the tab with the shared account.
                    if (viaPool && !st.playableNatively() && !"gate".equals(st.state) && !"warming".equals(st.state)) {
                        Log.i(TAG, s.name + ": no player for this session; asking the web player");
                        StreamResolver.Stream shared = Pool.resolveShared(this, s);
                        if (shared.playableNatively() || "warming".equals(shared.state)) st = shared;
                    }
                }
                final StreamResolver.Stream got = st;
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

    /**
     * The chosen server is slow to answer (some embed hosts take 15-20 s): start resolving the
     * next one too and play whichever is ready first. The slow one stays available via Left.
     */
    private final Runnable impatience = () -> {
        if (everPlayed || isFinishing() || servers.size() < 2 || current < 0) return;
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
                st = resolver.resolve(s, page);
            } catch (Exception e) {
                return;
            }
            handler.post(() -> {
                if (isFinishing()) return;
                resolved.put(s.pageUrl, st);
                if (gen != loadGeneration || everPlayed || current != idx || !st.playableNatively()) return;
                Log.i(TAG, s.name + " answered first; switching");
                current = alt;
                loadGeneration++; // the slow server's answer must not interrupt this one
                bindServerLabel();
                play(st);
            });
        });
    };

    @OptIn(markerClass = UnstableApi.class) // HlsMediaSource / DefaultHttpDataSource (Media3 version is pinned)
    private void play(StreamResolver.Stream st) {
        if (st.server.premium) {
            // What the site gave a premium tab tells us whether the account really has premium.
            if (st.playableNatively() || st.embed != null) Account.notePremium(this, true);
            else if ("gate".equals(st.state)) Account.notePremium(this, false);
        }
        if (!st.playableNatively()) {
            Log.i(TAG, st.server.name + " has no HLS (state=" + st.state + ")");
            // "warming": the CDN's warming.ts placeholder - no video on this server yet, try another.
            onFailure("gate".equals(st.state) ? "premium" : "warming".equals(st.state) ? "warming" : "no player");
            return;
        }
        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", st.playerOrigin + "/");
        headers.put("Origin", st.playerOrigin);
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(Http.DESKTOP_UA)
                .setDefaultRequestProperties(headers)
                .setConnectTimeoutMs(12_000)
                .setReadTimeoutMs(12_000)
                .setAllowCrossProtocolRedirects(true);
        MediaSource source;
        // A channel's final URL (after the CDN's redirect to /auth/<token>) carries no extension;
        // the channel's own URL says whether it is HLS.
        if (st.hlsUrl.contains(".m3u8") || st.server.pageUrl.contains(".m3u8") || channelGroup == null) {
            // A restarted premium channel repeats the same playlist for 30-40 s; ExoPlayer's
            // default gives up on an unchanging live playlist after 3 target durations. Allow
            // twice that - the stall timer above is the viewer-facing limit.
            HlsMediaSource.Factory hls = new HlsMediaSource.Factory(http).setAllowChunklessPreparation(true);
            if (st.server.premium || channelGroup != null) {
                hls.setPlaylistTrackerFactory((dsf, policy, parserFactory) ->
                        new DefaultHlsPlaylistTracker(dsf, policy, parserFactory, 6.0));
            }
            source = hls.createMediaSource(MediaItem.fromUri(st.hlsUrl));
        } else {
            // IPTV channels without an HLS variant are plain MPEG-TS over HTTP; let the default
            // factory sniff the container.
            source = new DefaultMediaSourceFactory(http).createMediaSource(MediaItem.fromUri(st.hlsUrl));
        }
        player.setMediaSource(source);
        player.prepare();
        player.setPlayWhenReady(true);
        handler.removeCallbacks(startTimeout);
        handler.postDelayed(startTimeout, startTimeoutMs());
        Log.i(TAG, "playing " + st.server.name + " via " + StreamResolver.hostOf(st.hlsUrl));
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

        boolean premium = "premium".equals(why);
        if (!premium && !retried.contains(s.pageUrl) && everPlayed) {
            // It was playing: the playlist token probably expired. Re-resolve the same server.
            retried.add(s.pageUrl);
            Toast.makeText(this, getString(R.string.np_reconnecting, s.name), Toast.LENGTH_SHORT).show();
            switchTo(current, false);
            return;
        }
        if (channelGroup != null) {
            // The viewer chose this channel: don't zap away on their behalf.
            player.stop();
            int msg = "warming".equals(why) ? R.string.np_channel_warming : R.string.np_channel_failed;
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
            Toast.makeText(this, getString(R.string.np_trying_next, s.name, servers.get(next).name),
                    Toast.LENGTH_SHORT).show();
            // Servers that die instantly would otherwise be swept in a burst of page fetches,
            // which the site rate-limits (HTTP 429); pace the sweep.
            long sinceSwitch = System.currentTimeMillis() - switchedAt;
            final int target = next;
            final int gen = ++loadGeneration;
            if (sinceSwitch < 3_000L) {
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
