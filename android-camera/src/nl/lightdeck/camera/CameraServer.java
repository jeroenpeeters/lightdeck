package nl.lightdeck.camera;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Map;

/**
 * The HTTP side of the app, by hand on a ServerSocket (no library): one thread per request, each
 * request answered with `Connection: close`. Lightdeck's `pnpm laser-survey` is the only client.
 *
 *   GET  /status                       what the camera can do and is set to, JSON
 *   POST /settings?iso=&exposureMs=&focus=&width=   sets any of them, answers like /status
 *   POST /photo                        a JPEG, with the settings used in x-lightdeck-settings
 *   POST /clip?seconds=                an MP4, the same
 *
 * A failure is a status of 4xx or 5xx with the reason as plain text. The method is not looked at.
 * The home network is trusted, as everywhere in lightdeck: no login.
 */
final class CameraServer {
    private static final Charset UTF8 = Charset.forName("UTF-8");

    private final int port;
    private final CameraController camera;
    private ServerSocket server;
    private volatile boolean running;

    CameraServer(int port, CameraController camera) {
        this.port = port;
        this.camera = camera;
    }

    void start() throws IOException {
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(port));
        running = true;
        Thread accept = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "camera-http");
        accept.setDaemon(true);
        accept.start();
    }

    void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
        }
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket socket = server.accept();
                Thread worker = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        handle(socket);
                    }
                }, "camera-request");
                worker.setDaemon(true);
                worker.start();
            } catch (IOException e) {
                if (running) continue;
            }
        }
    }

    private void handle(Socket socket) {
        try {
            socket.setSoTimeout(10000);
            String head = readHead(socket.getInputStream());
            String line = head.split("\r\n", 2)[0];
            String[] parts = line.split(" ");
            if (parts.length < 2) {
                reply(socket, 400, "text/plain", "bad request".getBytes(UTF8), null);
                return;
            }
            String target = parts[1];
            int q = target.indexOf('?');
            String path = q < 0 ? target : target.substring(0, q);
            Map<String, String> query = parseQuery(q < 0 ? "" : target.substring(q + 1));
            route(socket, path, query);
        } catch (Exception e) {
            try {
                reply(socket, 500, "text/plain", String.valueOf(e.getMessage()).getBytes(UTF8), null);
            } catch (IOException ignored) {
            }
        } finally {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void route(Socket socket, String path, Map<String, String> query) throws IOException {
        try {
            if (path.equals("/status")) {
                reply(socket, 200, "application/json", camera.status().toString().getBytes(UTF8), null);
            } else if (path.equals("/settings")) {
                camera.configure(
                        number(query, "iso"), number(query, "exposureMs"),
                        number(query, "focus"), number(query, "width"));
                reply(socket, 200, "application/json", camera.status().toString().getBytes(UTF8), null);
            } else if (path.equals("/photo")) {
                CameraController.Capture capture = camera.photo();
                reply(socket, 200, "image/jpeg", capture.data, capture.settings);
            } else if (path.equals("/clip")) {
                Double seconds = number(query, "seconds");
                double length = seconds == null ? 10 : seconds.doubleValue();
                if (length < 1 || length > 120) {
                    reply(socket, 400, "text/plain", "seconds is 1 to 120".getBytes(UTF8), null);
                    return;
                }
                CameraController.Capture capture = camera.clip(length);
                reply(socket, 200, "video/mp4", capture.data, capture.settings);
            } else if (path.equals("/")) {
                reply(socket, 200, "text/plain", "Lightdeck camera\n".getBytes(UTF8), null);
            } else {
                reply(socket, 404, "text/plain", "no such thing".getBytes(UTF8), null);
            }
        } catch (CameraController.NotReady e) {
            reply(socket, 503, "text/plain", e.getMessage().getBytes(UTF8), null);
        } catch (IllegalArgumentException e) {
            reply(socket, 400, "text/plain", String.valueOf(e.getMessage()).getBytes(UTF8), null);
        } catch (Exception e) {
            reply(socket, 500, "text/plain", String.valueOf(e).getBytes(UTF8), null);
        }
    }

    private static Double number(Map<String, String> query, String key) {
        String text = query.get(key);
        if (text == null || text.length() == 0) return null;
        try {
            return Double.valueOf(text);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(key + " is not a number: " + text);
        }
    }

    private static Map<String, String> parseQuery(String text) throws IOException {
        Map<String, String> map = new HashMap<String, String>();
        if (text.length() == 0) return map;
        for (String pair : text.split("&")) {
            int eq = pair.indexOf('=');
            String key = eq < 0 ? pair : pair.substring(0, eq);
            String value = eq < 0 ? "" : pair.substring(eq + 1);
            map.put(URLDecoder.decode(key, "UTF-8"), URLDecoder.decode(value, "UTF-8"));
        }
        return map;
    }

    /** Reads up to the empty line that ends the head of a request. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int b;
        while (buffer.size() < 16384 && (b = in.read()) >= 0) {
            buffer.write(b);
            byte[] bytes = buffer.toByteArray();
            int n = bytes.length;
            if (n >= 4 && bytes[n - 4] == '\r' && bytes[n - 3] == '\n'
                    && bytes[n - 2] == '\r' && bytes[n - 1] == '\n') {
                break;
            }
        }
        return new String(buffer.toByteArray(), UTF8);
    }

    private static void reply(Socket socket, int status, String type, byte[] body, String settings)
            throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(' ').append(status == 200 ? "OK" : "Error").append("\r\n");
        head.append("Content-Type: ").append(type).append("\r\n");
        head.append("Content-Length: ").append(body.length).append("\r\n");
        if (settings != null) head.append("x-lightdeck-settings: ").append(settings).append("\r\n");
        head.append("Connection: close\r\n\r\n");
        OutputStream out = socket.getOutputStream();
        out.write(head.toString().getBytes(UTF8));
        out.write(body);
        out.flush();
    }
}
