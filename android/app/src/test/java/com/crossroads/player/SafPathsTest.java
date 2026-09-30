package com.crossroads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class SafPathsTest {

    @Test
    public void treePathMapsVolumes() {
        assertEquals("/storage/emulated/0/Music", SafPaths.treePath("primary:Music", "/storage/emulated/0"));
        assertEquals("/storage/emulated/0", SafPaths.treePath("primary:", "/storage/emulated/0"));
        assertEquals("/storage/emulated/0/Music/Sub", SafPaths.treePath("primary:Music/Sub/", "/storage/emulated/0/"));
        assertEquals("/storage/1234-ABCD/Audio", SafPaths.treePath("1234-ABCD:Audio", "/storage/emulated/0"));
        assertEquals("/storage/emulated/0/Documents/Lyrics", SafPaths.treePath("home:Lyrics", null));
        assertEquals("/storage/emulated/0/Music", SafPaths.treePath("primary:Music", null));
        assertNull(SafPaths.treePath("no-colon", "/storage/emulated/0"));
        assertNull(SafPaths.treePath(null, "/storage/emulated/0"));
    }

    @Test
    public void relativePath() {
        assertEquals("Album/01.flac", SafPaths.relativePath("/storage/emulated/0/Music", "/storage/emulated/0/Music/Album/01.flac"));
        assertEquals("", SafPaths.relativePath("/storage/emulated/0/Music/", "/storage/emulated/0/Music"));
        assertNull(SafPaths.relativePath("/storage/emulated/0/Music", "/storage/emulated/0/Musical/x.flac"));
        assertNull(SafPaths.relativePath("/storage/emulated/0/Music", "/sdcard/Music/x.flac"));
    }

    @Test
    public void childAndParentDocumentIds() {
        assertEquals("primary:Music/Album/01.flac", SafPaths.childDocumentId("primary:Music", "Album/01.flac"));
        assertEquals("primary:Album/01.flac", SafPaths.childDocumentId("primary:", "/Album/01.flac"));
        assertEquals("primary:Music", SafPaths.childDocumentId("primary:Music", ""));
        assertEquals("primary:Music/Album", SafPaths.parentDocumentId("primary:Music/Album/01.flac"));
        assertEquals("primary:", SafPaths.parentDocumentId("primary:Music"));
        assertNull(SafPaths.parentDocumentId(null));
    }

    @Test
    public void namesAndExtensions() {
        assertEquals("01.flac", SafPaths.fileName("/storage/emulated/0/Music/01.flac"));
        assertEquals("01.flac", SafPaths.fileName("primary:Music/01.flac"));
        assertEquals("Music", SafPaths.fileName("primary:Music"));
        assertEquals("01.lrc", SafPaths.withExtension("01.flac", ".lrc"));
        assertEquals("a.b.lrc", SafPaths.withExtension("a.b.flac", ".lrc"));
        assertEquals("noext.lrc", SafPaths.withExtension("noext", ".lrc"));
    }
}
