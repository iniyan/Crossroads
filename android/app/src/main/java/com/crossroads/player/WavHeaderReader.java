package com.crossroads.player;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads the RIFF/WAVE (and RF64) header: the {@code fmt } chunk for sample rate, channels
 * and bit depth, the {@code data} chunk size for the total sample count, the LIST/INFO
 * chunk for tags and an embedded {@code id3 } chunk when present. Audio data is skipped.
 *
 * Pure Java (no Android classes) so it can be unit-tested on the JVM.
 */
public final class WavHeaderReader {

    public static final class Result {
        public int formatTag;          // 1 = PCM, 3 = IEEE float, 0xFFFE = extensible (resolved via sub-format)
        public int channels;
        public int sampleRate;
        public int bitsPerSample;
        public int blockAlign;
        public long dataBytes = -1;
        public long totalSamples = -1;
        public boolean isFloat;
        public boolean hasPicture;
        public final Map<String, List<String>> tags = Bytes.newTags();
    }

    static final int FORMAT_PCM = 1;
    static final int FORMAT_FLOAT = 3;
    static final int FORMAT_EXTENSIBLE = 0xFFFE;
    static final int MAX_CHUNKS = 64;
    static final int MAX_INFO_BYTES = 4 * 1024 * 1024;
    static final int MAX_ID3_BYTES = 16 * 1024 * 1024;

    private static final Map<String, String> INFO_NAMES = new HashMap<>();
    static {
        INFO_NAMES.put("INAM", "TITLE");
        INFO_NAMES.put("IART", "ARTIST");
        INFO_NAMES.put("IPRD", "ALBUM");
        INFO_NAMES.put("ICRD", "DATE");
        INFO_NAMES.put("IGNR", "GENRE");
        INFO_NAMES.put("ICMT", "COMMENT");
        INFO_NAMES.put("ITRK", "TRACKNUMBER");
        INFO_NAMES.put("IPRT", "TRACKNUMBER");
        INFO_NAMES.put("ICOP", "COPYRIGHT");
        INFO_NAMES.put("ISFT", "ENCODER");
        INFO_NAMES.put("IENG", "ENGINEER");
        INFO_NAMES.put("ICMS", "COMMISSIONED");
        INFO_NAMES.put("IKEY", "KEYWORDS");
        INFO_NAMES.put("ISBJ", "SUBJECT");
        INFO_NAMES.put("ITCH", "TECHNICIAN");
        INFO_NAMES.put("ISRC", "SOURCE");
        INFO_NAMES.put("IMED", "MEDIA");
        INFO_NAMES.put("ILNG", "LANGUAGE");
        INFO_NAMES.put("IWRI", "LYRICIST");
        INFO_NAMES.put("IMUS", "COMPOSER");
        INFO_NAMES.put("IPRO", "PRODUCER");
        INFO_NAMES.put("IALB", "ALBUM");
    }

    private WavHeaderReader() {}

    /**
     * @param in stream positioned at the start of the file.
     * @return the parsed header, or null when the stream is not RIFF/WAVE.
     */
    public static Result read(InputStream in) throws IOException {
        return read(in, -1);
    }

    /**
     * @param fileLength size of the file, or -1 when unknown. With it known, a data chunk
     *                   whose size is bogus (0xFFFFFFFF or 0 from a writer that never
     *                   finalised the header, or simply larger than the file) is clamped to
     *                   what the file actually holds, and no chunk larger than the file is
     *                   ever allocated.
     */
    public static Result read(InputStream in, long fileLength) throws IOException {
        byte[] riff = Bytes.readUpTo(in, 12);
        if (riff.length < 12) return null;
        boolean rf64 = Bytes.matches(riff, 0, "RF64");
        if (!rf64 && !Bytes.matches(riff, 0, "RIFF")) return null;
        if (!Bytes.matches(riff, 8, "WAVE")) return null;

        long maxInfo = fileLength > 0 ? Math.min(MAX_INFO_BYTES, fileLength) : MAX_INFO_BYTES;
        long maxId3 = fileLength > 0 ? Math.min(MAX_ID3_BYTES, fileLength) : MAX_ID3_BYTES;

        Result r = new Result();
        long ds64DataSize = -1;
        long ds64SampleCount = -1;
        boolean sawFmt = false;
        long pos = 12; // bytes consumed so far
        for (int chunks = 0; chunks < MAX_CHUNKS; chunks++) {
            byte[] header = Bytes.readUpTo(in, 8);
            if (header.length < 8) break;
            pos += 8;
            String id = Bytes.ascii(header, 0, 4);
            long size = Bytes.u32le(header, 4);
            long padded = size + (size & 1);

            if (id.equals("fmt ") && size >= 16 && size <= 4096) {
                parseFmt(Bytes.readFully(in, (int) size), r);
                sawFmt = true;
                if ((size & 1) != 0) Bytes.skipFully(in, 1);
                pos += padded;
            } else if (id.equals("ds64") && size >= 28 && size <= 4096) {
                byte[] b = Bytes.readFully(in, (int) size);
                ds64DataSize = Bytes.u64le(b, 8);
                ds64SampleCount = Bytes.u64le(b, 16);
                if ((size & 1) != 0) Bytes.skipFully(in, 1);
                pos += padded;
            } else if (id.equals("data")) {
                long dataBytes = (rf64 && size == 0xFFFFFFFFL && ds64DataSize >= 0) ? ds64DataSize : size;
                if (fileLength > 0) {
                    long remaining = Math.max(0, fileLength - pos);
                    // 0xFFFFFFFF / 0: the writer did not know the size; larger: header is wrong.
                    if (dataBytes == 0xFFFFFFFFL || dataBytes == 0 || dataBytes > remaining) dataBytes = remaining;
                }
                r.dataBytes = dataBytes;
                // Audio follows; INFO/id3 chunks may still trail it, so keep walking.
                long skip = dataBytes + (dataBytes & 1);
                if (!Bytes.skipFully(in, skip)) break;
                pos += skip;
            } else if (id.equals("LIST") && size >= 4 && size <= maxInfo) {
                byte[] b = Bytes.readFully(in, (int) size);
                if (Bytes.matches(b, 0, "INFO")) parseInfo(b, 4, r);
                if ((size & 1) != 0) Bytes.skipFully(in, 1);
                pos += padded;
            } else if ((id.equalsIgnoreCase("id3 ") || id.equalsIgnoreCase("ID3 ")) && size > 10 && size <= maxId3) {
                byte[] b = Bytes.readFully(in, (int) size);
                Id3v2Reader.Result id3 = Id3v2Reader.parse(b);
                if (id3 != null) {
                    for (Map.Entry<String, List<String>> e : id3.tags.entrySet()) {
                        for (String v : e.getValue()) Bytes.addTag(r.tags, e.getKey(), v);
                    }
                    if (id3.hasPicture) r.hasPicture = true;
                }
                if ((size & 1) != 0) Bytes.skipFully(in, 1);
                pos += padded;
            } else {
                if (!Bytes.skipFully(in, padded)) break;
                pos += padded;
            }
        }
        if (!sawFmt) return null;
        if (ds64SampleCount > 0) r.totalSamples = ds64SampleCount;
        else if (r.dataBytes >= 0 && r.blockAlign > 0) r.totalSamples = r.dataBytes / r.blockAlign;
        return r;
    }

    static void parseFmt(byte[] b, Result r) {
        r.formatTag = Bytes.u16le(b, 0);
        r.channels = Bytes.u16le(b, 2);
        r.sampleRate = (int) Bytes.u32le(b, 4);
        r.blockAlign = Bytes.u16le(b, 12);
        r.bitsPerSample = Bytes.u16le(b, 14);
        if (r.formatTag == FORMAT_EXTENSIBLE && b.length >= 40) {
            int validBits = Bytes.u16le(b, 18);
            if (validBits > 0 && validBits <= r.bitsPerSample) r.bitsPerSample = validBits;
            // Sub-format GUID: first two bytes hold the classic format tag.
            r.formatTag = Bytes.u16le(b, 24);
        }
        r.isFloat = r.formatTag == FORMAT_FLOAT;
    }

    static void parseInfo(byte[] b, int pos, Result r) {
        while (pos + 8 <= b.length) {
            String id = Bytes.ascii(b, pos, 4);
            long size = Bytes.u32le(b, pos + 4);
            pos += 8;
            if (size < 0 || pos + size > b.length) break;
            String value = Bytes.trimNul(new String(b, pos, (int) size, StandardCharsets.UTF_8));
            String name = INFO_NAMES.get(id);
            Bytes.addTag(r.tags, name != null ? name : id, value);
            pos += (int) (size + (size & 1));
        }
    }
}
