package com.crossroads.player;

import java.io.IOException;
import java.io.InputStream;

/**
 * Reads the first MPEG audio frame header (sample rate, channels, layer, frame bitrate) and
 * the Xing/Info or VBRI header that follows it (frame count -> total samples, byte count ->
 * average bitrate for VBR files). Only the first 64 KB after the ID3 tag are inspected.
 *
 * Pure Java (no Android classes) so it can be unit-tested on the JVM.
 */
public final class Mp3HeaderReader {

    public static final class Result {
        /** 1, 2 or 25 (MPEG 2.5). */
        public int version;
        public int layer;
        public int sampleRate;
        public int channels;
        /** Bitrate declared by the first frame, bits per second. */
        public int frameBitrate;
        /** Best-known average bitrate: Xing/VBRI derived when present, else the frame bitrate. */
        public int bitrate;
        public boolean vbr;
        public long totalSamples = -1;
        public int samplesPerFrame;
        public int frameLength;
        public String codec;
    }

    static final int SEARCH_BYTES = 64 * 1024;

    private static final int[][] BITRATES_V1 = {
        {0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448},   // layer 1
        {0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384},      // layer 2
        {0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320}        // layer 3
    };
    private static final int[][] BITRATES_V2 = {
        {0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256},      // layer 1
        {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160},           // layer 2
        {0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}            // layer 3
    };
    private static final int[] RATES_V1 = {44100, 48000, 32000};
    private static final int[] RATES_V2 = {22050, 24000, 16000};
    private static final int[] RATES_V25 = {11025, 12000, 8000};

    private Mp3HeaderReader() {}

    /**
     * @param in         stream positioned just after any ID3v2 tag.
     * @param audioBytes bytes of MPEG audio in the file (file size minus tags), or -1 when unknown;
     *                   used to estimate the sample count of CBR files without a Xing header.
     * @return the header data, or null when no MPEG frame was found in the first 64 KB.
     */
    public static Result read(InputStream in, long audioBytes) throws IOException {
        byte[] buf = Bytes.readUpTo(in, SEARCH_BYTES);
        return parse(buf, audioBytes);
    }

    static Result parse(byte[] buf, long audioBytes) {
        for (int i = 0; i + 4 <= buf.length; i++) {
            if ((buf[i] & 0xFF) != 0xFF || (buf[i + 1] & 0xE0) != 0xE0) continue;
            Result r = parseHeader(buf, i);
            if (r == null) continue;
            // Require the next frame to start with a sync word when it is inside the buffer.
            int next = i + r.frameLength;
            if (next + 1 < buf.length && !((buf[next] & 0xFF) == 0xFF && (buf[next + 1] & 0xE0) == 0xE0)) continue;
            readVbrHeaders(buf, i, r);
            if (r.totalSamples < 0 && audioBytes > 0 && r.frameLength > 0) {
                r.totalSamples = (audioBytes / r.frameLength) * r.samplesPerFrame;
            }
            return r;
        }
        return null;
    }

    /** Decodes the 4-byte frame header at {@code off}; null when it is not a valid audio frame. */
    static Result parseHeader(byte[] b, int off) {
        if (off + 4 > b.length) return null;
        int b1 = b[off + 1] & 0xFF;
        int b2 = b[off + 2] & 0xFF;
        int b3 = b[off + 3] & 0xFF;
        int versionBits = (b1 >> 3) & 0x03;   // 00 = 2.5, 01 = reserved, 10 = 2, 11 = 1
        int layerBits = (b1 >> 1) & 0x03;     // 00 = reserved, 01 = III, 10 = II, 11 = I
        int bitrateIdx = (b2 >> 4) & 0x0F;
        int rateIdx = (b2 >> 2) & 0x03;
        int padding = (b2 >> 1) & 0x01;
        int channelMode = (b3 >> 6) & 0x03;
        if (versionBits == 1 || layerBits == 0 || bitrateIdx == 0 || bitrateIdx == 15 || rateIdx == 3) return null;

        Result r = new Result();
        r.version = versionBits == 3 ? 1 : versionBits == 2 ? 2 : 25;
        r.layer = 4 - layerBits;
        int[] rates = r.version == 1 ? RATES_V1 : r.version == 2 ? RATES_V2 : RATES_V25;
        r.sampleRate = rates[rateIdx];
        int[][] table = r.version == 1 ? BITRATES_V1 : BITRATES_V2;
        r.frameBitrate = table[r.layer - 1][bitrateIdx] * 1000;
        r.bitrate = r.frameBitrate;
        r.channels = channelMode == 3 ? 1 : 2;
        if (r.layer == 1) r.samplesPerFrame = 384;
        else if (r.layer == 2) r.samplesPerFrame = 1152;
        else r.samplesPerFrame = r.version == 1 ? 1152 : 576;
        if (r.layer == 1) r.frameLength = (12 * r.frameBitrate / r.sampleRate + padding) * 4;
        else r.frameLength = (r.samplesPerFrame / 8) * r.frameBitrate / r.sampleRate + padding;
        r.codec = "MPEG " + (r.version == 25 ? "2.5" : String.valueOf(r.version)) + " Layer " + r.layer;
        if (r.frameLength <= 4) return null;
        return r;
    }

    private static void readVbrHeaders(byte[] b, int frame, Result r) {
        int sideInfo = r.version == 1 ? (r.channels == 1 ? 17 : 32) : (r.channels == 1 ? 9 : 17);
        int xing = frame + 4 + sideInfo;
        if (Bytes.matches(b, xing, "Xing") || Bytes.matches(b, xing, "Info")) {
            boolean isVbr = Bytes.matches(b, xing, "Xing");
            if (xing + 8 > b.length) return;
            long flags = Bytes.u32be(b, xing + 4);
            int pos = xing + 8;
            long frames = -1;
            long bytes = -1;
            if ((flags & 0x1) != 0 && pos + 4 <= b.length) { frames = Bytes.u32be(b, pos); pos += 4; }
            if ((flags & 0x2) != 0 && pos + 4 <= b.length) { bytes = Bytes.u32be(b, pos); pos += 4; }
            // The count includes the Xing/Info frame itself, which carries no audio.
            applyVbr(r, frames > 0 ? frames - 1 : frames, bytes, isVbr);
            return;
        }
        int vbri = frame + 4 + 32;
        if (Bytes.matches(b, vbri, "VBRI") && vbri + 26 <= b.length) {
            long bytes = Bytes.u32be(b, vbri + 10);
            long frames = Bytes.u32be(b, vbri + 14);
            applyVbr(r, frames, bytes, true);
        }
    }

    private static void applyVbr(Result r, long frames, long bytes, boolean isVbr) {
        if (frames > 0) {
            r.totalSamples = frames * r.samplesPerFrame;
            // Only VBR needs the average; an "Info" (CBR) header's frame bitrate is exact.
            if (isVbr && bytes > 0 && r.sampleRate > 0) {
                double seconds = (double) r.totalSamples / r.sampleRate;
                r.bitrate = (int) Math.round(bytes * 8 / seconds);
            }
        }
        r.vbr = isVbr;
    }
}
