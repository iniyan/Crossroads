package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

/**
 * JVM tests for the raw-socket HTTP client against a tiny ServerSocket-based HTTP server
 * (java.net only: the JDK's com.sun.net.httpserver is not on the Android unit-test classpath).
 */
public class LanHttpClientTest {

    private ServerSocket server;
    private Thread serverThread;
    private int port;
    private volatile boolean running;
    private final AtomicReference<String> seenMethod = new AtomicReference<>();
    private final AtomicReference<String> seenBody = new AtomicReference<>();
    private final AtomicReference<String> seenHost = new AtomicReference<>();
    private final AtomicReference<String> seenContentType = new AtomicReference<>();
    private final AtomicReference<String> seenPath = new AtomicReference<>();

    @Before
    public void start() throws IOException {
        server = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1"));
        port = server.getLocalPort();
        running = true;
        serverThread = new Thread(() -> {
            while (running) {
                try (Socket s = server.accept()) {
                    serve(s);
                } catch (IOException e) {
                    if (running) e.printStackTrace();
                }
            }
        });
        serverThread.setDaemon(true);
        serverThread.start();
    }

    @After
    public void stop() throws IOException {
        running = false;
        server.close();
    }

    private void serve(Socket s) throws IOException {
        InputStream in = s.getInputStream();
        String requestLine = LanHttpClient.readLine(in, 8192);
        if (requestLine == null) return;
        String[] parts = requestLine.split(" ");
        String method = parts[0];
        String target = parts.length > 1 ? parts[1] : "/";
        Map<String, String> headers = new HashMap<>();
        String line;
        while ((line = LanHttpClient.readLine(in, 8192)) != null && !line.isEmpty()) {
            int colon = line.indexOf(':');
            if (colon > 0) headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
        }
        int length = headers.containsKey("content-length") ? Integer.parseInt(headers.get("content-length")) : 0;
        byte[] body = new byte[length];
        int offset = 0;
        while (offset < length) {
            int n = in.read(body, offset, length - offset);
            if (n == -1) break;
            offset += n;
        }
        seenMethod.set(method);
        seenHost.set(headers.get("host"));
        seenContentType.set(headers.get("content-type"));
        seenPath.set(target);
        seenBody.set(new String(body, StandardCharsets.UTF_8));

        OutputStream out = s.getOutputStream();
        String path = target.contains("?") ? target.substring(0, target.indexOf('?')) : target;
        switch (path) {
            case "/v1/echo": {
                byte[] res = ("{\"ok\":true,\"path\":\"" + target + "\"}").getBytes(StandardCharsets.UTF_8);
                write(out, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + res.length + "\r\nConnection: close\r\n\r\n", res);
                break;
            }
            case "/v1/chunked":
                write(out, "HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\npart0\r\n5\r\npart1\r\n5\r\npart2\r\n0\r\n\r\n", new byte[0]);
                break;
            case "/v1/error": {
                byte[] res = "{\"error\":\"closed\"}".getBytes(StandardCharsets.UTF_8);
                write(out, "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: " + res.length + "\r\nConnection: close\r\n\r\n", res);
                break;
            }
            case "/v1/empty":
                write(out, "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", new byte[0]);
                break;
            case "/v1/redirect":
                write(out, "HTTP/1.1 302 Found\r\nLocation: http://8.8.8.8/evil\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", new byte[0]);
                break;
            case "/v1/big": {
                byte[] res = new byte[200_000];
                write(out, "HTTP/1.1 200 OK\r\nContent-Length: " + res.length + "\r\nConnection: close\r\n\r\n", res);
                break;
            }
            case "/v1/eof":
                write(out, "HTTP/1.1 503 Busy\r\nConnection: close\r\n\r\n", new byte[0]);
                break;
            case "/v1/slow":
                try { Thread.sleep(3000); } catch (InterruptedException ignored) { /* teardown */ }
                write(out, "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", new byte[0]);
                break;
            case "/v1/drip": {
                // one byte every 300 ms: never trips the per-read timeout, only the deadline can end it
                byte[] res = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".getBytes(StandardCharsets.ISO_8859_1);
                try {
                    for (byte b : res) { out.write(b); out.flush(); Thread.sleep(300); }
                } catch (InterruptedException | IOException ignored) { /* client gave up */ }
                break;
            }
            default:
                write(out, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", new byte[0]);
        }
        out.flush();
    }

    private static void write(OutputStream out, String head, byte[] body) throws IOException {
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
    }

    @Test
    public void postsJsonWithHostAndContentTypeAndReadsContentLengthBody() throws IOException {
        LanHttpClient.Response r = LanHttpClient.request("127.0.0.1", port, "POST", "/v1/echo?session=abc", "{\"a\":1}", 5000, 1 << 20);
        assertEquals(200, r.status);
        assertEquals("{\"ok\":true,\"path\":\"/v1/echo?session=abc\"}", r.body);
        assertEquals("POST", seenMethod.get());
        assertEquals("{\"a\":1}", seenBody.get());
        assertEquals("127.0.0.1:" + port, seenHost.get());
        assertEquals("application/json; charset=utf-8", seenContentType.get());
    }

    @Test
    public void getsWithoutBodyAndReadsChunkedResponses() throws IOException {
        LanHttpClient.Response r = LanHttpClient.request("127.0.0.1", port, "GET", "/v1/chunked", "ignored", 5000, 1 << 20);
        assertEquals(201, r.status);
        assertEquals("part0part1part2", r.body);
        assertEquals("GET", seenMethod.get());
        assertEquals("", seenBody.get());
    }

    @Test
    public void returnsErrorStatusesWithTheirBodiesAndDoesNotFollowRedirects() throws IOException {
        LanHttpClient.Response err = LanHttpClient.request("127.0.0.1", port, "POST", "/v1/error", "{}", 5000, 1 << 20);
        assertEquals(403, err.status);
        assertEquals("{\"error\":\"closed\"}", err.body);
        LanHttpClient.Response empty = LanHttpClient.request("127.0.0.1", port, "POST", "/v1/empty", "{}", 5000, 1 << 20);
        assertEquals(401, empty.status);
        assertEquals("", empty.body);
        LanHttpClient.Response redirect = LanHttpClient.request("127.0.0.1", port, "GET", "/v1/redirect", null, 5000, 1 << 20);
        assertEquals(302, redirect.status);
        assertEquals("/v1/redirect", seenPath.get());   // the Location was never fetched
        LanHttpClient.Response eof = LanHttpClient.request("127.0.0.1", port, "GET", "/v1/eof", null, 5000, 1 << 20);
        assertEquals(503, eof.status);                  // no Content-Length: read to end of stream
        assertEquals("", eof.body);
    }

    @Test
    public void capsResponseSizeAndTimesOut() throws IOException {
        try {
            LanHttpClient.request("127.0.0.1", port, "GET", "/v1/big", null, 5000, 100_000);
            fail("expected too large");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("too large"));
        }
        assertEquals(200_000, LanHttpClient.request("127.0.0.1", port, "GET", "/v1/big", null, 5000, 1 << 20).body.length());
        long t0 = System.currentTimeMillis();
        try {
            LanHttpClient.request("127.0.0.1", port, "GET", "/v1/slow", null, 500, 1 << 20);
            fail("expected timeout");
        } catch (SocketTimeoutException e) {
            assertTrue(System.currentTimeMillis() - t0 < 2500);
        }
    }

    @Test
    public void refusesNamesBadMethodsAndBadPaths() {
        for (String[] bad : new String[][] {
            { "localhost", "GET", "/v1/info" },
            { "desktop.local", "GET", "/v1/info" },
            { "127.0.0.1", "PUT", "/v1/info" },
            { "127.0.0.1", "GET", "v1/info" },
            { "127.0.0.1", "GET", "/v1/info HTTP/1.1\r\nX: y" },
            { "127.0.0.1", "GET", "/v1/infé" }
        }) {
            try {
                LanHttpClient.request(bad[0], port, bad[1], bad[2], null, 1000, 1024);
                fail("accepted " + String.join(" ", bad));
            } catch (IOException expected) {
                assertNotNull(expected.getMessage());
            }
        }
        assertFalse(LanHttpClient.isValidPath("/with space"));
        assertTrue(LanHttpClient.isValidPath("/v1/pair/status?session=ab-12"));
    }

    @Test
    public void formatsIpv6HostHeaderAndParsesStatusLines() throws IOException {
        assertEquals("[fd00::5]:9000", LanHttpClient.hostHeader("fd00::5", 9000));
        assertEquals("10.0.2.2:51234", LanHttpClient.hostHeader("10.0.2.2", 51234));
        assertEquals(404, LanHttpClient.parseStatus("HTTP/1.1 404 Not Found"));
        assertEquals(200, LanHttpClient.parseStatus("HTTP/1.0 200"));
        for (String bad : new String[] { "HTTP/2 200 OK", "HTTP/1.1 abc", "HTTP/1.1 20 OK", "hello" }) {
            try { LanHttpClient.parseStatus(bad); fail(bad); } catch (IOException expected) { /* ok */ }
        }
    }

    @Test
    public void parsesRawResponsesWithAndWithoutLengthAndRejectsOversizedHeaders() throws IOException {
        String raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"eof\":1}";
        LanHttpClient.Response r = LanHttpClient.readResponse(new ByteArrayInputStream(raw.getBytes(StandardCharsets.ISO_8859_1)), 1024);
        assertEquals(200, r.status);
        assertEquals("{\"eof\":1}", r.body);
        String chunked = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
        assertEquals("Wikipedia", LanHttpClient.readResponse(new ByteArrayInputStream(chunked.getBytes(StandardCharsets.ISO_8859_1)), 1024).body);
        String tooLong = "HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n";
        try {
            LanHttpClient.readResponse(new ByteArrayInputStream(tooLong.getBytes(StandardCharsets.ISO_8859_1)), 1024);
            fail("expected too large");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("too large"));
        }
        StringBuilder huge = new StringBuilder("HTTP/1.1 200 OK\r\n");
        StringBuilder value = new StringBuilder();
        for (int i = 0; i < 300; i++) value.append('v');
        for (int i = 0; i < 200; i++) huge.append("X-H").append(i).append(": ").append(value).append("\r\n");
        huge.append("\r\n");
        try {
            LanHttpClient.readResponse(new ByteArrayInputStream(huge.toString().getBytes(StandardCharsets.ISO_8859_1)), 1024);
            fail("expected headers too large");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("headers too large"));
        }
        ByteArrayOutputStream chunkedBomb = new ByteArrayOutputStream();
        chunkedBomb.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n800\r\n".getBytes(StandardCharsets.ISO_8859_1));
        chunkedBomb.write(new byte[0x800]);
        chunkedBomb.write("\r\n800\r\n".getBytes(StandardCharsets.ISO_8859_1));
        chunkedBomb.write(new byte[0x800]);
        chunkedBomb.write("\r\n0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
        try {
            LanHttpClient.readResponse(new ByteArrayInputStream(chunkedBomb.toByteArray()), 3000);
            fail("expected chunked too large");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("too large"));
        }
    }

    private static IOException readFails(String raw, int maxBytes) {
        try {
            LanHttpClient.readResponse(new ByteArrayInputStream(raw.getBytes(StandardCharsets.ISO_8859_1)), maxBytes);
            fail("accepted: " + raw.replace("\r\n", "|"));
            return null;
        } catch (IOException e) {
            return e;
        }
    }

    @Test
    public void chunkTotalCannotOverflowPastTheCap() {
        // 1-byte chunk then 0x7fffffff: `total += size` used to wrap negative and pass the cap, then allocate 2 GB
        IOException e = readFails("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n7fffffff\r\n", 8 * 1024 * 1024);
        assertTrue(e.getMessage(), e.getMessage().contains("too large"));
        // a single chunk exactly one over the cap, and one at the cap but truncated (no up-front allocation of the cap)
        assertTrue(readFails("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n800001\r\n", 0x800000).getMessage().contains("too large"));
        assertTrue(readFails("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n800000\r\nabc", 0x800000).getMessage().contains("truncated"));
        // Content-Length at the cap but truncated: same
        assertTrue(readFails("HTTP/1.1 200 OK\r\nContent-Length: 8388608\r\n\r\nshort", 8 * 1024 * 1024).getMessage().contains("truncated"));
        // chunks summing to exactly the cap are fine
        StringBuilder exact = new StringBuilder("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
        for (int i = 0; i < 4; i++) { exact.append("4\r\nabcd\r\n"); }
        exact.append("0\r\n\r\n");
        try {
            assertEquals(16, LanHttpClient.readResponse(new ByteArrayInputStream(exact.toString().getBytes(StandardCharsets.ISO_8859_1)), 16).body.length());
        } catch (IOException unexpected) {
            fail(unexpected.getMessage());
        }
    }

    @Test
    public void rejectsSignedPrefixedAndOversizedSizes() throws IOException {
        for (String size : new String[] { "+5", "-5", "0x5", " 5 ", "5 5", "", ";", "100000000", "80000000", "ffffffff", "g" }) {
            String raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + size + "\r\nhello\r\n0\r\n\r\n";
            IOException e = readFails(raw, 1024);
            assertTrue(size + " -> " + e.getMessage(), e.getMessage().contains("bad chunk size") || e.getMessage().contains("too large"));
        }
        assertEquals(5, LanHttpClient.parseChunkSize("5"));
        assertEquals(5, LanHttpClient.parseChunkSize("5;ext=1"));
        assertEquals(0x7fffffff, LanHttpClient.parseChunkSize("7FFFFFFF"));
        for (String length : new String[] { "+5", "-1", "5 5", "0x5", "", "1e3", "9999999999999999" }) {
            IOException e = readFails("HTTP/1.1 200 OK\r\nContent-Length: " + length + "\r\n\r\nhello", 1024);
            assertTrue(length + " -> " + e.getMessage(), e.getMessage().contains("bad content-length"));
        }
        assertEquals(0, LanHttpClient.parseContentLength(" 0 "));
        assertEquals(123456789012345L, LanHttpClient.parseContentLength("123456789012345"));
    }

    @Test
    public void capsTrailerLinesAndChunkExtensionLines() throws IOException {
        StringBuilder trailers = new StringBuilder("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n");
        for (int i = 0; i < 200_000; i++) trailers.append("x: y\r\n");
        trailers.append("\r\n");
        assertTrue(readFails(trailers.toString(), 1024).getMessage().contains("trailers too large"));
        StringBuilder few = new StringBuilder("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n");
        for (int i = 0; i < 10; i++) few.append("x: y\r\n");
        few.append("\r\n");
        assertEquals("abc", LanHttpClient.readResponse(new ByteArrayInputStream(few.toString().getBytes(StandardCharsets.ISO_8859_1)), 1024).body);
        StringBuilder ext = new StringBuilder("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;");
        for (int i = 0; i < 9000; i++) ext.append('a');
        ext.append("\r\nhello\r\n0\r\n\r\n");
        assertTrue(readFails(ext.toString(), 1024).getMessage().contains("line too long"));
        // header count cap (lines, not just bytes)
        StringBuilder many = new StringBuilder("HTTP/1.1 200 OK\r\n");
        for (int i = 0; i < 101; i++) many.append("h").append(i).append(": v\r\n");
        many.append("\r\n");
        assertTrue(readFails(many.toString(), 1024).getMessage().contains("headers too large"));
    }

    @Test
    public void wholeRequestHasAWallClockDeadline() throws IOException {
        // parsing from memory: a deadline that already passed ends the read at once
        LanHttpClient.Deadline passed = new LanHttpClient.Deadline(System.nanoTime() - 1);
        try {
            LanHttpClient.readResponse(new ByteArrayInputStream("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1)), 1024, passed);
            fail("expected deadline");
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("deadline"));
        }
        assertEquals(4500, LanHttpClient.deadlineMs(1500));
        // over the wire: a server dripping one byte per 300 ms never trips the 1500 ms read
        // timeout; without the deadline the 39-byte reply would take ~12 s and succeed
        long t0 = System.currentTimeMillis();
        try {
            LanHttpClient.request("127.0.0.1", port, "GET", "/v1/drip", null, 1500, 1 << 20);
            fail("expected the deadline to end the request");
        } catch (IOException e) {
            long took = System.currentTimeMillis() - t0;
            assertTrue(e.getMessage(), e.getMessage().contains("deadline"));
            assertTrue("took " + took + " ms", took >= 4000 && took < 8000);
        }
    }
}
