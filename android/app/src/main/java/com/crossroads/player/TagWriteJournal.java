package com.crossroads.player;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Write-ahead journal for {@link SafTagWriter}: before every step that creates, renames or
 * deletes a document, the record describing the files involved (all in one directory) and
 * the stage reached is written to a JSON file in the app's private storage. Should the app
 * die mid-write, {@link SafTagWriter#recover} reads it on the next start and puts the
 * directory back in order, touching only the names recorded here.
 *
 * Pure Java (hand-rolled flat JSON) so it runs in JVM unit tests; org.json is an Android
 * stub there.
 */
final class TagWriteJournal {

    static final String STAGE_PLANNED = "planned";
    static final String STAGE_TEMP_CREATED = "temp-created";
    static final String STAGE_TEMP_VERIFIED = "temp-verified";
    static final String STAGE_ORIGINAL_RENAMED = "original-renamed";
    static final String STAGE_TEMP_RENAMED = "temp-renamed";
    static final String STAGE_VERIFIED = "verified";

    static final class Record {
        final String id;
        final String treeUri;
        final String parentUri;
        final String originalName;
        String tempName;
        String backupName;
        String stage;
        final long createdAt;

        Record(String id, String treeUri, String parentUri, String originalName, String tempName, String backupName, String stage, long createdAt) {
            this.id = id;
            this.treeUri = treeUri;
            this.parentUri = parentUri;
            this.originalName = originalName;
            this.tempName = tempName;
            this.backupName = backupName;
            this.stage = stage;
            this.createdAt = createdAt;
        }
    }

    private final File file;
    private final List<Record> records = new ArrayList<>();
    private boolean loaded;

    TagWriteJournal(File file) {
        this.file = file;
    }

    File file() {
        return file;
    }

    /** Adds a record at {@link #STAGE_PLANNED} and persists the journal. */
    synchronized Record begin(String treeUri, String parentUri, String originalName) throws IOException {
        load();
        String id = Long.toHexString(System.nanoTime()) + "-" + Integer.toHexString(System.identityHashCode(this));
        Record r = new Record(id, treeUri, parentUri, originalName, null, null, STAGE_PLANNED, System.currentTimeMillis());
        records.add(r);
        save();
        return r;
    }

    /** Persists the record's current field values with the new stage. */
    synchronized void update(Record record, String stage) throws IOException {
        load();
        record.stage = stage;
        if (!records.contains(record)) records.add(record);
        save();
    }

    /** Removes the record (the write finished, or recovery dealt with it). */
    synchronized void complete(Record record) throws IOException {
        load();
        records.remove(record);
        save();
    }

    /** A snapshot of the pending records. */
    synchronized List<Record> pending() throws IOException {
        load();
        return Collections.unmodifiableList(new ArrayList<>(records));
    }

    private void load() throws IOException {
        if (loaded) return;
        loaded = true;
        records.clear();
        if (!file.isFile()) return;
        byte[] bytes;
        try (FileInputStream in = new FileInputStream(file)) {
            bytes = Bytes.readUpTo(in, 4 * 1024 * 1024);
        }
        try {
            records.addAll(parse(new String(bytes, StandardCharsets.UTF_8)));
        } catch (RuntimeException e) {
            // A corrupt journal must not block the app; the strays it described are named
            // ".crossroads-..." and stay recoverable by hand.
            throw new IOException("Corrupt tag-write journal: " + e.getMessage(), e);
        }
    }

    private void save() throws IOException {
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create " + dir);
        File tmp = new File(file.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(serialize(records).getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        }
        if (file.exists() && !file.delete()) throw new IOException("Cannot replace " + file);
        if (!tmp.renameTo(file)) throw new IOException("Cannot write " + file);
    }

    // --- flat JSON ---------------------------------------------------------------------------

    static String serialize(List<Record> list) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            Record r = list.get(i);
            if (i > 0) sb.append(',');
            sb.append('{');
            field(sb, "id", r.id).append(',');
            field(sb, "treeUri", r.treeUri).append(',');
            field(sb, "parentUri", r.parentUri).append(',');
            field(sb, "originalName", r.originalName).append(',');
            field(sb, "tempName", r.tempName).append(',');
            field(sb, "backupName", r.backupName).append(',');
            field(sb, "stage", r.stage).append(',');
            sb.append("\"createdAt\":").append(r.createdAt);
            sb.append('}');
        }
        return sb.append("]\n").toString();
    }

    private static StringBuilder field(StringBuilder sb, String key, String value) {
        sb.append('"').append(key).append("\":");
        if (value == null) return sb.append("null");
        sb.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"');
    }

    /** Parses what {@link #serialize} writes (an array of flat objects with string / number / null values). */
    static List<Record> parse(String text) {
        Parser p = new Parser(text);
        List<Record> out = new ArrayList<>();
        p.ws();
        if (p.done()) return out;
        p.expect('[');
        p.ws();
        if (p.peek() == ']') { p.next(); return out; }
        while (true) {
            p.ws();
            p.expect('{');
            String id = null, treeUri = null, parentUri = null, originalName = null, tempName = null, backupName = null, stage = null;
            long createdAt = 0;
            p.ws();
            if (p.peek() != '}') {
                while (true) {
                    p.ws();
                    String key = p.string();
                    p.ws();
                    p.expect(':');
                    p.ws();
                    Object value = p.value();
                    String s = value instanceof String ? (String) value : null;
                    switch (key) {
                        case "id": id = s; break;
                        case "treeUri": treeUri = s; break;
                        case "parentUri": parentUri = s; break;
                        case "originalName": originalName = s; break;
                        case "tempName": tempName = s; break;
                        case "backupName": backupName = s; break;
                        case "stage": stage = s; break;
                        case "createdAt": if (value instanceof Long) createdAt = (Long) value; break;
                        default: break;
                    }
                    p.ws();
                    if (p.peek() == ',') { p.next(); continue; }
                    break;
                }
            }
            p.expect('}');
            if (id != null && parentUri != null && originalName != null) {
                out.add(new Record(id, treeUri, parentUri, originalName, tempName, backupName, stage == null ? STAGE_PLANNED : stage, createdAt));
            }
            p.ws();
            if (p.peek() == ',') { p.next(); continue; }
            p.expect(']');
            return out;
        }
    }

    private static final class Parser {
        private final String s;
        private int i;

        Parser(String s) {
            this.s = s;
        }

        boolean done() {
            return i >= s.length();
        }

        char peek() {
            if (done()) throw new IllegalStateException("Unexpected end of journal");
            return s.charAt(i);
        }

        char next() {
            char c = peek();
            i++;
            return c;
        }

        void ws() {
            while (!done() && Character.isWhitespace(s.charAt(i))) i++;
        }

        void expect(char c) {
            if (next() != c) throw new IllegalStateException("Expected '" + c + "' at " + (i - 1));
        }

        Object value() {
            char c = peek();
            if (c == '"') return string();
            if (s.startsWith("null", i)) { i += 4; return null; }
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            int start = i;
            while (!done() && "-+0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            if (start == i) throw new IllegalStateException("Unexpected character at " + i);
            try {
                return Long.parseLong(s.substring(start, i));
            } catch (NumberFormatException e) {
                return 0L;
            }
        }

        String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = next();
                if (c == '"') return sb.toString();
                if (c != '\\') { sb.append(c); continue; }
                char e = next();
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 'r': sb.append('\r'); break;
                    case 't': sb.append('\t'); break;
                    case 'b': sb.append('\b'); break;
                    case 'f': sb.append('\f'); break;
                    case 'u':
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                        i += 4;
                        break;
                    default: sb.append(e);
                }
            }
        }
    }
}
