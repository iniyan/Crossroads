package com.crossroads.player;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Byte-level helpers shared by the pure-Java metadata readers. */
final class Bytes {

    private Bytes() {}

    static final int MAX_SKIP_BUFFER = 8192;

    /** Reads exactly {@code len} bytes or throws EOFException. */
    static byte[] readFully(InputStream in, int len) throws IOException {
        byte[] buf = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) throw new EOFException("Unexpected end of stream");
            off += n;
        }
        return buf;
    }

    /** Reads up to {@code len} bytes; returns the bytes actually read (may be shorter at EOF). */
    static byte[] readUpTo(InputStream in, int len) throws IOException {
        byte[] buf = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) break;
            off += n;
        }
        if (off == len) return buf;
        byte[] out = new byte[off];
        System.arraycopy(buf, 0, out, 0, off);
        return out;
    }

    /** Skips exactly {@code n} bytes, reading through when the stream refuses to seek. Returns false at EOF. */
    static boolean skipFully(InputStream in, long n) throws IOException {
        byte[] scratch = null;
        while (n > 0) {
            long skipped = in.skip(n);
            if (skipped <= 0) {
                if (scratch == null) scratch = new byte[(int) Math.min(MAX_SKIP_BUFFER, n)];
                int read = in.read(scratch, 0, (int) Math.min(scratch.length, n));
                if (read < 0) return false;
                skipped = read;
            }
            n -= skipped;
        }
        return true;
    }

    static int u8(byte[] b, int off) {
        return b[off] & 0xFF;
    }

    static int u16be(byte[] b, int off) {
        return ((b[off] & 0xFF) << 8) | (b[off + 1] & 0xFF);
    }

    static int u24be(byte[] b, int off) {
        return ((b[off] & 0xFF) << 16) | ((b[off + 1] & 0xFF) << 8) | (b[off + 2] & 0xFF);
    }

    static long u32be(byte[] b, int off) {
        return ((long) (b[off] & 0xFF) << 24) | ((b[off + 1] & 0xFF) << 16) | ((b[off + 2] & 0xFF) << 8) | (b[off + 3] & 0xFF);
    }

    static long u64be(byte[] b, int off) {
        return (u32be(b, off) << 32) | u32be(b, off + 4);
    }

    static int u16le(byte[] b, int off) {
        return (b[off] & 0xFF) | ((b[off + 1] & 0xFF) << 8);
    }

    static long u32le(byte[] b, int off) {
        return (b[off] & 0xFF) | ((b[off + 1] & 0xFF) << 8) | ((b[off + 2] & 0xFF) << 16) | ((long) (b[off + 3] & 0xFF) << 24);
    }

    static long u64le(byte[] b, int off) {
        return u32le(b, off) | (u32le(b, off + 4) << 32);
    }

    /** ID3v2 "syncsafe" 28-bit integer. */
    static int syncsafe(byte[] b, int off) {
        return ((b[off] & 0x7F) << 21) | ((b[off + 1] & 0x7F) << 14) | ((b[off + 2] & 0x7F) << 7) | (b[off + 3] & 0x7F);
    }

    static String ascii(byte[] b, int off, int len) {
        return new String(b, off, len, StandardCharsets.ISO_8859_1);
    }

    static boolean matches(byte[] b, int off, String ascii) {
        if (off < 0 || off + ascii.length() > b.length) return false;
        for (int i = 0; i < ascii.length(); i++) {
            if ((b[off + i] & 0xFF) != ascii.charAt(i)) return false;
        }
        return true;
    }

    static String hex(byte[] b, int off, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        for (int i = off; i < off + len; i++) {
            sb.append(Character.forDigit((b[i] >> 4) & 0xF, 16)).append(Character.forDigit(b[i] & 0xF, 16));
        }
        return sb.toString();
    }

    static boolean allZero(byte[] b, int off, int len) {
        for (int i = off; i < off + len; i++) if (b[i] != 0) return false;
        return true;
    }

    /** Decodes {@code len} bytes as UTF-8, dropping trailing NULs. */
    static String utf8(byte[] b, int off, int len) {
        return trimNul(new String(b, off, len, StandardCharsets.UTF_8));
    }

    static String trimNul(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '\0') end--;
        return end == s.length() ? s : s.substring(0, end);
    }

    static String decode(byte[] b, int off, int len, Charset cs) {
        if (len <= 0) return "";
        return trimNul(new String(b, off, len, cs));
    }

    /** Adds a tag value to the UPPERCASE-keyed multi-map, ignoring blanks. */
    static void addTag(Map<String, List<String>> tags, String name, String value) {
        if (name == null || value == null) return;
        String key = name.trim().toUpperCase(Locale.ROOT);
        String val = trimNul(value).trim();
        if (key.isEmpty() || val.isEmpty()) return;
        List<String> list = tags.get(key);
        if (list == null) {
            list = new ArrayList<>(1);
            tags.put(key, list);
        }
        list.add(val);
    }

    static Map<String, List<String>> newTags() {
        return new LinkedHashMap<>();
    }
}
