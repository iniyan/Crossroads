package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.Test;

/**
 * Runs the vectors shared with the JS writer (src/test/resources/flac-vectors.txt, generated
 * by scripts/generateFlacVectors.mjs from ffmpeg-encoded files) and asserts byte-identical
 * output, so both platforms write exactly the same file for the same edit.
 */
public class FlacTagWriterVectorsTest {

    static final class Vector {
        String name;
        byte[] input;
        int padding = FlacTagWriter.DEFAULT_PADDING;
        final FlacTagWriter.Ops ops = new FlacTagWriter.Ops();
        String sha256;
        boolean inPlace;
        String vendor;
        final Map<String, List<String>> tags = new LinkedHashMap<>();
    }

    static String utf8(String b64) {
        return new String(Base64.getDecoder().decode(b64), StandardCharsets.UTF_8);
    }

    static List<Vector> load() throws IOException {
        InputStream in = FlacTagWriterVectorsTest.class.getResourceAsStream("/flac-vectors.txt");
        if (in == null) throw new IOException("flac-vectors.txt missing from test resources");
        String text = new String(Bytes.readUpTo(in, 64 * 1024 * 1024), StandardCharsets.UTF_8);
        List<Vector> out = new ArrayList<>();
        Vector cur = null;
        for (String raw : text.split("\n")) {
            String line = raw.replaceAll("\\s+$", "");
            if (line.isEmpty() || line.startsWith("#")) continue;
            int sp = line.indexOf(' ');
            String cmd = sp < 0 ? line : line.substring(0, sp);
            String rest = sp < 0 ? "" : line.substring(sp + 1);
            switch (cmd) {
                case "vector": cur = new Vector(); cur.name = rest; break;
                case "input": cur.input = Base64.getDecoder().decode(rest); break;
                case "padding": cur.padding = Integer.parseInt(rest); break;
                case "set": {
                    String[] kv = rest.split(" ", 2);
                    String key = utf8(kv[0]);
                    String value = utf8(kv.length > 1 ? kv[1] : "");
                    List<String> values = cur.ops.set.get(key);
                    if (values == null) {
                        values = new ArrayList<>();
                        cur.ops.set.put(key, values);
                    }
                    values.add(value);
                    break;
                }
                case "clear": cur.ops.set.put(utf8(rest), new ArrayList<>()); break;
                case "remove": cur.ops.remove.add(utf8(rest)); break;
                case "expect": {
                    String[] parts = rest.split(" ");
                    cur.sha256 = parts[1];
                    cur.inPlace = Boolean.parseBoolean(parts[3]);
                    cur.vendor = utf8(parts.length > 5 ? parts[5] : "");
                    break;
                }
                case "tag": {
                    String[] kv = rest.split(" ", 2);
                    String key = utf8(kv[0]);
                    List<String> values = cur.tags.get(key);
                    if (values == null) {
                        values = new ArrayList<>();
                        cur.tags.put(key, values);
                    }
                    values.add(utf8(kv.length > 1 ? kv[1] : ""));
                    break;
                }
                case "end": out.add(cur); cur = null; break;
                default: throw new IOException("Unknown vector line: " + line);
            }
        }
        return out;
    }

    static String sha256(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
        return Bytes.hex(d, 0, d.length);
    }

    @Test
    public void everyVectorProducesThePinnedOutput() throws Exception {
        List<Vector> vectors = load();
        assertTrue("expected shared vectors", vectors.size() > 10);
        for (Vector v : vectors) {
            byte[] out = FlacTagWriter.apply(v.input, v.ops, v.padding);
            assertEquals(v.name + ": output bytes", v.sha256, sha256(out));

            FlacTagWriter.Parsed parsed = FlacTagWriter.parseMetadata(v.input);
            byte[] head = java.util.Arrays.copyOfRange(v.input, 0, parsed.audioOffset);
            FlacTagWriter.Plan plan = FlacTagWriter.plan(head, v.ops, v.padding);
            assertEquals(v.name + ": inPlace", v.inPlace, plan.inPlace);
            assertEquals(v.name + ": vendor", v.vendor, plan.vendor);
            assertEquals(v.name + ": planned tags", v.tags, plan.tags);

            String[] vendor = new String[1];
            Map<String, List<String>> back = FlacTagWriter.readTags(FlacTagWriter.readHead(new ByteArrayInputStream(out)), vendor);
            assertEquals(v.name + ": tags read back", v.tags, back);
            assertEquals(v.name + ": vendor read back", v.vendor, vendor[0]);

            // The written file verifies against its own plan and the original audio hash.
            String audioHash = FlacTagWriter.sha256Hex(new ByteArrayInputStream(v.input, parsed.audioOffset, v.input.length - parsed.audioOffset));
            assertNull(v.name + ": verification", FlacTagWriter.verify(out, plan, audioHash));
        }
    }
}
