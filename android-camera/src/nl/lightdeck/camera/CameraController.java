package nl.lightdeck.camera;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.ImageFormat;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureFailure;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.TotalCaptureResult;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The camera, held by hand: the exposure, the sensitivity and the focus are fixed to what lightdeck
 * asked, so that every photo of a survey is made the same way and can be compared with the next.
 *
 * The preview (what the operator aims with) runs in automatic exposure, and a photo or clip is a
 * request of its own with the manual values. One operation at a time (`op`): a photo, a clip and a
 * change of settings never overlap. The camera callbacks come on a thread of their own, and the
 * HTTP threads wait for them, so no operation may be started from that thread.
 *
 * A clip needs its own session (preview plus the recorder), so the still session is closed for it
 * and built again after. Frame duration limits a clip's exposure to a thirtieth of a second.
 */
final class CameraController {
    /** The camera is not open (the app is behind another, or has no permission). */
    static final class NotReady extends Exception {
        NotReady(String message) {
            super(message);
        }
    }

    static final class Capture {
        final byte[] data;
        final String settings;

        Capture(byte[] data, String settings) {
            this.data = data;
            this.settings = settings;
        }
    }

    private static final long MAX_VIDEO_EXPOSURE_NS = 33333333L;

    private final Context context;
    private final CameraManager manager;
    private final HandlerThread thread = new HandlerThread("camera");
    private final Handler handler;
    /** One operation at a time. */
    private final Object op = new Object();

    private String cameraId;
    private CameraCharacteristics chars;
    private boolean manualSensor;
    private volatile CameraDevice device;
    private Surface previewSurface;
    private Size previewSize;
    private Size stillSize;
    private Size videoSize;
    private ImageReader reader;
    private volatile CameraCaptureSession session;
    private volatile boolean ready;
    private volatile String problem = "the camera is not open yet";

    private int iso = 100;
    private double exposureMs = 100;
    private double focus = 0;
    private int width = 1600;

    CameraController(Context context) {
        this.context = context;
        this.manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        thread.start();
        handler = new Handler(thread.getLooper());
    }

    Size previewSize() {
        return previewSize;
    }

    boolean isReady() {
        return ready;
    }

    String problem() {
        return problem;
    }

    // --- opening ---------------------------------------------------------------------------

    /** Opens the back camera and starts the preview on this texture. Returns at once. */
    @SuppressLint("MissingPermission")
    void start(SurfaceTexture texture) {
        try {
            pickCamera();
            texture.setDefaultBufferSize(previewSize.getWidth(), previewSize.getHeight());
            previewSurface = new Surface(texture);
            manager.openCamera(cameraId, new CameraDevice.StateCallback() {
                @Override
                public void onOpened(CameraDevice opened) {
                    device = opened;
                    createStillSession(null);
                }

                @Override
                public void onDisconnected(CameraDevice lost) {
                    lost.close();
                    down("the camera was taken by another app");
                }

                @Override
                public void onError(CameraDevice broken, int error) {
                    broken.close();
                    down("the camera gave error " + error);
                }
            }, handler);
        } catch (Exception e) {
            down("cannot open the camera: " + e);
        }
    }

    /** Closes the camera (the app went behind another one). */
    void close() {
        synchronized (op) {
            ready = false;
            problem = "the camera is closed: bring the app to the screen";
            if (session != null) {
                session.close();
                session = null;
            }
            if (device != null) {
                device.close();
                device = null;
            }
            if (reader != null) {
                reader.close();
                reader = null;
            }
        }
    }

    private void down(String why) {
        ready = false;
        problem = why;
        device = null;
        session = null;
    }

    private void pickCamera() throws CameraAccessException {
        String chosen = null;
        for (String id : manager.getCameraIdList()) {
            CameraCharacteristics c = manager.getCameraCharacteristics(id);
            Integer facing = c.get(CameraCharacteristics.LENS_FACING);
            if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                chosen = id;
                break;
            }
        }
        if (chosen == null) {
            String[] ids = manager.getCameraIdList();
            if (ids.length == 0) throw new CameraAccessException(CameraAccessException.CAMERA_DISCONNECTED);
            chosen = ids[0];
        }
        cameraId = chosen;
        chars = manager.getCameraCharacteristics(chosen);
        int[] capabilities = chars.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        manualSensor = false;
        if (capabilities != null) {
            for (int cap : capabilities) {
                if (cap == CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR) manualSensor = true;
            }
        }
        chooseSizes();
    }

    /** The largest size that is not wider than `maxWidth`, in the shape of `aspect` if there is one. */
    private static Size choose(Size[] sizes, int maxWidth, double aspect) {
        Size best = null;
        Size bestLoose = null;
        Size smallest = null;
        for (Size s : sizes) {
            if (smallest == null || s.getWidth() < smallest.getWidth()) smallest = s;
            if (s.getWidth() > maxWidth) continue;
            if (bestLoose == null || s.getWidth() > bestLoose.getWidth()) bestLoose = s;
            double a = (double) s.getWidth() / s.getHeight();
            if (aspect > 0 && Math.abs(a - aspect) > 0.02) continue;
            if (best == null || s.getWidth() > best.getWidth()) best = s;
        }
        if (best != null) return best;
        if (bestLoose != null) return bestLoose;
        return smallest;
    }

    private void chooseSizes() {
        StreamConfigurationMap map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        stillSize = choose(map.getOutputSizes(ImageFormat.JPEG), width, 16.0 / 9);
        double aspect = (double) stillSize.getWidth() / stillSize.getHeight();
        previewSize = choose(map.getOutputSizes(SurfaceTexture.class), 1280, aspect);
        videoSize = choose(map.getOutputSizes(MediaRecorder.class), 1280, aspect);
    }

    // --- sessions --------------------------------------------------------------------------

    /** Builds the session of preview and photos. `done` runs on the camera thread when it is up or failed. */
    private void createStillSession(final Runnable done) {
        try {
            if (session != null) {
                session.close();
                session = null;
            }
            if (reader != null) reader.close();
            reader = ImageReader.newInstance(stillSize.getWidth(), stillSize.getHeight(), ImageFormat.JPEG, 2);
            List<Surface> outputs = Arrays.asList(previewSurface, reader.getSurface());
            device.createCaptureSession(outputs, new CameraCaptureSession.StateCallback() {
                @Override
                public void onConfigured(CameraCaptureSession configured) {
                    session = configured;
                    try {
                        CaptureRequest.Builder preview = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW);
                        preview.addTarget(previewSurface);
                        preview.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);
                        configured.setRepeatingRequest(preview.build(), null, handler);
                        ready = true;
                        problem = null;
                    } catch (Exception e) {
                        down("cannot start the preview: " + e);
                    }
                    if (done != null) done.run();
                }

                @Override
                public void onConfigureFailed(CameraCaptureSession failed) {
                    down("the camera could not be configured");
                    if (done != null) done.run();
                }
            }, handler);
        } catch (Exception e) {
            down("cannot build the camera session: " + e);
            if (done != null) done.run();
        }
    }

    /** Called from an HTTP thread: builds the still session again and waits for it. */
    private void rebuildStill() throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        ready = false;
        createStillSession(new Runnable() {
            @Override
            public void run() {
                latch.countDown();
            }
        });
        if (!latch.await(10, TimeUnit.SECONDS) || !ready) {
            throw new NotReady(problem == null ? "the camera did not come back" : problem);
        }
    }

    private void requireReady() throws NotReady {
        if (!ready || device == null || session == null) {
            throw new NotReady(problem == null ? "the camera is not ready" : problem);
        }
    }

    // --- settings --------------------------------------------------------------------------

    /** Any of the four may be null, which leaves it as it is. A new width rebuilds the session. */
    void configure(Double isoValue, Double exposure, Double focusValue, Double widthValue) throws Exception {
        synchronized (op) {
            if (isoValue != null) {
                if (isoValue.doubleValue() < 1) throw new IllegalArgumentException("iso is a number from 1");
                iso = (int) Math.round(isoValue.doubleValue());
            }
            if (exposure != null) {
                if (exposure.doubleValue() <= 0) throw new IllegalArgumentException("exposureMs is above 0");
                exposureMs = exposure.doubleValue();
            }
            if (focusValue != null) {
                if (focusValue.doubleValue() < 0) throw new IllegalArgumentException("focus is in diopters, 0 or more");
                focus = focusValue.doubleValue();
            }
            if (widthValue != null) {
                int wanted = (int) Math.round(widthValue.doubleValue());
                if (wanted < 320) throw new IllegalArgumentException("width is at least 320");
                if (wanted != width && chars != null) {
                    width = wanted;
                    chooseSizes();
                    if (device != null) rebuildStill();
                } else {
                    width = wanted;
                }
            }
        }
    }

    private long exposureNs() {
        double ns = exposureMs * 1000000.0;
        Range<Long> range = chars == null ? null : chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        if (range != null) ns = Math.max(range.getLower().longValue(), Math.min(range.getUpper().longValue(), ns));
        return (long) ns;
    }

    private int clampedIso() {
        Range<Integer> range = chars == null ? null : chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        if (range == null) return iso;
        return Math.max(range.getLower().intValue(), Math.min(range.getUpper().intValue(), iso));
    }

    private float clampedFocus() {
        Float min = chars == null ? null : chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        float f = (float) focus;
        if (min != null && min.floatValue() > 0) f = Math.min(f, min.floatValue());
        return f;
    }

    /** Everything fixed: no auto exposure, no auto white balance, no auto focus, no flash. */
    private void applyManual(CaptureRequest.Builder builder, long exposure) {
        builder.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
        builder.set(CaptureRequest.CONTROL_AE_MODE, CameraMetadata.CONTROL_AE_MODE_OFF);
        builder.set(CaptureRequest.SENSOR_SENSITIVITY, clampedIso());
        builder.set(CaptureRequest.SENSOR_EXPOSURE_TIME, exposure);
        builder.set(CaptureRequest.CONTROL_AWB_MODE, CameraMetadata.CONTROL_AWB_MODE_DAYLIGHT);
        builder.set(CaptureRequest.CONTROL_AF_MODE, CameraMetadata.CONTROL_AF_MODE_OFF);
        builder.set(CaptureRequest.LENS_FOCUS_DISTANCE, clampedFocus());
        builder.set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_OFF);
    }

    private int jpegOrientation() {
        int sensor = 0;
        Integer value = chars.get(CameraCharacteristics.SENSOR_ORIENTATION);
        if (value != null) sensor = value.intValue();
        int rotation = ((WindowManager) context.getSystemService(Context.WINDOW_SERVICE))
                .getDefaultDisplay().getRotation();
        int degrees = rotation * 90;
        return (sensor - degrees + 360) % 360;
    }

    // --- photo -----------------------------------------------------------------------------

    Capture photo() throws Exception {
        synchronized (op) {
            requireReady();
            final ImageReader imageReader = reader;
            Image stale;
            imageReader.setOnImageAvailableListener(null, null);
            while ((stale = imageReader.acquireLatestImage()) != null) stale.close();

            final AtomicReference<byte[]> data = new AtomicReference<byte[]>();
            final AtomicReference<TotalCaptureResult> result = new AtomicReference<TotalCaptureResult>();
            final AtomicReference<String> failure = new AtomicReference<String>();
            final CountDownLatch done = new CountDownLatch(2);
            imageReader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override
                public void onImageAvailable(ImageReader r) {
                    Image image = r.acquireNextImage();
                    if (image == null) return;
                    try {
                        ByteBuffer buffer = image.getPlanes()[0].getBuffer();
                        byte[] bytes = new byte[buffer.remaining()];
                        buffer.get(bytes);
                        data.set(bytes);
                    } finally {
                        image.close();
                    }
                    done.countDown();
                }
            }, handler);

            long exposure = exposureNs();
            CaptureRequest.Builder builder = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
            builder.addTarget(imageReader.getSurface());
            applyManual(builder, exposure);
            builder.set(CaptureRequest.JPEG_ORIENTATION, jpegOrientation());
            builder.set(CaptureRequest.JPEG_QUALITY, (byte) 95);
            session.capture(builder.build(), new CameraCaptureSession.CaptureCallback() {
                @Override
                public void onCaptureCompleted(CameraCaptureSession s, CaptureRequest request, TotalCaptureResult r) {
                    result.set(r);
                    done.countDown();
                }

                @Override
                public void onCaptureFailed(CameraCaptureSession s, CaptureRequest request, CaptureFailure f) {
                    failure.set("the camera failed to capture (reason " + f.getReason() + ")");
                    done.countDown();
                    done.countDown();
                }
            }, handler);

            long waitMs = 10000 + (long) exposureMs;
            boolean finished = done.await(waitMs, TimeUnit.MILLISECONDS);
            imageReader.setOnImageAvailableListener(null, null);
            if (failure.get() != null) throw new IOException(failure.get());
            if (!finished || data.get() == null) throw new IOException("the photo did not arrive within " + waitMs + " ms");
            return new Capture(data.get(), settingsOf(result.get(), stillSize));
        }
    }

    // --- clip ------------------------------------------------------------------------------

    Capture clip(double seconds) throws Exception {
        synchronized (op) {
            requireReady();
            File file = new File(context.getCacheDir(), "clip.mp4");
            if (file.exists() && !file.delete()) throw new IOException("cannot clear the clip file");

            // The still session makes room for one with the recorder in it.
            ready = false;
            session.close();
            session = null;
            MediaRecorder recorder = new MediaRecorder();
            CameraCaptureSession clipSession = null;
            String settings = null;
            try {
                recorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
                recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
                recorder.setOutputFile(file.getAbsolutePath());
                recorder.setVideoEncodingBitRate(10000000);
                recorder.setVideoFrameRate(30);
                recorder.setVideoSize(videoSize.getWidth(), videoSize.getHeight());
                recorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
                recorder.setOrientationHint(jpegOrientation());
                recorder.prepare();
                Surface recorderSurface = recorder.getSurface();

                long exposure = Math.min(exposureNs(), MAX_VIDEO_EXPOSURE_NS);
                CaptureRequest.Builder builder = device.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
                builder.addTarget(previewSurface);
                builder.addTarget(recorderSurface);
                applyManual(builder, exposure);

                clipSession = openSession(Arrays.asList(previewSurface, recorderSurface));
                clipSession.setRepeatingRequest(builder.build(), null, handler);
                recorder.start();
                Thread.sleep((long) (seconds * 1000));
                clipSession.stopRepeating();
                recorder.stop();
                settings = settingsOf(null, videoSize, exposure);
            } finally {
                try {
                    recorder.release();
                } catch (RuntimeException ignored) {
                }
                if (clipSession != null) clipSession.close();
                rebuildStill();
            }
            return new Capture(readAll(file), settings);
        }
    }

    /** Builds a session and waits for it, from an HTTP thread. */
    private CameraCaptureSession openSession(List<Surface> surfaces) throws Exception {
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicReference<CameraCaptureSession> made = new AtomicReference<CameraCaptureSession>();
        device.createCaptureSession(surfaces, new CameraCaptureSession.StateCallback() {
            @Override
            public void onConfigured(CameraCaptureSession configured) {
                made.set(configured);
                latch.countDown();
            }

            @Override
            public void onConfigureFailed(CameraCaptureSession failed) {
                latch.countDown();
            }
        }, handler);
        if (!latch.await(10, TimeUnit.SECONDS) || made.get() == null) {
            throw new IOException("the camera could not be configured for a clip");
        }
        return made.get();
    }

    private static byte[] readAll(File file) throws IOException {
        InputStream in = new FileInputStream(file);
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[65536];
            int n;
            while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
            return out.toByteArray();
        } finally {
            in.close();
        }
    }

    // --- what is said about it -------------------------------------------------------------

    private String settingsOf(TotalCaptureResult result, Size size) throws JSONException {
        return settingsOf(result, size, exposureNs());
    }

    /** What was used for a shot, as the camera reports it where it does, as one line of JSON. */
    private String settingsOf(TotalCaptureResult result, Size size, long requestedNs) throws JSONException {
        JSONObject o = new JSONObject();
        Integer sensitivity = result == null ? null : result.get(TotalCaptureResult.SENSOR_SENSITIVITY);
        Long exposure = result == null ? null : result.get(TotalCaptureResult.SENSOR_EXPOSURE_TIME);
        Float lens = result == null ? null : result.get(TotalCaptureResult.LENS_FOCUS_DISTANCE);
        o.put("iso", sensitivity != null ? sensitivity.intValue() : clampedIso());
        o.put("exposureMs", (exposure != null ? exposure.longValue() : requestedNs) / 1000000.0);
        o.put("focus", lens != null ? lens.doubleValue() : clampedFocus());
        o.put("width", size.getWidth());
        o.put("height", size.getHeight());
        o.put("manual", manualSensor);
        o.put("at", System.currentTimeMillis());
        return o.toString();
    }

    JSONObject status() throws JSONException {
        synchronized (op) {
            JSONObject o = new JSONObject();
            o.put("ready", ready);
            if (!ready && problem != null) o.put("problem", problem);
            o.put("manualSensor", manualSensor);
            o.put("iso", iso);
            o.put("exposureMs", exposureMs);
            o.put("focus", focus);
            if (chars != null) {
                Range<Integer> isoRange = chars.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
                if (isoRange != null) {
                    o.put("isoRange", new JSONArray(Arrays.asList(isoRange.getLower(), isoRange.getUpper())));
                }
                Range<Long> exposureRange = chars.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
                if (exposureRange != null) {
                    List<Double> ms = new ArrayList<Double>();
                    ms.add(exposureRange.getLower().longValue() / 1000000.0);
                    ms.add(exposureRange.getUpper().longValue() / 1000000.0);
                    o.put("exposureRangeMs", new JSONArray(ms));
                }
                Float minFocus = chars.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
                if (minFocus != null) o.put("minFocus", minFocus.doubleValue());
            }
            if (stillSize != null) {
                o.put("still", new JSONObject().put("width", stillSize.getWidth()).put("height", stillSize.getHeight()));
            }
            if (videoSize != null) {
                o.put("video", new JSONObject().put("width", videoSize.getWidth()).put("height", videoSize.getHeight()));
            }
            return o;
        }
    }

    /** One line for the screen. */
    String summary() {
        if (!ready) return problem == null ? "not ready" : problem;
        return "iso " + iso + "  exposure " + exposureMs + " ms  focus " + focus + "  photos "
                + stillSize.getWidth() + "x" + stillSize.getHeight()
                + (manualSensor ? "" : "  (no manual exposure on this phone)");
    }
}
