package nl.lightdeck.bridge;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Process;

/**
 * Foreground service that keeps the bridge alive when the screen is off or another app is
 * in front. Without it Android freezes the process a little after it leaves the screen,
 * which stops the vendor library's keep-alive and the WebSocket.
 *
 * The bridge itself is {@link BridgeCore}, which lives in the process; this service only
 * makes the process one that Android leaves running, and says in a notification what the
 * two connections are doing. If Android kills the process anyway, START_STICKY starts the
 * service again, and with it the core.
 *
 * The type is connectedDevice: it has no time limit (dataSync has one on Android 15), and
 * the manifest holds CHANGE_WIFI_MULTICAST_STATE, one of the permissions Android asks for
 * with that type.
 */
public class BridgeService extends Service {

    static final String ACTION_STOP = "nl.lightdeck.bridge.STOP";

    private static final String CHANNEL = "bridge";
    private static final int NOTIFICATION_ID = 512;
    private static final long REFRESH_MS = 2000;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private BridgeCore core;
    private String shown = "";

    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            update();
            ui.postDelayed(this, REFRESH_MS);
        }
    };

    /** Starts the service from the screen, which is allowed because it is in front. */
    static void start(Context context) {
        Intent i = new Intent(context, BridgeService.class);
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i);
        else context.startService(i);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopBridge();
            return START_NOT_STICKY;
        }
        // startForeground first: Android gives only a few seconds after startForegroundService.
        enterForeground();
        core = BridgeCore.get(this);
        ui.removeCallbacks(refresh);
        refresh.run();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        ui.removeCallbacks(refresh);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void enterForeground() {
        Notification n = build(status());
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
    }

    // UI thread
    private void update() {
        String now = status();
        if (now.equals(shown)) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, build(now));
    }

    private String status() {
        BridgeCore c = core;
        String device = c != null && c.isDeviceOpen() ? "connected" : "not connected";
        String engine = c != null && c.isEngineConnected() ? "connected" : "not connected";
        return "LR512 " + device + " · Lightdeck " + engine;
    }

    private Notification build(String text) {
        shown = text;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                // Low importance: no sound and no pop-up every time a connection changes.
                NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Bridge running", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }

        int immutable = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, OpenGateActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            immutable | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, BridgeService.class).setAction(ACTION_STOP),
            immutable | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL)
            : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("Lightdeck LR512 Bridge")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .addAction(new Notification.Action.Builder(null, "Stop", stop).build());
        if (Build.VERSION.SDK_INT >= 31) {
            b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        }
        return b.build();
    }

    /**
     * The Stop key of the notification. The core is threads in this process with no stop of
     * their own, so ending the service means ending the process. The bridge holds the last
     * frame, as it does when the app crashes.
     */
    private void stopBridge() {
        BridgeCore.get(this).log(">>> Stopped from the notification. The bridge ends.");
        ui.removeCallbacks(refresh);
        stopForeground(true);
        stopSelf();
        Process.killProcess(Process.myPid());
    }
}
