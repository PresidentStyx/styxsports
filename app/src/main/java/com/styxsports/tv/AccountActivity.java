package com.styxsports.tv;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;

import java.util.EnumMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Sign in to the site's premium account with its TV flow: the screen shows a short code and a QR
 * code; the viewer signs in on their phone and types the code. When signed in the screen shows
 * the account state and a sign-out button.
 */
public class AccountActivity extends Activity {

    private static final String TAG = "StyxAccountUi";
    private static final long POLL_MS = 3_000L;
    private static final long TICK_MS = 1_000L;
    private static final long CLOSE_AFTER_SUCCESS_MS = 1_600L;

    static Intent intent(Context ctx) {
        return new Intent(ctx, AccountActivity.class);
    }

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private float density;
    private Account account;

    private TextView title, lead, steps, status;
    private LinearLayout buttons;
    private View codeCard;
    private TextView codeLabel, codeText, countdown;
    private ImageView qr;

    private Account.Code code;
    private boolean finishing;
    private int generation;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (code == null) return;
            long rem = code.expiresAt - System.currentTimeMillis() / 1000;
            if (rem <= 0) {
                onCodeGone(getString(R.string.acct_code_expired));
                return;
            }
            countdown.setText(getString(R.string.acct_expires_in, rem / 60, rem % 60));
            countdown.setTextColor(rem <= 60 ? color(R.color.hot) : color(R.color.muted));
            handler.postDelayed(this, TICK_MS);
        }
    };

    private final Runnable poll = new Runnable() {
        @Override
        public void run() {
            final Account.Code c = code;
            final int gen = generation;
            if (c == null) return;
            io.execute(() -> {
                Account.Poll p;
                try {
                    p = account.poll(c);
                } catch (Exception e) {
                    Log.w(TAG, "poll failed: " + e.getMessage());
                    p = new Account.Poll("pending", "");
                }
                final Account.Poll res = p;
                handler.post(() -> {
                    if (gen != generation || isFinishing()) return;
                    onPoll(res);
                });
            });
        }
    };

    // ---------------------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------------------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        density = getResources().getDisplayMetrics().density;
        account = new Account(this, RemoteConfig.load(this));
        Http.ensureCookies();
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(buildUi());

        if (Account.isSignedIn(this)) {
            showSignedIn();
            verifySession();
        } else {
            startCodeFlow();
        }
    }

    @Override
    protected void onDestroy() {
        generation++;
        handler.removeCallbacksAndMessages(null);
        io.shutdownNow();
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

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(72), dp(40), dp(72), dp(40));
        root.addView(row, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // --- Left: what this is and how to do it.
        LinearLayout left = new LinearLayout(this);
        left.setOrientation(LinearLayout.VERTICAL);
        row.addView(left, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.wordmark);
        logo.setScaleType(ImageView.ScaleType.FIT_START);
        left.addView(logo, new LinearLayout.LayoutParams(dp(196), dp(30)));

        title = new TextView(this);
        title.setTextColor(color(R.color.text));
        title.setTextSize(28);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setText(R.string.acct_title);
        left.addView(title, margins(0, dp(26), 0, 0));

        lead = new TextView(this);
        lead.setTextColor(color(R.color.muted));
        lead.setTextSize(15);
        lead.setLineSpacing(0, 1.15f);
        left.addView(lead, margins(0, dp(8), dp(40), 0));

        steps = new TextView(this);
        steps.setTextColor(color(R.color.text));
        steps.setTextSize(16);
        steps.setLineSpacing(0, 1.35f);
        left.addView(steps, margins(0, dp(22), dp(40), 0));

        status = new TextView(this);
        status.setTextColor(color(R.color.muted));
        status.setTextSize(14);
        left.addView(status, margins(0, dp(22), 0, 0));

        buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        left.addView(buttons, margins(0, dp(18), 0, 0));

        // --- Right: the code card.
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER_HORIZONTAL);
        card.setPadding(dp(30), dp(26), dp(30), dp(26));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(color(R.color.surface));
        bg.setStroke(dp(1), color(R.color.outline_strong));
        bg.setCornerRadius(dp(18));
        card.setBackground(bg);
        codeCard = card;
        row.addView(card, new LinearLayout.LayoutParams(dp(340), ViewGroup.LayoutParams.WRAP_CONTENT));

        codeLabel = new TextView(this);
        codeLabel.setTextColor(color(R.color.muted));
        codeLabel.setTextSize(13);
        codeLabel.setAllCaps(true);
        codeLabel.setLetterSpacing(0.12f);
        codeLabel.setText(R.string.acct_your_code);
        card.addView(codeLabel);

        codeText = new TextView(this);
        codeText.setTextColor(color(R.color.gold));
        codeText.setTextSize(54);
        codeText.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        codeText.setGravity(Gravity.CENTER);
        codeText.setText(R.string.acct_code_placeholder);
        card.addView(codeText, margins(0, dp(6), 0, 0));

        countdown = new TextView(this);
        countdown.setTextColor(color(R.color.muted));
        countdown.setTextSize(13);
        card.addView(countdown, margins(0, dp(2), 0, dp(18)));

        FrameLayout qrFrame = new FrameLayout(this);
        qrFrame.setBackgroundColor(Color.WHITE);
        qrFrame.setPadding(dp(8), dp(8), dp(8), dp(8));
        qr = new ImageView(this);
        qr.setScaleType(ImageView.ScaleType.FIT_CENTER);
        qrFrame.addView(qr, new FrameLayout.LayoutParams(dp(184), dp(184)));
        card.addView(qrFrame);

        TextView scan = new TextView(this);
        scan.setTextColor(color(R.color.muted));
        scan.setTextSize(12);
        scan.setGravity(Gravity.CENTER);
        scan.setText(R.string.acct_scan_hint);
        card.addView(scan, margins(0, dp(12), 0, 0));

        return root;
    }

    private LinearLayout.LayoutParams margins(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(l, t, r, b);
        return lp;
    }

    private TextView pillButton(String label, View.OnClickListener onClick) {
        TextView b = new TextView(this);
        b.setText(label);
        b.setTextColor(ContextCompat.getColorStateList(this, R.color.button_text));
        b.setTextSize(15);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setPadding(dp(22), dp(11), dp(22), dp(11));
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

    private void setButtons(TextView... items) {
        buttons.removeAllViews();
        for (TextView b : items) buttons.addView(b);
        if (items.length > 0) items[0].requestFocus();
    }

    // ---------------------------------------------------------------------------------------------
    // Signed-out: code flow
    // ---------------------------------------------------------------------------------------------

    private void startCodeFlow() {
        stopTimers();
        finishing = false;
        code = null;
        codeCard.setVisibility(View.VISIBLE);
        lead.setText(R.string.acct_lead);
        steps.setText(getString(R.string.acct_steps, account.activateDisplay()));
        codeText.setText(R.string.acct_code_placeholder);
        codeText.setTextColor(color(R.color.muted));
        countdown.setText("");
        qr.setImageBitmap(qrBitmap(account.activateUrl(), dp(184)));
        status.setText(R.string.acct_getting_code);
        setButtons(pillButton(getString(R.string.acct_cancel), v -> finish()));

        final int gen = ++generation;
        io.execute(() -> {
            try {
                final Account.Code c = account.requestCode();
                handler.post(() -> {
                    if (gen != generation || isFinishing()) return;
                    onCode(c);
                });
            } catch (Exception e) {
                Log.w(TAG, "code request failed: " + e);
                handler.post(() -> {
                    if (gen != generation || isFinishing()) return;
                    status.setText(getString(R.string.acct_error, shortError(e)));
                    setButtons(pillButton(getString(R.string.action_retry), v -> startCodeFlow()),
                            pillButton(getString(R.string.acct_cancel), v -> finish()));
                });
            }
        });
    }

    private void onCode(Account.Code c) {
        code = c;
        codeText.setText(c.display());
        codeText.setTextColor(color(R.color.gold));
        status.setText(R.string.acct_waiting);
        setButtons(pillButton(getString(R.string.acct_new_code), v -> startCodeFlow()),
                pillButton(getString(R.string.acct_cancel), v -> finish()));
        handler.post(tick);
        handler.postDelayed(poll, POLL_MS);
    }

    private void onPoll(Account.Poll p) {
        if (code == null || finishing) return;
        switch (p.status) {
            case "approved":
                stopTimers();
                finishing = true;
                codeText.setText(R.string.acct_code_approved);
                codeText.setTextColor(color(R.color.text));
                countdown.setText("");
                status.setText(R.string.acct_finishing);
                setButtons();
                completeSignIn(p.token);
                break;
            case "used":
                onCodeGone(getString(R.string.acct_code_used));
                break;
            case "expired":
            case "invalid":
                onCodeGone(getString(R.string.acct_code_expired));
                break;
            default:
                handler.postDelayed(poll, POLL_MS);
        }
    }

    private void onCodeGone(String why) {
        stopTimers();
        code = null;
        codeText.setText(R.string.acct_code_placeholder);
        codeText.setTextColor(color(R.color.muted));
        countdown.setText("");
        status.setText(why);
        setButtons(pillButton(getString(R.string.acct_new_code), v -> startCodeFlow()),
                pillButton(getString(R.string.acct_cancel), v -> finish()));
    }

    private void completeSignIn(final String token) {
        final int gen = ++generation;
        io.execute(() -> {
            try {
                account.completeSignIn(token);
                handler.post(() -> {
                    if (gen != generation || isFinishing()) return;
                    Toast.makeText(this, R.string.acct_signed_in_toast, Toast.LENGTH_LONG).show();
                    showSignedIn();
                    handler.postDelayed(this::finish, CLOSE_AFTER_SUCCESS_MS);
                });
            } catch (Exception e) {
                Log.w(TAG, "sign-in completion failed: " + e);
                handler.post(() -> {
                    if (gen != generation || isFinishing()) return;
                    finishing = false;
                    status.setText(getString(R.string.acct_error, shortError(e)));
                    setButtons(pillButton(getString(R.string.action_retry), v -> startCodeFlow()),
                            pillButton(getString(R.string.acct_cancel), v -> finish()));
                });
            }
        });
    }

    private void stopTimers() {
        handler.removeCallbacks(tick);
        handler.removeCallbacks(poll);
    }

    // ---------------------------------------------------------------------------------------------
    // Signed-in
    // ---------------------------------------------------------------------------------------------

    private void showSignedIn() {
        stopTimers();
        code = null;
        codeCard.setVisibility(View.GONE);
        lead.setText(R.string.acct_signed_in_lead);
        Boolean premium = Account.premiumKnown(this);
        steps.setText(premium == null ? R.string.acct_premium_unknown
                : premium ? R.string.acct_premium_yes : R.string.acct_premium_no);
        status.setText("");
        setButtons(pillButton(getString(R.string.acct_back), v -> finish()),
                pillButton(getString(R.string.acct_sign_out), v -> signOut()));
    }

    /** The session may have lapsed since last time; ask the account service quietly. */
    private void verifySession() {
        final int gen = ++generation;
        io.execute(() -> {
            boolean ok;
            try {
                ok = account.refreshStatus();
            } catch (Exception e) {
                return; // offline: keep showing what we know
            }
            if (ok) return;
            handler.post(() -> {
                if (gen != generation || isFinishing()) return;
                Toast.makeText(this, R.string.acct_session_lapsed, Toast.LENGTH_LONG).show();
                startCodeFlow();
            });
        });
    }

    private void signOut() {
        status.setText(R.string.acct_signing_out);
        setButtons();
        final int gen = ++generation;
        io.execute(() -> {
            account.signOut();
            handler.post(() -> {
                if (gen != generation || isFinishing()) return;
                Toast.makeText(this, R.string.acct_signed_out_toast, Toast.LENGTH_SHORT).show();
                startCodeFlow();
            });
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private static Bitmap qrBitmap(String text, int px) {
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.MARGIN, 0);
            BitMatrix m = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, px, px, hints);
            int w = m.getWidth(), h = m.getHeight();
            int[] pixels = new int[w * h];
            for (int y = 0; y < h; y++) {
                int off = y * w;
                for (int x = 0; x < w; x++) pixels[off + x] = m.get(x, y) ? Color.BLACK : Color.WHITE;
            }
            Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.RGB_565);
            b.setPixels(pixels, 0, w, 0, 0, w, h);
            return b;
        } catch (Exception e) {
            Log.w(TAG, "qr failed: " + e);
            return null;
        }
    }

    private static String shortError(Exception e) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }
}
