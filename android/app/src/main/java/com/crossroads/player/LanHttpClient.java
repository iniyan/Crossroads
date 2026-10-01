package com.crossroads.player;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * A deliberately tiny HTTP/1.1 client over a raw {@link Socket} for the sync endpoints (#25).
 *
 * Why not HttpURLConnection: the platform's HTTP stacks obey the network security config, so
 * letting them talk plain HTTP to the desktop means enabling cleartext for the whole app. A raw
 * socket is outside that policy, so cleartext can stay disabled globally and the only cleartext
 * path in the app is this one: it is reached solely from SyncDiscoveryPlugin.request, after
 * LanAddress has restricted the target to http://<private IP literal>:<port>/v1/..., and
 * every byte it carries is AES-GCM encrypted/authenticated by the app layer anyway. There is
 * no proxy (the socket connects directly, Proxy.NO_PROXY), no redirect following, no cookie
 * jar, no caching and no connection reuse. Pure Java: unit-tested on the JVM.
 *
 * Request shape is fixed: GET or POST, JSON body, {@code Connection: close}. The response is
 * read with {@code Content-Length}, chunked transfer coding, or to end-of-stream, and capped at
 * {@code maxResponseBytes}; headers, trailers and line lengths are capped too so a hostile peer
 * cannot make us buffer. Nothing is allocated up front from a length the peer sent: bodies are
 * copied in 16 KB steps and the cap is checked as they grow. Besides the per-read socket
 * timeout, a whole request has a wall-clock deadline (connect + 2 x read timeout, see
 * {@link #deadlineMs}) checked in every read loop and enforced by a watchdog that closes the
 * socket, so a peer that drips one byte per timeout cannot hold the request open for ever.
 */
public final class LanHttpClient {

    public static final class Response {
        public final int status;
        public final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private static final int MAX_LINE_BYTES = 8 * 1024;
    private static final int MAX_HEADER_BYTES = 32 * 1024;
    private static final int MAX_HEADERS = 100;
    private static final int MAX_TRAILER_LINES = 32;
    private static final int COPY_CHUNK = 16 * 1024;

    /** Single daemon thread that closes sockets whose request outlived its deadline. */
    private static final ScheduledExecutorService WATCHDOG;

    static {
        ScheduledThreadPoolExecutor pool = new ScheduledThreadPoolExecutor(1, r -> {
            Thread t = new Thread(r, "lan-http-watchdog");
            t.setDaemon(true);
            return t;
        });
        pool.setRemoveOnCancelPolicy(true);
        WATCHDOG = pool;
    }

    private LanHttpClient() {}

    /** Total budget for one request: the connect timeout plus twice the read timeout. */
    static long deadlineMs(int timeoutMs) {
        return 3L * timeoutMs;
    }

    /**
     * @param host    IP literal (no names: nothing is resolved through DNS)
     * @param method  GET or POST
     * @param path    absolute path (+ query), printable ASCII only
     * @param body    request body for POST (UTF-8 JSON), ignored for GET
     * @param timeoutMs  connect and per-read timeout; the whole request may take at most
     *                   {@link #deadlineMs(int)}
     */
    public static Response request(String host, int port, String method, String path, String body, int timeoutMs, int maxResponseBytes) throws IOException {
        if (!LanAddress.isIpLiteral(host)) throw new IOException("host must be an IP literal");
        if (port < 1 || port > 65535) throw new IOException("invalid port");
        if (!"GET".equals(method) && !"POST".equals(method)) throw new IOException("method not allowed");
        if (!isValidPath(path)) throw new IOException("invalid path");
        if (timeoutMs < 1) throw new IOException("invalid timeout");

        byte[] bodyBytes = "POST".equals(method) ? (body == null ? "" : body).getBytes(StandardCharsets.UTF_8) : new byte[0];
        StringBuilder head = new StringBuilder(256);
        head.append(method).append(' ').append(path).append(" HTTP/1.1\r\n");
        head.append("Host: ").append(hostHeader(host, port)).append("\r\n");
        head.append("Accept: application/json\r\n");
        head.append("User-Agent: Crossroads-Android\r\n");
        head.append("Connection: close\r\n");
        if ("POST".equals(method)) {
            head.append("Content-Type: application/json; charset=utf-8\r\n");
            head.append("Content-Length: ").append(bodyBytes.length).append("\r\n");
        }
        head.append("\r\n");

        InetAddress address = InetAddress.getByName(host);   // literal: no DNS lookup
        long budget = deadlineMs(timeoutMs);
        Deadline deadline = new Deadline(System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(budget));
        try (Socket socket = new Socket(Proxy.NO_PROXY)) {
            // Belt and braces: the read loops check the deadline between reads, the watchdog
            // breaks a read (or a stalled write) that is blocked when it passes.
            ScheduledFuture<?> watchdog = WATCHDOG.schedule(() -> closeQuietly(socket), budget, TimeUnit.MILLISECONDS);
            try {
                socket.setSoTimeout(timeoutMs);
                socket.setTcpNoDelay(true);
                socket.connect(new InetSocketAddress(address, port), timeoutMs);
                OutputStream out = socket.getOutputStream();
                out.write(head.toString().getBytes(StandardCharsets.US_ASCII));
                out.write(bodyBytes);
                out.flush();
                return readResponse(new BufferedInputStream(socket.getInputStream(), COPY_CHUNK), maxResponseBytes, deadline);
            } catch (IOException e) {
                if (deadline.passed()) throw new IOException("request deadline exceeded (" + budget + " ms)", e);
                throw e;
            } finally {
                watchdog.cancel(false);
            }
        }
    }

    private static void closeQuietly(Socket socket) {
        try {
            socket.close();
        } catch (IOException ignored) {
            // already closed
        }
    }

    /** Wall-clock limit for one request; {@link #NONE} for parsing from memory (tests). */
    static final class Deadline {
        static final Deadline NONE = new Deadline(Long.MAX_VALUE);
        private final long atNanos;

        Deadline(long atNanos) {
            this.atNanos = atNanos;
        }

        boolean passed() {
            return atNanos != Long.MAX_VALUE && System.nanoTime() - atNanos >= 0;
        }

        void check() throws IOException {
            if (passed()) throw new IOException("request deadline exceeded");
        }
    }

    /** "192.168.1.2:51234" or "[fd00::5]:51234". */
    static String hostHeader(String host, int port) {
        return (host.indexOf(':') >= 0 ? "[" + host + "]" : host) + ":" + port;
    }

    static boolean isValidPath(String path) {
        if (path == null || path.isEmpty() || path.charAt(0) != '/' || path.length() > 2048) return false;
        for (int i = 0; i < path.length(); i++) {
            char c = path.charAt(i);
            if (c <= 0x20 || c >= 0x7f) return false;   // no whitespace / control / non-ASCII: no request smuggling
        }
        return true;
    }

    static Response readResponse(InputStream in, int maxResponseBytes) throws IOException {
        return readResponse(in, maxResponseBytes, Deadline.NONE);
    }

    static Response readResponse(InputStream in, int maxResponseBytes, Deadline deadline) throws IOException {
        String statusLine = readLine(in, MAX_LINE_BYTES, deadline);
        if (statusLine == null) throw new IOException("empty response");
        int status = parseStatus(statusLine);
        Map<String, String> headers = readHeaders(in, deadline);
        String transfer = headers.get("transfer-encoding");
        String lengthHeader = headers.get("content-length");
        byte[] bytes;
        if (transfer != null && transfer.toLowerCase(Locale.ROOT).contains("chunked")) {
            bytes = readChunked(in, maxResponseBytes, deadline);
        } else if (lengthHeader != null) {
            long length = parseContentLength(lengthHeader);
            if (length > maxResponseBytes) throw new IOException("response too large");
            ByteArrayOutputStream buffer = new ByteArrayOutputStream((int) Math.min(length, COPY_CHUNK));
            copyExactly(in, buffer, length, deadline);
            bytes = buffer.toByteArray();
        } else {
            bytes = readToEnd(in, maxResponseBytes, deadline);
        }
        return new Response(status, new String(bytes, StandardCharsets.UTF_8));
    }

    /** Decimal digits only (no sign, no whitespace inside), at most 15 of them. */
    static long parseContentLength(String value) throws IOException {
        String v = value.trim();
        if (v.isEmpty() || v.length() > 15) throw new IOException("bad content-length");
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (c < '0' || c > '9') throw new IOException("bad content-length");
        }
        return Long.parseLong(v);
    }

    /** Hex digits only (no sign, no 0x, no whitespace), at most 8 of them: fits an int, never negative. */
    static int parseChunkSize(String sizeLine) throws IOException {
        int semicolon = sizeLine.indexOf(';');
        String hex = semicolon >= 0 ? sizeLine.substring(0, semicolon) : sizeLine;
        if (hex.isEmpty() || hex.length() > 8) throw new IOException("bad chunk size");
        long size = 0;
        for (int i = 0; i < hex.length(); i++) {
            int digit = Character.digit(hex.charAt(i), 16);
            if (digit < 0) throw new IOException("bad chunk size");
            size = (size << 4) | digit;
        }
        if (size > Integer.MAX_VALUE) throw new IOException("bad chunk size");
        return (int) size;
    }

    static int parseStatus(String statusLine) throws IOException {
        if (!statusLine.startsWith("HTTP/1.")) throw new IOException("not an HTTP response");
        String[] parts = statusLine.split(" ", 3);
        if (parts.length < 2 || parts[1].length() != 3) throw new IOException("malformed status line");
        try {
            int status = Integer.parseInt(parts[1]);
            if (status < 100 || status > 999) throw new IOException("malformed status code");
            return status;
        } catch (NumberFormatException e) {
            throw new IOException("malformed status code");
        }
    }

    private static Map<String, String> readHeaders(InputStream in, Deadline deadline) throws IOException {
        Map<String, String> headers = new HashMap<>();
        int total = 0;
        int count = 0;
        for (;;) {
            String line = readLine(in, MAX_LINE_BYTES, deadline);
            if (line == null) throw new IOException("truncated headers");
            if (line.isEmpty()) return headers;
            total += line.length();
            if (total > MAX_HEADER_BYTES || ++count > MAX_HEADERS) throw new IOException("headers too large");
            int colon = line.indexOf(':');
            if (colon <= 0) continue;
            String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
            String value = line.substring(colon + 1).trim();
            String previous = headers.get(name);
            headers.put(name, previous == null ? value : previous + ", " + value);
        }
    }

    /** One line without its line ending (CRLF or LF); null at end of stream before any byte. */
    static String readLine(InputStream in, int maxBytes) throws IOException {
        return readLine(in, maxBytes, Deadline.NONE);
    }

    static String readLine(InputStream in, int maxBytes, Deadline deadline) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(128);
        int c;
        boolean any = false;
        deadline.check();
        while ((c = in.read()) != -1) {
            any = true;
            if (c == '\n') break;
            if (buffer.size() >= maxBytes) throw new IOException("line too long");
            buffer.write(c);
            // The buffered stream only blocks when it refills, but a dripping peer makes every
            // byte a refill: check often enough that a slow line cannot outlive the deadline.
            if ((buffer.size() & 0x3f) == 0) deadline.check();
        }
        if (!any) return null;
        byte[] bytes = buffer.toByteArray();
        int end = bytes.length;
        if (end > 0 && bytes[end - 1] == '\r') end--;
        return new String(bytes, 0, end, StandardCharsets.ISO_8859_1);
    }

    /** Copies exactly {@code length} bytes in COPY_CHUNK steps (nothing sized by the peer is allocated). */
    private static void copyExactly(InputStream in, ByteArrayOutputStream out, long length, Deadline deadline) throws IOException {
        byte[] chunk = new byte[(int) Math.min(length, COPY_CHUNK)];
        long remaining = length;
        while (remaining > 0) {
            deadline.check();
            int n = in.read(chunk, 0, (int) Math.min(remaining, chunk.length));
            if (n == -1) throw new IOException("truncated body");
            out.write(chunk, 0, n);
            remaining -= n;
        }
    }

    private static byte[] readToEnd(InputStream in, int maxBytes, Deadline deadline) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[COPY_CHUNK];
        long total = 0;
        int n;
        for (;;) {
            deadline.check();
            n = in.read(chunk);
            if (n == -1) break;
            total += n;
            if (total > maxBytes) throw new IOException("response too large");
            buffer.write(chunk, 0, n);
        }
        return buffer.toByteArray();
    }

    private static byte[] readChunked(InputStream in, int maxBytes, Deadline deadline) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        long total = 0;
        for (;;) {
            String sizeLine = readLine(in, MAX_LINE_BYTES, deadline);
            if (sizeLine == null) throw new IOException("truncated chunked body");
            int size = parseChunkSize(sizeLine);
            if (size == 0) {
                // trailers until the empty line: few, short, ignored
                int lines = 0;
                String trailer;
                while ((trailer = readLine(in, MAX_LINE_BYTES, deadline)) != null && !trailer.isEmpty()) {
                    if (++lines > MAX_TRAILER_LINES) throw new IOException("trailers too large");
                }
                return buffer.toByteArray();
            }
            // Compare before adding: `total + size` would wrap an int (1 + 0x7fffffff) and slip
            // past the cap; long arithmetic and the cap check happen before any byte is buffered.
            if (size > (long) maxBytes - total) throw new IOException("response too large");
            total += size;
            copyExactly(in, buffer, size, deadline);
            String crlf = readLine(in, 2, deadline);
            if (crlf == null || !crlf.isEmpty()) throw new IOException("bad chunk terminator");
        }
    }
}
