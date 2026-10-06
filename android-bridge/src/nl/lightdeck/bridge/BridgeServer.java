package nl.lightdeck.bridge;

import android.util.Base64;

import com.lightingsoft.xhl.XHL;
import com.lightingsoft.xhl.XHL_Device;
import com.lightingsoft.xhl.XHL_DmxIoInterface;
import com.lightingsoft.xhl.XHL_DmxSecurisedBuffer;
import com.lightingsoft.xhl.XHL_DmxUniverse;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.util.Arrays;

/**
 * Dependency-free WebSocket bridge: the engine connects and streams rendered DMX
 * frames; this hands them to the vendor library's sendDmx.
 *
 * Client -> bridge (binary message): [universe:1 byte][512 DMX bytes] = 513 bytes.
 * Client -> bridge (text message), sent after connecting and whenever it changes:
 *   {"type":"limits","maxFps":25}
 *   the most frames per second the bridge may hand to the device, per universe. It is
 *   clamped to MIN_FPS..MAX_FPS. A message that cannot be read is ignored and the
 *   connection stays. Without one, and again after the client has gone, it is DEFAULT_FPS.
 * Bridge -> client (text message):
 *   {"type":"status","device":"open"|"lost","universes":N,"channels":[512,0]}
 *   sent on connect and whenever the device is attached or detached. `channels` is how
 *   many channels the device's licence allows per universe. A universe with 0 channels
 *   cannot be used: the vendor library refuses every frame for it.
 *   {"type":"alive","device":"open"|"lost","frames":N}
 *   sent every ALIVE_MS while a client is connected: the bridge is there and its pump
 *   runs. `frames` is every frame handed to the vendor's sendDmx since the app started,
 *   refreshes and failed ones included. A client that does not know the message ignores it.
 *
 * The WebSocket server is independent of the device. It keeps listening while the device
 * is away, remembers the latest frame per universe, and replays it when a device is
 * attached again, so the engine's connection and the light state survive a device drop.
 *
 * Backpressure: the receive path never blocks on DMX. It only overwrites a per-universe
 * "latest" buffer, marks it dirty and wakes the pump. The pump thread waits on that lock
 * until a frame arrives or the next deadline is due, so a frame is handed on at once when
 * the rate cap allows it. A flood is coalesced to latest-wins: what waits for the cap is
 * always the newest frame.
 *
 * Only changes: a frame that is byte for byte the frame last sent on that universe is
 * counted as skipped and not sent again.
 *
 * Idle limit: a client that has sent a valid limits message speaks the protocol of the
 * keep-alive: it sends something at least once a second. When no byte at all has come
 * from it for CLIENT_IDLE_MS, the connection is taken for dead (a half-open one, after a
 * Wi-Fi drop, looks like this): the bridge closes it, goes back to the default cap and
 * accepts again, so that the engine can reconnect. A client that never sent limits (an
 * older engine, tools/lr512-send.mjs) has no limit. The pump, the held last frame, the
 * refresh and the device are not touched by this.
 *
 * Rate cap: two sends on one universe (a new frame or a refresh) are at least
 * 1000 / maxFps apart. No sender can ask the device for more.
 *
 * Refresh: a universe that has been sent is sent again, unchanged, when REFRESH_MS has
 * passed since its last send, the way a lighting desk keeps transmitting.
 *
 * The vendor buffer is filled with one copyBuffer call for a new frame (what it does is
 * a setValue per element, see sendUniverse) and is left alone for a refresh.
 *
 * A failing send says nothing about the connection. It is logged with the library's own
 * reason and counted, and never used to decide that the device is gone.
 *
 * Single client at a time (the engine). A second connection is not accepted until the
 * first has closed: the accept loop serves the client itself.
 *
 * Threads: the pump thread (DMX and the alive message), the receive thread (the client's
 * messages), the supervisor of BridgeCore (attach, detach). `lock` guards the frames that
 * arrive and the wake flag, and is never held while calling the vendor library or writing
 * to the socket. `writeLock` makes every message to the client one whole write.
 */
final class BridgeServer {

    interface Logger { void log(String msg); }

    static final int MAX_UNIVERSES = 4;

    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int FRAME = 513;             // 1 universe id + 512 channels
    private static final long REFRESH_MS = 100;       // idle re-send, 10 Hz
    private static final long ALIVE_MS = 1000;        // the alive message to the client
    private static final long CLIENT_IDLE_MS = 6000;  // no byte from a client that sent limits
    private static final long STATS_MS = 10000;
    private static final long FAILURE_LOG_EVERY_MS = 10000;
    private static final double DEFAULT_FPS = 25;     // what the original app can be seen to use
    private static final double MIN_FPS = 1;
    private static final double MAX_FPS = 60;
    private static final long MAX_WAIT_MS = 1000;     // the pump looks up at least this often
    private static final int IGNORED_TEXT_LOGGED = 3; // per connection

    private static final long NS_PER_MS = 1000000L;
    private static final long HOUR_NS = 3600L * 1000L * NS_PER_MS;
    private static final Charset UTF8 = Charset.forName("UTF-8");

    /** Everything that belongs to one opened device. Replaced as a whole on attach. */
    private static final class Binding {
        int universes;
        XHL_DmxUniverse[] universe;
        XHL_DmxSecurisedBuffer[] buffer;
        int[] channels;        // licensed channels per universe, 0 = unusable
        boolean[] toldUnusable;
        // From here on only the pump thread touches the binding, once it is published.
        long[] lastSend;       // System.nanoTime() of the last sendDmx, new frame or refresh
        long[] lastFailureLog;
        byte[][] pending;      // the newest frame picked up, waiting for its turn
        boolean[] hasPending;
        byte[][] image;        // what the vendor buffer holds: the last frame copied into it
        boolean[] hasImage;
        boolean[] delivered;   // the last sendDmx on this universe returned true
        int[][] ints;          // scratch for copyBuffer
    }

    private final int port;
    private final Logger log;

    private final byte[][] latest = new byte[MAX_UNIVERSES][512];
    private final boolean[] dirty = new boolean[MAX_UNIVERSES];
    private final boolean[] seen = new boolean[MAX_UNIVERSES]; // data was received at least once
    private final Object lock = new Object();
    private boolean wake = false;                  // under lock: something happened that the pump must see

    private volatile Binding binding;          // null while no device is attached
    private volatile boolean running = false;

    private ServerSocket server;
    private volatile Socket client;
    private volatile OutputStream clientOut;
    private final Object writeLock = new Object();

    // the cap the client asked for, as the gap between two sends on one universe
    private volatile double maxFps = DEFAULT_FPS;
    private volatile long minGapNs = gapFor(DEFAULT_FPS);

    // counters for the periodic stats line
    private long rxFrames, droppedNoDevice;               // under lock
    private long sentNew, sentRefresh, failedFrames, refusedFrames, skippedFrames; // pump thread
    private long handedFrames;                            // pump thread, never reset: the alive message

    BridgeServer(int port, Logger log) {
        this.port = port;
        this.log = log;
    }

    void start() {
        if (running) return;
        running = true;
        new Thread(new Runnable() { @Override public void run() { pumpLoop(); } }, "lr512-pump").start();
        new Thread(new Runnable() { @Override public void run() { acceptLoop(); } }, "lr512-ws").start();
    }

    void stop() {
        running = false;
        wakePump();
        try { if (client != null) client.close(); } catch (Throwable ignored) { }
        try { if (server != null) server.close(); } catch (Throwable ignored) { }
    }

    /** Bind an opened device. Returns false when it has no usable DMX output. */
    boolean attach(XHL_Device device) {
        try {
            XHL_DmxIoInterface io = device.getInterface_DmxIo();
            if (io == null) { log.log("Bridge: device has no DMX IO interface."); return false; }
            int n = Math.min(io.getUniversesCount(), MAX_UNIVERSES);
            if (n <= 0) { log.log("Bridge: device reports 0 universes."); return false; }
            Binding b = new Binding();
            b.universes = n;
            b.universe = new XHL_DmxUniverse[n];
            b.buffer = new XHL_DmxSecurisedBuffer[n];
            b.channels = new int[n];
            b.toldUnusable = new boolean[n];
            b.lastSend = new long[n];
            b.lastFailureLog = new long[n];
            b.pending = new byte[n][512];
            b.hasPending = new boolean[n];
            b.image = new byte[n][512];
            b.hasImage = new boolean[n];
            b.delivered = new boolean[n];
            b.ints = new int[n][512];
            // Long ago, so that the first frame and the first failure are not held back.
            Arrays.fill(b.lastSend, System.nanoTime() - HOUR_NS);
            Arrays.fill(b.lastFailureLog, System.nanoTime() - HOUR_NS);
            for (int u = 0; u < n; u++) {
                b.universe[u] = io.getDmxUniverse(u);
                b.buffer[u] = new XHL_DmxSecurisedBuffer(512);
                try {
                    b.channels[u] = b.universe[u].getChannelCount();
                } catch (Throwable t) {
                    b.channels[u] = 512; // unknown: let the library decide per frame
                    log.log("Bridge: getChannelCount universe " + u + " failed: " + t);
                }
                // The ports must be in OUTPUT mode or sendDmx goes nowhere.
                try {
                    XHL_DmxUniverse.XHL_IoMode was = b.universe[u].getIoMode();
                    boolean set = b.universe[u].setIoMode(XHL_DmxUniverse.XHL_IoMode.XHL_Output);
                    log.log("Bridge: universe " + u + ": " + b.channels[u] + " channels licensed, ioMode was "
                        + was + ", setIoMode(Output)=" + set + ", now " + b.universe[u].getIoMode());
                } catch (Throwable t) {
                    log.log("Bridge: setIoMode universe " + u + " failed: " + t);
                }
            }
            synchronized (lock) {
                // Replay the last known state into the new device.
                for (int u = 0; u < n; u++) if (seen[u]) dirty[u] = true;
            }
            binding = b;
            wakePump();
            log.log("Bridge: device attached, " + n + " universe(s).");
            sendStatus();
            return true;
        } catch (Throwable t) {
            log.log("Bridge: attach failed: " + t);
            return false;
        }
    }

    void detach(String reason) {
        if (binding == null) return;
        binding = null;
        log.log("Bridge: device detached (" + reason + "). Frames are kept and replayed on reattach.");
        sendStatus();
    }

    boolean isAttached() { return binding != null; }

    /** True while an engine has completed the WebSocket handshake and is still connected. */
    boolean isClientConnected() { return clientOut != null; }

    // --- DMX pump: waits for a frame or a deadline, latest-wins, change test, rate cap, refresh ---

    /** Wake the pump: a frame arrived, the cap changed, a client came, a device was attached. */
    private void wakePump() {
        synchronized (lock) {
            wake = true;
            lock.notifyAll();
        }
    }

    private static long gapFor(double fps) {
        return (long) (1e9 / fps);
    }

    private void pumpLoop() {
        log.log("Bridge: DMX pump running, woken by every frame, cap " + (int) DEFAULT_FPS
            + " fps until lightdeck sets another, idle refresh every " + REFRESH_MS + " ms, alive every "
            + ALIVE_MS + " ms.");
        long nextStats = System.nanoTime() + STATS_MS * NS_PER_MS;
        long nextAlive = System.nanoTime(); // due at once when a client has just come
        while (running) {
            long wait = MAX_WAIT_MS * NS_PER_MS;
            Binding b = binding;
            if (b != null) {
                for (int u = 0; u < b.universes; u++) wait = Math.min(wait, pumpUniverse(b, u));
            }
            long now = System.nanoTime();
            if (clientOut != null) {
                if (nextAlive - now <= 0) {
                    sendAlive(b);
                    nextAlive = now + ALIVE_MS * NS_PER_MS;
                }
                wait = Math.min(wait, nextAlive - now);
            } else {
                nextAlive = now;
            }
            if (nextStats - now <= 0) {
                logStats(b);
                nextStats = now + STATS_MS * NS_PER_MS;
            }
            wait = Math.min(wait, nextStats - now);
            sleepOnLock(wait);
        }
    }

    /** Waits until something wakes the pump or `ns` have passed, whichever is first. */
    private void sleepOnLock(long ns) {
        // Object.wait(0) waits for ever, so never less than 1 ms. Rounded up, so that the
        // deadline has passed when the pump looks again.
        long ms = (ns + NS_PER_MS - 1) / NS_PER_MS;
        if (ms < 1) ms = 1;
        synchronized (lock) {
            if (!wake) {
                try { lock.wait(ms); } catch (InterruptedException ignored) { }
            }
            wake = false;
        }
    }

    /**
     * Does what is due on one universe and returns in how many nanoseconds the next thing
     * is due (Long.MAX_VALUE when nothing is). Called by the pump thread only.
     */
    private long pumpUniverse(Binding b, int u) {
        boolean arrived;
        synchronized (lock) {
            arrived = dirty[u];
            if (arrived) {
                System.arraycopy(latest[u], 0, b.pending[u], 0, 512);
                dirty[u] = false;
            }
        }
        if (arrived) b.hasPending[u] = true; // a newer frame replaces one that was waiting

        // The device's licence gives this universe no channels. The vendor library would
        // refuse every frame ("dongle limitation"), so do not even try.
        if (b.channels[u] <= 0) {
            if (arrived) refusedFrames++;
            b.hasPending[u] = false;
            if (!b.toldUnusable[u]) {
                b.toldUnusable[u] = true;
                log.log(">>> Frames arrive for universe " + u + ", but this LR512 has 0 channels licensed"
                    + " on it. They are ignored. Send to a universe that has channels.");
            }
            return Long.MAX_VALUE;
        }

        // Only changes: the same bytes as the last frame sent are not a new frame. The
        // refresh below is what keeps the device fed.
        if (b.hasPending[u] && b.delivered[u] && Arrays.equals(b.pending[u], b.image[u])) {
            b.hasPending[u] = false;
            skippedFrames++;
        }

        long gap = minGapNs;
        long refresh = Math.max(REFRESH_MS * NS_PER_MS, gap); // the refresh is under the cap too
        long since = System.nanoTime() - b.lastSend[u];
        if (b.hasPending[u]) {
            if (since < gap) return gap - since; // the newest frame waits for the end of the gap
            sendUniverse(b, u, true);
            return refresh;
        }
        if (b.hasImage[u]) {
            if (since < refresh) return refresh - since;
            sendUniverse(b, u, false);
            return refresh;
        }
        return Long.MAX_VALUE;
    }

    /**
     * Hands the universe to the vendor library. With `fresh` the pending frame is copied
     * into the vendor buffer first; without it the buffer is sent as it is (the refresh).
     *
     * The vendor buffer keeps what it was given: the original app has one buffer per
     * universe, changes it with setValue and sends it every 40 ms, and sendDmx takes it as
     * a const reference. So a refresh needs no copy. copyBuffer(int[]) is one JNI call
     * that does setValue(i, a[i]) for the whole array, which is what this method used to
     * do in 512 JNI calls; it never changes the size of the buffer.
     */
    private void sendUniverse(Binding b, int u, boolean fresh) {
        String problem = null;
        long start = System.nanoTime();
        b.lastSend[u] = start; // also when it fails: the cap counts attempts
        try {
            if (fresh) {
                byte[] frame = b.pending[u];
                int[] ints = b.ints[u];
                for (int c = 0; c < 512; c++) ints[c] = frame[c] & 0xff;
                b.buffer[u].copyBuffer(ints);
                System.arraycopy(frame, 0, b.image[u], 0, 512);
                b.hasImage[u] = true;
                b.hasPending[u] = false;
            }
            handedFrames++;
            boolean ok = b.universe[u].sendDmx(b.buffer[u]);
            b.delivered[u] = ok;
            if (ok) {
                if (fresh) sentNew++; else sentRefresh++;
            } else {
                problem = "returned false, library says: " + lastError();
            }
        } catch (Throwable t) {
            b.delivered[u] = false;
            problem = "threw " + t;
        }
        if (problem != null) {
            failedFrames++;
            if (start - b.lastFailureLog[u] >= FAILURE_LOG_EVERY_MS * NS_PER_MS) {
                b.lastFailureLog[u] = start;
                log.log("Bridge: sendDmx(universe " + u + ") " + problem);
            }
        }
    }

    private void sendAlive(Binding b) {
        String json = "{\"type\":\"alive\",\"device\":\"" + (b != null ? "open" : "lost")
            + "\",\"frames\":" + handedFrames + "}";
        try {
            writeFrame(0x1, json.getBytes(UTF8));
        } catch (Throwable ignored) {
            // A broken connection shows in the receive thread, which closes it.
        }
    }

    private static String lastError() {
        try {
            XHL x = XHL.libXHW();
            return x.getLastError() + " / " + x.getLastErrorDescription();
        } catch (Throwable t) {
            return "?";
        }
    }

    private void logStats(Binding b) {
        long rx, dropped;
        synchronized (lock) {
            rx = rxFrames; rxFrames = 0;
            dropped = droppedNoDevice; droppedNoDevice = 0;
        }
        long sentN = sentNew, sentR = sentRefresh, failed = failedFrames, refused = refusedFrames,
            skipped = skippedFrames;
        sentNew = 0; sentRefresh = 0; failedFrames = 0; refusedFrames = 0; skippedFrames = 0;
        if (rx == 0 && sentN + sentR == 0 && failed == 0 && refused == 0 && skipped == 0) return;
        log.log("Bridge: 10s stats: rx=" + rx + " sent=" + (sentN + sentR) + " (new=" + sentN + " refresh="
            + sentR + ") skipped=" + skipped + " failed=" + failed
            + (refused > 0 ? " ignored(no channels)=" + refused : "")
            + " cap=" + fpsText(maxFps) + "fps"
            + (b == null ? " (no device, " + dropped + " frames held)" : ""));
    }

    private static String fpsText(double fps) {
        return fps == Math.rint(fps) ? String.valueOf((long) fps) : String.valueOf(fps);
    }

    // --- WebSocket accept loop (one client at a time) ---
    private void acceptLoop() {
        while (running && server == null) {
            try {
                server = new ServerSocket(port);
                log.log("Bridge: WebSocket listening on port " + port);
            } catch (Throwable t) {
                log.log("Bridge: could not listen on " + port + ": " + t + " (retrying in 3 s)");
                sleep(3000);
            }
        }
        while (running) {
            try {
                Socket s = server.accept();
                s.setTcpNoDelay(true);
                try { if (client != null) client.close(); } catch (Throwable ignored) { }
                client = s;
                log.log("Bridge: client connected from " + s.getInetAddress().getHostAddress());
                handleClient(s);
                log.log("Bridge: client disconnected.");
            } catch (Throwable t) {
                if (running) log.log("Bridge: accept error: " + t);
            }
        }
    }

    private void handleClient(Socket s) {
        try {
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            if (!handshake(in, out)) { log.log("Bridge: WS handshake failed."); return; }
            setMaxFps(DEFAULT_FPS); // a new client starts at the default, whatever the last one asked
            clientOut = out;
            sendStatus();
            wakePump(); // the first alive message goes out now
            byte[] payload = new byte[FRAME + 16];
            int ignoredText = 0;
            boolean idleLimit = false;
            while (running && !s.isClosed()) {
                int opcode = readFrame(in, payload);
                if (opcode < 0) break;              // closed
                if (opcode == 0x8) break;           // close
                if (opcode == 0x9) { writeFrame(0xA, new byte[0]); continue; } // ping -> pong
                if (opcode == 0x2 && lastPayloadLen >= FRAME) onDmxFrame(payload);
                if (opcode == 0x1) {
                    if (onText(payload, lastPayloadLen)) {
                        if (!idleLimit) {
                            // From the first valid limits message the client has to keep talking.
                            // The timeout counts per read, so any byte restarts it, and one that
                            // runs out in the middle of a frame ends the connection through the
                            // exception below, never a parse that goes on.
                            idleLimit = true;
                            s.setSoTimeout((int) CLIENT_IDLE_MS);
                        }
                    } else if (ignoredText++ < IGNORED_TEXT_LOGGED) {
                        log.log("Bridge: ignored a text message from the client that is not a valid limits message ("
                            + lastPayloadLen + " bytes).");
                    }
                }
                // other opcodes ignored
            }
        } catch (SocketTimeoutException t) {
            // Only possible once the idle limit is set.
            if (running) {
                log.log("Bridge: client silent for " + (CLIENT_IDLE_MS / 1000)
                    + " s, closing the connection so that it can reconnect.");
                try {
                    writeFrame(0x8, new byte[] { 0x03, (byte) 0xE8 }); // close, 1000
                } catch (Throwable ignored) { }
            }
        } catch (Throwable t) {
            if (running) log.log("Bridge: client error: " + t);
        } finally {
            clientOut = null;
            setMaxFps(DEFAULT_FPS); // nobody is asking for a cap any more
            try { s.close(); } catch (Throwable ignored) { }
        }
    }

    /**
     * A text message from the client: {"type":"limits","maxFps":25}. Returns false when it
     * is not that, in which case it is ignored and the connection stays.
     */
    private boolean onText(byte[] payload, int len) {
        // A message that did not fit the buffer was cut off: not one of ours.
        if (len >= payload.length) return false;
        try {
            String json = new String(payload, 0, len, UTF8).trim();
            if (!json.startsWith("{") || !json.endsWith("}")) return false;
            String type = jsonValue(json, "type");
            if (type == null || !type.startsWith("\"limits\"")) return false;
            String number = jsonValue(json, "maxFps");
            if (number == null) return false;
            int end = 0;
            while (end < number.length() && "+-0123456789.eE".indexOf(number.charAt(end)) >= 0) end++;
            if (end == 0) return false;
            double fps = Double.parseDouble(number.substring(0, end));
            if (fps != fps) return false; // NaN
            setMaxFps(Math.max(MIN_FPS, Math.min(MAX_FPS, fps)));
            return true;
        } catch (Throwable t) {
            return false; // NumberFormatException and anything else odd
        }
    }

    /** What stands after `"key":` in a JSON text, or null. Enough for a flat object. */
    private static String jsonValue(String json, String key) {
        String quoted = "\"" + key + "\"";
        int from = 0;
        while (true) {
            int at = json.indexOf(quoted, from);
            if (at < 0) return null;
            int i = at + quoted.length();
            while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
            if (i < json.length() && json.charAt(i) == ':') {
                i++;
                while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
                return json.substring(i);
            }
            from = at + quoted.length();
        }
    }

    private void setMaxFps(double fps) {
        boolean changed;
        synchronized (lock) {
            changed = fps != maxFps;
            maxFps = fps;
            minGapNs = gapFor(fps);
            wake = true;
            lock.notifyAll();
        }
        if (changed) log.log("Bridge: frame cap is now " + fpsText(fps) + " fps.");
    }

    private void onDmxFrame(byte[] payload) {
        int u = payload[0] & 0xff;
        if (u >= MAX_UNIVERSES) {
            log.log("Bridge: rx frame for universe " + u + ", max is " + (MAX_UNIVERSES - 1));
            return;
        }
        synchronized (lock) {
            System.arraycopy(payload, 1, latest[u], 0, 512);
            dirty[u] = true;
            seen[u] = true;
            rxFrames++;
            if (binding == null) droppedNoDevice++;
            wake = true;
            lock.notifyAll();
        }
    }

    private void sendStatus() {
        Binding b = binding;
        StringBuilder channels = new StringBuilder("[");
        if (b != null) {
            for (int u = 0; u < b.universes; u++) {
                if (u > 0) channels.append(',');
                channels.append(b.channels[u]);
            }
        }
        channels.append(']');
        String json = "{\"type\":\"status\",\"device\":\"" + (b != null ? "open" : "lost")
            + "\",\"universes\":" + (b != null ? b.universes : 0)
            + ",\"channels\":" + channels + "}";
        try {
            writeFrame(0x1, json.getBytes("UTF-8"));
        } catch (Throwable ignored) { }
    }

    /**
     * Server -> client frame, unmasked, as one write, so that the pump thread, the receive
     * thread and the supervisor can all call it. Payloads here are always short.
     */
    private void writeFrame(int opcode, byte[] payload) throws Exception {
        OutputStream out = clientOut;
        if (out == null) return;
        int head = payload.length < 126 ? 2 : 4;
        byte[] frame = new byte[head + payload.length];
        frame[0] = (byte) (0x80 | (opcode & 0x0f));
        if (head == 2) {
            frame[1] = (byte) payload.length;
        } else {
            frame[1] = 126;
            frame[2] = (byte) ((payload.length >> 8) & 0xff);
            frame[3] = (byte) (payload.length & 0xff);
        }
        System.arraycopy(payload, 0, frame, head, payload.length);
        synchronized (writeLock) {
            out.write(frame);
            out.flush();
        }
    }

    private boolean handshake(InputStream in, OutputStream out) throws Exception {
        StringBuilder sb = new StringBuilder();
        int c;
        // read until \r\n\r\n
        while ((c = in.read()) != -1) {
            sb.append((char) c);
            if (c == '\n' && sb.length() >= 4
                && sb.charAt(sb.length() - 2) == '\r'
                && sb.charAt(sb.length() - 3) == '\n'
                && sb.charAt(sb.length() - 4) == '\r') break;
            if (sb.length() > 8192) return false;
        }
        String key = null;
        for (String line : sb.toString().split("\r\n")) {
            int idx = line.indexOf(':');
            if (idx > 0 && line.substring(0, idx).trim().equalsIgnoreCase("Sec-WebSocket-Key")) {
                key = line.substring(idx + 1).trim();
            }
        }
        if (key == null) return false;
        MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
        byte[] hash = sha1.digest((key + WS_GUID).getBytes("UTF-8"));
        String accept = Base64.encodeToString(hash, Base64.NO_WRAP);
        String resp = "HTTP/1.1 101 Switching Protocols\r\n"
            + "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        out.write(resp.getBytes("UTF-8"));
        out.flush();
        return true;
    }

    private int lastPayloadLen = 0;

    // Reads one client frame into buf (unmasked payload). Returns the opcode, or -1 on EOF.
    private int readFrame(InputStream in, byte[] buf) throws Exception {
        int b0 = in.read();
        if (b0 < 0) return -1;
        int b1 = in.read();
        if (b1 < 0) return -1;
        int opcode = b0 & 0x0f;
        boolean masked = (b1 & 0x80) != 0;
        long len = b1 & 0x7f;
        if (len == 126) {
            len = ((long) readByte(in) << 8) | readByte(in);
        } else if (len == 127) {
            len = 0;
            for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
        }
        byte[] mask = new byte[4];
        if (masked) readFully(in, mask, 0, 4);
        lastPayloadLen = (int) Math.min(len, buf.length);
        // read payload (into buf up to capacity, discard overflow)
        long toRead = len;
        int off = 0;
        byte[] scratch = new byte[1024];
        while (toRead > 0) {
            int chunk = (int) Math.min(toRead, scratch.length);
            readFully(in, scratch, 0, chunk);
            for (int i = 0; i < chunk; i++) {
                int val = masked ? (scratch[i] ^ mask[(off + i) & 3]) & 0xff : scratch[i] & 0xff;
                if (off + i < buf.length) buf[off + i] = (byte) val;
            }
            off += chunk; toRead -= chunk;
        }
        return opcode;
    }

    private int readByte(InputStream in) throws Exception {
        int b = in.read();
        if (b < 0) throw new java.io.EOFException();
        return b & 0xff;
    }

    private void readFully(InputStream in, byte[] b, int off, int len) throws Exception {
        int n = 0;
        while (n < len) {
            int r = in.read(b, off + n, len - n);
            if (r < 0) throw new java.io.EOFException();
            n += r;
        }
    }

    private void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException ignored) { }
    }
}
