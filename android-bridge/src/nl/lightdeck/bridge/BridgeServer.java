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
import java.security.MessageDigest;

/**
 * Dependency-free WebSocket bridge: the engine connects and streams rendered DMX
 * frames; this hands them to the vendor library's sendDmx.
 *
 * Client -> bridge (binary message): [universe:1 byte][512 DMX bytes] = 513 bytes.
 * Bridge -> client (text message):
 *   {"type":"status","device":"open"|"lost","universes":N,"channels":[512,0]}
 *   sent on connect and whenever the device is attached or detached. `channels` is how
 *   many channels the device's licence allows per universe. A universe with 0 channels
 *   cannot be used: the vendor library refuses every frame for it.
 *
 * The WebSocket server is independent of the device. It keeps listening while the device
 * is away, remembers the latest frame per universe, and replays it when a device is
 * attached again, so the engine's connection and the light state survive a device drop.
 *
 * Backpressure: the receive path never blocks on DMX. It only overwrites a per-universe
 * "latest" buffer and marks it dirty. The pump thread sends the most recent frame per
 * universe at a fixed cadence (~40 Hz), so a flood is coalesced to latest-wins.
 *
 * Refresh: a universe that has received data is re-sent every REFRESH_MS even when it
 * did not change, the way a lighting desk keeps transmitting.
 *
 * A failing send says nothing about the connection. It is logged with the library's own
 * reason and counted, and never used to decide that the device is gone.
 *
 * Single client at a time (the engine). A new connection replaces the old one.
 */
final class BridgeServer {

    interface Logger { void log(String msg); }

    static final int MAX_UNIVERSES = 4;

    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final int FRAME = 513;             // 1 universe id + 512 channels
    private static final long PUMP_INTERVAL_MS = 25;  // ~40 Hz
    private static final long REFRESH_MS = 100;       // idle re-send, 10 Hz
    private static final long STATS_MS = 10000;
    private static final long FAILURE_LOG_EVERY_MS = 10000;

    /** Everything that belongs to one opened device. Replaced as a whole on attach. */
    private static final class Binding {
        int universes;
        XHL_DmxUniverse[] universe;
        XHL_DmxSecurisedBuffer[] buffer;
        long[] lastSend;
        int[] channels;        // licensed channels per universe, 0 = unusable
        boolean[] toldUnusable;
        long[] lastFailureLog;
    }

    private final int port;
    private final Logger log;

    private final byte[][] latest = new byte[MAX_UNIVERSES][512];
    private final boolean[] dirty = new boolean[MAX_UNIVERSES];
    private final boolean[] seen = new boolean[MAX_UNIVERSES]; // data was received at least once
    private final Object lock = new Object();

    private volatile Binding binding;          // null while no device is attached
    private volatile boolean running = false;

    private ServerSocket server;
    private volatile Socket client;
    private volatile OutputStream clientOut;
    private final Object writeLock = new Object();

    // counters for the periodic stats line
    private long rxFrames, sentFrames, failedFrames, refusedFrames, droppedNoDevice;

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
            b.lastSend = new long[n];
            b.channels = new int[n];
            b.toldUnusable = new boolean[n];
            b.lastFailureLog = new long[n];
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

    // --- DMX pump: fixed cadence, latest-wins, idle refresh ---
    private void pumpLoop() {
        log.log("Bridge: DMX pump running at ~" + (1000 / PUMP_INTERVAL_MS) + " Hz, idle refresh every "
            + REFRESH_MS + " ms.");
        long lastStats = System.currentTimeMillis();
        while (running) {
            long t0 = System.currentTimeMillis();
            Binding b = binding;
            if (b != null) {
                for (int u = 0; u < b.universes; u++) pumpUniverse(b, u, t0);
            }
            if (t0 - lastStats >= STATS_MS) {
                logStats(b);
                lastStats = t0;
            }
            long dt = System.currentTimeMillis() - t0;
            if (dt < PUMP_INTERVAL_MS) sleep(PUMP_INTERVAL_MS - dt);
        }
    }

    private void pumpUniverse(Binding b, int u, long now) {
        byte[] snapshot = null;
        boolean refresh;
        synchronized (lock) {
            if (dirty[u]) { snapshot = latest[u].clone(); dirty[u] = false; }
            refresh = seen[u] && now - b.lastSend[u] >= REFRESH_MS;
        }
        if (snapshot == null && !refresh) return;

        // The device's licence gives this universe no channels. The vendor library would
        // refuse every frame ("dongle limitation"), so do not even try.
        if (b.channels[u] <= 0) {
            if (snapshot != null) refusedFrames++;
            b.lastSend[u] = now;
            if (!b.toldUnusable[u]) {
                b.toldUnusable[u] = true;
                log.log(">>> Frames arrive for universe " + u + ", but this LR512 has 0 channels licensed"
                    + " on it. They are ignored. Send to a universe that has channels.");
            }
            return;
        }

        String problem = null;
        try {
            if (snapshot != null) {
                for (int c = 0; c < 512; c++) b.buffer[u].setValue(c, snapshot[c] & 0xff);
            }
            boolean ok = b.universe[u].sendDmx(b.buffer[u]);
            b.lastSend[u] = now;
            if (ok) sentFrames++;
            else problem = "returned false, library says: " + lastError();
        } catch (Throwable t) {
            problem = "threw " + t;
        }
        if (problem != null) {
            failedFrames++;
            if (now - b.lastFailureLog[u] >= FAILURE_LOG_EVERY_MS) {
                b.lastFailureLog[u] = now;
                log.log("Bridge: sendDmx(universe " + u + ") " + problem);
            }
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
        long rx, sent, failed, refused, dropped;
        synchronized (lock) {
            rx = rxFrames; rxFrames = 0;
            dropped = droppedNoDevice; droppedNoDevice = 0;
        }
        sent = sentFrames; sentFrames = 0;
        failed = failedFrames; failedFrames = 0;
        refused = refusedFrames; refusedFrames = 0;
        if (rx == 0 && sent == 0 && failed == 0 && refused == 0) return;
        log.log("Bridge: 10s stats: rx=" + rx + " sent=" + sent + " failed=" + failed
            + (refused > 0 ? " ignored(no channels)=" + refused : "")
            + (b == null ? " (no device, " + dropped + " frames held)" : ""));
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
            clientOut = out;
            sendStatus();
            byte[] payload = new byte[FRAME + 16];
            while (running && !s.isClosed()) {
                int opcode = readFrame(in, payload);
                if (opcode < 0) break;              // closed
                if (opcode == 0x8) break;           // close
                if (opcode == 0x9) { writeFrame(0xA, new byte[0]); continue; } // ping -> pong
                if (opcode == 0x2 && lastPayloadLen >= FRAME) onDmxFrame(payload);
                // text/other opcodes ignored
            }
        } catch (Throwable t) {
            if (running) log.log("Bridge: client error: " + t);
        } finally {
            clientOut = null;
            try { s.close(); } catch (Throwable ignored) { }
        }
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

    /** Server -> client frame, unmasked. Payloads here are always short. */
    private void writeFrame(int opcode, byte[] payload) throws Exception {
        OutputStream out = clientOut;
        if (out == null) return;
        synchronized (writeLock) {
            out.write(0x80 | (opcode & 0x0f));
            if (payload.length < 126) {
                out.write(payload.length);
            } else {
                out.write(126);
                out.write((payload.length >> 8) & 0xff);
                out.write(payload.length & 0xff);
            }
            out.write(payload);
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
