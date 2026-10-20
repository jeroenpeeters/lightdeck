package nl.lightdeck.camera;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.SurfaceTexture;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Size;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.io.IOException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;

/**
 * The camera app of the laser survey: a preview to aim with, the address to give to lightdeck, and
 * an HTTP server (`CameraServer`) that takes a photo or films a clip when `pnpm laser-survey` asks.
 *
 * The phone stands beside the laser, looking at the wall, and stays on this screen: the camera
 * is closed when the app goes behind another one, and the server then answers 503.
 */
public class MainActivity extends Activity implements TextureView.SurfaceTextureListener {
    static final int PORT = 9020;
    private static final int REQUEST_CAMERA = 1;

    private TextureView view;
    private TextView info;
    private CameraController camera;
    private CameraServer server;
    private String serverProblem;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable refresh = new Runnable() {
        @Override
        public void run() {
            showInfo();
            ui.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        view = new TextureView(this);
        view.setSurfaceTextureListener(this);
        root.addView(view, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        info = new TextView(this);
        info.setTextColor(Color.WHITE);
        info.setBackgroundColor(Color.argb(160, 0, 0, 0));
        info.setTextSize(16);
        info.setPadding(24, 16, 24, 16);
        info.setTypeface(android.graphics.Typeface.MONOSPACE);
        root.addView(info, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.START));
        setContentView(root);

        camera = new CameraController(this);
        server = new CameraServer(PORT, camera);
        try {
            server.start();
        } catch (IOException e) {
            serverProblem = "cannot listen on port " + PORT + ": " + e.getMessage();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] {Manifest.permission.CAMERA}, REQUEST_CAMERA);
        } else if (view.isAvailable()) {
            openCamera(view.getSurfaceTexture());
        }
        ui.post(refresh);
    }

    @Override
    protected void onPause() {
        ui.removeCallbacks(refresh);
        camera.close();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        server.stop();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code == REQUEST_CAMERA && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED
                && view.isAvailable()) {
            openCamera(view.getSurfaceTexture());
        }
    }

    private void openCamera(SurfaceTexture texture) {
        camera.start(texture);
        view.post(new Runnable() {
            @Override
            public void run() {
                fitPreview(view.getWidth(), view.getHeight());
            }
        });
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture texture, int width, int height) {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            openCamera(texture);
        }
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int width, int height) {
        fitPreview(width, height);
    }

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
        camera.close();
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture texture) {
    }

    /** The usual correction of a TextureView in landscape (the camera sensor is turned a quarter). */
    private void fitPreview(int viewWidth, int viewHeight) {
        Size size = camera.previewSize();
        if (size == null || viewWidth == 0 || viewHeight == 0) return;
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        Matrix matrix = new Matrix();
        RectF viewRect = new RectF(0, 0, viewWidth, viewHeight);
        RectF bufferRect = new RectF(0, 0, size.getHeight(), size.getWidth());
        float cx = viewRect.centerX();
        float cy = viewRect.centerY();
        if (rotation == Surface.ROTATION_90 || rotation == Surface.ROTATION_270) {
            bufferRect.offset(cx - bufferRect.centerX(), cy - bufferRect.centerY());
            matrix.setRectToRect(viewRect, bufferRect, Matrix.ScaleToFit.FILL);
            float scale = Math.max((float) viewHeight / size.getHeight(), (float) viewWidth / size.getWidth());
            matrix.postScale(scale, scale, cx, cy);
            matrix.postRotate(90 * (rotation - 2), cx, cy);
        } else if (rotation == Surface.ROTATION_180) {
            matrix.postRotate(180, cx, cy);
        }
        view.setTransform(matrix);
    }

    private void showInfo() {
        StringBuilder text = new StringBuilder("Lightdeck camera\n");
        if (serverProblem != null) {
            text.append(serverProblem).append('\n');
        } else {
            for (String address : addresses()) text.append("http://").append(address).append(':').append(PORT).append('\n');
        }
        text.append(camera.summary());
        info.setText(text.toString());
    }

    private static Iterable<String> addresses() {
        java.util.ArrayList<String> found = new java.util.ArrayList<String>();
        try {
            for (NetworkInterface net : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!net.isUp() || net.isLoopback()) continue;
                for (InetAddress address : Collections.list(net.getInetAddresses())) {
                    if (address instanceof Inet4Address) found.add(address.getHostAddress());
                }
            }
        } catch (IOException ignored) {
        }
        return found;
    }
}
