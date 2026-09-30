package com.crossroads.player;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import com.getcapacitor.Logger;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Persistent cache of per-file probe results (see AudioFileProbe), keyed by path and
 * validated by file size + modification time, so unchanged files are never re-parsed on
 * later launches. Lives in the app's private database directory.
 *
 * One process-wide instance ({@link #get(Context)}): the foreground scan and the background
 * pass share the connection (WAL mode, writes serialised on this object), which is what keeps
 * a second SQLiteOpenHelper from throwing SQLiteDatabaseLockedException into getTracks().
 *
 * Versioning is split three ways:
 *   - DB_VERSION: the table layout; a change drops the table.
 *   - probe (column): AudioFileProbe.PROBE_VERSION the row was written with; older rows are
 *     ignored (and overwritten) instead of being served.
 *   - modelVersion (meta row): the renderer's LIBRARY_MODEL_VERSION as passed by getTracks();
 *     a change clears every row.
 *
 * Failed probes are cached as well (status = failed) so a file the readers cannot parse is
 * not retried on every launch, but only for RETRY_FAILED_MS.
 */
final class LibraryIndexDb extends SQLiteOpenHelper {

    static final String DB_NAME = "library-index.db";

    /** Schema version only (probe and model versions are stored in the rows / meta table). */
    static final int DB_VERSION = 2;

    static final String STATUS_OK = "ok";
    static final String STATUS_FAILED = "failed";

    /** How long a failed probe is trusted before the file is tried again. */
    static final long RETRY_FAILED_MS = 7L * 24 * 60 * 60 * 1000;

    private static final String TAG = "LibraryIndexDb";
    private static final String TABLE = "tracks";
    private static final String META = "meta";
    private static final String META_MODEL_VERSION = "modelVersion";
    private static final int DELETE_BATCH = 400;

    private static LibraryIndexDb instance;

    /** The shared instance for this process. */
    static synchronized LibraryIndexDb get(Context context) {
        if (instance == null) instance = new LibraryIndexDb(context.getApplicationContext());
        return instance;
    }

    /** A row to write. */
    static final class Entry {
        final String path;
        final long size;
        final long mtime;
        final String details;
        final boolean failed;

        Entry(String path, long size, long mtime, String details, boolean failed) {
            this.path = path;
            this.size = size;
            this.mtime = mtime;
            this.details = details;
            this.failed = failed;
        }
    }

    /** A row as read back. */
    static final class Cached {
        final long size;
        final long mtime;
        final String details;
        final int probe;
        final boolean failed;
        final long updated;

        Cached(long size, long mtime, String details, int probe, boolean failed, long updated) {
            this.size = size;
            this.mtime = mtime;
            this.details = details;
            this.probe = probe;
            this.failed = failed;
            this.updated = updated;
        }

        /** Whether this row still describes the file and was produced by the current readers. */
        boolean isCurrent(long fileSize, long fileMtime, long now) {
            if (size != fileSize || mtime != fileMtime || probe != AudioFileProbe.PROBE_VERSION) return false;
            return !failed || now - updated < RETRY_FAILED_MS;
        }
    }

    private LibraryIndexDb(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE " + TABLE + " (" +
            "path TEXT PRIMARY KEY, " +
            "size INTEGER NOT NULL, " +
            "mtime INTEGER NOT NULL, " +
            "details TEXT NOT NULL, " +
            "probe INTEGER NOT NULL, " +
            "status TEXT NOT NULL, " +
            "updated INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE " + META + " (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS " + TABLE);
        db.execSQL("DROP TABLE IF EXISTS " + META);
        onCreate(db);
    }

    @Override
    public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        onUpgrade(db, oldVersion, newVersion);
    }

    /**
     * Makes sure the rows were written for {@code modelVersion}; clears them otherwise.
     * Returns true when rows were dropped.
     */
    synchronized boolean ensureModelVersion(int modelVersion) {
        String wanted = String.valueOf(modelVersion);
        try {
            SQLiteDatabase db = getWritableDatabase();
            String current = null;
            try (Cursor c = db.query(META, new String[] {"value"}, "key = ?", new String[] {META_MODEL_VERSION}, null, null, null, "1")) {
                if (c.moveToFirst()) current = c.getString(0);
            }
            if (wanted.equals(current)) return false;
            db.beginTransaction();
            try {
                int dropped = db.delete(TABLE, null, null);
                ContentValues values = new ContentValues(2);
                values.put("key", META_MODEL_VERSION);
                values.put("value", wanted);
                db.insertWithOnConflict(META, null, values, SQLiteDatabase.CONFLICT_REPLACE);
                db.setTransactionSuccessful();
                if (current != null) Logger.info(TAG, "Model version " + current + " -> " + wanted + ": dropped " + dropped + " cached rows");
                return dropped > 0;
            } finally {
                db.endTransaction();
            }
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Model version check failed: " + e);
            return false;
        }
    }

    /**
     * Every row, keyed by path, in one query (a scan looks up thousands of paths; one SELECT
     * per row was the slow part). Empty when the database cannot be read: the scan then
     * simply probes.
     */
    Map<String, Cached> loadAll() {
        Map<String, Cached> out = new HashMap<>();
        try (Cursor c = getReadableDatabase().query(TABLE,
                new String[] {"path", "size", "mtime", "details", "probe", "status", "updated"},
                null, null, null, null, null)) {
            while (c.moveToNext()) {
                out.put(c.getString(0), new Cached(c.getLong(1), c.getLong(2), c.getString(3), c.getInt(4),
                    STATUS_FAILED.equals(c.getString(5)), c.getLong(6)));
            }
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Reading the index failed; probing without cache: " + e);
            out.clear();
        }
        return out;
    }

    /** The cached row for {@code path} (any state), or null. */
    Cached get(String path) {
        try (Cursor c = getReadableDatabase().query(TABLE,
                new String[] {"size", "mtime", "details", "probe", "status", "updated"},
                "path = ?", new String[] {path}, null, null, null, "1")) {
            if (!c.moveToFirst()) return null;
            return new Cached(c.getLong(0), c.getLong(1), c.getString(2), c.getInt(3), STATUS_FAILED.equals(c.getString(4)), c.getLong(5));
        } catch (RuntimeException e) {
            Logger.warn(TAG, "Reading the index failed for " + path + ": " + e);
            return null;
        }
    }

    /** The cached details JSON for {@code path} when the row is current, else null. */
    String getCurrent(String path, long size, long mtime) {
        Cached cached = get(path);
        return cached != null && cached.isCurrent(size, mtime, System.currentTimeMillis()) ? cached.details : null;
    }

    /** Inserts or replaces the given entries in one transaction. */
    synchronized void putAll(List<Entry> entries) {
        if (entries.isEmpty()) return;
        SQLiteDatabase db = getWritableDatabase();
        long now = System.currentTimeMillis();
        db.beginTransaction();
        try {
            for (Entry e : entries) {
                ContentValues values = new ContentValues(7);
                values.put("path", e.path);
                values.put("size", e.size);
                values.put("mtime", e.mtime);
                values.put("details", e.details);
                values.put("probe", AudioFileProbe.PROBE_VERSION);
                values.put("status", e.failed ? STATUS_FAILED : STATUS_OK);
                values.put("updated", now);
                db.insertWithOnConflict(TABLE, null, values, SQLiteDatabase.CONFLICT_REPLACE);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /**
     * Deletes rows whose path is not in {@code livePaths}. Returns the number removed. Does
     * nothing when {@code livePaths} is empty: MediaStore occasionally answers with nothing
     * (mid-rescan, storage briefly unavailable) and that must not wipe the cache.
     */
    synchronized int prune(Set<String> livePaths) {
        if (livePaths == null || livePaths.isEmpty()) return 0;
        List<String> stale = new ArrayList<>();
        SQLiteDatabase db = getWritableDatabase();
        try (Cursor c = db.query(TABLE, new String[] {"path"}, null, null, null, null, null)) {
            while (c.moveToNext()) {
                String path = c.getString(0);
                if (!livePaths.contains(path)) stale.add(path);
            }
        }
        if (stale.isEmpty()) return 0;
        db.beginTransaction();
        try {
            for (int i = 0; i < stale.size(); i += DELETE_BATCH) {
                List<String> batch = stale.subList(i, Math.min(stale.size(), i + DELETE_BATCH));
                StringBuilder where = new StringBuilder("path IN (");
                for (int j = 0; j < batch.size(); j++) where.append(j == 0 ? "?" : ",?");
                where.append(')');
                db.delete(TABLE, where.toString(), batch.toArray(new String[0]));
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
        return stale.size();
    }

    /** Drops the row for one path (the file was rewritten; the next lookup re-probes it). */
    synchronized void delete(String path) {
        getWritableDatabase().delete(TABLE, "path = ?", new String[] {path});
    }

    long count() {
        try (Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM " + TABLE, null)) {
            return c.moveToFirst() ? c.getLong(0) : 0;
        } catch (RuntimeException e) {
            return 0;
        }
    }
}
