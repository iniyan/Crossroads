// Persistent library index for the desktop scanner: a JSON file in userData mapping each
// file path to the raw song parsed from it, keyed by (size, mtime) so unchanged files are
// never re-parsed. Written atomically (temp file + rename).
//
// Versioning: the file is keyed on INDEX_VERSION (this scanner's raw song shape) combined
// with the renderer's LIBRARY_MODEL_VERSION (src/library/song.js, passed with every scan
// request); a change to either drops every entry.
//
// Failed parses are cached too (a file that music-metadata rejects would otherwise be
// re-parsed on every scan) but with `failedAt`, and are retried after RETRY_FAILED_MS.
// Transient I/O errors are never cached (see libraryScanner.js).

const fsp = require('fs/promises');
const path = require('path');

const INDEX_FILE = 'library-index.json';

// Bump when the raw song shape produced by the scanner changes incompatibly.
const INDEX_VERSION = 3;

// How long a deterministic parse failure is trusted before the file is tried again.
const RETRY_FAILED_MS = 7 * 24 * 60 * 60 * 1000;

const versionKey = (modelVersion) => `${INDEX_VERSION}.${modelVersion}`;

class LibraryIndex {
    /**
     * @param {string} dir  Directory that holds the index file (app.getPath('userData')).
     */
    constructor(dir) {
        this.file = path.join(dir, INDEX_FILE);
        this.entries = new Map();   // path -> { size, mtime, song, failedAt? }
        this.modelVersion = null;   // LIBRARY_MODEL_VERSION the entries were produced under
        this.dirty = false;
        this.loaded = false;
    }

    async load() {
        this.entries = new Map();
        this.modelVersion = null;
        this.loaded = true;
        this.dirty = false;
        let text;
        try {
            text = await fsp.readFile(this.file, 'utf8');
        } catch (e) {
            if (e && e.code === 'ENOENT') return this;
            console.warn('Library index unreadable, rebuilding', e.message);
            return this;
        }
        try {
            const data = JSON.parse(text);
            const modelVersion = Number.isInteger(data?.modelVersion) ? data.modelVersion : null;
            if (data && modelVersion !== null && data.version === versionKey(modelVersion)
                && data.entries && typeof data.entries === 'object') {
                this.modelVersion = modelVersion;
                for (const [file, entry] of Object.entries(data.entries)) {
                    if (entry && typeof entry.size === 'number' && typeof entry.mtime === 'number' && entry.song) {
                        this.entries.set(file, entry);
                    }
                }
            } else {
                this.dirty = true; // old format: rewrite on next save
            }
        } catch (e) {
            console.warn('Library index corrupt, rebuilding', e.message);
            this.dirty = true;
        }
        return this;
    }

    /**
     * Binds the index to the renderer's model version. Entries written under another
     * version are dropped (the derived fields they lack cannot be filled in without a parse).
     * @returns {boolean} true when entries were dropped
     */
    ensureModelVersion(modelVersion) {
        const version = Number.isInteger(modelVersion) && modelVersion >= 0 ? modelVersion : 0;
        if (this.modelVersion === version) return false;
        const dropped = this.entries.size > 0;
        if (dropped) console.log(`Library index model version ${this.modelVersion} -> ${version}: dropping ${this.entries.size} entries`);
        this.entries = new Map();
        this.modelVersion = version;
        this.dirty = true;
        return dropped;
    }

    /**
     * The cached song for `file` if it still matches `size` and `mtime`, else null. A cached
     * failure is honoured only for RETRY_FAILED_MS.
     */
    get(file, size, mtime, now = Date.now()) {
        const entry = this.entries.get(file);
        if (!entry || entry.size !== size || entry.mtime !== mtime) return null;
        if (typeof entry.failedAt === 'number' && now - entry.failedAt >= RETRY_FAILED_MS) return null;
        return entry.song;
    }

    /** Whether the cached entry for `file` records a parse failure. */
    isFailed(file) {
        const entry = this.entries.get(file);
        return !!entry && typeof entry.failedAt === 'number';
    }

    /**
     * @param {Object} [opts]
     * @param {number} [opts.failedAt]  Timestamp of a deterministic parse failure; the entry is
     *                                  retried after RETRY_FAILED_MS.
     */
    put(file, size, mtime, song, { failedAt = null } = {}) {
        const entry = { size, mtime, song };
        if (typeof failedAt === 'number') entry.failedAt = failedAt;
        this.entries.set(file, entry);
        this.dirty = true;
    }

    /**
     * Drops entries under `root` whose path is not in `livePaths` (deleted or moved files).
     * Entries outside `root` are kept so switching music folders back and forth stays cheap.
     * Nothing is dropped when `livePaths` is empty: an empty listing is far more likely a
     * transient failure (unmounted drive, permission hiccup) than a library wiped clean, and
     * the entries cost nothing while the files are gone.
     * @returns {number} entries removed
     */
    prune(root, livePaths, isInside) {
        if (!livePaths || livePaths.size === 0) return 0;
        let removed = 0;
        for (const file of Array.from(this.entries.keys())) {
            if (!livePaths.has(file) && isInside(root, file)) {
                this.entries.delete(file);
                removed++;
            }
        }
        if (removed > 0) this.dirty = true;
        return removed;
    }

    get size() {
        return this.entries.size;
    }

    async save() {
        if (!this.dirty) return false;
        const modelVersion = this.modelVersion === null ? 0 : this.modelVersion;
        const data = {
            version: versionKey(modelVersion),
            modelVersion,
            savedAt: Date.now(),
            entries: Object.fromEntries(this.entries)
        };
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fsp.mkdir(path.dirname(this.file), { recursive: true });
        await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
        await fsp.rename(tmp, this.file);
        this.dirty = false;
        return true;
    }
}

module.exports = { LibraryIndex, INDEX_VERSION, INDEX_FILE, RETRY_FAILED_MS, versionKey };
