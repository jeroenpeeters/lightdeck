package nl.lightdeck.bridge;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/**
 * Screen for the LR512 bridge. All the work happens in {@link BridgeCore}, which outlives
 * this Activity; this class only shows the log and keeps the screen on.
 *
 * The same log goes to logcat (tag "LR512GATE") and to lr512-gate.log in the app's
 * external files directory.
 */
public class OpenGateActivity extends Activity {

    private static final int MAX_VIEW_LINES = 400;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView logView;
    private ScrollView scroll;
    private BridgeCore core;
    private int viewLines = 0;

    private final BridgeCore.LogSink sink = new BridgeCore.LogSink() {
        @Override public void onLine(String line) { postLine(line); }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // While this screen is visible the phone stays awake, so Android does not freeze
        // the process and drop the device connection.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        scroll = new ScrollView(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (12 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);
        scroll.addView(root);

        Button rescan = new Button(this);
        rescan.setText("Re-enumerate");
        rescan.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { core.reEnumerate(); }
        });
        root.addView(rescan);

        logView = new TextView(this);
        logView.setTextColor(Color.BLACK);
        logView.setTextSize(12f);
        logView.setTypeface(Typeface.MONOSPACE);
        root.addView(logView);

        setContentView(scroll);

        core = BridgeCore.get(this);
    }

    @Override
    protected void onStart() {
        super.onStart();
        showRecent();
        core.setSink(sink);
    }

    @Override
    protected void onStop() {
        super.onStop();
        core.setSink(null);
    }

    private void showRecent() {
        List<String> lines = core.recentLines();
        StringBuilder sb = new StringBuilder();
        for (String l : lines) sb.append(l).append('\n');
        logView.setText(sb);
        viewLines = lines.size();
    }

    private void postLine(final String line) {
        ui.post(new Runnable() {
            @Override public void run() { appendLine(line); }
        });
    }

    // UI thread
    private void appendLine(String line) {
        if (viewLines >= MAX_VIEW_LINES) {
            showRecent();
        } else {
            logView.append(line + "\n");
            viewLines++;
        }
        scroll.fullScroll(View.FOCUS_DOWN);
    }
}
