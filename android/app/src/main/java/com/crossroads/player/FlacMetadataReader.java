package com.crossroads.player;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads the metadata blocks of a FLAC stream: STREAMINFO (sample rate, bit depth, channels,
 * total samples, MD5 of the decoded audio), VORBIS_COMMENT (every tag, multi-valued) and
 * whether a PICTURE block is present. Picture bytes and all other blocks are skipped, never
 * loaded, so memory stays flat regardless of embedded artwork size.
 *
 * Pure Java (no Android classes) so it can be unit-tested on the JVM.
 */
public final class FlacMetadataReader {

    public static final class Result {
        public int sampleRate;
        public int channels;
        public int bitsPerSample;
        public long totalSamples;
        /** Lowercase hex MD5 of the unencoded audio, or null when the encoder left it zero. */
        public String md5;
        public boolean hasPicture;
        public String vendor;
        public final Map<String, List<String>> tags = Bytes.newTags();
        public int blocks;
    }

    static final int BLOCK_STREAMINFO = 0;
    static final int BLOCK_VORBIS_COMMENT = 4;
    static final int BLOCK_PICTURE = 6;
    static final int STREAMINFO_LENGTH = 34;

    /** Comment blocks larger than this (lyrics are a few KB; 16 MB is hostile) are skipped. */
    static final int MAX_VORBIS_COMMENT_BYTES = 16 * 1024 * 1024;
    static final int MAX_BLOCKS = 128;
    static final int MAX_COMMENTS = 4096;

    private FlacMetadataReader() {}

    /**
     * @param in stream positioned at the start of the file (a leading ID3v2 tag is tolerated).
     * @return the parsed metadata, or null when the stream is not FLAC.
     */
    public static Result read(InputStream in) throws IOException {
        return read(in, -1);
    }

    /**
     * @param fileLength size of the file, or -1 when unknown; no block larger than the file is
     *                   ever allocated.
     */
    public static Result read(InputStream in, long fileLength) throws IOException {
        int maxComment = fileLength > 0 ? (int) Math.min(MAX_VORBIS_COMMENT_BYTES, fileLength) : MAX_VORBIS_COMMENT_BYTES;
        byte[] head = Bytes.readUpTo(in, 4);
        if (head.length < 4) return null;
        if (Bytes.matches(head, 0, "ID3")) {
            // ID3v2 header is 10 bytes: we have 4, read the remaining 6 for flags + size.
            byte[] rest = Bytes.readUpTo(in, 6);
            if (rest.length < 6) return null;
            int size = ((rest[2] & 0x7F) << 21) | ((rest[3] & 0x7F) << 14) | ((rest[4] & 0x7F) << 7) | (rest[5] & 0x7F);
            boolean footer = (rest[1] & 0x10) != 0;
            if (!Bytes.skipFully(in, size + (footer ? 10 : 0))) return null;
            head = Bytes.readUpTo(in, 4);
            if (head.length < 4) return null;
        }
        if (!Bytes.matches(head, 0, "fLaC")) return null;

        Result result = new Result();
        boolean sawStreamInfo = false;
        while (result.blocks < MAX_BLOCKS) {
            byte[] header = Bytes.readUpTo(in, 4);
            if (header.length < 4) break;
            result.blocks++;
            boolean last = (header[0] & 0x80) != 0;
            int type = header[0] & 0x7F;
            int length = Bytes.u24be(header, 1);

            if (type == BLOCK_STREAMINFO && length == STREAMINFO_LENGTH && !sawStreamInfo) {
                parseStreamInfo(Bytes.readFully(in, length), result);
                sawStreamInfo = true;
            } else if (type == BLOCK_VORBIS_COMMENT && length <= maxComment) {
                parseVorbisComment(Bytes.readFully(in, length), result);
            } else {
                if (type == BLOCK_PICTURE) result.hasPicture = true;
                if (!Bytes.skipFully(in, length)) break;
            }
            if (last) break;
        }
        return sawStreamInfo ? result : null;
    }

    /** STREAMINFO layout (bits): 16 minBlock, 16 maxBlock, 24 minFrame, 24 maxFrame, 20 rate, 3 ch-1, 5 bps-1, 36 samples, 128 md5. */
    static void parseStreamInfo(byte[] b, Result r) {
        r.sampleRate = (int) ((Bytes.u32be(b, 10) >>> 12) & 0xFFFFF);
        r.channels = ((b[12] >> 1) & 0x07) + 1;
        r.bitsPerSample = (((b[12] & 0x01) << 4) | ((b[13] >> 4) & 0x0F)) + 1;
        r.totalSamples = ((long) (b[13] & 0x0F) << 32) | Bytes.u32be(b, 14);
        r.md5 = Bytes.allZero(b, 18, 16) ? null : Bytes.hex(b, 18, 16);
    }

    /** Vorbis comment: LE u32 vendor length, vendor, LE u32 count, then (LE u32 length, "KEY=value") x count. */
    static void parseVorbisComment(byte[] b, Result r) {
        int pos = 0;
        if (b.length < 8) return;
        long vendorLen = Bytes.u32le(b, pos);
        pos += 4;
        if (vendorLen < 0 || pos + vendorLen > b.length) return;
        r.vendor = Bytes.utf8(b, pos, (int) vendorLen);
        pos += (int) vendorLen;
        if (pos + 4 > b.length) return;
        long count = Bytes.u32le(b, pos);
        pos += 4;
        for (long i = 0; i < count && i < MAX_COMMENTS; i++) {
            if (pos + 4 > b.length) return;
            long len = Bytes.u32le(b, pos);
            pos += 4;
            if (len < 0 || pos + len > b.length) return;
            addComment(r, new String(b, pos, (int) len, StandardCharsets.UTF_8));
            pos += (int) len;
        }
    }

    static void addComment(Result r, String comment) {
        int eq = comment.indexOf('=');
        if (eq <= 0) return;
        String key = comment.substring(0, eq).trim().toUpperCase(Locale.ROOT);
        String value = comment.substring(eq + 1);
        if (key.equals("METADATA_BLOCK_PICTURE") || key.equals("COVERART")) {
            r.hasPicture = true;
            return;
        }
        if (key.equals("COVERARTMIME")) return;
        Bytes.addTag(r.tags, key, value);
    }
}
