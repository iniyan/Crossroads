package com.crossroads.player;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * Writes FLAC tags to a document reachable through a Storage Access Framework tree grant
 * (files owned by other apps cannot be opened for writing by path). The pure part is
 * {@link FlacTagWriter}; this class runs the crash-safe replace sequence against a
 * {@link DocumentStore} and records every step in a {@link TagWriteJournal} first.
 *
 * The file is never written in place. Sequence (each step journaled before it runs):
 *   a. a temp document ".<name>.crossroads-<rand>.tmp" is created next to the track (the
 *      name the provider actually assigned is used from then on), the new metadata and the
 *      audio bytes are written, synced and verified by re-reading (STREAMINFO, tags, audio
 *      SHA-256);
 *   b. the original is renamed to ".<name>.crossroads-bak-<rand>";
 *   c. the temp document is renamed to the original's name;
 *   d. the document now at that name is verified again;
 *   e. the backup is deleted and the journal record closed.
 * The original bytes therefore always exist under either their own name or the backup name
 * until the new file is verified in place. A provider that cannot rename makes the writer
 * refuse (the original is never truncated). Any recovery is a rename of a file this class
 * created or renamed, never a write of old bytes into a path that may have been replaced,
 * and the error text says "original restored" only when that was verified.
 */
final class SafTagWriter {

    static final String TEMP_MIME = "application/octet-stream";
    private static final int BUFFER = 256 * 1024;
    private static final SecureRandom RANDOM = new SecureRandom();

    /** Where progress and recovery actions are reported (Capacitor's Logger in the app; nothing in tests). */
    interface Log {
        void log(String message);
    }

    static final Log NO_LOG = message -> { };

    static final class Result {
        final String strategy;
        final boolean changed;
        final Map<String, List<String>> tags;
        /** True when the directory was modified (temp created, original renamed): index / scanner must be refreshed. */
        final boolean touchedFile;
        /** Non-null when the write succeeded but a stray file could not be cleaned up. */
        final String warning;

        Result(String strategy, boolean changed, Map<String, List<String>> tags, boolean touchedFile, String warning) {
            this.strategy = strategy;
            this.changed = changed;
            this.tags = tags;
            this.touchedFile = touchedFile;
            this.warning = warning;
        }
    }

    /** A failed write; {@link #touchedFile} tells the caller whether the directory changed. */
    static final class WriteException extends IOException {
        final boolean touchedFile;

        WriteException(String message, boolean touchedFile, Throwable cause) {
            super(message, cause);
            this.touchedFile = touchedFile;
        }
    }

    private SafTagWriter() {}

    static String randomSuffix() {
        return Long.toHexString(RANDOM.nextLong() & 0x7FFFFFFFFFFFFFFFL);
    }

    /**
     * @param store    the document provider
     * @param journal  write-ahead journal (see {@link TagWriteJournal})
     * @param treeUri  the tree grant the documents were resolved from (journaled for diagnostics)
     * @param parent   the directory holding the track
     * @param original the FLAC document; {@code name} may be null (it is then looked up)
     */
    static Result write(DocumentStore store, TagWriteJournal journal, String treeUri, DocumentStore.Doc parent,
                        DocumentStore.Doc original, FlacTagWriter.Ops ops, Log log) throws IOException {
        String name = original.name != null ? original.name : store.displayName(original);
        if (name == null || name.isEmpty()) throw new WriteException("Cannot determine the file's name", false, null);
        DocumentStore.Doc originalDoc = new DocumentStore.Doc(original.uri, name);

        // Plan first; a no-op costs one read of the metadata region and nothing else.
        FlacTagWriter.Plan plan;
        byte[] originalHead;
        String audioHash;
        try (InputStream in = store.openRead(originalDoc)) {
            originalHead = FlacTagWriter.readHead(in);
            plan = FlacTagWriter.plan(originalHead, ops, FlacTagWriter.DEFAULT_PADDING);
            if (plan.unchanged) return new Result("rewrite", false, plan.tags, false, null);
            audioHash = FlacTagWriter.sha256Hex(in);
        }

        String rand = randomSuffix();
        TagWriteJournal.Record record = journal.begin(treeUri, parent.uri, name);
        DocumentStore.Doc temp = null;
        boolean touched = false;
        try {
            // a. temp document with the complete new file, verified before anything else moves.
            // The requested name is journaled before the call so a crash inside it still leaves
            // a name recovery can look for; the provider's actual name replaces it afterwards.
            record.tempName = "." + name + ".crossroads-" + rand + ".tmp";
            journal.update(record, TagWriteJournal.STAGE_PLANNED);
            try {
                temp = store.create(parent, TEMP_MIME, record.tempName);
            } catch (IOException | RuntimeException e) {
                throw new WriteException("Cannot create a temporary file next to the track (" + e.getMessage() + "); the original file was not modified", false, e);
            }
            if (temp == null || temp.name == null) throw new WriteException("Cannot create a temporary file next to the track; the original file was not modified", false, null);
            touched = true;
            record.tempName = temp.name;
            journal.update(record, TagWriteJournal.STAGE_TEMP_CREATED);
            try {
                try (DocumentStore.WriteChannel out = store.openWrite(temp);
                     InputStream in = store.openRead(originalDoc)) {
                    OutputStream stream = out.stream();
                    stream.write(plan.prefix);
                    stream.write(plan.metadata);
                    if (!Bytes.skipFully(in, plan.audioOffset)) throw new IOException("File shorter than its metadata");
                    copy(in, stream);
                    stream.flush();
                    out.sync();
                }
            } catch (IOException | RuntimeException e) {
                throw failBeforeRename(store, temp, record, journal, log, "Writing the new file failed (" + e.getMessage() + ")", e);
            }
            String problem = verify(store, temp, plan, audioHash);
            if (problem != null) {
                throw failBeforeRename(store, temp, record, journal, log, "Verification of the new file failed (" + problem + ")", null);
            }

            // b. original -> backup. Nothing has touched the original before this point.
            String backupRequested = "." + name + ".crossroads-bak-" + rand;
            record.backupName = backupRequested;
            journal.update(record, TagWriteJournal.STAGE_TEMP_VERIFIED);
            DocumentStore.Doc backup;
            try {
                backup = store.rename(originalDoc, backupRequested);
            } catch (UnsupportedOperationException e) {
                throw failBeforeRename(store, temp, record, journal, log,
                    "This storage location does not support renaming files, so tags cannot be written safely here", e);
            } catch (IOException | RuntimeException e) {
                if (store.exists(originalDoc)) {
                    throw failBeforeRename(store, temp, record, journal, log, "Could not set the original file aside (" + e.getMessage() + ")", e);
                }
                // The provider threw after renaming: find the backup by the name we asked for.
                backup = store.findChild(parent, backupRequested);
                if (backup == null) {
                    throw new WriteException("Setting the original aside failed (" + e.getMessage() + ") and the file could not be found afterwards; the new tags were written to " + temp.name, true, e);
                }
            }
            if (backup == null || backup.name == null) {
                throw failBeforeRename(store, temp, record, journal, log, "Could not set the original file aside", null);
            }
            record.backupName = backup.name;
            journal.update(record, TagWriteJournal.STAGE_ORIGINAL_RENAMED);

            // c. temp -> original name.
            DocumentStore.Doc replaced = null;
            String renameError = null;
            try {
                replaced = store.rename(temp, name);
            } catch (IOException | RuntimeException e) {
                renameError = e.getMessage();
                replaced = store.findChild(parent, name);   // the provider may have renamed before throwing
            }
            if (replaced == null) {
                deleteQuietly(store, findByName(store, parent, temp), log);
                String outcome = restoreBackup(store, parent, name, backup, originalHead, audioHash, log);
                throw new WriteException("Placing the new file failed (" + renameError + "); " + outcome, true, null);
            }
            journal.update(record, TagWriteJournal.STAGE_TEMP_RENAMED);

            // d. verify what is now at the original name.
            String finalProblem = name.equals(replaced.name) ? verify(store, replaced, plan, audioHash) : "provider renamed it to " + replaced.name;
            if (finalProblem != null) {
                String outcome;
                try {
                    DocumentStore.Doc bad = store.rename(replaced, "." + name + ".crossroads-bad-" + rand);
                    outcome = "the rejected file was moved to " + bad.name + "; " + restoreBackup(store, parent, name, backup, originalHead, audioHash, log);
                } catch (IOException | RuntimeException e) {
                    outcome = "the rejected file could not be moved aside (" + e.getMessage() + "); the original bytes are kept as " + backup.name + " in the same folder";
                }
                throw new WriteException("Verification after replacing the file failed (" + finalProblem + "); " + outcome, true, null);
            }
            journal.update(record, TagWriteJournal.STAGE_VERIFIED);

            // e. drop the backup.
            String warning = null;
            try {
                store.delete(backup);
                journal.complete(record);
            } catch (IOException | RuntimeException e) {
                // The write succeeded; the record stays so recovery removes the backup later.
                warning = "The old copy " + backup.name + " could not be deleted (" + e.getMessage() + ")";
                log.log(warning);
            }
            return new Result("rewrite", true, plan.tags, true, warning);
        } catch (WriteException e) {
            // The record is closed when the directory is provably back in order (the original
            // name holds a readable FLAC, no temp / backup of ours left); otherwise recovery
            // on the next start looks at it again.
            if (!e.touchedFile || isClean(store, parent, record)) journal.complete(record);
            throw e;
        } catch (IOException | RuntimeException e) {
            // Journal I/O or an unexpected error: leave the record for recovery when files moved.
            throw new WriteException("Writing tags failed: " + e.getMessage(), touched, e);
        }
    }

    /** Failure while the original is still untouched: delete the temp, close the record. */
    private static WriteException failBeforeRename(DocumentStore store, DocumentStore.Doc temp, TagWriteJournal.Record record,
                                                   TagWriteJournal journal, Log log, String reason, Throwable cause) {
        boolean tempGone = deleteQuietly(store, temp, log);
        if (tempGone) {
            try {
                journal.complete(record);
            } catch (IOException e) {
                log.log("Journal update failed: " + e.getMessage());
            }
        }
        String tail = tempGone ? "; the original file was not modified" : "; the original file was not modified (a temporary file " + temp.name + " could not be removed)";
        return new WriteException(reason + tail, true, cause);
    }

    /**
     * Puts the backup back under the original name, if that name is free, and verifies the
     * result against the bytes read before the write. Returns a truthful description; the
     * phrase "original restored" is used only after verification.
     */
    private static String restoreBackup(DocumentStore store, DocumentStore.Doc parent, String name, DocumentStore.Doc backup,
                                        byte[] originalHead, String audioHash, Log log) {
        try {
            DocumentStore.Doc occupied = store.findChild(parent, name);
            if (occupied != null) {
                return "the original could not be put back because " + name + " is occupied; the original bytes are kept as " + backup.name + " in the same folder";
            }
            DocumentStore.Doc back = store.rename(backup, name);
            if (back != null && name.equals(back.name) && isOriginal(store, back, originalHead, audioHash)) {
                log.log("Original restored as " + name);
                return "original restored";
            }
            return "the original was put back as " + (back == null ? name : back.name) + " but could not be verified; check the file";
        } catch (IOException | RuntimeException e) {
            return "the original could not be put back (" + e.getMessage() + "); the original bytes are kept as " + backup.name + " in the same folder";
        }
    }

    /** True when {@code doc} holds exactly the bytes read before the write (metadata region and audio hash). */
    static boolean isOriginal(DocumentStore store, DocumentStore.Doc doc, byte[] originalHead, String audioHash) {
        try (InputStream in = store.openRead(doc)) {
            byte[] head = FlacTagWriter.readHead(in);
            if (!Arrays.equals(head, originalHead)) return false;
            return FlacTagWriter.sha256Hex(in).equals(audioHash);
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** True when the original name holds a readable FLAC and no temp / backup named in the record remains. */
    private static boolean isClean(DocumentStore store, DocumentStore.Doc parent, TagWriteJournal.Record record) {
        try {
            DocumentStore.Doc orig = store.findChild(parent, record.originalName);
            if (orig == null || !parsesAsFlac(store, orig)) return false;
            if (record.tempName != null && store.findChild(parent, record.tempName) != null) return false;
            return record.backupName == null || store.findChild(parent, record.backupName) == null;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** Verifies a written document against the plan; null when it matches, else the problem. */
    private static String verify(DocumentStore store, DocumentStore.Doc doc, FlacTagWriter.Plan plan, String audioHash) {
        try (InputStream in = store.openRead(doc)) {
            return FlacTagWriter.verify(in, plan, audioHash);
        } catch (IOException | RuntimeException e) {
            return "unreadable after write: " + e.getMessage();
        }
    }

    private static boolean parsesAsFlac(DocumentStore store, DocumentStore.Doc doc) {
        try (InputStream in = store.openRead(doc)) {
            FlacTagWriter.parseMetadata(FlacTagWriter.readHead(in));
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** The document {@code doc} refers to, re-looked-up by name (the provider may have replaced its URI). */
    private static DocumentStore.Doc findByName(DocumentStore store, DocumentStore.Doc parent, DocumentStore.Doc doc) {
        if (doc == null) return null;
        try {
            if (store.exists(doc)) return doc;
            return doc.name == null ? null : store.findChild(parent, doc.name);
        } catch (IOException | RuntimeException e) {
            return doc;
        }
    }

    /** Deletes a document we created; true when it is gone afterwards. */
    private static boolean deleteQuietly(DocumentStore store, DocumentStore.Doc doc, Log log) {
        if (doc == null) return true;
        try {
            store.delete(doc);
        } catch (IOException | RuntimeException e) {
            log.log("Could not delete " + doc + ": " + e.getMessage());
        }
        return !store.exists(doc);
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[BUFFER];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    // --- recovery ----------------------------------------------------------------------------

    /**
     * Repairs whatever an interrupted write left behind, using only the names in the journal:
     *   - a readable FLAC under the original name means the write finished (or never moved
     *     the original): leftover temp / backup documents of ours are deleted;
     *   - otherwise, when the backup exists, anything at the original name is ours (the original
     *     had been moved away) and is set aside as ".crossroads-bad-", and the backup is renamed
     *     back;
     *   - otherwise, a verified temp with no original is renamed into place.
     * Returns one line per record describing what was done.
     */
    static List<String> recover(DocumentStore store, TagWriteJournal journal, Log log) throws IOException {
        List<String> actions = new ArrayList<>();
        for (TagWriteJournal.Record r : journal.pending()) {
            DocumentStore.Doc parent = new DocumentStore.Doc(r.parentUri, null);
            String action;
            try {
                action = recoverRecord(store, parent, r);
            } catch (IOException | RuntimeException e) {
                action = "recovery failed for " + r.originalName + ": " + e.getMessage();
                log.log(action);
                actions.add(action);
                continue;   // keep the record; try again next start
            }
            log.log(action);
            actions.add(action);
            journal.complete(r);
        }
        return actions;
    }

    private static String recoverRecord(DocumentStore store, DocumentStore.Doc parent, TagWriteJournal.Record r) throws IOException {
        DocumentStore.Doc orig = store.findChild(parent, r.originalName);
        DocumentStore.Doc temp = r.tempName == null ? null : store.findChild(parent, r.tempName);
        DocumentStore.Doc backup = r.backupName == null ? null : store.findChild(parent, r.backupName);
        boolean origValid = orig != null && parsesAsFlac(store, orig);

        if (origValid) {
            StringBuilder sb = new StringBuilder(r.originalName + ": intact (stage " + r.stage + ")");
            if (temp != null) { store.delete(temp); sb.append("; deleted temp ").append(temp.name); }
            if (backup != null) { store.delete(backup); sb.append("; deleted backup ").append(backup.name); }
            return sb.toString();
        }
        if (backup != null) {
            StringBuilder sb = new StringBuilder(r.originalName + ": restoring from backup " + backup.name + " (stage " + r.stage + ")");
            if (orig != null) {
                // The original had been moved to the backup, so whatever sits under its name came from us.
                DocumentStore.Doc bad = store.rename(orig, "." + r.originalName + ".crossroads-bad-" + randomSuffix());
                sb.append("; unreadable file at the original name moved to ").append(bad.name);
            }
            DocumentStore.Doc back = store.rename(backup, r.originalName);
            sb.append("; renamed back as ").append(back.name).append(parsesAsFlac(store, back) ? " (readable)" : " (NOT readable)");
            if (temp != null) { store.delete(temp); sb.append("; deleted temp ").append(temp.name); }
            return sb.toString();
        }
        if (orig == null && temp != null) {
            if (parsesAsFlac(store, temp)) {
                DocumentStore.Doc placed = store.rename(temp, r.originalName);
                return r.originalName + ": missing, verified temp " + temp.name + " renamed into place as " + placed.name;
            }
            return r.originalName + ": missing and the temp " + temp.name + " is not readable; left untouched for manual recovery";
        }
        if (temp != null) {
            store.delete(temp);
            return r.originalName + ": file present (stage " + r.stage + "); deleted temp " + temp.name;
        }
        return r.originalName + ": nothing to do (stage " + r.stage + ")";
    }
}
