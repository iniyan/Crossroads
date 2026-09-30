package com.crossroads.player;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import org.junit.Before;
import org.junit.Test;

/**
 * Drives the crash-safe replace sequence of {@link SafTagWriter} against
 * {@link FakeDocumentStore}: happy path, provider quirks, a provider error at every step and
 * a simulated crash at every step followed by journal recovery. The invariant under test:
 * the original bytes are always available under the original name or the backup name, the
 * message says "original restored" only when that is verified, and recovery leaves a readable
 * FLAC under the original name with no strays.
 */
public class SafTagWriterTest {

    private static final String NAME = "01 Song.flac";
    private static final String[] TAGS = { "TITLE=Song", "ARTIST=Someone" };

    private FakeDocumentStore store;
    private DocumentStore.Doc dir;
    private DocumentStore.Doc original;
    private byte[] originalBytes;
    private File journalFile;
    private final List<String> logged = new ArrayList<>();
    private final SafTagWriter.Log log = logged::add;

    private static byte[] flac(int padding) {
        return FlacTagWriterTest.file("v", TAGS, padding);
    }

    @Before
    public void setUp() throws IOException {
        store = new FakeDocumentStore();
        dir = store.mkdir("Album");
        originalBytes = flac(64);
        original = store.put(dir, NAME, originalBytes);
        File tmp = Files.createTempDirectory("cr-journal").toFile();
        journalFile = new File(tmp, "tag-write-journal.json");
    }

    private TagWriteJournal journal() {
        return new TagWriteJournal(journalFile);
    }

    private static FlacTagWriter.Ops ops() {
        // Larger than the padding: the new region does not fit, a full rewrite is required either way.
        return new FlacTagWriter.Ops().set("ALBUM", "An Album").set("LYRICS", repeat("la ", 200));
    }

    private static String repeat(String s, int n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n; i++) sb.append(s);
        return sb.toString();
    }

    private byte[] expected() throws IOException {
        return FlacTagWriter.apply(originalBytes, ops(), FlacTagWriter.DEFAULT_PADDING);
    }

    private SafTagWriter.Result write() throws IOException {
        return SafTagWriter.write(store, journal(), "content://tree/primary%3AMusic", dir, original, ops(), log);
    }

    private SafTagWriter.WriteException writeExpectingFailure() throws IOException {
        try {
            write();
        } catch (SafTagWriter.WriteException e) {
            return e;
        }
        fail("expected the write to fail");
        return null;
    }

    private static boolean parses(byte[] bytes) {
        try {
            FlacTagWriter.parseMetadata(FlacTagWriter.readHead(new ByteArrayInputStream(bytes)));
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** The directory holds only the original name, with the given bytes. */
    private void assertOnly(byte[] bytes) {
        assertEquals(Arrays.asList(NAME), store.names(dir));
        assertArrayEquals(bytes, store.content(dir, NAME));
    }

    private void assertOriginalUntouched(SafTagWriter.WriteException e) throws IOException {
        assertOnly(originalBytes);
        assertTrue(e.getMessage(), e.getMessage().contains("the original file was not modified"));
        assertFalse(e.getMessage(), e.getMessage().contains("restored"));
        assertTrue(journal().pending().isEmpty());
    }

    // --- success -----------------------------------------------------------------------------

    @Test
    public void replacesTheFileThroughTempAndBackupAndClosesTheJournal() throws IOException {
        SafTagWriter.Result r = write();
        assertEquals("rewrite", r.strategy);
        assertTrue(r.changed);
        assertTrue(r.touchedFile);
        assertNull(r.warning);
        assertEquals(Arrays.asList("An Album"), r.tags.get("ALBUM"));
        assertOnly(expected());
        assertTrue(journal().pending().isEmpty());
        // The sequence: temp created, written, verified, original -> backup, temp -> name, backup deleted.
        String joined = String.join("\n", store.log);
        int create = joined.indexOf("create:." + NAME + ".crossroads-");
        int toBackup = joined.indexOf("rename:" + NAME + "->." + NAME + ".crossroads-bak-");
        int toName = joined.indexOf(".tmp->" + NAME);
        int del = joined.indexOf("delete:." + NAME + ".crossroads-bak-");
        assertTrue(create >= 0 && toBackup > create && toName > toBackup && del > toName);
    }

    @Test
    public void noopReadsOnlyTheMetadataAndTouchesNothing() throws IOException {
        SafTagWriter.Result r = SafTagWriter.write(store, journal(), "tree", dir, original, new FlacTagWriter.Ops().set("title", "Song"), log);
        assertFalse(r.changed);
        assertFalse(r.touchedFile);
        assertEquals(1, store.openReadCount);
        int audioOffset = FlacTagWriter.parseMetadata(originalBytes).audioOffset;
        assertEquals("only the metadata region is read for a no-op", audioOffset, store.bytesRead);
        assertOnly(originalBytes);
        assertFalse(journalFile.exists());
        for (String event : store.log) assertFalse(event, event.startsWith("create") || event.startsWith("rename") || event.startsWith("delete") || event.startsWith("openWrite"));
    }

    @Test
    public void usesTheNameTheProviderActuallyAssigned() throws IOException {
        store.createNameMangler = requested -> requested.replace(".tmp", " (1).tmp");
        SafTagWriter.Result r = write();
        assertTrue(r.changed);
        assertOnly(expected());
        assertTrue(String.join("\n", store.log).contains(" (1).tmp->" + NAME));
        assertTrue(journal().pending().isEmpty());
    }

    @Test
    public void looksUpTheDisplayNameWhenTheCallerDoesNotKnowIt() throws IOException {
        SafTagWriter.Result r = SafTagWriter.write(store, journal(), "tree", dir, new DocumentStore.Doc(original.uri, null), ops(), log);
        assertTrue(r.changed);
        assertOnly(expected());
    }

    @Test
    public void planningErrorsSurfaceAsFlacTagExceptionsBeforeAnythingIsTouched() throws IOException {
        try {
            SafTagWriter.write(store, journal(), "tree", dir, original, new FlacTagWriter.Ops().set("BAD=KEY", "x"), log);
            fail();
        } catch (FlacTagWriter.FlacTagException e) {
            assertEquals("INVALID_TAG", e.code);
        }
        assertOnly(originalBytes);
        assertFalse(journalFile.exists());
    }

    // --- refusal ----------------------------------------------------------------------------

    @Test
    public void refusesWhenTheProviderCannotRenameAndLeavesTheOriginalAlone() throws IOException {
        store.renameUnsupported = true;
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertTrue(e.getMessage(), e.getMessage().contains("does not support renaming"));
        assertTrue(e.touchedFile);   // a temp was created and removed: the caller rescans
        assertOriginalUntouched(e);
        // The original was never opened for writing.
        for (String event : store.log) assertFalse(event, event.equals("openWrite:" + NAME));
    }

    @Test
    public void createFailureLeavesNothingBehind() throws IOException {
        store.hook = FakeDocumentStore.failAt("create", 0);
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertFalse(e.touchedFile);
        assertTrue(e.getMessage(), e.getMessage().contains("Cannot create a temporary file"));
        assertOriginalUntouched(e);
    }

    // --- provider errors at every step ------------------------------------------------------

    @Test
    public void writeSyncAndVerifyFailuresBeforeTheRenameLeaveTheOriginalUntouched() throws IOException {
        for (int n = 0; n < 3; n++) {
            setUp();
            store.hook = FakeDocumentStore.failAt("write", n);
            SafTagWriter.WriteException e = writeExpectingFailure();
            assertTrue(e.getMessage(), e.getMessage().contains("Writing the new file failed"));
            assertOriginalUntouched(e);
        }
        setUp();
        store.hook = FakeDocumentStore.failAt("sync", 0);
        assertOriginalUntouched(writeExpectingFailure());

        setUp();
        store.hook = FakeDocumentStore.failAt("openWrite", 0);
        assertOriginalUntouched(writeExpectingFailure());

        // Temp verification mismatch: a byte of the audio flips as the channel closes.
        setUp();
        store.hook = (event, doc, entry) -> {
            if (event.equals("close")) entry.content[entry.content.length - 1] ^= 1;
        };
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertTrue(e.getMessage(), e.getMessage().contains("Verification of the new file failed (audio data changed)"));
        assertOriginalUntouched(e);
    }

    @Test
    public void tempThatCannotBeDeletedIsNamedButTheOriginalIsUntouched() throws IOException {
        store.hook = FakeDocumentStore.all(FakeDocumentStore.failAt("sync", 0), FakeDocumentStore.failAt("delete", 0));
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertTrue(e.getMessage(), e.getMessage().contains("could not be removed"));
        assertFalse(e.getMessage().contains("restored"));
        assertArrayEquals(originalBytes, store.content(dir, NAME));
        assertEquals(2, store.names(dir).size());
        // The record stays so recovery deletes the stray later.
        assertEquals(1, journal().pending().size());
        store.hook = null;
        SafTagWriter.recover(store, journal(), log);
        assertOnly(originalBytes);
        assertTrue(journal().pending().isEmpty());
    }

    @Test
    public void renameOfTheOriginalFailingLeavesItUntouched() throws IOException {
        store.hook = FakeDocumentStore.failAt("rename", 0);
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertTrue(e.getMessage(), e.getMessage().contains("Could not set the original file aside"));
        assertOriginalUntouched(e);
    }

    @Test
    public void renameOfTheTempFailingRestoresTheOriginalVerified() throws IOException {
        store.hook = FakeDocumentStore.failAt("rename", 1);
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertTrue(e.touchedFile);
        assertTrue(e.getMessage(), e.getMessage().contains("Placing the new file failed"));
        assertTrue(e.getMessage(), e.getMessage().endsWith("original restored"));
        assertOnly(originalBytes);
        assertTrue(journal().pending().isEmpty());
    }

    @Test
    public void whenTheRestoreRenameAlsoFailsTheMessageNamesTheBackupAndRecoveryFinishesIt() throws IOException {
        store.hook = FakeDocumentStore.failAt("rename", 1, 2);
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertFalse(e.getMessage(), e.getMessage().contains("restored"));
        assertTrue(e.getMessage(), e.getMessage().contains("kept as ." + NAME + ".crossroads-bak-"));
        // The original bytes exist under the backup name; nothing under the original name.
        assertEquals(1, store.names(dir).size());
        String backup = store.names(dir).get(0);
        assertTrue(backup.startsWith("." + NAME + ".crossroads-bak-"));
        assertArrayEquals(originalBytes, store.content(dir, backup));
        assertEquals(1, journal().pending().size());

        store.hook = null;
        List<String> actions = SafTagWriter.recover(store, journal(), log);
        assertEquals(1, actions.size());
        assertTrue(actions.get(0), actions.get(0).contains("renamed back as " + NAME + " (readable)"));
        assertOnly(originalBytes);
        assertTrue(journal().pending().isEmpty());
    }

    @Test
    public void finalVerificationFailureMovesTheRejectedFileAsideAndRestoresTheOriginal() throws IOException {
        // The provider "corrupts" the temp as it is renamed into place (the first rename to that name).
        boolean[] done = { false };
        store.hook = (event, doc, entry) -> {
            if (event.equals("renamed") && doc.name.equals(NAME) && !done[0]) {
                done[0] = true;
                entry.content[entry.content.length - 1] ^= 1;
            }
        };
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertTrue(e.getMessage(), e.getMessage().contains("Verification after replacing the file failed (audio data changed)"));
        assertTrue(e.getMessage(), e.getMessage().contains("moved to ." + NAME + ".crossroads-bad-"));
        assertTrue(e.getMessage(), e.getMessage().endsWith("original restored"));
        assertArrayEquals(originalBytes, store.content(dir, NAME));
        assertEquals(2, store.names(dir).size());
        assertTrue(hasNameStartingWith("." + NAME + ".crossroads-bad-"));
        assertTrue(journal().pending().isEmpty());
    }

    private boolean hasNameStartingWith(String prefix) {
        for (String name : store.names(dir)) if (name.startsWith(prefix)) return true;
        return false;
    }

    @Test
    public void providerRenamingToADifferentNameIsTreatedAsAVerificationFailure() throws IOException {
        int[] renames = { 0 };
        store.hook = (event, doc, entry) -> {
            if (event.equals("renamed") && renames[0]++ == 1) {
                entry.name = NAME + " (1)";    // the provider chose another name for the temp
            }
        };
        SafTagWriter.WriteException e = writeExpectingFailure();
        assertTrue(e.getMessage(), e.getMessage().contains("provider renamed it to " + NAME + " (1)"));
        // The misnamed file is set aside as ".crossroads-bad-" and the backup goes back under the original name.
        assertTrue(e.getMessage(), e.getMessage().endsWith("original restored"));
        assertArrayEquals(originalBytes, store.content(dir, NAME));
        assertTrue(hasNameStartingWith("." + NAME + ".crossroads-bad-"));
        assertFalse(hasNameStartingWith("." + NAME + ".crossroads-bak-"));
        assertEquals(2, store.names(dir).size());
        assertTrue(journal().pending().isEmpty());
    }

    @Test
    public void backupDeleteFailureIsAWarningAndRecoveryCleansItUp() throws IOException {
        store.hook = FakeDocumentStore.failAt("delete", 0);
        SafTagWriter.Result r = write();
        assertTrue(r.changed);
        assertNotNull(r.warning);
        assertTrue(r.warning, r.warning.contains("could not be deleted"));
        assertArrayEquals(expected(), store.content(dir, NAME));
        assertEquals(2, store.names(dir).size());
        assertEquals(1, journal().pending().size());
        assertEquals(TagWriteJournal.STAGE_VERIFIED, journal().pending().get(0).stage);

        store.hook = null;
        List<String> actions = SafTagWriter.recover(store, journal(), log);
        assertTrue(actions.get(0), actions.get(0).contains("deleted backup"));
        assertOnly(expected());
        assertTrue(journal().pending().isEmpty());
    }

    // --- crash at every step, then recovery ---------------------------------------------------

    @Test
    public void crashAtEveryStepIsRepairedByRecovery() throws IOException {
        String[] events = { "create", "openWrite", "write", "sync", "close", "closed", "rename", "renamed", "delete", "findChild", "exists" };
        int crashes = 0;
        for (String event : events) {
            for (int nth = 0; nth < 6; nth++) {
                setUp();
                store.hook = FakeDocumentStore.crashAt(event, nth);
                boolean crashed = false;
                try {
                    write();
                } catch (FakeDocumentStore.Crash c) {
                    crashed = true;
                }
                if (!crashed) break;   // this event does not fire that often on the happy path
                crashes++;
                String where = event + "#" + nth;
                store.hook = null;

                // Invariant even before recovery: the original bytes are somewhere we can name.
                byte[] atName = store.content(dir, NAME);
                boolean originalSomewhere = Arrays.equals(originalBytes, atName);
                for (String name : store.names(dir)) if (Arrays.equals(originalBytes, store.content(dir, name))) originalSomewhere = true;
                boolean newVerifiedAtName = atName != null && Arrays.equals(expected(), atName);
                assertTrue(where + ": original bytes lost", originalSomewhere || newVerifiedAtName);

                // Recovery: a readable FLAC under the original name, no temp / backup strays, journal empty.
                TagWriteJournal j = journal();
                SafTagWriter.recover(store, j, log);
                byte[] after = store.content(dir, NAME);
                assertNotNull(where + ": nothing at the original name after recovery", after);
                assertTrue(where + ": unreadable after recovery", parses(after));
                assertTrue(where + ": neither the original nor the verified new file", Arrays.equals(after, originalBytes) || Arrays.equals(after, expected()));
                for (String name : store.names(dir)) {
                    assertFalse(where + ": stray " + name, name.contains(".crossroads-") && !name.contains("-bad-"));
                }
                assertTrue(where + ": journal not empty", journal().pending().isEmpty());
                // Recovery is idempotent.
                assertTrue(SafTagWriter.recover(store, journal(), log).isEmpty());
            }
        }
        assertTrue("expected many crash points, got " + crashes, crashes >= 12);
    }

    @Test
    public void recoveryOnlyTouchesNamesInTheJournal() throws IOException {
        // A stray that looks like ours but is not journaled stays; a journaled temp goes.
        store.put(dir, "." + NAME + ".crossroads-deadbeef.tmp", new byte[] { 1 });
        TagWriteJournal j = journal();
        TagWriteJournal.Record r = j.begin("tree", dir.uri, NAME);
        r.tempName = "." + NAME + ".crossroads-cafe.tmp";
        j.update(r, TagWriteJournal.STAGE_TEMP_CREATED);
        store.put(dir, r.tempName, new byte[] { 2 });
        SafTagWriter.recover(store, journal(), log);
        assertEquals(Arrays.asList(NAME, "." + NAME + ".crossroads-deadbeef.tmp"), store.names(dir));
        assertTrue(journal().pending().isEmpty());
    }

    @Test
    public void recoveryRenamesAVerifiedTempIntoPlaceWhenTheOriginalIsGone() throws IOException {
        TagWriteJournal j = journal();
        TagWriteJournal.Record r = j.begin("tree", dir.uri, NAME);
        r.tempName = "." + NAME + ".crossroads-1.tmp";
        r.backupName = "." + NAME + ".crossroads-bak-1";
        j.update(r, TagWriteJournal.STAGE_ORIGINAL_RENAMED);
        // Backup was deleted (or never made it), original gone, a complete temp remains.
        store.docs.remove(original.uri);
        store.put(dir, r.tempName, expected());
        List<String> actions = SafTagWriter.recover(store, journal(), log);
        assertTrue(actions.get(0), actions.get(0).contains("renamed into place"));
        assertOnly(expected());

        // An unreadable temp is left alone and reported.
        setUp();
        j = journal();
        r = j.begin("tree", dir.uri, NAME);
        r.tempName = "." + NAME + ".crossroads-2.tmp";
        j.update(r, TagWriteJournal.STAGE_TEMP_CREATED);
        store.docs.remove(original.uri);
        store.put(dir, r.tempName, new byte[] { 0, 1, 2 });
        actions = SafTagWriter.recover(store, journal(), log);
        assertTrue(actions.get(0), actions.get(0).contains("left untouched"));
        assertEquals(Arrays.asList(r.tempName), store.names(dir));
    }

    @Test
    public void recoveryKeepsARecordWhoseRepairFails() throws IOException {
        store.hook = FakeDocumentStore.failAt("rename", 1, 2);
        writeExpectingFailure();
        store.hook = FakeDocumentStore.failAt("rename", 0);
        List<String> actions = SafTagWriter.recover(store, journal(), log);
        assertTrue(actions.get(0), actions.get(0).startsWith("recovery failed"));
        assertEquals(1, journal().pending().size());
        store.hook = null;
        SafTagWriter.recover(store, journal(), log);
        assertOnly(originalBytes);
        assertTrue(journal().pending().isEmpty());
    }
}
