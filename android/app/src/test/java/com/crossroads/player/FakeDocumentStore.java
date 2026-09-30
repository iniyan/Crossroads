package com.crossroads.player;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * In-memory {@link DocumentStore} for the JVM tests: documents live under directories, every
 * rename assigns a fresh URI (as path-based SAF providers do), and a {@link Hook} can fail or
 * tamper at any operation to simulate I/O errors, verification mismatches and crashes.
 */
final class FakeDocumentStore implements DocumentStore {

    static final class Entry {
        String name;
        final String parentUri;
        byte[] content;      // null for a directory

        Entry(String name, String parentUri, byte[] content) {
            this.name = name;
            this.parentUri = parentUri;
            this.content = content;
        }
    }

    /**
     * Called around store operations. Events: create, openRead, openWrite, write (before each
     * chunk), sync, close (before the write channel closes), closed (after), rename, renamed,
     * delete, findChild, exists. Throwing an IOException simulates a provider error; throwing
     * an {@link Error} simulates the process dying (the writer does not catch it).
     */
    interface Hook {
        void on(String event, Doc doc, Entry entry) throws IOException;
    }

    /** Thrown by hooks to simulate the app being killed at that point. */
    static final class Crash extends Error {
        Crash(String where) {
            super("crash at " + where);
        }
    }

    final Map<String, Entry> docs = new LinkedHashMap<>();
    final List<String> log = new ArrayList<>();
    Hook hook = null;
    boolean renameUnsupported = false;
    /** Maps a requested create name to the name the provider "chooses". */
    java.util.function.UnaryOperator<String> createNameMangler = null;
    int openReadCount = 0;
    long bytesRead = 0;
    private int nextId = 1;

    /** A hook that throws an IOException on the given (0-based) occurrences of {@code event}. */
    static Hook failAt(String event, int... nths) {
        int[] count = { 0 };
        return (e, doc, entry) -> {
            if (!e.equals(event)) return;
            int n = count[0]++;
            for (int nth : nths) if (n == nth) throw new IOException("simulated " + event + " failure #" + nth);
        };
    }

    /** A hook that crashes (Error) the {@code nth} time {@code event} fires. */
    static Hook crashAt(String event, int nth) {
        int[] count = { 0 };
        return (e, doc, entry) -> {
            if (e.equals(event) && count[0]++ == nth) throw new Crash(event + "#" + nth);
        };
    }

    static Hook all(final Hook... hooks) {
        return (e, doc, entry) -> {
            for (Hook h : hooks) h.on(e, doc, entry);
        };
    }

    private void fire(String event, Doc doc, Entry entry) throws IOException {
        log.add(event + (doc != null && doc.name != null ? ":" + doc.name : ""));
        if (hook != null) hook.on(event, doc, entry);
    }

    private String newUri() {
        return "fake://doc/" + (nextId++);
    }

    // --- fixture helpers ---------------------------------------------------------------------

    Doc mkdir(String name) {
        String uri = newUri();
        docs.put(uri, new Entry(name, null, null));
        return new Doc(uri, name);
    }

    Doc put(Doc parent, String name, byte[] content) {
        String uri = newUri();
        docs.put(uri, new Entry(name, parent.uri, content.clone()));
        return new Doc(uri, name);
    }

    /** Names of the documents in a directory, in creation order. */
    List<String> names(Doc parent) {
        List<String> out = new ArrayList<>();
        for (Entry e : docs.values()) if (parent.uri.equals(e.parentUri)) out.add(e.name);
        return out;
    }

    byte[] content(Doc parent, String name) {
        for (Entry e : docs.values()) if (parent.uri.equals(e.parentUri) && name.equals(e.name)) return e.content;
        return null;
    }

    private Entry entry(Doc doc) {
        return docs.get(doc.uri);
    }

    // --- DocumentStore -------------------------------------------------------------------------

    @Override
    public Doc create(Doc parent, String mimeType, String requestedName) throws IOException {
        fire("create", new Doc(parent.uri, requestedName), null);
        if (entry(parent) == null) throw new IOException("No such directory " + parent);
        String actual = createNameMangler == null ? requestedName : createNameMangler.apply(requestedName);
        if (content(parent, actual) != null) throw new IOException("Exists: " + actual);
        return put(parent, actual, new byte[0]);
    }

    @Override
    public InputStream openRead(Doc doc) throws IOException {
        Entry e = entry(doc);
        fire("openRead", doc, e);
        if (e == null || e.content == null) throw new IOException("No such document " + doc);
        openReadCount++;
        return new ByteArrayInputStream(e.content) {
            @Override
            public synchronized int read() {
                int b = super.read();
                if (b >= 0) bytesRead++;
                return b;
            }

            @Override
            public synchronized int read(byte[] b, int off, int len) {
                int n = super.read(b, off, len);
                if (n > 0) bytesRead += n;
                return n;
            }

            @Override
            public synchronized long skip(long n) {
                long s = super.skip(n);
                bytesRead += s;
                return s;
            }
        };
    }

    @Override
    public WriteChannel openWrite(Doc doc) throws IOException {
        final Entry e = entry(doc);
        fire("openWrite", doc, e);
        if (e == null || e.content == null) throw new IOException("No such document " + doc);
        e.content = new byte[0];   // truncating open
        final OutputStream stream = new OutputStream() {
            @Override
            public void write(int b) throws IOException {
                write(new byte[] { (byte) b }, 0, 1);
            }

            @Override
            public void write(byte[] b, int off, int len) throws IOException {
                fire("write", doc, e);
                ByteArrayOutputStream grown = new ByteArrayOutputStream(e.content.length + len);
                grown.write(e.content, 0, e.content.length);
                grown.write(b, off, len);
                e.content = grown.toByteArray();
            }
        };
        return new WriteChannel() {
            @Override
            public OutputStream stream() {
                return stream;
            }

            @Override
            public void sync() throws IOException {
                fire("sync", doc, e);
            }

            @Override
            public void close() throws IOException {
                fire("close", doc, e);
                fire("closed", doc, e);
            }
        };
    }

    @Override
    public Doc rename(Doc doc, String newName) throws IOException {
        Entry e = entry(doc);
        fire("rename", new Doc(doc.uri, (e != null ? e.name : doc.name) + "->" + newName), e);
        if (renameUnsupported) throw new UnsupportedOperationException("rename not supported");
        if (e == null) throw new IOException("No such document " + doc);
        Doc parent = new Doc(e.parentUri, null);
        if (content(parent, newName) != null) throw new IOException("Exists: " + newName);
        docs.remove(doc.uri);
        String uri = newUri();
        Entry moved = new Entry(newName, e.parentUri, e.content);
        docs.put(uri, moved);
        fire("renamed", new Doc(uri, newName), moved);
        return new Doc(uri, moved.name);   // hooks may change the name the provider "chose"
    }

    @Override
    public boolean delete(Doc doc) throws IOException {
        fire("delete", doc, entry(doc));
        return docs.remove(doc.uri) != null;
    }

    @Override
    public boolean exists(Doc doc) {
        try {
            fire("exists", doc, entry(doc));
        } catch (IOException e) {
            return false;
        }
        return docs.containsKey(doc.uri);
    }

    @Override
    public Doc findChild(Doc parent, String name) throws IOException {
        fire("findChild", new Doc(parent.uri, name), null);
        for (Map.Entry<String, Entry> me : docs.entrySet()) {
            if (parent.uri.equals(me.getValue().parentUri) && name.equals(me.getValue().name)) return new Doc(me.getKey(), name);
        }
        return null;
    }

    @Override
    public String displayName(Doc doc) {
        Entry e = entry(doc);
        return e == null ? null : e.name;
    }
}
