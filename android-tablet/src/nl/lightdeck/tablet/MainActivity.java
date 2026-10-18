package nl.lightdeck.tablet;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The tablet page of lightdeck, full screen, in a WebView. Nothing else.
 *
 * Chrome only installs a page as an app on https, and a page on the local network is plain http, so
 * the home screen only got a shortcut that kept the bar of the browser. A WebView has no bar and no
 * such rule, and this app also keeps the screen on and does not let a swipe or the back key leave
 * the page by accident. The page itself is lightdeck's (`/tablet`): it draws what the server says
 * and keeps its own connection, so this app holds no state of its own except the address.
 *
 * When the page cannot be loaded (lightdeck is not running, wrong address, no Wi-Fi) a plain screen
 * says so, tries again every few seconds, and has a key to change the address.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "lightdeck";
    private static final String KEY_URL = "url";
    /** How long the screen of an error waits before it tries the page again. */
    private static final long RETRY_MS = 4000;
    /** The page knows it is in this app by this part of the user agent (it has no full screen key then). */
    private static final String AGENT = " LightdeckTablet/1";
    private static final int GRAPHITE = Color.parseColor("#0f1114");
    private static final int AMBER = Color.parseColor("#ffb400");
    private static final int PAPER = Color.parseColor("#e8ecf0");

    private WebView web;
    private View problem;
    private TextView problemText;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable retry = new Runnable() {
        @Override
        public void run() {
            if (problem.getVisibility() == View.VISIBLE) web.loadUrl(address());
        }
    };

    private String address() {
        return getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, Config.URL);
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(GRAPHITE));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(GRAPHITE);

        web = new WebView(this);
        web.setBackgroundColor(GRAPHITE);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(settings.getUserAgentString() + AGENT);
        // The page can be looked at from chrome://inspect on a computer, which is how it is debugged.
        WebView.setWebContentsDebuggingEnabled(true);
        web.setWebViewClient(new PageClient());
        root.addView(web, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        problem = buildProblem();
        problem.setVisibility(View.GONE);
        root.addView(problem, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        if (state != null) web.restoreState(state);
        else web.loadUrl(address());
    }

    /** The screen of an error: what is wrong, and two keys. Built in code, so the app has no layouts. */
    private View buildProblem() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(GRAPHITE);
        int pad = dp(32);
        box.setPadding(pad, pad, pad, pad);

        problemText = new TextView(this);
        problemText.setTextColor(PAPER);
        problemText.setTextSize(22);
        problemText.setGravity(Gravity.CENTER);
        box.addView(problemText);

        LinearLayout keys = new LinearLayout(this);
        keys.setOrientation(LinearLayout.HORIZONTAL);
        keys.setGravity(Gravity.CENTER);
        keys.setPadding(0, dp(24), 0, 0);
        keys.addView(key("Try again", new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                web.loadUrl(address());
            }
        }));
        keys.addView(key("Change address", new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                askAddress();
            }
        }));
        box.addView(keys);
        return box;
    }

    private Button key(String text, View.OnClickListener onClick) {
        Button key = new Button(this);
        key.setText(text);
        key.setAllCaps(false);
        key.setTextSize(20);
        key.setTextColor(PAPER);
        key.setBackgroundColor(Color.parseColor("#272c34"));
        key.setMinHeight(dp(64));
        key.setMinimumHeight(dp(64));
        key.setPadding(dp(24), 0, dp(24), 0);
        LinearLayout.LayoutParams layout = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        layout.setMargins(dp(8), 0, dp(8), 0);
        key.setLayoutParams(layout);
        key.setOnClickListener(onClick);
        return key;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /** Asks for the address of lightdeck and keeps it. A bare address gets http:// and /tablet. */
    private void askAddress() {
        final EditText field = new EditText(this);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setText(address());
        field.setSelection(field.getText().length());
        new AlertDialog.Builder(this)
            .setTitle("Address of lightdeck")
            .setMessage("For example http://192.168.68.183:8080/tablet")
            .setView(field)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save", new android.content.DialogInterface.OnClickListener() {
                @Override
                public void onClick(android.content.DialogInterface dialog, int which) {
                    String url = Address.clean(field.getText().toString());
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
                    web.loadUrl(url);
                }
            })
            .show();
    }

    private void showProblem(String text) {
        problemText.setText(text);
        problem.setVisibility(View.VISIBLE);
        handler.removeCallbacks(retry);
        handler.postDelayed(retry, RETRY_MS);
    }

    private void hideProblem() {
        problem.setVisibility(View.GONE);
        handler.removeCallbacks(retry);
    }

    private class PageClient extends WebViewClient {
        /** True from an error until the next load starts: the WebView calls "finished" after an error too. */
        private boolean failed;

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
            failed = false;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            failed = true;
            showProblem("Lightdeck cannot be reached at\n" + address()
                + "\n\nIs lightdeck running, and is this tablet on the same Wi-Fi? It tries again by itself.");
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (!request.isForMainFrame()) return;
            failed = true;
            showProblem("Lightdeck answered " + response.getStatusCode() + " at\n" + address());
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!failed) hideProblem();
        }
    }

    // ---- full screen, and a back key that does not leave ----

    @Override
    public void onWindowFocusChanged(boolean focus) {
        super.onWindowFocusChanged(focus);
        if (focus) hideBars();
    }

    private void hideBars() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.systemBars());
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        }
    }

    /** Back goes back in the page; at the first page it does nothing, so a stray touch cannot leave. */
    @Override
    public void onBackPressed() {
        if (problem.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
        } else if (web.canGoBack()) {
            web.goBack();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        web.saveState(state);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(retry);
        web.destroy();
        super.onDestroy();
    }
}
