package com.crossroads.player;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;

import java.io.BufferedInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/** {@link DocumentStore} over ContentResolver + DocumentsContract (tree-based document URIs). */
final class SafDocumentStore implements DocumentStore {

    private static final int BUFFER = 256 * 1024;
    private static final String[] NAME_PROJECTION = { DocumentsContract.Document.COLUMN_DISPLAY_NAME };
    private static final String[] CHILD_PROJECTION = { DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME };
    private static final String[] FLAGS_PROJECTION = { DocumentsContract.Document.COLUMN_FLAGS };

    private final ContentResolver resolver;

    SafDocumentStore(ContentResolver resolver) {
        this.resolver = resolver;
    }

    @Override
    public Doc create(Doc parent, String mimeType, String requestedName) throws IOException {
        Uri uri = DocumentsContract.createDocument(resolver, Uri.parse(parent.uri), mimeType, requestedName);
        if (uri == null) throw new IOException("createDocument returned null");
        String actual = displayName(new Doc(uri.toString(), null));
        return new Doc(uri.toString(), actual != null ? actual : requestedName);
    }

    @Override
    public InputStream openRead(Doc doc) throws IOException {
        InputStream in = resolver.openInputStream(Uri.parse(doc.uri));
        if (in == null) throw new FileNotFoundException("Cannot open " + doc);
        return new BufferedInputStream(in, BUFFER);
    }

    @Override
    public WriteChannel openWrite(Doc doc) throws IOException {
        final ParcelFileDescriptor pfd = resolver.openFileDescriptor(Uri.parse(doc.uri), "wt");
        if (pfd == null) throw new FileNotFoundException("Cannot open " + doc + " for writing");
        // Android's FileOutputStream(FileDescriptor) does not own the descriptor; the pfd closes it.
        final FileOutputStream out = new FileOutputStream(pfd.getFileDescriptor());
        return new WriteChannel() {
            @Override
            public OutputStream stream() {
                return out;
            }

            @Override
            public void sync() throws IOException {
                out.flush();
                pfd.getFileDescriptor().sync();
            }

            @Override
            public void close() throws IOException {
                try {
                    out.close();
                } finally {
                    pfd.close();
                }
            }
        };
    }

    @Override
    public Doc rename(Doc doc, String newName) throws IOException {
        Uri uri = Uri.parse(doc.uri);
        Integer flags = flags(uri);
        if (flags != null && (flags & DocumentsContract.Document.FLAG_SUPPORTS_RENAME) == 0) {
            throw new UnsupportedOperationException("Provider does not support renaming " + doc);
        }
        Uri renamed;
        try {
            renamed = DocumentsContract.renameDocument(resolver, uri, newName);
        } catch (UnsupportedOperationException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new IOException("renameDocument failed: " + e.getMessage(), e);
        }
        if (renamed == null) throw new IOException("renameDocument returned null for " + doc);
        String actual = displayName(new Doc(renamed.toString(), null));
        return new Doc(renamed.toString(), actual != null ? actual : newName);
    }

    @Override
    public boolean delete(Doc doc) throws IOException {
        try {
            return DocumentsContract.deleteDocument(resolver, Uri.parse(doc.uri));
        } catch (FileNotFoundException e) {
            return false;
        } catch (RuntimeException e) {
            throw new IOException("deleteDocument failed: " + e.getMessage(), e);
        }
    }

    @Override
    public boolean exists(Doc doc) {
        try (Cursor c = resolver.query(Uri.parse(doc.uri), new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID }, null, null, null)) {
            return c != null && c.getCount() > 0;
        } catch (RuntimeException e) {
            return false;
        }
    }

    @Override
    public Doc findChild(Doc parent, String name) throws IOException {
        Uri parentUri = Uri.parse(parent.uri);
        Uri children;
        try {
            children = DocumentsContract.buildChildDocumentsUriUsingTree(parentUri, DocumentsContract.getDocumentId(parentUri));
        } catch (RuntimeException e) {
            throw new IOException("Not a tree document: " + parent, e);
        }
        try (Cursor c = resolver.query(children, CHILD_PROJECTION, null, null, null)) {
            if (c == null) return null;
            while (c.moveToNext()) {
                if (name.equals(c.getString(1))) {
                    Uri uri = DocumentsContract.buildDocumentUriUsingTree(parentUri, c.getString(0));
                    return new Doc(uri.toString(), name);
                }
            }
            return null;
        } catch (RuntimeException e) {
            throw new IOException("Listing " + parent + " failed: " + e.getMessage(), e);
        }
    }

    @Override
    public String displayName(Doc doc) {
        try (Cursor c = resolver.query(Uri.parse(doc.uri), NAME_PROJECTION, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (RuntimeException ignored) {
            // fall through
        }
        return null;
    }

    private Integer flags(Uri uri) {
        try (Cursor c = resolver.query(uri, FLAGS_PROJECTION, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getInt(0);
        } catch (RuntimeException ignored) {
            // unknown
        }
        return null;
    }
}
