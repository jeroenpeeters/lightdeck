package nl.lightdeck.bridge;

import android.content.Context;
import android.hardware.usb.UsbManager;
import android.net.wifi.WifiManager;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import com.lightingsoft.xhl.CallBackHotPlug;
import com.lightingsoft.xhl.XHL;
import com.lightingsoft.xhl.XHL_Bus;
import com.lightingsoft.xhl.XHL_Device;
import com.lightingsoft.xhl.XHL_SoftwareProfile;
import com.lightingsoft.xhl.XHL_System;

import java.io.File;
import java.io.FileWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * Process-wide bridge core. Lives as long as the app process, independent of the Activity,
 * so rotating or reopening the screen does not register the vendor library twice or start a
 * second WebSocket server.
 *
 * Startup mirrors the real Light Rider app (decompiled `e1.t$a`):
 *   libXHW() -> setSoftware(XHL_SC_LightRider, "Light Rider", profile) -> setAssetManager
 *   -> initializeSushi() -> addCallBackHotPlug(cb) -> enumerateAsync()
 *
 * A supervisor loop then keeps exactly one device open and attached to the WebSocket
 * server. When the device leaves or is no longer open, it detaches, scans again and
 * reopens by itself. No restart of the app is needed.
 *
 * Scanning follows the original app: never start a scan while one is running, never scan
 * while a device is open, and open a device only once the scan has finished. Whether a
 * frame could be sent is not a sign of connection health; the library closes the device
 * itself when the network fails, and that is what the supervisor watches.
 */
final class BridgeCore {

    static final String TAG = "LR512GATE";
    static final int PORT = 9010;

    interface LogSink { void onLine(String line); }

    private static final int RECENT_LINES = 300;
    private static final long RESCAN_AFTER_MS = 5000;        // pause between two scans
    private static final long SCAN_PATIENCE_MS = 15000;      // stop waiting for a scan to end
    private static final long RETRY_AFTER_FAILED_OPEN_MS = 3000;
    private static final long MAX_LOG_FILE_BYTES = 512 * 1024;

    private static BridgeCore instance;

    static synchronized BridgeCore get(Context context) {
        if (instance == null) {
            instance = new BridgeCore(context.getApplicationContext());
            instance.start();
        }
        return instance;
    }

    private final Context ctx;
    private final ArrayDeque<String> recent = new ArrayDeque<String>();
    private volatile LogSink sink;
    private File logFile;

    private XHL x;
    private BridgeServer server;
    private volatile XHL_Device device;   // the open, attached device, or null
    private volatile XHL_Device arrived;  // last device reported by the arrival callback
    private volatile boolean kick = true; // scan before opening anything

    private WifiManager.MulticastLock multicastLock;
    private WifiManager.WifiLock wifiLock;
    private PowerManager.WakeLock wakeLock;

    // Devices arrive and leave here, on a library thread.
    private final CallBackHotPlug hotplug = new CallBackHotPlug() {
        @Override public void onDeviceArrival(XHL_Device dev, XHL_Bus.SupportState ss,
                                              XHL_Bus.BusType bus, String name, String desc) {
            log("onDeviceArrival: name=" + clean(name) + " desc=" + clean(desc).replace('\n', ' ')
                + " bus=" + bus + " support=" + ss);
            arrived = dev;
        }
        @Override public void onDeviceLeft(XHL_Device dev, XHL_Bus.BusType bus) {
            onLeft(dev, bus);
        }
        @Override public void onDeviceListChanged() { }
    };

    private BridgeCore(Context appContext) {
        this.ctx = appContext;
    }

    private void start() {
        try {
            logFile = new File(ctx.getExternalFilesDir(null), "lr512-gate.log");
            if (logFile.length() > MAX_LOG_FILE_BYTES) logFile.delete();
        } catch (Throwable t) {
            logFile = null;
        }
        log("LR512 bridge starting. ABI(s): " + java.util.Arrays.toString(android.os.Build.SUPPORTED_ABIS));
        acquireLocks();
        new Thread(new Runnable() { @Override public void run() { run0(); } }, "lr512-core").start();
    }

    // DasNet discovery is UDP broadcast, which Android drops without a multicast lock. The
    // Wi-Fi and CPU locks keep the stream alive when the screen is off.
    private void acquireLocks() {
        try {
            WifiManager wifi = (WifiManager) ctx.getSystemService(Context.WIFI_SERVICE);
            multicastLock = wifi.createMulticastLock("lr512-bridge");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "lr512-bridge");
            wifiLock.setReferenceCounted(false);
            wifiLock.acquire();
            log("Multicast and Wi-Fi locks acquired.");
        } catch (Throwable t) {
            log("Wi-Fi locks NOT acquired: " + t);
        }
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lr512:bridge");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        } catch (Throwable t) {
            log("WakeLock NOT acquired: " + t);
        }
    }

    // core thread
    private void run0() {
        try { Looper.prepare(); } catch (Throwable ignored) { }
        try {
            x = XHL.libXHW();
            String ver;
            try { ver = x.getVersionName(); } catch (Throwable t) { ver = "?"; }
            log("libXHardwareLibrary loaded. XHL version: " + ver);

            x.setSoftware(XHL.XHL_SoftwareCode.XHL_SC_LightRider, "Light Rider", new GateProfile(ctx));
            XHL_System.setAssetManager(ctx.getAssets());
            boolean sushi;
            try { sushi = x.initializeSushi(); } catch (Throwable t) { sushi = false; log("initializeSushi threw: " + t); }
            log("setSoftware OK, setAssetManager OK, initializeSushi = " + sushi);

            x.addCallBackHotPlug(hotplug);
            logNetworkInfo();
        } catch (Throwable t) {
            log("FATAL during init: " + t);
            Log.e(TAG, "init failed", t);
            return;
        }

        // The WebSocket server does not depend on the device: the engine can connect and
        // stay connected while the device is away.
        server = new BridgeServer(PORT, new BridgeServer.Logger() {
            @Override public void log(String m) { BridgeCore.this.log(m); }
        });
        server.start();
        String ip = firstIpv4();
        log(">>> Bridge up. Point the engine at  ws://" + (ip == null ? "<phone-ip>" : ip) + ":" + PORT);

        supervise();
    }

    // core thread, forever
    private void supervise() {
        long scanStarted = 0;
        boolean announcedSearch = false;
        while (true) {
            try {
                XHL_Device d = device;
                if (d != null) {
                    announcedSearch = false;
                    String problem = health(d);
                    if (problem != null) drop(problem, true);
                } else {
                    if (!announcedSearch) {
                        log("Searching for the LR512 (DasNet)...");
                        announcedSearch = true;
                    }
                    long now = System.currentTimeMillis();
                    boolean scanning = isScanning() && now - scanStarted < SCAN_PATIENCE_MS;
                    if (!scanning) {
                        // After a loss or a failed open the device list may be stale:
                        // scan first, open afterwards.
                        XHL_Device candidate = kick ? null : findCandidate();
                        if (candidate != null) {
                            if (!open(candidate)) {
                                sleep(RETRY_AFTER_FAILED_OPEN_MS);
                                kick = true;
                            }
                        } else if (kick || now - scanStarted >= RESCAN_AFTER_MS) {
                            kick = false;
                            if (!isScanning()) {
                                scanStarted = now;
                                x.enumerateAsync();
                            }
                        }
                    }
                }
            } catch (Throwable t) {
                log("supervisor error: " + t);
                Log.e(TAG, "supervisor", t);
            }
            sleep(500);
        }
    }

    /** Returns null when the device is fine, else a short reason. */
    private String health(XHL_Device d) {
        try {
            if (!d.isOpen()) return "device is no longer open";
        } catch (Throwable t) {
            return "isOpen threw " + t;
        }
        return null;
    }

    private boolean isScanning() {
        try { return x.enumerateAsyncIsRunning(); } catch (Throwable t) { return false; }
    }

    private XHL_Device findCandidate() {
        XHL_Device fromCallback = arrived;
        if (fromCallback != null) {
            arrived = null;
            return fromCallback;
        }
        try {
            int n = x.getDeviceCount();
            XHL_Device any = null;
            for (int i = 0; i < n; i++) {
                XHL_Device d = x.getDevice(i);
                if (d == null) continue;
                if (any == null) any = d;
                try {
                    if (XHL_Bus.BusType.BT_DasNet.equals(d.getBusType())) return d;
                } catch (Throwable ignored) { }
            }
            return any;
        } catch (Throwable t) {
            return null;
        }
    }

    private boolean open(XHL_Device d) {
        log("Opening: " + describe(d));
        try {
            boolean ok = d.open();
            sleep(500);
            boolean isOpen = d.isOpen();
            String err;
            try { err = x.getLastErrorDescription(); } catch (Throwable t) { err = "?"; }
            log("open() returned " + ok + ", isOpen=" + isOpen + ", state=" + safe(d, "getDeviceState")
                + ", lastError=" + err);
            if (!isOpen) return false;
            if (!server.attach(d)) return false;
            device = d;
            log(">>> Device open and attached. DMX is live.");
            return true;
        } catch (Throwable t) {
            log("open failed: " + t);
            Log.e(TAG, "open failed", t);
            return false;
        }
    }

    // library thread
    private void onLeft(XHL_Device dev, XHL_Bus.BusType bus) {
        // The bus printed here is unreliable: the vendor wrapper indexes the enum by ordinal.
        log("onDeviceLeft: " + clean(safe(dev, "getDeviceName")) + " (bus reported as " + bus + ")");
        XHL_Device d = device;
        if (d == null) return;
        boolean ours;
        try { ours = dev != null && dev.getCppPtr() == d.getCppPtr(); } catch (Throwable t) { ours = false; }
        if (ours) drop("device left", false);
        // If it was another handle for the same device, the health check notices within 0.5 s.
    }

    /** Detach and forget the device; the supervisor then looks for it again. */
    private synchronized void drop(String reason, boolean close) {
        XHL_Device d = device;
        if (d == null) return;
        device = null;
        arrived = null;
        server.detach(reason);
        log(">>> Device lost: " + reason + ". Reconnecting automatically...");
        if (close) {
            try { d.close(); } catch (Throwable t) { log("close threw: " + t); }
        }
        kick = true;
    }

    /** Manual nudge from the UI. */
    void reEnumerate() {
        log("---- manual re-enumerate");
        kick = true;
    }

    boolean isDeviceOpen() { return device != null; }

    // --- logging ---

    void setSink(LogSink s) { sink = s; }

    List<String> recentLines() {
        synchronized (recent) { return new ArrayList<String>(recent); }
    }

    void log(String msg) {
        Log.i(TAG, msg);
        String line = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(new Date()) + "  " + msg;
        synchronized (recent) {
            recent.addLast(line);
            while (recent.size() > RECENT_LINES) recent.removeFirst();
        }
        if (logFile != null) {
            try (FileWriter w = new FileWriter(logFile, true)) { w.write(line + "\n"); } catch (Throwable ignored) { }
        }
        LogSink s = sink;
        if (s != null) {
            try { s.onLine(line); } catch (Throwable ignored) { }
        }
    }

    // --- helpers ---

    private void logNetworkInfo() {
        try {
            java.util.Enumeration<java.net.NetworkInterface> ifs = java.net.NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                java.net.NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress a = addrs.nextElement();
                    if (a instanceof java.net.Inet4Address) log("iface " + ni.getName() + " ipv4 " + a.getHostAddress());
                }
            }
        } catch (Throwable t) {
            log("net info failed: " + t);
        }
    }

    /** Prefers the Wi-Fi interface; mobile data (rmnet) is no use to the engine. */
    private String firstIpv4() {
        String fallback = null;
        try {
            java.util.Enumeration<java.net.NetworkInterface> ifs = java.net.NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                java.net.NetworkInterface ni = ifs.nextElement();
                if (!ni.isUp() || ni.isLoopback()) continue;
                java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    java.net.InetAddress a = addrs.nextElement();
                    if (!(a instanceof java.net.Inet4Address)) continue;
                    if (ni.getName().startsWith("wlan")) return a.getHostAddress();
                    if (fallback == null) fallback = a.getHostAddress();
                }
            }
        } catch (Throwable ignored) { }
        return fallback;
    }

    private String describe(XHL_Device dev) {
        String bus;
        try { bus = String.valueOf(dev.getBusType()); } catch (Throwable t) { bus = "?"; }
        return "name=" + clean(safe(dev, "getDeviceName")) + " type=" + safe(dev, "getDeviceTypeName")
            + " bus=" + bus + " uid=" + safe(dev, "getUID");
    }

    private String safe(XHL_Device dev, String method) {
        try { return String.valueOf(dev.getClass().getMethod(method).invoke(dev)); }
        catch (Throwable t) { return "?"; }
    }

    /** The vendor returns wide strings with padding characters; keep printable text only. */
    private static String clean(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\n' || (c >= 0x20 && c < 0x7f)) sb.append(c);
        }
        return sb.toString();
    }

    private void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }

    // Minimal XHL_SoftwareProfile, mirroring the app's own implementation (e1.t$a$a):
    // it just returns constants plus the Context and UsbManager.
    static final class GateProfile extends XHL_SoftwareProfile {
        private final Context ctx;
        GateProfile(Context c) { this.ctx = c; }
        @Override protected boolean canPartialOpenWrongDongleDevice() { return true; }
        @Override protected boolean enumerateCloseAllDevices() { return false; }
        @Override protected boolean enumerateUsedDevice() { return true; }
        @Override protected boolean enumerateWrongNapDevice() { return true; }
        @Override protected boolean getBusSupport(XHL_Bus.BusType t) { return true; }
        @Override protected Context getContext() { return ctx; }
        @Override protected UsbManager getUsbManager() { return (UsbManager) ctx.getSystemService(Context.USB_SERVICE); }
        @Override protected boolean shouldBeDeletedByXHL() { return false; }
        @Override protected boolean shouldPerformLocaldatabaseNapTest() { return false; }
        @Override protected boolean shouldPerformServerDataBaseNapTest() { return false; }
        @Override protected boolean updateDeviceListOnManualChange(XHL_Bus.BusType t) { return true; }
    }
}
