package com.crossroads.player;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Environment;
import android.provider.DocumentsContract;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * File access beyond what MediaStore offers (#20 tag writing, #22 .lrc sidecars, #23
 * playlist files), all through the Storage Access Framework.
 *
 * JS API (Capacitor.registerPlugin('MediaFiles')):
 *   requestFolderAccess()             -> { grants: [{ uri, path }] }   (ACTION_OPEN_DOCUMENT_TREE, persisted)
 *   getFolderAccess()                 -> { grants: [{ uri, path }] }
 *   canAccess({ path })               -> { granted: boolean, grantPath: string|null }
 *   writeTags({ path, ops })          -> { ok, strategy, changed, tags }   FLAC only, see SafTagWriter
 *   readSidecar({ path })             -> { content: string|null, needsAccess: boolean }
 *   writeSidecar({ path, content })   -> { ok }
 *   savePlaylist({ name, content })   -> { ok, name, uri } | { canceled: true }  (ACTION_CREATE_DOCUMENT)
 *   openPlaylist()                    -> { name, content, path: string|null, uri } | { canceled: true }
 *
 * A tree grant ("Music" or the whole storage) is mapped to a file-system path via
 * {@link SafPaths}; a track path inside it becomes a document URI without traversing the
 * tree. Everything I/O bound runs on this plugin's own thread, which first replays the
 * tag-write journal (see {@link SafTagWriter#recover}) so an interrupted write is repaired
 * before any new one starts.
 */
@CapacitorPlugin(name = "MediaFiles")
public class MediaFilesPlugin extends Plugin {

    private static final String TAG = "MediaFiles";
    private static final int MAX_TEXT_BYTES = 16 * 1024 * 1024;
    private static final String[] PLAYLIST_MIME_TYPES = {
        "audio/x-mpegurl", "audio/mpegurl", "application/vnd.apple.mpegurl", "application/x-mpegurl", "text/plain", "application/octet-stream"
    };

    private static final ExecutorService IO = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "crossroads-files");
        t.setPriority(Thread.NORM_PRIORITY - 1);
        return t;
    });

    private static final String JOURNAL_FILE = "tag-write-journal.json";
    private static final SafTagWriter.Log LOG = message -> Logger.info(TAG, message);

    private TagWriteJournal journal() {
        return new TagWriteJournal(new File(getContext().getFilesDir(), JOURNAL_FILE));
    }

    @Override
    public void load() {
        final Context context = getContext();
        final TagWriteJournal journal = journal();
        IO.execute(() -> {
            try {
                for (String action : SafTagWriter.recover(new SafDocumentStore(context.getContentResolver()), journal, LOG)) {
                    Logger.info(TAG, "Tag-write recovery: " + action);
                }
            } catch (IOException | RuntimeException e) {
                Logger.error(TAG, "Tag-write recovery failed", e);
            }
        });
    }

    /** A persisted tree grant and the directory it maps to. */
    static final class Grant {
        final Uri treeUri;
        final String treeDocumentId;
        final String path;

        Grant(Uri treeUri, String treeDocumentId, String path) {
            this.treeUri = treeUri;
            this.treeDocumentId = treeDocumentId;
            this.path = path;
        }

        JSObject toJson() {
            JSObject o = new JSObject();
            o.put("uri", treeUri.toString());
            o.put("path", path);
            return o;
        }
    }

    // --- grants ----------------------------------------------------------------------------

    private static String primaryRoot() {
        try {
            return Environment.getExternalStorageDirectory().getAbsolutePath();
        } catch (RuntimeException e) {
            return SafPaths.DEFAULT_PRIMARY_ROOT;
        }
    }

    private List<Grant> grants() {
        List<Grant> out = new ArrayList<>();
        Context context = getContext();
        ContentResolver resolver = context.getContentResolver();
        for (UriPermission permission : resolver.getPersistedUriPermissions()) {
            Uri uri = permission.getUri();
            if (!permission.isReadPermission() || !SafPaths.EXTERNAL_STORAGE_AUTHORITY.equals(uri.getAuthority())) continue;
            if (!DocumentsContract.isTreeUri(uri)) continue;
            String docId = DocumentsContract.getTreeDocumentId(uri);
            String path = SafPaths.treePath(docId, primaryRoot());
            if (path == null) continue;
            out.add(new Grant(uri, docId, path));
        }
        return out;
    }

    private static JSObject grantsJson(List<Grant> grants) {
        JSArray arr = new JSArray();
        for (Grant g : grants) arr.put(g.toJson());
        JSObject result = new JSObject();
        result.put("grants", arr);
        return result;
    }

    /** The grant whose directory contains {@code path}, deepest first; null when none does. */
    private Grant grantFor(String path) {
        Grant best = null;
        for (Grant g : grants()) {
            if (SafPaths.relativePath(g.path, path) == null) continue;
            if (best == null || g.path.length() > best.path.length()) best = g;
        }
        return best;
    }

    private static Uri documentUri(Grant grant, String path) {
        String rel = SafPaths.relativePath(grant.path, path);
        if (rel == null) return null;
        return DocumentsContract.buildDocumentUriUsingTree(grant.treeUri, SafPaths.childDocumentId(grant.treeDocumentId, rel));
    }

    private boolean documentExists(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { DocumentsContract.Document.COLUMN_DOCUMENT_ID }, null, null, null)) {
            return c != null && c.getCount() > 0;
        } catch (RuntimeException e) {
            return false;
        }
    }

    @PluginMethod
    public void requestFolderAccess(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try {
            Uri music = DocumentsContract.buildDocumentUri(SafPaths.EXTERNAL_STORAGE_AUTHORITY, "primary:Music");
            intent.putExtra(DocumentsContract.EXTRA_INITIAL_URI, music);
        } catch (RuntimeException ignored) {
            // Optional hint only.
        }
        startActivityForResult(call, intent, "folderAccessResult");
    }

    @ActivityCallback
    private void folderAccessResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri tree = result.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (tree != null) {
            try {
                int flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                getContext().getContentResolver().takePersistableUriPermission(tree, flags);
            } catch (SecurityException e) {
                Logger.warn(TAG, "Persisting the folder grant failed: " + e);
            }
        }
        JSObject json = grantsJson(grants());
        json.put("canceled", tree == null);
        call.resolve(json);
    }

    @PluginMethod
    public void getFolderAccess(PluginCall call) {
        call.resolve(grantsJson(grants()));
    }

    @PluginMethod
    public void canAccess(PluginCall call) {
        String path = call.getString("path");
        Grant grant = path == null ? null : grantFor(path);
        JSObject result = new JSObject();
        result.put("granted", grant != null);
        result.put("grantPath", grant == null ? JSONObject.NULL : grant.path);
        call.resolve(result);
    }

    // --- #20 tags --------------------------------------------------------------------------

    /**
     * { set: { KEY: string | string[] }, remove: string[] } -> Ops. Only strings (and empty
     * arrays, which clear a key) are accepted; anything else is an error rather than being
     * coerced into text or into a removal.
     */
    static FlacTagWriter.Ops parseOps(JSObject ops) throws JSONException {
        FlacTagWriter.Ops out = new FlacTagWriter.Ops();
        if (ops == null) throw new JSONException("Tag operations required");
        JSONObject set = ops.optJSONObject("set");
        if (set != null) {
            // JSONObject does not keep insertion order, but the writer sorts new keys itself.
            Iterator<String> keys = set.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object raw = set.get(key);
                List<String> values = new ArrayList<>();
                if (raw instanceof JSONArray) {
                    JSONArray arr = (JSONArray) raw;
                    for (int i = 0; i < arr.length(); i++) {
                        Object item = arr.get(i);
                        if (!(item instanceof String)) throw new JSONException("Tag values must be strings (" + key + ")");
                        values.add((String) item);
                    }
                } else if (raw instanceof String) {
                    values.add((String) raw);
                } else {
                    throw new JSONException("Tag values must be strings (" + key + ")");
                }
                out.set.put(key, values);
            }
        }
        JSONArray remove = ops.optJSONArray("remove");
        if (remove != null) {
            for (int i = 0; i < remove.length(); i++) {
                Object item = remove.get(i);
                if (!(item instanceof String)) throw new JSONException("Tag names must be strings");
                out.remove.add((String) item);
            }
        }
        return out;
    }

    @PluginMethod
    public void writeTags(PluginCall call) {
        final String path = call.getString("path");
        if (path == null || path.isEmpty()) { call.reject("path is required"); return; }
        if (!path.toLowerCase(java.util.Locale.ROOT).endsWith(".flac")) { call.reject("Only FLAC files can be written", "UNSUPPORTED_FORMAT"); return; }
        final FlacTagWriter.Ops ops;
        try {
            ops = parseOps(call.getObject("ops"));
        } catch (JSONException e) {
            call.reject("Invalid tag operations: " + e.getMessage());
            return;
        }
        final Grant grant = grantFor(path);
        if (grant == null) { call.reject("Grant folder access to edit tags", "NEEDS_ACCESS"); return; }
        final Uri document = documentUri(grant, path);
        final String rel = SafPaths.relativePath(grant.path, path);
        final String parentId = SafPaths.parentDocumentId(SafPaths.childDocumentId(grant.treeDocumentId, rel));
        final Uri parent = DocumentsContract.buildDocumentUriUsingTree(grant.treeUri, parentId);
        final String treeUri = grant.treeUri.toString();
        final TagWriteJournal journal = journal();
        IO.execute(() -> {
            boolean touched = false;
            try {
                if (!documentExists(document)) throw new IOException("File not found in the granted folder");
                DocumentStore store = new SafDocumentStore(getContext().getContentResolver());
                SafTagWriter.Result written = SafTagWriter.write(store, journal, treeUri,
                    new DocumentStore.Doc(parent.toString(), null), new DocumentStore.Doc(document.toString(), SafPaths.fileName(path)), ops, LOG);
                touched = written.touchedFile;
                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("strategy", written.strategy);
                result.put("changed", written.changed);
                result.put("tags", tagsJson(written.tags));
                if (written.warning != null) result.put("warning", written.warning);
                call.resolve(result);
            } catch (FlacTagWriter.FlacTagException e) {
                call.reject(e.getMessage(), e.code);
            } catch (SafTagWriter.WriteException e) {
                touched = e.touchedFile;
                Logger.error(TAG, "Writing tags failed for " + path, e);
                call.reject("Writing tags failed: " + e.getMessage());
            } catch (IOException | RuntimeException e) {
                Logger.error(TAG, "Writing tags failed for " + path, e);
                call.reject("Writing tags failed: " + e.getMessage());
            } finally {
                // The directory changed (or may have): drop the cached row and let MediaStore look again.
                if (touched) refreshFile(path);
            }
        });
    }

    private void refreshFile(String path) {
        try {
            LibraryIndexDb.get(getContext()).delete(path);
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Index invalidation failed for " + path + ": " + e);
        }
        try {
            MediaScannerConnection.scanFile(getContext(), new String[] { path }, null, null);
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Media scan request failed for " + path + ": " + e);
        }
    }

    private static JSObject tagsJson(Map<String, List<String>> tags) {
        JSObject out = new JSObject();
        for (Map.Entry<String, List<String>> e : tags.entrySet()) {
            JSArray arr = new JSArray();
            for (String v : e.getValue()) arr.put(v);
            out.put(e.getKey(), arr);
        }
        return out;
    }

    // --- #22 sidecars ----------------------------------------------------------------------

    @PluginMethod
    public void readSidecar(PluginCall call) {
        final String path = call.getString("path");
        if (path == null || path.isEmpty()) { call.reject("path is required"); return; }
        final Grant grant = grantFor(path);
        JSObject result = new JSObject();
        if (grant == null) {
            result.put("content", JSONObject.NULL);
            result.put("needsAccess", true);
            call.resolve(result);
            return;
        }
        final Uri document = documentUri(grant, path);
        IO.execute(() -> {
            String content = null;
            try {
                if (documentExists(document)) content = readText(document);
            } catch (IOException | RuntimeException e) {
                Logger.warn(TAG, "Sidecar unreadable " + path + ": " + e);
            }
            result.put("content", content == null ? JSONObject.NULL : content);
            result.put("needsAccess", false);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void writeSidecar(PluginCall call) {
        final String path = call.getString("path");
        final String content = call.getString("content");
        if (path == null || path.isEmpty() || content == null) { call.reject("path and content are required"); return; }
        if (!path.toLowerCase(java.util.Locale.ROOT).endsWith(".lrc")) { call.reject("Only .lrc files can be written"); return; }
        final Grant grant = grantFor(path);
        if (grant == null) { call.reject("Grant folder access to save lyrics", "NEEDS_ACCESS"); return; }
        final Uri document = documentUri(grant, path);
        final String rel = SafPaths.relativePath(grant.path, path);
        final String parentId = SafPaths.parentDocumentId(SafPaths.childDocumentId(grant.treeDocumentId, rel));
        final Uri parent = DocumentsContract.buildDocumentUriUsingTree(grant.treeUri, parentId);
        IO.execute(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                Uri target = document;
                if (!documentExists(document)) {
                    target = DocumentsContract.createDocument(resolver, parent, "application/octet-stream", SafPaths.fileName(path));
                    if (target == null) throw new IOException("Cannot create the .lrc file");
                }
                try (OutputStream out = resolver.openOutputStream(target, "wt")) {
                    if (out == null) throw new IOException("Cannot open the .lrc file for writing");
                    out.write(content.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }
                JSObject result = new JSObject();
                result.put("ok", true);
                call.resolve(result);
            } catch (IOException | RuntimeException e) {
                Logger.error(TAG, "Writing sidecar failed for " + path, e);
                call.reject("Saving lyrics failed: " + e.getMessage());
            }
        });
    }

    // --- #23 playlists ---------------------------------------------------------------------

    @PluginMethod
    public void savePlaylist(PluginCall call) {
        String name = call.getString("name", "Playlist.m3u8");
        String content = call.getString("content");
        if (content == null) { call.reject("content is required"); return; }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/x-mpegurl");
        intent.putExtra(Intent.EXTRA_TITLE, name);
        startActivityForResult(call, intent, "savePlaylistResult");
    }

    @ActivityCallback
    private void savePlaylistResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = result.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) {
            JSObject canceled = new JSObject();
            canceled.put("canceled", true);
            call.resolve(canceled);
            return;
        }
        final String content = call.getString("content", "");
        IO.execute(() -> {
            try {
                try (OutputStream out = getContext().getContentResolver().openOutputStream(uri, "wt")) {
                    if (out == null) throw new IOException("Cannot open the playlist for writing");
                    out.write(content.getBytes(StandardCharsets.UTF_8));
                    out.flush();
                }
                JSObject json = new JSObject();
                json.put("ok", true);
                json.put("uri", uri.toString());
                json.put("name", displayName(uri));
                call.resolve(json);
            } catch (IOException | RuntimeException e) {
                Logger.error(TAG, "Writing playlist failed", e);
                call.reject("Saving the playlist failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void openPlaylist(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, PLAYLIST_MIME_TYPES);
        startActivityForResult(call, intent, "openPlaylistResult");
    }

    @ActivityCallback
    private void openPlaylistResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = result.getResultCode() == Activity.RESULT_OK && data != null ? data.getData() : null;
        if (uri == null) {
            JSObject canceled = new JSObject();
            canceled.put("canceled", true);
            call.resolve(canceled);
            return;
        }
        IO.execute(() -> {
            try {
                String content = readText(uri);
                if (content == null) throw new IOException("Playlist is empty or too large");
                JSObject json = new JSObject();
                json.put("content", content);
                json.put("name", displayName(uri));
                json.put("uri", uri.toString());
                // Best effort: the playlist's own path, for entries relative to it.
                String path = null;
                if (SafPaths.EXTERNAL_STORAGE_AUTHORITY.equals(uri.getAuthority()) && DocumentsContract.isDocumentUri(getContext(), uri)) {
                    path = SafPaths.treePath(DocumentsContract.getDocumentId(uri), primaryRoot());
                }
                json.put("path", path == null ? JSONObject.NULL : path);
                call.resolve(json);
            } catch (IOException | RuntimeException e) {
                Logger.error(TAG, "Reading playlist failed", e);
                call.reject("Opening the playlist failed: " + e.getMessage());
            }
        });
    }

    // --- helpers ---------------------------------------------------------------------------

    private String readText(Uri uri) throws IOException {
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_TEXT_BYTES) return null;
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (RuntimeException ignored) {
            // fall through
        }
        return uri.getLastPathSegment();
    }
}
