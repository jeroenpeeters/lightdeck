package nl.lightdeck.bridge;

import android.app.Activity;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/**
 * Screen for the LR512 bridge. All the work happens in {@link BridgeCore}, which outlives
 * this Activity; this class only shows the two connections and the log, and keeps the
 * screen on.
 *
 * The screen is dark because the phone lies next to the lights during a show. The colours
 * are those of the Lightdeck page (src/server/public/styles.css).
 *
 * The same log goes to logcat (tag "LR512GATE") and to lr512-gate.log in the app's
 * external files directory.
 */
public class OpenGateActivity extends Activity {

    private static final int MAX_VIEW_LINES = 400;
    private static final long STATUS_EVERY_MS = 300;
    // After scrolling back by hand the log stays where it is for this long, then follows again.
    private static final long FOLLOW_AGAIN_MS = 15000;
    private static final int TIMESTAMP_CHARS = 12; // "HH:mm:ss.SSS"

    private static final int GROUND = 0xff0f1114;
    private static final int PANEL = 0xff181b20;
    private static final int KEY = 0xff272c34;
    private static final int KEY_DOWN = 0xff363d48;
    private static final int PAPER = 0xfff4f6f7;
    private static final int DIM = 0xffaeb6bf;
    private static final int FAINT = 0xff7d8792;
    private static final int GO = 0xff35d07f;
    private static final int STOP = 0xffff4a3d;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView logView;
    private ScrollView scroll;
    private Lamp deviceLamp;
    private Lamp engineLamp;
    private BridgeCore core;
    private int viewLines = 0;
    private boolean follow = true;
    private boolean touching = false;
    private long lastTouch = 0;

    private final BridgeCore.LogSink sink = new BridgeCore.LogSink() {
        @Override public void onLine(String line) { postLine(line); }
    };

    private final Runnable statusTick = new Runnable() {
        @Override public void run() {
            showStatus();
            ui.postDelayed(this, STATUS_EVERY_MS);
        }
    };

    private final Runnable toLatest = new Runnable() {
        // ScrollView limits this to the end of the log.
        @Override public void run() { scroll.scrollTo(0, logView.getHeight()); }
    };

    /** A round light with a name: green when connected, red when not. */
    private static final class Lamp {
        final LinearLayout view;
        final GradientDrawable light;
        final String name;
        Boolean on; // null until the first status

        Lamp(LinearLayout view, GradientDrawable light, String name) {
            this.view = view;
            this.light = light;
            this.name = name;
        }

        void set(boolean connected) {
            if (on != null && on == connected) return;
            on = connected;
            light.setColor(connected ? GO : STOP);
            view.setContentDescription(name + (connected ? " connected" : " not connected"));
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // While this screen is visible the phone stays awake, so Android does not freeze
        // the process and drop the device connection.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setBackgroundDrawable(new ColorDrawable(GROUND));
        getWindow().setStatusBarColor(GROUND);
        getWindow().setNavigationBarColor(GROUND);

        final int pad = dp(16);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(GROUND);
        root.setPadding(pad, pad, pad, pad);
        // Newer Android draws the app behind the status and navigation bars.
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int left, top, right, bottom;
                if (Build.VERSION.SDK_INT >= 30) {
                    Insets bars = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    left = bars.left; top = bars.top; right = bars.right; bottom = bars.bottom;
                } else {
                    left = insets.getSystemWindowInsetLeft();
                    top = insets.getSystemWindowInsetTop();
                    right = insets.getSystemWindowInsetRight();
                    bottom = insets.getSystemWindowInsetBottom();
                }
                v.setPadding(pad + left, pad + top, pad + right, pad + bottom);
                return insets;
            }
        });

        root.addView(header(), new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        logView = new TextView(this);
        logView.setTextColor(DIM);
        logView.setTextSize(12f);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setLineSpacing(dp(2), 1f);
        logView.setPadding(dp(12), dp(12), dp(12), dp(12));

        scroll = new ScrollView(this);
        scroll.setBackground(flat(PANEL));
        scroll.setClipToOutline(true);
        scroll.addView(logView);
        scroll.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                int action = e.getActionMasked();
                touching = action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL;
                lastTouch = System.currentTimeMillis();
                follow = false;
                return false;
            }
        });
        // The log is as tall as its text only after the next layout, so go to the end then.
        View.OnLayoutChangeListener resized = new View.OnLayoutChangeListener() {
            @Override public void onLayoutChange(View v, int l, int t, int r, int b,
                                                 int ol, int ot, int or, int ob) {
                if (follow && (b - t != ob - ot)) scroll.post(toLatest);
            }
        };
        logView.addOnLayoutChangeListener(resized);
        scroll.addOnLayoutChangeListener(resized);
        LinearLayout.LayoutParams logAt = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f);
        logAt.topMargin = dp(12);
        root.addView(scroll, logAt);

        Button rescan = new Button(this);
        rescan.setText("Scan for LR512");
        rescan.setAllCaps(false);
        rescan.setTextColor(PAPER);
        rescan.setTextSize(17f);
        rescan.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        rescan.setStateListAnimator(null);
        StateListDrawable key = new StateListDrawable();
        key.addState(new int[] { android.R.attr.state_pressed }, flat(KEY_DOWN));
        key.addState(new int[0], flat(KEY));
        rescan.setBackground(key);
        rescan.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { core.reEnumerate(); }
        });
        LinearLayout.LayoutParams keyAt = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, dp(56));
        keyAt.topMargin = dp(12);
        root.addView(rescan, keyAt);

        setContentView(root);

        core = BridgeCore.get(this);
    }

    @Override
    protected void onStart() {
        super.onStart();
        follow = true;
        showRecent();
        core.setSink(sink);
        statusTick.run();
    }

    @Override
    protected void onStop() {
        super.onStop();
        core.setSink(null);
        ui.removeCallbacks(statusTick);
    }

    private View header() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(dp(48));

        TextView title = new TextView(this);
        title.setText("LR512 Bridge");
        title.setTextColor(PAPER);
        title.setTextSize(20f);
        title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        row.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        deviceLamp = lamp("LR512");
        engineLamp = lamp("Lightdeck");
        row.addView(deviceLamp.view);
        row.addView(engineLamp.view);
        return row;
    }

    private Lamp lamp(String name) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        box.setPadding(dp(14), 0, 0, 0);

        GradientDrawable light = new GradientDrawable();
        light.setShape(GradientDrawable.OVAL);
        light.setColor(STOP);
        View dot = new View(this);
        dot.setBackground(light);
        box.addView(dot, new LinearLayout.LayoutParams(dp(14), dp(14)));

        TextView label = new TextView(this);
        label.setText(name);
        label.setTextColor(DIM);
        label.setTextSize(14f);
        label.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        label.setSingleLine(true);
        label.setPadding(dp(6), 0, 0, 0);
        box.addView(label);

        return new Lamp(box, light, name);
    }

    // UI thread
    private void showStatus() {
        deviceLamp.set(core.isDeviceOpen());
        engineLamp.set(core.isEngineConnected());
    }

    private void showRecent() {
        List<String> lines = core.recentLines();
        SpannableStringBuilder sb = new SpannableStringBuilder();
        for (String l : lines) sb.append(styled(l));
        logView.setText(sb);
        viewLines = lines.size();
        if (follow) scroll.post(toLatest);
    }

    private void postLine(final String line) {
        ui.post(new Runnable() {
            @Override public void run() { appendLine(line); }
        });
    }

    // UI thread
    private void appendLine(String line) {
        if (!follow && !touching
            && (atEnd() || System.currentTimeMillis() - lastTouch >= FOLLOW_AGAIN_MS)) {
            follow = true;
        }
        if (viewLines >= MAX_VIEW_LINES) {
            showRecent();
        } else {
            logView.append(styled(line));
            viewLines++;
        }
    }

    private boolean atEnd() {
        return scroll.getScrollY() + scroll.getHeight() >= logView.getHeight() - dp(24);
    }

    /** One log line: the time faint, lines marked ">>>" bright, the rest in between. */
    private static CharSequence styled(String line) {
        SpannableStringBuilder sb = new SpannableStringBuilder(line).append('\n');
        boolean timed = line.length() > TIMESTAMP_CHARS + 2
            && line.charAt(2) == ':' && line.charAt(TIMESTAMP_CHARS) == ' ';
        if (!timed) return sb;
        sb.setSpan(new ForegroundColorSpan(FAINT), 0, TIMESTAMP_CHARS, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (line.startsWith(">>>", TIMESTAMP_CHARS + 2)) {
            sb.setSpan(new ForegroundColorSpan(PAPER), TIMESTAMP_CHARS, line.length(),
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        return sb;
    }

    private GradientDrawable flat(int colour) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(colour);
        d.setCornerRadius(dp(4));
        return d;
    }

    private int dp(int n) {
        return (int) (n * getResources().getDisplayMetrics().density + 0.5f);
    }
}
