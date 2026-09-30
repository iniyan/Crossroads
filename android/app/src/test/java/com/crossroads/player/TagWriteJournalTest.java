package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

import org.junit.Before;
import org.junit.Test;

public class TagWriteJournalTest {

    private File file;

    @Before
    public void setUp() throws IOException {
        file = new File(Files.createTempDirectory("cr-journal").toFile(), "sub/tag-write-journal.json");
    }

    @Test
    public void persistsEveryStageAndForgetsCompletedRecords() throws IOException {
        TagWriteJournal j = new TagWriteJournal(file);
        assertTrue(j.pending().isEmpty());
        TagWriteJournal.Record r = j.begin("content://tree/primary%3AMusic", "content://tree/primary%3AMusic/document/primary%3AMusic%2FAlbum", "01 \"Song\" \\ ünï.flac");
        assertTrue(file.isFile());
        List<TagWriteJournal.Record> fresh = new TagWriteJournal(file).pending();
        assertEquals(1, fresh.size());
        assertEquals(TagWriteJournal.STAGE_PLANNED, fresh.get(0).stage);
        assertEquals("01 \"Song\" \\ ünï.flac", fresh.get(0).originalName);
        assertNull(fresh.get(0).tempName);

        r.tempName = ".01.crossroads-ab.tmp";
        j.update(r, TagWriteJournal.STAGE_TEMP_CREATED);
        r.backupName = ".01.crossroads-bak-ab";
        j.update(r, TagWriteJournal.STAGE_ORIGINAL_RENAMED);
        fresh = new TagWriteJournal(file).pending();
        assertEquals(TagWriteJournal.STAGE_ORIGINAL_RENAMED, fresh.get(0).stage);
        assertEquals(".01.crossroads-ab.tmp", fresh.get(0).tempName);
        assertEquals(".01.crossroads-bak-ab", fresh.get(0).backupName);
        assertEquals(r.id, fresh.get(0).id);
        assertTrue(fresh.get(0).createdAt > 0);

        TagWriteJournal.Record second = j.begin("t", "p", "other.flac");
        j.complete(r);
        fresh = new TagWriteJournal(file).pending();
        assertEquals(1, fresh.size());
        assertEquals("other.flac", fresh.get(0).originalName);
        j.complete(second);
        assertTrue(new TagWriteJournal(file).pending().isEmpty());
    }

    @Test
    public void roundTripsControlCharactersAndUnicode() {
        TagWriteJournal.Record r = new TagWriteJournal.Record("id", "tree", "parent", "a\tb\n\u0001 東京 🎵", null, "x", TagWriteJournal.STAGE_VERIFIED, 42L);
        String text = TagWriteJournal.serialize(java.util.Collections.singletonList(r));
        List<TagWriteJournal.Record> back = TagWriteJournal.parse(text);
        assertEquals(1, back.size());
        assertEquals("a\tb\n\u0001 東京 🎵", back.get(0).originalName);
        assertNull(back.get(0).tempName);
        assertEquals("x", back.get(0).backupName);
        assertEquals(42L, back.get(0).createdAt);
        assertTrue(TagWriteJournal.parse("").isEmpty());
        assertTrue(TagWriteJournal.parse("[]").isEmpty());
        // Unknown fields are ignored; records missing the essentials are skipped.
        assertEquals(1, TagWriteJournal.parse("[{\"id\":\"1\",\"parentUri\":\"p\",\"originalName\":\"n\",\"extra\":true},{\"id\":\"2\"}]").size());
    }

    @Test
    public void corruptJournalIsAnIOException() throws IOException {
        file.getParentFile().mkdirs();
        Files.write(file.toPath(), "[{\"id\":".getBytes(StandardCharsets.UTF_8));
        try {
            new TagWriteJournal(file).pending();
            fail();
        } catch (IOException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("Corrupt tag-write journal"));
        }
    }
}
