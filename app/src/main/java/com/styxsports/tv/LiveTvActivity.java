package com.styxsports.tv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.BaseAdapter;
import android.widget.FrameLayout;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import java.text.DateFormat;
import java.text.NumberFormat;
import java.util.Collections;
import java.util.Date;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Live TV: the premium account's IPTV channels. Groups down the left, the selected group's
 * channels in a grid on the right; OK on a channel opens it in the native player, where
 * Left/Right zap through the group. Both lists recycle their rows (11k channels).
 */
public class LiveTvActivity extends Activity {

    private static final String TAG = "StyxLiveTv";
    private static final String PREFS = "styxsports_livetv";
    private static final String KEY_GROUP = "group";

    static Intent intent(Context ctx) {
        return new Intent(ctx, LiveTvActivity.class);
    }

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private float density;
    private ImageLoader logos;

    private TextView subtitle, hint;
    private ListView groupList;
    private GridView grid;
    private View statusPanel;
    private ProgressBar spinner;
    private TextView statusText;
    private LinearLayout statusButtons;

    private Iptv playlist;
    private List<Iptv.Group> groups = Collections.emptyList();
    private Iptv.Group shown;
    private final GroupAdapter groupAdapter = new GroupAdapter();
    private final ChannelAdapter channelAdapter = new ChannelAdapter();
    private boolean refreshing;

    // ---------------------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;
        logos = new ImageLoader(dp(56));
        Http.ensureCookies();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(buildUi());
        load(false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Coming back from the player: the recently-watched group may have changed.
        if (playlist != null) bindGroups(false);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
        logos.shutdown();
        super.onDestroy();
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

    private View buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(color(R.color.bg));

        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        root.addView(column, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // --- Top bar
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(48), dp(22), dp(48), dp(14));
        column.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.wordmark);
        logo.setScaleType(ImageView.ScaleType.FIT_START);
        bar.addView(logo, new LinearLayout.LayoutParams(dp(196), dp(30)));

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        tlp.leftMargin = dp(22);
        bar.addView(titles, tlp);

        TextView title = new TextView(this);
        title.setText(R.string.ltv_title);
        title.setTextColor(color(R.color.text));
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        titles.addView(title);

        subtitle = new TextView(this);
        subtitle.setTextColor(color(R.color.muted));
        subtitle.setTextSize(13);
        subtitle.setSingleLine();
        subtitle.setEllipsize(TextUtils.TruncateAt.END);
        titles.addView(subtitle);

        hint = new TextView(this);
        hint.setTextColor(color(R.color.muted));
        hint.setTextSize(13);
        hint.setSingleLine();
        hint.setText(R.string.ltv_hint);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.leftMargin = dp(16);
        bar.addView(hint, hlp);

        // --- Body: groups | channels
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.HORIZONTAL);
        body.setPadding(dp(40), 0, dp(40), dp(16));
        column.addView(body, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        groupList = new ListView(this);
        groupList.setId(View.generateViewId());
        groupList.setAdapter(groupAdapter);
        groupList.setDivider(null);
        groupList.setDividerHeight(dp(2));
        groupList.setVerticalScrollBarEnabled(false);
        groupList.setSelector(focusFrame());
        groupList.setDrawSelectorOnTop(true);
        groupList.setPadding(dp(8), dp(4), dp(8), dp(4));
        groupList.setClipToPadding(false);
        groupList.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                showGroup(position, false);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });
        groupList.setOnItemClickListener((parent, view, position, id) -> {
            showGroup(position, false);
            if (channelAdapter.getCount() > 0) grid.requestFocus();
        });
        groupList.setOnFocusChangeListener((v, has) -> groupAdapter.notifyDataSetChanged());
        body.addView(groupList, new LinearLayout.LayoutParams(dp(300), ViewGroup.LayoutParams.MATCH_PARENT));

        grid = new GridView(this);
        grid.setId(View.generateViewId());
        grid.setAdapter(channelAdapter);
        grid.setNumColumns(4);
        grid.setHorizontalSpacing(dp(10));
        grid.setVerticalSpacing(dp(10));
        grid.setStretchMode(GridView.STRETCH_COLUMN_WIDTH);
        grid.setVerticalScrollBarEnabled(false);
        grid.setSelector(focusFrame());
        grid.setDrawSelectorOnTop(true);
        grid.setPadding(dp(8), dp(4), dp(8), dp(4));
        grid.setClipToPadding(false);
        grid.setOnItemClickListener((parent, view, position, id) -> openChannel(position));
        grid.setOnFocusChangeListener((v, has) -> {
            if (has && grid.getSelectedItemPosition() == AdapterView.INVALID_POSITION && channelAdapter.getCount() > 0) {
                grid.setSelection(0);
            }
        });
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f);
        glp.leftMargin = dp(16);
        body.addView(grid, glp);

        groupList.setNextFocusRightId(grid.getId());
        grid.setNextFocusLeftId(groupList.getId());

        // --- Status (loading / error) overlay
        statusPanel = buildStatusPanel();
        root.addView(statusPanel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return root;
    }

    /** Selector for the lists: the app's white focus ring, only while the list itself has focus. */
    private StateListDrawable focusFrame() {
        GradientDrawable ring = new GradientDrawable();
        ring.setColor(0x00000000);
        ring.setStroke(dp(3), color(R.color.accent));
        ring.setCornerRadius(dp(12));
        StateListDrawable d = new StateListDrawable();
        d.addState(new int[] {android.R.attr.state_focused}, ring);
        d.addState(new int[0], new ColorDrawable(0x00000000));
        return d;
    }

    private View buildStatusPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setBackgroundColor(0xCC0A0A0A);
        panel.setClickable(true);
        spinner = new ProgressBar(this);
        panel.addView(spinner, new LinearLayout.LayoutParams(dp(44), dp(44)));
        statusText = new TextView(this);
        statusText.setTextColor(color(R.color.text));
        statusText.setTextSize(17);
        statusText.setGravity(Gravity.CENTER);
        statusText.setPadding(dp(120), dp(18), dp(120), dp(18));
        panel.addView(statusText);
        statusButtons = new LinearLayout(this);
        statusButtons.setOrientation(LinearLayout.HORIZONTAL);
        panel.addView(statusButtons);
        return panel;
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

    private void showStatus(String message, boolean busy) {
        statusPanel.setVisibility(View.VISIBLE);
        spinner.setVisibility(busy ? View.VISIBLE : View.GONE);
        statusText.setText(message);
        statusButtons.removeAllViews();
    }

    private void showError(String message) {
        showStatus(message, false);
        statusButtons.addView(pillButton(getString(R.string.action_retry), v -> load(true)));
        statusButtons.addView(pillButton(getString(R.string.acct_back), v -> finish()));
        statusButtons.getChildAt(0).requestFocus();
    }

    private void hideStatus() {
        statusPanel.setVisibility(View.GONE);
    }

    // ---------------------------------------------------------------------------------------------
    // Data
    // ---------------------------------------------------------------------------------------------

    /** Shows the cached playlist at once and re-downloads it when it is old (or on demand). */
    private void load(boolean force) {
        if (refreshing) return;
        refreshing = true;
        if (playlist == null) showStatus(getString(R.string.ltv_loading), true);
        else Toast.makeText(this, R.string.ltv_refreshing, Toast.LENGTH_SHORT).show();
        io.execute(() -> {
            Iptv cached = force ? Iptv.loaded() : Iptv.cached(this);
            if (cached != null && playlist == null) {
                handler.post(() -> onPlaylist(cached));
            }
            if (cached != null && cached.isFresh() && !force) {
                handler.post(() -> refreshing = false);
                return;
            }
            try {
                final Iptv fresh = Iptv.fetch(this);
                handler.post(() -> {
                    refreshing = false;
                    onPlaylist(fresh);
                });
            } catch (Exception e) {
                Log.w(TAG, "playlist fetch failed: " + e);
                final String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                handler.post(() -> {
                    refreshing = false;
                    if (isFinishing()) return;
                    if (playlist == null) showError(getString(R.string.ltv_failed, why));
                    else Toast.makeText(this, getString(R.string.ltv_failed, why), Toast.LENGTH_LONG).show();
                });
            }
        });
    }

    private void onPlaylist(Iptv p) {
        if (isFinishing()) return;
        boolean first = playlist == null;
        playlist = p;
        hideStatus();
        subtitle.setText(getString(R.string.ltv_subtitle,
                NumberFormat.getIntegerInstance().format(p.channelCount), p.groups.size(),
                DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(p.fetchedAt))));
        bindGroups(first);
    }

    private void bindGroups(boolean restoreSelection) {
        groups = playlist.groupsWithRecent(this);
        groupAdapter.notifyDataSetChanged();
        if (groups.isEmpty()) {
            showError(getString(R.string.ltv_failed, getString(R.string.ltv_empty)));
            return;
        }
        int pos = 0;
        String remembered = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_GROUP, null);
        String target = restoreSelection || shown == null ? remembered : shown.name;
        if (target != null) {
            for (int i = 0; i < groups.size(); i++) if (groups.get(i).name.equals(target)) pos = i;
        }
        groupList.setSelection(pos);
        showGroup(pos, true);
        if (restoreSelection) groupList.requestFocus();
    }

    private void showGroup(int position, boolean force) {
        if (position < 0 || position >= groups.size()) return;
        Iptv.Group g = groups.get(position);
        if (!force && g == shown) return;
        boolean sameName = shown != null && shown.name.equals(g.name);
        shown = g;
        channelAdapter.notifyDataSetChanged();
        if (!sameName) grid.setSelection(0);
        groupAdapter.notifyDataSetChanged();
        if (!Iptv.RECENT_GROUP.equals(g.name)) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_GROUP, g.name).apply();
        }
    }

    private void openChannel(int position) {
        if (shown == null || position < 0 || position >= shown.channels.size()) return;
        startActivity(NativePlayerActivity.channelIntent(this, shown.name, position));
    }

    // ---------------------------------------------------------------------------------------------
    // Keys
    // ---------------------------------------------------------------------------------------------

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            switch (e.getKeyCode()) {
                case KeyEvent.KEYCODE_MENU:
                    load(true);
                    return true;
                case KeyEvent.KEYCODE_BACK:
                case KeyEvent.KEYCODE_ESCAPE:
                    if (grid.hasFocus() && statusPanel.getVisibility() != View.VISIBLE) {
                        groupList.requestFocus();
                        return true;
                    }
                    break;
                default:
                    break;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    // ---------------------------------------------------------------------------------------------
    // Adapters
    // ---------------------------------------------------------------------------------------------

    private final class GroupAdapter extends BaseAdapter {
        @Override
        public int getCount() {
            return groups.size();
        }

        @Override
        public Object getItem(int position) {
            return groups.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            LinearLayout row;
            TextView name, count;
            if (convertView == null) {
                row = new LinearLayout(LiveTvActivity.this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(16), dp(11), dp(16), dp(11));
                name = new TextView(LiveTvActivity.this);
                name.setTextSize(15);
                name.setSingleLine();
                name.setEllipsize(TextUtils.TruncateAt.END);
                row.addView(name, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
                count = new TextView(LiveTvActivity.this);
                count.setTextSize(12);
                count.setTextColor(color(R.color.muted));
                LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                clp.leftMargin = dp(10);
                row.addView(count, clp);
                row.setTag(new View[] {name, count});
            } else {
                row = (LinearLayout) convertView;
                View[] parts = (View[]) row.getTag();
                name = (TextView) parts[0];
                count = (TextView) parts[1];
            }
            Iptv.Group g = groups.get(position);
            boolean active = g == shown;
            name.setText(g.name);
            name.setTypeface(active ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            name.setTextColor(color(active ? R.color.text : R.color.muted));
            count.setText(String.valueOf(g.channels.size()));
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(color(active ? R.color.surface_focused : R.color.surface));
            bg.setCornerRadius(dp(12));
            row.setBackground(bg);
            return row;
        }
    }

    private final class ChannelAdapter extends BaseAdapter {
        @Override
        public int getCount() {
            return shown == null ? 0 : shown.channels.size();
        }

        @Override
        public Object getItem(int position) {
            return shown.channels.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            LinearLayout cell;
            ImageView logo;
            TextView name;
            if (convertView == null) {
                // Logo on top (channel logos are wide), name under it.
                cell = new LinearLayout(LiveTvActivity.this);
                cell.setOrientation(LinearLayout.VERTICAL);
                cell.setGravity(Gravity.CENTER_HORIZONTAL);
                cell.setPadding(dp(12), dp(12), dp(12), dp(10));
                GradientDrawable bg = new GradientDrawable();
                bg.setColor(color(R.color.surface));
                bg.setStroke(dp(1), color(R.color.outline));
                bg.setCornerRadius(dp(12));
                cell.setBackground(bg);
                cell.setLayoutParams(new AbsListViewParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(112)));
                logo = new ImageView(LiveTvActivity.this);
                logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
                cell.addView(logo, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)));
                name = new TextView(LiveTvActivity.this);
                name.setTextColor(color(R.color.text));
                name.setTextSize(13);
                name.setMaxLines(2);
                name.setGravity(Gravity.CENTER_HORIZONTAL);
                name.setEllipsize(TextUtils.TruncateAt.END);
                LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                nlp.topMargin = dp(8);
                cell.addView(name, nlp);
                cell.setTag(new View[] {logo, name});
            } else {
                cell = (LinearLayout) convertView;
                View[] parts = (View[]) cell.getTag();
                logo = (ImageView) parts[0];
                name = (TextView) parts[1];
            }
            Iptv.Channel c = shown.channels.get(position);
            name.setText(displayName(c));
            logos.load(c.logo, logo, R.drawable.crest_placeholder);
            return cell;
        }

        /** "US: ESPN" in the "US | Sport" group is just "ESPN"; the group already says where. */
        private String displayName(Iptv.Channel c) {
            int bar = c.group.indexOf('|');
            String code = (bar > 0 ? c.group.substring(0, bar) : "").trim();
            if (!code.isEmpty() && c.name.length() > code.length() + 2
                    && c.name.regionMatches(true, 0, code, 0, code.length())
                    && c.name.charAt(code.length()) == ':') {
                return c.name.substring(code.length() + 1).trim();
            }
            return c.name;
        }
    }

    /** GridView needs its children's params to be AbsListView.LayoutParams. */
    private static final class AbsListViewParams extends android.widget.AbsListView.LayoutParams {
        AbsListViewParams(int w, int h) {
            super(w, h);
        }
    }
}
