package com.crossroads.player;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * The handful of document operations {@link SafTagWriter} needs, abstracted from the
 * Storage Access Framework so the write / journal / recovery state machine runs on the
 * JVM against an in-memory store ({@code FakeDocumentStore} in the tests).
 * {@link SafDocumentStore} is the ContentResolver-backed production implementation.
 *
 * Every method that takes a {@link Doc} may be called with one whose {@code name} is null
 * (a directory, or a document the caller only knows by URI).
 */
interface DocumentStore {

    /** A document reference: its URI (as the provider knows it) and, when known, its display name. */
    final class Doc {
        final String uri;
        final String name;

        Doc(String uri, String name) {
            if (uri == null) throw new IllegalArgumentException("uri");
            this.uri = uri;
            this.name = name;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof Doc && ((Doc) o).uri.equals(uri);
        }

        @Override
        public int hashCode() {
            return uri.hashCode();
        }

        @Override
        public String toString() {
            return name == null ? uri : name + " <" + uri + ">";
        }
    }

    /** A truncating write to a document; {@link #sync()} flushes it to storage. */
    interface WriteChannel extends Closeable {
        OutputStream stream();

        void sync() throws IOException;
    }

    /**
     * Creates an empty document in {@code parent}. Providers may hand back a different name
     * than requested (e.g. "x (1).tmp"); the returned Doc carries the ACTUAL display name.
     */
    Doc create(Doc parent, String mimeType, String requestedName) throws IOException;

    InputStream openRead(Doc doc) throws IOException;

    WriteChannel openWrite(Doc doc) throws IOException;

    /**
     * Renames a document, returning it under its new (actual) name.
     * @throws UnsupportedOperationException when the provider cannot rename documents
     */
    Doc rename(Doc doc, String newName) throws IOException;

    /** True when the document was deleted (false when it did not exist). */
    boolean delete(Doc doc) throws IOException;

    boolean exists(Doc doc);

    /** The child of {@code parent} called {@code name}, or null. */
    Doc findChild(Doc parent, String name) throws IOException;

    /** The current display name of a document, or null when it cannot be read. */
    String displayName(Doc doc);
}
