package com.styxsports.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native launcher screen: rows of focusable event cards parsed from the site, navigated with the
 * D-pad like any TV app. Selecting a card opens {@link PlayerActivity} on that stream page.
 */
public class HomeActivity extends Activity {

    private static final long STATUS_INTERVAL_MS = 30_000L;
    private static final long FULL_REFRESH_INTERVAL_MS = 5 * 60_000L;
    private static final long STALE_ON_RESUME_MS = 90_000L;

    private static final int CARD_W_DP = 292;
    private static final int CARD_H_DP = 150;
    private static final int CREST_DP = 38;
    /** Top-bar wordmark size in dp; keeps the image's 6.54:1 ratio. */
    private static final int WORDMARK_H = 30;
    private static final int WORDMARK_W = 196;

    private static final String PREFS = "styxsports";
    private static final String KEY_FILTER = "filter_category";
    private static final int MAX_CONTINUE = 6;

    private RemoteConfig config;
    private SiteRepository repo;
    private ImageLoader images;
    private UpdateFlow updates;
    private Favorites favorites;
    /** Selected sport chip (category name), {@link #PREMIUM_FILTER}, or null for All. */
    private String filterCategory;
    /** Chip value for the "Premium Only" tab (not a real category name). */
    private static final String PREMIUM_FILTER = "__premium_only__";
    /** Chip that opens the Live TV screen (premium IPTV playlist); never a filter. */
    private static final String LIVE_TV_TAB = "__live_tv__";
    private boolean renderedLiveTv;
    private long lastAccountCheckAt;
    /** Whether the last render kept premium-only games out of the regular rows. */
    private boolean renderedPremiumHidden;
    private LinearLayout chips;
    private HorizontalScrollView chipsScroller;
    /** Identity of the Continue Watching row at the last render, to re-render when it changes. */
    private String recentsKey = "";
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());

    private Snapshot snapshot;
    private boolean loading;

    private float density;
    private FrameLayout root;
    private ScrollView scroller;
    private LinearLayout rows;
    private TextView statusText;
    private TextView accountButton;
    private View overlay;
    private ProgressBar overlaySpinner;
    private TextView overlayMessage;
    private LinearLayout overlayButtons;

    /** A card's mutable parts, so live clocks/scores can be updated in place. */
    private static final class CardHolder {
        Event event;
        View card;
        TextView pill;
        TextView middle;
        TextView badges;
    }

    private final Map<String, List<CardHolder>> holders = new HashMap<>();
    private String focusedEventId;
    private boolean initialFocusDone;
    private boolean restoreCardFocus;

    private final Runnable statusTick = new Runnable() {
        @Override
        public void run() {
            // Someone may have shared (or stopped sharing) an account since the last paint: the
            // presence ping keeps Pool's answer fresh, this keeps the chips in step with it.
            if (snapshot != null && !loading
                    && (premiumHidden() != renderedPremiumHidden || hasLiveTv() != renderedLiveTv)) {
                render(snapshot);
            } else {
                refreshStatusOnly();
            }
            handler.postDelayed(this, STATUS_INTERVAL_MS);
        }
    };

    private final Runnable fullTick = new Runnable() {
        @Override
        public void run() {
            fullRefresh(false);
            updates.checkIfDue();
            handler.postDelayed(this, FULL_REFRESH_INTERVAL_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        config = RemoteConfig.load(this);
        if (!config.nativeHome) {
            // Remote kill switch: behave like the original WebView-only app.
            startActivity(PlayerActivity.intent(this, config.homeUrl, false));
            finish();
            return;
        }

        Http.ensureCookies();
        density = getResources().getDisplayMetrics().density;
        repo = new SiteRepository(this);
        images = new ImageLoader(dp(CREST_DP));
        updates = new UpdateFlow(this, io);
        favorites = new Favorites(this);
        filterCategory = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_FILTER, null);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveMode();
        setContentView(buildUi());

        Snapshot cached = repo.cached();
        if (cached != null && !cached.events.isEmpty()) {
            render(cached);
        } else {
            showLoading();
        }

        refreshConfig();
        fullRefresh(true);
        if (!showCrashReport()) updates.checkInBackground();
    }

    /** Shows what was recorded about the previous crash, if any. Returns whether it did. */
    private boolean showCrashReport() {
        String report = CrashLog.pendingReport(this);
        if (report == null) return false;

        TextView text = new TextView(this);
        text.setText(report);
        text.setTypeface(Typeface.MONOSPACE);
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        text.setTextColor(color(R.color.text));
        text.setTextIsSelectable(false);
        ScrollView scroller = new ScrollView(this);
        scroller.addView(text);
        int pad = dp(16);
        scroller.setPadding(pad, dp(8), pad, 0);
        // Fixed height so the Dismiss button stays on screen; long traces scroll with D-pad.
        int maxHeight = (int) (getResources().getDisplayMetrics().heightPixels * 0.55f);
        FrameLayout box = new FrameLayout(this);
        box.addView(scroller, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, maxHeight));

        new AlertDialog.Builder(this)
                .setTitle(R.string.crash_report_title)
                .setMessage(R.string.crash_report_hint)
                .setView(box)
                .setPositiveButton(R.string.action_dismiss, (d, w) -> CrashLog.clear(this))
                .setOnDismissListener(d -> {
                    CrashLog.clear(this);
                    updates.checkInBackground();
                })
                .show();
        return true;
    }

    // ---------------------------------------------------------------------------------------------
    // UI construction
    // ---------------------------------------------------------------------------------------------

    private int color(int res) {
        return ContextCompat.getColor(this, res);
    }

    private int dp(float v) {
        return Math.round(v * density);
    }

    private View buildUi() {
        root = new FrameLayout(this);
        root.setBackgroundColor(color(R.color.bg));

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        root.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        column.addView(buildTopBar(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        column.addView(buildChips(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        scroller = new ScrollView(this) {
            @Override
            protected int computeScrollDeltaToGetChildRectOnScreen(Rect rect) {
                return 0; // we position rows ourselves on focus (see alignRow)
            }
        };
        scroller.setVerticalScrollBarEnabled(false);
        scroller.setOverScrollMode(View.OVER_SCROLL_NEVER);
        scroller.setClipToPadding(false);
        scroller.setClipChildren(false);
        scroller.setFocusable(false);
        scroller.setPadding(0, dp(8), 0, dp(120));
        column.addView(scroller, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        rows = new LinearLayout(this);
        rows.setOrientation(LinearLayout.VERTICAL);
        rows.setClipChildren(false);
        rows.setClipToPadding(false);
        scroller.addView(rows, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.addView(buildOverlay(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return root;
    }

    private View buildTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(48), dp(22), dp(48), dp(10));

        // "STYX SPORTS" wordmark (6.54:1), one image so both words share the same face.
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.wordmark);
        logo.setScaleType(ImageView.ScaleType.FIT_START);
        logo.setContentDescription(getString(R.string.app_name));
        bar.addView(logo, new LinearLayout.LayoutParams(dp(WORDMARK_W), dp(WORDMARK_H)));

        statusText = new TextView(this);
        statusText.setTextColor(color(R.color.muted));
        statusText.setTextSize(13);
        statusText.setGravity(Gravity.END);
        statusText.setSingleLine(true);
        statusText.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams stp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        stp.rightMargin = dp(20);
        bar.addView(statusText, stp);

        bar.addView(pillButton(getString(R.string.action_refresh), v -> {
            Toast.makeText(this, R.string.refreshing, Toast.LENGTH_SHORT).show();
            fullRefresh(true);
            updates.checkInBackground(); // "is there a new version?" is part of Refresh
        }));
        View site = pillButton(getString(R.string.action_open_site), v -> openWebsite());
        ((LinearLayout.LayoutParams) site.getLayoutParams()).leftMargin = dp(10);
        bar.addView(site);

        accountButton = pillButton("", v -> startActivity(AccountActivity.intent(this)));
        ((LinearLayout.LayoutParams) accountButton.getLayoutParams()).leftMargin = dp(10);
        bar.addView(accountButton);
        bindAccountButton();

        TextView version = new TextView(this);
        version.setText("v" + AppUpdater.installedVersion(this));
        version.setTextColor(color(R.color.muted));
        version.setTextSize(11);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        vp.leftMargin = dp(14);
        bar.addView(version, vp);
        return bar;
    }

    /** "Sign in" when signed out; "Premium" (gold) once signed in. */
    private void bindAccountButton() {
        if (accountButton == null) return;
        boolean signedIn = Account.isSignedIn(this);
        Boolean premium = Account.premiumKnown(this);
        if (!signedIn) {
            accountButton.setText(R.string.action_sign_in);
        } else if (premium != null && !premium) {
            accountButton.setText(R.string.action_account);
        } else {
            accountButton.setText("★ " + getString(R.string.action_account_premium));
        }
        if (signedIn && (Account.isStale(this) || Account.iptvStale(this))) recheckAccount();
    }

    /** Sessions lapse; make sure the button (and the player's server choice) reflect reality. */
    private void recheckAccount() {
        // Offline the checks stay stale; don't hammer the account service on every re-render.
        long now = System.currentTimeMillis();
        if (now - lastAccountCheckAt < 60_000L) return;
        lastAccountCheckAt = now;
        final Account account = new Account(this, config);
        io.execute(() -> {
            try {
                if (Account.isStale(this) && !account.refreshStatus()) return;
                if (Account.iptvStale(this)) account.discoverIptv();
            } catch (Exception e) {
                android.util.Log.w("StyxHome", "account re-check failed: " + e); // offline; keep the cached answer
            } finally {
                handler.post(() -> {
                    bindAccountButton();
                    if (snapshot != null && !loading
                            && (premiumHidden() != renderedPremiumHidden || hasLiveTv() != renderedLiveTv)) {
                        render(snapshot);
                    }
                });
            }
        });
    }

    /** Sport filter chips: All + one per category, remembered across launches. */
    private View buildChips() {
        chipsScroller = new HorizontalScrollView(this);
        chipsScroller.setHorizontalScrollBarEnabled(false);
        chipsScroller.setOverScrollMode(View.OVER_SCROLL_NEVER);
        chipsScroller.setFocusable(false);
        chipsScroller.setClipToPadding(false);
        chipsScroller.setPadding(dp(48), dp(2), dp(48), dp(4));
        chips = new LinearLayout(this);
        chips.setOrientation(LinearLayout.HORIZONTAL);
        chipsScroller.addView(chips, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return chipsScroller;
    }

    private void renderChips(Snapshot s) {
        View focused = getCurrentFocus();
        String focusedChip = focused != null && focused.getParent() == chips ? (String) focused.getTag() : null;
        chips.removeAllViews();
        List<String> names = new ArrayList<>();
        names.add(null); // All
        for (Snapshot.Category c : s.byCategory().keySet()) names.add(c.name);
        // Without a premium account the premium-only games live in their own tab.
        if (premiumHidden()) names.add(PREMIUM_FILTER);
        // With one, the account's IPTV channels get a tab of their own (a separate screen).
        boolean liveTv = hasLiveTv();
        renderedLiveTv = liveTv;
        if (liveTv) names.add(LIVE_TV_TAB);
        if (filterCategory != null && !names.contains(filterCategory)) filterCategory = null;
        for (final String name : names) {
            final TextView chip = new TextView(this);
            chip.setText(name == null ? getString(R.string.chip_all)
                    : PREMIUM_FILTER.equals(name) ? getString(R.string.chip_premium_only)
                    : LIVE_TV_TAB.equals(name) ? getString(R.string.chip_live_tv) : name);
            chip.setTag(name);
            chip.setTextColor(ContextCompat.getColorStateList(this, R.color.button_text));
            chip.setTextSize(13);
            chip.setTypeface(Typeface.DEFAULT_BOLD);
            chip.setPadding(dp(15), dp(6), dp(15), dp(6));
            chip.setBackgroundResource(R.drawable.chip_bg);
            chip.setFocusable(true);
            chip.setClickable(true);
            chip.setSelected(name == null ? filterCategory == null : name.equals(filterCategory));
            chip.setOnClickListener(v -> selectFilter(name));
            chip.setOnFocusChangeListener((v, has) -> {
                if (has) {
                    int target = v.getLeft() + v.getWidth() / 2 - chipsScroller.getWidth() / 2
                            + chipsScroller.getPaddingLeft();
                    chipsScroller.smoothScrollTo(Math.max(0, target), 0);
                }
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.rightMargin = dp(8);
            chip.setId(View.generateViewId());
            chips.addView(chip, lp);
            if (focusedChip != null && focusedChip.equals(name)) chip.requestFocus();
        }
        // Keep Left/Right inside the chip row instead of drifting into the top bar.
        if (chips.getChildCount() > 0) {
            View first = chips.getChildAt(0);
            View last = chips.getChildAt(chips.getChildCount() - 1);
            first.setNextFocusLeftId(first.getId());
            last.setNextFocusRightId(last.getId());
        }
    }

    private void selectFilter(String name) {
        if (LIVE_TV_TAB.equals(name)) {
            startActivity(LiveTvActivity.intent(this));
            return;
        }
        if (name == null ? filterCategory == null : name.equals(filterCategory)) return;
        filterCategory = name;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_FILTER, name).apply();
        if (snapshot != null) render(snapshot);
    }

    private TextView pillButton(String label, View.OnClickListener onClick) {
        TextView b = new TextView(this);
        b.setText(label);
        b.setTextColor(ContextCompat.getColorStateList(this, R.color.button_text));
        b.setTextSize(13);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(dp(16), dp(8), dp(16), dp(8));
        b.setBackgroundResource(R.drawable.button_bg);
        b.setFocusable(true);
        b.setClickable(true);
        b.setOnClickListener(onClick);
        b.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return b;
    }

    private View buildOverlay() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(color(R.color.bg));
        box.setClickable(true); // swallow clicks while showing

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.wordmark);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        box.addView(logo, new LinearLayout.LayoutParams(dp(300), dp(46)));

        overlaySpinner = new ProgressBar(this);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(dp(36), dp(36));
        sp.topMargin = dp(28);
        box.addView(overlaySpinner, sp);

        overlayMessage = new TextView(this);
        overlayMessage.setTextColor(color(R.color.muted));
        overlayMessage.setTextSize(16);
        overlayMessage.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mp.topMargin = dp(18);
        mp.leftMargin = dp(48);
        mp.rightMargin = dp(48);
        box.addView(overlayMessage, mp);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.topMargin = dp(22);
        buttons.addView(pillButton(getString(R.string.action_retry), v -> fullRefresh(true)));
        View site = pillButton(getString(R.string.action_open_site), v -> openWebsite());
        ((LinearLayout.LayoutParams) site.getLayoutParams()).leftMargin = dp(12);
        buttons.addView(site);
        box.addView(buttons, bp);
        overlayButtons = buttons;

        overlay = box;
        return box;
    }

    // ---------------------------------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------------------------------

    private void showLoading() {
        overlay.setVisibility(View.VISIBLE);
        overlaySpinner.setVisibility(View.VISIBLE);
        overlayButtons.setVisibility(View.GONE);
        overlayMessage.setText(R.string.loading_events);
    }

    private void showProblem(String message) {
        overlay.setVisibility(View.VISIBLE);
        overlaySpinner.setVisibility(View.GONE);
        overlayButtons.setVisibility(View.VISIBLE);
        overlayMessage.setText(message);
        overlayButtons.getChildAt(0).requestFocus();
    }

    /** config.json is read at launch and then every 6 h while Home stays open (feature flags). */
    private static final long CONFIG_REFRESH_MS = 6 * 3600_000L;

    private void refreshConfig() {
        io.execute(() -> {
            try {
                RemoteConfig fresh = RemoteConfig.parse(Http.getText(RemoteConfig.CONFIG_URL));
                handler.post(() -> {
                    if (isFinishing() || isDestroyed()) return;
                    fresh.save(this);
                    config = fresh;
                });
            } catch (Exception ignored) {
                // Offline or GitHub unreachable: keep using the cached copy.
            }
        });
        handler.removeCallbacks(configTick);
        handler.postDelayed(configTick, CONFIG_REFRESH_MS);
    }

    private final Runnable configTick = this::refreshConfig;

    private void fullRefresh(boolean userVisible) {
        if (loading) return;
        loading = true;
        if (userVisible && snapshot != null) statusText.setText(R.string.refreshing);
        io.execute(() -> {
            try {
                Snapshot fresh = repo.fetch(config);
                handler.post(() -> {
                    loading = false;
                    if (isFinishing() || isDestroyed()) return;
                    images.forgetFailures();
                    render(fresh);
                });
            } catch (IOException e) {
                handler.post(() -> {
                    loading = false;
                    if (isFinishing() || isDestroyed()) return;
                    if (snapshot == null || snapshot.events.isEmpty()) {
                        showProblem(getString(R.string.load_failed, e.getMessage()));
                    } else {
                        statusText.setText(getString(R.string.status_offline, timeOf(snapshot.fetchedAtMs)));
                    }
                });
            }
        });
    }

    private void refreshStatusOnly() {
        final Snapshot s = snapshot;
        if (s == null || loading) return;
        io.execute(() -> {
            repo.refreshStatus(config, s);
            handler.post(() -> {
                if (snapshot != s || isFinishing() || isDestroyed()) return;
                for (List<CardHolder> list : holders.values()) {
                    for (CardHolder h : list) bindDynamic(h);
                }
                updateStatusText();
            });
        });
    }

    private void updateStatusText() {
        if (snapshot == null) return;
        int live = snapshot.liveEvents().size();
        String text = getResources().getQuantityString(R.plurals.status_updated, live,
                timeOf(snapshot.fetchedAtMs), live);
        // This network blocks the site; the app is reading it through the web version.
        if (Relay.active(this)) text += getString(R.string.status_via_relay);
        statusText.setText(text);
    }

    // ---------------------------------------------------------------------------------------------
    // Rendering
    // ---------------------------------------------------------------------------------------------

    private void render(Snapshot s) {
        snapshot = s;
        // Removing the focused card makes Android hand focus to the first focusable view (a
        // top-bar button) at once; remember that a card had it so restoreFocus() can take it back.
        View focused = getCurrentFocus();
        boolean cardHadFocus = focused != null && focused.getTag() instanceof Event;
        restoreCardFocus = !initialFocusDone || cardHadFocus;
        holders.clear();
        rows.removeAllViews();
        favorites.setCategories(s);
        renderChips(s);

        Map<Snapshot.Category, List<Event>> byCat = s.byCategory();
        // Without a premium account, premium-only games are kept out of the regular rows and
        // shown together under the "Premium Only" chip instead.
        final boolean premiumHidden = premiumHidden();
        final boolean premiumOnly = premiumHidden && PREMIUM_FILTER.equals(filterCategory);
        renderedPremiumHidden = premiumHidden;
        Snapshot.Category filter = null;
        if (filterCategory != null && !premiumOnly) {
            for (Snapshot.Category c : byCat.keySet()) if (c.name.equals(filterCategory)) filter = c;
        }

        // Continue watching: games opened recently that are still listed (fresh data) or recent
        // enough to matter. Only on the unfiltered view.
        List<Event> recent = premiumPass(continueWatching(s), premiumHidden, false);
        recentsKey = keyOf(recent);
        if (filter == null && !premiumOnly && !recent.isEmpty()) {
            addRow(getString(R.string.row_continue), getString(R.string.row_continue_sub), recent);
        }

        // Starred teams / leagues.
        if (!favorites.isEmpty()) {
            List<Event> mine = new ArrayList<>();
            for (Event e : s.events) {
                if (favorites.matches(e) && (filter == null || e.categoryId == filter.id)) mine.add(e);
            }
            mine = premiumPass(mine, premiumHidden, premiumOnly);
            if (!mine.isEmpty()) {
                Collections.sort(mine, Snapshot.ROW_ORDER);
                addRow(getString(R.string.row_favorites), getString(R.string.row_favorites_sub), mine);
            }
        }

        List<Event> live = new ArrayList<>();
        for (Event e : s.liveEvents()) if (filter == null || e.categoryId == filter.id) live.add(e);
        live = premiumPass(live, premiumHidden, premiumOnly);
        if (!live.isEmpty()) {
            addRow(getString(R.string.row_live_now), getResources().getQuantityString(
                    R.plurals.count_live, live.size(), live.size()), favoritesFirst(live));
        }
        for (Map.Entry<Snapshot.Category, List<Event>> en : byCat.entrySet()) {
            Snapshot.Category c = en.getKey();
            if (filter != null && c != filter) continue;
            List<Event> events = premiumPass(en.getValue(), premiumHidden, premiumOnly);
            if (events.isEmpty()) continue;
            int liveN = 0, endedN = 0;
            for (Event e : events) {
                if (e.ended) endedN++;
                else if (e.live) liveN++;
            }
            int upcoming = events.size() - liveN - endedN;
            String sub = liveN > 0
                    ? getString(R.string.row_sub_live_upcoming, liveN, upcoming)
                    : getString(R.string.row_sub_upcoming, upcoming);
            if (endedN > 0) sub += " · " + getString(R.string.row_sub_final, endedN);
            addRow(c.name, sub, favoritesFirst(events));
        }

        if (rows.getChildCount() == 0) {
            if (premiumOnly) {
                rows.addView(emptyNote(getString(R.string.no_premium_events)));
            } else if (filter != null) {
                rows.addView(emptyNote(getString(R.string.no_events_filtered, filter.name)));
            } else if (premiumHidden && !s.events.isEmpty()) {
                rows.addView(emptyNote(getString(R.string.only_premium_events)));
            } else {
                showProblem(getString(R.string.no_events));
                return;
            }
        }
        overlay.setVisibility(View.GONE);
        updateStatusText();
        afterLayout(this::restoreFocus);
    }

    /** Recently opened games, using the snapshot's copy when it is still listed. */
    private List<Event> continueWatching(Snapshot s) {
        List<Event> out = new ArrayList<>();
        Map<String, Event> byId = new HashMap<>();
        for (Event e : s.events) byId.put(e.id, e);
        for (Recents.Item it : Recents.load(this)) {
            Event fresh = byId.get(it.event.id);
            out.add(fresh != null ? fresh : it.event);
            if (out.size() >= MAX_CONTINUE) break;
        }
        return out;
    }

    /**
     * No way to play premium: signed out with nothing shared through the pool, or signed in but
     * the account turned out not to have it.
     */
    private boolean premiumHidden() {
        boolean own = Account.isSignedIn(this) && !Boolean.FALSE.equals(Account.premiumKnown(this));
        return !own && !Pool.sharedAvailable(this);
    }

    /** Live TV: the account's own playlist, or the shared account's through the pool. */
    private boolean hasLiveTv() {
        return Account.hasIptv(this) || Pool.sharedIptv(this);
    }

    /**
     * With premium hidden: only the premium games ({@code premiumOnly}) or only the free ones.
     * With a premium account every game passes.
     */
    private static List<Event> premiumPass(List<Event> in, boolean premiumHidden, boolean premiumOnly) {
        if (!premiumHidden) return in;
        List<Event> out = new ArrayList<>(in.size());
        for (Event e : in) if (e.premium == premiumOnly) out.add(e);
        return out;
    }

    private TextView emptyNote(String text) {
        TextView empty = new TextView(this);
        empty.setText(text);
        empty.setTextColor(color(R.color.muted));
        empty.setTextSize(16);
        empty.setPadding(dp(48), dp(40), dp(48), 0);
        return empty;
    }

    private static String keyOf(List<Event> events) {
        StringBuilder b = new StringBuilder();
        for (Event e : events) b.append(e.id).append(',');
        return b.toString();
    }

    /** Stable: starred games first, everything else in its existing order. */
    private List<Event> favoritesFirst(List<Event> in) {
        if (favorites.isEmpty()) return in;
        List<Event> out = new ArrayList<>(in.size());
        for (Event e : in) if (favorites.matches(e)) out.add(e);
        if (out.isEmpty()) return in;
        for (Event e : in) if (!favorites.matches(e)) out.add(e);
        return out;
    }


    /** Runs once the freshly added rows have been measured and laid out (so focus can land). */
    private void afterLayout(final Runnable r) {
        rows.getViewTreeObserver().addOnGlobalLayoutListener(
                new ViewTreeObserver.OnGlobalLayoutListener() {
                    @Override
                    public void onGlobalLayout() {
                        rows.getViewTreeObserver().removeOnGlobalLayoutListener(this);
                        r.run();
                    }
                });
    }

    private void restoreFocus() {
        // First render: Android has already handed focus to a top-bar button; move it to the
        // first card. Later renders: only take focus if a card had it before the rebuild.
        if (!restoreCardFocus) return;
        restoreCardFocus = false;
        initialFocusDone = true;
        if (focusedEventId != null) {
            List<CardHolder> list = holders.get(focusedEventId);
            if (list != null && !list.isEmpty()) {
                list.get(0).card.requestFocus();
                return;
            }
        }
        if (rows.getChildCount() > 0) {
            LinearLayout firstRow = (LinearLayout) rows.getChildAt(0);
            HorizontalScrollView hsv = (HorizontalScrollView) firstRow.getChildAt(1);
            LinearLayout strip = (LinearLayout) hsv.getChildAt(0);
            if (strip.getChildCount() > 0) strip.getChildAt(0).requestFocus();
        }
    }

    private void addRow(String title, String subtitle, List<Event> events) {
        final LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setClipChildren(false);
        row.setClipToPadding(false);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.BOTTOM);
        header.setPadding(dp(48), dp(14), dp(48), dp(2));
        TextView t = new TextView(this);
        t.setText(title);
        t.setTextColor(color(R.color.text));
        t.setTextSize(20);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        header.addView(t);
        TextView st = new TextView(this);
        st.setText(subtitle);
        st.setTextColor(color(R.color.muted));
        st.setTextSize(13);
        LinearLayout.LayoutParams stp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        stp.leftMargin = dp(12);
        stp.bottomMargin = dp(3);
        header.addView(st, stp);
        row.addView(header);

        final HorizontalScrollView hsv = new HorizontalScrollView(this) {
            @Override
            protected int computeScrollDeltaToGetChildRectOnScreen(Rect rect) {
                return 0; // centred manually in alignCard
            }
        };
        hsv.setHorizontalScrollBarEnabled(false);
        hsv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        hsv.setClipToPadding(false);
        hsv.setClipChildren(false);
        hsv.setFocusable(false);
        hsv.setPadding(dp(48), 0, dp(48), 0);

        LinearLayout strip = new LinearLayout(this);
        strip.setOrientation(LinearLayout.HORIZONTAL);
        strip.setClipChildren(false);
        strip.setClipToPadding(false);
        strip.setPadding(0, dp(10), 0, dp(10));
        for (Event e : events) {
            View card = createCard(e, row, hsv);
            card.setId(View.generateViewId());
            strip.addView(card);
        }
        // Keep Left/Right inside the row: the ends point at themselves.
        if (strip.getChildCount() > 0) {
            View first = strip.getChildAt(0);
            View last = strip.getChildAt(strip.getChildCount() - 1);
            first.setNextFocusLeftId(first.getId());
            last.setNextFocusRightId(last.getId());
        }
        hsv.addView(strip, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        row.addView(hsv);

        rows.addView(row, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    private View createCard(final Event e, final View row, final HorizontalScrollView hsv) {
        final CardHolder h = new CardHolder();
        h.event = e;

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.card_bg);
        card.setPadding(dp(14), dp(12), dp(14), dp(10));
        card.setFocusable(true);
        card.setClickable(true);
        card.setTag(e);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(CARD_W_DP), dp(CARD_H_DP));
        lp.rightMargin = dp(14);
        card.setLayoutParams(lp);

        // Top line: status pill on the left, badges on the right.
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        h.pill = new TextView(this);
        h.pill.setTextSize(11);
        h.pill.setTypeface(Typeface.DEFAULT_BOLD);
        h.pill.setTextColor(Color.WHITE);
        h.pill.setPadding(dp(8), dp(3), dp(8), dp(3));
        top.addView(h.pill);
        h.badges = new TextView(this);
        h.badges.setTextSize(11);
        h.badges.setTypeface(Typeface.DEFAULT_BOLD);
        h.badges.setGravity(Gravity.END);
        top.addView(h.badges, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        card.addView(top);

        // Middle: teams.
        LinearLayout mid = new LinearLayout(this);
        mid.setOrientation(LinearLayout.HORIZONTAL);
        mid.setGravity(Gravity.CENTER_VERTICAL);
        h.middle = new TextView(this);
        h.middle.setTextColor(color(R.color.text));
        h.middle.setTypeface(Typeface.DEFAULT_BOLD);
        h.middle.setGravity(Gravity.CENTER);
        if (e.away.isEmpty()) {
            h.middle.setText(e.home);
            h.middle.setTextSize(16);
            h.middle.setMaxLines(3);
            h.middle.setEllipsize(TextUtils.TruncateAt.END);
            mid.addView(h.middle, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        } else {
            mid.addView(teamColumn(e.home, e.crestHome));
            h.middle.setTextSize(17);
            h.middle.setSingleLine(true);
            mid.addView(h.middle, new LinearLayout.LayoutParams(dp(68), ViewGroup.LayoutParams.WRAP_CONTENT));
            mid.addView(teamColumn(e.away, e.crestAway));
        }
        card.addView(mid, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // Bottom: league / sport tag.
        TextView league = new TextView(this);
        league.setText(prettyLeague(e.league));
        league.setTextColor(color(R.color.muted));
        league.setTextSize(11);
        league.setSingleLine(true);
        league.setEllipsize(TextUtils.TruncateAt.END);
        card.addView(league);

        h.card = card;
        bindDynamic(h);

        card.setOnClickListener(v -> openEvent(e));
        card.setOnLongClickListener(v -> {
            showFavoritesDialog(e);
            return true;
        });
        card.setOnFocusChangeListener((v, has) -> {
            v.animate().scaleX(has ? 1.06f : 1f).scaleY(has ? 1.06f : 1f).setDuration(120).start();
            if (has) {
                focusedEventId = e.id;
                alignCard(hsv, v);
                alignRow(row);
            }
        });

        List<CardHolder> list = holders.get(e.id);
        if (list == null) {
            list = new ArrayList<>(2);
            holders.put(e.id, list);
        }
        list.add(h);
        return card;
    }

    private View teamColumn(String name, String crestUrl) {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        col.setLayoutParams(new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        ImageView crest = new ImageView(this);
        crest.setScaleType(ImageView.ScaleType.FIT_CENTER);
        col.addView(crest, new LinearLayout.LayoutParams(dp(CREST_DP), dp(CREST_DP)));
        images.load(crestUrl, crest, R.drawable.crest_placeholder);

        TextView n = new TextView(this);
        n.setText(name);
        n.setTextColor(color(R.color.text));
        n.setTextSize(12.5f);
        n.setGravity(Gravity.CENTER_HORIZONTAL);
        n.setMaxLines(2);
        n.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        np.topMargin = dp(5);
        col.addView(n, np);
        return col;
    }

    /** Parts of a card that change while the screen is open (live clock, score). */
    private void bindDynamic(CardHolder h) {
        Event e = h.event;
        if (e.ended) {
            h.pill.setText(R.string.pill_final);
            h.pill.setBackground(pillBackground(color(R.color.pill_time)));
        } else if (e.live) {
            String txt = getString(R.string.pill_live);
            if (!e.liveText.isEmpty()) txt += "  " + e.liveText;
            h.pill.setText(txt);
            h.pill.setBackground(pillBackground(color(R.color.live)));
        } else {
            h.pill.setText(startLabel(e.startTs));
            h.pill.setBackground(pillBackground(color(R.color.pill_time)));
        }
        if (!e.away.isEmpty()) {
            if (!e.score.isEmpty()) {
                h.middle.setText(e.score.replace(" - ", "–"));
                h.middle.setTextColor(color(R.color.text));
            } else {
                h.middle.setText(R.string.versus);
                h.middle.setTextColor(color(R.color.muted));
            }
        }
        StringBuilder b = new StringBuilder();
        boolean starred = favorites.matches(e);
        if (starred) b.append(getString(R.string.badge_favorite));
        if (e.hot) {
            if (b.length() > 0) b.append("   ");
            b.append(e.hotRank > 0 ? getString(R.string.badge_hot_rank, e.hotRank) : getString(R.string.badge_hot));
        }
        if (e.premium) {
            if (b.length() > 0) b.append("   ");
            b.append(getString(R.string.badge_premium));
        }
        h.badges.setText(b);
        h.badges.setTextColor(color(e.hot && !starred ? R.color.hot : R.color.gold));
    }

    private GradientDrawable pillBackground(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(5));
        return d;
    }

    /** Horizontally centre the focused card inside its row. */
    private void alignCard(HorizontalScrollView hsv, View card) {
        int target = card.getLeft() + card.getWidth() / 2 - hsv.getWidth() / 2 + hsv.getPaddingLeft();
        hsv.smoothScrollTo(Math.max(0, target), 0);
    }

    /** Vertically bring the focused row near the top so the rows below stay visible. */
    private void alignRow(View row) {
        scroller.smoothScrollTo(0, Math.max(0, row.getTop() - dp(6)));
    }

    // ---------------------------------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------------------------------

    private void openEvent(Event e) {
        if (e.url.isEmpty()) return;
        Recents.record(this, e);
        if (config.nativePlayer) {
            startActivity(NativePlayerActivity.intent(this, e));
        } else {
            startActivity(PlayerActivity.intent(this, e.url, true));
        }
    }

    /** Long-press on a card: star/unstar either team or the league. */
    private void showFavoritesDialog(final Event e) {
        final List<String> labels = new ArrayList<>();
        final List<Runnable> actions = new ArrayList<>();
        for (final String team : new String[] {e.home, e.away}) {
            if (team.isEmpty()) continue;
            boolean on = favorites.isTeam(team);
            labels.add(getString(on ? R.string.fav_remove_team : R.string.fav_add_team, team));
            actions.add(() -> {
                boolean now = favorites.toggleTeam(team);
                Toast.makeText(this, getString(now ? R.string.fav_added : R.string.fav_removed, team),
                        Toast.LENGTH_SHORT).show();
            });
        }
        final String leagueKey = favorites.leagueOf(e);
        if (!leagueKey.isEmpty()) {
            final String league = e.league.isEmpty() ? leagueKey : prettyLeague(leagueKey);
            boolean on = favorites.isLeague(leagueKey);
            labels.add(getString(on ? R.string.fav_remove_league : R.string.fav_add_league, league));
            actions.add(() -> {
                boolean now = favorites.toggleLeague(leagueKey);
                Toast.makeText(this, getString(now ? R.string.fav_added : R.string.fav_removed, league),
                        Toast.LENGTH_SHORT).show();
            });
        }
        if (labels.isEmpty()) return;
        new AlertDialog.Builder(this)
                .setTitle(R.string.fav_title)
                .setItems(labels.toArray(new String[0]), (d, which) -> {
                    actions.get(which).run();
                    focusedEventId = e.id;
                    if (snapshot != null) render(snapshot);
                })
                .setNegativeButton(R.string.action_dismiss, null)
                .show();
    }

    private void openWebsite() {
        startActivity(PlayerActivity.intent(this, config.homeUrl, false));
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_MENU) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                Toast.makeText(this, R.string.refreshing, Toast.LENGTH_SHORT).show();
                fullRefresh(true);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (updates != null) updates.onActivityResult(requestCode);
    }

    // ---------------------------------------------------------------------------------------------
    // Formatting helpers
    // ---------------------------------------------------------------------------------------------

    private String startLabel(long startTs) {
        if (startTs <= 0) return getString(R.string.pill_upcoming);
        Date d = new Date(startTs * 1000L);
        Calendar now = Calendar.getInstance();
        Calendar then = Calendar.getInstance();
        then.setTime(d);
        boolean sameDay = now.get(Calendar.YEAR) == then.get(Calendar.YEAR)
                && now.get(Calendar.DAY_OF_YEAR) == then.get(Calendar.DAY_OF_YEAR);
        String pattern = sameDay ? "h:mm a" : "EEE h:mm a";
        return new SimpleDateFormat(pattern, Locale.getDefault()).format(d);
    }

    private String timeOf(long ms) {
        return new SimpleDateFormat("h:mm a", Locale.getDefault()).format(new Date(ms));
    }

    private static final Map<String, String> LEAGUE_NAMES = new HashMap<>();

    static {
        LEAGUE_NAMES.put("epl", "Premier League");
        LEAGUE_NAMES.put("laliga", "La Liga");
        LEAGUE_NAMES.put("seriea", "Serie A");
        LEAGUE_NAMES.put("ligue1", "Ligue 1");
        LEAGUE_NAMES.put("bundesliga", "Bundesliga");
        LEAGUE_NAMES.put("bundesliga2", "2. Bundesliga");
        LEAGUE_NAMES.put("mls", "MLS");
        LEAGUE_NAMES.put("championship", "Championship");
        LEAGUE_NAMES.put("leagueone", "League One");
        LEAGUE_NAMES.put("leaguetwo", "League Two");
        LEAGUE_NAMES.put("eredivisie", "Eredivisie");
        LEAGUE_NAMES.put("ligamx", "Liga MX");
        LEAGUE_NAMES.put("portugal", "Primeira Liga");
        LEAGUE_NAMES.put("argentina", "Argentine Primera");
        LEAGUE_NAMES.put("brazil", "Brasileirão");
        LEAGUE_NAMES.put("colombia", "Colombian Primera A");
        LEAGUE_NAMES.put("ucl", "Champions League");
        LEAGUE_NAMES.put("uel", "Europa League");
    }

    private static String prettyLeague(String key) {
        if (key == null || key.isEmpty()) return "";
        String known = LEAGUE_NAMES.get(key.toLowerCase(Locale.ROOT));
        if (known != null) return known;
        String s = key.replace('-', ' ').replace('_', ' ');
        return s.length() <= 4 ? s.toUpperCase(Locale.ROOT)
                : Character.toUpperCase(s.charAt(0)) + s.substring(1);
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
    protected void onResume() {
        super.onResume();
        if (repo == null) return; // kill-switch path
        applyImmersiveMode();
        handler.removeCallbacks(statusTick);
        handler.removeCallbacks(fullTick);
        handler.postDelayed(statusTick, STATUS_INTERVAL_MS);
        handler.postDelayed(fullTick, FULL_REFRESH_INTERVAL_MS);
        bindAccountButton();
        // The launcher keeps this activity alive for days; a new release must not need a force-stop.
        if (CrashLog.pendingReport(this) == null) updates.checkIfDue();
        if (snapshot != null && !loading) {
            boolean premiumHidden = premiumHidden();
            if (premiumHidden != renderedPremiumHidden || hasLiveTv() != renderedLiveTv
                    || !keyOf(premiumPass(continueWatching(snapshot), premiumHidden, false)).equals(recentsKey)) {
                render(snapshot);
            }
            if (System.currentTimeMillis() - snapshot.fetchedAtMs > STALE_ON_RESUME_MS) {
                fullRefresh(false);
            } else {
                refreshStatusOnly();
            }
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(statusTick);
        handler.removeCallbacks(fullTick);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        if (images != null) images.shutdown();
        super.onDestroy();
    }

}
