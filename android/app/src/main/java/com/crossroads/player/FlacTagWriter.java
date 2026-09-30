package com.crossroads.player;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Pure-Java twin of electron/flacTagWriter.js: plans the replacement of a FLAC file's
 * VORBIS_COMMENT block without touching the audio frames. Both implementations produce
 * byte-identical output for the same input and operations (see the shared vectors in
 * src/test/resources/flac-vectors.txt); the rules are documented at the top of the JS file.
 *
 * This class does no file I/O of its own: it turns the metadata region into a {@link Plan}
 * and verifies a written file. {@code SafTagWriter} does the Storage Access Framework part.
 */
public final class FlacTagWriter {

    public static final int DEFAULT_PADDING = 8192;
    public static final String DEFAULT_VENDOR = "Crossroads";

    static final int BLOCK_STREAMINFO = 0;
    static final int BLOCK_PADDING = 1;
    static final int BLOCK_VORBIS_COMMENT = 4;
    static final int STREAMINFO_LENGTH = 34;
    static final int MAX_BLOCK_LENGTH = 0xFFFFFF;
    static final int MAX_BLOCKS = 128;
    /** Metadata regions bigger than this are refused (pictures of a few MB are normal; 64 MB is not). */
    static final long MAX_METADATA_BYTES = 64L * 1024 * 1024;

    private static final byte[] MARKER = "fLaC".getBytes(StandardCharsets.ISO_8859_1);

    private FlacTagWriter() {}

    /** A problem with the file or the requested tags; the message is user-facing. */
    public static final class FlacTagException extends IOException {
        public final String code;

        public FlacTagException(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    /** Tag operations: {@code set} replaces every value of a key (empty list removes it), {@code remove} drops keys. */
    public static final class Ops {
        public final Map<String, List<String>> set = new LinkedHashMap<>();
        public final List<String> remove = new ArrayList<>();

        public Ops set(String key, String... values) {
            set.put(key, new ArrayList<>(Arrays.asList(values)));
            return this;
        }

        public Ops remove(String... keys) {
            remove.addAll(Arrays.asList(keys));
            return this;
        }
    }

    static final class Block {
        final int type;
        final boolean last;
        final int offset;
        final int length;

        Block(int type, boolean last, int offset, int length) {
            this.type = type;
            this.last = last;
            this.offset = offset;
            this.length = length;
        }
    }

    static final class Parsed {
        int prefixLength;
        int metaStart;
        int audioOffset;
        final List<Block> blocks = new ArrayList<>();
    }

    /** One comment key as first spelled in the file, with all of its values. */
    static final class Entry {
        final String key;
        final List<String> values;

        Entry(String key, List<String> values) {
            this.key = key;
            this.values = values;
        }
    }

    /** The result of {@link #plan}. */
    public static final class Plan {
        /** True when the new metadata region has exactly the old length and can overwrite it. */
        public boolean inPlace;
        /** True when the new region equals the old one byte for byte (nothing to write). */
        public boolean unchanged;
        /** The complete new metadata region (all block headers and bodies). */
        public byte[] metadata;
        /** Bytes before the metadata region (ID3v2 prefix, if any, plus "fLaC"). */
        public byte[] prefix;
        /** Offset of the metadata region in the file (= prefix.length). */
        public int metaStart;
        /** Offset of the first audio frame in the original file. */
        public int audioOffset;
        /** STREAMINFO body of the original file. */
        public byte[] streamInfo;
        /** The tags the file will carry, upper-cased keys. */
        public Map<String, List<String>> tags;
        public String vendor;
    }

    // --- parsing ---------------------------------------------------------------------------

    static int id3v2Length(byte[] buf) {
        if (buf.length < 10 || buf[0] != 'I' || buf[1] != 'D' || buf[2] != '3') return 0;
        int size = ((buf[6] & 0x7F) << 21) | ((buf[7] & 0x7F) << 14) | ((buf[8] & 0x7F) << 7) | (buf[9] & 0x7F);
        return 10 + size + ((buf[5] & 0x10) != 0 ? 10 : 0);
    }

    static Parsed parseMetadata(byte[] buf) throws FlacTagException {
        Parsed p = new Parsed();
        p.prefixLength = id3v2Length(buf);
        if (buf.length < p.prefixLength + 4 || !Bytes.matches(buf, p.prefixLength, "fLaC")) {
            throw new FlacTagException("Not a FLAC file", "NOT_FLAC");
        }
        p.metaStart = p.prefixLength + 4;
        int pos = p.metaStart;
        while (true) {
            if (p.blocks.size() >= MAX_BLOCKS) throw new FlacTagException("Too many metadata blocks", "CORRUPT");
            if (pos + 4 > buf.length) throw new FlacTagException("Truncated metadata block header", "TRUNCATED");
            boolean last = (buf[pos] & 0x80) != 0;
            int type = buf[pos] & 0x7F;
            int length = Bytes.u24be(buf, pos + 1);
            if (type == 127) throw new FlacTagException("Invalid metadata block type", "CORRUPT");
            if (pos + 4 + length > buf.length) throw new FlacTagException("Truncated metadata block", "TRUNCATED");
            p.blocks.add(new Block(type, last, pos + 4, length));
            pos += 4 + length;
            if (last) break;
        }
        Block first = p.blocks.get(0);
        if (first.type != BLOCK_STREAMINFO || first.length != STREAMINFO_LENGTH) {
            throw new FlacTagException("First metadata block is not STREAMINFO", "CORRUPT");
        }
        p.audioOffset = pos;
        return p;
    }

    /**
     * Reads the metadata region (file start .. first audio frame) from a stream positioned at
     * the start of the file. Nothing past the region is consumed beyond what the block headers
     * require, so the caller can go on hashing the audio from the same stream.
     */
    public static byte[] readHead(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
        byte[] probe = Bytes.readUpTo(in, 10);
        out.write(probe, 0, probe.length);
        int prefix = id3v2Length(probe);
        if (prefix > 0) {
            if (prefix - 10 > MAX_METADATA_BYTES) throw new FlacTagException("Metadata region too large", "TOO_LARGE");
            out.write(Bytes.readFully(in, prefix - 10));
            byte[] marker = Bytes.readFully(in, 4);
            if (!Bytes.matches(marker, 0, "fLaC")) throw new FlacTagException("Not a FLAC file", "NOT_FLAC");
            out.write(marker);
        } else if (probe.length < 4 || !Bytes.matches(probe, 0, "fLaC")) {
            throw new FlacTagException("Not a FLAC file", "NOT_FLAC");
        }
        // `out` now holds prefix + marker + (without prefix) 6 bytes of the first block.
        int have = out.size() - (prefix + 4);
        byte[] pending = have > 0 ? Arrays.copyOfRange(out.toByteArray(), prefix + 4, out.size()) : new byte[0];
        ByteArrayOutputStream meta = new ByteArrayOutputStream(64 * 1024);
        meta.write(pending, 0, pending.length);
        int consumed = 0;  // bytes of `meta` already walked
        for (int n = 0; ; n++) {
            if (n >= MAX_BLOCKS) throw new FlacTagException("Too many metadata blocks", "CORRUPT");
            while (meta.size() < consumed + 4) {
                byte[] more = Bytes.readUpTo(in, consumed + 4 - meta.size());
                if (more.length == 0) throw new FlacTagException("Truncated metadata block header", "TRUNCATED");
                meta.write(more, 0, more.length);
            }
            byte[] cur = meta.toByteArray();
            int length = Bytes.u24be(cur, consumed + 1);
            boolean last = (cur[consumed] & 0x80) != 0;
            long end = (long) consumed + 4 + length;
            if (end + prefix + 4 > MAX_METADATA_BYTES) throw new FlacTagException("Metadata region too large", "TOO_LARGE");
            while (meta.size() < end) {
                byte[] more = Bytes.readUpTo(in, (int) (end - meta.size()));
                if (more.length == 0) throw new FlacTagException("Truncated metadata block", "TRUNCATED");
                meta.write(more, 0, more.length);
            }
            consumed = (int) end;
            if (last) break;
        }
        byte[] head = new byte[prefix + 4 + consumed];
        byte[] headStart = out.toByteArray();
        System.arraycopy(headStart, 0, head, 0, prefix + 4);
        System.arraycopy(meta.toByteArray(), 0, head, prefix + 4, consumed);
        return head;
    }

    /** Decodes a VORBIS_COMMENT body: vendor plus the (key, value) pairs in file order (entries without a "KEY=" part are skipped). */
    static String parseVorbisComment(byte[] b, int off, int len, List<String[]> comments) throws FlacTagException {
        return parseVorbisComment(b, off, len, comments, null);
    }

    /**
     * Decodes a VORBIS_COMMENT body: vendor plus the (key, value) pairs in file order. Entries
     * with no "KEY=" part (no '=' or an empty key) are not editable; when {@code raw} is given
     * they are collected there byte for byte so the writer can keep them, as libFLAC does.
     */
    static String parseVorbisComment(byte[] b, int off, int len, List<String[]> comments, List<byte[]> raw) throws FlacTagException {
        if (len < 8) throw new FlacTagException("Corrupt VORBIS_COMMENT block", "CORRUPT");
        int pos = off;
        int end = off + len;
        long vendorLen = Bytes.u32le(b, pos);
        pos += 4;
        if (vendorLen < 0 || pos + vendorLen > end) throw new FlacTagException("Corrupt VORBIS_COMMENT vendor", "CORRUPT");
        String vendor = new String(b, pos, (int) vendorLen, StandardCharsets.UTF_8);
        pos += (int) vendorLen;
        if (pos + 4 > end) throw new FlacTagException("Corrupt VORBIS_COMMENT count", "CORRUPT");
        long count = Bytes.u32le(b, pos);
        pos += 4;
        for (long i = 0; i < count; i++) {
            if (pos + 4 > end) throw new FlacTagException("Corrupt VORBIS_COMMENT entry", "CORRUPT");
            long l = Bytes.u32le(b, pos);
            pos += 4;
            if (l < 0 || pos + l > end) throw new FlacTagException("Corrupt VORBIS_COMMENT entry", "CORRUPT");
            int eq = -1;
            for (int j = 0; j < (int) l; j++) if (b[pos + j] == '=') { eq = j; break; }
            if (eq <= 0) {
                if (raw != null) raw.add(Arrays.copyOfRange(b, pos, pos + (int) l));
            } else {
                comments.add(new String[] {
                    new String(b, pos, eq, StandardCharsets.UTF_8),
                    new String(b, pos + eq + 1, (int) l - eq - 1, StandardCharsets.UTF_8)
                });
            }
            pos += (int) l;
        }
        return vendor;
    }

    /** Groups by folded key (trimmed, upper-cased), first-seen order, keeping the first spelling. */
    static LinkedHashMap<String, Entry> group(List<String[]> comments) {
        LinkedHashMap<String, Entry> map = new LinkedHashMap<>();
        for (String[] c : comments) {
            String upper = foldKey(c[0]);
            Entry e = map.get(upper);
            if (e == null) {
                e = new Entry(c[0], new ArrayList<>());
                map.put(upper, e);
            }
            e.values.add(c[1]);
        }
        return map;
    }

    static Map<String, List<String>> tagsObject(Map<String, Entry> grouped) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        for (Map.Entry<String, Entry> e : grouped.entrySet()) out.put(e.getKey(), new ArrayList<>(e.getValue().values));
        return out;
    }

    /**
     * The characters JS String.prototype.trim() strips (ECMAScript WhiteSpace + LineTerminator),
     * spelled out so both writers agree on what "blank" means. Note that Java's own
     * Character.isWhitespace() differs (it includes U+001C..U+001F and excludes NBSP).
     */
    static boolean isJsSpace(char c) {
        switch (c) {
            case 0x09: case 0x0A: case 0x0B: case 0x0C: case 0x0D: case 0x20: case 0xA0: case 0x1680:
            case 0x2000: case 0x2001: case 0x2002: case 0x2003: case 0x2004: case 0x2005: case 0x2006:
            case 0x2007: case 0x2008: case 0x2009: case 0x200A:
            case 0x2028: case 0x2029: case 0x202F: case 0x205F: case 0x3000: case 0xFEFF:
                return true;
            default:
                return false;
        }
    }

    /** True when every character is in the JS whitespace set (the empty string is blank). */
    static boolean isBlank(String s) {
        for (int i = 0; i < s.length(); i++) if (!isJsSpace(s.charAt(i))) return false;
        return true;
    }

    /** JS String.prototype.trim() over the explicit whitespace set. */
    static String jsTrim(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && isJsSpace(s.charAt(start))) start++;
        while (end > start && isJsSpace(s.charAt(end - 1))) end--;
        return s.substring(start, end);
    }

    /** The grouping key of a comment name: trimmed and upper-cased, as the renderer folds it. */
    static String foldKey(String key) {
        return jsTrim(key == null ? "" : key).toUpperCase(Locale.ROOT);
    }

    /** True for a legal NEW comment name: printable ASCII 0x20..0x7D without '='. */
    static boolean isLegalKey(String upper) {
        for (int i = 0; i < upper.length(); i++) {
            char c = upper.charAt(i);
            if (c < 0x20 || c > 0x7D || c == '=') return false;
        }
        return true;
    }

    /** The folded key of an operation; empty names are rejected. */
    static String normalizeKey(String key) throws FlacTagException {
        String upper = foldKey(key);
        if (upper.isEmpty()) throw new FlacTagException("Empty tag name", "INVALID_TAG");
        return upper;
    }

    static List<String> normalizeValues(String key, List<String> raw) throws FlacTagException {
        List<String> out = new ArrayList<>();
        if (raw == null) return out;
        for (String v : raw) {
            if (v == null) continue;
            if (isBlank(v)) continue;
            if (v.indexOf('\0') >= 0) throw new FlacTagException("Invalid value for " + key, "INVALID_TAG");
            out.add(v);
        }
        return out;
    }

    static LinkedHashMap<String, Entry> apply(LinkedHashMap<String, Entry> existing, Ops ops) throws FlacTagException {
        LinkedHashMap<String, Entry> result = new LinkedHashMap<>();
        for (Map.Entry<String, Entry> e : existing.entrySet()) {
            result.put(e.getKey(), new Entry(e.getValue().key, new ArrayList<>(e.getValue().values)));
        }
        for (String key : ops.remove) result.remove(normalizeKey(key));
        List<Entry> added = new ArrayList<>();
        for (Map.Entry<String, List<String>> s : ops.set.entrySet()) {
            String key = normalizeKey(s.getKey());
            List<String> values = normalizeValues(key, s.getValue());
            if (values.isEmpty()) {
                result.remove(key);
            } else if (result.containsKey(key)) {
                result.put(key, new Entry(result.get(key).key, values));
            } else {
                if (!isLegalKey(key)) throw new FlacTagException("Invalid tag name: " + s.getKey(), "INVALID_TAG");
                added.add(new Entry(key, values));
            }
        }
        Collections.sort(added, (a, b) -> a.key.compareTo(b.key));
        for (Entry e : added) result.put(e.key, e);
        return result;
    }

    static byte[] serializeVorbisComment(String vendor, Map<String, Entry> tags) throws FlacTagException {
        return serializeVorbisComment(vendor, tags, Collections.<byte[]>emptyList());
    }

    /** Vendor, the grouped tags and then the raw (key-less) entries verbatim, as a VORBIS_COMMENT body. */
    static byte[] serializeVorbisComment(String vendor, Map<String, Entry> tags, List<byte[]> raw) throws FlacTagException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] v = vendor.getBytes(StandardCharsets.UTF_8);
        writeU32le(out, v.length);
        out.write(v, 0, v.length);
        int count = 0;
        ByteArrayOutputStream entries = new ByteArrayOutputStream();
        for (Entry e : tags.values()) {
            for (String value : e.values) {
                byte[] text = (e.key + "=" + value).getBytes(StandardCharsets.UTF_8);
                writeU32le(entries, text.length);
                entries.write(text, 0, text.length);
                count++;
            }
        }
        for (byte[] bytes : raw) {
            writeU32le(entries, bytes.length);
            entries.write(bytes, 0, bytes.length);
            count++;
        }
        writeU32le(out, count);
        byte[] body = entries.toByteArray();
        out.write(body, 0, body.length);
        if (out.size() > MAX_BLOCK_LENGTH) throw new FlacTagException("Tags too large for one metadata block", "TOO_LARGE");
        return out.toByteArray();
    }

    private static void writeU32le(ByteArrayOutputStream out, long v) {
        out.write((int) (v & 0xFF));
        out.write((int) ((v >> 8) & 0xFF));
        out.write((int) ((v >> 16) & 0xFF));
        out.write((int) ((v >> 24) & 0xFF));
    }

    private static void writeHeader(ByteArrayOutputStream out, int type, int length, boolean last) {
        out.write((last ? 0x80 : 0) | type);
        out.write((length >> 16) & 0xFF);
        out.write((length >> 8) & 0xFF);
        out.write(length & 0xFF);
    }

    /** The tags of a metadata region as { UPPER: values }; the vendor is returned via {@code vendorOut[0]} (null when there is no block). */
    public static Map<String, List<String>> readTags(byte[] head, String[] vendorOut) throws FlacTagException {
        Parsed parsed = parseMetadata(head);
        for (Block b : parsed.blocks) {
            if (b.type == BLOCK_VORBIS_COMMENT) {
                List<String[]> comments = new ArrayList<>();
                String vendor = parseVorbisComment(head, b.offset, b.length, comments);
                if (vendorOut != null && vendorOut.length > 0) vendorOut[0] = vendor;
                return tagsObject(group(comments));
            }
        }
        if (vendorOut != null && vendorOut.length > 0) vendorOut[0] = null;
        return new LinkedHashMap<>();
    }

    /** Plans the write for the metadata region {@code head} (start of file .. audio offset). */
    public static Plan plan(byte[] head, Ops ops, int padding) throws FlacTagException {
        Parsed parsed = parseMetadata(head);
        int oldLength = parsed.audioOffset - parsed.metaStart;

        Block firstVc = null;
        int vcCount = 0;
        for (Block b : parsed.blocks) {
            if (b.type != BLOCK_VORBIS_COMMENT) continue;
            if (firstVc == null) firstVc = b;
            vcCount++;
        }
        if (vcCount > 1) throw new FlacTagException("File has multiple comment blocks; not supported", "MULTIPLE_COMMENT_BLOCKS");
        String vendor = DEFAULT_VENDOR;
        LinkedHashMap<String, Entry> existing = new LinkedHashMap<>();
        List<byte[]> raw = new ArrayList<>();
        if (firstVc != null) {
            List<String[]> comments = new ArrayList<>();
            vendor = parseVorbisComment(head, firstVc.offset, firstVc.length, comments, raw);
            existing = group(comments);
        }
        LinkedHashMap<String, Entry> tags = apply(existing, ops);
        byte[] vcBody = serializeVorbisComment(vendor, tags, raw);

        List<int[]> outTypes = new ArrayList<>();   // [type]
        List<byte[]> outBodies = new ArrayList<>();
        boolean replaced = false;
        for (Block b : parsed.blocks) {
            if (b.type == BLOCK_PADDING) continue;
            if (b.type == BLOCK_VORBIS_COMMENT) {
                outTypes.add(new int[] { BLOCK_VORBIS_COMMENT });
                outBodies.add(vcBody);
                replaced = true;
                continue;
            }
            outTypes.add(new int[] { b.type });
            outBodies.add(Arrays.copyOfRange(head, b.offset, b.offset + b.length));
            if (b.type == BLOCK_STREAMINFO && firstVc == null && !replaced) {
                outTypes.add(new int[] { BLOCK_VORBIS_COMMENT });
                outBodies.add(vcBody);
                replaced = true;
            }
        }

        long newLength = 0;
        for (byte[] body : outBodies) newLength += 4 + body.length;
        long leftover = oldLength - newLength;
        boolean inPlace;
        long paddingLength;
        if (leftover == 0) {
            inPlace = true;
            paddingLength = -1;
        } else if (leftover >= 4) {
            inPlace = true;
            paddingLength = leftover - 4;
        } else {
            inPlace = false;
            paddingLength = Math.max(0, padding);
        }
        if (paddingLength > MAX_BLOCK_LENGTH) {
            inPlace = false;
            paddingLength = Math.max(0, padding);
        }
        if (paddingLength >= 0) {
            outTypes.add(new int[] { BLOCK_PADDING });
            outBodies.add(new byte[(int) paddingLength]);
        }

        ByteArrayOutputStream meta = new ByteArrayOutputStream((int) Math.min(Integer.MAX_VALUE, newLength + 4 + Math.max(0, paddingLength)));
        for (int i = 0; i < outBodies.size(); i++) {
            byte[] body = outBodies.get(i);
            writeHeader(meta, outTypes.get(i)[0], body.length, i == outBodies.size() - 1);
            meta.write(body, 0, body.length);
        }

        Plan plan = new Plan();
        plan.inPlace = inPlace;
        plan.metadata = meta.toByteArray();
        if (inPlace && plan.metadata.length != oldLength) throw new FlacTagException("Internal error: in-place size mismatch", "INTERNAL");
        plan.prefix = Arrays.copyOfRange(head, 0, parsed.metaStart);
        plan.metaStart = parsed.metaStart;
        plan.audioOffset = parsed.audioOffset;
        Block si = parsed.blocks.get(0);
        plan.streamInfo = Arrays.copyOfRange(head, si.offset, si.offset + STREAMINFO_LENGTH);
        plan.tags = tagsObject(tags);
        plan.vendor = vendor;
        plan.unchanged = Arrays.equals(plan.metadata, Arrays.copyOfRange(head, parsed.metaStart, parsed.audioOffset));
        return plan;
    }

    /** Whole-buffer variant (tests, vectors): the complete new file for {@code original}. */
    public static byte[] apply(byte[] original, Ops ops, int padding) throws FlacTagException {
        Parsed parsed = parseMetadata(original);
        Plan plan = plan(Arrays.copyOfRange(original, 0, parsed.audioOffset), ops, padding);
        byte[] out = new byte[plan.prefix.length + plan.metadata.length + (original.length - parsed.audioOffset)];
        System.arraycopy(plan.prefix, 0, out, 0, plan.prefix.length);
        System.arraycopy(plan.metadata, 0, out, plan.prefix.length, plan.metadata.length);
        System.arraycopy(original, parsed.audioOffset, out, plan.prefix.length + plan.metadata.length, original.length - parsed.audioOffset);
        return out;
    }

    // --- verification ----------------------------------------------------------------------

    /** Lowercase hex SHA-256 of everything left in the stream. */
    public static String sha256Hex(InputStream in) throws IOException {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        return Bytes.hex(md.digest(), 0, 32);
    }

    static boolean tagsEqual(Map<String, List<String>> a, Map<String, List<String>> b) {
        if (a.size() != b.size()) return false;
        for (Map.Entry<String, List<String>> e : a.entrySet()) {
            List<String> other = b.get(e.getKey());
            if (other == null || !other.equals(e.getValue())) return false;
        }
        return true;
    }

    /**
     * Checks a written file, read from {@code in} (positioned at its start), against the plan:
     * STREAMINFO bytes, the tags read back and, when {@code expectedAudioHash} is given, the
     * SHA-256 of everything after the metadata. Returns null when it all matches, else the
     * mismatch.
     */
    public static String verify(InputStream in, Plan plan, String expectedAudioHash) throws IOException {
        byte[] head;
        Parsed parsed;
        try {
            head = readHead(in);
            parsed = parseMetadata(head);
        } catch (FlacTagException e) {
            return "metadata unreadable after write: " + e.getMessage();
        }
        Block si = parsed.blocks.get(0);
        if (!Arrays.equals(Arrays.copyOfRange(head, si.offset, si.offset + STREAMINFO_LENGTH), plan.streamInfo)) return "STREAMINFO changed";
        if (!tagsEqual(readTags(head, null), plan.tags)) return "tags read back differ from the tags written";
        if (expectedAudioHash != null) {
            String actual = sha256Hex(in);
            if (!actual.equals(expectedAudioHash)) return "audio data changed";
        }
        return null;
    }

    /** Convenience for callers holding a whole file in memory. */
    public static String verify(byte[] file, Plan plan, String expectedAudioHash) throws IOException {
        return verify(new java.io.ByteArrayInputStream(file), plan, expectedAudioHash);
    }
}
