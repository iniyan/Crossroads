package com.crossroads.player;

import android.net.Uri;
import android.os.Environment;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Logger;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Serves HTTP range requests for local audio files itself.
 *
 * Capacitor's {@code WebViewLocalServer} answers a {@code Range} request with 206 and a
 * Content-Range header but streams the file from byte 0, so every seek in the audio element
 * restarts the track. This client intercepts {@code /_capacitor_file_/...} requests that carry
 * a Range header, opens the file at the requested offset and returns a correctly bounded body.
 * Everything else (and anything that goes wrong) falls through to Capacitor's own handling.
 */
public class RangeAwareWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "RangeAwareWebViewClient";
    private static final String FILE_PREFIX = Bridge.CAPACITOR_FILE_START + "/";
    private static final String DEFAULT_LOCAL_HOST = "localhost";
    private static final String SHARED_STORAGE_ROOT = "/storage/";

    private static final Map<String, String> MIME_BY_EXTENSION = new HashMap<>();

    static {
        MIME_BY_EXTENSION.put("flac", "audio/flac");
        MIME_BY_EXTENSION.put("mp3", "audio/mpeg");
        MIME_BY_EXTENSION.put("m4a", "audio/mp4");
        MIME_BY_EXTENSION.put("mp4", "audio/mp4");
        MIME_BY_EXTENSION.put("aac", "audio/aac");
        MIME_BY_EXTENSION.put("wav", "audio/wav");
        MIME_BY_EXTENSION.put("ogg", "audio/ogg");
        MIME_BY_EXTENSION.put("opus", "audio/ogg");
    }

    private final Bridge bridge;

    public RangeAwareWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        try {
            WebResourceResponse response = handleRangeRequest(request);
            if (response != null) return response;
        } catch (Exception e) {
            Logger.warn(TAG, "Range handling failed, deferring to Capacitor: " + e.getMessage());
        }
        return super.shouldInterceptRequest(view, request);
    }

    /** @return a response for a ranged local-file request, or null to let Capacitor handle it. */
    private WebResourceResponse handleRangeRequest(WebResourceRequest request) throws IOException {
        if (!"GET".equalsIgnoreCase(request.getMethod())) return null;
        String rangeHeader = header(request, "Range");
        if (rangeHeader == null) return null;

        Uri url = request.getUrl();
        if (url == null || !isLocalHost(url)) return null;
        String path = url.getPath(); // already percent-decoded
        if (path == null || !path.startsWith(FILE_PREFIX)) return null;

        String filePath = path.substring(Bridge.CAPACITOR_FILE_START.length());
        if (!isAllowedFile(filePath)) return null;

        File file = new File(filePath);
        if (!file.isFile() || !file.canRead()) return null;
        long total = file.length();

        String mimeType = mimeTypeFor(file.getName());
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-cache"); // parity with Capacitor's PathHandler

        ByteRange range;
        try {
            range = ByteRange.parse(rangeHeader, total);
        } catch (ByteRange.UnsatisfiableException e) {
            headers.put("Content-Range", "bytes */" + total);
            headers.put("Content-Length", "0");
            return new WebResourceResponse(mimeType, null, 416, "Range Not Satisfiable", headers, emptyStream());
        }

        if (range == null) {
            // Malformed Range header: ignore it and serve the whole file.
            headers.put("Content-Length", String.valueOf(total));
            return new WebResourceResponse(mimeType, null, 200, "OK", headers, new FileInputStream(file));
        }

        // The WebView skips the request's first-byte-pos from this stream itself, so the
        // stream only moves for suffix ranges (see ByteRange.streamPosition()).
        FileInputStream in = new FileInputStream(file);
        try {
            if (range.streamPosition() > 0) in.getChannel().position(range.streamPosition());
        } catch (IOException e) {
            in.close();
            throw e;
        }
        headers.put("Content-Range", range.contentRange(total));
        headers.put("Content-Length", String.valueOf(range.length()));
        return new WebResourceResponse(
            mimeType,
            null,
            206,
            "Partial Content",
            headers,
            new BoundedInputStream(in, range.streamLimit())
        );
    }

    private boolean isLocalHost(Uri url) {
        String host = url.getHost();
        if (host == null) return false;
        String localUrl = bridge.getLocalUrl();
        String localHost = localUrl != null ? Uri.parse(localUrl).getHost() : null;
        if (localHost == null || localHost.isEmpty()) localHost = DEFAULT_LOCAL_HOST;
        return host.equalsIgnoreCase(localHost);
    }

    /**
     * The app only ever plays MediaStore paths, which live on shared storage. Anything else
     * (and any path with '..' segments) is left to Capacitor rather than served here.
     */
    static boolean isAllowedFile(String filePath) {
        if (filePath == null || !filePath.startsWith("/")) return false;
        for (String segment : filePath.split("/")) {
            if ("..".equals(segment)) return false;
        }
        if (filePath.startsWith(SHARED_STORAGE_ROOT)) return true;
        File external = Environment.getExternalStorageDirectory();
        if (external == null) return false;
        String root = external.getAbsolutePath();
        return filePath.startsWith(root.endsWith("/") ? root : root + "/");
    }

    static String mimeTypeFor(String fileName) {
        int dot = fileName.lastIndexOf('.');
        String ext = dot >= 0 ? fileName.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String mime = MIME_BY_EXTENSION.get(ext);
        return mime != null ? mime : "application/octet-stream";
    }

    private static String header(WebResourceRequest request, String name) {
        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
        }
        return null;
    }

    private static InputStream emptyStream() {
        return new InputStream() {
            @Override
            public int read() {
                return -1;
            }
        };
    }
}
