package com.crossroads.player;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

/** Little builder for synthetic binary fixtures. */
final class TestBytes {

    private final ByteArrayOutputStream out = new ByteArrayOutputStream();

    static TestBytes builder() {
        return new TestBytes();
    }

    TestBytes bytes(byte[] b) {
        out.write(b, 0, b.length);
        return this;
    }

    TestBytes bytes(int... values) {
        for (int v : values) out.write(v);
        return this;
    }

    TestBytes ascii(String s) {
        return bytes(s.getBytes(StandardCharsets.ISO_8859_1));
    }

    TestBytes utf8(String s) {
        return bytes(s.getBytes(StandardCharsets.UTF_8));
    }

    TestBytes u8(int v) {
        out.write(v & 0xFF);
        return this;
    }

    TestBytes u16be(int v) {
        return bytes((v >> 8) & 0xFF, v & 0xFF);
    }

    TestBytes u24be(int v) {
        return bytes((v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
    }

    TestBytes u32be(long v) {
        return bytes((int) (v >> 24) & 0xFF, (int) (v >> 16) & 0xFF, (int) (v >> 8) & 0xFF, (int) v & 0xFF);
    }

    TestBytes u64be(long v) {
        return u32be(v >>> 32).u32be(v & 0xFFFFFFFFL);
    }

    TestBytes u16le(int v) {
        return bytes(v & 0xFF, (v >> 8) & 0xFF);
    }

    TestBytes u32le(long v) {
        return bytes((int) v & 0xFF, (int) (v >> 8) & 0xFF, (int) (v >> 16) & 0xFF, (int) (v >> 24) & 0xFF);
    }

    TestBytes u64le(long v) {
        return u32le(v & 0xFFFFFFFFL).u32le(v >>> 32);
    }

    TestBytes syncsafe(int v) {
        return bytes((v >> 21) & 0x7F, (v >> 14) & 0x7F, (v >> 7) & 0x7F, v & 0x7F);
    }

    TestBytes zeros(int n) {
        for (int i = 0; i < n; i++) out.write(0);
        return this;
    }

    TestBytes fill(int n, int value) {
        for (int i = 0; i < n; i++) out.write(value);
        return this;
    }

    int size() {
        return out.size();
    }

    byte[] build() {
        return out.toByteArray();
    }
}
